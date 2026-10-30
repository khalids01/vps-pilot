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
import { useAppSettings } from "@/features/settings/app-settings";
import { type ServerProfile, safeError } from "./api";
import { useCommandActivity } from "./command-activity";
import {
  type MetricPoint,
  type MetricSample,
  metricPoint,
} from "./live-metrics-data";
import { streamApi } from "./streams";

interface LiveMetrics {
  enabled: boolean;
  interval: number;
  sample: MetricSample | null;
  point: MetricPoint | null;
  history: MetricPoint[];
  state: string;
  fresh: boolean;
  runId: string | null;
}
const Context = createContext<LiveMetrics | null>(null);
export function useLiveMetrics() {
  const context = useContext(Context);
  if (!context) throw new Error("Live metrics need a server workspace.");
  return context;
}
export function LiveMetricsProvider({
  profile,
  connected,
  active,
  children,
}: {
  profile: ServerProfile;
  connected: boolean;
  active: boolean;
  children: ReactNode;
}) {
  const log = useCommandActivity();
  const { settings, update } = useAppSettings();
  const enabled = settings.liveStats && settings.visibleStats.length > 0;
  const interval = settings.intervalSeconds;
  const [visible, setVisible] = useState(
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  const [sample, setSample] = useState<MetricSample | null>(null);
  const [point, setPoint] = useState<MetricPoint | null>(null);
  const [history, setHistory] = useState<MetricPoint[]>([]);
  const [state, setState] = useState("Paused");
  const [fresh, setFresh] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const update = () =>
      setVisible(document.visibilityState === "visible" && document.hasFocus());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  const toggle = useCallback(
    (value: boolean) => {
      failures.current = 0;
      update({ liveStats: value });
    },
    [update],
  );
  useEffect(() => {
    setFresh(false);
    if (!enabled || !connected || !active || !visible) {
      setState(
        !connected
          ? "Disconnected"
          : enabled
            ? "Paused while inactive"
            : "Paused",
      );
      return;
    }
    let disposed = false;
    let id: string | null = null;
    let entry: string | null = null;
    let previous: MetricSample | null = null;
    let ended = false;
    let goodSamples = 0;
    const closed = new Map<string, Promise<void>>();
    const close = (streamId: string) => {
      const pending = closed.get(streamId);
      if (pending) return pending;
      // Publish the promise before invoking IPC: late events share the same cleanup.
      const operation = Promise.resolve()
        .then(() => streamApi.close(profile.id, streamId))
        .catch(() => {});
      closed.set(streamId, operation);
      return operation;
    };
    let retry: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => {
      if (disposed || ended) return;
      ended = true;
      setFresh(false);
      const delay = Math.min(60, 5 * 2 ** Math.min(failures.current++, 4));
      setState(`${message} Retrying in ${delay}s.`);
      if (entry)
        log.update(entry, { status: "failed", ended: Date.now(), message });
      if (id) void close(id);
      retry = setTimeout(() => setAttempt((value) => value + 1), delay * 1000);
    };
    setState(attempt ? "Restarting live metrics…" : "Starting live metrics…");
    // Serial cleanup/start and deferred setup also prevent StrictMode double starts.
    const task = queue.current.then(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      if (disposed) return;
      try {
        const command = await streamApi.describeMonitor();
        if (disposed) return;
        entry = log.begin("Live metrics", command, {
          background: true,
          group: "live-metrics",
          cancel: () => toggle(false),
        });
        setRunId(entry);
        setHistory([]);
        const result = await streamApi.monitor(
          profile.id,
          interval,
          (event) => {
            if (disposed) {
              void close(event.id);
              return;
            }
            id = event.id;
            if (ended) return;
            if (event.type === "metrics") {
              const next = metricPoint(previous, event.sample);
              previous = event.sample;
              if (++goodSamples >= 3) failures.current = 0;
              setSample(event.sample);
              setPoint(next);
              setHistory((old) => [...old, next].slice(-180));
              setFresh(true);
              setState("Live");
              if (entry)
                log.update(entry, {
                  output: JSON.stringify(event.sample, null, 2),
                  message: `Live · ${interval}s minimum interval · latest counters only`,
                });
              void streamApi
                .ack(profile.id, event.id, event.sequence)
                .catch((error) => fail(safeError(error)));
            } else if (event.type === "closed") {
              fail(event.message);
            }
          },
        );
        id = result.id;
        if (disposed || ended) await close(id);
      } catch (error) {
        fail(safeError(error));
      }
    });
    queue.current = task;
    return () => {
      disposed = true;
      clearTimeout(retry);
      queue.current = task.then(async () => {
        if (id) await close(id);
        if (entry && !ended)
          log.update(entry, {
            status: "cancelled",
            ended: Date.now(),
            message:
              "Sampling paused. SSH input is closed; the sampler exits on EOF or after 30 seconds without requests.",
          });
      });
    };
  }, [
    enabled,
    connected,
    active,
    visible,
    interval,
    profile.id,
    log,
    toggle,
    attempt,
  ]);
  const value = useMemo(
    () => ({
      enabled,
      interval,
      sample,
      point,
      history,
      state,
      fresh,
      runId,
    }),
    [enabled, interval, sample, point, history, state, fresh, runId],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
