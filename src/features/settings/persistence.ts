import { invoke, isTauri } from "@tauri-apps/api/core";
import { fleetKey, sanitizeFleet } from "@/features/workspace/fleet-data";

const cache = new Map<string, string>();
const pending = new Map<string, string>();
const latestWrite = new Map<string, number>();
const saveStates = new Map<string, PreferenceSaveState>();
const failedDocuments = new Set<string>();
const saveListeners = new Map<string, Set<() => void>>();
let timer: ReturnType<typeof setTimeout> | undefined;
let queue = Promise.resolve();
let sequence = 0;
export const storageErrorEvent = "vps-pilot:storage-error";
export const storageRecoveredEvent = "vps-pilot:storage-recovered";

export type PreferenceSaveStatus = "idle" | "saving" | "saved" | "error";
export interface PreferenceSaveState {
  readonly status: PreferenceSaveStatus;
}
const idleState: PreferenceSaveState = { status: "idle" };
const savingState: PreferenceSaveState = { status: "saving" };
const savedState: PreferenceSaveState = { status: "saved" };
const errorState: PreferenceSaveState = { status: "error" };

function setSaveState(key: string, next: PreferenceSaveState) {
  if ((saveStates.get(key) ?? idleState) === next) return;
  saveStates.set(key, next);
  const listeners = saveListeners.get(key);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

export function getPreferenceSaveState(key: string): PreferenceSaveState {
  return saveStates.get(key) ?? idleState;
}

function markSaved(key: string) {
  setSaveState(key, savedState);
  const wasFailed = failedDocuments.delete(key);
  // Only clear the global persistence banner once no other document from any
  // server is still failed. Unrelated settings/bootstrap errors are untouched.
  if (wasFailed && failedDocuments.size === 0)
    window.dispatchEvent(new CustomEvent(storageRecoveredEvent));
}

export function subscribePreferenceSaveState(
  key: string,
  listener: () => void,
) {
  let listeners = saveListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    saveListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) saveListeners.delete(key);
  };
}

function enqueue(key: string, value: string, immediate: boolean) {
  cache.set(key, value);
  latestWrite.set(key, ++sequence);
  pending.set(key, value);
  setSaveState(key, savingState);
  clearTimeout(timer);
  timer = undefined;
  if (immediate || key === "vps-pilot-updates") void flushPreferences();
  else timer = setTimeout(() => void flushPreferences(), 150);
}

function writeLocal(key: string, value: string) {
  const entrySequence = ++sequence;
  latestWrite.set(key, entrySequence);
  cache.set(key, value);
  pending.set(key, value);
  setSaveState(key, savingState);
  try {
    localStorage.setItem(key, value);
    // A failure is retryable with this exact value until a matching write is
    // acknowledged; localStorage is synchronous here.
    if (latestWrite.get(key) !== entrySequence) return;
    pending.delete(key);
    markSaved(key);
  } catch {
    if (latestWrite.get(key) === entrySequence) {
      failedDocuments.add(key);
      setSaveState(key, errorState);
    }
  }
}

export function readPreference(key: string): string | null {
  if (isTauri()) return cache.get(key) ?? null;
  // A failed local write keeps its latest value in memory until retried, so a
  // remount after the failure must not read the older persisted bytes.
  if (pending.has(key)) return cache.get(key) ?? null;
  return localStorage.getItem(key);
}
export function flushPreferences() {
  clearTimeout(timer);
  timer = undefined;
  const entries = [...pending].map(([key, value]) => {
    return [key, value, latestWrite.get(key) ?? 0] as const;
  });
  pending.clear();
  if (entries.length === 0) return queue;
  queue = queue.then(async () => {
    for (const [key, value, entrySequence] of entries) {
      try {
        await invoke("app_save_document", { key, value, import: false });
        // A newer local value, or a retry of this one, keeps the state saving
        // until its own matching acknowledgement arrives.
        if (latestWrite.get(key) !== entrySequence || pending.has(key))
          continue;
        markSaved(key);
      } catch {
        // Never let an older failure overwrite a newer write's state.
        if (latestWrite.get(key) !== entrySequence) continue;
        const latest = cache.get(key);
        if (latest !== undefined) pending.set(key, latest);
        failedDocuments.add(key);
        setSaveState(key, errorState);
        window.dispatchEvent(
          new CustomEvent(storageErrorEvent, {
            detail: "Workspace changes could not be saved to this device.",
          }),
        );
      }
    }
  });
  return queue;
}
export function writePreference(
  key: string,
  value: string,
  options?: { immediate?: boolean },
) {
  if (!isTauri()) {
    writeLocal(key, value);
    return;
  }
  if (cache.get(key) === value) return;
  enqueue(key, value, options?.immediate === true);
}
export function retryPreference(key: string) {
  const value = cache.get(key);
  if (value === undefined) return Promise.resolve();
  if (!isTauri()) {
    // Retry the latest value even when it matches the cached bytes.
    writeLocal(key, value);
    return Promise.resolve();
  }
  // A retry writes the latest cached value even when it is byte-identical to
  // the value whose acknowledgement failed.
  enqueue(key, value, true);
  return queue;
}
export async function hydratePreferences(documents: Record<string, string>) {
  const [
    { sanitizePreferences, workspacePreferenceKey },
    { sanitizeLayout },
    {
      commandConsolePreferenceKey,
      commandConsolePreferencePrefix,
      sanitizeCommandConsolePreference,
    },
    {
      quickSetupDraftKey,
      quickSetupDraftMaxLength,
      quickSetupDraftPrefix,
      quickSetupInvalidDraftSentinel,
      sanitizeQuickSetupDraft,
      quickSetupProgressKey,
      quickSetupProgressPrefix,
      sanitizeQuickSetupProgress,
    },
  ] = await Promise.all([
    import("../workspace/preferences"),
    import("../terminal/layout"),
    import("../ssh/command-console-preferences"),
    import("../ssh/quick-setup-model"),
  ]);
  const cleanQuickSetupDraft = (key: string, raw: string): string | null => {
    const serverId = key.slice(quickSetupDraftPrefix.length);
    if (quickSetupDraftKey(serverId) !== key) return null;
    if (raw === quickSetupInvalidDraftSentinel)
      return quickSetupInvalidDraftSentinel;
    if (raw.length > quickSetupDraftMaxLength)
      return quickSetupInvalidDraftSentinel;
    try {
      const value = sanitizeQuickSetupDraft(JSON.parse(raw));
      return value ? JSON.stringify(value) : quickSetupInvalidDraftSentinel;
    } catch {
      return quickSetupInvalidDraftSentinel;
    }
  };
  const { setupCheckpointPrefix, parseSetupCheckpoints } = await import(
    "../ssh/quick-setup-execution-model"
  );
  const clean = (key: string, raw: string): string | null => {
    if (key.startsWith(setupCheckpointPrefix)) {
      const serverId = key.slice(setupCheckpointPrefix.length);
      if (!quickSetupDraftKey(serverId)) return null;
      const steps = parseSetupCheckpoints(raw);
      return steps === null ? "invalid" : JSON.stringify({ version: 1, steps });
    }
    if (key.startsWith(quickSetupProgressPrefix)) {
      const serverId = key.slice(quickSetupProgressPrefix.length);
      if (quickSetupProgressKey(serverId) !== key || raw.length > 1024)
        return null;
      try {
        const value = sanitizeQuickSetupProgress(JSON.parse(raw));
        return value ? JSON.stringify(value) : null;
      } catch {
        return null;
      }
    }
    if (key.startsWith(quickSetupDraftPrefix))
      return cleanQuickSetupDraft(key, raw);
    if (raw.length > 128000) return null;
    try {
      if (key === fleetKey) {
        const value = sanitizeFleet(JSON.parse(raw));
        return value ? JSON.stringify(value) : null;
      }
      if (key === "vps-pilot-updates") {
        const value = JSON.parse(raw);
        const version = value?.state?.skippedVersion;
        if (
          version !== null &&
          (typeof version !== "string" ||
            version.length > 80 ||
            !/^[0-9A-Za-z.+-]+$/.test(version))
        )
          return null;
        return JSON.stringify({
          state: { skippedVersion: version },
          version: 0,
        });
      }
      if (key === workspacePreferenceKey) {
        const value = sanitizePreferences(JSON.parse(raw));
        return value ? JSON.stringify(value) : null;
      }
      if (key.startsWith(commandConsolePreferencePrefix)) {
        const serverId = key.slice(commandConsolePreferencePrefix.length);
        if (commandConsolePreferenceKey(serverId) !== key) return null;
        const value = sanitizeCommandConsolePreference(JSON.parse(raw));
        if (!value) return null;
        const serialized = JSON.stringify(value);
        return serialized.length <= 256 ? serialized : null;
      }
      const match = /^vps-pilot:(sample|remote)-terminal:v1:(.+)$/.exec(key);
      if (!match) return null;
      const value = sanitizeLayout(
        JSON.parse(raw),
        match[2],
        match[1] as "sample" | "remote",
      );
      return value ? JSON.stringify(value) : null;
    } catch {
      return null;
    }
  };
  const known = new Set<string>();
  const remember = (key: string, value: string) => {
    cache.set(key, value);
    known.add(key);
  };
  cache.clear();
  for (const [key, raw] of Object.entries(documents)) {
    const value = clean(key, raw);
    if (value !== null) remember(key, value);
  }
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key || cache.has(key)) continue;
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    const value = clean(key, raw);
    if (value === null) continue;
    if (value === quickSetupInvalidDraftSentinel) {
      remember(key, value);
      continue;
    }
    const actual = await invoke<string>("app_save_document", {
      key,
      value,
      import: true,
    });
    const sanitized = clean(key, actual);
    if (sanitized !== null) remember(key, sanitized);
  }
  // Previously acknowledged documents are already saved; a newer in-memory
  // write remains pending and keeps its own observable state.
  for (const key of known) {
    if (!pending.has(key)) setSaveState(key, savedState);
  }
}
