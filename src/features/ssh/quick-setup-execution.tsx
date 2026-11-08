import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getPreferenceSaveState,
  readPreference,
  retryPreference,
  subscribePreferenceSaveState,
  writePreference,
} from "@/features/settings/persistence";
import { type ServerProfile, safeError } from "./api";
import { useConfiguration } from "./configuration-context";
import {
  type ConfigurationReview,
  reviewMatchesContext,
} from "./configuration-model";
import {
  freshSetupSnapshot,
  parseSetupCheckpoints,
  type SetupCheckpoint,
  setupCheckpointPrefix,
  stepCategories,
  stepItems,
} from "./quick-setup-execution-model";
import type { QuickSetupDraft, QuickSetupStepId } from "./quick-setup-model";
import { QuickSetupResolvedSources } from "./quick-setup-sources";

export function QuickSetupExecution({
  profile,
  draft,
  visible,
  onStep,
}: {
  profile: ServerProfile;
  draft: QuickSetupDraft;
  visible: boolean;
  onStep: (step: QuickSetupStepId) => void;
}) {
  const inspection = useConfiguration();
  const key = setupCheckpointPrefix + profile.id;
  const [history, setHistory] = useState(() =>
    parseSetupCheckpoints(readPreference(key)),
  );
  const [open, setOpen] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [review, setReview] = useState<ConfigurationReview | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now);
  const sequence = useRef(0);
  const scan = useRef<{ snapshotId?: string; step: QuickSetupStepId } | null>(
    null,
  );
  const items = stepItems(draft);
  const categories = stepCategories(draft.step);
  const context = JSON.stringify([
    profile.id,
    profile.revision,
    inspection.connectionId,
    draft,
    visible,
    inspection.snapshot?.snapshotId,
  ]);
  const latest = useRef(context);
  latest.current = context;
  const locked = useRef(false);
  const persistence = useSyncExternalStore(
    (listener) => subscribePreferenceSaveState(key, listener),
    () => getPreferenceSaveState(key).status,
  );
  useEffect(() => {
    if (latest.current !== context) return;
    sequence.current += 1;
    locked.current = false;
    setPending(false);
    setOpen(false);
    setReview(null);
    setError("");
    return () => {
      sequence.current += 1;
    };
  }, [context]);
  const scope = JSON.stringify([
    profile.id,
    profile.revision,
    inspection.connectionId,
    draft.step,
    visible,
  ]);
  useEffect(() => {
    if (scope) scan.current = null;
  }, [scope]);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);
  function remember(step: QuickSetupStepId, phase: SetupCheckpoint["phase"]) {
    if (history === null) return;
    const next = [
      ...history.filter((item) => item.step !== step),
      { step, phase, at: Date.now() },
    ];
    setHistory(next);
    writePreference(key, JSON.stringify({ version: 1, steps: next }));
  }
  // Evidence stays in the existing in-memory inspection cache. Only timestamps
  // and bounded phase enums are persisted, never remote output or login proof.
  const snapshot = inspection.snapshot;
  useEffect(() => {
    const request = scan.current;
    if (
      !request ||
      inspection.busy ||
      !snapshot ||
      snapshot.snapshotId === request.snapshotId ||
      snapshot.profileId !== profile.id ||
      snapshot.connectionId !== inspection.connectionId
    )
      return;
    scan.current = null;
    remember(request.step, "scanned");
  });
  const fresh =
    freshSetupSnapshot(snapshot, profile.id, inspection.connectionId, now) &&
    !inspection.stale &&
    !inspection.busy &&
    !inspection.error &&
    !error;
  const checkpoint = history?.find((item) => item.step === draft.step);
  const observed =
    snapshot?.sections.filter((section) => categories.includes(section.id)) ??
    [];
  async function createReview() {
    if (!fresh || !snapshot || !inspection.connectionId || locked.current)
      return;
    locked.current = true;
    const captured = context;
    const request = ++sequence.current;
    setOpen(true);
    setReview(null);
    setError("");
    setPending(true);
    const binding = {
      profileId: profile.id,
      connectionId: inspection.connectionId,
      profileRevision: profile.revision,
      snapshotId: snapshot.snapshotId,
      selected: categories,
    };
    try {
      const result = await invoke<ConfigurationReview>(
        "ssh_configuration_review",
        {
          profileId: binding.profileId,
          connectionId: binding.connectionId,
          snapshotId: binding.snapshotId,
          selected: categories,
        },
      );
      if (latest.current !== captured || sequence.current !== request) return;
      const match = reviewMatchesContext(result, binding);
      if (!match.ok) throw Error(match.reason);
      if (result.expiresAt <= Date.now())
        throw Error("Review expired. Scan again and create a fresh review.");
      setReview(result);
      remember(draft.step, "reviewed");
    } catch (failure) {
      if (latest.current === captured && sequence.current === request)
        setError(safeError(failure));
    } finally {
      if (sequence.current === request) {
        setPending(false);
        locked.current = false;
      }
    }
  }
  function startScan() {
    if (!inspection.canInspect || inspection.busy || pending) return;
    setReview(null);
    setOpen(false);
    setError("");
    scan.current = { snapshotId: snapshot?.snapshotId, step: draft.step };
    inspection.inspect();
  }
  const access = draft.step === 2 || draft.step === 3;
  const reviewLive = review && fresh && review.expiresAt > now;
  return (
    <section
      aria-label="Step actions"
      className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Check and apply this step</h3>
        <span
          role="status"
          className={`rounded-md px-2 py-1 text-xs ${inspection.error || error ? "bg-destructive/10 text-destructive" : fresh ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
        >
          {inspection.busy
            ? "Scanning…"
            : inspection.error || error
              ? "Needs attention"
              : fresh
                ? "Scan available · not verified"
                : checkpoint
                  ? "Recheck required"
                  : "Not checked"}
        </span>
      </div>
      <ol
        className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground"
        aria-label="Step execution stages"
      >
        <li>1 · Scan</li>
        <li>2 · Review</li>
        <li>3 · Apply</li>
        <li>4 · Verify</li>
      </ol>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Scan existing configuration before reviewing changes. Detection alone
        does not verify that your choices are configured correctly.
      </p>
      {checkpoint && (
        <p className="text-xs text-muted-foreground">
          Last {checkpoint.phase}: {new Date(checkpoint.at).toLocaleString()}.
          Saved history is not live verification.
        </p>
      )}
      {history === null && (
        <p role="alert" className="text-xs text-destructive">
          Saved step history is invalid and was preserved. Setup choices are
          still available.
        </p>
      )}
      {persistence === "saving" && (
        <p role="status" className="text-xs text-muted-foreground">
          Saving step history…
        </p>
      )}
      {persistence === "error" && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-xs text-destructive"
        >
          Step history could not be saved.
          <Button
            size="sm"
            variant="outline"
            onClick={() => void retryPreference(key)}
          >
            Retry saving history
          </Button>
        </div>
      )}
      {(inspection.error || error) && (
        <div role="alert" className="space-y-2 text-xs text-destructive">
          <p className="[overflow-wrap:anywhere]">
            {inspection.error || error}
          </p>
          <p>
            No automatic retry was started. Scan again before creating another
            review.
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          onClick={startScan}
          disabled={!inspection.canInspect || inspection.busy || pending}
        >
          {inspection.error || error
            ? "Retry scan"
            : fresh
              ? "Scan again"
              : "Scan existing"}
        </Button>
        {inspection.busy && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={inspection.canceling}
            onClick={inspection.cancel}
          >
            {inspection.canceling ? "Canceling…" : "Cancel scan"}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!fresh || pending}
          onClick={() => void createReview()}
        >
          Review this step
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setRecovery((value) => !value)}
          aria-expanded={recovery}
        >
          Recovery options
        </Button>
      </div>
      {!inspection.canInspect && (
        <p className="text-xs text-warning">
          Connect this VPS to scan and review its current configuration.
        </p>
      )}
      {recovery && (
        <div className="space-y-2 border-t pt-3 text-xs text-muted-foreground">
          <p>
            Keep the original working connection open. Retry only through a
            fresh review after checking the result.
          </p>
          <p>
            Automatic removal and selective undo are unavailable. Existing
            users, authorized keys, packages and workloads cannot safely be
            removed without ownership and dependency checks. Protected backups
            reported by access actions must be reviewed before restoration.
          </p>
        </div>
      )}
      {fresh && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Observed configuration · {observed.length} sections
          </summary>
          <div className="mt-3 space-y-3">
            {observed.map((section) => (
              <div key={section.id} className="space-y-1">
                <p className="font-medium">
                  {section.title} · {section.state}
                </p>
                {section.message && <p>{section.message}</p>}
                <dl className="max-h-52 overflow-auto rounded-md border p-2">
                  {Object.entries(section.values).map(([label, value]) => (
                    <div
                      key={label}
                      className="grid gap-1 border-b py-2 last:border-0 sm:grid-cols-2"
                    >
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </details>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) {
            sequence.current += 1;
            locked.current = false;
            setPending(false);
          }
          setOpen(value);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Review this step</DialogTitle>
            <DialogDescription className="[overflow-wrap:anywhere]">
              {profile.name} · {profile.username}@{profile.host}:{profile.port}.
              This preflight makes no server changes.
            </DialogDescription>
          </DialogHeader>
          {pending && (
            <p role="status" className="text-sm">
              Creating native review…
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="text-sm text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
          )}
          {review && (
            <div className="min-w-0 space-y-4 text-sm">
              {review.items.map((item) => (
                <section
                  key={item.id}
                  className="space-y-2 rounded-lg border p-3"
                >
                  <h4 className="font-medium">
                    {item.title} · {item.evidenceState}
                  </h4>
                  <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                    {item.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </section>
              ))}
              {items.length > 0 && <QuickSetupResolvedSources items={items} />}
              <p className="text-xs text-warning">
                {access
                  ? "Administrator and key changes use their own exact native reviews and verification controls in the SSH key step."
                  : "Apply and automatic undo are unavailable for this step. No validated installer or recovery command has been produced; this is a preflight only."}
              </p>
              {!reviewLive && (
                <p role="alert" className="text-xs text-destructive">
                  This review is no longer current. Scan again.
                </p>
              )}
            </div>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            {reviewLive && access ? (
              <Button
                onClick={() => {
                  setOpen(false);
                  onStep(3);
                }}
              >
                Open access review and apply
              </Button>
            ) : (
              <Button disabled>Apply unavailable</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
