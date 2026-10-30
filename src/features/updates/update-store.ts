import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "skipped"
  | "downloading"
  | "installed"
  | "restartRequired"
  | "error";

interface CheckOptions {
  manual?: boolean;
  openDialog?: boolean;
}

interface UpdateState {
  status: UpdateStatus;
  dialogOpen: boolean;
  currentVersion: string | null;
  version: string | null;
  notes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  update: Update | null;
  skippedVersion: string | null;
  deferredVersion: string | null;
  setDialogOpen: (open: boolean) => void;
  checkForUpdate: (options?: CheckOptions) => Promise<void>;
  installAndRestart: () => Promise<void>;
  restartApp: () => Promise<void>;
  skipVersion: () => void;
  remindLater: () => void;
}

let checking: Promise<void> | null = null;

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set, get) => ({
      status: "idle",
      dialogOpen: false,
      currentVersion: null,
      version: null,
      notes: null,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      update: null,
      skippedVersion: null,
      deferredVersion: null,
      setDialogOpen: (dialogOpen) => set({ dialogOpen }),
      checkForUpdate: async ({ manual = false, openDialog = false } = {}) => {
        if (openDialog) set({ dialogOpen: true });
        if (
          ["downloading", "installed", "restartRequired"].includes(get().status)
        )
          return;
        if (checking) return checking;

        checking = (async () => {
          set({ status: "checking", error: null });
          try {
            const previous = get().update;
            set({ update: null });
            await previous?.close();
            const [currentVersion, update] = await Promise.all([
              getVersion(),
              check({ timeout: 15_000 }),
            ]);

            if (!update) {
              set({
                status: "upToDate",
                currentVersion,
                version: null,
                notes: null,
                update: null,
              });
              return;
            }

            const wasSkipped = get().skippedVersion === update.version;
            set({
              status: wasSkipped && !manual ? "skipped" : "available",
              currentVersion,
              version: update.version,
              notes: update.body?.trim() || null,
              update,
              downloadedBytes: 0,
              totalBytes: null,
              error: null,
              deferredVersion: manual ? null : get().deferredVersion,
            });
          } catch (error) {
            set({
              status: manual ? "error" : "idle",
              error: manual ? readableError(error) : null,
            });
          } finally {
            checking = null;
          }
        })();

        return checking;
      },
      installAndRestart: async () => {
        const update = get().update;
        if (!update || get().status !== "available") return;

        let downloadedBytes = 0;
        set({
          status: "downloading",
          dialogOpen: true,
          downloadedBytes: 0,
          totalBytes: null,
          error: null,
        });

        try {
          await update.downloadAndInstall(
            (event) => {
              if (event.event === "Started") {
                set({ totalBytes: event.data.contentLength ?? null });
              }
              if (event.event === "Progress") {
                downloadedBytes += event.data.chunkLength;
                set({ downloadedBytes });
              }
            },
            { timeout: 10 * 60_000 },
          );
          set({ status: "installed", error: null });
        } catch (error) {
          set({ status: "error", error: readableError(error) });
          return;
        }

        await restartAfterInstall(set);
      },
      restartApp: async () => restartAfterInstall(set),
      skipVersion: () => {
        const version = get().version;
        if (!version) return;
        set({
          skippedVersion: version,
          deferredVersion: null,
          status: "skipped",
          dialogOpen: false,
        });
      },
      remindLater: () => {
        const version = get().version;
        set({ deferredVersion: version, dialogOpen: false });
      },
    }),
    {
      name: "vps-pilot-updates",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ skippedVersion: state.skippedVersion }),
    },
  ),
);

async function restartAfterInstall(set: (patch: Partial<UpdateState>) => void) {
  try {
    await relaunch();
  } catch (error) {
    set({
      status: "restartRequired",
      dialogOpen: true,
      error: `The update was installed, but VPS Pilot could not restart automatically. Save your work and restart the app manually. ${readableError(error)}`,
    });
  }
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
