import { useQueryClient } from "@tanstack/react-query";
import { Channel, invoke } from "@tauri-apps/api/core";
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
import { Input } from "@/components/ui/input";
import {
  profileQueryKey,
  type ServerProfile,
  safeError,
  statusQueryKey,
} from "./api";
import { useCommandActivity } from "./command-activity";
import { useConfiguration } from "./configuration-context";
import { CheckRow } from "./quick-setup-controls";
import {
  type QuickSetupDraft,
  resolveQuickSetupFirewallPlan,
  writeQuickSetupDraft,
} from "./quick-setup-model";
import { useSetupPackages } from "./quick-setup-packages";

interface Status {
  id: string;
  status: string;
  message?: string;
  rules: string;
  ssh: {
    passwordauthentication?: string;
    permitrootlogin?: string;
    ports?: number[];
  };
}
interface Approval {
  reviewId: string;
  command: string;
  verificationCommands: string[];
}

export function QuickSetupSecurity({
  profile,
  draft,
  visible,
  onBusyChange,
  onVerified,
  onOpenProfile,
  onChange,
}: {
  profile: ServerProfile;
  draft: QuickSetupDraft;
  visible: boolean;
  onBusyChange: (busy: boolean) => void;
  onVerified: (verified: boolean) => void;
  onOpenProfile?: (id: string) => void;
  onChange: (access: QuickSetupDraft["access"]) => void;
}) {
  const { connectionId } = useConfiguration();
  const log = useCommandActivity();
  const queryClient = useQueryClient();
  const packages = useSetupPackages();
  const id = useId();
  const [status, setStatus] = useState<Status | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [kind, setKind] = useState("firewall-status");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const passwordLogin = draft.access.passwordLogin ?? false;
  const rootLogin = draft.access.rootLogin ?? false;
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [savedProfile, setSavedProfile] = useState<ServerProfile | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const identity = JSON.stringify([profile.id, profile.revision, connectionId]);
  const latest = useRef(identity);
  latest.current = identity;
  const selection = JSON.stringify([
    draft.access,
    draft.sshKey,
    passwordLogin,
    rootLogin,
    recoveryAcknowledged,
  ]);
  const selectedKeyId =
    draft.sshKey.strategy === "existing"
      ? draft.sshKey.existingKeyId
      : draft.sshKey.strategy === "generate"
        ? draft.sshKey.generatedKeyId
        : undefined;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    void selection;
    setApproval(null);
    setPassword("");
    setPassphrase("");
  }, [selection]);
  useEffect(() => {
    void identity;
    setStatus(null);
    setApproval(null);
    setPassword("");
    setPassphrase("");
    setRecoveryAcknowledged(false);
    setCandidateId(null);
    setSavedProfile(null);
  }, [identity]);
  useEffect(() => {
    if (!visible) {
      setApproval(null);
      setPassword("");
      setPassphrase("");
    }
  }, [visible]);
  function activityBusy(value: boolean) {
    setBusy(value);
    onBusyChange(value);
  }
  async function prepare(action: string) {
    if (running.current || !connectionId) return;
    running.current = true;
    activityBusy(true);
    setError("");
    const captured = identity;
    try {
      const plan = resolveQuickSetupFirewallPlan(draft, profile.port);
      const result = await invoke<Approval>("ssh_setup_packages_prepare", {
        source: {
          profileId: profile.id,
          profileRevision: profile.revision,
          connectionId,
          items: ["ufw"],
          kind: action,
          rules: plan.rules.map((rule) => ({
            port: rule.port,
            protocol: rule.protocol,
          })),
          ...(action === "security-apply"
            ? {
                security: {
                  keyId: selectedKeyId,
                  port: draft.access.port,
                  passwordLogin,
                  rootLogin,
                  configureFirewall: draft.access.ufw === "configure",
                  recoveryAcknowledged,
                },
              }
            : {}),
        },
      });
      if (alive.current && latest.current === captured && visibleRef.current) {
        setKind(action);
        setApproval(result);
        setApprovalIndex(0);
      }
    } catch (failure) {
      if (alive.current && latest.current === captured)
        setError(safeError(failure));
    } finally {
      running.current = false;
      if (alive.current) activityBusy(false);
    }
  }
  async function saveConnection(candidate = candidateId) {
    if (!candidate) return;
    setError("");
    try {
      const result = await invoke<{ profile: ServerProfile }>(
        "ssh_setup_security_save",
        { candidateId: candidate },
      );
      if (
        !result.profile ||
        result.profile.host !== profile.host ||
        result.profile.username !== profile.username ||
        result.profile.port !== draft.access.port
      )
        throw Error("Saved connection did not match the verified endpoint.");
      writeQuickSetupDraft(result.profile.id, { ...draft, step: 4 });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: profileQueryKey }),
        queryClient.invalidateQueries({ queryKey: statusQueryKey }),
      ]);
      if (alive.current) {
        setCandidateId(null);
        setSavedProfile(result.profile);
      }
      if (visibleRef.current) onOpenProfile?.(result.profile.id);
    } catch (failure) {
      if (alive.current) setError(safeError(failure));
    }
  }
  async function apply(review = approval, selectedAction = kind) {
    if (!review || running.current) return;
    running.current = true;
    activityBusy(true);
    setError("");
    const captured = identity;
    const action = selectedAction;
    const activity = log.begin(
      action === "firewall-status"
        ? "Read SSH and firewall settings"
        : "Apply SSH and firewall settings",
      review.command,
    );
    const sudoPassword = password;
    const keyPassphrase = passphrase || null;
    const reviewId = review.reviewId;
    setPassword("");
    setPassphrase("");
    setApproval(null);
    setPhase(action === "firewall-status" ? "Checking…" : "Applying…");
    const verificationLogs = new Map<string, string>();
    const progress = new Channel<{
      phase: string;
      command?: string;
      port?: number;
    }>();
    progress.onmessage = (event) => {
      if (event.phase.endsWith("-verified")) {
        const entry = verificationLogs.get(
          event.phase.replace("-verified", ""),
        );
        if (entry) {
          log.update(entry, {
            status: "completed",
            ended: Date.now(),
            message: "Independent key login and sudo verified.",
            code: 0,
          });
          verificationLogs.delete(event.phase.replace("-verified", ""));
        }
      } else if (event.command && event.port) {
        verificationLogs.set(
          event.phase,
          log.begin(
            `Verify sudo · ${profile.username}@${profile.host}:${event.port}`,
            event.command,
            { group: activity },
          ),
        );
      }
      if (
        alive.current &&
        latest.current === captured &&
        !event.phase.endsWith("-verified")
      )
        setPhase(
          event.phase === "current"
            ? "Testing current access…"
            : event.phase === "staged"
              ? "Testing new SSH access…"
              : "Verifying final settings…",
        );
    };
    try {
      const result = await invoke<{ items: Status[]; candidateId?: string }>(
        "ssh_setup_packages_apply",
        { reviewId, sudoPassword, keyPassphrase, onProgress: progress },
      );
      if (alive.current && latest.current === captured) {
        setStatus(result.items[0]);
        setPhase(action === "firewall-status" ? "" : "SSH access verified");
        if (action === "security-apply") onVerified(true);
        if (result.candidateId) {
          setCandidateId(result.candidateId);
          await saveConnection(result.candidateId);
        }
      }
      log.update(activity, {
        status: "completed",
        ended: Date.now(),
        message:
          action === "firewall-status"
            ? "Current settings checked."
            : "New key login, sudo and final SSH settings verified.",
        code: 0,
      });
    } catch (failure) {
      for (const entry of verificationLogs.values())
        log.update(entry, {
          status: "failed",
          ended: Date.now(),
          message: safeError(failure),
          code: null,
        });
      log.update(activity, {
        status: "failed",
        ended: Date.now(),
        message: safeError(failure),
        code: null,
      });
      if (alive.current && latest.current === captured) {
        setError(safeError(failure));
        setPhase("");
        onVerified(false);
      }
    } finally {
      progress.onmessage = () => {};
      running.current = false;
      if (alive.current) activityBusy(false);
    }
  }
  const rules = (status?.rules ?? "")
    .split("\n")
    .filter((line) => /^\s*\[\s*\d+\]/.test(line));
  const verification = approvalIndex > 0;
  const verifyLabels = [
    "Verify current key login and sudo",
    "Verify sudo on the new SSH port",
    "Verify sudo after login-policy changes",
  ];
  return (
    <section
      aria-label="Current SSH and firewall status"
      className="space-y-4 border-t pt-4"
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Connected SSH port</dt>
        <dd>{profile.port}</dd>
        <dt className="text-muted-foreground">Password login</dt>
        <dd>
          {status?.ssh.passwordauthentication === "yes"
            ? "Enabled"
            : status?.ssh.passwordauthentication === "no"
              ? "Disabled"
              : "Unknown"}
        </dd>
        <dt className="text-muted-foreground">Root login</dt>
        <dd>
          {status?.ssh.permitrootlogin === "no"
            ? "Disabled"
            : ["without-password", "prohibit-password"].includes(
                  status?.ssh.permitrootlogin ?? "",
                )
              ? "Keys only"
              : status?.ssh.permitrootlogin === "yes"
                ? "Enabled"
                : "Unknown"}
        </dd>
        <dt className="text-muted-foreground">UFW</dt>
        <dd>
          {status?.rules.includes("Status: active")
            ? "Enabled"
            : status?.rules.includes("Status: inactive")
              ? "Disabled"
              : status?.status === "missing"
                ? "Not installed"
                : "Unknown"}
        </dd>
      </dl>
      {rules.length > 0 && (
        <ul className="divide-y rounded-lg border px-3 text-xs">
          {rules.map((rule) => (
            <li key={rule} className="py-2 [overflow-wrap:anywhere]">
              {rule.trim()}
            </li>
          ))}
        </ul>
      )}
      <fieldset disabled={busy} className="divide-y border-y">
        <CheckRow
          id={`${id}-password-login`}
          label="Allow password login"
          checked={passwordLogin}
          onToggle={() =>
            onChange({ ...draft.access, passwordLogin: !passwordLogin })
          }
        />
        <CheckRow
          id={`${id}-root-login`}
          label="Allow root login with SSH keys"
          checked={rootLogin}
          onToggle={() => onChange({ ...draft.access, rootLogin: !rootLogin })}
        />
        <CheckRow
          id={`${id}-recovery`}
          label="Provider console is available and the target SSH port is allowed in the provider firewall"
          checked={recoveryAcknowledged}
          onToggle={() => setRecoveryAcknowledged((value) => !value)}
        />
      </fieldset>
      {status?.message && (
        <p className="text-sm text-warning">{status.message}</p>
      )}
      {phase && (
        <p role="status" className="text-sm text-primary">
          {phase}
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
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !connectionId}
          onClick={() => void prepare("firewall-status")}
        >
          Refresh status
        </Button>
        {status?.status === "missing" && (
          <Button
            variant="outline"
            disabled={busy || packages.busy || !connectionId}
            onClick={() => void packages.prepare(["ufw"])}
          >
            Install UFW
          </Button>
        )}
        {!candidateId && !savedProfile && (
          <Button
            disabled={
              busy ||
              !connectionId ||
              !status ||
              Boolean(status.message) ||
              !selectedKeyId ||
              profile.username === "root" ||
              !recoveryAcknowledged
            }
            onClick={() => void prepare("security-apply")}
          >
            {busy ? "Applying…" : "Apply changes"}
          </Button>
        )}
        {candidateId && (
          <Button disabled={busy} onClick={() => void saveConnection()}>
            Retry saving connection
          </Button>
        )}
        {savedProfile && (
          <Button
            variant="outline"
            onClick={() => onOpenProfile?.(savedProfile.id)}
          >
            Open verified connection
          </Button>
        )}
      </div>
      {profile.username === "root" && (
        <p className="text-xs text-muted-foreground">
          Switch to the verified administrator in step 2 first.
        </p>
      )}
      {!selectedKeyId && profile.username !== "root" && (
        <p className="text-xs text-muted-foreground">
          Select a local SSH key in step 2.
        </p>
      )}
      <Dialog
        open={Boolean(approval)}
        onOpenChange={(open) => {
          if (!open) {
            setApproval(null);
            setPassword("");
            setPassphrase("");
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {kind === "firewall-status"
                ? "Read current settings"
                : verification
                  ? verifyLabels[approvalIndex - 1]
                  : "Apply SSH & firewall"}
            </DialogTitle>
            <DialogDescription>
              {profile.username}@{profile.host}:
              {verification && approvalIndex > 1
                ? draft.access.port
                : profile.port}
            </DialogDescription>
          </DialogHeader>
          {kind === "security-apply" && !verification && (
            <p className="text-sm">
              SSH port {draft.access.port} ·{" "}
              {passwordLogin ? "Password login allowed" : "Keys only"} · Root{" "}
              {rootLogin ? "keys only" : "disabled"}. Remote recovery stays
              armed until both new connections pass.
            </p>
          )}
          {!verification && profile.username !== "root" && (
            <div className="space-y-2">
              <label htmlFor={`${id}-sudo`} className="block text-sm">
                Sudo password
              </label>
              <Input
                id={`${id}-sudo`}
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          )}
          {kind === "security-apply" && !verification && (
            <div className="space-y-2">
              <label htmlFor={`${id}-key`} className="block text-sm">
                Key passphrase (if encrypted)
              </label>
              <Input
                id={`${id}-key`}
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </div>
          )}
          <details className="text-xs">
            <summary className="cursor-pointer">Command</summary>
            <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
              {verification
                ? approval?.verificationCommands[approvalIndex - 1]
                : approval?.command}
            </pre>
          </details>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setApproval(null);
                setPassword("");
                setPassphrase("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (
                  approvalIndex < (approval?.verificationCommands.length ?? 0)
                )
                  setApprovalIndex((index) => index + 1);
                else void apply();
              }}
            >
              {kind === "firewall-status"
                ? "Read status"
                : approvalIndex < (approval?.verificationCommands.length ?? 0)
                  ? "Approve command"
                  : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
