import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DeviceSecuritySettings } from "@/features/security/device-lock";
import { UpdateControl } from "@/features/updates/update-control";
import {
  defaultSettings,
  type StatId,
  statIds,
  useAppSettings,
} from "./app-settings";
import { ThemePicker } from "./theme-picker";

const labels: Record<StatId, string> = {
  cpu: "CPU",
  ram: "RAM",
  storage: "Storage capacity",
  diskIo: "Disk activity",
  network: "Network download and upload",
};
export function SettingsPage() {
  const { settings, update, saving, error } = useAppSettings();
  return (
    <main
      aria-label="Application settings"
      className="min-h-0 flex-1 overflow-y-auto px-5 py-7 sm:px-9 sm:py-9"
    >
      <div className="mx-auto w-full max-w-4xl">
        <header className="border-b border-border/70 pb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        </header>
        <DeviceSecuritySettings />
        <section
          aria-labelledby="appearance-heading"
          className="space-y-5 border-b border-border/70 py-6"
        >
          <h2 id="appearance-heading" className="text-sm font-semibold">
            Appearance
          </h2>
          <ThemePicker />
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <span className="text-sm">App zoom</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Zoom out"
                disabled={settings.zoomPercent <= 50}
                onClick={() =>
                  update((old) => ({
                    ...old,
                    zoomPercent: Math.max(50, old.zoomPercent - 10),
                  }))
                }
              >
                <Minus />
              </Button>
              <output
                className="w-12 text-center text-xs tabular-nums"
                aria-label="Zoom level"
              >
                {settings.zoomPercent}%
              </output>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Zoom in"
                disabled={settings.zoomPercent >= 200}
                onClick={() =>
                  update((old) => ({
                    ...old,
                    zoomPercent: Math.min(200, old.zoomPercent + 10),
                  }))
                }
              >
                <Plus />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => update({ zoomPercent: 100 })}
              >
                Reset zoom
              </Button>
            </div>
          </div>
        </section>
        <section
          aria-labelledby="live-settings-heading"
          className="space-y-5 border-b border-border/70 py-6"
        >
          <h2 id="live-settings-heading" className="text-sm font-semibold">
            Live stats
          </h2>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <label
              htmlFor="live-stats-enabled"
              className="flex items-center gap-2.5 text-sm"
            >
              <Checkbox
                id="live-stats-enabled"
                checked={settings.liveStats}
                onCheckedChange={(liveStats) => update({ liveStats })}
              />
              Enable live stats automatically
            </label>
            <fieldset className="flex items-center gap-3">
              <legend className="sr-only">Refresh interval</legend>
              <span className="text-xs text-muted-foreground">Refresh</span>
              <div className="flex gap-1 rounded-lg border bg-muted/20 p-0.5">
                {[1, 2, 5].map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={
                      settings.intervalSeconds === value ? "secondary" : "ghost"
                    }
                    aria-pressed={settings.intervalSeconds === value}
                    onClick={() => update({ intervalSeconds: value })}
                  >
                    {value} second{value === 1 ? "" : "s"}
                  </Button>
                ))}
              </div>
            </fieldset>
          </div>
          <fieldset>
            <legend className="mb-3 text-xs text-muted-foreground">
              Visible stats
            </legend>
            <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
              {statIds.map((id) => (
                <label
                  key={id}
                  htmlFor={`visible-stat-${id}`}
                  className="flex items-center gap-2.5 text-sm"
                >
                  <Checkbox
                    id={`visible-stat-${id}`}
                    checked={settings.visibleStats.includes(id)}
                    onCheckedChange={(checked) =>
                      update((old) => ({
                        ...old,
                        visibleStats: checked
                          ? [...old.visibleStats, id]
                          : old.visibleStats.filter((value) => value !== id),
                      }))
                    }
                  />
                  {labels[id]}
                </label>
              ))}
            </div>
          </fieldset>
        </section>
        <section
          aria-labelledby="updates-heading"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 py-6"
        >
          <h2 id="updates-heading" className="text-sm font-semibold">
            Application updates
          </h2>
          <UpdateControl />
        </section>
        <footer className="flex flex-wrap items-center justify-between gap-3 py-5">
          <p role="status" className="text-xs text-muted-foreground">
            {error
              ? "Changes not saved"
              : saving
                ? "Saving…"
                : "Saved on this device"}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              update({ ...defaultSettings, visibleStats: [...statIds] })
            }
          >
            Restore default settings
          </Button>
        </footer>
      </div>
    </main>
  );
}
