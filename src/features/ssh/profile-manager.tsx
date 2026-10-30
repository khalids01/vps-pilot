import { useQueryClient } from "@tanstack/react-query";
import { open as chooseFile } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowUpRight,
  FolderOpen,
  Pencil,
  RefreshCw,
  Settings2,
  Star,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { matchesServer, sortFleet } from "@/features/workspace/fleet-data";
import { EnvironmentBadge, useFleet } from "@/features/workspace/fleet-store";
import {
  address,
  type ConfigHost,
  desktopAvailable,
  type ProfileInput,
  profileQueryKey,
  type ServerProfile,
  safeError,
  sshApi,
  useConfigHosts,
  useServerProfiles,
} from "./api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenServer: (profile: ServerProfile) => void;
  onDeleteServer: (profile: ServerProfile) => void;
  samples: { id: string; name: string; address: string }[];
  onOpenSample: (id: string) => void;
}
const blankProfile = (): ProfileInput => ({
  id: null,
  name: "",
  host: "",
  port: 22,
  username: "",
  identityFile: null,
  passwordAllowed: true,
});
export function ProfileManager(props: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      {props.open && (
        <ConnectionPicker {...props} busy={busy} setBusy={setBusy} />
      )}
    </Dialog>
  );
}
function ConnectionPicker({
  onOpenChange,
  onOpenServer,
  onDeleteServer,
  samples,
  onOpenSample,
  busy,
  setBusy,
}: Props & { busy: boolean; setBusy: (busy: boolean) => void }) {
  const fleet = useFleet();
  const [view, setView] = useState("connections");
  const [draft, setDraft] = useState<ProfileInput>(blankProfile);
  const [search, setSearch] = useState("");
  const [command, setCommand] = useState("");
  const [commandError, setCommandError] = useState("");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<ServerProfile | null>(null);
  const profiles = useServerProfiles();
  const config = useConfigHosts(view === "connections");
  const queryClient = useQueryClient();
  const matches = (name: string, host: string) =>
    `${name} ${host}`.toLowerCase().includes(search.trim().toLowerCase());
  const saved = sortFleet(profiles.data ?? [], fleet.data.servers).filter(
    (profile) => matchesServer(profile, fleet.metadata(profile.id), search),
  );
  const configured =
    config.data?.filter((profile) => matches(profile.alias, profile.host)) ??
    [];
  async function save(input: ProfileInput) {
    setBusy(true);
    setError("");
    try {
      const profile = await sshApi.saveProfile(input);
      await queryClient.invalidateQueries({ queryKey: profileQueryKey });
      onOpenServer(profile);
      onOpenChange(false);
    } catch (error) {
      setError(safeError(error));
    } finally {
      setBusy(false);
    }
  }
  async function openConfig(entry: ConfigHost) {
    const existing = profiles.data?.find(
      (profile) =>
        profile.name === entry.alias.trim() &&
        profile.host === entry.host.trim().toLowerCase().replace(/\.$/, "") &&
        profile.username === entry.username.trim() &&
        profile.port === entry.port &&
        (profile.identityFile ?? null) === (entry.identityFile ?? null) &&
        (profile.passwordAllowed !== false) ===
          (entry.passwordAllowed !== false),
    );
    if (existing) {
      onOpenServer(existing);
      onOpenChange(false);
      return;
    }
    await save({
      id: null,
      name: entry.alias,
      host: entry.host,
      username: entry.username,
      port: entry.port,
      identityFile: entry.identityFile ?? null,
      passwordAllowed: entry.passwordAllowed !== false,
    });
  }
  function changeView(value: string) {
    setView(value);
    setError("");
    setRemoving(null);
    setCommand("");
    setCommandError("");
    if (value === "new") setDraft(blankProfile());
  }
  return (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-5 p-6 sm:max-w-xl"
      showCloseButton={!busy}
    >
      <DialogHeader>
        <DialogTitle>
          {removing
            ? `Remove ${removing.name}?`
            : draft.id && view === "new"
              ? "Edit connection"
              : "Open connection"}
        </DialogTitle>
        <DialogDescription>
          {removing
            ? "Removes the saved profile from this app. Your server and SSH config stay unchanged."
            : "Choose a server or add a connection."}
        </DialogDescription>
      </DialogHeader>
      <Tabs
        value={view}
        className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-5"
        onValueChange={(value) => {
          if (!busy && typeof value === "string") changeView(value);
        }}
      >
        {!removing && (
          <TabsList aria-label="Connection source" className="w-full">
            <TabsTrigger value="connections" className="flex-1" disabled={busy}>
              Connections
            </TabsTrigger>
            <TabsTrigger
              value="new"
              className="flex-1"
              disabled={busy || !desktopAvailable}
            >
              New connection
            </TabsTrigger>
          </TabsList>
        )}
        <TabsContent value={view} className="min-h-0 overflow-y-auto">
          {removing ? (
            <div className="space-y-5">
              <p className="break-all font-mono text-xs text-muted-foreground">
                {address(removing)}
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
                  Remove connection
                </Button>
              </div>
            </div>
          ) : view === "new" ? (
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                void save(draft);
              }}
            >
              {!draft.id && (
                <div className="space-y-2 border-b pb-5">
                  <label htmlFor="ssh-command" className="text-sm">
                    Paste an SSH command
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="ssh-command"
                      className="min-w-0 font-mono text-xs"
                      placeholder="ssh deploy@example.com -p 2222"
                      value={command}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                      onChange={(event) => {
                        setCommand(event.target.value);
                        setCommandError("");
                      }}
                    />
                    <Button
                      variant="outline"
                      type="button"
                      disabled={busy || !command.trim()}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        setCommandError("");
                        try {
                          const parsed = await sshApi.parseCommand(command);
                          setDraft(parsed);
                          setCommand("");
                        } catch (error) {
                          setCommandError(safeError(error));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Fill details
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Fills the fields below. Nothing is executed.
                  </p>
                  {commandError && (
                    <p role="alert" className="text-sm text-destructive">
                      {commandError}
                    </p>
                  )}
                </div>
              )}
              <label className="block text-sm" htmlFor="profile-host">
                Host
                <Input
                  id="profile-host"
                  className="mt-2"
                  value={draft.host}
                  placeholder="example.com or 203.0.113.10"
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
              <div className="grid grid-cols-[1fr_7rem] gap-4">
                <label className="block text-sm" htmlFor="profile-user">
                  User
                  <Input
                    id="profile-user"
                    className="mt-2"
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
                  Port
                  <Input
                    id="profile-port"
                    className="mt-2"
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
              <label className="block text-sm" htmlFor="profile-name">
                Name
                <Input
                  id="profile-name"
                  className="mt-2"
                  value={draft.name}
                  placeholder="Production"
                  required
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </label>
              <div className="space-y-2">
                <label htmlFor="profile-key" className="text-sm">
                  Private key{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </label>
                <div className="flex gap-2">
                  <Input
                    id="profile-key"
                    className="min-w-0 font-mono text-xs"
                    value={draft.identityFile ?? ""}
                    placeholder="Use SSH agent or default keys"
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        identityFile: event.target.value || null,
                      })
                    }
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Choose private key"
                    disabled={busy}
                    onClick={async () => {
                      try {
                        const path = await chooseFile({
                          multiple: false,
                          directory: false,
                          title: "Choose SSH private key",
                        });
                        if (path) setDraft({ ...draft, identityFile: path });
                      } catch (error) {
                        setError(safeError(error));
                      }
                    }}
                  >
                    <FolderOpen aria-hidden="true" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Passwords and key passphrases are requested when connecting.
                </p>
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-between border-t pt-4">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => changeView("connections")}
                >
                  <ArrowLeft aria-hidden="true" />
                  Back
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Open workspace"}
                </Button>
              </div>
            </form>
          ) : (
            <div className="space-y-5">
              {!desktopAvailable && (
                <p className="text-sm text-muted-foreground">
                  SSH connections are available in the desktop app.
                </p>
              )}
              {desktopAvailable && (
                <>
                  <div className="flex gap-2">
                    <Input
                      aria-label="Search connections"
                      placeholder="Find a connection…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Refresh connections"
                      disabled={
                        busy || config.isFetching || profiles.isFetching
                      }
                      onClick={() => {
                        void config.refetch();
                        void profiles.refetch();
                      }}
                    >
                      <RefreshCw
                        className={config.isFetching ? "animate-spin" : ""}
                        aria-hidden="true"
                      />
                    </Button>
                  </div>
                  <section aria-label="SSH config connections">
                    <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                      SSH CONFIG
                    </h3>
                    {config.isPending && (
                      <p
                        role="status"
                        className="py-3 text-sm text-muted-foreground"
                      >
                        Reading ~/.ssh/config…
                      </p>
                    )}
                    {config.error && (
                      <p role="alert" className="py-3 text-sm text-destructive">
                        {safeError(config.error)}
                      </p>
                    )}
                    {!config.isPending &&
                      !config.error &&
                      !configured.length && (
                        <p className="py-3 text-sm text-muted-foreground">
                          {search
                            ? "No matches."
                            : "No named hosts in ~/.ssh/config."}
                        </p>
                      )}
                    <div className="divide-y">
                      {configured.map((entry) => (
                        <div key={entry.alias}>
                          <Button
                            variant="ghost"
                            className="h-auto w-full justify-between gap-3 rounded-none px-1 py-3 text-left"
                            aria-label={`Open ${entry.alias}`}
                            disabled={
                              busy ||
                              profiles.isPending ||
                              Boolean(profiles.error) ||
                              Boolean(entry.blockedReason)
                            }
                            onClick={() => void openConfig(entry)}
                          >
                            <span className="min-w-0">
                              <span className="block break-words">
                                {entry.alias}
                              </span>
                              <span className="mt-1 block break-all font-mono text-xs font-normal text-muted-foreground">
                                {address(entry)}
                              </span>
                            </span>
                            <ArrowUpRight
                              className="size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          </Button>
                          {entry.blockedReason && (
                            <p className="pb-3 text-xs text-amber-300">
                              {entry.blockedReason}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                  <section aria-label="App connections">
                    <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                      SAVED IN VPS PILOT
                    </h3>
                    {profiles.isPending && (
                      <p
                        role="status"
                        className="py-3 text-sm text-muted-foreground"
                      >
                        Loading connections…
                      </p>
                    )}
                    {profiles.error && (
                      <p role="alert" className="py-3 text-sm text-destructive">
                        {safeError(profiles.error)}
                      </p>
                    )}
                    {!profiles.isPending &&
                      !profiles.error &&
                      !saved.length && (
                        <p className="py-3 text-sm text-muted-foreground">
                          {search ? "No matches." : "No saved connections."}
                        </p>
                      )}
                    <div className="divide-y">
                      {saved.map((profile) => (
                        <div
                          key={profile.id}
                          className="flex items-center gap-1"
                        >
                          <Button
                            variant="ghost"
                            className="h-auto min-w-0 flex-1 justify-start rounded-none px-1 py-3 text-left"
                            disabled={busy}
                            aria-label={`Open ${profile.name}`}
                            onClick={() => {
                              onOpenServer(profile);
                              onOpenChange(false);
                            }}
                          >
                            <span className="min-w-0">
                              <span className="block break-words">
                                {fleet.metadata(profile.id).favorite && (
                                  <Star className="mr-1 inline size-3 fill-primary text-primary" />
                                )}
                                {profile.name}
                                <EnvironmentBadge
                                  environment={
                                    fleet.metadata(profile.id).environment
                                  }
                                />
                              </span>
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {[
                                  fleet.metadata(profile.id).project,
                                  ...fleet.metadata(profile.id).tags,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                              <span className="mt-1 block break-all font-mono text-xs font-normal text-muted-foreground">
                                {address(profile)}
                              </span>
                            </span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Organize ${profile.name}`}
                            disabled={busy}
                            onClick={() => fleet.edit(profile)}
                          >
                            <Settings2 />
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
                                identityFile: profile.identityFile ?? null,
                                passwordAllowed:
                                  profile.passwordAllowed !== false,
                              });
                              setView("new");
                              setError("");
                            }}
                          >
                            <Pencil aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy}
                            aria-label={`Remove ${profile.name}`}
                            onClick={() => {
                              setRemoving(profile);
                              setError("");
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </section>
                  {error && (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  )}
                </>
              )}
              {samples.length > 0 && (
                <details className="border-t pt-4 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    Sample workspaces
                  </summary>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {samples.map((sample) => (
                      <Button
                        key={sample.id}
                        size="sm"
                        variant="ghost"
                        onClick={() => onOpenSample(sample.id)}
                      >
                        {sample.name}
                      </Button>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </DialogContent>
  );
}
