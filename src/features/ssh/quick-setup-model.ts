import {
  readPreference,
  writePreference,
} from "@/features/settings/persistence";
import { quickSetupCatalogLabel } from "./quick-setup-catalog";

export const quickSetupDraftPrefix = "vps-pilot:quick-setup-draft:v1:";
export const quickSetupDraftMaxLength = 4096;
export const quickSetupInvalidDraftSentinel =
  "vps-pilot:quick-setup-draft-invalid";

// Keep persisted IDs stable so existing VPS drafts and access progress survive.
export const quickSetupSteps = [
  { id: 1, title: "Connection overview" },
  { id: 3, title: "Administrator & SSH key" },
  { id: 4, title: "SSH & firewall" },
  { id: 5, title: "Application stack" },
  { id: 6, title: "Developer tools" },
  { id: 7, title: "Runtimes" },
] as const;
export type QuickSetupStepId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export function quickSetupStepNumber(id: QuickSetupStepId) {
  return quickSetupSteps.findIndex((step) => step.id === id) + 1;
}

export const quickSetupUtilities = [
  "git",
  "curl",
  "ripgrep",
  "fd",
  "fzf",
  "jq",
  "btop",
  "unzip",
  "herdr",
  "tmux",
  "bat",
  "eza",
  "rsync",
  "direnv",
] as const;
export type QuickSetupUtilityId = (typeof quickSetupUtilities)[number];

export const quickSetupRuntimes = [
  "bun",
  "nvm-node",
  "uv",
  "python",
  "go",
] as const;
export type QuickSetupRuntimeId = (typeof quickSetupRuntimes)[number];

export const quickSetupAdminModes = ["new", "existing"] as const;
export type QuickSetupAdminMode = (typeof quickSetupAdminModes)[number];

export const quickSetupKeyStrategies = [
  "existing",
  "generate",
  "agent",
] as const;
export type QuickSetupKeyStrategy = (typeof quickSetupKeyStrategies)[number];

export const quickSetupUfwChoices = ["configure", "keep-current"] as const;
export type QuickSetupUfwChoice = (typeof quickSetupUfwChoices)[number];

export const quickSetupRuleProtocols = ["tcp", "udp"] as const;
export type QuickSetupRuleProtocol = (typeof quickSetupRuleProtocols)[number];
export const quickSetupFirewallRuleLimit = 16;
export interface QuickSetupFirewallRule {
  port: number;
  protocol: QuickSetupRuleProtocol;
}

export const quickSetupStackChoices = [
  "dokploy",
  "javascript",
  "containers",
  "skip",
] as const;
export type QuickSetupStackChoice = (typeof quickSetupStackChoices)[number];

export const quickSetupEngines = ["docker", "podman"] as const;
export type QuickSetupEngine = (typeof quickSetupEngines)[number];

export const quickSetupEditorChoices = ["none", "neovim", "lazyvim"] as const;
export type QuickSetupEditorChoice = (typeof quickSetupEditorChoices)[number];

export interface QuickSetupDraft {
  version: 1;
  step: QuickSetupStepId;
  administrator: {
    mode: QuickSetupAdminMode;
    username: string;
  };
  sshKey: {
    strategy: QuickSetupKeyStrategy;
    generatedKeyId?: string;
    existingKeyId?: string;
  };
  access: {
    port: number;
    ufw: QuickSetupUfwChoice;
    recoveryAcknowledged: boolean;
    passwordLogin?: boolean;
    rootLogin?: boolean;
    allowHttp: boolean;
    allowHttps: boolean;
    rules: QuickSetupFirewallRule[];
  };
  stack: {
    choice: QuickSetupStackChoice;
    engine: QuickSetupEngine | null;
  };
  tools: {
    editor: QuickSetupEditorChoice;
    utilities: QuickSetupUtilityId[];
  };
  runtimes: QuickSetupRuntimeId[];
}

export function defaultQuickSetupDraft(): QuickSetupDraft {
  return {
    version: 1,
    step: 1,
    administrator: { mode: "new", username: "deploy" },
    sshKey: { strategy: "existing" },
    access: {
      port: 52022,
      ufw: "configure",
      recoveryAcknowledged: false,
      allowHttp: false,
      allowHttps: false,
      rules: [],
    },
    stack: { choice: "skip", engine: null },
    tools: { editor: "none", utilities: ["git", "curl", "unzip"] },
    runtimes: [],
  };
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const generatedKeyIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const usernamePattern = /^[a-z_][a-z0-9_-]{0,31}$/;

export function quickSetupDraftKey(serverId: string) {
  return uuidPattern.test(serverId)
    ? `${quickSetupDraftPrefix}${serverId}`
    : null;
}

export function validateQuickSetupUsername(value: string): string | null {
  if (value === "root")
    return "Choose a separate administrator; root is not allowed.";
  if (!usernamePattern.test(value))
    return "Use 1–32 lowercase letters, digits, underscores or hyphens, starting with a letter or underscore.";
  return null;
}

export function validateQuickSetupPort(value: number): string | null {
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    return "Use a whole port from 1 to 65535.";
  return null;
}

export function parseQuickSetupPort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[0-9]{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return validateQuickSetupPort(port) === null ? port : null;
}

export const quickSetupKeyNameMaxLength = 64;
const reservedQuickSetupKeyNames = [
  "config",
  "authorized_keys",
  "known_hosts",
  "environment",
] as const;

export function validateQuickSetupKeyName(value: string): string | null {
  if (value.length === 0)
    return "Enter a key file name from 1 to 64 ASCII characters.";
  if (value.length > quickSetupKeyNameMaxLength)
    return "Use at most 64 ASCII characters.";
  if (!/^[A-Za-z0-9_]$/.test(value[0]))
    return "Start with a letter, number, or underscore, not a dot or hyphen.";
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(value))
    return "Use only ASCII letters, numbers, dots, underscores, or hyphens.";
  if (value.toLowerCase().endsWith(".pub"))
    return "Enter the private key name without the .pub suffix.";
  if ((reservedQuickSetupKeyNames as readonly string[]).includes(value))
    return "That file name is reserved by OpenSSH. Choose a different name.";
  if (value.startsWith("vps-pilot_"))
    return "That file name is reserved for VPS Pilot. Choose a different name.";
  return null;
}

export function defaultQuickSetupKeyName(host: string): string {
  const base = host
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/g, "");
  const candidate = `vps-${base || "key"}`.slice(0, quickSetupKeyNameMaxLength);
  if (validateQuickSetupKeyName(candidate) === null) return candidate;
  return "vps-key";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
function uniqueMembers<T extends string>(
  value: unknown,
  allowed: readonly T[],
  limit: number,
): value is T[] {
  if (!Array.isArray(value) || value.length > limit) return false;
  if (!value.every((item) => typeof item === "string")) return false;
  const unique = new Set(value);
  return (
    unique.size === value.length &&
    value.every((item) => (allowed as readonly string[]).includes(item))
  );
}

function sanitizeFirewallRules(
  value: unknown,
): QuickSetupFirewallRule[] | null {
  if (!Array.isArray(value) || value.length > quickSetupFirewallRuleLimit)
    return null;
  const rules: QuickSetupFirewallRule[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["port", "protocol"]))
      return null;
    const port = entry.port;
    if (
      typeof port !== "number" ||
      validateQuickSetupPort(port) !== null ||
      !(quickSetupRuleProtocols as readonly unknown[]).includes(entry.protocol)
    )
      return null;
    const protocol = entry.protocol as QuickSetupRuleProtocol;
    const key = `${port}/${protocol}`;
    if (seen.has(key)) return null;
    seen.add(key);
    rules.push({ port, protocol });
  }
  return rules;
}

export function sanitizeQuickSetupDraft(
  value: unknown,
): QuickSetupDraft | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      "version",
      "step",
      "administrator",
      "sshKey",
      "access",
      "stack",
      "tools",
      "runtimes",
    ])
  )
    return null;
  if (value.version !== 1) return null;
  if (
    typeof value.step !== "number" ||
    !Number.isInteger(value.step) ||
    value.step < 1 ||
    value.step > 8
  )
    return null;

  const administrator = value.administrator;
  if (
    !isRecord(administrator) ||
    !hasExactKeys(administrator, ["mode", "username"]) ||
    !(quickSetupAdminModes as readonly unknown[]).includes(
      administrator.mode,
    ) ||
    typeof administrator.username !== "string" ||
    validateQuickSetupUsername(administrator.username) !== null
  )
    return null;

  const sshKey = value.sshKey;
  if (
    !isRecord(sshKey) ||
    !(quickSetupKeyStrategies as readonly unknown[]).includes(sshKey.strategy)
  )
    return null;
  const generatedKeyId = sshKey.generatedKeyId;
  if (
    generatedKeyId !== undefined &&
    (typeof generatedKeyId !== "string" ||
      !generatedKeyIdPattern.test(generatedKeyId) ||
      sshKey.strategy !== "generate")
  )
    return null;
  const existingKeyId = sshKey.existingKeyId;
  if (
    existingKeyId !== undefined &&
    (typeof existingKeyId !== "string" ||
      !generatedKeyIdPattern.test(existingKeyId) ||
      sshKey.strategy !== "existing")
  )
    return null;
  const sshKeyFields = ["strategy"];
  if (generatedKeyId !== undefined) sshKeyFields.push("generatedKeyId");
  if (existingKeyId !== undefined) sshKeyFields.push("existingKeyId");
  if (!hasExactKeys(sshKey, sshKeyFields)) return null;

  const access = value.access;
  if (!isRecord(access)) return null;
  const optionalAccessKeys = [
    "allowHttp",
    "allowHttps",
    "rules",
    "passwordLogin",
    "rootLogin",
  ] as const;
  const presentOptionalAccessKeys = optionalAccessKeys.filter((key) =>
    Object.keys(access).includes(key),
  );
  const allowHttp = access.allowHttp;
  const allowHttps = access.allowHttps;
  const firewallRules =
    access.rules === undefined ? [] : sanitizeFirewallRules(access.rules);
  if (
    !hasExactKeys(access, [
      "port",
      "ufw",
      "recoveryAcknowledged",
      ...presentOptionalAccessKeys,
    ]) ||
    typeof access.port !== "number" ||
    validateQuickSetupPort(access.port) !== null ||
    !(quickSetupUfwChoices as readonly unknown[]).includes(access.ufw) ||
    typeof access.recoveryAcknowledged !== "boolean" ||
    (allowHttp !== undefined && typeof allowHttp !== "boolean") ||
    (allowHttps !== undefined && typeof allowHttps !== "boolean") ||
    (access.passwordLogin !== undefined &&
      typeof access.passwordLogin !== "boolean") ||
    (access.rootLogin !== undefined && typeof access.rootLogin !== "boolean") ||
    firewallRules === null
  )
    return null;

  const stack = value.stack;
  if (
    !isRecord(stack) ||
    !hasExactKeys(stack, ["choice", "engine"]) ||
    !(quickSetupStackChoices as readonly unknown[]).includes(stack.choice) ||
    !(
      stack.engine === null ||
      (quickSetupEngines as readonly unknown[]).includes(stack.engine)
    )
  )
    return null;
  if (
    (stack.choice === "dokploy" && stack.engine !== "docker") ||
    (stack.choice === "skip" && stack.engine !== null)
  )
    return null;

  const tools = value.tools;
  if (
    !isRecord(tools) ||
    !hasExactKeys(tools, ["editor", "utilities"]) ||
    !(quickSetupEditorChoices as readonly unknown[]).includes(tools.editor) ||
    !uniqueMembers(
      tools.utilities,
      quickSetupUtilities,
      quickSetupUtilities.length,
    )
  )
    return null;

  if (
    !uniqueMembers(
      value.runtimes,
      quickSetupRuntimes,
      quickSetupRuntimes.length,
    )
  )
    return null;
  if (stack.choice === "javascript" && !value.runtimes.includes("nvm-node"))
    return null;

  return {
    version: 1,
    step: (value.step === 2
      ? 3
      : value.step === 8
        ? 7
        : value.step) as QuickSetupStepId,
    administrator: {
      mode: administrator.mode as QuickSetupAdminMode,
      username: administrator.username,
    },
    sshKey: {
      strategy: sshKey.strategy as QuickSetupKeyStrategy,
      ...(generatedKeyId === undefined ? {} : { generatedKeyId }),
      ...(existingKeyId === undefined ? {} : { existingKeyId }),
    },
    access: {
      port: access.port,
      ufw: access.ufw as QuickSetupUfwChoice,
      recoveryAcknowledged: access.recoveryAcknowledged,
      allowHttp: allowHttp === true,
      allowHttps: allowHttps === true,
      rules: firewallRules,
      ...(access.passwordLogin === undefined
        ? {}
        : { passwordLogin: access.passwordLogin as boolean }),
      ...(access.rootLogin === undefined
        ? {}
        : { rootLogin: access.rootLogin as boolean }),
    },
    stack: {
      choice: stack.choice as QuickSetupStackChoice,
      engine: stack.engine as QuickSetupEngine | null,
    },
    tools: {
      editor: tools.editor as QuickSetupEditorChoice,
      utilities: [...tools.utilities],
    },
    runtimes: [...value.runtimes],
  };
}

export type QuickSetupDraftLoad =
  | { status: "empty" }
  | { status: "ok"; draft: QuickSetupDraft }
  | { status: "invalid" };

export function readQuickSetupDraft(serverId: string): QuickSetupDraftLoad {
  const key = quickSetupDraftKey(serverId);
  if (!key) return { status: "empty" };
  const raw = readPreference(key);
  if (raw === null) return { status: "empty" };
  if (
    raw === quickSetupInvalidDraftSentinel ||
    raw.length > quickSetupDraftMaxLength
  )
    return { status: "invalid" };
  try {
    const draft = sanitizeQuickSetupDraft(JSON.parse(raw));
    return draft ? { status: "ok", draft } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

export function writeQuickSetupDraft(serverId: string, draft: QuickSetupDraft) {
  const key = quickSetupDraftKey(serverId);
  const clean = sanitizeQuickSetupDraft(draft);
  if (!key || !clean) return;
  // Enqueue immediately so the visible Saving/Saved state tracks this write,
  // and never report saved before the native acknowledgement arrives.
  writePreference(key, JSON.stringify(clean), { immediate: true });
}

export const quickSetupProgressPrefix = "vps-pilot:setup-access:v1:";
export const quickSetupProgressStages = [
  "accountReady",
  "keyInstalled",
  "accessVerified",
  "accessPromoted",
] as const;
export type QuickSetupProgressStage = (typeof quickSetupProgressStages)[number];
export interface QuickSetupProgress {
  version: 1;
  stage: QuickSetupProgressStage;
  username: string;
  keyId?: string;
}
export function quickSetupProgressKey(serverId: string) {
  return uuidPattern.test(serverId)
    ? `${quickSetupProgressPrefix}${serverId}`
    : null;
}
export function sanitizeQuickSetupProgress(
  value: unknown,
): QuickSetupProgress | null {
  if (!isRecord(value)) return null;
  const keys = ["version", "stage", "username"];
  if (value.keyId !== undefined) keys.push("keyId");
  if (!hasExactKeys(value, keys) || value.version !== 1) return null;
  if (!(quickSetupProgressStages as readonly unknown[]).includes(value.stage))
    return null;
  if (
    typeof value.username !== "string" ||
    validateQuickSetupUsername(value.username) !== null
  )
    return null;
  if (
    value.keyId !== undefined &&
    (typeof value.keyId !== "string" || !uuidPattern.test(value.keyId))
  )
    return null;
  return {
    version: 1,
    stage: value.stage as QuickSetupProgressStage,
    username: value.username,
    ...(value.keyId === undefined ? {} : { keyId: value.keyId }),
  };
}
export function readQuickSetupProgress(
  serverId: string,
): QuickSetupProgress | null {
  const key = quickSetupProgressKey(serverId);
  if (!key) return null;
  const raw = readPreference(key);
  if (raw === null || raw.length > 1024) return null;
  try {
    return sanitizeQuickSetupProgress(JSON.parse(raw));
  } catch {
    return null;
  }
}
export function writeQuickSetupProgress(
  serverId: string,
  progress: QuickSetupProgress,
) {
  const key = quickSetupProgressKey(serverId);
  const clean = sanitizeQuickSetupProgress(progress);
  if (!key || !clean) return;
  writePreference(key, JSON.stringify(clean), { immediate: true });
}

export interface QuickSetupAccessTargets {
  current: { username: string; port: number };
  planned: { username: string; port: number };
}

export function resolveQuickSetupAccessTargets(
  profile: { username: string; port: number },
  draft: QuickSetupDraft,
): QuickSetupAccessTargets {
  return {
    current: { username: profile.username, port: profile.port },
    planned: {
      username: draft.administrator.username,
      port: draft.access.port,
    },
  };
}

export function requiredQuickSetupRuntimes(
  draft: QuickSetupDraft,
): QuickSetupRuntimeId[] {
  return draft.stack.choice === "javascript" ? ["nvm-node"] : [];
}
export interface QuickSetupResolvedItem {
  id: string;
  label: string;
  sources: string[];
}
export interface QuickSetupPlan {
  items: QuickSetupResolvedItem[];
  duplicateSelections: number;
  missing: string[];
}
export function resolveQuickSetupPlan(draft: QuickSetupDraft): QuickSetupPlan {
  const items = new Map<string, QuickSetupResolvedItem>();
  let duplicateSelections = 0;
  const missing: string[] = [];
  const add = (id: string, source: string) => {
    const existing = items.get(id);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      duplicateSelections += 1;
      return;
    }
    items.set(id, {
      id,
      label: quickSetupCatalogLabel(id),
      sources: [source],
    });
  };

  if (draft.stack.choice === "dokploy") {
    add("dokploy", "Application stack");
    add("docker", "Dokploy requires Docker");
  } else if (draft.stack.choice === "javascript") {
    add("javascript-pm2", "Application stack");
    add("nvm-node", "JavaScript / PM2 requires Node.js");
  } else if (draft.stack.choice === "containers") {
    if (!draft.stack.engine)
      missing.push("Container foundation needs Docker or Podman.");
  }
  if (
    draft.stack.choice !== "dokploy" &&
    draft.stack.choice !== "skip" &&
    draft.stack.engine
  )
    add(draft.stack.engine, "Selected container engine");

  if (draft.tools.editor === "neovim") add("neovim", "Selected editor");
  if (draft.tools.editor === "lazyvim") {
    add("neovim", "Neovim + LazyVim");
    add("lazyvim-starter", "Selected editor");
    add("git", "LazyVim requirement");
    add("ripgrep", "LazyVim requirement");
    add("fd", "LazyVim requirement");
  }
  for (const utility of draft.tools.utilities) add(utility, "Selected utility");
  for (const runtime of draft.runtimes) add(runtime, "Selected runtime");

  return {
    items: [...items.values()],
    duplicateSelections,
    missing,
  };
}

export interface QuickSetupPlannedFirewallRule extends QuickSetupFirewallRule {
  protected: boolean;
  purpose: string;
}
export interface QuickSetupFirewallPlan {
  apply: boolean;
  inbound: "deny";
  outbound: "allow";
  rules: QuickSetupPlannedFirewallRule[];
}
export function quickSetupFirewallRuleKey(rule: QuickSetupFirewallRule) {
  return `${rule.port}/${rule.protocol}`;
}
export function resolveQuickSetupFirewallPlan(
  draft: QuickSetupDraft,
  currentPort: number,
): QuickSetupFirewallPlan {
  const apply = draft.access.ufw === "configure";
  const rules: QuickSetupPlannedFirewallRule[] = [];
  const seen = new Set<string>();
  const add = (
    rule: QuickSetupFirewallRule,
    protectedRule: boolean,
    purpose: string,
  ) => {
    const key = quickSetupFirewallRuleKey(rule);
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({ ...rule, protected: protectedRule, purpose });
  };
  if (apply) {
    add({ port: currentPort, protocol: "tcp" }, true, "Current SSH profile");
    add({ port: draft.access.port, protocol: "tcp" }, true, "Target SSH port");
    if (draft.access.allowHttp)
      add({ port: 80, protocol: "tcp" }, false, "HTTP ingress");
    if (draft.access.allowHttps)
      add({ port: 443, protocol: "tcp" }, false, "HTTPS ingress");
    for (const rule of draft.access.rules) add(rule, false, "Custom rule");
  }
  return { apply, inbound: "deny", outbound: "allow", rules };
}
export function parseQuickSetupCustomRule(
  portText: string,
  protocol: QuickSetupRuleProtocol,
  existing: readonly QuickSetupFirewallRule[],
): { rule: QuickSetupFirewallRule } | { error: string } {
  const port = parseQuickSetupPort(portText);
  if (port === null) return { error: "Use a whole port from 1 to 65535." };
  if (existing.length >= quickSetupFirewallRuleLimit)
    return { error: `Up to ${quickSetupFirewallRuleLimit} custom rules.` };
  const rule = { port, protocol };
  if (
    existing.some(
      (item) =>
        quickSetupFirewallRuleKey(item) === quickSetupFirewallRuleKey(rule),
    )
  )
    return { error: "That port and protocol is already listed." };
  return { rule };
}
