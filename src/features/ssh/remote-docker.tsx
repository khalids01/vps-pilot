import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Tooltip } from "@/components/ui/tooltip";
import { type ServerProfile, safeError } from "./api";
import { useCommandActivity } from "./command-activity";
import { DockerDatabases } from "./docker-databases";
import {
  DockerLifecycle,
  DockerManagement,
  type DockerSection,
} from "./docker-management";
import {
  type ContainerRow as Container,
  imageLabel,
  portLabels,
  stateGroup,
  uniqueContainers,
} from "./docker-view";
import { RemoteInspection } from "./remote-inspection";
import { RemoteTerminal } from "./remote-terminal";
import { type StreamEvent, streamApi } from "./streams";

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
  active = true,
}: {
  profile: ServerProfile;
  connected: boolean;
  active?: boolean;
}) {
  const activity = useCommandActivity();
  const [section, setSection] = useState<DockerSection>("Containers");
  const [logFilter, setLogFilter] = useState("");
  const [pausedLogs, setPausedLogs] = useState<string | null>(null);
  const [inventoryTime, setInventoryTime] = useState<number | null>(null);
  const [containers, setContainers] = useState<Container[] | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [stats, setStats] = useState<Stats | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"Overview" | "Logs" | "Terminal">(
    "Overview",
  );
  const [stateFilter, setStateFilter] = useState("all");
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
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const closePanel = () => {
    setPanelOpen(false);
    selectedButton.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (panelOpen && detail)
      detailHeading.current?.focus({ preventScroll: true });
  }, [panelOpen, detail]);
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
  const load = useCallback(
    async <T,>(
      kind: "list" | "details" | "stats",
      container: string | null,
      done: (rows: T[]) => void,
    ) => {
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
    },
    [connected, profile.id, profile.name, activity],
  );
  const initialListAttempted = useRef(false);
  useEffect(() => {
    if (!active || !connected || initialListAttempted.current) return;
    initialListAttempted.current = true;
    void load<Container>("list", null, (rows) => {
      setContainers(uniqueContainers(rows));
      setInventoryTime(Date.now());
    });
  }, [active, connected, load]);
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
    setPausedLogs(null);
    setDetailTab("Logs");
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
      (!project ||
        (project === "@standalone" ? !c.project : c.project === project)) &&
      (stateFilter === "all" || stateGroup(c.state) === stateFilter) &&
      [c.name, c.image, c.service, c.id].some((value) =>
        value.toLowerCase().includes(query.toLowerCase()),
      ),
  );
  return (
    <section
      aria-label={`${profile.name} Docker`}
      className="flex min-w-0 flex-col gap-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Docker</h2>
          <p className="text-xs text-muted-foreground">
            {inventoryTime
              ? `Last refreshed at ${new Date(inventoryTime).toLocaleTimeString()}`
              : !connected
                ? "Connect to view containers."
                : busy || !initialListAttempted.current
                  ? "Loading containers…"
                  : "Containers unavailable."}
          </p>
        </div>
        <Button
          variant="outline"
          className={section === "Containers" ? "" : "hidden"}
          disabled={!connected || busy}
          onClick={() =>
            load<Container>("list", null, (rows) => {
              setContainers(uniqueContainers(rows));
              setInventoryTime(Date.now());
            })
          }
        >
          Refresh containers
        </Button>
      </div>
      {(detail || logs || terminals.length > 0) && !panelOpen && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setPanelOpen(true)}
        >
          Open container details
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DockerManagement
        profile={profile}
        connected={connected}
        tab={section}
        active={active}
        databases={
          <DockerDatabases
            profile={profile}
            connected={connected}
            active={active && section === "Databases"}
            containers={containers ?? []}
          />
        }
        diagnostics={
          <RemoteInspection
            profile={profile}
            connected={connected}
            tool="Docker"
            active={active && section === "Diagnostics"}
            autoLoad
          />
        }
        onTabChange={setSection}
        onChanged={() =>
          void (async () => {
            let exists = true;
            await load<Container>("list", null, (rows) => {
              setContainers(uniqueContainers(rows));
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
        <div
          className={
            "grid min-w-0 items-start gap-5 " +
            (panelOpen ? "xl:grid-cols-[minmax(0,1fr)_28rem]" : "grid-cols-1")
          }
        >
          <div className="flex min-h-0 min-w-0 flex-col gap-4">
            {containers ? (
              <>
                <div className="grid shrink-0 gap-3 sm:grid-cols-[minmax(12rem,20rem)_minmax(0,1fr)]">
                  <Select
                    value={project}
                    onValueChange={(value) => setProject(value ?? "")}
                    items={[
                      { value: "", label: "All projects" },
                      { value: "@standalone", label: "Standalone containers" },
                      ...groups.map((name) => ({
                        value: name,
                        label:
                          name +
                          " · " +
                          containers.filter((c) => c.project === name).length +
                          " containers",
                      })),
                    ]}
                  >
                    <SelectTrigger
                      aria-label="Container project filter"
                      className="w-full min-w-0 data-[size=default]:h-9"
                    >
                      <SelectValue className="min-w-0 truncate" />
                    </SelectTrigger>
                    <SelectContent
                      align="start"
                      alignItemWithTrigger={false}
                      className="min-w-(--anchor-width) max-w-[calc(100vw-2rem)]"
                    >
                      <SelectItem value="">All projects</SelectItem>
                      <SelectItem value="@standalone">
                        Standalone containers
                      </SelectItem>
                      {groups.map((name) => (
                        <SelectItem
                          key={name}
                          value={name}
                          className="min-h-10 py-2"
                        >
                          <span className="min-w-0 whitespace-normal break-words">
                            {name}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {
                                containers.filter((c) => c.project === name)
                                  .length
                              }{" "}
                              containers
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label="Search containers"
                    className="min-w-0"
                    placeholder="Search containers…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
                  <div
                    role="status"
                    aria-label="Container results"
                    className="space-y-1 text-xs text-muted-foreground"
                  >
                    <p className="font-medium text-foreground">
                      Showing {visible.length} of {containers.length} containers
                    </p>
                    <p>
                      Server totals:{" "}
                      {
                        containers.filter(
                          (c) => stateGroup(c.state) === "running",
                        ).length
                      }{" "}
                      running ·{" "}
                      {
                        containers.filter(
                          (c) => stateGroup(c.state) === "stopped",
                        ).length
                      }{" "}
                      stopped
                      {containers.some((c) => stateGroup(c.state) === "other")
                        ? ` · ${containers.filter((c) => stateGroup(c.state) === "other").length} other`
                        : ""}{" "}
                      · {groups.length} Compose{" "}
                      {groups.length === 1 ? "project" : "projects"}
                    </p>
                  </div>
                  <Select
                    value={stateFilter}
                    onValueChange={(value) => setStateFilter(value ?? "all")}
                    items={[
                      { value: "all", label: "All states" },
                      { value: "running", label: "Running" },
                      { value: "stopped", label: "Stopped" },
                      { value: "other", label: "Other states" },
                    ]}
                  >
                    <SelectTrigger
                      aria-label="Container state filter"
                      className="w-36"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectItem value="all">All states</SelectItem>
                      <SelectItem value="running">Running</SelectItem>
                      <SelectItem value="stopped">Stopped</SelectItem>
                      <SelectItem value="other">Other states</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="overflow-x-auto rounded-xl border">
                  <table className="w-full table-fixed text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-card text-xs text-muted-foreground">
                      <tr>
                        <th className="w-[32%] p-4">Container</th>
                        <th className="w-[18%] p-4">Status</th>
                        <th className="w-[25%] p-4">Image</th>
                        <th className="w-[25%] p-4">Ports</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((c) => {
                        const ports = portLabels(c.ports);
                        const bindings = ports.published.length
                          ? ports.published
                          : ports.internal;
                        return (
                          <tr
                            key={c.id}
                            aria-selected={detail?.id === c.id && panelOpen}
                            className={
                              "border-t hover:bg-muted/30 " +
                              (detail?.id === c.id && panelOpen
                                ? "bg-muted/40"
                                : "")
                            }
                          >
                            <td className="min-w-0 p-4">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-auto max-w-full justify-start p-0 text-left"
                                aria-label={c.name}
                                disabled={busy || !connected}
                                onClick={(event) => {
                                  selectedButton.current = event.currentTarget;
                                  setPanelOpen(true);
                                  setActiveTerminal(
                                    terminals.includes(c.id) ? c.id : null,
                                  );
                                  setDetailTab("Overview");
                                  if (detail?.id !== c.id) {
                                    setStats(null);
                                    setDetail(null);
                                  }
                                  void load<Detail>("details", c.id, (rows) =>
                                    setDetail(rows[0] ?? null),
                                  );
                                }}
                              >
                                <Tooltip content={c.name}>
                                  <span className="block truncate">
                                    {c.name}
                                  </span>
                                </Tooltip>
                              </Button>
                              <p className="mt-1 truncate text-xs text-muted-foreground">
                                {c.project || "Standalone"}
                                {c.service ? ` / ${c.service}` : ""}
                              </p>
                            </td>
                            <td className="p-4">
                              <Tooltip content={c.status || c.state}>
                                <span
                                  className={
                                    "inline-flex rounded-md px-2 py-1 text-xs " +
                                    (c.state === "running"
                                      ? "bg-primary/10 text-primary"
                                      : "bg-muted text-muted-foreground")
                                  }
                                >
                                  {c.state}
                                </span>
                              </Tooltip>
                              {c.status.includes("(healthy)") ? (
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  Healthy
                                </span>
                              ) : c.status.includes("(unhealthy)") ? (
                                <span className="mt-1 block text-xs text-destructive">
                                  Unhealthy
                                </span>
                              ) : null}
                            </td>
                            <td className="p-4">
                              <Tooltip content={c.image}>
                                <span className="block truncate text-xs">
                                  {imageLabel(c.image)}
                                </span>
                              </Tooltip>
                            </td>
                            <td className="p-4">
                              <Tooltip
                                content={c.ports || "No ports configured"}
                              >
                                <span className="block truncate text-xs">
                                  {bindings.slice(0, 2).join(", ") || "None"}
                                  {bindings.length > 2
                                    ? ` +${bindings.length - 2}`
                                    : ""}
                                </span>
                              </Tooltip>
                              {bindings.length > 0 && (
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {ports.published.length
                                    ? "Published on server"
                                    : "Internal only"}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!visible.length && (
                    <div className="space-y-3 p-8 text-center text-sm text-muted-foreground">
                      <p>
                        {containers.length
                          ? "No containers match these filters."
                          : "No containers on this server."}
                      </p>
                      {containers.length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setQuery("");
                            setProject("");
                            setStateFilter("all");
                          }}
                        >
                          Clear filters
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                {!connected
                  ? "Connect to view containers."
                  : busy
                    ? "Loading containers…"
                    : "Could not load containers. Use Refresh containers to try again."}
              </div>
            )}
          </div>
          <aside
            className={
              panelOpen
                ? "relative flex min-w-0 flex-col rounded-xl border bg-card max-xl:overflow-y-auto max-xl:fixed max-xl:inset-x-4 max-xl:top-36 max-xl:bottom-16 max-xl:z-30 max-xl:shadow-2xl"
                : "hidden"
            }
            aria-label="Container inspector"
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                !(event.target as HTMLElement).closest(".xterm")
              ) {
                event.stopPropagation();
                closePanel();
              }
            }}
          >
            {!detail && (
              <div className="space-y-3 p-5">
                <div className="flex items-center justify-between">
                  <p>
                    {busy
                      ? "Loading container…"
                      : "Container details unavailable."}
                  </p>
                  <Button variant="ghost" onClick={closePanel}>
                    Close details
                  </Button>
                </div>
              </div>
            )}
            {detail && (
              <section
                aria-label="Container details"
                className="min-w-0 space-y-5 p-5"
              >
                <div className="flex items-center justify-between">
                  <h3
                    ref={detailHeading}
                    tabIndex={-1}
                    className="min-w-0 truncate font-semibold outline-none"
                  >
                    {detail.name.replace(/^\//, "")}
                  </h3>
                  <Button variant="ghost" onClick={closePanel}>
                    Close details
                  </Button>
                </div>
                <nav
                  aria-label="Container detail views"
                  className="flex gap-2 border-b pb-3"
                >
                  {(["Overview", "Logs", "Terminal"] as const).map((tab) => (
                    <Button
                      key={tab}
                      variant={detailTab === tab ? "secondary" : "ghost"}
                      size="sm"
                      aria-current={detailTab === tab ? "page" : undefined}
                      onClick={() => setDetailTab(tab)}
                    >
                      {tab}
                    </Button>
                  ))}
                </nav>
                <div
                  className={detailTab === "Overview" ? "space-y-5" : "hidden"}
                >
                  <p className="break-all text-xs text-muted-foreground">
                    {detail.id}
                  </p>
                  <dl className="grid grid-cols-2 gap-4 text-sm">
                    {Object.entries({
                      Image: detail.image,
                      Ports:
                        containers?.find((c) => c.id === detail.id)?.ports ||
                        "None",
                      State: detail.status,
                      Health: detail.health,
                      Started: detail.started,
                      Restarts: detail.restarts,
                      "Restart policy": detail.restartPolicy,
                      Network: detail.networkMode,
                      Privileged: detail.privileged ? "Yes" : "No",
                    }).map(([name, value]) => (
                      <div key={name}>
                        <dt className="text-xs text-muted-foreground">
                          {name}
                        </dt>
                        <dd className="break-all">{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={
                        busy || !connected || detail.status !== "running"
                      }
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
                      onClick={() => {
                        setDetailTab("Logs");
                        void reviewLogs();
                      }}
                    >
                      Review live logs
                    </Button>
                    <Button
                      variant="outline"
                      disabled={
                        !connected ||
                        detail.status !== "running" ||
                        (terminals.length >= 4 &&
                          !terminals.includes(detail.id))
                      }
                      onClick={() => {
                        setTerminals((old) =>
                          old.includes(detail.id) ? old : [...old, detail.id],
                        );
                        setActiveTerminal(detail.id);
                        setDetailTab("Terminal");
                      }}
                    >
                      Open container terminal
                    </Button>
                  </div>
                  {stats && (
                    <dl className="grid grid-cols-2 gap-4 text-sm">
                      {Object.entries({
                        CPU: stats.cpu,
                        Memory: stats.memory,
                        "Memory usage": stats.memoryPercent,
                        "Network I/O": stats.network,
                        "Block I/O": stats.disk,
                        PIDs: stats.pids,
                      }).map(([name, value]) => (
                        <div key={name}>
                          <dt className="text-xs text-muted-foreground">
                            {name}
                          </dt>
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
                        .filter(
                          (name): name is string => typeof name === "string",
                        )
                        .map((name) => (
                          <p key={name} className="break-all font-mono text-xs">
                            {name}=••••••
                          </p>
                        ))}
                    </div>
                  </details>
                  <DockerLifecycle id={detail.id} state={detail.status} />
                </div>
                {detailTab === "Logs" && (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Read bounded live output from this container.
                    </p>
                    <Button
                      variant="outline"
                      disabled={busy || !connected || !!stream.current}
                      onClick={() => void reviewLogs()}
                    >
                      Review live logs
                    </Button>
                    {logTarget && logTarget !== detail.id && (
                      <p className="text-xs text-muted-foreground">
                        The current log stream belongs to{" "}
                        {containers?.find((c) => c.id === logTarget)?.name ??
                          logTarget}
                        . Stop it before starting another.
                      </p>
                    )}
                  </div>
                )}
                {detailTab === "Terminal" && (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Open a shell as the container's configured user.
                    </p>
                    <Button
                      variant="outline"
                      disabled={
                        !connected ||
                        detail.status !== "running" ||
                        (terminals.length >= 4 &&
                          !terminals.includes(detail.id))
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
                )}
              </section>
            )}
            <div className={detailTab === "Logs" ? "px-5 pb-5" : "hidden"}>
              {(logs || logState) && (
                <section
                  aria-label="Container live logs"
                  className="space-y-2 rounded-xl border p-3"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs">
                      {containers?.find((c) => c.id === logTarget)?.name ??
                        logTarget}{" "}
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
                      onClick={() =>
                        setPausedLogs(pausedLogs === null ? logs : null)
                      }
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
            </div>
            <div
              className={
                detailTab === "Terminal" ? "min-w-0 px-5 pb-5" : "hidden"
              }
            >
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
                        Shell:{" "}
                        {containers?.find((c) => c.id === id)?.name ??
                          id.slice(0, 12)}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Interactive /bin/sh as the container's configured user.
                    Commands can modify application data.
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
            </div>
          </aside>
        </div>
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
