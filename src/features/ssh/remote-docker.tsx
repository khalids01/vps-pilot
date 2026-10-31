import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ServerProfile, safeError } from "./api";
import { useCommandActivity } from "./command-activity";
import {
  DockerLifecycle,
  DockerManagement,
  type DockerSection,
} from "./docker-management";
import { RemoteInspection } from "./remote-inspection";
import { RemoteTerminal } from "./remote-terminal";
import { type StreamEvent, streamApi } from "./streams";

interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  project: string;
  service: string;
}
interface Detail {
  id: string;
  name: string;
  image: string;
  status: string;
  started: string;
  restarts: number;
  health: string;
  restartPolicy: string;
  networkMode: string;
  privileged: boolean;
  mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
  environment: (string | null)[];
}
interface Stats {
  cpu: string;
  memory: string;
  memoryPercent: string;
  network: string;
  disk: string;
  pids: string;
}
interface Plan {
  id: string;
  command: string;
  purpose: string;
}
export function RemoteDocker({
  profile,
  connected,
}: {
  profile: ServerProfile;
  connected: boolean;
}) {
  const activity = useCommandActivity();
  const [section, setSection] = useState<DockerSection>("Containers");
  const [logFilter, setLogFilter] = useState("");
  const [pausedLogs, setPausedLogs] = useState<string | null>(null);
  const [inventoryTime, setInventoryTime] = useState<number | null>(null);
  const [containers, setContainers] = useState<Container[] | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [stats, setStats] = useState<Stats | null>(null);
  const [query, setQuery] = useState(""),
    [project, setProject] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [logs, setLogs] = useState(""),
    [logState, setLogState] = useState(""),
    [logTarget, setLogTarget] = useState<string | null>(null),
    [logPlan, setLogPlan] = useState<Plan | null>(null);
  const [terminals, setTerminals] = useState<string[]>([]),
    [activeTerminal, setActiveTerminal] = useState<string | null>(null);
  const stream = useRef<string | null>(null),
    mounted = useRef(true),
    generation = useRef(0),
    busyRef = useRef(false),
    logEntry = useRef<string | null>(null),
    pendingPlan = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      if (stream.current)
        void streamApi.close(profile.id, stream.current).catch(() => {});
      if (pendingPlan.current)
        void invoke("ssh_action_reject", {
          profileId: profile.id,
          planId: pendingPlan.current,
        }).catch(() => {});
    };
  }, [profile.id]);
  async function load<T>(
    kind: "list" | "details" | "stats",
    container: string | null,
    done: (rows: T[]) => void,
  ) {
    if (busyRef.current || !connected) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const entry = activity.begin(
      `Docker ${kind}`,
      `Docker ${kind} · ${profile.name}`,
    );
    try {
      const reply = await invoke<{ data: T[]; command: string }>(
        "ssh_docker_query",
        { profileId: profile.id, query: kind, container },
      );
      if (mounted.current) {
        done(reply.data);
        activity.update(entry, {
          command: reply.command,
          status: "completed",
          ended: Date.now(),
        });
      }
    } catch (e) {
      if (mounted.current) {
        setError(safeError(e));
        activity.update(entry, {
          status: "failed",
          message: safeError(e),
          ended: Date.now(),
        });
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const stop = () => {
    generation.current++;
    const id = stream.current;
    stream.current = null;
    setLogState("Stopped");
    if (id) void streamApi.close(profile.id, id).catch(() => {});
    if (logEntry.current)
      activity.update(logEntry.current, {
        status: "cancelled",
        ended: Date.now(),
      });
  };
  async function reviewLogs() {
    if (!detail || busyRef.current || stream.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const plan = await invoke<Plan>("ssh_action_review", {
        profileId: profile.id,
        action: { type: "dockerFollow", container: detail.id },
      });
      if (mounted.current) {
        pendingPlan.current = plan.id;
        setLogTarget(detail.id);
        setLogPlan(plan);
      } else
        void invoke("ssh_action_reject", {
          profileId: profile.id,
          planId: plan.id,
        }).catch(() => {});
    } catch (e) {
      if (mounted.current) setError(safeError(e));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const rejectLogs = () => {
    const plan = pendingPlan.current;
    pendingPlan.current = null;
    setLogPlan(null);
    if (plan)
      void invoke("ssh_action_reject", {
        profileId: profile.id,
        planId: plan,
      }).catch(() => {});
  };
  async function follow() {
    if (!logPlan || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const plan = logPlan;
    pendingPlan.current = null;
    setLogPlan(null);
    setLogs("");
    setLogState("Opening…");
    const current = ++generation.current;
    let ended = false;
    const entry = activity.begin("Container live logs", plan.command, {
      cancel: stop,
    });
    logEntry.current = entry;
    const output = new Channel<StreamEvent>();
    const decoder = new TextDecoder();
    output.onmessage = (event) => {
      if (!mounted.current || generation.current !== current) {
        void streamApi.close(profile.id, event.id).catch(() => {});
        return;
      }
      if (event.type === "data") {
        const text = decoder.decode(new Uint8Array(event.data), {
          stream: true,
        });
        setLogs((old) => (old + text).slice(-65536));
        setLogState("Following · 60-second / 1 MiB stream limit");
        void streamApi
          .ack(profile.id, event.id, event.sequence)
          .catch(() => {});
      } else if (event.type === "closed") {
        ended = true;
        stream.current = null;
        setLogState(event.message);
        activity.update(entry, {
          status: event.code === 0 ? "completed" : "failed",
          ended: Date.now(),
          message: event.message,
        });
      }
    };
    try {
      const id = await invoke<string>("ssh_action_execute", {
        profileId: profile.id,
        planId: plan.id,
        password: "",
        output,
      });
      if (mounted.current && current === generation.current && !ended)
        stream.current = id;
      else void streamApi.close(profile.id, id).catch(() => {});
    } catch (e) {
      if (mounted.current) {
        setError(safeError(e));
        setLogState("Failed");
        activity.update(entry, { status: "failed", ended: Date.now() });
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const groups = [
    ...new Set((containers ?? []).map((c) => c.project).filter(Boolean)),
  ].sort();
  const visible = (containers ?? []).filter(
    (c) =>
      (!project || c.project === project) &&
      [c.name, c.image, c.service, c.id].some((value) =>
        value.toLowerCase().includes(query.toLowerCase()),
      ),
  );
  return (
    <section aria-label={`${profile.name} Docker`} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Docker</h2>
          <p className="text-xs text-muted-foreground">
            Container and Compose snapshots · No automatic polling
            {inventoryTime
              ? ` · Updated ${new Date(inventoryTime).toLocaleTimeString()}`
              : ""}
          </p>
        </div>
        <Button
          className={section === "Containers" ? "" : "hidden"}
          disabled={!connected || busy}
          onClick={() =>
            load<Container>("list", null, (rows) => {
              setContainers(rows);
              setInventoryTime(Date.now());
            })
          }
        >
          {containers ? "Refresh containers" : "Load containers"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DockerManagement
        profile={profile}
        connected={connected}
        tab={section}
        onTabChange={setSection}
        onChanged={() =>
          void (async () => {
            let exists = true;
            await load<Container>("list", null, (rows) => {
              setContainers(rows);
              setInventoryTime(Date.now());
              if (detail && !rows.some((c) => c.id === detail.id)) {
                exists = false;
                setDetail(null);
              }
            });
            if (detail && exists)
              await load<Detail>("details", detail.id, (rows) =>
                setDetail(rows[0] ?? null),
              );
          })()
        }
      >
        {containers && (
          <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Select
                value={project}
                onValueChange={(value) => setProject(value ?? "")}
                items={[
                  { value: "", label: `All containers (${containers.length})` },
                  ...groups.map((name) => {
                    const members = containers.filter(
                      (c) => c.project === name,
                    );
                    return {
                      value: name,
                      label: `${name} · ${members.filter((c) => c.state === "running").length}/${members.length} running`,
                    };
                  }),
                ]}
              >
                <SelectTrigger
                  aria-label="Container project filter"
                  className="w-full data-[size=default]:h-9 sm:w-56 sm:shrink-0"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">
                    All containers ({containers.length})
                  </SelectItem>
                  {groups.map((name) => {
                    const members = containers.filter(
                      (c) => c.project === name,
                    );
                    return (
                      <SelectItem key={name} value={name}>
                        {name} ·{" "}
                        {members.filter((c) => c.state === "running").length}/
                        {members.length} running
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Input
                aria-label="Search containers"
                className="min-w-0 flex-1"
                placeholder="Search name, image or service…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-left text-xs">
                <thead className="bg-card text-muted-foreground">
                  <tr>
                    {["Container", "State / health", "Image", "Ports"].map(
                      (label) => (
                        <th key={label} className="p-3">
                          {label}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="p-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || !connected}
                          onClick={() => {
                            setStats(null);
                            void load<Detail>("details", c.id, (rows) =>
                              setDetail(rows[0] ?? null),
                            );
                          }}
                        >
                          {c.name}
                        </Button>
                        <p className="text-muted-foreground">
                          {c.project || "Standalone"}
                          {c.service ? ` / ${c.service}` : ""}
                        </p>
                      </td>
                      <td className="p-3">{c.status || c.state}</td>
                      <td className="max-w-64 break-all p-3">{c.image}</td>
                      <td className="max-w-64 break-all p-3">
                        {c.ports || "No published ports"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!visible.length && (
                <p className="p-4 text-sm text-muted-foreground">
                  No matching containers.
                </p>
              )}
            </div>
          </div>
        )}
        {detail && (
          <section
            aria-label="Container details"
            className="space-y-4 rounded-xl border bg-card p-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">
                {detail.name.replace(/^\//, "")}
              </h3>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                Close details
              </Button>
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {detail.id}
            </p>
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              {Object.entries({
                State: detail.status,
                Health: detail.health,
                Started: detail.started,
                Restarts: detail.restarts,
                "Restart policy": detail.restartPolicy,
                Network: detail.networkMode,
                Privileged: detail.privileged ? "Yes" : "No",
              }).map(([name, value]) => (
                <div key={name}>
                  <dt className="text-xs text-muted-foreground">{name}</dt>
                  <dd className="break-all">{String(value)}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || !connected || detail.status !== "running"}
                onClick={() =>
                  load<Stats>("stats", detail.id, (rows) =>
                    setStats(rows[0] ?? null),
                  )
                }
              >
                Refresh resource snapshot
              </Button>
              <Button
                variant="outline"
                disabled={busy || !connected || !!stream.current}
                onClick={() => void reviewLogs()}
              >
                Review live logs
              </Button>
              <Button
                variant="outline"
                disabled={
                  !connected ||
                  detail.status !== "running" ||
                  (terminals.length >= 4 && !terminals.includes(detail.id))
                }
                onClick={() => {
                  setTerminals((old) =>
                    old.includes(detail.id) ? old : [...old, detail.id],
                  );
                  setActiveTerminal(detail.id);
                }}
              >
                Open container terminal
              </Button>
            </div>
            {stats && (
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                {Object.entries({
                  CPU: stats.cpu,
                  Memory: stats.memory,
                  "Memory usage": stats.memoryPercent,
                  "Network I/O": stats.network,
                  "Block I/O": stats.disk,
                  PIDs: stats.pids,
                }).map(([name, value]) => (
                  <div key={name}>
                    <dt className="text-xs text-muted-foreground">{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <details>
              <summary className="cursor-pointer text-sm">
                Mounts ({detail.mounts?.length ?? 0})
              </summary>
              {detail.mounts?.map((m) => (
                <p key={m.Destination} className="mt-2 break-all text-xs">
                  {m.Type} · {m.Source} → {m.Destination} ·{" "}
                  {m.RW ? "Read/write" : "Read-only"}
                </p>
              ))}
            </details>
            <details>
              <summary className="cursor-pointer text-sm">
                Environment · values always masked
              </summary>
              <div className="mt-2 space-y-1">
                {detail.environment
                  .filter((name): name is string => typeof name === "string")
                  .map((name) => (
                    <p key={name} className="break-all font-mono text-xs">
                      {name}=••••••
                    </p>
                  ))}
              </div>
            </details>
            <DockerLifecycle id={detail.id} state={detail.status} />
          </section>
        )}
        {(logs || logState) && (
          <section
            aria-label="Container live logs"
            className="space-y-2 rounded-xl border p-3"
          >
            <div className="flex items-center justify-between">
              <p className="text-xs">
                {containers?.find((c) => c.id === logTarget)?.name ?? logTarget}{" "}
                · {logState}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={!stream.current}
                onClick={stop}
              >
                Stop logs
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label="Search container logs"
                placeholder="Filter cached log lines…"
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                className="min-w-40 flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPausedLogs(pausedLogs === null ? logs : null)}
              >
                {pausedLogs === null ? "Pause display" : "Resume display"}
              </Button>
            </div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
              {(pausedLogs ?? logs)
                .split("\n")
                .filter((line) =>
                  line.toLowerCase().includes(logFilter.toLowerCase()),
                )
                .join("\n") || "No matching output."}
            </pre>
          </section>
        )}
        {!!terminals.length && (
          <section aria-label="Container terminals" className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {terminals.map((id) => (
                <Button
                  key={id}
                  variant={activeTerminal === id ? "default" : "outline"}
                  size="sm"
                  onClick={() => setActiveTerminal(id)}
                >
                  {containers?.find((c) => c.id === id)?.name ??
                    id.slice(0, 12)}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Interactive /bin/sh as the container's configured user. Commands
              can modify application data.
            </p>
            {terminals.map((id) => (
              <div
                key={id}
                className={activeTerminal === id ? "block" : "hidden"}
              >
                <RemoteTerminal
                  profile={profile}
                  connected={connected}
                  container={id}
                />
              </div>
            ))}
          </section>
        )}
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm">
            Images, volumes and Docker diagnostics
          </summary>
          <RemoteInspection
            profile={profile}
            connected={connected}
            tool="Docker"
            active={false}
          />
        </details>
      </DockerManagement>
      <Dialog
        open={!!logPlan}
        onOpenChange={(open) => {
          if (!open) rejectLogs();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Follow container logs?</DialogTitle>
            <DialogDescription>
              {profile.name} · {detail?.name}. Logs can contain application
              secrets. Output stays in bounded memory and is not saved.
            </DialogDescription>
          </DialogHeader>
          <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
            {logPlan?.command}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={rejectLogs}>
              Cancel
            </Button>
            <Button disabled={!connected} onClick={() => void follow()}>
              Follow logs
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
