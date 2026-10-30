import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  flushPreferences,
  hydratePreferences,
  storageErrorEvent,
} from "./persistence";

export const statIds = ["cpu", "ram", "storage", "diskIo", "network"] as const;
export type StatId = (typeof statIds)[number];
export interface AppSettings {
  liveStats: boolean;
  intervalSeconds: number;
  visibleStats: StatId[];
  zoomPercent: number;
}
export const defaultSettings: AppSettings = {
  liveStats: true,
  intervalSeconds: 1,
  visibleStats: [...statIds],
  zoomPercent: 100,
};
interface ContextValue {
  settings: AppSettings;
  update: (
    patch: Partial<AppSettings> | ((old: AppSettings) => AppSettings),
  ) => void;
  saving: boolean;
  error: string;
}
const Context = createContext<ContextValue | null>(null);
export function useAppSettings() {
  const value = useContext(Context);
  if (!value) throw Error("App settings are not initialized.");
  return value;
}
export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(defaultSettings);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const current = useRef(defaultSettings);
  const writes = useRef(Promise.resolve());
  const saveGeneration = useRef(0);
  useEffect(() => {
    let disposed = false;
    if (attempt) setLoadError("");
    const load = async () => {
      try {
        if (isTauri()) {
          const data = await invoke<{
            settings: AppSettings;
            documents: Record<string, string>;
          }>("app_bootstrap");
          if (disposed) return;
          await hydratePreferences(data.documents);
          const { useUpdateStore } = await import("../updates/update-store");
          await useUpdateStore.persist.rehydrate();
          if (disposed) return;
          current.current = data.settings;
          setSettings(data.settings);
        }
        if (!disposed) {
          setReady(true);
          setLoadError("");
        }
      } catch {
        if (!disposed)
          setLoadError(
            "Local data could not be opened. Your saved data has not been reset.",
          );
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [attempt]);
  const update = useCallback<ContextValue["update"]>((patch) => {
    const next =
      typeof patch === "function"
        ? patch(current.current)
        : { ...current.current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(current.current)) return;
    current.current = next;
    setSettings(next);
    setSaving(true);
    setError("");
    const generation = ++saveGeneration.current;
    writes.current = writes.current.then(async () => {
      try {
        if (isTauri()) await invoke("app_save_settings", { settings: next });
        if (generation === saveGeneration.current) {
          setSaving(false);
          setError("");
        }
      } catch {
        if (generation === saveGeneration.current) {
          setSaving(false);
          setError(
            "Settings could not be saved. Changes are active for this session only.",
          );
        }
      }
    });
  }, []);
  useEffect(() => {
    const onError = (event: Event) =>
      setError((event as CustomEvent<string>).detail);
    const flush = () => void flushPreferences();
    window.addEventListener(storageErrorEvent, onError);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener(storageErrorEvent, onError);
      window.removeEventListener("pagehide", flush);
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    if (isTauri()) {
      void invoke("app_apply_zoom", {
        zoomPercent: settings.zoomPercent,
      }).catch(() =>
        setError("The app zoom could not be applied on this device."),
      );
    } else {
      document.documentElement.style.zoom = String(settings.zoomPercent / 100);
    }
  }, [ready, settings.zoomPercent]);
  useEffect(() => {
    if (!ready) return;
    const step = (direction: number) =>
      update((old) => ({
        ...old,
        zoomPercent: Math.max(
          50,
          Math.min(200, old.zoomPercent + direction * 10),
        ),
      }));
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (!["+", "=", "-", "_", "0"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "0") update({ zoomPercent: 100 });
      else step(event.key === "-" || event.key === "_" ? -1 : 1);
    };
    let lastWheel = 0;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (Date.now() - lastWheel < 120 || event.deltaY === 0) return;
      lastWheel = Date.now();
      step(event.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("wheel", wheel);
    };
  }, [ready, update]);
  const value = useMemo(
    () => ({ settings, update, saving, error }),
    [settings, update, saving, error],
  );
  if (!ready)
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-4 p-8">
        <h1 className="text-lg font-medium">
          {loadError ? "Unable to open local data" : "Opening VPS Pilot…"}
        </h1>
        {loadError && (
          <>
            <p role="alert" className="text-sm text-muted-foreground">
              {loadError}
            </p>
            <Button onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </Button>
          </>
        )}
      </main>
    );
  return (
    <Context.Provider value={value}>
      {error && (
        <p
          role="alert"
          className="border-b bg-background px-4 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {children}
    </Context.Provider>
  );
}
