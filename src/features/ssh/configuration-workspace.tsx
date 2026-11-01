import { invoke } from "@tauri-apps/api/core";
import { useLayoutEffect, useRef, useState } from "react";
import {
  ConfigurationNotice,
  ConfigurationStatus,
} from "@/components/configuration-status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ToolId } from "@/features/workspace/fixtures";
import { type ServerProfile, safeError } from "./api";
import { useConfiguration } from "./configuration-context";
import {
  type ConfigurationEvidence,
  type ConfigurationReview,
  evidenceStatus,
  reviewMatchesContext,
} from "./configuration-model";
import { RemoteActions } from "./remote-actions";

const categories: {
  id: string;
  title: string;
  description: string;
  tool?: ToolId;
}[] = [
  {
    id: "system",
    title: "System",
    description: "OS, hostname, timezone and cached package-update evidence.",
    tool: "overview",
  },
  {
    id: "ssh",
    title: "Users and SSH",
    description:
      "Current account, authentication policy evidence and administrative access.",
    tool: "ssh-access",
  },
  {
    id: "security",
    title: "Security",
    description:
      "Installed security tools, service activity and automatic-update scheduling.",
    tool: "firewall",
  },
  {
    id: "essentials",
    title: "Essential software",
    description:
      "Git, curl, certificates, installed versions and package ownership.",
    tool: "software",
  },
  {
    id: "docker",
    title: "Docker",
    description:
      "Docker CLI presence; existing workloads remain in the Docker workspace.",
    tool: "docker",
  },
  {
    id: "resources",
    title: "Resources",
    description: "Memory, swap and root filesystem capacity.",
    tool: "overview",
  },
];
const sshLabels: Record<string, string> = {
  passwordauthentication: "Password authentication",
  pubkeyauthentication: "Public-key authentication",
  permitrootlogin: "Root login policy",
  kbdinteractiveauthentication: "Keyboard-interactive authentication",
  authenticationmethods: "Required authentication methods",
  usepam: "PAM authentication",
  port: "Default configured ports",
  listenaddress: "Default configured listeners",
};
const reviewStateLabels = {
  ready: "Evidence ready",
  partial: "Partial evidence",
  unavailable: "Evidence unavailable",
} as const;
function reviewErrorText(error: unknown) {
  return safeError(error);
}
function Evidence({
  section,
  title,
  showStatus = true,
  hideRules = false,
}: {
  section?: ConfigurationEvidence;
  title: string;
  showStatus?: boolean;
  hideRules?: boolean;
}) {
  return (
    <section className="space-y-3 border-t pt-4" aria-label={title}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {showStatus && (
          <ConfigurationStatus
            state={
              !section
                ? "unknown"
                : section.state === "ready"
                  ? evidenceStatus(section)
                  : section.state
            }
          />
        )}
      </div>
      {section?.message && (
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {section.message}
        </p>
      )}
      {section ? (
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)]">
          {Object.entries(section.values)
            .filter(
              ([key]) =>
                key !== "attention" && (!hideRules || !/^Rule \d+$/.test(key)),
            )
            .sort(([left], [right]) =>
              left.localeCompare(right, undefined, { numeric: true }),
            )
            .map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">
                  {sshLabels[key] ?? key}
                </dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words">
                  {value === "yes"
                    ? "Enabled"
                    : value === "no"
                      ? "Disabled"
                      : readableValue(value)}
                </dd>
              </div>
            ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          No inspection yet. Choose Inspect server to collect read-only
          evidence.
        </p>
      )}
    </section>
  );
}
type SshEvidenceGroup = "policy" | "accounts" | "keys";
function sshEvidenceGroup(
  section: ConfigurationEvidence | undefined,
  group: SshEvidenceGroup,
): ConfigurationEvidence | undefined {
  if (!section) return undefined;
  const belongs = (key: string) => {
    if (/^Local accounts?\b/i.test(key)) return "accounts";
    if (/^Authorized keys?\b/i.test(key)) return "keys";
    return "policy";
  };
  const values = Object.fromEntries(
    Object.entries(section.values).filter(([key]) => belongs(key) === group),
  );
  return {
    ...section,
    values,
    message:
      group === "accounts"
        ? "Bounded local account metadata only. Group membership does not prove administrative privileges; network directory accounts are not enumerated."
        : group === "keys"
          ? "Only the current account’s standard public-key file is inspected. Fingerprints identify file entries, not working login methods. The running daemon may use a different authorization source."
          : section.message,
  };
}

function readableValue(value: string) {
  const match = /^(\d+) (KiB|bytes)$/.exec(value);
  if (!match) return value;
  const bytes = Number(match[1]) * (match[2] === "KiB" ? 1024 : 1);
  if (!Number.isSafeInteger(bytes)) return value;
  const power = bytes
    ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)))
    : 0;
  return `${(bytes / 1024 ** power).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KiB", "MiB", "GiB", "TiB"][power]}`;
}
function FirewallRules({ section }: { section?: ConfigurationEvidence }) {
  const rules = Object.entries(section?.values ?? {})
    .filter(([key]) => /^Rule \d+$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  return (
    <section
      aria-label="Observed firewall rules"
      className="space-y-3 border-t pt-4"
    >
      <h2 className="text-sm font-medium">Observed firewall rules</h2>
      <p className="text-sm text-muted-foreground">
        Rule order is preserved from this snapshot. These rows are for
        inspection, not stable targets for editing or removal.
      </p>
      {rules.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-table-header text-muted-foreground">
              <tr>
                {["Order", "Destination", "Policy", "Source", "Family"].map(
                  (label) => (
                    <th
                      key={label}
                      scope="col"
                      className="px-3 py-2 font-medium"
                    >
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rules.map(([id, raw]) => {
                const match =
                  /^(.*?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?\s+(.*)$/.exec(
                    raw,
                  );
                if (!match)
                  return (
                    <tr key={id}>
                      <td className="px-3 py-3">{id.replace("Rule ", "")}</td>
                      <td colSpan={4} className="px-3 py-3">
                        {raw} · Unrecognized rule format; preserved as display
                        only.
                      </td>
                    </tr>
                  );
                const [, destination, action, direction, source] = match;
                const verbs: Record<string, string> = {
                  ALLOW: "Allows",
                  DENY: "Blocks",
                  REJECT: "Rejects",
                  LIMIT: "Rate limits",
                };
                const verb = verbs[action];
                const flow =
                  direction === "IN"
                    ? "incoming "
                    : direction === "OUT"
                      ? "outgoing "
                      : direction === "FWD"
                        ? "forwarded "
                        : "";
                return (
                  <tr key={id} className="hover:bg-row-hover">
                    <td className="px-3 py-3 align-top">
                      {id.replace("Rule ", "")}
                    </td>
                    <td className="px-3 py-3 align-top">
                      {destination}
                      <p className="mt-1 min-w-48 text-xs leading-relaxed text-muted-foreground">
                        {verb} {flow}connections to {destination} from {source}.
                      </p>
                    </td>
                    <td className="px-3 py-3 align-top">
                      {action} {direction}
                    </td>
                    <td className="px-3 py-3 align-top">{source}</td>
                    <td className="px-3 py-3 align-top">
                      {raw.includes("(v6)") ? "IPv6" : "IPv4 / unspecified"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {!section
            ? "No inspection yet."
            : section.state !== "ready"
              ? "No complete rule inventory is available. Absence of rows is not proof that traffic is allowed."
              : "No explicit rules observed. Default policies still apply."}
        </p>
      )}
    </section>
  );
}

export function ConfigurationWorkspace({
  tool,
  profile,
  connected,
  onNavigate,
}: {
  tool: "quick-setup" | "ssh-access" | "firewall";
  profile: ServerProfile;
  connected: boolean;
  onNavigate: (tool: ToolId) => void;
}) {
  const {
    snapshot,
    connectionId,
    busy,
    error,
    stale,
    canInspect,
    inspect,
    cancel,
    canceling,
    notice,
    selected,
    select,
  } = useConfiguration();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [review, setReview] = useState<ConfigurationReview | null>(null);
  const [reviewStatus, setReviewStatus] = useState<
    "idle" | "creating" | "rechecking"
  >("idle");
  const [reviewError, setReviewError] = useState("");
  const [reviewMessage, setReviewMessage] = useState("");
  const reviewVersion = useRef(0);
  const reviewPending = useRef(false);
  const lastReview = useRef<ConfigurationReview | null>(null);
  const page = useRef<HTMLElement>(null);
  // Any identity, evidence, selection, connection or inspection change makes
  // an older review response unusable, even if it arrives after this render.
  const contextKey = [
    profile.id,
    profile.revision,
    connected ? "connected" : "disconnected",
    connectionId ?? "",
    snapshot?.snapshotId ?? "",
    snapshot?.connectionId ?? "",
    selected.join(","),
    busy ? "busy" : "idle",
  ].join("|");
  // Kept current during render so an awaited response can compare against the
  // context that exists now, not only the captured context of its request.
  const latestContextKey = useRef(contextKey);
  latestContextKey.current = contextKey;
  const previousContextKey = useRef(contextKey);
  useLayoutEffect(() => {
    if (previousContextKey.current === contextKey) return;
    previousContextKey.current = contextKey;
    reviewVersion.current += 1;
    reviewPending.current = false;
    lastReview.current = null;
    setReviewOpen(false);
    setReview(null);
    setReviewStatus("idle");
    setReviewError("");
    setReviewMessage("");
  }, [contextKey]);
  useLayoutEffect(() => {
    // A different configuration page starts at its heading; evidence stays cached.
    if (tool) page.current?.closest("main")?.scrollTo({ top: 0 });
  }, [tool]);
  const section = (id: string) =>
    snapshot?.sections.find((item) => item.id === id);
  const setup = tool === "quick-setup";
  const canReview = Boolean(
    selected.length &&
      snapshot?.snapshotId &&
      connectionId &&
      connected &&
      !stale &&
      !busy &&
      reviewStatus === "idle",
  );
  async function createReview() {
    if (
      reviewPending.current ||
      !snapshot?.snapshotId ||
      !connectionId ||
      !connected ||
      stale ||
      busy ||
      !selected.length
    )
      return;
    const version = ++reviewVersion.current;
    const requestKey = contextKey;
    const context = {
      profileId: profile.id,
      connectionId,
      profileRevision: profile.revision,
      snapshotId: snapshot.snapshotId,
      selected: [...selected],
    };
    reviewPending.current = true;
    setReviewOpen(true);
    setReview(null);
    setReviewError("");
    setReviewMessage("");
    setReviewStatus("creating");
    try {
      const result = await invoke<ConfigurationReview>(
        "ssh_configuration_review",
        {
          profileId: context.profileId,
          connectionId: context.connectionId,
          snapshotId: context.snapshotId,
          selected: context.selected,
        },
      );
      if (
        reviewVersion.current !== version ||
        latestContextKey.current !== requestKey
      )
        return;
      const match = reviewMatchesContext(result, context);
      if (!match.ok) throw Error(match.reason);
      lastReview.current = result;
      setReview(result);
      setReviewStatus("idle");
      reviewPending.current = false;
    } catch (failure) {
      if (
        reviewVersion.current !== version ||
        latestContextKey.current !== requestKey
      )
        return;
      lastReview.current = null;
      setReview(null);
      setReviewError(reviewErrorText(failure));
      setReviewStatus("idle");
      reviewPending.current = false;
    }
  }
  async function recheckReview(target = lastReview.current) {
    if (
      !target ||
      reviewPending.current ||
      !snapshot?.snapshotId ||
      target.snapshotId !== snapshot.snapshotId ||
      !connectionId ||
      !connected ||
      stale ||
      busy
    )
      return;
    const version = ++reviewVersion.current;
    const requestKey = contextKey;
    const context = {
      profileId: target.profileId,
      connectionId: target.connectionId,
      profileRevision: profile.revision,
      snapshotId: snapshot.snapshotId,
      selected: [...selected],
    };
    reviewPending.current = true;
    setReviewError("");
    setReviewMessage("");
    setReviewStatus("rechecking");
    try {
      const result = await invoke<ConfigurationReview>(
        "ssh_configuration_review_validate",
        {
          profileId: target.profileId,
          connectionId: target.connectionId,
          reviewId: target.id,
        },
      );
      if (
        reviewVersion.current !== version ||
        latestContextKey.current !== requestKey
      )
        return;
      if (result.id !== target.id || result.expiresAt !== target.expiresAt)
        throw Error("Review response did not match the rechecked review.");
      const match = reviewMatchesContext(result, context);
      if (!match.ok) throw Error(match.reason);
      lastReview.current = result;
      setReview(result);
      setReviewMessage(
        "Review still matches the current connection and snapshot. This is cached evidence, not a fresh remote inspection.",
      );
      setReviewStatus("idle");
      reviewPending.current = false;
    } catch (failure) {
      if (
        reviewVersion.current !== version ||
        latestContextKey.current !== requestKey
      )
        return;
      setReview(null);
      setReviewError(reviewErrorText(failure));
      setReviewStatus("idle");
      reviewPending.current = false;
    }
  }
  function closeReview() {
    reviewVersion.current += 1;
    reviewPending.current = false;
    setReviewOpen(false);
    setReview(null);
    setReviewStatus("idle");
    setReviewError("");
    setReviewMessage("");
  }
  // Retry always creates a new review from the current native cache and
  // identity. It never reuses or extends an expired review.
  function retryReview() {
    void createReview();
  }
  const currentContext = {
    profileId: profile.id,
    connectionId: connectionId ?? null,
    profileRevision: profile.revision,
    snapshotId: snapshot?.snapshotId ?? "",
    selected,
  };
  const visibleReview =
    review && reviewMatchesContext(review, currentContext).ok ? review : null;
  const sharedBlockers = visibleReview
    ? [...new Set(visibleReview.items.flatMap((item) => item.blockers))].filter(
        (blocker) =>
          visibleReview.items.every((item) => item.blockers.includes(blocker)),
      )
    : [];
  const title = setup
    ? "Quick Setup"
    : tool === "ssh-access"
      ? "SSH Access"
      : "Firewall";
  return (
    <section ref={page} aria-label={title} className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {setup
              ? "Inspect first, then review only the setup items you need. Existing applications and settings are preserved."
              : tool === "ssh-access"
                ? "Separate saved connection settings from server policy evidence. A saved key path does not prove key login works."
                : "Review UFW status, rules and listeners separately from cloud firewalls and Docker networking."}
          </p>
          {snapshot && (
            <p className="mt-2 text-xs text-muted-foreground">
              Observed {new Date(snapshot.observedAt).toLocaleString()} ·{" "}
              {stale
                ? "Previous connection; stale evidence"
                : "Snapshot, not live polling"}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!canInspect || busy} onClick={inspect}>
            {busy
              ? "Inspecting…"
              : snapshot
                ? "Refresh configuration"
                : "Inspect server"}
          </Button>
          {busy && (
            <Button variant="outline" disabled={canceling} onClick={cancel}>
              {canceling ? "Canceling…" : "Cancel inspection"}
            </Button>
          )}
        </div>
      </header>
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {!connected && (
        <ConfigurationNotice title="Server disconnected">
          Connect using the workspace connection control. Cached evidence is
          read-only and may be stale.
        </ConfigurationNotice>
      )}
      {connected && !canInspect && (
        <ConfigurationNotice title="Connection status unavailable">
          Refresh the connection before inspecting this server.
        </ConfigurationNotice>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error} Refresh is explicit; no changes were requested.
        </p>
      )}
      <ConfigurationNotice title="Read-only configuration">
        Inspection never installs software, refreshes package indexes or changes
        SSH/firewall settings. Applying changes requires validated recovery and
        is not enabled yet.
      </ConfigurationNotice>
      {setup ? (
        <>
          <div className="divide-y border-y">
            {categories.map((category) => {
              const item = section(category.id);
              return (
                <div
                  key={category.id}
                  className="flex flex-wrap items-start gap-4 py-4"
                >
                  <Checkbox
                    className="size-6"
                    aria-label={`Select ${category.title}`}
                    disabled={!item || stale || busy}
                    checked={selected.includes(category.id)}
                    onCheckedChange={(checked) =>
                      select(category.id, checked === true)
                    }
                  />
                  <div className="min-w-0 flex-1 basis-64">
                    <h2 className="text-sm font-medium">{category.title}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {category.description}
                    </p>
                    <details className="mt-3 text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        Current evidence
                      </summary>
                      <Evidence
                        showStatus={false}
                        section={item}
                        title={`${category.title} details`}
                      />
                    </details>
                  </div>
                  <ConfigurationStatus
                    state={
                      !item
                        ? "unknown"
                        : item.state === "ready"
                          ? evidenceStatus(item)
                          : item.state
                    }
                  />
                  {category.tool && (
                    <Button
                      variant="outline"
                      onClick={() => onNavigate(category.tool as ToolId)}
                    >
                      {category.tool === "ssh-access"
                        ? "Open SSH Access"
                        : category.tool === "firewall"
                          ? "Open Firewall"
                          : category.tool === "docker"
                            ? "Open Docker"
                            : category.tool === "software"
                              ? "Open Software"
                              : "Open Overview"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {snapshot && !snapshot.snapshotId && (
            <p role="status" className="text-sm text-warning">
              This cached evidence predates native review. Refresh configuration
              to inspect this server again.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {selected.length} selected for review
            </span>
            <Button
              variant="outline"
              disabled={!canReview}
              onClick={() => void createReview()}
            >
              Review selection
            </Button>
          </div>
        </>
      ) : tool === "ssh-access" ? (
        <>
          <section aria-label="Saved connection" className="space-y-3">
            <h2 className="text-sm font-medium">Saved connection</h2>
            <p className="text-sm text-muted-foreground">
              These are local profile settings, not effective server policy.
            </p>
            <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 text-sm">
              <dt className="text-muted-foreground">Host</dt>
              <dd className="break-all">{profile.host}</dd>
              <dt className="text-muted-foreground">User</dt>
              <dd>{profile.username}</dd>
              <dt className="text-muted-foreground">Port</dt>
              <dd>{profile.port}</dd>
              <dt className="text-muted-foreground">Local key</dt>
              <dd className="break-all">
                {profile.identityFile || "Agent or default local keys"}
              </dd>
            </dl>
          </section>
          <Evidence
            section={sshEvidenceGroup(section("ssh"), "policy")}
            title="SSH server policy"
          />
          <Evidence
            section={sshEvidenceGroup(section("ssh"), "accounts")}
            title="Local users"
          />
          <Evidence
            section={sshEvidenceGroup(section("ssh"), "keys")}
            title="Authorized public keys"
          />
          <Evidence section={section("listeners")} title="Listening sockets" />
          <p className="text-sm text-muted-foreground">
            Key generation, authorized-key changes and port/authentication
            migrations need their dedicated verified workflow. They are not
            enabled by this inspection.
          </p>
        </>
      ) : (
        <>
          <Evidence
            section={section("firewall")}
            hideRules
            title="UFW status and rules"
          />
          <FirewallRules section={section("firewall")} />
          <Evidence section={section("listeners")} title="Listening sockets" />
          <ConfigurationNotice title="Public reachability is not established">
            A listener is not an allow rule. Cloud/provider restrictions are
            unknown, and Docker-published ports may bypass UFW filtering.
            Existing SSH access has not been certified for firewall changes.
          </ConfigurationNotice>
          <section
            className="border-t pt-4"
            aria-label="Privileged UFW inspection"
          >
            <h2 className="mb-3 text-sm font-medium">
              Read privileged UFW status
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">
              If the unprivileged snapshot is incomplete, the existing sudo
              status reader can request a separate exact-command approval. Its
              result does not authorize rule changes.
            </p>
            <RemoteActions
              profile={profile}
              connected={connected}
              tool="Firewall"
            />
          </section>
        </>
      )}
      <Dialog
        open={reviewOpen}
        onOpenChange={(open) => {
          if (!open) closeReview();
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review setup selection</DialogTitle>
            <DialogDescription>
              {profile.name} · {profile.username}@{profile.host}:{profile.port}.
              Readiness review using cached inspection evidence.
            </DialogDescription>
          </DialogHeader>
          {reviewStatus === "creating" && !visibleReview && (
            <p role="status" className="text-sm text-muted-foreground">
              Creating review…
            </p>
          )}
          {reviewError && (
            <div className="space-y-3">
              <p role="alert" className="text-sm text-destructive">
                {reviewError}
              </p>
              <Button
                variant="outline"
                disabled={reviewStatus !== "idle"}
                onClick={retryReview}
              >
                Retry review
              </Button>
            </div>
          )}
          {visibleReview && (
            <div className="space-y-4 text-sm">
              <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">Server</dt>
                <dd className="break-words">
                  {profile.name} · {profile.username}@{profile.host}:
                  {profile.port}
                </dd>
                <dt className="text-muted-foreground">Source observed</dt>
                <dd>{new Date(visibleReview.observedAt).toLocaleString()}</dd>
                <dt className="text-muted-foreground">Review expires</dt>
                <dd>{new Date(visibleReview.expiresAt).toLocaleString()}</dd>
              </dl>
              <p className="text-sm text-warning">
                Preview only. Cached inspection evidence observed{" "}
                {new Date(visibleReview.observedAt).toLocaleString()}; this is
                not a fresh live check.
              </p>
              <p className="text-sm text-warning">
                Execution is unavailable. No commands are generated or applied.
              </p>
              {sharedBlockers.length > 0 && (
                <div className="space-y-1">
                  <p className="font-medium">
                    Applies to every selected category
                  </p>
                  <ul className="space-y-1 text-muted-foreground">
                    {sharedBlockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              )}
              <ol className="space-y-4">
                {visibleReview.items.map((item) => {
                  const itemBlockers = item.blockers.filter(
                    (blocker) => !sharedBlockers.includes(blocker),
                  );
                  return (
                    <li key={item.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>{item.title}</strong>
                        <span className="text-xs text-muted-foreground">
                          {reviewStateLabels[item.evidenceState]}
                        </span>
                      </div>
                      {itemBlockers.length > 0 && (
                        <ul className="mt-2 space-y-1 text-muted-foreground">
                          {itemBlockers.map((blocker) => (
                            <li key={blocker}>{blocker}</li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2 text-muted-foreground">
                        {item.nextStep}
                      </p>
                    </li>
                  );
                })}
              </ol>
              {reviewMessage && (
                <p role="status" className="text-sm text-info">
                  {reviewMessage}
                </p>
              )}
              <Button
                variant="outline"
                disabled={reviewStatus !== "idle"}
                onClick={() => void recheckReview()}
              >
                {reviewStatus === "rechecking"
                  ? "Rechecking review…"
                  : "Recheck review"}
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeReview}>
              Close review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
