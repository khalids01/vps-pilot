import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Container,
  HardDrive,
  LayoutDashboard,
  Network,
  Package,
  PanelsTopLeft,
  Plug,
  Plus,
  Server,
  Shield,
  SquareTerminal,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type SampleServer, sampleServers, type ToolId } from "./fixtures";
import { Overview } from "./overview";

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

function CommandPanel({ server }: { server: SampleServer }) {
  const [expanded, setExpanded] = useState(true);
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
          onClick={() => setExpanded(!expanded)}
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

function ServerWorkspace({ server }: { server: SampleServer }) {
  const [selectedTool, setSelectedTool] = useState<ToolId>("overview");
  const tool = tools.find((item) => item.id === selectedTool) ?? tools[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label={`${server.name} tools`}
          className="flex shrink-0 gap-1 overflow-x-auto border-b bg-sidebar p-2 md:w-48 md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-3"
        >
          <p className="hidden px-3 pt-3 pb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground md:block">
            Workspace
          </p>
          {tools.map(({ id, label, icon: Icon }, index) => (
            <div
              key={id}
              className={id === "helper" ? "md:mt-auto md:pt-5" : ""}
            >
              {index === 2 && (
                <p className="mt-4 hidden border-t px-3 pt-4 pb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground md:block">
                  Manage
                </p>
              )}
              <Button
                variant="ghost"
                aria-current={selectedTool === id ? "page" : undefined}
                onClick={() => setSelectedTool(id)}
                className={`h-10 w-full justify-start gap-3 px-3 ${selectedTool === id ? "bg-sidebar-accent text-primary hover:bg-sidebar-accent hover:text-primary" : "text-muted-foreground"}`}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Button>
            </div>
          ))}
        </nav>
        <main
          aria-label={`${server.name}: ${tool.label}`}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5 sm:p-8"
        >
          <div className="mx-auto w-full max-w-6xl">
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
              <Overview server={server} onNavigate={setSelectedTool} />
            ) : (
              <ToolPlaceholder tool={tool} server={server} />
            )}
          </div>
        </main>
      </div>
      <CommandPanel server={server} />
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
  const [openServerIds, setOpenServerIds] = useState(
    sampleServers.map((server) => server.id),
  );
  const [activeServerId, setActiveServerId] = useState<string | null>(
    sampleServers[0].id,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const closedServers = sampleServers.filter(
    (server) => !openServerIds.includes(server.id),
  );

  function closeServer(serverId: string) {
    const index = openServerIds.indexOf(serverId);
    const remaining = openServerIds.filter((id) => id !== serverId);
    const nextId =
      activeServerId === serverId
        ? (remaining[Math.min(index, remaining.length - 1)] ?? null)
        : activeServerId;
    setOpenServerIds(remaining);
    setActiveServerId(nextId);
    // Closing is safe here: fixtures have no live connection or running session.
    requestAnimationFrame(() =>
      document
        .getElementById(nextId ? `tab-${nextId}` : "add-sample-server")
        ?.focus(),
    );
  }

  function openSample(serverId: string) {
    setOpenServerIds((ids) => [...ids, serverId]);
    setActiveServerId(serverId);
    setPickerOpen(false);
    requestAnimationFrame(() =>
      document.getElementById(`tab-${serverId}`)?.focus(),
    );
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-sidebar/80 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="rounded-lg border bg-primary/10 p-2 text-primary">
            <PanelsTopLeft className="size-4" aria-hidden="true" />
          </span>
          <span className="text-sm font-semibold tracking-wide">VPS PILOT</span>
        </div>
        <span className="text-xs text-muted-foreground">
          Your server workspace
        </span>
      </header>
      <div className="flex shrink-0 items-center gap-2 border-b bg-primary/5 px-5 py-2 text-xs text-muted-foreground">
        <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
          UI preview
        </span>
        <span>
          Fictional servers and sample data. No connections or commands run.
        </span>
      </div>
      <Tabs
        value={activeServerId}
        onValueChange={(value) => {
          if (typeof value === "string" && openServerIds.includes(value))
            setActiveServerId(value);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 items-end gap-2 border-b bg-sidebar px-3 pt-2">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <TabsList
              aria-label="Sample VPS workspaces"
              activateOnFocus
              className="w-max"
            >
              {openServerIds.map((id) => {
                const server = sampleServers.find((item) => item.id === id);
                if (!server) return null;
                return (
                  <div key={server.id} className="relative">
                    <TabsTrigger
                      id={`tab-${server.id}`}
                      value={server.id}
                      className="pr-10"
                    >
                      <Server className="size-3.5" aria-hidden="true" />
                      {server.name}
                    </TabsTrigger>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Close ${server.name} sample tab`}
                      className="absolute top-2 right-1.5 text-muted-foreground"
                      onClick={() => closeServer(server.id)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                );
              })}
            </TabsList>
          </div>
          <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
            <DialogTrigger
              id="add-sample-server"
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="mb-1"
                  aria-label="Open sample server"
                />
              }
            >
              <Plus aria-hidden="true" />
            </DialogTrigger>
            <DialogContent
              finalFocus={() =>
                document.getElementById(
                  activeServerId
                    ? `tab-${activeServerId}`
                    : "add-sample-server",
                )
              }
            >
              <DialogHeader>
                <DialogTitle>Open a sample server</DialogTitle>
                <DialogDescription>
                  Explore the layout with fictional profiles. Real server setup
                  will be added with SSH connections.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                {closedServers.length ? (
                  closedServers.map((server) => (
                    <Button
                      key={server.id}
                      variant="outline"
                      className="h-auto w-full justify-between gap-3 py-3"
                      onClick={() => openSample(server.id)}
                    >
                      <span className="text-left">
                        <span className="block">{server.name}</span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {server.address}
                        </span>
                      </span>
                      <ArrowRight aria-hidden="true" />
                    </Button>
                  ))
                ) : (
                  <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
                    All three sample servers are open. Close a tab to reopen it
                    here.
                  </p>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>
        {openServerIds.map((id) => {
          const server = sampleServers.find((item) => item.id === id);
          return server ? (
            <TabsContent
              key={id}
              value={id}
              keepMounted
              className="flex flex-1 flex-col data-hidden:hidden"
            >
              <ServerWorkspace server={server} />
            </TabsContent>
          ) : null;
        })}
        {!openServerIds.length && (
          <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <Server className="size-8 text-primary" aria-hidden="true" />
            <h1 className="text-2xl font-medium">Your workspace starts here</h1>
            <p className="max-w-sm text-sm text-muted-foreground">
              Open a sample server to explore the interface.
            </p>
            <Button onClick={() => setPickerOpen(true)}>
              <Plus aria-hidden="true" />
              Open sample server
            </Button>
          </main>
        )}
      </Tabs>
    </div>
  );
}
