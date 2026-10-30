import { UpdateControl } from "@/features/updates/update-control";
export function SettingsPage() {
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
      </div>
    </main>
  );
}
