import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SidebarFooter({
  onSettings,
  settingsOpen = false,
}: {
  onSettings: () => void;
  settingsOpen?: boolean;
}) {
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
