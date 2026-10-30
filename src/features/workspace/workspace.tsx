import { DragDropProvider } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Container,
  HardDrive,
  LayoutDashboard,
  Network,
  Package,
  Plug,
  Plus,
  Server,
  Shield,
  SquareTerminal,
  Terminal,
  Workflow,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
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
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { HelperWorkspace } from "@/features/helper/helper-workspace";
import { SettingsPage } from "@/features/settings/settings-page";
import {
  address,
  remoteTabId,
  type ServerProfile,
  safeError,
  sshApi,
  statusQueryKey,
  useConnectionStatuses,
  useServerProfiles,
} from "@/features/ssh/api";
import { ProfileManager } from "@/features/ssh/profile-manager";
import { RemoteWorkspace } from "@/features/ssh/remote-workspace";
import { SidebarFooter } from "@/features/updates/sidebar-footer";
import {
  UpdateManager,
  UpdateSidebarNotice,
} from "@/features/updates/update-control";
import { type SampleServer, sampleServers, type ToolId } from "./fixtures";
import { Overview } from "./overview";
import {
  newServerPreferences,
  type ServerPreferences,
  useWorkspacePreferences,
} from "./preferences";
import { ServerTab } from "./server-tab";
import { Software } from "./software";

const TerminalWorkspace = lazy(() =>
  import("@/features/terminal/terminal-workspace").then((module) => ({
    default: module.TerminalWorkspace,
  })),
);

const tools = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    description: "Your server, at a glance.",
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    description: "Independent shell sessions, grouped tabs, and split panes.",
  },
  {
    id: "software",
    label: "Software",
    icon: Package,
    description:
      "Installed tools, ownership, and conflict checks before changes.",
  },
  {
    id: "docker",
    label: "Docker",
    icon: Container,
    description: "Containers, Compose projects, images, volumes, and logs.",
  },
  {
    id: "proxy",
    label: "Proxy",
    icon: Network,
    description: "Proxy ownership, routing, and configuration.",
  },
  {
    id: "services",
    label: "Services",
    icon: Workflow,
    description: "Service status, startup behavior, and logs.",
  },
  {
    id: "storage",
    label: "Storage",
    icon: HardDrive,
    description: "Disk usage, scans, and cleanup with exact previews.",
  },
  {
    id: "firewall",
    label: "Firewall",
    icon: Shield,
    description: "Firewall rules with protection for active SSH access.",
  },
  {
    id: "helper",
    label: "Server helper",
    icon: Plug,
    description: "Helper installation, updates, and desktop or manual removal.",
  },
] as const;

function SampleStatus({ available }: { available: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${available ? "bg-primary" : "bg-muted-foreground"}`}
      />
      {available ? "Sample data" : "Sample · disconnected"}
    </span>
  );
}

function ToolPlaceholder({
  tool,
  server,
}: {
  tool: (typeof tools)[number];
  server: SampleServer;
}) {
  const Icon = tool.icon;
  return (
    <section className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
      <span className="mb-5 rounded-xl border bg-card p-3 text-primary">
        <Icon className="size-6" aria-hidden="true" />
      </span>
      <h2 className="text-lg font-medium">{tool.label} workspace</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {tool.description}
      </p>
      <p className="mt-5 max-w-md text-xs leading-relaxed text-muted-foreground">
        This screen is reserved for a later increment. No{" "}
        {tool.id === "terminal"
          ? "terminal session is open"
          : "management actions are available"}{" "}
        on {server.name}.
      </p>
    </section>
  );
}

function CommandPanel({
  server,
  expanded,
  onExpandedChange,
}: {
  server: SampleServer;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const outputId = `activity-${server.id}`;
  return (
    <section
      aria-label={`Sample command activity for ${server.name}`}
      className="shrink-0 border-t bg-background/80"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="flex items-center gap-2 font-medium">
            <SquareTerminal
              className="size-4 text-primary"
              aria-hidden="true"
            />
            Command activity
          </span>
          <span className="text-muted-foreground">
            {server.name} · sample output
          </span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          aria-controls={outputId}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? "Hide output" : "Show output"}
          {expanded ? (
            <ChevronDown aria-hidden="true" />
          ) : (
            <ChevronUp aria-hidden="true" />
          )}
        </Button>
      </div>
      <div
        id={outputId}
        hidden={!expanded}
        className="max-h-40 overflow-auto border-t px-4 py-3 sm:px-6"
      >
        {server.activity.length ? (
          <div className="space-y-3 font-mono text-xs leading-relaxed">
            {server.activity.map((entry) => (
              <div key={entry.command}>
                <p className="break-all">
                  <span className="mr-3 text-primary">[sample]</span>
                  <span className="select-all">{entry.command}</span>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words pl-0 text-muted-foreground sm:pl-19">
                  {entry.output}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No activity for this sample server.
          </p>
        )}
      </div>
    </section>
  );
}

function ServerWorkspace({
  server,
  preferences,
  onPreferencesChange,
  onSettings,
  settingsOpen,
}: {
  server: SampleServer;
  preferences: ServerPreferences;
  onPreferencesChange: (patch: Partial<ServerPreferences>) => void;
  onSettings: () => void;
  settingsOpen: boolean;
}) {
  const selectedTool = preferences.tool;
  const [terminalOpened, setTerminalOpened] = useState(
    selectedTool === "terminal",
  );
  function navigateToTool(id: ToolId) {
    if (id === "terminal") setTerminalOpened(true);
    onPreferencesChange({ tool: id });
  }
  const tool = tools.find((item) => item.id === selectedTool) ?? tools[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label={`${server.name} tools`}
          className="flex shrink-0 gap-1 overflow-x-auto border-b bg-sidebar p-2 md:w-48 md:flex-col md:overflow-hidden md:border-r md:border-b-0 md:p-3"
        >
          <div className="flex min-h-0 gap-1 overflow-auto md:flex-1 md:flex-col">
            <p className="hidden px-3 pt-3 pb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground md:block">
              Workspace
            </p>
            {tools.map(({ id, label, icon: Icon }, index) => (
              <div key={id} className={id === "helper" ? "md:pt-5" : ""}>
                {index === 2 && (
                  <p className="mt-4 hidden border-t px-3 pt-4 pb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground md:block">
                    Manage
                  </p>
                )}
                <Button
                  variant="ghost"
                  aria-current={
                    !settingsOpen && selectedTool === id ? "page" : undefined
                  }
                  onClick={() => navigateToTool(id)}
                  className={`h-10 w-full justify-start gap-3 px-3 ${!settingsOpen && selectedTool === id ? "bg-sidebar-accent text-primary hover:bg-sidebar-accent hover:text-primary" : "text-muted-foreground"}`}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </Button>
              </div>
            ))}
            <SidebarFooter
              settingsOpen={settingsOpen}
              onSettings={onSettings}
            />
          </div>
          <UpdateSidebarNotice />
        </nav>
        {settingsOpen && <SettingsPage />}
        <main
          aria-label={`${server.name}: ${tool.label}`}
          className={`${settingsOpen ? "hidden" : ""} min-h-0 min-w-0 flex-1 overflow-y-auto p-5 sm:p-8`}
        >
          <div
            className={`mx-auto w-full max-w-6xl ${selectedTool === "terminal" ? "flex min-h-full flex-col" : ""}`}
          >
            <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.16em] text-primary">
                  {server.name} / {tool.label}
                </p>
                <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">
                  {selectedTool === "overview"
                    ? "Your server, at a glance."
                    : tool.label}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {selectedTool === "overview"
                    ? server.description
                    : tool.description}
                </p>
              </div>
              <span className="rounded-lg border bg-card px-3 py-2">
                <SampleStatus available={server.available} />
              </span>
            </div>
            {selectedTool === "overview" ? (
              <Overview
                server={server}
                helperScenario={preferences.helperScenario}
                onNavigate={navigateToTool}
              />
            ) : selectedTool === "software" ? (
              <Software
                server={server}
                category={preferences.softwareCategory}
                onCategoryChange={(softwareCategory) =>
                  onPreferencesChange({ softwareCategory })
                }
              />
            ) : selectedTool === "helper" ? (
              <HelperWorkspace
                server={server}
                scenario={preferences.helperScenario}
                onScenarioChange={(helperScenario) =>
                  onPreferencesChange({ helperScenario })
                }
              />
            ) : selectedTool !== "terminal" ? (
              <ToolPlaceholder tool={tool} server={server} />
            ) : null}
            {terminalOpened && (
              <div
                className={
                  selectedTool === "terminal"
                    ? "flex min-h-96 flex-1 flex-col"
                    : "hidden"
                }
              >
                <Suspense
                  fallback={
                    <p role="status" className="text-sm text-muted-foreground">
                      Loading terminal workspace…
                    </p>
                  }
                >
                  <TerminalWorkspace server={server} />
                </Suspense>
              </div>
            )}
          </div>
        </main>
      </div>
      <CommandPanel
        server={server}
        expanded={preferences.commandExpanded}
        onExpandedChange={(commandExpanded) =>
          onPreferencesChange({ commandExpanded })
        }
      />
      <footer className="flex shrink-0 flex-wrap justify-between gap-x-6 gap-y-1 border-t bg-sidebar px-4 py-2 text-[11px] text-muted-foreground">
        <span className="break-all">
          {server.name} · {server.address}
        </span>
        <span>No SSH connection · sample workspace</span>
      </footer>
    </div>
  );
}

export function Workspace() {
  const { preferences, setPreferences, notice } = useWorkspacePreferences();
  const { openServerIds, activeServerId } = preferences;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState("");
  const [closing, setClosing] = useState(false);
  const profiles = useServerProfiles();
  const statuses = useConnectionStatuses(Boolean(profiles.data?.length));
  const queryClient = useQueryClient();
  const tabInfo = (id: string) => {
    const sample = sampleServers.find((server) => server.id === id);
    if (sample) return sample;
    const profile = profiles.data?.find(
      (profile) => remoteTabId(profile.id) === id,
    );
    return profile
      ? {
          id,
          name: profile.name,
          detail: address(profile),
          connectionStatus: statuses.data?.find(
            (status) => status.profileId === profile.id,
          )?.status,
        }
      : { id, name: "Saved server" };
  };
  function openRemote(profile: ServerProfile) {
    const id = remoteTabId(profile.id);
    setPreferences((current) => ({
      ...current,
      openServerIds: current.openServerIds.includes(id)
        ? current.openServerIds
        : [...current.openServerIds, id],
      activeServerId: id,
      servers: {
        ...current.servers,
        [id]: current.servers[id] ?? newServerPreferences(),
      },
    }));
  }
  function requestClose(id: string) {
    if (id.startsWith("remote:")) {
      setCloseError("");
      setClosingId(id);
    } else closeServer(id);
  }
  const closedServers = sampleServers.filter(
    (server) => !openServerIds.includes(server.id),
  );

  function closeServer(serverId: string) {
    // Real tabs reach this point after disconnect or a successful native delete.
    // Use current state because the native operation may have completed later.
    setPreferences((current) => {
      const index = current.openServerIds.indexOf(serverId);
      const remaining = current.openServerIds.filter((id) => id !== serverId);
      return {
        ...current,
        openServerIds: remaining,
        activeServerId:
          current.activeServerId === serverId
            ? (remaining[Math.min(index, remaining.length - 1)] ?? null)
            : current.activeServerId,
      };
    });
    requestAnimationFrame(() => {
      const target =
        document.querySelector<HTMLElement>(
          '[data-slot="tabs-trigger"][aria-selected="true"]',
        ) ?? document.getElementById("new-vps-tab");
      target?.focus();
    });
  }

  function openSample(serverId: string) {
    setPreferences((current) => ({
      ...current,
      openServerIds: current.openServerIds.includes(serverId)
        ? current.openServerIds
        : [...current.openServerIds, serverId],
      activeServerId: serverId,
    }));
    setManagerOpen(false);
    requestAnimationFrame(() =>
      document.getElementById(`tab-${serverId}`)?.focus(),
    );
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <UpdateManager />
      {notice && (
        <p
          role="status"
          className="border-b bg-muted/40 px-5 py-2 text-xs text-muted-foreground"
        >
          {notice}
        </p>
      )}
      <Tabs
        value={activeServerId}
        onValueChange={(value) => {
          if (typeof value === "string" && openServerIds.includes(value)) {
            setSettingsOpen(false);
            setPreferences((current) => ({
              ...current,
              activeServerId: value,
            }));
          }
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 items-end gap-2 border-b bg-sidebar px-3 pt-2">
          <div className="mb-2 mr-2 flex shrink-0 items-center gap-2 px-2 text-primary">
            <img
              src="/app-icon.png"
              alt=""
              className="size-5"
              width={20}
              height={20}
            />
            <span className="hidden text-xs font-semibold tracking-wide sm:inline">
              VPS PILOT
            </span>
          </div>
          <div className="min-w-0 flex-1 overflow-x-auto">
            <DragDropProvider
              onDragEnd={(event) => {
                const source = event.operation.source;
                if (
                  event.canceled ||
                  !isSortable(source) ||
                  source.group !== "vps-tabs" ||
                  source.index === source.initialIndex
                )
                  return;
                const sourceId = String(source.id);
                const targetIndex = source.index;
                setPreferences((current) => {
                  const order = [...current.openServerIds];
                  const from = order.indexOf(sourceId);
                  if (
                    from < 0 ||
                    targetIndex < 0 ||
                    targetIndex >= order.length
                  )
                    return current;
                  const [id] = order.splice(from, 1);
                  order.splice(targetIndex, 0, id);
                  return { ...current, openServerIds: order };
                });
              }}
            >
              <TabsList
                aria-label="VPS workspaces"
                activateOnFocus
                className="w-max"
              >
                {openServerIds.map((id, index) => {
                  const server = tabInfo(id);
                  return (
                    <ServerTab
                      key={id}
                      server={server}
                      index={index}
                      onClose={() => requestClose(id)}
                    />
                  );
                })}
              </TabsList>
            </DragDropProvider>
            <p id="server-reorder-help" className="sr-only">
              Drag the handle to reorder VPS tabs. With the handle focused,
              press Space, use arrow keys, then Space to drop or Escape to
              cancel.
            </p>
          </div>
          <Button
            id="new-vps-tab"
            variant="ghost"
            size="icon"
            className="mb-1 shrink-0"
            aria-label="New VPS tab"
            onClick={() => setManagerOpen(true)}
          >
            <Plus aria-hidden="true" />
          </Button>
        </div>
        {openServerIds.map((id) => {
          const server = sampleServers.find((item) => item.id === id);
          const profile = profiles.data?.find(
            (profile) => remoteTabId(profile.id) === id,
          );
          if (!server)
            return (
              <TabsContent
                key={id}
                value={id}
                keepMounted
                className="flex flex-1 flex-col data-hidden:hidden"
              >
                {profile ? (
                  <RemoteWorkspace
                    key={profile.revision}
                    profile={profile}
                    onSettings={() => setSettingsOpen(true)}
                    settingsOpen={settingsOpen}
                    active={!settingsOpen && activeServerId === id}
                    selectedTool={preferences.servers[id]?.tool ?? "overview"}
                    onSelectTool={(tool) => {
                      setSettingsOpen(false);
                      setPreferences((current) => ({
                        ...current,
                        servers: {
                          ...current.servers,
                          [id]: {
                            ...(current.servers[id] ?? newServerPreferences()),
                            tool,
                          },
                        },
                      }));
                    }}
                    status={statuses.data?.find(
                      (status) => status.profileId === profile.id,
                    )}
                  />
                ) : (
                  <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                    <h1 className="text-xl font-medium">
                      Saved server unavailable
                    </h1>
                    <p className="text-sm text-muted-foreground">
                      {profiles.isFetching
                        ? "Loading profile metadata…"
                        : "Use the plus button in the desktop app to choose a connection. No connection has been started."}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => setManagerOpen(true)}
                    >
                      Choose a connection
                    </Button>
                  </main>
                )}
              </TabsContent>
            );
          return server ? (
            <TabsContent
              key={id}
              value={id}
              keepMounted
              className="flex flex-1 flex-col data-hidden:hidden"
            >
              <ServerWorkspace
                server={server}
                onSettings={() => setSettingsOpen(true)}
                settingsOpen={settingsOpen}
                preferences={preferences.servers[server.id]}
                onPreferencesChange={(patch) => {
                  if (patch.tool) setSettingsOpen(false);
                  setPreferences((current) => ({
                    ...current,
                    servers: {
                      ...current.servers,
                      [server.id]: { ...current.servers[server.id], ...patch },
                    },
                  }));
                }}
              />
            </TabsContent>
          ) : null;
        })}
        {!openServerIds.length && (
          <div className="flex min-h-0 flex-1">
            <nav
              aria-label="Application navigation"
              className="flex w-48 shrink-0 flex-col border-r bg-sidebar p-3"
            >
              <SidebarFooter
                settingsOpen={settingsOpen}
                onSettings={() => setSettingsOpen(true)}
              />
              <div className="mt-auto">
                <UpdateSidebarNotice />
              </div>
            </nav>
            {settingsOpen ? (
              <SettingsPage />
            ) : (
              <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
                <Server className="size-8 text-primary" aria-hidden="true" />
                <h1 className="text-2xl font-medium">
                  Your workspace starts here
                </h1>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Choose a saved connection or add a new server to open a VPS
                  workspace.
                </p>
                <Button onClick={() => setManagerOpen(true)}>
                  <Plus aria-hidden="true" />
                  Choose a connection
                </Button>
              </main>
            )}
          </div>
        )}
      </Tabs>
      <ProfileManager
        samples={closedServers}
        onOpenSample={openSample}
        open={managerOpen}
        onOpenChange={setManagerOpen}
        onOpenServer={openRemote}
        onDeleteServer={(profile) => {
          const id = remoteTabId(profile.id);
          closeServer(id);
          setPreferences((current) => {
            const servers = { ...current.servers };
            delete servers[id];
            return { ...current, servers };
          });
        }}
      />
      <Dialog
        open={closingId !== null}
        onOpenChange={(open) => {
          if (!open && !closing) setClosingId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Disconnect and close{" "}
              {closingId ? tabInfo(closingId).name : "server"}?
            </DialogTitle>
            <DialogDescription>
              This ends any active SSH connection or pending attempt for this
              VPS. Its saved profile is kept. Other server connections are
              preserved.
            </DialogDescription>
          </DialogHeader>
          {closeError && (
            <p role="alert" className="text-sm text-destructive">
              {closeError}
            </p>
          )}
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" disabled={closing} />}
            >
              Cancel
            </DialogClose>
            <Button
              disabled={closing}
              onClick={async () => {
                if (!closingId) return;
                setClosing(true);
                setCloseError("");
                try {
                  await sshApi.disconnect(closingId.slice(7));
                  closeServer(closingId);
                  setClosingId(null);
                  await queryClient.invalidateQueries({
                    queryKey: statusQueryKey,
                  });
                } catch (error) {
                  setCloseError(safeError(error));
                } finally {
                  setClosing(false);
                }
              }}
            >
              Disconnect and close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
