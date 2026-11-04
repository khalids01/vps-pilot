import {
  readPreference,
  writePreference,
} from "@/features/settings/persistence";
import { quickSetupCatalogLabel } from "./quick-setup-catalog";

export const quickSetupDraftPrefix = "vps-pilot:quick-setup-draft:v1:";
export const quickSetupDraftMaxLength = 4096;
export const quickSetupInvalidDraftSentinel =
  "vps-pilot:quick-setup-draft-invalid";

export const quickSetupSteps = [
  { id: 1, title: "Connect and inspect" },
  { id: 2, title: "Administrator" },
  { id: 3, title: "SSH key" },
  { id: 4, title: "SSH and firewall" },
  { id: 5, title: "Application stack" },
  { id: 6, title: "Developer tools" },
  { id: 7, title: "Runtimes" },
  { id: 8, title: "Review and finish" },
] as const;
export type QuickSetupStepId = (typeof quickSetupSteps)[number]["id"];

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
] as const;
export type QuickSetupUtilityId = (typeof quickSetupUtilities)[number];

export const quickSetupRuntimes = ["bun", "nvm-node", "uv"] as const;
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
  };
  access: {
    port: number;
    ufw: QuickSetupUfwChoice;
    recoveryAcknowledged: boolean;
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
    access: { port: 52022, ufw: "configure", recoveryAcknowledged: false },
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
  if (
    !hasExactKeys(
      sshKey,
      generatedKeyId === undefined
        ? ["strategy"]
        : ["strategy", "generatedKeyId"],
    )
  )
    return null;

  const access = value.access;
  if (
    !isRecord(access) ||
    !hasExactKeys(access, ["port", "ufw", "recoveryAcknowledged"]) ||
    typeof access.port !== "number" ||
    validateQuickSetupPort(access.port) !== null ||
    !(quickSetupUfwChoices as readonly unknown[]).includes(access.ufw) ||
    typeof access.recoveryAcknowledged !== "boolean"
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

  if (!uniqueMembers(value.runtimes, quickSetupRuntimes, 3)) return null;
  if (stack.choice === "javascript" && !value.runtimes.includes("nvm-node"))
    return null;

  return {
    version: 1,
    step: value.step as QuickSetupStepId,
    administrator: {
      mode: administrator.mode as QuickSetupAdminMode,
      username: administrator.username,
    },
    sshKey:
      generatedKeyId === undefined
        ? { strategy: sshKey.strategy as QuickSetupKeyStrategy }
        : {
            strategy: sshKey.strategy as QuickSetupKeyStrategy,
            generatedKeyId,
          },
    access: {
      port: access.port,
      ufw: access.ufw as QuickSetupUfwChoice,
      recoveryAcknowledged: access.recoveryAcknowledged,
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
  writePreference(key, JSON.stringify(clean));
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
