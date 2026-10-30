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
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";

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
}
type Patch = Partial<
  Pick<
    CommandEntry,
    "command" | "output" | "status" | "message" | "code" | "ended"
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
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [background, setBackground] = useState(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const cancels = useRef(new Map<string, () => void>());
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
  const reveal = useCallback((id?: string) => {
    if (id) {
      setSelected(id);
      setBackground(
        entriesRef.current.find((entry) => entry.id === id)?.background ??
          false,
      );
    }
    setExpanded(true);
  }, []);
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
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide command console" : "Show command console"}
            {expanded ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </div>
        <div id={outputId} hidden={!expanded} className="border-t">
          <div className="flex items-center gap-2 px-4 py-2">
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
          <div className="grid max-h-[min(42dvh,22rem)] min-h-36 overflow-y-auto border-t md:grid-cols-[14rem_minmax(0,1fr)]">
            <fieldset
              className="flex min-w-0 max-h-32 flex-col overflow-auto border-b p-2 md:max-h-none md:border-r md:border-b-0"
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
                    <span>
                      <span className="block text-xs">{entry.label}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {entry.status} ·{" "}
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
              <div className="min-w-0 space-y-3 p-4">
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
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Exact command
                  </p>
                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-background/60 p-2 font-mono text-[11px]">
                    {chosen.command || "Preparing command…"}
                  </pre>
                </div>
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Raw output
                  </p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                    {chosen.output ||
                      (chosen.status === "running"
                        ? "Waiting for output…"
                        : "No output returned.")}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </Context.Provider>
  );
}
