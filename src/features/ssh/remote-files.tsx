import { Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { address, type ServerProfile, safeError } from "./api";
import { useCommandActivity } from "./command-activity";
import { FileManager } from "./file-manager";
import { type FileReview, filesApi, type RemoteText } from "./files-api";
import { formatBytes } from "./structured-report";
import { TextEditor } from "./text-editor";

const mode = (value: number | null) =>
  value === null ? "—" : (value & 0o777).toString(8).padStart(3, "0");
export function RemoteFiles({
  profile,
  connected,
}: {
  profile: ServerProfile;
  connected: boolean;
}) {
  const [file, setFile] = useState<RemoteText | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [review, setReview] = useState<FileReview | null>(null);
  const [reviewText, setReviewText] = useState("");
  const [discard, setDiscard] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const pending = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const reviewRef = useRef<FileReview | null>(null);
  reviewRef.current = review;
  const activity = useCommandActivity();
  const dirty = Boolean(file && draft !== file.content);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = reviewRef.current;
      if (current)
        void filesApi.reject(profile.id, current.token).catch(() => {});
    };
  }, [profile.id]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function run<T>(
    label: string,
    operation: () => Promise<T>,
    done: (result: T) => void,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    if (label !== "Load remote folder") setMessage("");
    const entry = activity.begin(label, `SFTP · ${profile.name}`);
    try {
      const result = await operation();
      if (mounted.current) {
        done(result);
        activity.update(entry, {
          status: "completed",
          ended: Date.now(),
          message:
            "SFTP operation finished. File contents are excluded from history.",
        });
      }
      return true;
    } catch (cause) {
      if (mounted.current) {
        const message = safeError(cause);
        setError(message);
        activity.update(entry, {
          status: "failed",
          ended: Date.now(),
          message,
        });
      }
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const read = (path: string) =>
    void run(
      "Open remote text file",
      () => filesApi.read(profile.id, path),
      (result) => {
        setFile(result);
        setDraft(result.content);
      },
    );
  const guard = (action: () => void) => {
    if (dirty) {
      pending.current = action;
      setDiscard(true);
    } else action();
  };
  const cancelReview = () => {
    if (busy) return;
    const current = review;
    setReview(null);
    if (current)
      void filesApi.reject(profile.id, current.token).catch(() => {});
  };
  const reviewDraft = () => {
    if (!file || !dirty || busy || !connected) return;
    void run(
      "Review file changes",
      () => filesApi.review(profile.id, file, draft),
      (result) => {
        setReviewText(draft);
        setReview(result);
      },
    );
  };
  const editor = file ? (
    <div className="min-w-0 space-y-3 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-all text-sm font-medium">{file.path}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Mode {mode(file.permissions)} ·{" "}
            {new TextEncoder().encode(draft).length.toLocaleString()} bytes ·{" "}
            {dirty ? "Unsaved changes" : "Matches last opened/saved version"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!connected || busy}
            onClick={() => guard(() => read(file.path))}
          >
            Reload file
          </Button>
          <Button
            size="sm"
            disabled={!connected || busy || !dirty}
            title="Review changes (Ctrl/Cmd+S)"
            onClick={reviewDraft}
          >
            <Save />
            Review changes
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close file editor"
            disabled={busy}
            onClick={() =>
              guard(() => {
                setFile(null);
                setDraft("");
              })
            }
          >
            <X />
          </Button>
        </div>
      </div>
      <div className="h-[55dvh] min-h-72">
        <TextEditor
          key={file.path}
          path={file.path}
          value={draft}
          onChange={setDraft}
          onSave={reviewDraft}
          readOnly={busy}
          label="Remote file editor"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Drafts stay in memory across navigation. File contents are excluded from
        SQLite and command history.
      </p>
    </div>
  ) : null;
  return (
    <section aria-label={`${profile.name} files`} className="space-y-4">
      <header>
        <h2 className="text-xl font-medium">Files</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Manage files on {profile.name} as {profile.username}. System and
          credential paths are protected by the native backend.
        </p>
      </header>
      {!connected && (
        <p
          role="status"
          className="rounded-lg border p-3 text-sm text-muted-foreground"
        >
          Connect this VPS to browse or save files. Your open draft stays in
          this workspace.
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="break-all text-sm text-primary">
          {message}
        </p>
      )}
      <FileManager
        profile={profile}
        connected={connected}
        busy={busy}
        run={run}
        editor={editor}
        refreshKey={refreshKey}
        onOpen={(path) => guard(() => read(path))}
        onUpload={(directory) =>
          void run(
            "Prepare file upload",
            () => filesApi.upload(profile.id, directory, null),
            (result) => {
              if (result) {
                setReviewText("");
                setReview(result);
              } else setMessage("Upload cancelled.");
            },
          )
        }
        beforeMutation={(paths, action) => {
          if (
            file &&
            paths.some(
              (path) => file.path === path || file.path.startsWith(`${path}/`),
            )
          )
            guard(action);
          else action();
        }}
        onCompleted={(operation, result) => {
          if (
            file &&
            (operation === "move" || operation === "trash") &&
            result.completed.some(
              (item) =>
                file.path === item.source ||
                file.path.startsWith(`${item.source}/`),
            )
          ) {
            setFile(null);
            setDraft("");
          }
        }}
      />
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open) cancelReview();
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {review?.operation === "upload"
                ? "Review file upload"
                : "Review file changes"}
            </DialogTitle>
            <DialogDescription>
              {profile.name} · {address(profile)}
            </DialogDescription>
          </DialogHeader>
          {review && (
            <>
              <dl className="space-y-2 break-all text-xs">
                <div>
                  <dt className="text-muted-foreground">Destination</dt>
                  <dd>{review.path}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Private backup of existing contents
                  </dt>
                  <dd>
                    {review.backupPath ??
                      "New file; existing files will not be silently replaced."}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">New size</dt>
                  <dd>{formatBytes(review.bytes)}</dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                Checks for external changes before replacement. Existing owner
                and permission bits are preserved; ACLs and extended attributes
                are not copied. No service is reloaded.
              </p>
              {review.operation === "edit" && file && (
                <div className="h-[45dvh] min-h-52">
                  <TextEditor
                    key={review.token}
                    path={review.path}
                    value={reviewText}
                    original={file.content}
                    readOnly
                    label="File change preview"
                  />
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={cancelReview}
                >
                  Cancel
                </Button>
                <Button
                  disabled={busy || !connected}
                  onClick={() => {
                    const approved = review;
                    void run(
                      "Save reviewed file",
                      () => filesApi.commit(profile.id, approved.token),
                      (receipt) => {
                        if (approved.operation === "edit" && file)
                          setFile({
                            ...file,
                            content: reviewText,
                            revision: receipt.revision,
                            size: approved.bytes,
                          });
                        setReview(null);
                        setRefreshKey((key) => key + 1);
                        setMessage(
                          receipt.backupPath
                            ? `Saved. Backup: ${receipt.backupPath}`
                            : "Uploaded new file.",
                        );
                      },
                    ).then((success) => {
                      if (mounted.current) {
                        if (!success && approved.backupPath)
                          setMessage(
                            "Review backup location: " +
                              approved.backupPath +
                              ". Reopen the remote file before retrying.",
                          );
                        setReview(null);
                      }
                    });
                  }}
                >
                  {busy
                    ? "Saving…"
                    : review.operation === "upload"
                      ? "Confirm upload"
                      : "Back up and save"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={discard}
        onOpenChange={(open) => {
          setDiscard(open);
          if (!open) pending.current = null;
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your draft for {file?.path} has not been saved to {profile.name}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Keep editing
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const action = pending.current;
                pending.current = null;
                setDiscard(false);
                action?.();
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
