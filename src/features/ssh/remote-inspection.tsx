import { Activity, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ServerProfile, safeError } from "./api";
import { useCommandActivity } from "./command-activity";
import { type CpuSample, cpuUsage } from "./inspection-data";
import type { InspectionReport } from "./report-types";
import { type InspectionKind, streamApi } from "./streams";
import { StructuredReport } from "./structured-report";

type Snapshot = {
  report: InspectionReport | null;
  time: number;
  state: string;
  runId: string;
};
const views: Record<string, InspectionKind> = {
  Overview: "overview",
  Software: "software",
  Docker: "docker",
  Proxy: "proxy",
  Services: "services",
  Storage: "storage",
  Firewall: "firewall",
  Network: "network",
  Processes: "processes",
};
const descriptions: Record<InspectionKind, string> = {
  overview: "A measured snapshot of this server’s resources and health.",
  software: "Installed packages and software paths for your SSH user.",
  docker: "Containers, Compose projects, images, volumes, and storage usage.",
  proxy: "Web services, configuration locations, and port ownership.",
  services: "Service health and startup behavior. App changes are disabled.",
  storage:
    "Filesystems, mounted storage, and block devices. No files are removed.",
  firewall: "Firewall rules and listening ports. Rule changes are disabled.",
  network: "Interfaces, routes, listening ports, and transfer counters.",
  processes: "Resource usage by process. Command arguments are excluded.",
};
export function RemoteInspection({
  profile,
  connected,
  tool,
  active,
}: {
  profile: ServerProfile;
  connected: boolean;
  tool: string;
  active: boolean;
}) {
  const kind = views[tool] ?? "overview";
  const log = useCommandActivity();
  const [snapshots, setSnapshots] = useState<
    Partial<Record<InspectionKind, Snapshot>>
  >({});
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<InspectionKind | null>(null);
  const [cpuPercent, setCpuPercent] = useState<number | null>(null);
  const previousCpu = useRef<CpuSample | null>(null);
  const running = useRef(false);
  const stream = useRef<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const run = useCallback(
    async (background = false) => {
      if (!connected || running.current) return;
      running.current = true;
      setBusy(true);
      const current = ++generation.current;
      const decoder = new TextDecoder();
      let text = "";
      let ended = false;
      let report: InspectionReport | null = null;
      let runId = "";
      const cancel = () => {
        if (generation.current !== current || ended) return;
        generation.current++;
        ended = true;
        setLive(null);
        running.current = false;
        setBusy(false);
        log.update(runId, {
          status: "cancelled",
          ended: Date.now(),
          message: "Cancelled. Its remote process may still be running.",
        });
        setSnapshots((all) => ({
          ...all,
          [kind]: {
            report: all[kind]?.report ?? null,
            time: all[kind]?.time ?? Date.now(),
            state: "Cancelled",
            runId,
          },
        }));
        const id = stream.current;
        stream.current = null;
        if (id) void streamApi.close(profile.id, id).catch(() => {});
      };
      runId = log.begin(`${tool} inspection`, "", {
        background,
        group: background ? `monitor:${kind}` : undefined,
        cancel,
      });
      setSnapshots((all) => ({
        ...all,
        [kind]: {
          report: all[kind]?.report ?? null,
          time: all[kind]?.time ?? Date.now(),
          state: "Running",
          runId,
        },
      }));
      try {
        const command = await streamApi.describe(kind);
        if (!mounted.current || current !== generation.current) return;
        log.update(runId, { command });
        const result = await streamApi.inspect(profile.id, kind, (event) => {
          if (!mounted.current || current !== generation.current) {
            void streamApi.close(profile.id, event.id).catch(() => {});
            return;
          }
          if (ended) return;
          if (event.type === "data") {
            text = (
              text +
              decoder.decode(new Uint8Array(event.data), { stream: true })
            ).slice(-131072);
            log.update(runId, { output: text });
            void streamApi
              .ack(profile.id, event.id, event.sequence)
              .catch((error) =>
                log.update(runId, { message: safeError(error) }),
              );
          } else if (event.type === "inspection") {
            report = event.report;
          } else {
            ended = true;
            text += decoder.decode();
            const received = report;
            if (kind === "overview" && received?.overview) {
              const overview = received.overview;
              const sample =
                overview.cpuTotal !== null && overview.cpuIdle !== null
                  ? { total: overview.cpuTotal, idle: overview.cpuIdle }
                  : null;
              setCpuPercent(cpuUsage(previousCpu.current, sample));
              previousCpu.current = sample;
            }
            const partial = received?.sections.some((section) =>
              ["partial", "unavailable"].includes(section.state),
            );
            const state =
              event.code === 0
                ? partial
                  ? "Partial result"
                  : "Updated"
                : received
                  ? "Partial result"
                  : "Inspection failed";
            log.update(runId, {
              output: text,
              status: event.code === 0 && !partial ? "completed" : "failed",
              ended: Date.now(),
              code: event.code,
              message: event.message,
            });
            setSnapshots((all) => ({
              ...all,
              [kind]: {
                report: received ?? all[kind]?.report ?? null,
                time: received ? Date.now() : (all[kind]?.time ?? Date.now()),
                state,
                runId,
              },
            }));
            running.current = false;
            stream.current = null;
            setBusy(false);
            void streamApi.close(profile.id, event.id).catch(() => {});
          }
        });
        if (!mounted.current || current !== generation.current) {
          void streamApi.close(profile.id, result.id).catch(() => {});
          return;
        }
        log.update(runId, { command: result.command });
        if (!ended) stream.current = result.id;
      } catch (error) {
        if (mounted.current && current === generation.current) {
          log.update(runId, {
            status: "failed",
            ended: Date.now(),
            output: text,
            message: safeError(error),
          });
          setSnapshots((all) => ({
            ...all,
            [kind]: {
              report: all[kind]?.report ?? null,
              time: all[kind]?.time ?? Date.now(),
              state: "Inspection failed",
              runId,
            },
          }));
          running.current = false;
          setBusy(false);
        }
      }
    },
    [connected, kind, profile.id, log, tool],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      if (stream.current)
        void streamApi.close(profile.id, stream.current).catch(() => {});
    };
  }, [profile.id]);
  useEffect(() => {
    if (live !== kind || !connected || !active || !views[tool]) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void run(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [live, connected, run, kind, tool, active]);
  useEffect(() => {
    if (!connected) {
      previousCpu.current = null;
      setCpuPercent(null);
      setLive(null);
    }
  }, [connected]);
  const snapshot = snapshots[kind];
  return (
    <section
      className="space-y-5"
      aria-label={`${profile.name} ${tool} inspection`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-medium tracking-tight">{tool}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {descriptions[kind]}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!connected || busy}
            onClick={() => void run()}
          >
            <RefreshCw className={busy ? "animate-spin" : ""} />
            {busy ? "Inspecting…" : snapshot?.report ? "Refresh" : "Inspect"}
          </Button>
          {["overview", "network", "processes"].includes(kind) && (
            <Button
              size="sm"
              variant="outline"
              disabled={!connected}
              aria-pressed={live === kind}
              onClick={() => setLive(live === kind ? null : kind)}
            >
              <Activity />
              {live === kind ? "Pause monitoring" : "Monitor every 5s"}
            </Button>
          )}
        </div>
      </div>
      {snapshot && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <p role="status" className="text-muted-foreground">
            {snapshot.state} · {new Date(snapshot.time).toLocaleTimeString()}
            {!connected
              ? " · Disconnected, showing last result"
              : snapshot.report &&
                  ["Running", "Inspection failed", "Cancelled"].includes(
                    snapshot.state,
                  )
                ? " · Showing previous result"
                : ""}
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => log.reveal(snapshot.runId)}
          >
            View command
          </Button>
        </div>
      )}
      {snapshot?.report ? (
        <StructuredReport report={snapshot.report} cpuPercent={cpuPercent} />
      ) : (
        <div className="rounded-xl border border-dashed px-6 py-12 text-center">
          <p className="text-sm font-medium">
            {busy
              ? "Reading server information…"
              : snapshot
                ? snapshot.state
                : "No inspection yet."}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {snapshot?.state === "Inspection failed"
              ? "Open the command console for details."
              : connected
                ? `Select Inspect to read ${profile.name}.`
                : "Connect to this server to inspect it."}
          </p>
        </div>
      )}
    </section>
  );
}
