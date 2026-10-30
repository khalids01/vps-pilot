import { isTauri } from "@tauri-apps/api/core";
import {
  BellRingIcon,
  BugIcon,
  CheckCircle2Icon,
  DownloadIcon,
  GaugeIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { parseReleaseNotes, type ReleaseNoteCategory } from "./release-notes";
import { type UpdateStatus, useUpdateStore } from "./update-store";

export function UpdateControl() {
  const status = useUpdateStore((state) => state.status);
  const checkForUpdate = useUpdateStore((state) => state.checkForUpdate);
  return (
    <Button
      variant="outline"
      disabled={!isTauri() || status === "checking" || status === "downloading"}
      onClick={() => void checkForUpdate({ manual: true, openDialog: true })}
    >
      <RefreshCwIcon
        data-icon="inline-start"
        className={status === "checking" ? "animate-spin" : ""}
      />
      {status === "checking" ? "Checking for updates…" : "Check for updates"}
    </Button>
  );
}

export function UpdateSidebarNotice() {
  const state = useUpdateStore();
  const isHiddenForVersion =
    state.version === state.skippedVersion ||
    state.version === state.deferredVersion;
  const visible =
    state.status === "downloading" ||
    state.status === "installed" ||
    state.status === "restartRequired" ||
    (state.status === "available" && !isHiddenForVersion);

  if (!visible) return null;

  const percent = getPercent(state.downloadedBytes, state.totalBytes);
  return (
    <div className="shrink-0 border-t border-border p-3">
      <button
        type="button"
        onClick={() => state.setDialogOpen(true)}
        className="group w-full rounded-xl border border-primary/25 bg-primary/8 p-3 text-left transition-colors hover:border-primary/45 hover:bg-primary/12 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <div className="flex items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            {state.status === "restartRequired" ? (
              <RotateCcwIcon className="size-4" />
            ) : (
              <DownloadIcon className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">
              {state.status === "downloading"
                ? "Installing update"
                : state.status === "restartRequired"
                  ? "Restart required"
                  : "Update available"}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {state.status === "downloading"
                ? percent === null
                  ? `${formatBytes(state.downloadedBytes)} downloaded`
                  : `${percent}% downloaded`
                : state.version
                  ? `VPS Pilot ${state.version}`
                  : "View update details"}
            </span>
          </span>
          <BellRingIcon className="mt-1 size-4 shrink-0 text-primary" />
        </div>
        {state.status === "downloading" && (
          <ProgressBar percent={percent} className="mt-3" />
        )}
      </button>
    </div>
  );
}

export function UpdateDialog() {
  const state = useUpdateStore();
  const percent = getPercent(state.downloadedBytes, state.totalBytes);

  function handleOpenChange(open: boolean) {
    if (open) {
      state.setDialogOpen(true);
      return;
    }
    if (state.status === "downloading") return;
    if (state.status === "available") {
      state.remindLater();
      return;
    }
    state.setDialogOpen(false);
  }

  return (
    <Dialog open={state.dialogOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={state.status !== "downloading"}
      >
        <DialogHeader>
          <DialogTitle>{getTitle(state.status, state.version)}</DialogTitle>
          <DialogDescription>
            {state.currentVersion
              ? `You are using VPS Pilot ${state.currentVersion}.`
              : "Updates are downloaded from the signed VPS Pilot release channel."}
          </DialogDescription>
        </DialogHeader>

        <UpdateBody
          status={state.status}
          version={state.version}
          notes={state.notes}
          error={state.error}
          percent={percent}
          downloaded={state.downloadedBytes}
          total={state.totalBytes}
        />

        <UpdateActions status={state.status} />
      </DialogContent>
    </Dialog>
  );
}

function UpdateActions({ status }: { status: UpdateStatus }) {
  const state = useUpdateStore();

  if (status === "available") {
    return (
      <DialogFooter className="sm:justify-between">
        <Button variant="ghost" onClick={state.skipVersion}>
          Skip this version
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="outline" onClick={state.remindLater}>
            Remind me later
          </Button>
          <Button onClick={() => void state.installAndRestart()}>
            <DownloadIcon data-icon="inline-start" />
            Update
          </Button>
        </div>
      </DialogFooter>
    );
  }

  if (status === "downloading") {
    return (
      <DialogFooter>
        <Button disabled>Installing update…</Button>
      </DialogFooter>
    );
  }

  if (status === "restartRequired" || status === "installed") {
    return (
      <DialogFooter>
        <Button variant="outline" onClick={() => state.setDialogOpen(false)}>
          Restart later
        </Button>
        <Button onClick={() => void state.restartApp()}>
          <RotateCcwIcon data-icon="inline-start" />
          Restart VPS Pilot
        </Button>
      </DialogFooter>
    );
  }

  return (
    <DialogFooter>
      <Button
        variant="outline"
        disabled={status === "checking"}
        onClick={() =>
          void state.checkForUpdate({ manual: true, openDialog: true })
        }
      >
        <RefreshCwIcon
          data-icon="inline-start"
          className={status === "checking" ? "animate-spin" : ""}
        />
        {status === "checking" ? "Checking…" : "Check again"}
      </Button>
    </DialogFooter>
  );
}

function UpdateBody({
  status,
  version,
  notes,
  error,
  percent,
  downloaded,
  total,
}: {
  status: UpdateStatus;
  version: string | null;
  notes: string | null;
  error: string | null;
  percent: number | null;
  downloaded: number;
  total: number | null;
}) {
  if (status === "checking") {
    return <StatusMessage message="Checking for a signed update…" spinning />;
  }

  if (status === "upToDate") {
    return (
      <div className="flex gap-3 rounded-xl bg-emerald-500/10 p-4">
        <CheckCircle2Icon className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div>
          <p className="font-medium">VPS Pilot is up to date</p>
          <p className="mt-1 text-sm text-muted-foreground">
            You already have the newest available version.
          </p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        role="alert"
        className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive"
      >
        <p className="font-medium">The update could not be completed.</p>
        <p className="mt-1 break-words">{error ?? "Please try again."}</p>
      </div>
    );
  }

  if (status === "available") {
    const sections = parseReleaseNotes(notes);
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl bg-primary/8 p-4">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <SparklesIcon className="size-4" />
          </span>
          <div>
            <p className="font-semibold">Version {version} is ready</p>
            <p className="text-sm text-muted-foreground">
              Review the changes before installing.
            </p>
          </div>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">What is new</h3>
          {sections.length > 0 ? (
            <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-3">
              {sections.map((section) => (
                <ReleaseNoteCard key={section.category} section={section} />
              ))}
            </div>
          ) : (
            <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-muted/35 p-4 text-sm leading-6 text-muted-foreground">
              {notes ?? "No release notes were provided for this version."}
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Updating restarts VPS Pilot and closes all SSH connections and
          terminal sessions. Finish your work before continuing. VPS Pilot
          verifies the signed download before installing it.
        </p>
      </div>
    );
  }

  if (status === "downloading" || status === "installed") {
    return (
      <div className="rounded-xl border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">Downloading and installing</span>
          <span className="tabular-nums text-muted-foreground">
            {percent === null ? "Working…" : `${percent}%`}
          </span>
        </div>
        <ProgressBar percent={percent} />
        <p className="mt-3 text-xs text-muted-foreground">
          {percent === null
            ? `${formatBytes(downloaded)} downloaded`
            : `${formatBytes(downloaded)} of ${formatBytes(total ?? 0)}`}
        </p>
      </div>
    );
  }

  if (status === "restartRequired") {
    return (
      <div className="rounded-xl bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
        <p className="font-medium">The update was installed successfully.</p>
        <p className="mt-1">
          {error ?? "Close and reopen VPS Pilot to finish the update."}
        </p>
      </div>
    );
  }

  if (status === "skipped") {
    return (
      <p className="text-sm text-muted-foreground">
        This version is skipped. A future version will still appear
        automatically.
      </p>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      VPS Pilot checks the signed release channel automatically after launch.
    </p>
  );
}

const RELEASE_NOTE_ICON: Record<ReleaseNoteCategory, typeof BugIcon> = {
  bugFixes: BugIcon,
  performance: GaugeIcon,
  features: ShieldCheckIcon,
};

function ReleaseNoteCard({
  section,
}: {
  section: ReturnType<typeof parseReleaseNotes>[number];
}) {
  const Icon = RELEASE_NOTE_ICON[section.category];
  return (
    <div className="rounded-xl border border-border bg-muted/25 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-primary" />
        {section.title}
      </div>
      <ul className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">
        {section.items.slice(0, 3).map((item) => (
          <li key={item}>• {item}</li>
        ))}
      </ul>
    </div>
  );
}

function StatusMessage({
  message,
  spinning = false,
}: {
  message: string;
  spinning?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">
      <RefreshCwIcon className={spinning ? "size-4 animate-spin" : "size-4"} />
      {message}
    </div>
  );
}

function ProgressBar({
  percent,
  className = "",
}: {
  percent: number | null;
  className?: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label="Update download"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={`h-2 overflow-hidden rounded-full bg-muted ${className}`}
    >
      <div
        className={`h-full rounded-full bg-primary ${percent === null ? "w-1/3 animate-pulse" : "transition-[width]"}`}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

function getTitle(status: UpdateStatus, version: string | null) {
  if (status === "available") return `VPS Pilot ${version} is available`;
  if (status === "downloading") return "Installing your update";
  if (status === "restartRequired" || status === "installed") {
    return "Restart to finish updating";
  }
  return "Application updates";
}

function getPercent(downloaded: number, total: number | null) {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function UpdateManager() {
  const checkForUpdate = useUpdateStore((state) => state.checkForUpdate);
  useEffect(() => {
    if (!isTauri()) return;
    const timer = window.setTimeout(() => void checkForUpdate(), 4_000);
    return () => window.clearTimeout(timer);
  }, [checkForUpdate]);
  return <UpdateDialog />;
}
