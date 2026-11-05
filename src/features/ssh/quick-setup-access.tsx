import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { safeError } from "./api";
import type { SetupKey } from "./quick-setup-keys";

interface KeyLoginProof {
  proofId: string;
  profileId: string;
  profileRevision: string;
  connectionId: string;
  keyId: string;
  keyFingerprint: string;
  keyLocation: SetupKey["location"];
  host: string;
  username: string;
  port: number;
  expiresAtMs: number;
}

interface SetupConfigReview {
  reviewId: string;
  proofId: string;
  profileId: string;
  alias: string;
  entry: string;
  destination: string;
  mode: string;
  backup: boolean;
  host: string;
  username: string;
  port: number;
  keyFingerprint: string;
  expiresAtMs: number;
}

interface SetupConfigSave {
  status: string;
  alias: string;
  destination: string;
  backupPath: string | null;
}

interface SourceSelection {
  profileId: string;
  profileRevision: string;
  host: string;
}

interface TargetSelection {
  username: string;
  port: number;
}

const aliasPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const reviewModeLabels: Record<string, string> = {
  create: "Create a new app-owned entry",
  update: "Update the app-owned entry",
  noChange: "No change needed",
};

function aliasErrorText(value: string) {
  return aliasPattern.test(value)
    ? ""
    : "Use 1–64 ASCII letters, numbers, dots, underscores or hyphens, not starting with a hyphen.";
}

function defaultAlias(host: string) {
  const base = host
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const alias = `vps-pilot-${base || "server"}`.slice(0, 64);
  return aliasPattern.test(alias) ? alias : "vps-pilot";
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function rejectReview(reviewId: string) {
  void invoke<void>("ssh_setup_config_reject", { reviewId }).catch(() => {});
}

export function QuickSetupAccess({
  source,
  connectionId,
  connected,
  target,
  selectedKey,
  keyBusy,
  onBusyChange,
}: {
  source: SourceSelection;
  connectionId?: string | null;
  connected: boolean;
  target: TargetSelection;
  selectedKey: SetupKey;
  keyBusy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [proof, setProof] = useState<KeyLoginProof | null>(null);
  const [verifiedAt, setVerifiedAt] = useState<number | null>(null);
  const [verifyError, setVerifyError] = useState("");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [alias, setAlias] = useState(() => defaultAlias(source.host));
  const [aliasError, setAliasError] = useState("");
  const [review, setReview] = useState<SetupConfigReview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveResult, setSaveResult] = useState<SetupConfigSave | null>(null);
  const [notice, setNotice] = useState("");
  const active = useRef(true);
  const epoch = useRef(0);
  const verifySequence = useRef(0);
  const reviewSequence = useRef(0);
  const saveSequence = useRef(0);
  const proofRef = useRef<KeyLoginProof | null>(null);
  const reviewRef = useRef<SetupConfigReview | null>(null);
  const verifyActive = useRef(false);
  const reviewActive = useRef(false);
  const saveActive = useRef(false);

  const invalidate = useCallback((message = "") => {
    const savingNow = saveActive.current;
    const hadActivity = Boolean(
      proofRef.current ||
        reviewRef.current ||
        verifyActive.current ||
        reviewActive.current ||
        savingNow,
    );
    epoch.current += 1;
    verifySequence.current += 1;
    reviewSequence.current += 1;
    verifyActive.current = false;
    reviewActive.current = false;
    setVerifying(false);
    const live = reviewRef.current;
    reviewRef.current = null;
    if (live) rejectReview(live.reviewId);
    proofRef.current = null;
    setProof(null);
    setVerifiedAt(null);
    setUnlockOpen(false);
    setPassphrase("");
    setVerifyError("");
    setAliasError("");
    setSaveResult(null);
    if (!savingNow) {
      setReview(null);
      setReviewOpen(false);
      setReviewPending(false);
      setReviewError("");
      setSaveError("");
    }
    if (hadActivity && message) setNotice(message);
  }, []);

  const expire = useCallback(() => {
    const now = Date.now();
    const currentProof = proofRef.current;
    if (currentProof && currentProof.expiresAtMs <= now) {
      proofRef.current = null;
      setProof(null);
      setVerifiedAt(null);
      setUnlockOpen(false);
      setPassphrase("");
      setNotice("Key login verification expired. Verify the key again.");
    }
    const live = reviewRef.current;
    if (live && live.expiresAtMs <= now) {
      reviewRef.current = null;
      rejectReview(live.reviewId);
      setReview(null);
      setReviewOpen(false);
      setReviewPending(false);
      setReviewError(
        "The SSH config review expired. Create a new review after verifying key login again.",
      );
    }
  }, []);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      epoch.current += 1;
      verifySequence.current += 1;
      reviewSequence.current += 1;
      verifyActive.current = false;
      reviewActive.current = false;
      const live = reviewRef.current;
      reviewRef.current = null;
      if (live) rejectReview(live.reviewId);
      onBusyChange(false);
    };
  }, [onBusyChange]);

  const contextKey = [
    source.profileId,
    source.profileRevision,
    source.host,
    connectionId ?? "",
    selectedKey.keyId,
    selectedKey.fingerprint,
    target.username,
    target.port,
    connected ? "connected" : "disconnected",
  ].join("\u0000");
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const previousContext = useRef(contextKey);
  useEffect(() => {
    if (previousContext.current === contextKey) return;
    previousContext.current = contextKey;
    invalidate("The server, key, or target changed. Verify key login again.");
  }, [contextKey, invalidate]);

  const busy = verifying || reviewPending || saving;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (!proof && !review) return;
    const deadlines = [proof?.expiresAtMs, review?.expiresAtMs].filter(
      (value): value is number => typeof value === "number",
    );
    if (!deadlines.length) return;
    const delay = Math.max(0, Math.min(...deadlines) - Date.now());
    const timer = window.setTimeout(expire, delay);
    return () => window.clearTimeout(timer);
  }, [proof, review, expire]);

  function proofMatches(result: KeyLoginProof) {
    return (
      result.keyLocation === selectedKey.location &&
      result.profileId === source.profileId &&
      result.profileRevision === source.profileRevision &&
      result.connectionId === connectionId &&
      result.keyId === selectedKey.keyId &&
      result.keyFingerprint === selectedKey.fingerprint &&
      result.host === source.host &&
      result.username === target.username &&
      result.port === target.port &&
      result.expiresAtMs > Date.now()
    );
  }

  function reviewMatches(result: SetupConfigReview) {
    const current = proofRef.current;
    return Boolean(
      current &&
        current.expiresAtMs > Date.now() &&
        result.expiresAtMs <= current.expiresAtMs &&
        result.proofId === current.proofId &&
        result.profileId === source.profileId &&
        result.alias === alias &&
        result.host === source.host &&
        result.username === target.username &&
        result.port === target.port &&
        result.keyFingerprint === selectedKey.fingerprint &&
        result.expiresAtMs > Date.now(),
    );
  }

  function contextMatches(captured: string) {
    return contextRef.current === captured;
  }

  function openUnlock() {
    if (keyBusy || busy) return;
    setPassphrase("");
    setVerifyError("");
    setUnlockOpen(true);
  }

  function startVerify() {
    if (keyBusy || busy || verifyActive.current) return;
    setVerifyError("");
    if (selectedKey.encrypted) openUnlock();
    else void submitVerify(null);
  }

  function closeUnlock() {
    epoch.current += 1;
    setPassphrase("");
    setVerifyError("");
    setUnlockOpen(false);
  }

  async function submitVerify(secret: string | null) {
    if (
      verifyActive.current ||
      verifying ||
      keyBusy ||
      !connected ||
      !connectionId
    )
      return;
    if (selectedKey.encrypted && !secret) {
      setVerifyError("Enter the passphrase for the selected encrypted key.");
      return;
    }
    setPassphrase("");
    setVerifyError("");
    const request = ++verifySequence.current;
    const startingEpoch = epoch.current;
    const startingContext = contextRef.current;
    verifyActive.current = true;
    setVerifying(true);
    try {
      const result = await invoke<KeyLoginProof>("ssh_setup_key_verify", {
        profileId: source.profileId,
        profileRevision: source.profileRevision,
        connectionId,
        keyId: selectedKey.keyId,
        username: target.username,
        port: target.port,
        passphrase: secret,
      });
      if (
        !active.current ||
        request !== verifySequence.current ||
        startingEpoch !== epoch.current ||
        !contextMatches(startingContext)
      )
        return;
      if (!proofMatches(result)) {
        setVerifyError(
          "Verification did not match the current server, key, or target. Verify again.",
        );
        return;
      }
      proofRef.current = result;
      setProof(result);
      setVerifiedAt(Date.now());
      setAlias(defaultAlias(source.host));
      setAliasError("");
      setNotice("");
      setReviewError("");
      setSaveResult(null);
      setUnlockOpen(false);
    } catch (failure) {
      if (
        !active.current ||
        request !== verifySequence.current ||
        startingEpoch !== epoch.current ||
        !contextMatches(startingContext)
      )
        return;
      setVerifyError(safeError(failure));
    } finally {
      if (request === verifySequence.current) {
        verifyActive.current = false;
        if (active.current) setVerifying(false);
      }
    }
  }

  function closeReview() {
    if (saving) return;
    reviewSequence.current += 1;
    reviewActive.current = false;
    const live = reviewRef.current;
    reviewRef.current = null;
    if (live) rejectReview(live.reviewId);
    setReview(null);
    setReviewOpen(false);
    setReviewPending(false);
    setReviewError("");
    setSaveError("");
  }

  function reviewConfig() {
    if (reviewActive.current || !proofRef.current || keyBusy || busy) return;
    const message = aliasErrorText(alias);
    if (message) {
      setAliasError(message);
      return;
    }
    setAliasError("");
    setReviewError("");
    setSaveError("");
    setSaveResult(null);
    setReview(null);
    reviewRef.current = null;
    const currentProof = proofRef.current;
    const requestedAlias = alias;
    const request = ++reviewSequence.current;
    const startingEpoch = epoch.current;
    const startingContext = contextRef.current;
    reviewActive.current = true;
    setReviewPending(true);
    setReviewOpen(true);
    void (async () => {
      try {
        const result = await invoke<SetupConfigReview>(
          "ssh_setup_config_review",
          {
            proofId: currentProof.proofId,
            alias: requestedAlias,
          },
        );
        if (
          !active.current ||
          request !== reviewSequence.current ||
          startingEpoch !== epoch.current ||
          !contextMatches(startingContext)
        ) {
          rejectReview(result.reviewId);
          return;
        }
        if (!reviewMatches(result)) {
          rejectReview(result.reviewId);
          setReviewError(
            "The review did not match the current key login proof. Create a new review.",
          );
          return;
        }
        reviewRef.current = result;
        setReview(result);
      } catch (failure) {
        if (
          !active.current ||
          request !== reviewSequence.current ||
          startingEpoch !== epoch.current ||
          !contextMatches(startingContext)
        )
          return;
        setReviewError(safeError(failure));
      } finally {
        if (request === reviewSequence.current) {
          reviewActive.current = false;
          if (active.current) setReviewPending(false);
        }
      }
    })();
  }

  async function saveConfig() {
    if (saveActive.current) return;
    const current = review;
    const currentProof = proofRef.current;
    if (!current || !currentProof) return;
    const now = Date.now();
    if (
      !contextMatches(contextKey) ||
      !reviewMatches(current) ||
      currentProof.expiresAtMs <= now ||
      current.expiresAtMs <= now
    ) {
      reviewSequence.current += 1;
      reviewActive.current = false;
      reviewRef.current = null;
      rejectReview(current.reviewId);
      setReview(null);
      setReviewOpen(false);
      setReviewPending(false);
      setSaveError("");
      setSaveResult(null);
      setReviewError(
        "This SSH config review is stale or expired. Verify key login and create a new review.",
      );
      return;
    }
    reviewRef.current = null;
    saveActive.current = true;
    const startingContext = contextRef.current;
    const request = ++saveSequence.current;
    setSaving(true);
    setSaveError("");
    try {
      const result = await invoke<SetupConfigSave>("ssh_setup_config_save", {
        reviewId: current.reviewId,
      });
      if (result.status === "saved")
        void queryClient.invalidateQueries({
          queryKey: ["ssh", "config-hosts"],
        });
      if (!active.current || request !== saveSequence.current) return;
      if (!contextMatches(startingContext)) {
        setReview(null);
        setReviewOpen(false);
        setReviewError("");
        setNotice(
          "The SSH config was saved for the target that was reviewed. Verify the current target before saving again.",
        );
        return;
      }
      setSaveResult(result);
      setReview(null);
      setReviewOpen(false);
      setReviewError("");
      setNotice(`Saved ${result.alias} to ${result.destination}.`);
    } catch (failure) {
      if (!active.current || request !== saveSequence.current) return;
      setSaveError(safeError(failure));
    } finally {
      if (request === saveSequence.current) {
        saveActive.current = false;
        if (active.current) setSaving(false);
      }
    }
  }

  const verifyDisabled = keyBusy || busy || !connected || !connectionId;
  const reviewDisabled = keyBusy || busy || !proof;
  const saveable = Boolean(
    review && reviewMatches(review) && contextMatches(contextKey),
  );
  const modeLabel = review
    ? (reviewModeLabels[review.mode] ?? review.mode)
    : "";

  return (
    <section
      aria-label="Key login access"
      className="space-y-3 border-t border-border/70 pt-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            role="status"
            aria-label="Key login status"
            className="text-sm font-medium"
          >
            {proof ? "Key login verified" : "Key login not verified"}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed break-all text-muted-foreground">
            {target.username}@{source.host}:{target.port} ·{" "}
            {selectedKey.fingerprint}
          </p>
          {proof && verifiedAt !== null && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Verified at {formatTime(verifiedAt)} · proof valid until{" "}
              {formatTime(proof.expiresAtMs)}.
            </p>
          )}
        </div>
        {!proof && (
          <Button
            type="button"
            variant="outline"
            disabled={verifyDisabled}
            onClick={startVerify}
          >
            {verifying ? "Verifying key login…" : "Verify key login"}
          </Button>
        )}
      </div>

      {!connected || !connectionId ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Connect to this server before verifying key login.
        </p>
      ) : null}

      {verifyError && !unlockOpen && (
        <p role="alert" className="text-sm leading-relaxed text-destructive">
          {verifyError}
        </p>
      )}

      {proof && (
        <div className="space-y-2.5">
          <div className="max-w-sm space-y-1.5">
            <label htmlFor={`${id}-alias`} className="block text-sm">
              SSH config alias
            </label>
            <Input
              id={`${id}-alias`}
              value={alias}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              disabled={keyBusy || busy}
              aria-invalid={Boolean(aliasError)}
              aria-describedby={aliasError ? `${id}-alias-error` : undefined}
              onChange={(event) => {
                setAlias(event.target.value);
                setAliasError("");
              }}
            />
          </div>
          {aliasError && (
            <p
              id={`${id}-alias-error`}
              role="alert"
              className="text-xs leading-relaxed text-destructive"
            >
              {aliasError}
            </p>
          )}
          <Button
            type="button"
            disabled={reviewDisabled}
            onClick={reviewConfig}
          >
            {reviewPending ? "Preparing review…" : "Review SSH config"}
          </Button>
          {saveResult && (
            <p
              role="status"
              aria-label="SSH config save result"
              className="text-xs leading-relaxed text-muted-foreground"
            >
              Saved {saveResult.alias} to {saveResult.destination}.
              {saveResult.backupPath
                ? ` Protected backup: ${saveResult.backupPath}.`
                : ""}{" "}
              The current connection is unchanged.
            </p>
          )}
        </div>
      )}

      {notice && (
        <p
          role="status"
          aria-label="Key login activity"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {notice}
        </p>
      )}

      {reviewError && !reviewOpen && (
        <p
          role="alert"
          aria-label="SSH config review error"
          className="text-sm leading-relaxed text-destructive"
        >
          {reviewError}
        </p>
      )}

      <Dialog
        open={unlockOpen}
        onOpenChange={(open) => {
          if (!open) closeUnlock();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unlock selected key</DialogTitle>
            <DialogDescription>
              Enter the passphrase once for the encrypted key{" "}
              {selectedKey.fingerprint}. It is used for this verification and is
              not saved.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-passphrase`} className="block text-sm">
              Key passphrase
            </label>
            <Input
              id={`${id}-passphrase`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={passphrase}
              disabled={verifying}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </div>
          {verifyError && (
            <p
              role="alert"
              className="text-sm leading-relaxed text-destructive"
            >
              {verifyError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={verifying}
              onClick={closeUnlock}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={verifying || !passphrase}
              onClick={() => void submitVerify(passphrase)}
            >
              {verifying ? "Verifying key login…" : "Verify key login"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reviewOpen}
        onOpenChange={(open) => {
          if (!open) closeReview();
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-lg"
          showCloseButton={!saving}
        >
          <DialogHeader>
            <DialogTitle>Review SSH config</DialogTitle>
            <DialogDescription>
              This adds one app-owned entry and preserves unrelated aliases,
              comments and defaults.
            </DialogDescription>
          </DialogHeader>

          {reviewPending && (
            <p role="status" className="text-sm text-muted-foreground">
              Preparing the reviewed entry…
            </p>
          )}
          {reviewError && (
            <p
              role="alert"
              className="text-sm leading-relaxed text-destructive"
            >
              {reviewError}
            </p>
          )}

          {review && (
            <div className="min-w-0 space-y-3">
              <dl className="divide-y divide-border/70 border-y border-border/70">
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    Alias
                  </dt>
                  <dd className="min-w-0 text-sm break-all">{review.alias}</dd>
                </div>
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    Target
                  </dt>
                  <dd className="min-w-0 text-sm break-all">
                    {review.username}@{review.host}:{review.port}
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
                    Change
                  </dt>
                  <dd className="min-w-0 text-sm">{modeLabel}</dd>
                </div>
                <div className="grid gap-1 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:text-sm">
                    Destination
                  </dt>
                  <dd className="min-w-0 text-sm break-all">
                    {review.destination}
                  </dd>
                </div>
              </dl>

              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">New app-owned entry</p>
                <pre className="max-h-64 min-w-0 max-w-full overflow-auto rounded-md border border-border/70 bg-muted/40 p-2 font-mono text-xs leading-relaxed whitespace-pre">
                  {review.entry}
                </pre>
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">
                {review.mode === "noChange"
                  ? "This entry already matches the reviewed content, so saving writes no change."
                  : review.backup
                    ? "A protected backup of the existing file is made before the staged, atomic replacement."
                    : "The SSH config file is created with protected permissions."}{" "}
                Other aliases, comments and defaults are preserved.
              </p>
              {!saveable && !reviewError && (
                <p
                  role="alert"
                  className="text-xs leading-relaxed text-destructive"
                >
                  This review no longer matches the current target or has
                  expired. Close it and create a new review.
                </p>
              )}
            </div>
          )}

          {saveError && (
            <p
              role="alert"
              className="text-sm leading-relaxed text-destructive"
            >
              {saveError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={closeReview}
            >
              Cancel
            </Button>
            {review && !saveError && (
              <Button
                type="button"
                disabled={saving || !saveable}
                onClick={() => void saveConfig()}
              >
                {saving ? "Saving…" : "Save to SSH config"}
              </Button>
            )}
            {reviewError && !reviewPending && !review && (
              <Button type="button" disabled={saving} onClick={reviewConfig}>
                Retry review
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
