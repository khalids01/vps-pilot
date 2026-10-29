import { Activity, RefreshCw, Square, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ServerProfile, safeError } from "./api";
import { type CpuSample, cpuUsage, overviewData } from "./inspection-data";
import { type InspectionKind, streamApi } from "./streams";

type Snapshot = { text: string; time: string; state: string; command: string };
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
const limits: Partial<Record<InspectionKind, string>> = {
  software:
    "Package inventory reports installed packages and runtime paths for the SSH user. Installation source and ownership need further verification before changes.",
  docker:
    "Inspects containers, Compose projects, images, volumes, and disk usage. Docker socket permission is required. Persistent data is preserved.",
  proxy:
    "Inspects service and container ownership and listeners. Inactive configuration and deployment-platform ownership require further verification before changes.",
  storage:
    "Read-only filesystem, mount, block-device and journal inspection. Cleanup is unavailable until exact target ownership and protection checks are validated.",
  firewall:
    "UFW may deny inspection without root. Rule changes stay disabled until active SSH-port protection and automatic rollback have been tested.",
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
  const [snapshots, setSnapshots] = useState<
    Partial<Record<InspectionKind, Snapshot>>
  >({});
  const [activity, setActivity] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<InspectionKind | null>(null);
  const [cpuPercent, setCpuPercent] = useState<number | null>(null);
  const previousCpu = useRef<CpuSample | null>(null);
  const running = useRef(false);
  const stream = useRef<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const run = useCallback(async () => {
    if (!connected || running.current) return;
    running.current = true;
    setBusy(true);
    const current = ++generation.current;
    const decoder = new TextDecoder();
    let text = "";
    let ended = false;
    let command = "Preparing fixed read-only inspection…";
    const publish = (state: string) => {
      if (!mounted.current || current !== generation.current) return;
      const snapshot = {
        text,
        time: new Date().toLocaleString(),
        state,
        command,
      };
      setSnapshots((all) => ({ ...all, [kind]: snapshot }));
      setActivity(snapshot);
    };
    publish("Running");
    try {
      const result = await streamApi.inspect(profile.id, kind, (event) => {
        if (!mounted.current || current !== generation.current) {
          void streamApi.close(profile.id, event.id).catch(() => {});
          return;
        }
        if (ended) return;
        if (event.type === "data") {
          text = (
            text + decoder.decode(new Uint8Array(event.data), { stream: true })
          ).slice(-131072);
          publish("Running");
          void streamApi
            .ack(profile.id, event.id, event.sequence)
            .catch((error) => {
              text += `\n${safeError(error)}`;
              publish("Output interrupted");
            });
        } else {
          ended = true;
          text += decoder.decode();
          if (kind === "overview") {
            const sample = overviewData(text).cpu;
            setCpuPercent(cpuUsage(previousCpu.current, sample));
            previousCpu.current = sample;
          }
          publish(
            event.code === 0
              ? "Completed"
              : `${event.message}${event.code !== null ? ` Exit ${event.code}.` : ""}`,
          );
          running.current = false;
          stream.current = null;
          setBusy(false);
          void streamApi.close(profile.id, event.id).catch(() => {});
        }
      });
      command = result.command;
      if (!mounted.current || current !== generation.current) {
        void streamApi.close(profile.id, result.id).catch(() => {});
        return;
      }
      if (!ended) {
        stream.current = result.id;
        publish("Running");
      } else {
        setActivity((old) => (old ? { ...old, command } : old));
        setSnapshots((all) => ({
          ...all,
          [kind]: all[kind] ? { ...all[kind], command } : undefined,
        }));
      }
    } catch (error) {
      if (mounted.current && current === generation.current) {
        text += `\n${safeError(error)}`;
        publish("Failed");
        running.current = false;
        setBusy(false);
      }
    }
  }, [connected, kind, profile.id]);
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
      if (document.visibilityState === "visible") void run();
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
  const overview =
    kind === "overview" && snapshot ? overviewData(snapshot.text) : null;
  return (
    <section
      className="space-y-4"
      aria-label={`${profile.name} ${tool} inspection`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <h2 className="text-lg font-medium">{tool}</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!connected || busy}
            onClick={() => void run()}
          >
            <RefreshCw />
            Inspect
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
      <p className="text-xs leading-relaxed text-muted-foreground">
        {limits[kind] ??
          "Read-only inspection over SSH. Missing tools and permission failures are shown in the output."}{" "}
        Results are snapshots; refresh after external changes.
      </p>
      {!connected && (
        <p role="status" className="text-sm text-muted-foreground">
          Disconnected. Any saved snapshot below is stale. Connect to inspect
          this server.
        </p>
      )}
      {overview && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">CPU</p>
            <p className="mt-2 text-xl">
              {cpuPercent === null ? "Collecting…" : `${cpuPercent}%`}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Requires two completed samples.
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">Memory</p>
            <p className="mt-2 text-xl">
              {overview.memory ? `${overview.memory.percent}%` : "Unavailable"}
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">Root filesystem</p>
            <p className="mt-2 text-xl">
              {overview.diskPercent !== null
                ? `${overview.diskPercent}%`
                : "Unavailable"}
            </p>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            {overview.os} · {overview.arch}
            {overview.partial
              ? " · Some inspection sections failed; see output."
              : ""}
          </p>
        </div>
      )}
      {snapshot ? (
        <>
          <p role="status" className="text-xs text-muted-foreground">
            {snapshot.state} · {snapshot.time}
            {!connected ? " · stale" : ""}
          </p>
          <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/20 p-4 font-mono text-xs">
            {snapshot.text || "Waiting for remote output…"}
          </pre>
        </>
      ) : (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No inspection yet. Select Inspect to read {profile.name}.
        </div>
      )}
      {activity && (
        <section
          className="space-y-3 rounded-lg border bg-sidebar p-4"
          aria-label={`${profile.name} command activity`}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-xs font-medium">
              <SquareTerminal className="size-4 text-primary" />
              Command activity · {profile.name}
            </p>
            {busy && (
              <Button
                size="xs"
                variant="outline"
                onClick={async () => {
                  generation.current++;
                  setLive(null);
                  const id = stream.current;
                  stream.current = null;
                  running.current = false;
                  setBusy(false);
                  setActivity((old) =>
                    old
                      ? {
                          ...old,
                          state:
                            "Cancelled. Remote process may still be running.",
                        }
                      : old,
                  );
                  if (id) await streamApi.close(profile.id, id).catch(() => {});
                }}
              >
                <Square />
                Cancel inspection
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {activity.state} · {activity.time}
          </p>
          <details>
            <summary className="cursor-pointer text-xs">Exact command</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
              {activity.command}
            </pre>
          </details>
          <p className="text-[11px] text-muted-foreground">
            Output is bounded and kept in memory for this workspace. Individual
            tools can report permission errors even when the overall inspection
            finishes.
          </p>
        </section>
      )}
    </section>
  );
}
