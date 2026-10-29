import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  address,
  desktopAvailable,
  type ProfileInput,
  profileQueryKey,
  type ServerProfile,
  safeError,
  sshApi,
  useConfigHosts,
  useServerProfiles,
} from "./api";

export function ProfileManager({
  open,
  onOpenChange,
  onOpenServer,
  onDeleteServer,
  samples,
  onOpenSample,
}: {
  samples: { id: string; name: string; address: string }[];
  onOpenSample: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenServer: (profile: ServerProfile) => void;
  onDeleteServer: (profile: ServerProfile) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <ProfileManagerContent
          onOpenChange={onOpenChange}
          onOpenServer={onOpenServer}
          onDeleteServer={onDeleteServer}
          samples={samples}
          onOpenSample={onOpenSample}
        />
      )}
    </Dialog>
  );
}
function ProfileManagerContent({
  onOpenChange,
  onOpenServer,
  onDeleteServer,
  samples,
  onOpenSample,
}: Omit<Parameters<typeof ProfileManager>[0], "open">) {
  const profiles = useServerProfiles();
  const [choosing, setChoosing] = useState(true);
  const [search, setSearch] = useState("");
  const matches = (name: string, host: string) =>
    `${name} ${host}`.toLowerCase().includes(search.toLowerCase());
  const newDraft = () => {
    setChoosing(false);
    setError("");
    setDraft({ id: null, name: "", host: "", port: 22, username: "" });
  };
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProfileInput | null>(null);
  const [removing, setRemoving] = useState<ServerProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const config = useConfigHosts(!choosing && !draft && !removing);
  return (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-xl"
      showCloseButton={!busy}
    >
      <DialogHeader>
        <DialogTitle>
          {removing
            ? "Remove saved server profile?"
            : draft
              ? draft.id
                ? "Edit server profile"
                : "Add a new connection"
              : choosing
                ? "New VPS tab"
                : "Choose a connection"}
        </DialogTitle>
        <DialogDescription>
          {removing
            ? `${removing.name} · ${address(removing)}. Removes only this desktop profile; nothing on the VPS is changed. Disconnect first if a connection is active.`
            : "Choose an SSH config entry or an app-saved profile, or add a new connection. Connections start only after host verification; passwords are never saved."}
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto">
        {choosing ? (
          <div className="space-y-3">
            {!desktopAvailable && (
              <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
                Saved server connections are available in the desktop app. Run
                bun tauri dev; the browser continues to offer the sample
                workspaces.
              </p>
            )}
            <Button
              variant="outline"
              className="h-auto w-full justify-start gap-3 p-4"
              disabled={!desktopAvailable}
              onClick={() => setChoosing(false)}
            >
              <Server aria-hidden="true" />
              <span className="text-left">
                <span className="block">Choose a connection</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  From ~/.ssh/config or saved in VPS Pilot
                </span>
              </span>
            </Button>
            <Button
              variant="outline"
              className="h-auto w-full justify-start gap-3 p-4"
              disabled={!desktopAvailable}
              onClick={newDraft}
            >
              <Plus aria-hidden="true" />
              <span className="text-left">
                <span className="block">Add a new connection</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  Enter an address, username, and SSH port
                </span>
              </span>
            </Button>
            {samples.length > 0 && (
              <details className="pt-3 text-sm text-muted-foreground">
                <summary className="cursor-pointer">
                  Explore sample workspaces
                </summary>
                <div className="mt-3 flex flex-wrap gap-2">
                  {samples.map((sample) => (
                    <Button
                      key={sample.id}
                      size="sm"
                      variant="outline"
                      onClick={() => onOpenSample(sample.id)}
                    >
                      {sample.name}
                    </Button>
                  ))}
                </div>
              </details>
            )}
          </div>
        ) : !desktopAvailable ? (
          <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
            Saved server connections are available in the desktop app. Run bun
            tauri dev; the browser continues to offer the sample workspaces.
          </p>
        ) : removing ? (
          <div className="space-y-4">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setRemoving(null);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await sshApi.deleteProfile(removing.id);
                    onDeleteServer(removing);
                    await queryClient.invalidateQueries({
                      queryKey: profileQueryKey,
                    });
                    setRemoving(null);
                  } catch (error) {
                    setError(safeError(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Remove profile
              </Button>
            </div>
          </div>
        ) : draft ? (
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                const saved = await sshApi.saveProfile(draft);
                await queryClient.invalidateQueries({
                  queryKey: profileQueryKey,
                });
                onOpenServer(saved);
                onOpenChange(false);
              } catch (error) {
                setError(safeError(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="block text-sm" htmlFor="profile-name">
              Server name
              <Input
                id="profile-name"
                className="mt-1"
                value={draft.name}
                required
                maxLength={80}
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <label className="block text-sm" htmlFor="profile-host">
              Hostname or IP address
              <Input
                id="profile-host"
                className="mt-1"
                value={draft.host}
                placeholder="server.example.com"
                required
                maxLength={253}
                disabled={busy}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) =>
                  setDraft({ ...draft, host: event.target.value })
                }
              />
            </label>
            <div className="grid grid-cols-2 gap-4">
              <label className="block text-sm" htmlFor="profile-user">
                Linux username
                <Input
                  id="profile-user"
                  className="mt-1"
                  value={draft.username}
                  autoComplete="off"
                  required
                  maxLength={64}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, username: event.target.value })
                  }
                />
              </label>
              <label className="block text-sm" htmlFor="profile-port">
                SSH port
                <Input
                  id="profile-port"
                  className="mt-1"
                  value={draft.port || ""}
                  type="number"
                  min={1}
                  max={65535}
                  required
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, port: Number(event.target.value) })
                  }
                />
              </label>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Direct SSH uses password authentication. SSH config entries supply
              address, username, and port only. Key files, agents, jump hosts,
              and terminal sessions will follow in separate increments. Saving
              creates an app-owned profile and never changes ~/.ssh/config.
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError("");
                }}
              >
                <ArrowLeft aria-hidden="true" />
                Back
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save and open workspace"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setChoosing(true);
                  setError("");
                }}
              >
                <ArrowLeft aria-hidden="true" />
                Back
              </Button>
              <Button
                variant="outline"
                disabled={busy || config.isFetching}
                onClick={() => {
                  void config.refetch();
                  void profiles.refetch();
                }}
              >
                Refresh list
              </Button>
              <Button onClick={newDraft}>
                <Plus aria-hidden="true" />
                Add a new connection
              </Button>
            </div>
            <Input
              aria-label="Search connections"
              placeholder="Search name or address…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <section className="space-y-3" aria-label="SSH config connections">
              <h3 className="text-sm font-medium">
                SSH config{" "}
                <span className="font-normal text-muted-foreground">
                  · ~/.ssh/config
                </span>
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Read-only list, including named hosts from Include files.
                Opening saves an address, username, and port copy in VPS Pilot.
                Uses password authentication and its own host verification; key
                files and other config settings are not applied.
              </p>
              {config.isPending && (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading SSH config…
                </p>
              )}
              {config.error && (
                <p role="alert" className="text-sm text-destructive">
                  {safeError(config.error)}
                </p>
              )}
              {config.data?.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No named connections in ~/.ssh/config.
                </p>
              )}
              {config.data
                ?.filter((entry) => matches(entry.alias, entry.host))
                .map((entry) => (
                  <div
                    key={entry.alias}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium">
                        {entry.alias}
                      </p>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {address({
                          ...entry,
                          name: entry.alias,
                          id: "",
                          revision: "",
                        })}
                      </p>
                      {entry.blockedReason && (
                        <p className="mt-2 text-xs text-amber-300">
                          {entry.blockedReason}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Open ${entry.alias}`}
                      disabled={
                        busy ||
                        profiles.isPending ||
                        Boolean(profiles.error) ||
                        Boolean(entry.blockedReason)
                      }
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          const existing = profiles.data?.find(
                            (profile) =>
                              profile.name === entry.alias &&
                              profile.host ===
                                entry.host.toLowerCase().replace(/\.$/, "") &&
                              profile.port === entry.port &&
                              profile.username === entry.username,
                          );
                          const profile =
                            existing ??
                            (await sshApi.saveProfile({
                              id: null,
                              name: entry.alias,
                              host: entry.host,
                              port: entry.port,
                              username: entry.username,
                            }));
                          await queryClient.invalidateQueries({
                            queryKey: profileQueryKey,
                          });
                          onOpenServer(profile);
                          onOpenChange(false);
                        } catch (error) {
                          setError(safeError(error));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Open
                    </Button>
                  </div>
                ))}
            </section>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <h3 className="border-t pt-4 text-sm font-medium">
              Saved in VPS Pilot
            </h3>
            {profiles.isPending && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading saved profiles…
              </p>
            )}
            {profiles.error && (
              <p role="alert" className="text-sm text-destructive">
                {safeError(profiles.error)}
              </p>
            )}
            {!profiles.isPending &&
              !profiles.error &&
              !profiles.data?.length && (
                <div className="rounded-lg border border-dashed p-6 text-center">
                  <Server
                    className="mx-auto mb-3 size-6 text-primary"
                    aria-hidden="true"
                  />
                  <p className="text-sm">No saved servers yet</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Add a new connection or choose an SSH config entry above.
                  </p>
                </div>
              )}
            {profiles.data
              ?.filter((profile) => matches(profile.name, profile.host))
              .map((profile) => (
                <div
                  key={profile.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">
                      {profile.name}
                    </p>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {address(profile)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        onOpenServer(profile);
                        onOpenChange(false);
                      }}
                    >
                      Open
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`Edit ${profile.name}`}
                      onClick={() => {
                        setDraft({
                          id: profile.id,
                          name: profile.name,
                          host: profile.host,
                          port: profile.port,
                          username: profile.username,
                        });
                        setError("");
                      }}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`Remove ${profile.name} profile`}
                      onClick={() => {
                        setRemoving(profile);
                        setError("");
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Close
              </DialogClose>
            </DialogFooter>
          </div>
        )}
      </div>
    </DialogContent>
  );
}
