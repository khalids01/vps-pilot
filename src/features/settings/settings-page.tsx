import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { UpdateControl } from "@/features/updates/update-control";
import {
  defaultSettings,
  type StatId,
  statIds,
  useAppSettings,
} from "./app-settings";

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
      className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-8"
    >
      <div className="w-full space-y-7">
        <div>
          <h1 className="text-2xl font-medium">Settings</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Saved on this device. No cloud account or sync required.
          </p>
        </div>
        <section
          className="space-y-3 rounded-xl border bg-card p-5"
          aria-labelledby="updates-heading"
        >
          <h2 id="updates-heading" className="font-medium">
            Application updates
          </h2>
          <p className="text-sm text-muted-foreground">
            Check for a new version of VPS Pilot and review changes before
            updating.
          </p>
          <UpdateControl />
        </section>
        <section
          aria-labelledby="live-settings-heading"
          className="space-y-5 rounded-xl border bg-card p-5"
        >
          <h2 id="live-settings-heading" className="font-medium">
            Live stats
          </h2>
          <label
            htmlFor="live-stats-enabled"
            className="flex items-center gap-3 text-sm"
          >
            <Checkbox
              id="live-stats-enabled"
              checked={settings.liveStats}
              onCheckedChange={(liveStats) => update({ liveStats })}
            />
            Enable live stats automatically
          </label>
          <p className="text-xs text-muted-foreground">
            Only the active, connected VPS is sampled. Sampling pauses when the
            app is inactive. Live measurements stay in memory.
          </p>
          <fieldset className="space-y-3">
            <legend className="text-sm">Refresh interval</legend>
            <div className="flex gap-2">
              {[1, 2, 5].map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={
                    settings.intervalSeconds === value ? "secondary" : "outline"
                  }
                  aria-pressed={settings.intervalSeconds === value}
                  onClick={() => update({ intervalSeconds: value })}
                >
                  {value} second{value === 1 ? "" : "s"}
                </Button>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="text-sm">Visible stats</legend>
            {statIds.map((id) => (
              <label
                key={id}
                htmlFor={`visible-stat-${id}`}
                className="flex items-center gap-3 text-sm"
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
          </fieldset>
          <p className="text-xs text-muted-foreground">
            Hide all stats to stop sampling. Choosing a stat changes both the
            header and detail charts.
          </p>
        </section>
        <section
          aria-labelledby="appearance-heading"
          className="space-y-4 rounded-xl border bg-card p-5"
        >
          <h2 id="appearance-heading" className="font-medium">
            Appearance
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">App zoom</span>
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
              className="w-14 text-center text-sm tabular-nums"
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
          <p className="text-xs text-muted-foreground">
            Ctrl/Cmd + plus or minus to zoom, Ctrl/Cmd + 0 to reset. Ctrl/Cmd +
            scroll also works.
          </p>
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted-foreground">
            {error
              ? "Changes not saved"
              : saving
                ? "Saving…"
                : "Saved on this device"}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              update({ ...defaultSettings, visibleStats: [...statIds] })
            }
          >
            Restore default settings
          </Button>
        </div>
      </div>
    </main>
  );
}
