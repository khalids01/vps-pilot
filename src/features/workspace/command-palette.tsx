import { Combobox } from "@base-ui/react/combobox";
import { Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ServerProfile } from "@/features/ssh/api";
import type { ToolId } from "./fixtures";
import { matchesServer, sortFleet } from "./fleet-data";
import { useFleet } from "./fleet-store";

const tools: Record<ToolId, string> = {
  overview: "Overview",
  terminal: "Terminal",
  files: "Files",
  software: "Software",
  docker: "Docker",
  proxy: "Proxy",
  services: "Services",
  storage: "Storage",
  firewall: "Firewall",
  helper: "Server helper",
  network: "Network",
  processes: "Processes",
};
interface Entry {
  id: string;
  label: string;
  detail: string;
  profile?: ServerProfile;
  tool?: ToolId;
  run: () => void;
}
export function CommandPalette({
  profiles,
  activeId,
  onOpen,
  onHome,
  onSettings,
  onAdd,
  onClose,
}: {
  profiles: ServerProfile[];
  activeId: string | null;
  onOpen: (profile: ServerProfile, tool?: ToolId) => void;
  onHome: () => void;
  onSettings: () => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const fleet = useFleet();
  const ordered = sortFleet(profiles, fleet.data.servers).sort(
    (a, b) =>
      Number(`remote:${b.id}` === activeId) -
      Number(`remote:${a.id}` === activeId),
  );
  const entries: Entry[] = [
    {
      id: "fleet",
      label: "Fleet home",
      detail: "All saved servers",
      run: onHome,
    },
    {
      id: "settings",
      label: "Settings",
      detail: "Application preferences",
      run: onSettings,
    },
    {
      id: "add",
      label: "Add or choose a server",
      detail: "Connection picker",
      run: onAdd,
    },
    ...ordered.flatMap((profile) => {
      const metadata = fleet.metadata(profile.id);
      const detail = [
        metadata.project,
        metadata.environment === "none" ? "" : metadata.environment,
        profile.host,
        ...metadata.tags,
      ]
        .filter(Boolean)
        .join(" · ");
      return [
        {
          id: profile.id,
          label: `Open ${profile.name}`,
          detail,
          profile,
          run: () => onOpen(profile),
        },
        ...Object.entries(tools).map(([tool, label]) => ({
          id: `${profile.id}:${tool}`,
          label: `${profile.name} → ${label}`,
          detail,
          profile,
          tool: tool as ToolId,
          run: () => onOpen(profile, tool as ToolId),
        })),
      ];
    }),
  ];
  return (
    <Combobox.Root<Entry>
      inline
      open
      items={entries}
      limit={60}
      autoHighlight
      value={null}
      itemToStringLabel={(entry) => entry.label}
      filter={(entry, query) => {
        if (!entry.profile)
          return `${entry.label} ${entry.detail}`
            .toLowerCase()
            .includes(query.toLowerCase().trim());
        const metadata = fleet.metadata(entry.profile.id);
        return query
          .toLowerCase()
          .trim()
          .split(/\s+/)
          .every(
            (word) =>
              entry.label.toLowerCase().includes(word) ||
              matchesServer(entry.profile as ServerProfile, metadata, word),
          );
      }}
      onValueChange={(entry) => {
        if (entry) {
          onClose();
          entry.run();
        }
      }}
    >
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="gap-3 sm:max-w-xl" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Go to…</DialogTitle>
            <DialogDescription>
              Search servers, projects, tags, or tools. Navigation keeps
              existing sessions open.
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Combobox.Input
              render={<Input className="h-10 pl-9" />}
              aria-label="Search servers and tools"
              placeholder="e.g. production api docker"
              autoFocus
            />
          </div>
          <Combobox.Empty className="text-center text-muted-foreground [&:not(:empty)]:p-6">
            No matching servers or tools.
          </Combobox.Empty>
          <Combobox.List className="max-h-[min(55dvh,420px)] overflow-y-auto space-y-1">
            {(entry: Entry) => (
              <Combobox.Item
                key={entry.id}
                value={entry}
                className="cursor-pointer rounded-lg px-3 py-2.5 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
              >
                <span className="block text-sm">{entry.label}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {entry.detail}
                </span>
              </Combobox.Item>
            )}
          </Combobox.List>
          <p className="border-t pt-3 text-[11px] text-muted-foreground">
            ↑ ↓ Navigate · Enter Open · Esc Close · Ctrl/Cmd + K
          </p>
        </DialogContent>
      </Dialog>
    </Combobox.Root>
  );
}
