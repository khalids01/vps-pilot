import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type ServerProfile, safeError } from "./api";
import {
  type EnvDocument,
  type EnvEntry,
  EnvError,
  parseEnv,
  serializeEnv,
} from "./env-model";
import { type FileReview, filesApi, type RemoteText } from "./files-api";
export function ProjectEnv({
  profile,
  connectionId,
  folder,
  name,
  onClose,
  onRestart,
}: {
  profile: ServerProfile;
  connectionId: string | null | undefined;
  folder: string;
  name: string;
  onClose: () => void;
  onRestart: () => void;
}) {
  const [filename, setFilename] = useState(".env");
  const [file, setFile] = useState<RemoteText | null>(null);
  const [base, setBase] = useState<EnvDocument | null>(null);
  const [entries, setEntries] = useState<EnvEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState<string[]>([]);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [imported, setImported] = useState<EnvDocument | null>(null);
  const [replace, setReplace] = useState<string[]>([]);
  const [review, setReview] = useState<FileReview | null>(null);
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  const token = useRef<string | null>(null);
  const pendingContent = useRef("");
  const source = {
    profileId: profile.id,
    profileRevision: profile.revision,
    connectionId,
  };
  const dirty =
    !!base &&
    JSON.stringify(entries.map((e) => [e.key, e.value])) !==
      JSON.stringify(base.entries.map((e) => [e.key, e.value]));
  const duplicates = entries
    .filter((e, i) => entries.some((a, j) => j !== i && a.key === e.key))
    .map((e) => e.key);
  function clear() {
    setFile(null);
    setBase(null);
    setEntries([]);
    setPaste("");
    setImported(null);
    setRevealed([]);
    setReview(null);
    pendingContent.current = "";
  }
  async function load(target = filename) {
    if (!/^\.env(?:\.[A-Za-z0-9_.-]+)?$/.test(target)) {
      setError("Choose .env or a named .env file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await invoke<RemoteText>("ssh_project_env_read", {
        ...source,
        path: `${folder.replace(/\/$/, "")}/${target}`,
      });
      const parsed = parseEnv(result.content);
      if (!alive.current) return;
      setFile(result);
      setBase(parsed);
      setEntries(parsed.entries);
      setSaved(false);
    } catch (e) {
      if (alive.current)
        setError(e instanceof EnvError ? e.message : safeError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const lifecycle = useRef({ load, onClose, profileId: profile.id });
  lifecycle.current.onClose = onClose;
  useEffect(() => {
    alive.current = true;
    void lifecycle.current.load(".env");
    const hidden = () => {
      if (document.hidden) lifecycle.current.onClose();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false;
      pendingContent.current = "";
      document.removeEventListener("visibilitychange", hidden);
      if (token.current)
        void filesApi
          .reject(lifecycle.current.profileId, token.current)
          .catch(() => {});
    };
  }, []);
  function previewPaste() {
    try {
      setImported(parseEnv(paste));
      setReplace([]);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid environment text.");
    }
  }
  function importEntries() {
    if (!imported || imported.duplicates.length) return;
    let next = [...entries];
    for (const row of imported.entries) {
      const old = next.find((e) => e.key === row.key);
      if (old) {
        if (replace.includes(row.key))
          next = next.map((e) =>
            e.id === old.id ? { ...e, value: row.value } : e,
          );
      } else next.push({ ...row, raw: "", start: 0, end: 0 });
    }
    setEntries(next);
    setPaste("");
    setImported(null);
    setShowPaste(false);
    setSaved(false);
  }
  async function prepare() {
    if (!base || !file) return;
    setBusy(true);
    setError("");
    try {
      const content = serializeEnv(base, entries);
      const result = await invoke<FileReview>("ssh_project_env_review", {
        ...source,
        path: file.path,
        revision: file.revision,
        content,
      });
      if (!alive.current) {
        void filesApi.reject(profile.id, result.token);
        return;
      }
      pendingContent.current = content;
      token.current = result.token;
      setReview(result);
    } catch (e) {
      setError(e instanceof EnvError ? e.message : safeError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    if (!review) return;
    const current = review;
    token.current = null;
    setReview(null);
    setBusy(true);
    setError("");
    try {
      const receipt = await filesApi.commit(profile.id, current.token);
      if (alive.current && file) {
        const parsed = parseEnv(pendingContent.current);
        setBase(parsed);
        setEntries(parsed.entries);
        setFile({
          ...file,
          path: receipt.path,
          revision: receipt.revision,
          content: pendingContent.current,
          permissions: 0o100600,
        });
        setSaved(true);
      }
      pendingContent.current = "";
    } catch (e) {
      if (alive.current)
        setError(e instanceof EnvError ? e.message : safeError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function close() {
    if (!busy) {
      clear();
      onClose();
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[90dvh] overflow-auto sm:max-w-[min(90vw,90rem)]"
      >
        <DialogHeader>
          <DialogTitle>Manage env · {name}</DialogTitle>
        </DialogHeader>
        <p className="break-all text-xs text-muted-foreground">
          {profile.name} · {folder}
        </p>
        <div className="flex gap-2">
          <Input
            aria-label="Environment filename"
            disabled={busy || dirty || !!review}
            value={filename}
            onChange={(e) => {
              setFilename(e.target.value);
              setFile(null);
              setBase(null);
              setEntries([]);
              setSaved(false);
            }}
          />
          <Button
            variant="outline"
            disabled={busy || dirty || !!review}
            onClick={() => load()}
          >
            Open
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {file && (
          <>
            <div className="space-y-2">
              {entries.map((e) => (
                <div
                  className="flex gap-2 sm:grid sm:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)_auto_auto]"
                  key={e.id}
                >
                  <Input
                    aria-label="Variable name"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy || !!review}
                    value={e.key}
                    onChange={(ev) =>
                      setEntries((old) =>
                        old.map((a) =>
                          a.id === e.id ? { ...a, key: ev.target.value } : a,
                        ),
                      )
                    }
                  />
                  <textarea
                    aria-label={`Value for ${e.key || "new variable"}`}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy || !!review}
                    className={`min-h-10 w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm ${revealed.includes(e.id) ? "" : "[-webkit-text-security:disc]"}`}
                    value={e.value}
                    onChange={(ev) =>
                      setEntries((old) =>
                        old.map((a) =>
                          a.id === e.id ? { ...a, value: ev.target.value } : a,
                        ),
                      )
                    }
                  />
                  <Button
                    aria-label={`Show or hide ${e.key || "new variable"}`}
                    variant="ghost"
                    onClick={() =>
                      setRevealed((old) =>
                        old.includes(e.id)
                          ? old.filter((id) => id !== e.id)
                          : [...old, e.id],
                      )
                    }
                  >
                    {revealed.includes(e.id) ? "Hide" : "Show"}
                  </Button>
                  <Button
                    aria-label={`Remove ${e.key || "new variable"}`}
                    variant="ghost"
                    disabled={busy || !!review}
                    onClick={() =>
                      setEntries((old) => old.filter((a) => a.id !== e.id))
                    }
                  >
                    ×
                  </Button>
                </div>
              ))}
            </div>
            {duplicates.length > 0 && (
              <p role="alert" className="text-xs text-destructive">
                Duplicate keys: {[...new Set(duplicates)].join(", ")}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy || !!review || entries.length >= 1000}
                onClick={() =>
                  setEntries((old) => [
                    ...old,
                    {
                      id: crypto.randomUUID(),
                      key: "",
                      value: "",
                      raw: "",
                      start: 0,
                      end: 0,
                    },
                  ])
                }
              >
                Add variable
              </Button>
              {dirty && (
                <Button
                  variant="ghost"
                  disabled={busy || !!review}
                  onClick={() => {
                    setEntries(base?.entries ?? []);
                    setPaste("");
                    setImported(null);
                  }}
                >
                  Discard changes
                </Button>
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-sm">Paste .env</summary>
              <div className="space-y-2 pt-3">
                <textarea
                  aria-label="Paste environment variables"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy || !!review}
                  className={`min-h-32 w-full rounded-md border bg-background p-3 font-mono text-xs ${showPaste ? "" : "[-webkit-text-security:disc]"}`}
                  value={paste}
                  onChange={(e) => {
                    setPaste(e.target.value);
                    setImported(null);
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => setShowPaste((v) => !v)}
                  >
                    {showPaste ? "Hide paste" : "Show paste"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!paste.trim() || busy || !!review}
                    onClick={previewPaste}
                  >
                    Preview import
                  </Button>
                </div>
                {imported && (
                  <div className="space-y-2">
                    {imported.duplicates.length > 0 ? (
                      <>
                        <p className="text-xs text-destructive">
                          Repeated keys: {imported.duplicates.join(", ")}
                        </p>
                        <Button
                          variant="outline"
                          onClick={() => {
                            const unique = imported.entries.filter(
                              (e, i, all) =>
                                !all.slice(i + 1).some((a) => a.key === e.key),
                            );
                            setImported({
                              ...imported,
                              entries: unique,
                              duplicates: [],
                            });
                          }}
                        >
                          Keep last occurrence
                        </Button>
                      </>
                    ) : (
                      <>
                        {imported.entries.map((e) => (
                          <div
                            key={e.id}
                            className="flex items-center gap-2 text-xs"
                          >
                            <span className="mr-auto">{e.key}</span>
                            {entries.some((a) => a.key === e.key) ? (
                              <label
                                className="flex items-center gap-2"
                                htmlFor={`replace-${e.id}`}
                              >
                                <Checkbox
                                  id={`replace-${e.id}`}
                                  checked={replace.includes(e.key)}
                                  onCheckedChange={(v) =>
                                    setReplace((old) =>
                                      v
                                        ? [...old, e.key]
                                        : old.filter((k) => k !== e.key),
                                    )
                                  }
                                />
                                Replace existing
                              </label>
                            ) : (
                              "New"
                            )}
                          </div>
                        ))}
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setReplace(
                              imported.entries
                                .filter((e) =>
                                  entries.some((a) => a.key === e.key),
                                )
                                .map((e) => e.key),
                            )
                          }
                        >
                          Replace all existing
                        </Button>
                        <Button onClick={importEntries}>
                          Import variables
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </details>
            <p className="text-xs text-muted-foreground">
              Saves this file only. Apply with your app’s build or restart.
            </p>
          </>
        )}
        {review && (
          <div className="space-y-2 rounded border p-3 text-sm">
            <p>
              Save {entries.length} variables to {review.path}?
            </p>
            <p className="text-xs text-muted-foreground">
              {review.backupPath
                ? "Existing file will be backed up."
                : "New file."}{" "}
              Permissions: owner only.
            </p>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={save}>
                Confirm save
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  void filesApi.reject(profile.id, review.token);
                  token.current = null;
                  pendingContent.current = "";
                  setReview(null);
                }}
              >
                Back
              </Button>
            </div>
          </div>
        )}
        {saved && (
          <p role="status" className="text-sm text-primary">
            Environment saved.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            Done
          </Button>
          {saved && (
            <Button
              variant="outline"
              onClick={() => {
                close();
                onRestart();
              }}
            >
              Restart app
            </Button>
          )}
          <Button
            disabled={
              busy ||
              !dirty ||
              !!review ||
              duplicates.length > 0 ||
              entries.some((e) => !e.key.trim())
            }
            onClick={prepare}
          >
            {busy ? "Working…" : "Review changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
