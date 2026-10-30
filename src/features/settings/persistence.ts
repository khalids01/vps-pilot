import { invoke, isTauri } from "@tauri-apps/api/core";

const cache = new Map<string, string>();
const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let queue = Promise.resolve();
export const storageErrorEvent = "vps-pilot:storage-error";

export function readPreference(key: string): string | null {
  return isTauri() ? (cache.get(key) ?? null) : localStorage.getItem(key);
}
export function flushPreferences() {
  clearTimeout(timer);
  const entries = [...pending];
  pending.clear();
  queue = queue.then(async () => {
    for (const [key, value] of entries) {
      try {
        await invoke("app_save_document", { key, value, import: false });
      } catch {
        if (!pending.has(key) && cache.get(key) === value)
          pending.set(key, value);
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
export function writePreference(key: string, value: string) {
  if (!isTauri()) {
    localStorage.setItem(key, value);
    return;
  }
  if (cache.get(key) === value) return;
  cache.set(key, value);
  pending.set(key, value);
  clearTimeout(timer);
  if (key === "vps-pilot-updates") void flushPreferences();
  else timer = setTimeout(() => void flushPreferences(), 150);
}
export async function hydratePreferences(documents: Record<string, string>) {
  const [{ sanitizePreferences, workspacePreferenceKey }, { sanitizeLayout }] =
    await Promise.all([
      import("../workspace/preferences"),
      import("../terminal/layout"),
    ]);
  const clean = (key: string, raw: string): string | null => {
    if (raw.length > 128000) return null;
    try {
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
  cache.clear();
  for (const [key, raw] of Object.entries(documents)) {
    const value = clean(key, raw);
    if (value !== null) cache.set(key, value);
  }
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key || cache.has(key)) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    const value = clean(key, raw);
    if (value === null) continue;
    const actual = await invoke<string>("app_save_document", {
      key,
      value,
      import: true,
    });
    const sanitized = clean(key, actual);
    if (sanitized !== null) cache.set(key, sanitized);
  }
}
