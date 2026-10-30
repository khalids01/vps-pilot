import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type IWatermarkPanelProps,
} from "dockview-react";
import {
  Columns2,
  Pencil,
  Plus,
  RotateCcw,
  Rows2,
  ScrollText,
  Terminal,
  Unplug,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SampleServer } from "@/features/workspace/fixtures";
import {
  layoutKey,
  MAX_SAMPLE_SESSIONS,
  readLayout,
  type SessionKind,
  sanitizeLayout,
} from "./layout";
import { SampleTerminalPanel } from "./sample-panel";
import { TerminalView } from "./terminal-view";
import "dockview-react/dist/styles/dockview.css";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

const components = { "sample-terminal": SampleTerminalPanel };
const theme = {
  name: "vps-pilot",
  className: "pilot-terminal-theme",
  colorScheme: "dark" as const,
  gap: 4,
};

function EmptyTerminals(_: IWatermarkPanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Terminal className="size-7 text-primary" aria-hidden="true" />
      <h2 className="text-sm font-medium">No sessions open</h2>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
        Use New shell or Sample logs above to open a session in this VPS
        workspace.
      </p>
    </div>
  );
}

export function TerminalWorkspace({ server }: { server: SampleServer }) {
  const apiRef = useRef<DockviewApi | null>(null);
  const pendingLayout = useRef<string | null>(null);
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [sessionCount, setSessionCount] = useState(0);
  const [activeTitle, setActiveTitle] = useState("");
  const [notice, setNotice] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const renamePanelId = useRef<string | null>(null);

  const addSession = useCallback(
    (
      kind: SessionKind,
      direction?: "right" | "below",
      targetApi = apiRef.current,
    ) => {
      if (!targetApi || targetApi.panels.length >= MAX_SAMPLE_SESSIONS) return;
      if (targetApi.hasMaximizedGroup()) targetApi.exitMaximizedGroup();
      const active = targetApi.activePanel;
      let index = 1;
      const titleFor = (number: number) =>
        kind === "logs"
          ? `Application logs${number > 1 ? ` ${number}` : ""}`
          : `Shell ${number}`;
      while (targetApi.panels.some((panel) => panel.title === titleFor(index)))
        index++;
      const title = titleFor(index);
      targetApi.addPanel({
        id: `${server.id}:${crypto.randomUUID()}`,
        component: "sample-terminal",
        title,
        params: { serverId: server.id, kind },
        renderer: "always",
        minimumWidth: 160,
        minimumHeight: 100,
        position: active
          ? { referencePanel: active.id, direction: direction ?? "within" }
          : undefined,
      });
    },
    [server.id],
  );

  const saveLayout = useCallback(() => {
    if (!pendingLayout.current) return;
    try {
      localStorage.setItem(layoutKey(server.id), pendingLayout.current);
    } catch {
      setNotice(
        "Layout is kept for this session. Local saving is unavailable.",
      );
    }
  }, [server.id]);

  const onReady = useCallback(
    ({ api }: DockviewReadyEvent) => {
      apiRef.current = api;
      const saved = readLayout(server.id);
      if (saved.notice) setNotice(saved.notice);
      let restored = false;
      if (saved.layout) {
        try {
          api.fromJSON(saved.layout);
          restored = true;
        } catch {
          api.clear();
          setNotice(
            "Saved layout could not be restored. A fresh sample workspace was opened.",
          );
        }
      }
      if (!restored) {
        addSession("shell", undefined, api);
        addSession("logs", "right", api);
      }
      setDockApi(api);
    },
    [addSession, server.id],
  );

  useEffect(() => {
    if (!dockApi) return;
    const api = dockApi;
    apiRef.current = api;
    const update = () => {
      setSessionCount(api.panels.length);
      setActiveTitle(api.activePanel?.title ?? "");
    };
    const scheduleSave = () => {
      update();
      if (api.width > 0 && api.height > 0) {
        const layout = sanitizeLayout(api.toJSON(), server.id);
        if (layout) pendingLayout.current = JSON.stringify(layout);
      }
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(saveLayout, 180);
    };
    scheduleSave();
    const subscriptions = [
      api.onDidLayoutChange(scheduleSave),
      api.onDidActivePanelChange(scheduleSave),
    ];
    const flush = () => {
      if (pendingLayout.current) {
        try {
          localStorage.setItem(layoutKey(server.id), pendingLayout.current);
        } catch {
          /* Local storage may be unavailable; in-memory layout still worked. */
        }
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      clearTimeout(saveTimer.current);
      for (const subscription of subscriptions) subscription.dispose();
      window.removeEventListener("pagehide", flush);
      // Flush captured metadata even if Dockview has already been disposed.
      flush();
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [dockApi, saveLayout, server.id]);

  function renameSession() {
    const panel = apiRef.current?.activePanel;
    if (!panel) return;
    renamePanelId.current = panel.id;
    setTitleDraft(panel.title ?? "");
    setRenameOpen(true);
  }

  if (!server.available)
    return (
      <section className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
        <Unplug
          className="mb-4 size-7 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="text-lg font-medium">No terminal session available</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          This disconnected sample has no terminal output. Select Production or
          Staging to explore session layouts.
        </p>
      </section>
    );

  return (
    <TerminalView label={`${server.name} terminal workspace`}>
      <div
        data-terminal-options
        className="flex shrink-0 flex-wrap items-center justify-between gap-3"
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={sessionCount >= MAX_SAMPLE_SESSIONS}
            onClick={() => addSession("shell")}
          >
            <Plus aria-hidden="true" />
            New shell
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={sessionCount >= MAX_SAMPLE_SESSIONS}
            onClick={() => addSession("logs")}
          >
            <ScrollText aria-hidden="true" />
            Sample logs
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!sessionCount || sessionCount >= MAX_SAMPLE_SESSIONS}
            onClick={() => addSession("shell", "right")}
          >
            <Columns2 aria-hidden="true" />
            Split right
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!sessionCount || sessionCount >= MAX_SAMPLE_SESSIONS}
            onClick={() => addSession("shell", "below")}
          >
            <Rows2 aria-hidden="true" />
            Split down
          </Button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setResetOpen(true)}>
          <RotateCcw aria-hidden="true" />
          Reset layout
        </Button>
      </div>
      <div
        data-terminal-options
        className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b pb-3"
      >
        <p className="text-xs text-muted-foreground">
          <span aria-live="polite">
            {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
          </span>{" "}
          · {server.name} · read-only samples
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={sessionCount < 2}
            onClick={() =>
              apiRef.current?.activatePrevious({ includePanel: true })
            }
          >
            Previous session
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={sessionCount < 2}
            onClick={() => apiRef.current?.activateNext({ includePanel: true })}
          >
            Next session
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={!sessionCount}
            aria-label="Rename active session"
            onClick={renameSession}
          >
            <Pencil aria-hidden="true" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={!sessionCount}
            aria-label="Close active sample session"
            onClick={() => apiRef.current?.activePanel?.api.close()}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>
      {notice && (
        <p
          role="status"
          className="rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
        >
          {notice}
        </p>
      )}
      <div
        data-terminal-viewport
        className="relative min-h-64 flex-1 overflow-hidden rounded-lg border bg-background"
      >
        <div className="absolute inset-0">
          <DockviewReact
            className="h-full min-h-64"
            components={components}
            watermarkComponent={EmptyTerminals}
            onReady={onReady}
            theme={theme}
            defaultRenderer="always"
            disableFloatingGroups
            dndStrategy="pointer"
            getTabContextMenuItems={() => [
              "close",
              "closeOthers",
              "separator",
              "maximize",
            ]}
            onWillDrop={(event) => {
              if (event.getData()?.viewId !== apiRef.current?.id)
                event.preventDefault();
            }}
          />
        </div>
      </div>
      <p
        data-terminal-options
        className="shrink-0 text-[11px] leading-relaxed text-muted-foreground"
      >
        {activeTitle ? `Active: ${activeTitle}. ` : ""}Drag tabs to group or
        split. Layouts save on this device; terminal output is never saved. Up
        to {MAX_SAMPLE_SESSIONS} sample sessions per VPS.
      </p>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const panel = apiRef.current?.getPanel(
                renamePanelId.current ?? "",
              );
              if (titleDraft.trim()) panel?.api.setTitle(titleDraft.trim());
              setRenameOpen(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename session</DialogTitle>
              <DialogDescription>
                {server.name} · changes only this sample tab's label.
              </DialogDescription>
            </DialogHeader>
            <label
              htmlFor={`session-name-${server.id}`}
              className="mt-5 mb-5 block text-sm"
            >
              Session name
              <Input
                id={`session-name-${server.id}`}
                className="mt-2"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                maxLength={60}
                required
              />
            </label>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={!titleDraft.trim()}>
                Save name
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset {server.name}'s terminal layout?</DialogTitle>
            <DialogDescription>
              This closes its sample tabs and restores one shell and one log
              pane. Other VPS workspaces are preserved. No server commands run.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              onClick={() => {
                const api = apiRef.current;
                if (!api) return;
                api.clear();
                addSession("shell");
                addSession("logs", "right");
                setNotice("");
                setResetOpen(false);
              }}
            >
              Reset sample layout
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TerminalView>
  );
}
