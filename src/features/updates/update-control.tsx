import { isTauri } from "@tauri-apps/api/core";
import { Download, RefreshCw } from "lucide-react";
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
import { useUpdateStore } from "./update-store";

export function UpdateControl() {
  const state = useUpdateStore();
  const ready = [
    "available",
    "downloading",
    "installed",
    "restartRequired",
  ].includes(state.status);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="mb-1 shrink-0"
      disabled={!isTauri() || state.status === "checking"}
      onClick={() => {
        if (ready) state.setDialogOpen(true);
        else void state.checkForUpdate({ manual: true, openDialog: true });
      }}
    >
      {ready ? (
        <Download aria-hidden="true" />
      ) : (
        <RefreshCw aria-hidden="true" />
      )}
      {state.status === "checking"
        ? "Checking…"
        : ready
          ? "App update"
          : "Check for updates"}
    </Button>
  );
}

export function UpdateManager() {
  const state = useUpdateStore();
  const checkForUpdate = state.checkForUpdate;
  useEffect(() => {
    if (!isTauri()) return;
    const timer = window.setTimeout(() => void checkForUpdate(), 4_000);
    return () => window.clearTimeout(timer);
  }, [checkForUpdate]);

  const installing = state.status === "downloading";
  const installed =
    state.status === "installed" || state.status === "restartRequired";
  const available = state.status === "available";
  const percent = state.totalBytes
    ? Math.min(
        100,
        Math.round((state.downloadedBytes / state.totalBytes) * 100),
      )
    : null;
  return (
    <>
      {available &&
        state.version !== state.skippedVersion &&
        state.version !== state.deferredVersion &&
        !state.dialogOpen && (
          <div
            role="status"
            className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-primary/10 px-4 py-2 text-xs"
          >
            <span>VPS Pilot {state.version} is available.</span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => state.setDialogOpen(true)}
            >
              View update
            </Button>
          </div>
        )}
      <Dialog
        open={state.dialogOpen}
        onOpenChange={(open) => {
          if (installing) return;
          if (!open && available) state.remindLater();
          else state.setDialogOpen(open);
        }}
      >
        <DialogContent
          showCloseButton={!installing}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>
              {available
                ? `VPS Pilot ${state.version} is available`
                : installed
                  ? "Restart to finish updating"
                  : "Application updates"}
            </DialogTitle>
            <DialogDescription>
              {state.currentVersion
                ? `You are using VPS Pilot ${state.currentVersion}.`
                : "Check for a signed VPS Pilot update."}
            </DialogDescription>
          </DialogHeader>
          {state.status === "checking" && (
            <p role="status" className="text-sm text-muted-foreground">
              Checking for updates…
            </p>
          )}
          {state.status === "upToDate" && (
            <p role="status" className="text-sm">
              VPS Pilot is up to date.
            </p>
          )}
          {state.status === "error" && (
            <p role="alert" className="break-words text-sm text-destructive">
              The update could not be completed. {state.error}
            </p>
          )}
          {available && (
            <div className="space-y-4">
              <div>
                <h3 className="mb-2 text-sm font-medium">What is new</h3>
                <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                  {state.notes || "No release notes were provided."}
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                Updating restarts VPS Pilot and closes all SSH connections and
                terminal sessions. Finish your work before continuing.
              </p>
              <p className="text-xs text-muted-foreground">
                The download's signature is verified before installation.
              </p>
            </div>
          )}
          {installing && (
            <div role="status" className="space-y-2 text-sm">
              <p>
                Downloading and installing…{" "}
                {percent === null
                  ? `${(state.downloadedBytes / 1024 / 1024).toFixed(1)} MB downloaded`
                  : `${percent}%`}
              </p>
              <progress
                aria-label="Update download"
                value={percent ?? undefined}
                max={100}
                className="h-2 w-full accent-primary"
              />
            </div>
          )}
          {installed && (
            <p role="status" className="text-sm text-muted-foreground">
              {state.error ||
                "The update is installed. Restart VPS Pilot to finish."}
            </p>
          )}
          <DialogFooter>
            {available ? (
              <>
                <Button variant="ghost" onClick={state.skipVersion}>
                  Skip this version
                </Button>
                <Button variant="outline" onClick={state.remindLater}>
                  Remind me later
                </Button>
                <Button onClick={() => void state.installAndRestart()}>
                  Update and restart
                </Button>
              </>
            ) : installing ? (
              <Button disabled>Installing update…</Button>
            ) : installed ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => state.setDialogOpen(false)}
                >
                  Restart later
                </Button>
                <Button onClick={() => void state.restartApp()}>
                  Restart VPS Pilot
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                disabled={state.status === "checking"}
                onClick={() =>
                  void state.checkForUpdate({ manual: true, openDialog: true })
                }
              >
                Check again
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
