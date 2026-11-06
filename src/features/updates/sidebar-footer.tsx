import { Settings, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebarOptional,
} from "@/components/ui/sidebar";
import { Tooltip } from "@/components/ui/tooltip";
import { useAppVersion } from "./update-store";

export function SidebarFooter({
  onSettings,
  settingsOpen = false,
}: {
  onSettings: () => void;
  settingsOpen?: boolean;
}) {
  const sidebar = useSidebarOptional();

  if (!sidebar) {
    return (
      <div className="shrink-0">
        <Button
          variant="ghost"
          aria-current={settingsOpen ? "page" : undefined}
          onClick={onSettings}
          className={`h-10 w-full justify-start gap-3 px-3 ${settingsOpen ? "bg-sidebar-accent text-primary" : "text-muted-foreground"}`}
        >
          <Settings className="size-4" aria-hidden="true" />
          Settings
        </Button>
      </div>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={settingsOpen}
          aria-current={settingsOpen ? "page" : undefined}
          aria-label="Settings"
          tooltip="Settings"
          onClick={onSettings}
          className="h-10 gap-3 px-3 text-muted-foreground"
        >
          <Settings className="size-4" aria-hidden="true" />
          <span className="truncate transition-opacity duration-200 group-data-[collapsible=icon]:opacity-0">
            Settings
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function SidebarVersion() {
  const sidebar = useSidebarOptional();
  const version = useAppVersion();
  const collapsed = sidebar?.state === "collapsed" && !sidebar?.isMobile;
  const label = version
    ? `VPS Pilot version ${version}`
    : "VPS Pilot version unavailable";

  if (collapsed) {
    return (
      <div className="flex shrink-0 justify-center px-1 pb-1">
        <Tooltip content={label}>
          <span
            role="img"
            aria-label={label}
            data-testid="app-version"
            data-version={version ?? ""}
            className="grid size-8 place-items-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <Tag className="size-4" aria-hidden="true" />
          </span>
        </Tooltip>
      </div>
    );
  }

  return (
    <p
      role="note"
      aria-label={label}
      data-testid="app-version"
      data-version={version ?? ""}
      className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground"
    >
      <Tag className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {version ? `v${version}` : "Version unavailable"}
      </span>
    </p>
  );
}
