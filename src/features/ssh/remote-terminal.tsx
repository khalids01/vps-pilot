import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  type DockviewApi,
  DockviewReact,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import { Columns2, Pencil, Plus, Rows2, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
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
import { writePreference } from "@/features/settings/persistence";
import {
  layoutKey,
  readLayout,
  sanitizeLayout,
} from "@/features/terminal/layout";
import { terminalColors } from "@/features/terminal/sample-panel";
import { TerminalView } from "@/features/terminal/terminal-view";
import { type ServerProfile, safeError } from "./api";
import { streamApi } from "./streams";
import "dockview-react/dist/styles/dockview.css";
import "@xterm/xterm/css/xterm.css";
import "@/features/terminal/terminal.css";

const ServerContext = createContext<{
  profile: ServerProfile;
  connected: boolean;
} | null>(null);
function EmptyWorkspace() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      No terminal sessions. Use New shell to open one on this server.
    </div>
  );
}
function SessionTab({ api }: IDockviewPanelHeaderProps) {
  return <span className="px-3 py-2 text-xs">{api.title}</span>;
}
function LivePanel({
  api,
  params,
}: IDockviewPanelProps<{ serverId: string; kind: "shell"; start?: boolean }>) {
  const context = useContext(ServerContext);
  const profile = context?.profile;
  const [requested, setRequested] = useState(params.start === true);
  const host = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("Opening SSH terminal…");
  useEffect(() => {
    if (
      !host.current ||
      !profile ||
      profile.id !== params.serverId ||
      !requested
    )
      return;
    const element = host.current;
    let disposed = false;
    let id: string | null = null;
    let active = false;
    let ended = false;
    const terminal = new Terminal({
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 2000,
      cursorBlink: true,
      screenReaderMode: true,
      theme: terminalColors(element),
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminal.textarea?.setAttribute(
      "aria-label",
      `${profile.name} interactive terminal`,
    );
    const fail = (error: unknown) => {
      if (!disposed) setMessage(safeError(error));
    };
    const resize = () => {
      if (
        disposed ||
        !element.clientWidth ||
        !element.clientHeight ||
        !api.isVisible
      )
        return;
      fit.fit();
      if (id && active)
        void streamApi
          .resize(
            profile.id,
            id,
            Math.min(500, terminal.cols),
            Math.min(300, terminal.rows),
          )
          .catch(fail);
    };
    fit.fit();
    // Defer setup past React's development effect cleanup, so one user action
    // opens exactly one remote shell even with StrictMode enabled.
    void Promise.resolve()
      .then(() => {
        if (disposed) return null;
        return streamApi.terminal(
          profile.id,
          Math.max(2, Math.min(500, terminal.cols)),
          Math.max(1, Math.min(300, terminal.rows)),
          (event) => {
            if (disposed) {
              void streamApi.close(profile.id, event.id).catch(() => {});
              return;
            }
            if (ended) return;
            if (event.type === "data") {
              terminal.write(new Uint8Array(event.data), () => {
                if (!disposed)
                  void streamApi
                    .ack(profile.id, event.id, event.sequence)
                    .catch(fail);
              });
            } else if (event.type === "closed") {
              ended = true;
              active = false;
              setMessage(
                `${event.message}${event.code !== null ? ` Exit ${event.code}.` : ""}`,
              );
              terminal.options.disableStdin = true;
              void streamApi.close(profile.id, event.id).catch(() => {});
            }
          },
        );
      })
      .then((opened) => {
        if (!opened) return;
        id = opened;
        if (disposed) {
          void streamApi.close(profile.id, opened).catch(() => {});
          return;
        }
        if (ended) return;
        active = true;
        setMessage(
          "Connected · normal shell and sudo prompts · output stays in memory",
        );
        resize();
        terminal.focus();
      })
      .catch(fail);
    const encoder = new TextEncoder();
    let inputPending = 0;
    let inputQueue = Promise.resolve();
    const send = (data: Uint8Array) => {
      if (!id || !active || disposed) return;
      if (data.length > 16384 || inputPending >= 16) {
        setMessage(
          "Input limit reached. Paste at most 16 KiB and wait for the server.",
        );
        return;
      }
      inputPending++;
      const session = id;
      inputQueue = inputQueue
        .then(() => {
          if (!disposed && active)
            return streamApi.input(profile.id, session, data);
        })
        .catch(fail)
        .finally(() => inputPending--);
    };
    const input = terminal.onData((data) => send(encoder.encode(data)));
    const binary = terminal.onBinary((data) =>
      send(Uint8Array.from(data, (value) => value.charCodeAt(0))),
    );
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(resize, 80);
    });
    observer.observe(element);
    const visibility = api.onDidVisibilityChange(resize);
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      visibility.dispose();
      input.dispose();
      binary.dispose();
      terminal.dispose();
      if (id) void streamApi.close(profile.id, id).catch(() => {});
    };
  }, [api, profile?.id, profile?.name, profile, params.serverId, requested]);
  if (!requested)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          Restored layout · no SSH session has been started.
        </p>
        <Button
          disabled={!context?.connected}
          onClick={() => setRequested(true)}
        >
          Start shell on {profile?.name}
        </Button>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p
        role="status"
        className="shrink-0 border-b px-3 py-2 text-[11px] text-muted-foreground"
      >
        {profile?.name} · {message}
      </p>
      <div className="min-h-0 flex-1 p-2">
        <div ref={host} className="h-full w-full" />
      </div>
    </div>
  );
}
const components = { terminal: LivePanel };
const tabComponents = { session: SessionTab };
const theme = {
  name: "vps-pilot",
  className: "pilot-terminal-theme",
  colorScheme: "dark" as const,
  gap: 4,
};
export function RemoteTerminal({
  profile,
  connected,
}: {
  profile: ServerProfile;
  connected: boolean;
}) {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [count, setCount] = useState(0);
  const [closing, setClosing] = useState<string | null>(null);
  const sequence = useRef(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!api) return;
    const update = () => {
      setCount(api.panels.length);
      if (api.width <= 0 || api.height <= 0) return;
      const layout = sanitizeLayout(api.toJSON(), profile.id, "remote");
      if (layout) {
        try {
          writePreference(
            layoutKey(profile.id, "remote"),
            JSON.stringify(layout),
          );
        } catch {
          setNotice(
            "Layout saving is unavailable. This workspace remains usable.",
          );
        }
      }
    };
    const listener = api.onDidLayoutChange(update);
    return () => listener.dispose();
  }, [api, profile.id]);
  function add(direction?: "right" | "below") {
    if (!api || !connected || api.panels.length >= 12) return;
    const active = api.activePanel;
    api.addPanel({
      id: `${profile.id}:${crypto.randomUUID()}`,
      title: `Shell ${++sequence.current}`,
      component: "terminal",
      tabComponent: "session",
      params: { serverId: profile.id, kind: "shell", start: true },
      renderer: "always",
      minimumWidth: 160,
      minimumHeight: 100,
      position: active
        ? { referencePanel: active.id, direction: direction ?? "within" }
        : undefined,
    });
    setCount(api.panels.length);
  }
  return (
    <TerminalView label={`${profile.name} live terminals`}>
      <div data-terminal-options className="flex shrink-0 flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!connected || count >= 12}
          onClick={() => add()}
        >
          <Plus />
          New shell
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!connected || count >= 12}
          onClick={() => add("right")}
        >
          <Columns2 />
          Split right
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!connected || count >= 12}
          onClick={() => add("below")}
        >
          <Rows2 />
          Split down
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!count}
          onClick={() => api?.activatePrevious({ includePanel: true })}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!count}
          onClick={() => api?.activateNext({ includePanel: true })}
        >
          Next
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!count}
          onClick={() => {
            const panel = api?.activePanel;
            if (panel) {
              setRenaming(panel.id);
              setDraftTitle(panel.title ?? "");
            }
          }}
        >
          <Pencil />
          Rename
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!count}
          onClick={() => setClosing(api?.activePanel?.id ?? null)}
        >
          <X />
          Close active session
        </Button>
      </div>
      <p data-terminal-options className="text-xs text-muted-foreground">
        {count}/12 sessions · Drag tabs to group or split. Sessions stay open
        across navigation. Reconnecting requires new sessions.
      </p>
      <div
        data-terminal-viewport
        className="relative min-h-[28rem] flex-1 overflow-hidden rounded-lg border"
      >
        <div className="absolute inset-0">
          <ServerContext.Provider value={{ profile, connected }}>
            <DockviewReact
              components={components}
              watermarkComponent={EmptyWorkspace}
              tabComponents={tabComponents}
              onReady={({ api }) => {
                const saved = readLayout(profile.id, "remote");
                if (saved.notice) setNotice(saved.notice);
                if (saved.layout) {
                  try {
                    api.fromJSON(saved.layout);
                  } catch {
                    api.clear();
                    setNotice("Saved layout could not be restored.");
                  }
                }
                setApi(api);
                setCount(api.panels.length);
              }}
              theme={theme}
              defaultRenderer="always"
              disableFloatingGroups
              dndStrategy="pointer"
              getTabContextMenuItems={() => []}
              onWillDrop={(event) => {
                if (event.getData()?.viewId !== api?.id) event.preventDefault();
              }}
            />
          </ServerContext.Provider>
        </div>
      </div>
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming && draftTitle.trim())
                api?.getPanel(renaming)?.api.setTitle(draftTitle.trim());
              setRenaming(null);
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename terminal</DialogTitle>
              <DialogDescription>
                {profile.name} · changes this session's label.
              </DialogDescription>
            </DialogHeader>
            <label
              htmlFor={`rename-${profile.id}`}
              className="mt-4 block text-sm"
            >
              Session name
              <Input
                id={`rename-${profile.id}`}
                className="mt-2 mb-4"
                maxLength={60}
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                required
              />
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenaming(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!draftTitle.trim()}>
                Save name
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close {profile.name} session?</DialogTitle>
            <DialogDescription>
              This ends the selected SSH channel and can interrupt running
              commands. Remote processes may continue; inspect them before
              retrying work.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosing(null)}>
              Keep session
            </Button>
            <Button
              onClick={() => {
                if (closing) api?.getPanel(closing)?.api.close();
                setClosing(null);
              }}
            >
              Close session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TerminalView>
  );
}
