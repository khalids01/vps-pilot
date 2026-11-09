import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
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
import { profileQueryKey, safeError, statusQueryKey } from "./api";
import { useCommandActivity } from "./command-activity";
import type { SetupKey } from "./quick-setup-keys";
import {
  type QuickSetupProgressStage,
  readQuickSetupDraft,
  readQuickSetupProgress,
  writeQuickSetupDraft,
  writeQuickSetupProgress,
} from "./quick-setup-model";

interface AdminSource {
  profileId: string;
  profileRevision: string;
  host: string;
  username: string;
  port: number;
}

interface AdminReview {
  reviewId: string;
  profileId: string;
  profileRevision: string;
  connectionId: string;
  keyId: string;
  keyFingerprint: string;
  sourceUsername: string;
  username: string;
  host: string;
  port: number;
  osId: string;
  osVersion: string;
  action: "create" | "adopt";
  home: string | null;
  plannedHome: string;
  command: string;
  purpose: string;
  expiresAtMs: number;
}

interface AdminApplyResult {
  status: "created" | "adopted";
  username: string;
  sourceUsername: string;
  osId: string;
  osVersion: string;
}

interface AdminProof {
  proofId: string;
  profileId: string;
  profileRevision: string;
  connectionId: string;
  keyId: string;
  keyFingerprint: string;
  host: string;
  sourceUsername: string;
  username: string;
  port: number;
  sudoVerified: boolean;
  expiresAtMs: number;
}

interface AdminPromotion {
  profile: {
    id: string;
    name: string;
    username: string;
    host: string;
    port: number;
  };
  previousUsername: string;
  sourceProfileId: string;
  connectionId: string;
  connected: boolean;
}

export type AdminStage =
  | "pending"
  | "account-ready"
  | "key-installed"
  | "verified"
  | "promoted";

const persistedStage: Record<AdminStage, QuickSetupProgressStage | null> = {
  pending: null,
  "account-ready": "accountReady",
  "key-installed": "keyInstalled",
  verified: "accessVerified",
  promoted: "accessPromoted",
};

function rejectAdminReview(reviewId: string) {
  void invoke<void>("ssh_setup_admin_reject", { reviewId }).catch(() => {});
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const sudoCheckCommand =
  "exec /usr/bin/sudo -S -k -p '' -u root -- /usr/bin/id -u";

export function QuickSetupAdmin({
  visible = true,
  source,
  mode,
  username,
  connectionId,
  connected,
  selectedKey,
  keyBusy,
  keyInstalled = false,
  keyInstallation,
  onBusyChange,
  onStageChange,
  onOpenProfile,
}: {
  visible?: boolean;
  source: AdminSource;
  mode: "new" | "existing";
  username: string;
  plannedPort: number;
  connectionId?: string | null;
  connected: boolean;
  selectedKey: SetupKey;
  keyBusy: boolean;
  keyInstalled?: boolean;
  keyInstallation?: ReactNode;
  onBusyChange: (busy: boolean) => void;
  onStageChange: (stage: AdminStage) => void;
  onOpenProfile: (profileId: string) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const log = useCommandActivity();
  const [stage, setStage] = useState<AdminStage>(() => {
    // Restored non-secret progress never claims a live proof: anything at or
    // beyond "verified" comes back as key-installed until this run re-proves it.
    const saved = readQuickSetupProgress(source.profileId);
    if (!saved || saved.username !== username) return "pending";
    if (saved.keyId !== selectedKey.keyId) return "account-ready";
    if (saved.stage === "accessPromoted" || saved.stage === "accessVerified")
      return "key-installed";
    return saved.stage === "accountReady"
      ? "account-ready"
      : saved.stage === "keyInstalled"
        ? "key-installed"
        : "pending";
  });
  useEffect(() => {
    if (keyInstalled && stage === "account-ready") setStage("key-installed");
  }, [keyInstalled, stage]);
  const [review, setReview] = useState<AdminReview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [sudoPassword, setSudoPassword] = useState("");
  const [verifyPasswordOpen, setVerifyPasswordOpen] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [proof, setProof] = useState<AdminProof | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState("");
  const [promoted, setPromoted] = useState<AdminPromotion | null>(null);
  const active = useRef(true);
  const sequence = useRef(0);
  const reviewRef = useRef<AdminReview | null>(null);
  const proofRef = useRef<AdminProof | null>(null);
  const applyActive = useRef(false);
  const verifyActive = useRef(false);
  const promoteActive = useRef(false);

  const isRoot = source.username === "root";
  const busy =
    reviewPending || applying || verifying || promoting || Boolean(review);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    onStageChange(stage);
  }, [stage, onStageChange]);

  useEffect(() => {
    const saved = persistedStage[stage];
    if (!saved || promoted) return;
    writeQuickSetupProgress(source.profileId, {
      version: 1,
      stage: saved,
      username,
      keyId: selectedKey.keyId,
    });
  }, [stage, promoted, source.profileId, username, selectedKey.keyId]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      sequence.current += 1;
      applyActive.current = false;
      verifyActive.current = false;
      promoteActive.current = false;
      const live = reviewRef.current;
      reviewRef.current = null;
      if (live) rejectAdminReview(live.reviewId);
      setPassword("");
      setSudoPassword("");
      setPassphrase("");
      onBusyChange(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    if (!proof) return;
    const delay = Math.max(0, proof.expiresAtMs - Date.now());
    const timer = window.setTimeout(() => {
      if (!active.current) return;
      proofRef.current = null;
      setProof(null);
      setStage("key-installed");
      setNotice(
        "Administrator proof expired before access was promoted. Verify administrator access again.",
      );
    }, delay);
    return () => window.clearTimeout(timer);
  }, [proof]);

  const bindingKey = [
    source.profileId,
    source.profileRevision,
    source.host,
    source.username,
    source.port,
    connectionId ?? "",
    mode,
    username,
    selectedKey.keyId,
    selectedKey.fingerprint,
  ].join("\u0000");
  const contextKey = `${bindingKey}\u0000${visible}`;
  const previousBinding = useRef(bindingKey);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const previousContext = useRef(contextKey);
  useEffect(() => {
    if (previousContext.current === contextKey) return;
    previousContext.current = contextKey;
    const bindingChanged = previousBinding.current !== bindingKey;
    previousBinding.current = bindingKey;
    if (promoted) return;
    sequence.current += 1;
    const live = reviewRef.current;
    reviewRef.current = null;
    if (live) rejectAdminReview(live.reviewId);
    setReview(null);
    setReviewOpen(false);
    setProof(null);
    proofRef.current = null;
    setError("");
    setVerifyError("");
    setPromoteError("");
    setPassword("");
    setSudoPassword("");
    setPassphrase("");
    setVerifyPasswordOpen(false);
    setStage((current) =>
      bindingChanged
        ? "pending"
        : current === "verified"
          ? "key-installed"
          : current,
    );
  }, [bindingKey, contextKey, promoted]);

  function reviewMatches(value: AdminReview) {
    return (
      typeof value.reviewId === "string" &&
      value.reviewId.length > 0 &&
      value.profileId === source.profileId &&
      value.profileRevision === source.profileRevision &&
      value.connectionId === connectionId &&
      value.keyId === selectedKey.keyId &&
      value.keyFingerprint === selectedKey.fingerprint &&
      value.sourceUsername === source.username &&
      value.username === username &&
      value.host === source.host &&
      value.port === source.port &&
      (value.action === "create" || value.action === "adopt") &&
      (mode === "new" ? value.action === "create" : value.action === "adopt") &&
      typeof value.expiresAtMs === "number" &&
      value.expiresAtMs > Date.now()
    );
  }

  function proofMatches(value: AdminProof) {
    return (
      value.profileId === source.profileId &&
      value.profileRevision === source.profileRevision &&
      value.connectionId === connectionId &&
      value.keyId === selectedKey.keyId &&
      value.keyFingerprint === selectedKey.fingerprint &&
      value.sourceUsername === source.username &&
      value.username === username &&
      value.host === source.host &&
      value.port === source.port &&
      value.sudoVerified === true &&
      value.expiresAtMs > Date.now()
    );
  }

  function closeReview() {
    if (applying) return;
    sequence.current += 1;
    const live = reviewRef.current;
    reviewRef.current = null;
    if (live) rejectAdminReview(live.reviewId);
    setReview(null);
    setReviewOpen(false);
    setPassword("");
  }

  async function startReview() {
    if (reviewPending || applying || keyBusy || !connected || !connectionId)
      return;
    setError("");
    setNotice("");
    setReview(null);
    reviewRef.current = null;
    const starting = contextRef.current;
    const token = ++sequence.current;
    setReviewPending(true);
    setReviewOpen(true);
    try {
      const value = await invoke<AdminReview>("ssh_setup_admin_review", {
        profileId: source.profileId,
        profileRevision: source.profileRevision,
        connectionId,
        keyId: selectedKey.keyId,
        username,
        mode,
      });
      if (
        !active.current ||
        token !== sequence.current ||
        contextRef.current !== starting
      ) {
        if (typeof value.reviewId === "string")
          rejectAdminReview(value.reviewId);
        return;
      }
      if (!reviewMatches(value)) {
        rejectAdminReview(value.reviewId);
        setError(
          "The administrator review did not match the current root connection, planned account, or key. Start a new review.",
        );
        setReviewOpen(false);
        return;
      }
      reviewRef.current = value;
      setReview(value);
    } catch (failure) {
      if (!active.current || token !== sequence.current) return;
      setReviewOpen(false);
      setError(
        `${safeError(failure)} No account was created or changed. The root connection is unchanged.`,
      );
    } finally {
      if (token === sequence.current) {
        setReviewPending(false);
        applyActive.current = false;
      }
    }
  }

  async function applyReview() {
    const current = reviewRef.current;
    if (!current || applying || applyActive.current) return;
    if (current.action === "create" && password.length === 0) {
      setError("Enter the sudo password for the new administrator account.");
      return;
    }
    if (current.expiresAtMs <= Date.now() || !reviewMatches(current)) {
      reviewRef.current = null;
      rejectAdminReview(current.reviewId);
      setReview(null);
      setReviewOpen(false);
      setError(
        "This administrator review is stale or expired. Start a new review.",
      );
      return;
    }
    applyActive.current = true;
    setApplying(true);
    setError("");
    const operationId = log.begin(
      `${current.action === "create" ? "Create" : "Adopt"} administrator ${current.username}`,
      current.command,
      { group: "setup-admin" },
    );
    try {
      const value = await invoke<AdminApplyResult>("ssh_setup_admin_apply", {
        reviewId: current.reviewId,
        password: current.action === "create" ? password : "",
      });
      reviewRef.current = null;
      setReview(null);
      setReviewOpen(false);
      setPassword("");
      const confirmed =
        active.current &&
        (value.status === "created" || value.status === "adopted") &&
        value.username === username &&
        value.sourceUsername === source.username &&
        (current.action === "create"
          ? value.status === "created"
          : value.status === "adopted");
      log.update(operationId, {
        status: confirmed ? "completed" : "failed",
        ended: Date.now(),
        code: confirmed ? 0 : null,
        message: confirmed
          ? "Administrator account prepared. Install the public key, then apply and verify to prove sudo."
          : "The administrator result was not confirmed. Review the server account before retrying.",
        output: `Account: ${username}\nRoot connection: ${source.username}@${source.host}:${source.port}`,
      });
      if (!confirmed) {
        setError(
          "The administrator result did not match the reviewed account. Verify the account manually; no automatic retry is made.",
        );
        return;
      }
      setStage("account-ready");
      setNotice(
        `${value.status === "created" ? "Created" : "Adopted"} ${value.username} with validated sudoers on ${value.osId} ${value.osVersion}. Its public key is the next step.`,
      );
    } catch (failure) {
      log.update(operationId, {
        status: "failed",
        ended: Date.now(),
        code: null,
        message:
          "Administrator setup was not confirmed. Review the server account before retrying.",
      });
      if (!active.current) return;
      setError(
        `${safeError(failure)} The root connection remains in use. Review the account before creating another review; nothing retries automatically.`,
      );
    } finally {
      applyActive.current = false;
      if (active.current) setApplying(false);
    }
  }

  function startVerify() {
    if (!connected || !connectionId || verifyActive.current) return;
    setVerifyError("");
    setSudoPassword("");
    setPassphrase("");
    setVerifyPasswordOpen(true);
  }

  async function submitVerify() {
    if (verifyActive.current || !connected || !connectionId) return;
    if (sudoPassword.length === 0) {
      setVerifyError(
        "Enter the administrator's sudo password to verify actual sudo.",
      );
      return;
    }
    verifyActive.current = true;
    setVerifying(true);
    setVerifyError("");
    const token = ++sequence.current;
    const starting = contextRef.current;
    const operationId = log.begin(
      `Verify administrator access for ${username}`,
      sudoCheckCommand,
      { group: "setup-admin" },
    );
    try {
      const value = await invoke<AdminProof>("ssh_setup_admin_verify", {
        profileId: source.profileId,
        profileRevision: source.profileRevision,
        connectionId,
        keyId: selectedKey.keyId,
        username,
        passphrase: passphrase || null,
        sudoPassword,
      });
      const confirmed =
        active.current &&
        token === sequence.current &&
        contextRef.current === starting &&
        proofMatches(value);
      log.update(operationId, {
        status: confirmed ? "completed" : "failed",
        ended: Date.now(),
        code: confirmed ? 0 : null,
        message: confirmed
          ? "Independent key login and sudo to root verified. Access can now be promoted."
          : "Administrator verification was not confirmed.",
        output: `Account: ${username}\nKey: ${selectedKey.fingerprint}`,
      });
      if (!confirmed) {
        if (active.current) {
          setVerifyError(
            "The verification result did not match this connection, account, or key. Verify administrator access again.",
          );
        }
        return;
      }
      setProof(value);
      proofRef.current = value;
      setVerifyPasswordOpen(false);
      setSudoPassword("");
      setPassphrase("");
      setStage("verified");
      setNotice(
        `Independent key login as ${value.username} succeeded and sudo to root was verified. Promote access to save a separate administrator profile. The root profile and its session stay available.`,
      );
    } catch (failure) {
      log.update(operationId, {
        status: "failed",
        ended: Date.now(),
        code: null,
        message: "Administrator access was not verified.",
      });
      if (!active.current || token !== sequence.current) return;
      setVerifyError(safeError(failure));
    } finally {
      verifyActive.current = false;
      if (active.current) setVerifying(false);
    }
  }

  async function promote() {
    const current = proofRef.current;
    if (!current || promoting || promoteActive.current) return;
    if (current.expiresAtMs <= Date.now() || !proofMatches(current)) {
      proofRef.current = null;
      setProof(null);
      setStage("key-installed");
      setPromoteError(
        "Administrator proof is stale or expired. Verify administrator access again.",
      );
      return;
    }
    promoteActive.current = true;
    setPromoting(true);
    setPromoteError("");
    try {
      const value = await invoke<AdminPromotion>("ssh_setup_admin_promote", {
        proofId: current.proofId,
      });
      if (!active.current) return;
      if (
        !value.profile ||
        typeof value.profile.id !== "string" ||
        value.profile.username !== username ||
        value.profile.host !== source.host ||
        value.profile.port !== source.port ||
        value.previousUsername !== source.username ||
        value.sourceProfileId !== source.profileId ||
        typeof value.connectionId !== "string"
      ) {
        setPromoteError(
          "The promoted profile did not match the verified administrator. Nothing was switched; the root connection remains.",
        );
        return;
      }
      proofRef.current = null;
      setProof(null);
      if (!value.connected || !value.connectionId) {
        setPromoteError(
          "The administrator profile was saved, but its connection closed. Reconnect using the saved administrator profile. The original root profile is unchanged.",
        );
        await queryClient.invalidateQueries({ queryKey: profileQueryKey });
        return;
      }
      const savedDraft = readQuickSetupDraft(source.profileId);
      if (savedDraft.status === "ok") {
        writeQuickSetupDraft(value.profile.id, {
          ...savedDraft.draft,
          step: 4,
          administrator: {
            ...savedDraft.draft.administrator,
            mode: "existing",
          },
        });
      }
      writeQuickSetupProgress(source.profileId, {
        version: 1,
        stage: "accessPromoted",
        username,
        keyId: selectedKey.keyId,
      });
      setPromoted(value);
      setStage("promoted");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: profileQueryKey }),
        queryClient.invalidateQueries({ queryKey: statusQueryKey }),
      ]);
      setNotice(
        `Saved ${value.profile.name} as a separate connected administrator profile and opened it. The original ${source.username} profile and its terminal session are unchanged. SSH port, sshd key-only policy and firewall changes remain pending.`,
      );
      onOpenProfile(value.profile.id);
    } catch (failure) {
      if (!active.current) return;
      setPromoteError(
        `${safeError(failure)} The verified administrator connection was kept and the root profile is unchanged. Retry switching explicitly; nothing retries automatically.`,
      );
    } finally {
      promoteActive.current = false;
      if (active.current) setPromoting(false);
    }
  }

  const stageLabel = promoted
    ? "Administrator access promoted"
    : proof
      ? "Administrator key login and sudo verified"
      : stage === "account-ready"
        ? "Account ready · public key not yet installed"
        : stage === "key-installed"
          ? "Account ready · access not verified in this session"
          : "Administrator not applied";

  if (!isRoot) {
    return (
      <section
        aria-label="Administrator access"
        className="space-y-2.5 border-t border-border/70 pt-3"
      >
        <p className="text-sm font-medium">Administrator access</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Creating or adopting{" "}
          <span className="break-all font-medium">{username}</span> requires the
          existing root connection. This profile is connected as{" "}
          <span className="break-all font-medium">{source.username}</span>, so
          administrator setup is unavailable here. No account or key change was
          attempted.
        </p>
      </section>
    );
  }

  const accountReady = stage !== "pending";
  const canVerify =
    keyInstalled ||
    stage === "key-installed" ||
    stage === "verified" ||
    stage === "promoted";

  return (
    <section
      aria-label="Administrator access"
      className="space-y-3 border-t border-border/70 pt-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            role="status"
            aria-label="Administrator status"
            className="text-sm font-medium"
          >
            {stageLabel}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed break-all text-muted-foreground">
            {mode === "new" ? "Create" : "Adopt"}{" "}
            <span className="font-medium">{username}</span> through the root
            connection {source.username}@{source.host}:{source.port}.
          </p>
        </div>
        {!accountReady && !promoted && (
          <Button
            type="button"
            variant="default"
            disabled={
              reviewPending ||
              applying ||
              keyBusy ||
              !connected ||
              !connectionId
            }
            onClick={() => void startReview()}
          >
            {reviewPending
              ? "Preparing review…"
              : mode === "new"
                ? "Create administrator"
                : "Adopt administrator"}
          </Button>
        )}
      </div>

      {notice && (
        <p
          role="status"
          aria-label="Administrator notice"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {notice}
        </p>
      )}
      {error && !reviewOpen && (
        <p
          role="alert"
          aria-label="Administrator error"
          className="text-sm leading-relaxed text-destructive"
        >
          {error}
        </p>
      )}

      {stage === "account-ready" && !keyInstalled && !promoted && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Install the key for {username} next.
        </p>
      )}

      {promoted && (
        <p
          role="status"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          Connected as {promoted.profile.username}.
        </p>
      )}

      {!promoted && accountReady && !canVerify && (
        <details className="min-w-0">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Review the administrator account again
          </summary>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2.5 mt-1 text-muted-foreground"
            disabled={
              reviewPending ||
              applying ||
              keyBusy ||
              !connected ||
              !connectionId
            }
            onClick={() => void startReview()}
          >
            {reviewPending ? "Preparing review…" : "Review account again"}
          </Button>
        </details>
      )}

      {keyInstallation}

      {!promoted && canVerify && (
        <div className="space-y-2.5 border-t border-border/70 pt-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Verify administrator access</p>
              {proof && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Verified until {formatTime(proof.expiresAtMs)}. The root
                  session stays open.
                </p>
              )}
            </div>
            {!proof && (
              <Button
                type="button"
                variant="default"
                disabled={
                  verifying ||
                  promoting ||
                  keyBusy ||
                  !connected ||
                  !connectionId
                }
                onClick={startVerify}
              >
                {verifying ? "Verifying…" : "Verify administrator access"}
              </Button>
            )}
          </div>
          {verifyError && !verifyPasswordOpen && (
            <p
              role="alert"
              className="text-sm leading-relaxed text-destructive"
            >
              {verifyError}
            </p>
          )}
          {proof && (
            <div className="space-y-2">
              <p
                role="status"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                Independent key login as {proof.username} succeeded and sudo to
                root was verified.
              </p>
              <Button
                type="button"
                disabled={promoting}
                onClick={() => void promote()}
              >
                {promoting ? "Switching…" : `Switch to ${username}`}
              </Button>
            </div>
          )}
          {promoteError && (
            <p
              role="alert"
              className="text-sm leading-relaxed text-destructive"
            >
              {promoteError}
            </p>
          )}
        </div>
      )}

      <Dialog
        open={reviewOpen}
        onOpenChange={(open) => {
          if (!open) closeReview();
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-lg"
          showCloseButton={!applying}
        >
          <DialogHeader className="min-w-0">
            <DialogTitle>
              {review?.action === "adopt"
                ? "Review adopting administrator"
                : "Review new administrator"}
            </DialogTitle>
            <DialogDescription className="min-w-0 break-words">
              Server accounts, the SSH port, sshd settings and the firewall are
              not otherwise changed.
            </DialogDescription>
          </DialogHeader>
          {reviewPending && (
            <p role="status" className="text-sm text-muted-foreground">
              Preparing the administrator review…
            </p>
          )}
          {applying && (
            <p role="status" className="text-sm text-muted-foreground">
              Applying the administrator change…
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
                {[
                  ["Server", review.host],
                  ["Root connection", review.sourceUsername],
                  ["Planned account", review.username],
                  [
                    "Action",
                    review.action === "adopt"
                      ? "Adopt existing account (no reset)"
                      : "Create new account",
                  ],
                  ["Operating system", `${review.osId} ${review.osVersion}`],
                  ["Home", review.home ?? review.plannedHome],
                  ["Key fingerprint", review.keyFingerprint],
                  ["Review expires", formatTime(review.expiresAtMs)],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="grid gap-1 py-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3"
                  >
                    <dt className="text-xs text-muted-foreground sm:text-sm">
                      {label}
                    </dt>
                    <dd className="min-w-0 text-sm break-all">{value}</dd>
                  </div>
                ))}
              </dl>
              {review.action === "create" && (
                <div className="max-w-sm space-y-1.5">
                  <label htmlFor={`${id}-password`} className="block text-sm">
                    New administrator sudo password
                  </label>
                  <Input
                    id={`${id}-password`}
                    type="password"
                    autoComplete="new-password"
                    maxLength={4096}
                    value={password}
                    disabled={applying}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Sent only for this create request and never saved. An
                    existing account is never reset.
                  </p>
                </div>
              )}
              <details className="min-w-0">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Exact command
                </summary>
                <pre className="mt-1 max-h-64 min-w-0 max-w-full overflow-auto rounded-md border border-border/70 bg-muted/40 p-2 font-mono text-xs whitespace-pre">
                  {review.command}
                </pre>
              </details>
              <p className="break-words text-xs leading-relaxed text-muted-foreground">
                {review.purpose}
              </p>
            </div>
          )}
          <DialogFooter className="min-w-0 [&>button]:min-w-0 [&>button]:whitespace-normal">
            <Button
              type="button"
              variant="outline"
              disabled={applying}
              onClick={closeReview}
            >
              Cancel
            </Button>
            {review && (
              <Button
                type="button"
                disabled={
                  applying ||
                  !reviewMatches(review) ||
                  (review.action === "create" && password.length === 0)
                }
                onClick={() => void applyReview()}
              >
                {review.action === "adopt"
                  ? `Adopt ${review.username}`
                  : `Create ${review.username}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={verifyPasswordOpen}
        onOpenChange={(open) => {
          if (!open && !verifying) {
            setVerifyPasswordOpen(false);
            setSudoPassword("");
            setPassphrase("");
          }
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-md"
          showCloseButton={!verifying}
        >
          <DialogHeader className="min-w-0">
            <DialogTitle>Verify administrator access</DialogTitle>
            <DialogDescription className="min-w-0 break-words">
              <span className="mb-2 block break-all font-medium text-foreground">
                {username}@{source.host}:{source.port}
              </span>
              Authenticate with only{" "}
              <span className="break-all">{selectedKey.fingerprint}</span>, then
              verify sudo to root. Your current connection stays open.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-40 min-w-0 max-w-full overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre">
            <code>{sudoCheckCommand}</code>
          </pre>
          <div className="min-w-0 space-y-3">
            <div className="space-y-1.5">
              <label htmlFor={`${id}-sudo`} className="block text-sm">
                {username} sudo password
              </label>
              <Input
                id={`${id}-sudo`}
                type="password"
                autoComplete="current-password"
                maxLength={4096}
                value={sudoPassword}
                disabled={verifying}
                onChange={(event) => setSudoPassword(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Used only for this sudo check; never saved or shown.
              </p>
            </div>
            {selectedKey.encrypted && (
              <div className="space-y-1.5">
                <label htmlFor={`${id}-passphrase`} className="block text-sm">
                  Key passphrase
                </label>
                <Input
                  id={`${id}-passphrase`}
                  type="password"
                  autoComplete="off"
                  value={passphrase}
                  disabled={verifying}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </div>
            )}
            {verifyError && (
              <p
                role="alert"
                className="break-words text-sm leading-relaxed text-destructive"
              >
                {verifyError}
              </p>
            )}
          </div>
          <DialogFooter className="min-w-0 [&>button]:min-w-0 [&>button]:whitespace-normal">
            <Button
              type="button"
              variant="outline"
              disabled={verifying}
              onClick={() => {
                setVerifyPasswordOpen(false);
                setSudoPassword("");
                setPassphrase("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={verifying || sudoPassword.length === 0}
              onClick={() => void submitVerify()}
            >
              {verifying ? "Verifying…" : "Verify key login and sudo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
