import {
  ChevronDown,
  ChevronUp,
  Clock3,
  Square,
  SquareTerminal,
} from "lucide-react";
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
  commandConsoleMaxHeight,
  commandConsoleMinHeight,
  readCommandConsolePreference,
  writeCommandConsolePreference,
} from "./command-console-preferences";

export type CommandSummaryState = "ready" | "partial" | "unavailable";
export interface CommandSummaryItem {
  title: string;
  state: CommandSummaryState;
}
export interface CommandEntry {
  id: string;
  label: string;
  command: string;
  output: string;
  status: "running" | "completed" | "failed" | "cancelled";
  message: string;
  code: number | null;
  started: number;
  ended: number | null;
  background: boolean;
  group?: string;
  summary?: CommandSummaryItem[];
}
type Patch = Partial<
  Pick<
    CommandEntry,
    "command" | "output" | "status" | "message" | "code" | "ended" | "summary"
  >
>;
interface ActivityApi {
  begin: (
    label: string,
    command: string,
    options?: { background?: boolean; group?: string; cancel?: () => void },
  ) => string;
  update: (id: string, patch: Patch) => void;
  reveal: (id?: string) => void;
}
const Context = createContext<ActivityApi | null>(null);
const summaryLabels: Record<CommandSummaryState, string> = {
  ready: "Collected",
  partial: "Incomplete",
  unavailable: "Unavailable",
};
export function useCommandActivity() {
  const value = useContext(Context);
  if (!value) throw new Error("Command activity requires a server workspace.");
  return value;
}
// Only allowlisted in-memory command metadata/output enters this log. Credentials,
// terminal input and terminal buffers are never passed to or persisted by it.
export function CommandActivityProvider({
  serverId,
  serverName,
  children,
}: {
  serverId: string;
  serverName: string;
  children: ReactNode;
}) {
  const [entries, setEntries] = useState<CommandEntry[]>([]);
  const [initialPreference] = useState(() =>
    readCommandConsolePreference(serverId),
  );
  const [expanded, setExpanded] = useState(initialPreference.expanded);
  const [preferredHeight, setPreferredHeight] = useState(
    initialPreference.height,
  );
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? 900 : window.innerHeight,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [background, setBackground] = useState(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const cancels = useRef(new Map<string, () => void>());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const heightRef = useRef(preferredHeight);
  heightRef.current = preferredHeight;
  const loadedServer = useRef(serverId);
  const separatorRef = useRef<HTMLHRElement>(null);
  const pointerId = useRef<number | null>(null);
  const drag = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const persist = useCallback(
    (patch: { expanded?: boolean; height?: number }) => {
      writeCommandConsolePreference(serverId, {
        version: 1,
        expanded: expandedRef.current,
        height: heightRef.current,
        ...patch,
      });
    },
    [serverId],
  );
  useEffect(() => {
    const updateViewport = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);
  useEffect(() => {
    if (loadedServer.current === serverId) return;
    loadedServer.current = serverId;
    const preference = readCommandConsolePreference(serverId);
    expandedRef.current = preference.expanded;
    heightRef.current = preference.height;
    setExpanded(preference.expanded);
    setPreferredHeight(preference.height);
  }, [serverId]);
  useEffect(
    () => () => {
      const separator = separatorRef.current;
      const id = pointerId.current;
      if (separator && id !== null && separator.hasPointerCapture(id))
        separator.releasePointerCapture(id);
      pointerId.current = null;
      drag.current = null;
    },
    [],
  );
  const begin = useCallback<ActivityApi["begin"]>((label, command, options) => {
    const id = crypto.randomUUID();
    if (options?.cancel) cancels.current.set(id, options.cancel);
    setEntries((old) => {
      const next = old.filter(
        (entry) =>
          !options?.group ||
          entry.group !== options.group ||
          entry.status === "running",
      );
      const completed = next.filter((entry) => entry.status !== "running");
      const keep = new Set(completed.slice(-17).map((entry) => entry.id));
      const bounded = next.filter(
        (entry) => entry.status === "running" || keep.has(entry.id),
      );
      return [
        ...bounded,
        {
          id,
          label,
          command,
          output: "",
          status: "running",
          message: "Running",
          code: null,
          started: Date.now(),
          ended: null,
          background: options?.background ?? false,
          group: options?.group,
        },
      ];
    });
    if (!options?.background) {
      setSelected(id);
      setBackground(false);
    }
    return id;
  }, []);
  const update = useCallback((id: string, patch: Patch) => {
    if (patch.status && patch.status !== "running") cancels.current.delete(id);
    setEntries((old) =>
      old.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              ...patch,
              output:
                patch.output === undefined
                  ? entry.output
                  : patch.output.slice(-32768),
            }
          : entry,
      ),
    );
  }, []);
  const reveal = useCallback(
    (id?: string) => {
      if (id) {
        setSelected(id);
        setBackground(
          entriesRef.current.find((entry) => entry.id === id)?.background ??
            false,
        );
      }
      expandedRef.current = true;
      setExpanded(true);
      persist({ expanded: true });
    },
    [persist],
  );
  const api = useMemo(
    () => ({ begin, update, reveal }),
    [begin, update, reveal],
  );
  const visible = entries.filter((entry) => entry.background === background);
  const chosen =
    visible.find((entry) => entry.id === selected) ??
    visible[visible.length - 1];
  const latest = entries[entries.length - 1];
  const running = entries.filter((entry) => entry.status === "running").length;
  const outputId = `command-console-${serverId}`;
  const availableHeight = Math.min(
    commandConsoleMaxHeight,
    Math.max(96, Math.floor(viewportHeight * 0.6)),
  );
  const runtimeMin = Math.min(commandConsoleMinHeight, availableHeight);
  const visibleHeight = Math.min(
    Math.max(preferredHeight, runtimeMin),
    availableHeight,
  );
  const previewHeight = (value: number) => {
    const interaction = Math.min(
      availableHeight,
      Math.max(runtimeMin, Math.round(value)),
    );
    const next = Math.min(
      commandConsoleMaxHeight,
      Math.max(commandConsoleMinHeight, interaction),
    );
    heightRef.current = next;
    setPreferredHeight(next);
  };
  const commitHeight = () => persist({ height: heightRef.current });
  const toggleExpanded = () => {
    const next = !expandedRef.current;
    expandedRef.current = next;
    setExpanded(next);
    persist({ expanded: next });
  };
  return (
    <Context.Provider value={api}>
      {children}
      <section
        aria-label={`${serverName} command console`}
        className="shrink-0 border-t bg-sidebar"
      >
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-4 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="flex items-center gap-2 font-medium">
              <SquareTerminal className="size-4 text-primary" />
              Command console
            </span>
            <span className="text-muted-foreground">{serverName}</span>
            <span
              role="status"
              className={
                latest?.status === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground"
              }
            >
              {running
                ? `${running} running`
                : latest
                  ? `${latest.label} · ${latest.status}`
                  : "No commands yet"}
            </span>
          </div>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            aria-controls={outputId}
            onClick={toggleExpanded}
          >
            {expanded ? "Hide command console" : "Show command console"}
            {expanded ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </div>
        <div
          id={outputId}
          hidden={!expanded}
          className="flex flex-col border-t"
          style={{ height: `${visibleHeight}px` }}
        >
          <hr
            ref={separatorRef}
            aria-label="Resize command console"
            aria-orientation="horizontal"
            aria-valuenow={visibleHeight}
            aria-valuemin={runtimeMin}
            aria-valuemax={availableHeight}
            tabIndex={0}
            className="m-0 h-2 shrink-0 cursor-row-resize touch-none border-0 border-b bg-border outline-none focus-visible:ring-2 focus-visible:ring-ring/50 hover:bg-primary focus-visible:bg-primary"
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              pointerId.current = event.pointerId;
              drag.current = {
                pointerId: event.pointerId,
                startY: event.clientY,
                startHeight: visibleHeight,
              };
            }}
            onPointerMove={(event) => {
              const current = drag.current;
              if (!current || current.pointerId !== event.pointerId) return;
              previewHeight(
                current.startHeight + current.startY - event.clientY,
              );
            }}
            onPointerUp={(event) => {
              const current = drag.current;
              if (!current || current.pointerId !== event.pointerId) return;
              drag.current = null;
              pointerId.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
              commitHeight();
            }}
            onPointerCancel={(event) => {
              const current = drag.current;
              if (!current || current.pointerId !== event.pointerId) return;
              drag.current = null;
              pointerId.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
              persist({ height: heightRef.current });
            }}
            onKeyDown={(event) => {
              let next: number | undefined;
              if (event.key === "ArrowUp") next = visibleHeight + 24;
              else if (event.key === "ArrowDown") next = visibleHeight - 24;
              else if (event.key === "Home") next = runtimeMin;
              else if (event.key === "End") next = availableHeight;
              if (next === undefined) return;
              event.preventDefault();
              previewHeight(next);
              persist({ height: heightRef.current });
            }}
          />
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
            <Button
              size="xs"
              variant={background ? "ghost" : "secondary"}
              aria-pressed={!background}
              onClick={() => setBackground(false)}
            >
              Actions ({entries.filter((entry) => !entry.background).length})
            </Button>
            <Button
              size="xs"
              variant={background ? "secondary" : "ghost"}
              aria-pressed={background}
              onClick={() => setBackground(true)}
            >
              Monitoring ({entries.filter((entry) => entry.background).length})
            </Button>
            <span className="ml-auto hidden text-[10px] text-muted-foreground sm:inline">
              Session history · output stays in memory
            </span>
          </div>
          <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-t md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <fieldset
              className="flex max-h-32 min-h-0 min-w-0 flex-col overflow-auto border-b p-2 md:max-h-none md:border-r md:border-b-0"
              aria-label="Recent commands"
            >
              {visible.length ? (
                [...visible].reverse().map((entry) => (
                  <Button
                    key={entry.id}
                    size="sm"
                    variant={chosen?.id === entry.id ? "secondary" : "ghost"}
                    className="h-auto shrink-0 justify-start whitespace-normal py-2 text-left"
                    onClick={() => setSelected(entry.id)}
                  >
                    <span className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
                      <span className="truncate text-xs" title={entry.label}>
                        {entry.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {entry.status}
                      </span>
                      <span className="text-[10px] whitespace-nowrap text-muted-foreground">
                        {new Date(entry.started).toLocaleTimeString()}
                      </span>
                    </span>
                  </Button>
                ))
              ) : (
                <p className="p-3 text-xs text-muted-foreground">
                  {background
                    ? "No monitoring runs yet."
                    : "No app commands yet. Terminal input stays in its own session."}
                </p>
              )}
            </fieldset>
            {chosen && (
              <div className="min-h-0 min-w-0 space-y-3 overflow-y-auto p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium">
                    {chosen.label} · {serverName}
                  </p>
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock3 className="size-3" />
                      {chosen.ended === null
                        ? "Running"
                        : `${((chosen.ended - chosen.started) / 1000).toFixed(1)}s`}
                    </span>
                    <span>
                      {chosen.code === null
                        ? chosen.status
                        : `Exit ${chosen.code}`}
                    </span>
                    {chosen.status === "running" && (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => cancels.current.get(chosen.id)?.()}
                      >
                        <Square />
                        Cancel command
                      </Button>
                    )}
                  </div>
                </div>
                <p role="status" className="text-xs text-muted-foreground">
                  {chosen.message}
                </p>
                {chosen.summary?.length ? (
                  <ul
                    aria-label="Inspection evidence"
                    className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2"
                  >
                    {chosen.summary.map((item) => (
                      <li
                        key={`${item.title}-${item.state}`}
                        className="flex min-w-0 items-center justify-between gap-2"
                      >
                        <span className="truncate">{item.title}</span>
                        <span
                          className={`whitespace-nowrap ${
                            item.state === "ready"
                              ? "text-success"
                              : item.state === "partial"
                                ? "text-warning"
                                : "text-info"
                          }`}
                        >
                          {summaryLabels[item.state]}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <details
                  key={chosen.id}
                  className="rounded-md border bg-background/40"
                >
                  <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted-foreground">
                    Technical details
                  </summary>
                  <div className="space-y-3 border-t p-2">
                    <div>
                      <p className="mb-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                        Exact command
                      </p>
                      <pre className="max-h-24 overflow-auto rounded-md border bg-background/60 p-2 font-mono text-[11px] break-all whitespace-pre-wrap select-text">
                        {chosen.command || "Preparing command…"}
                      </pre>
                    </div>
                    <div>
                      <p className="mb-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                        Raw output
                      </p>
                      <pre className="max-h-48 overflow-auto font-mono text-[11px] break-all whitespace-pre-wrap select-text">
                        {chosen.output ||
                          (chosen.status === "running"
                            ? "Waiting for output…"
                            : "No output returned.")}
                      </pre>
                    </div>
                  </div>
                </details>
              </div>
            )}
          </div>
        </div>
      </section>
    </Context.Provider>
  );
}
