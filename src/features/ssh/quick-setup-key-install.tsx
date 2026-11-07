import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { safeError } from "./api";
import { useCommandActivity } from "./command-activity";

interface InstallSource {
  profileId: string;
  profileRevision: string;
  host: string;
  username: string;
  port: number;
}

interface InstallReview {
  reviewId: string;
  profileId: string;
  profileRevision: string;
  connectionId: string;
  keyId: string;
  keyFingerprint: string;
  username: string;
  host: string;
  port: number;
  destination: string;
  command: string;
  purpose: string;
  alreadyPresent: boolean;
  backupPlanned: boolean;
  expiresAtMs: number;
}

interface InstallApplyResult {
  status: "installed" | "alreadyPresent";
  backupPath: string | null;
  username: string;
  port: number;
}

function rejectInstallReview(reviewId: string) {
  void invoke<void>("ssh_setup_key_install_reject", { reviewId }).catch(
    () => {},
  );
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function QuickSetupKeyInstall({
  source,
  connectionId,
  connected,
  keyId,
  keyFingerprint,
  targetUsername,
  controlsBusy,
  onInstallationBusyChange,
  onInvalidate,
  onInstalled,
}: {
  source: InstallSource;
  connectionId?: string | null;
  connected: boolean;
  keyId: string;
  keyFingerprint: string;
  targetUsername?: string | null;
  controlsBusy: boolean;
  onInstallationBusyChange: (busy: boolean) => void;
  onInvalidate: () => void;
  onInstalled?: (username: string) => void;
}) {
  const id = useId();
  const log = useCommandActivity();
  const [review, setReview] = useState<InstallReview | null>(null);
  const [open, setOpen] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<InstallApplyResult | null>(null);
  const [notice, setNotice] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const active = useRef(true);
  const sequence = useRef(0);
  const reviewInFlight = useRef(false);
  const applyInFlight = useRef(false);
  const applySequence = useRef(0);
  const reviewRef = useRef<InstallReview | null>(null);

  const contextKey = [
    source.profileId,
    source.profileRevision,
    source.host,
    source.username,
    source.port,
    connectionId ?? "",
    keyId,
    keyFingerprint,
    targetUsername ?? "",
    connected ? "connected" : "disconnected",
  ].join("\u0000");
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const previousContext = useRef(contextKey);

  const installationBusy = open || reviewPending || applying;
  useEffect(() => {
    onInstallationBusyChange(installationBusy);
  }, [installationBusy, onInstallationBusyChange]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      sequence.current += 1;
      applySequence.current += 1;
      reviewInFlight.current = false;
      applyInFlight.current = false;
      const live = reviewRef.current;
      reviewRef.current = null;
      if (live) rejectInstallReview(live.reviewId);
      onInstallationBusyChange(false);
    };
  }, [onInstallationBusyChange]);

  useEffect(() => {
    if (previousContext.current === contextKey) return;
    previousContext.current = contextKey;
    if (applying) return;
    sequence.current += 1;
    reviewInFlight.current = false;
    const live = reviewRef.current;
    reviewRef.current = null;
    if (live) rejectInstallReview(live.reviewId);
    setReview(null);
    setReviewPending(false);
    setOpen(false);
    setCommandOpen(false);
    setResult(null);
    setNotice("");
    setError(
      "The server, connection, account, port, or key changed. Start a new installation review.",
    );
  }, [contextKey, applying]);

  useEffect(() => {
    if (!review) return;
    const delay = Math.max(0, review.expiresAtMs - Date.now());
    const timer = window.setTimeout(() => {
      if (!active.current) return;
      const live = reviewRef.current;
      if (!live || live.expiresAtMs > Date.now()) return;
      reviewInFlight.current = false;
      reviewRef.current = null;
      rejectInstallReview(live.reviewId);
      setReview(null);
      setReviewPending(false);
      setApplying(false);
      setOpen(false);
      setCommandOpen(false);
      setError("The installation review expired. Start a new review.");
    }, delay);
    return () => window.clearTimeout(timer);
  }, [review]);

  function reviewMatches(value: InstallReview) {
    return (
      typeof value.reviewId === "string" &&
      value.reviewId.length > 0 &&
      value.profileId === source.profileId &&
      value.profileRevision === source.profileRevision &&
      value.connectionId === connectionId &&
      value.keyId === keyId &&
      value.keyFingerprint === keyFingerprint &&
      value.username === (targetUsername ?? source.username) &&
      value.host === source.host &&
      value.port === source.port &&
      typeof value.destination === "string" &&
      typeof value.command === "string" &&
      typeof value.purpose === "string" &&
      typeof value.alreadyPresent === "boolean" &&
      typeof value.backupPlanned === "boolean" &&
      typeof value.expiresAtMs === "number" &&
      value.expiresAtMs > Date.now()
    );
  }

  function applyMatches(
    value: InstallApplyResult,
    username: string,
    port: number,
  ) {
    return (
      (value.status === "installed" || value.status === "alreadyPresent") &&
      value.username === username &&
      value.port === port &&
      (value.backupPath === null || typeof value.backupPath === "string")
    );
  }

  function contextMatches(captured: string) {
    return contextRef.current === captured;
  }

  function closeReview() {
    if (applying) return;
    sequence.current += 1;
    reviewInFlight.current = false;
    const live = reviewRef.current;
    reviewRef.current = null;
    if (live) rejectInstallReview(live.reviewId);
    setReview(null);
    setReviewPending(false);
    setOpen(false);
    setCommandOpen(false);
    if (live?.alreadyPresent) {
      setNotice(
        `This public key is already installed for ${live.username}. Use Test key on the current connection to verify it.`,
      );
    }
  }

  async function startReview() {
    if (
      reviewInFlight.current ||
      applyInFlight.current ||
      reviewPending ||
      applying ||
      controlsBusy ||
      !connected ||
      !connectionId
    )
      return;
    reviewInFlight.current = true;
    setError("");
    setNotice("");
    setResult(null);
    setCommandOpen(false);
    setReview(null);
    reviewRef.current = null;
    const startingContext = contextRef.current;
    const token = ++sequence.current;
    setReviewPending(true);
    setOpen(true);
    onInvalidate();
    try {
      const value = await invoke<InstallReview>(
        "ssh_setup_key_install_review",
        {
          profileId: source.profileId,
          profileRevision: source.profileRevision,
          connectionId,
          keyId,
          targetUsername: targetUsername ?? null,
        },
      );
      if (
        !active.current ||
        token !== sequence.current ||
        !contextMatches(startingContext)
      ) {
        if (typeof value.reviewId === "string") {
          rejectInstallReview(value.reviewId);
        }
        return;
      }
      if (!reviewMatches(value)) {
        rejectInstallReview(value.reviewId);
        setError(
          "The installation review did not match the current server, account, port, or key. Start a new review.",
        );
        return;
      }
      reviewRef.current = value;
      setReview(value);
    } catch (failure) {
      if (
        !active.current ||
        token !== sequence.current ||
        !contextMatches(startingContext)
      )
        return;
      setError(
        `${safeError(failure)} The public key was not installed. The current connection is unchanged. Start a new review when ready.`,
      );
    } finally {
      if (token === sequence.current) {
        reviewInFlight.current = false;
        if (active.current) setReviewPending(false);
      }
    }
  }

  async function applyReview() {
    if (applyInFlight.current) return;
    const current = reviewRef.current;
    if (!current || applying || !connected || !connectionId) return;
    if (current.expiresAtMs <= Date.now() || !reviewMatches(current)) {
      reviewRef.current = null;
      rejectInstallReview(current.reviewId);
      setReview(null);
      setReviewPending(false);
      setOpen(false);
      setCommandOpen(false);
      setError(
        "This installation review is stale or expired. Start a new review.",
      );
      return;
    }
    applyInFlight.current = true;
    const token = ++applySequence.current;
    const startingContext = contextRef.current;
    const expectedUsername = current.username;
    const expectedPort = current.port;
    reviewRef.current = null;
    setReview(null);
    setApplying(true);
    setError("");
    setCommandOpen(false);
    onInvalidate();
    const operationId = log.begin(
      `Install public key for ${current.username}`,
      current.command,
      { group: "setup-key-install" },
    );
    try {
      const value = await invoke<InstallApplyResult>(
        "ssh_setup_key_install_apply",
        { reviewId: current.reviewId },
      );
      const confirmed =
        contextMatches(startingContext) &&
        applyMatches(value, expectedUsername, expectedPort);
      log.update(operationId, {
        status: confirmed ? "completed" : "failed",
        ended: Date.now(),
        code: confirmed ? 0 : null,
        message: confirmed
          ? "Public key installation completed. Key login still requires a separate test."
          : "Installation outcome is not confirmed. Review the server again before retrying.",
        output: `Account: ${expectedUsername}\nKey fingerprint: ${keyFingerprint}`,
      });
      if (!active.current) return;
      if (!contextMatches(startingContext)) {
        setError(
          "The connection changed while the key installation was in progress. The outcome is not confirmed. Reconnect, then start a fresh review or test key login. The original connection setting is unchanged.",
        );
        return;
      }
      if (!applyMatches(value, expectedUsername, expectedPort)) {
        setError(
          "The installation result did not match the reviewed account or port. The outcome is not confirmed. Start a fresh review or test key login. The original connection setting is unchanged.",
        );
        return;
      }
      setResult(value);
      setOpen(false);
      setError("");
      onInstallationBusyChange(false);
      onInstalled?.(value.username);
      onInvalidate();
    } catch (failure) {
      log.update(operationId, {
        status: "failed",
        ended: Date.now(),
        code: null,
        message:
          "Public key installation was not confirmed. Review the server again before retrying.",
      });
      if (!active.current) return;
      if (!contextMatches(startingContext)) {
        setError(
          "The connection changed while the key installation was in progress. The outcome is not confirmed. Reconnect, then start a fresh review or test key login. The original connection setting is unchanged.",
        );
      } else {
        setError(
          `${safeError(failure)} The key installation was not confirmed. The original connection remains in use. Start a fresh review before trying again.`,
        );
      }
    } finally {
      if (token === applySequence.current) {
        applyInFlight.current = false;
        if (active.current) setApplying(false);
      }
    }
  }

  const reviewDisabled =
    controlsBusy || reviewPending || applying || !connected || !connectionId;
  const canApply = Boolean(
    review && !review.alreadyPresent && connected && reviewMatches(review),
  );
  const backupText = review
    ? review.alreadyPresent
      ? "No change; this key is already installed."
      : review.backupPlanned
        ? "Existing keys are backed up on the server before the new key is appended."
        : "The server creates a new keys file with restricted permissions."
    : "";

  return (
    <section
      aria-label="Install public key"
      className="space-y-2.5 border-t border-border/70 pt-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Install public key</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {targetUsername
              ? `Add the selected public key for the planned administrator ${targetUsername} through the existing root connection.`
              : `Add the selected public key for ${source.username} on the current connection.`}{" "}
            Existing keys are preserved.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={reviewDisabled}
          onClick={() => void startReview()}
        >
          {reviewPending
            ? "Preparing review…"
            : targetUsername
              ? `Install key for ${targetUsername}`
              : "Install public key"}
        </Button>
      </div>

      {!connected || !connectionId ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Connect to this server before installing the public key.
        </p>
      ) : null}

      {result && (
        <p
          role="status"
          aria-label="Key installation result"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {result.status === "installed"
            ? `Installed the public key for ${result.username}@${source.host}:${result.port}.`
            : `The public key was already installed for ${result.username}@${source.host}:${result.port}.`}{" "}
          {result.backupPath
            ? `A protected backup was kept at ${result.backupPath}.`
            : ""}{" "}
          Test key login on the current connection to verify access. The current
          connection is unchanged.
        </p>
      )}

      {notice && !open && (
        <p
          role="status"
          aria-label="Key installation notice"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {notice}
        </p>
      )}

      {error && !open && (
        <p
          role="alert"
          aria-label="Key installation error"
          className="text-sm leading-relaxed text-destructive"
        >
          {error}
        </p>
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) closeReview();
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-lg"
          showCloseButton={!applying}
        >
          <DialogHeader>
            <DialogTitle>Review public key installation</DialogTitle>
            <DialogDescription>
              The server adds this public key for{" "}
              {targetUsername
                ? `the planned administrator ${targetUsername}`
                : "the current account"}
              . Existing keys, passwords, SSH ports and firewall settings are
              not changed.
            </DialogDescription>
          </DialogHeader>

          {reviewPending && (
            <p role="status" className="text-sm text-muted-foreground">
              Preparing the installation review…
            </p>
          )}

          {applying && (
            <p role="status" className="text-sm text-muted-foreground">
              Installing the public key…
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="text-sm leading-relaxed text-destructive"
            >
              {error}
            </p>
          )}

          {review && (
            <div className="min-w-0 space-y-3">
              <dl className="divide-y divide-border/70 border-y border-border/70">
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    Server
                  </dt>
                  <dd className="min-w-0 text-sm break-all">{review.host}</dd>
                </div>
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    {targetUsername
                      ? "Planned administrator"
                      : "Current account"}
                  </dt>
                  <dd className="min-w-0 text-sm break-all">
                    {review.username}
                  </dd>
                </div>
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    Current port
                  </dt>
                  <dd className="min-w-0 text-sm tabular-nums">
                    {review.port}
                  </dd>
                </div>
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    Destination
                  </dt>
                  <dd className="min-w-0 text-sm break-all">
                    {review.destination}
                  </dd>
                </div>
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    Key
                  </dt>
                  <dd className="min-w-0 text-sm break-all">
                    {review.keyFingerprint}
                  </dd>
                </div>
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    Backup
                  </dt>
                  <dd className="min-w-0 text-sm leading-relaxed">
                    {backupText}
                  </dd>
                </div>
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    Purpose
                  </dt>
                  <dd className="min-w-0 text-sm leading-relaxed">
                    {review.purpose ||
                      "Add this public key for the current account."}
                  </dd>
                </div>
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    Review expires
                  </dt>
                  <dd className="min-w-0 text-sm tabular-nums">
                    {formatTime(review.expiresAtMs)}
                  </dd>
                </div>
              </dl>

              {review.alreadyPresent && (
                <p
                  role="status"
                  className="text-sm leading-relaxed text-muted-foreground"
                >
                  This public key is already installed for {review.username}.
                  Close this review and use Test key on the current connection
                  to verify it. No duplicate key will be added.
                </p>
              )}

              <div className="min-w-0 space-y-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={commandOpen}
                  aria-controls={`${id}-command`}
                  disabled={applying}
                  onClick={() => setCommandOpen((value) => !value)}
                  className="-ml-2.5 text-muted-foreground"
                >
                  {commandOpen ? "Hide exact command" : "Show exact command"}
                </Button>
                {commandOpen && (
                  <pre
                    id={`${id}-command`}
                    className="max-h-64 min-w-0 max-w-full overflow-auto rounded-md border border-border/70 bg-muted/40 p-2 font-mono text-xs leading-relaxed whitespace-pre"
                  >
                    {review.command}
                  </pre>
                )}
              </div>

              {!review.alreadyPresent && !canApply && !error && (
                <p
                  role="alert"
                  className="text-xs leading-relaxed text-destructive"
                >
                  This review no longer matches the current target or has
                  expired. Close it and start a new review.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={applying}
              onClick={closeReview}
            >
              Close
            </Button>
            {review && !review.alreadyPresent && (
              <Button
                type="button"
                disabled={!canApply}
                onClick={() => void applyReview()}
              >
                Install key for {review.username}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
