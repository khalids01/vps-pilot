import { ConfigurationStatus } from "@/components/configuration-status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ToolId } from "@/features/workspace/fixtures";
import {
  type ConfigurationEvidence,
  evidenceStatus,
  readableValue,
  setupStatus,
} from "./configuration-model";

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
export function Evidence({
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
export function sshEvidenceGroup(
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
type EvidenceGroup = { title: string; section: ConfigurationEvidence };
function groupEvidence(
  categoryId: string,
  section: ConfigurationEvidence,
): EvidenceGroup[] {
  const keys = Object.keys(section.values).filter((key) => key !== "attention");
  if (!keys.length) return [];
  if (categoryId === "ssh") {
    return [
      {
        title: "SSH policy",
        section: {
          ...(sshEvidenceGroup(section, "policy") as ConfigurationEvidence),
          message: null,
        },
      },
      {
        title: "Local users",
        section: sshEvidenceGroup(section, "accounts"),
      },
      {
        title: "Authorized public keys",
        section: sshEvidenceGroup(section, "keys"),
      },
    ].filter((group): group is EvidenceGroup =>
      Boolean(group.section && Object.keys(group.section.values).length),
    );
  }
  const tool = (key: string, name: string) =>
    new RegExp(
      `^(?:${name}|package ${name}|${name} (?:package|ownership|executable ownership))$`,
      "i",
    ).test(key);
  const rules: Record<
    string,
    { title: string; matches: (key: string) => boolean }[]
  > = {
    essentials: [
      {
        title: "Git package and ownership",
        matches: (key) => tool(key, "git"),
      },
      {
        title: "Curl package and ownership",
        matches: (key) => tool(key, "curl"),
      },
      {
        title: "Tar package and ownership",
        matches: (key) => tool(key, "tar"),
      },
      {
        title: "Unzip package and ownership",
        matches: (key) => tool(key, "unzip"),
      },
      {
        title: "Certificates package and ownership",
        matches: (key) =>
          /^(ca certificate bundle|package ca-certificates)$/i.test(key),
      },
    ],
    system: [
      {
        title: "System basics",
        matches: (key) => !/update|package/i.test(key),
      },
      { title: "Updates", matches: (key) => /update|package/i.test(key) },
    ],
    security: [
      {
        title: "Security services",
        matches: (key) => /fail2ban|service|jail/i.test(key),
      },
      {
        title: "Update scheduling",
        matches: (key) => /update|unattended|timer/i.test(key),
      },
    ],
    resources: [{ title: "Capacity", matches: () => true }],
    docker: [{ title: "Docker CLI", matches: () => true }],
  };
  const definitions = rules[categoryId] ?? [
    { title: "Details", matches: () => true },
  ];
  const assigned = new Set<string>();
  const groups: EvidenceGroup[] = [];
  for (const definition of definitions) {
    const values: Record<string, string> = {};
    for (const key of keys) {
      if (assigned.has(key) || !definition.matches(key)) continue;
      assigned.add(key);
      values[key] = section.values[key];
    }
    if (Object.keys(values).length)
      groups.push({
        title: definition.title,
        section: { ...section, values, message: null },
      });
  }
  const other = Object.fromEntries(
    keys
      .filter((key) => !assigned.has(key))
      .map((key) => [key, section.values[key]]),
  );
  if (Object.keys(other).length)
    groups.push({
      title: "Other details",
      section: { ...section, values: other, message: null },
    });
  return groups;
}
function toolActionLabel(tool: ToolId) {
  return tool === "ssh-access"
    ? "Open SSH Access"
    : tool === "firewall"
      ? "Open Firewall"
      : tool === "docker"
        ? "Open Docker"
        : tool === "software"
          ? "Open Software"
          : "Open Overview";
}
export interface ConfigurationDetailsCategory {
  id: string;
  title: string;
  tool?: ToolId;
}
export function ConfigurationDetailsDrawer({
  open,
  category,
  evidence,
  observedAt,
  stale,
  onOpenChange,
  onNavigate,
}: {
  open: boolean;
  category?: ConfigurationDetailsCategory;
  evidence?: ConfigurationEvidence;
  observedAt?: number;
  stale: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (tool: ToolId) => void;
}) {
  const groups =
    category && evidence ? groupEvidence(category.id, evidence) : [];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <DialogContent className="top-0 right-0 bottom-0 left-auto h-dvh w-full max-w-none translate-x-0 translate-y-0 content-start gap-4 overflow-y-auto rounded-none border-l p-4 sm:w-[480px] sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {category ? `${category.title} details` : "Category details"}
          </DialogTitle>
          <DialogDescription>
            {observedAt
              ? `Observed ${new Date(observedAt).toLocaleString()}`
              : "Not inspected yet"}{" "}
            · <ConfigurationStatus state={setupStatus(evidence)} />
          </DialogDescription>
        </DialogHeader>
        {stale && (
          <p className="text-xs text-warning">
            Previous connection; cached evidence may be stale.
          </p>
        )}
        {evidence?.message && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {evidence.message}
          </p>
        )}
        {!evidence ? (
          <p className="text-sm text-muted-foreground">
            No inspection yet. Choose Inspect server to collect read-only
            evidence.
          </p>
        ) : groups.length ? (
          groups.map((group) => (
            <Evidence
              key={group.title}
              section={group.section}
              title={group.title}
              showStatus={false}
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">Details unavailable.</p>
        )}
        <DialogFooter className="mt-auto flex-wrap justify-end">
          {category?.tool && (
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                onNavigate(category.tool as ToolId);
              }}
            >
              {toolActionLabel(category.tool)}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close details
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
