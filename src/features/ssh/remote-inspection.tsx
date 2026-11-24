import { RefreshCw, Search, Shield, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type ServerProfile, safeError } from "./api";
import { useCommandActivity } from "./command-activity";
import { type CpuSample, cpuUsage } from "./inspection-data";
import { useLiveMetrics } from "./live-metrics";
import { LiveMetricsPanel } from "./live-metrics-view";
import { RemoteActions } from "./remote-actions";
import type { InspectionReport } from "./report-types";
import { type InspectionKind, streamApi } from "./streams";
import {
  ReportSection,
  StructuredReport,
  statusBadge,
} from "./structured-report";

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
  "UFW Firewall": "firewall",
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
  connectionId,
  autoLoad = false,
}: {
  profile: ServerProfile;
  connected: boolean;
  tool: string;
  active: boolean;
  connectionId?: string;
  autoLoad?: boolean;
}) {
  const kind = views[tool] ?? "overview";
  const log = useCommandActivity();
  const liveMetrics = useLiveMetrics();
  const [snapshots, setSnapshots] = useState<
    Partial<Record<InspectionKind, Snapshot>>
  >({});
  const [busy, setBusy] = useState(false);
  const [cpuPercent, setCpuPercent] = useState<number | null>(null);
  const previousCpu = useRef<CpuSample | null>(null);
  const running = useRef(false);
  const stream = useRef<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const automaticallyLoaded = useRef(new Map<InspectionKind, number>());
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
        automaticallyLoaded.current.set(kind, Date.now());
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
          } else if (event.type === "closed") {
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
            automaticallyLoaded.current.set(kind, Date.now());
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
          automaticallyLoaded.current.set(kind, Date.now());
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
    if (!connected) {
      previousCpu.current = null;
      setCpuPercent(null);
    }
  }, [connected]);
  useEffect(() => {
    automaticallyLoaded.current.clear();
    if (connectionId) {
      generation.current++;
      if (stream.current)
        void streamApi.close(profile.id, stream.current).catch(() => {});
      stream.current = null;
      running.current = false;
      setBusy(false);
      setSnapshots({});
    }
  }, [connectionId, profile.id]);
  useEffect(() => {
    if (
      !autoLoad ||
      (!connectionId && kind !== "docker") ||
      !active ||
      !connected ||
      busy ||
      Date.now() - (automaticallyLoaded.current.get(kind) ?? 0) < 30_000
    )
      return;
    automaticallyLoaded.current.set(kind, Date.now());
    void run(true);
  }, [autoLoad, active, connected, connectionId, busy, kind, run]);
  useEffect(() => {
    if (!connected) automaticallyLoaded.current.clear();
  }, [connected]);
  const [serviceFilter, setServiceFilter] = useState("All");
  const snapshot = snapshots[kind];
  const [privileged, setPrivileged] = useState<{
    connectionId?: string;
    report: InspectionReport;
    time: number;
  }>();
  const rulesHeading = useId();
  const [ruleSearch, setRuleSearch] = useState("");
  if (kind === "firewall") {
    const sections = snapshot?.report?.sections ?? [];
    const automatic = sections.find(
      (section) => section.title === "Firewall rules",
    );
    const approved =
      privileged?.connectionId === connectionId
        ? privileged?.report.sections.find(
            (section) =>
              section.title === "Firewall rules" &&
              section.state !== "unavailable",
          )
        : undefined;
    const needsApproval = automatic?.state === "unavailable";
    const rules =
      approved &&
      (needsApproval || (privileged?.time ?? 0) >= (snapshot?.time ?? 0))
        ? approved
        : automatic;
    const message = rules?.message ?? "";
    const state =
      message === "UFW is active."
        ? "Active"
        : message === "UFW is inactive."
          ? "Inactive"
          : message.includes("not installed")
            ? "UFW missing"
            : busy
              ? "Reading firewall…"
              : needsApproval
                ? "Permission needed"
                : connected
                  ? "Status unavailable"
                  : "Disconnected";
    const verified = state === "Active" || state === "Inactive";
    const observedAt = rules === approved ? privileged?.time : snapshot?.time;
    const sshPort = sections.find(
      (section) => section.title === "Active SSH connection",
    )?.rows[0]?.[3];
    const defaults =
      sections.find((section) => section.title === "UFW defaults")?.rows ?? [];
    const rows = rules?.rows ?? [];
    const filtered = rows.filter((row) =>
      row.join(" ").toLowerCase().includes(ruleSearch.trim().toLowerCase()),
    );
    const details = sections.filter(
      (section) =>
        section.title !== "Firewall rules" && section.title !== "UFW defaults",
    );
    return (
      <section
        className="space-y-5"
        aria-label={`${profile.name} ${tool} inspection`}
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">{tool}</h2>
            <div
              className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
              role="status"
            >
              {state === "Active" ? (
                <ShieldCheck className="size-4 text-primary" />
              ) : (
                <Shield className="size-4 text-muted-foreground" />
              )}
              {statusBadge(state)}
              {verified && observedAt && (
                <span className="text-xs text-muted-foreground">
                  Read at {new Date(observedAt).toLocaleTimeString()}
                </span>
              )}
              {!connected && verified && (
                <span className="text-xs text-muted-foreground">
                  Disconnected · last result
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            {needsApproval ? (
              <RemoteActions
                key={connectionId}
                profile={profile}
                connected={connected && !busy}
                tool="Firewall"
                onReport={(report) =>
                  setPrivileged({ connectionId, report, time: Date.now() })
                }
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void run()}
                disabled={busy || !connected}
              >
                <RefreshCw className={busy ? "animate-spin" : ""} />
                Refresh
              </Button>
            )}
          </div>
        </header>
        {(sshPort || defaults.length > 0) && (
          <dl className="flex flex-wrap gap-x-8 gap-y-3 border-y py-3 text-sm">
            {sshPort && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  Current SSH port
                </dt>
                <dd className="mt-0.5 font-medium tabular-nums">{sshPort}</dd>
              </div>
            )}
            {defaults.map(([direction, policy]) => (
              <div key={direction}>
                <dt className="text-xs text-muted-foreground">
                  {direction} by default
                </dt>
                <dd className="mt-0.5 font-medium">
                  {policy === "ACCEPT"
                    ? "Allow"
                    : policy === "DROP"
                      ? "Drop"
                      : policy === "REJECT"
                        ? "Reject"
                        : policy}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <section aria-labelledby={rulesHeading} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id={rulesHeading} className="text-sm font-semibold">
              Rules{" "}
              {rows.length > 0 && (
                <span className="ml-1 font-normal tabular-nums text-muted-foreground">
                  {rows.length}
                  {rules?.truncated ? "+" : ""}
                </span>
              )}
            </h3>
            {rows.length > 0 && (
              <div className="relative w-full sm:w-56">
                <Search
                  className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  className="h-8 pl-8 text-xs"
                  aria-label="Search firewall rules"
                  placeholder="Search port, source or action…"
                  value={ruleSearch}
                  onChange={(event) => setRuleSearch(event.target.value)}
                />
              </div>
            )}
          </div>
          {filtered.length > 0 ? (
            <div className="overflow-x-auto border-y">
              <table
                aria-label="UFW rules in evaluation order"
                className="w-full min-w-[30rem] text-left text-sm"
              >
                <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <tr>
                    {["#", "Action", "Direction", "Destination", "Source"].map(
                      (column) => (
                        <th
                          key={column}
                          scope="col"
                          className="px-3 py-2.5 font-medium"
                        >
                          {column}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map(([number, destination, decision, source]) => {
                    const [action, direction] = (decision || "").split(/\s+/);
                    return (
                      <tr key={number} className="hover:bg-muted/25">
                        <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                          {number}
                        </td>
                        <td className="px-3 py-2.5">
                          {statusBadge(
                            action.charAt(0) + action.slice(1).toLowerCase(),
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {direction === "IN"
                            ? "Incoming"
                            : direction === "OUT"
                              ? "Outgoing"
                              : direction === "FWD"
                                ? "Routed"
                                : direction}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs">
                          {destination}
                        </td>
                        <td className="px-3 py-2.5">{source}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="border-y py-5 text-sm text-muted-foreground">
              {rows.length
                ? "No rules match your search."
                : state === "Active"
                  ? "No rules listed. The default policies apply."
                  : state === "Inactive"
                    ? "UFW is inactive. This read shows active rules only."
                    : state === "UFW missing"
                      ? "UFW was not found on this server."
                      : busy
                        ? "Reading UFW status and rules…"
                        : needsApproval
                          ? "Choose Read UFW status to approve reading the rules with sudo."
                          : connected
                            ? "Could not read UFW rules. Try Refresh."
                            : "Connect to this server to read its firewall."}
            </p>
          )}
          {(rules?.state === "partial" || rules?.truncated) && (
            <p className="text-xs text-muted-foreground">
              Some rules could not be displayed.
            </p>
          )}
        </section>
        {snapshot && (
          <details className="border-b pb-3">
            <summary className="cursor-pointer text-sm font-medium">
              Connection and diagnostics
            </summary>
            <div className="mt-3 space-y-3 text-xs text-muted-foreground">
              <p>
                Provider firewalls are managed separately. Docker-published
                ports can bypass UFW.
              </p>
              {details.map((section) => (
                <div key={section.title}>
                  <h4 className="mb-1 font-medium text-foreground">
                    {section.title}
                  </h4>
                  {section.rows.length > 0 ? (
                    <ul className="space-y-1">
                      {Array.from(
                        new Set(section.rows.map((row) => row.join(" · "))),
                      ).map((row) => (
                        <li key={row}>{row}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>{section.message ?? "No results"}</p>
                  )}
                </div>
              ))}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => log.reveal(snapshot.runId)}
              >
                View command
              </Button>
            </div>
          </details>
        )}
      </section>
    );
  }
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
            {busy
              ? "Inspecting…"
              : autoLoad || snapshot?.report
                ? "Refresh"
                : "Inspect"}
          </Button>
        </div>
      </div>
      {kind === "overview" && (liveMetrics.enabled || liveMetrics.point) && (
        <section aria-label="Live resource charts" className="space-y-3">
          <h3 className="text-sm font-medium">Live resources</h3>
          <p className="text-xs text-muted-foreground">
            {liveMetrics.state}. The inspection below is a separate manual
            snapshot.
          </p>
          <LiveMetricsPanel expanded />
        </section>
      )}
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
      {kind === "network" && (liveMetrics.enabled || liveMetrics.point) && (
        <LiveMetricsPanel networkOnly />
      )}
      {snapshot?.report && kind === "services" ? (
        <div className="space-y-3">
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Filter services</legend>
            {["All", "Running", "Stopped", "Failed"].map((filter) => (
              <Button
                key={filter}
                size="sm"
                variant={filter === serviceFilter ? "default" : "outline"}
                aria-pressed={filter === serviceFilter}
                onClick={() => setServiceFilter(filter)}
              >
                {filter}
              </Button>
            ))}
          </fieldset>
          {snapshot.report.sections
            .filter((section) => section.title === "Service state")
            .map((section) => {
              const boot = snapshot.report?.sections.find(
                (item) => item.title === "Boot enablement",
              );
              const bootByService = new Map(
                boot?.rows.map(([name, state]) => [name, state]),
              );
              const states: Record<string, string> = {
                Running: "active",
                Stopped: "inactive",
                Failed: "failed",
              };
              return (
                <ReportSection
                  key={section.title}
                  section={{
                    ...section,
                    title: "System services",
                    columns: ["Service", "Runtime", "At boot", "Description"],
                    rows: section.rows
                      .filter(
                        (row) =>
                          serviceFilter === "All" ||
                          row[2] === states[serviceFilter],
                      )
                      .map(([name, , state, , description]) => [
                        name,
                        state,
                        bootByService.get(name) ?? "Unavailable",
                        description,
                      ]),
                  }}
                />
              );
            })}
        </div>
      ) : snapshot?.report && kind === "network" ? (
        <>
          {snapshot.report.sections
            .filter((section) => section.title !== "Routes")
            .map((section) => (
              <ReportSection key={section.title} section={section} />
            ))}
          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Routes
            </summary>
            {snapshot.report.sections
              .filter((section) => section.title === "Routes")
              .map((section) => (
                <ReportSection key={section.title} section={section} />
              ))}
          </details>
        </>
      ) : snapshot?.report ? (
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
                ? autoLoad
                  ? "Waiting to read server information."
                  : `Select Inspect to read ${profile.name}.`
                : "Connect to this server to inspect it."}
          </p>
        </div>
      )}
    </section>
  );
}
