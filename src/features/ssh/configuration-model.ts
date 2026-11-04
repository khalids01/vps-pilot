export type EvidenceState = "ready" | "partial" | "unavailable";
export interface ConfigurationEvidence {
  id: string;
  title: string;
  state: EvidenceState;
  values: Record<string, string>;
  message: string | null;
}
export interface ConfigurationSnapshot {
  profileId: string;
  connectionId: string;
  observedAt: number;
  snapshotId: string;
  sections: ConfigurationEvidence[];
}
export interface ConfigurationReviewItem {
  id: string;
  title: string;
  evidenceState: EvidenceState;
  blockers: string[];
  nextStep: string;
}
export interface ConfigurationReview {
  id: string;
  profileId: string;
  connectionId: string;
  profileRevision: string;
  snapshotId: string;
  observedAt: number;
  expiresAt: number;
  canExecute: boolean;
  items: ConfigurationReviewItem[];
}
export interface ReviewContext {
  profileId: string;
  connectionId: string | null | undefined;
  profileRevision: string;
  snapshotId: string;
  selected: string[];
}
export type ReviewMatch = { ok: true } | { ok: false; reason: string };
export function reviewMatchesContext(
  review: ConfigurationReview,
  context: ReviewContext,
): ReviewMatch {
  if (review.canExecute !== false)
    return {
      ok: false,
      reason: "Review unexpectedly allows execution.",
    };
  if (
    review.profileId !== context.profileId ||
    !context.connectionId ||
    review.connectionId !== context.connectionId
  )
    return {
      ok: false,
      reason: "Review belongs to a different server or connection.",
    };
  if (review.profileRevision !== context.profileRevision)
    return { ok: false, reason: "Server profile changed after review." };
  if (review.snapshotId !== context.snapshotId)
    return {
      ok: false,
      reason: "Inspection evidence changed after review.",
    };
  const ids = review.items.map((item) => item.id);
  if (
    ids.length !== context.selected.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !context.selected.includes(id))
  )
    return {
      ok: false,
      reason: "Review categories do not match the current selection.",
    };
  return { ok: true };
}
export type ItemStatus = "configured" | "attention" | "unknown";
export function evidenceStatus(
  evidence: ConfigurationEvidence | undefined,
): ItemStatus {
  if (evidence?.state !== "ready") return "unknown";
  return evidence.values.attention === "true" ? "attention" : "configured";
}
export type SetupStatus = "unchecked" | "incomplete" | "attention" | "detected";
/** Quick Setup labels describe observed evidence only, never safety. */
export function setupStatus(
  evidence: ConfigurationEvidence | undefined,
): SetupStatus {
  if (!evidence) return "unchecked";
  if (evidence.state !== "ready") return "incomplete";
  return evidence.values.attention === "true" ? "attention" : "detected";
}
function observedValue(values: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = values[key]?.trim();
    if (value) return value;
  }
  return "";
}
type Presence = "detected" | "missing" | "unknown";
function executablePresence(raw: string): Presence {
  const value = raw.trim();
  if (/^Not found\b/i.test(value)) return "missing";
  if (/^Unknown\b/i.test(value)) return "unknown";
  return value.startsWith("/") ? "detected" : "unknown";
}
function packagePresence(
  raw: string,
): Exclude<Presence, "detected"> | "installed" {
  if (/^Installed\b/i.test(raw)) return "installed";
  if (/^Not installed\b/i.test(raw) || /^Removed\b/i.test(raw))
    return "missing";
  return "unknown";
}
function toolSummary(
  label: string,
  key: string,
  values: Record<string, string>,
) {
  const executable = observedValue(values, [
    label,
    key,
    `${label.charAt(0).toUpperCase()}${label.slice(1)}`,
  ]);
  const packageRecord = observedValue(values, [
    `Package ${key}`,
    `${key} package`,
  ]);
  if (!executable && !packageRecord) return "";
  if (executable) {
    const presence = executablePresence(executable);
    if (presence === "detected") return `${label} detected`;
    if (presence === "missing") return `${label} not found`;
  }
  const packageState = packageRecord
    ? packagePresence(packageRecord)
    : "unknown";
  if (packageState === "installed") return `${label} package installed`;
  if (packageState === "missing") return `${label} package not installed`;
  return `${label} status unknown`;
}
function activeState(raw: string) {
  const composite = /(?:^|\s)ActiveState=([A-Za-z0-9_-]+)/.exec(raw);
  if (composite) return composite[1].toLowerCase();
  const legacy =
    /^(active|inactive|failed|activating|deactivating|reloading|maintenance)$/i.exec(
      raw.trim(),
    );
  return legacy ? legacy[1].toLowerCase() : undefined;
}
function unitSummary(
  label: string,
  keys: string[],
  values: Record<string, string>,
) {
  const raw = observedValue(values, keys);
  if (!raw) return "";
  return `${label} ${activeState(raw) ?? "state unknown"}`;
}
export function readableValue(value: string) {
  const match = /^(\d+) (KiB|bytes)$/.exec(value);
  if (!match) return value;
  const bytes = Number(match[1]) * (match[2] === "KiB" ? 1024 : 1);
  if (!Number.isSafeInteger(bytes)) return value;
  const power = bytes
    ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)))
    : 0;
  return `${(bytes / 1024 ** power).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KiB", "MiB", "GiB", "TiB"][power]}`;
}
/** Projects only bounded observed fields into a one-line Quick Setup summary. */
export function setupSummary(
  categoryId: string,
  evidence: ConfigurationEvidence | undefined,
) {
  if (!evidence) return "Inspection needed";
  const values = evidence.values;
  const unavailable = "Details unavailable";
  const parts: string[] = [];
  if (categoryId === "system") {
    const system = observedValue(values, ["Operating system"]);
    const timezone = observedValue(values, ["Timezone"]);
    const updates = observedValue(values, ["Cached updates"]);
    if (system) parts.push(system);
    if (timezone) parts.push(`Timezone ${timezone}`);
    if (updates) parts.push(updates);
  } else if (categoryId === "essentials") {
    for (const [label, key] of [
      ["Git", "git"],
      ["curl", "curl"],
    ] as const) {
      const summary = toolSummary(label, key, values);
      if (summary) parts.push(summary);
    }
  } else if (categoryId === "ssh") {
    const user = observedValue(values, ["Current user"]);
    const keyAuthentication = observedValue(values, ["Key authentication"]);
    if (user) parts.push(`User ${user}`);
    parts.push(
      keyAuthentication
        ? `Key verification: ${keyAuthentication}`
        : "Key verification unavailable",
    );
  } else if (categoryId === "security") {
    const service = unitSummary(
      "fail2ban.service",
      ["Security unit fail2ban.service", "fail2ban.service ActiveState"],
      values,
    );
    const timer = unitSummary(
      "Unattended upgrades",
      [
        "Security unit apt-daily-upgrade.timer",
        "apt-daily-upgrade.timer ActiveState",
      ],
      values,
    );
    if (service) parts.push(service);
    if (timer) parts.push(timer);
  } else if (categoryId === "docker") {
    const cli = observedValue(values, ["CLI"]);
    const version = observedValue(values, ["CLI version"]);
    if (cli) parts.push(`CLI ${cli}`);
    if (version) parts.push(version);
  } else if (categoryId === "resources") {
    const memory = observedValue(values, ["Memory total"]);
    const swap = observedValue(values, ["Swap total"]);
    if (memory) parts.push(`Memory ${readableValue(memory)}`);
    if (swap) parts.push(`Swap ${readableValue(swap)}`);
  }
  return parts.length ? parts.join(" · ") : unavailable;
}
export function configurationQueryKey(profileId: string, connectionId: string) {
  return ["configuration", profileId, connectionId] as const;
}
