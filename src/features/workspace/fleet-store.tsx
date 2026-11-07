import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  readPreference,
  writePreference,
} from "@/features/settings/persistence";
import {
  profileQueryKey,
  type ServerProfile,
  safeError,
  sshApi,
} from "@/features/ssh/api";
import {
  type Environment,
  emptyOrganization,
  environments,
  type FleetData,
  fleetKey,
  type Organization,
  sanitizeFleet,
} from "./fleet-data";

interface FleetContext {
  data: FleetData;
  error: string;
  metadata: (id: string) => Organization;
  update: (id: string, patch: Partial<Organization>) => void;
  reorder: (ids: string[]) => void;
  remove: (id: string) => void;
  edit: (profile: ServerProfile) => void;
}
const Context = createContext<FleetContext | null>(null);
export function useFleet() {
  const context = useContext(Context);
  if (!context) throw Error("Fleet metadata is not initialized.");
  return context;
}
function load() {
  try {
    const raw = readPreference(fleetKey);
    const data = raw
      ? sanitizeFleet(JSON.parse(raw))
      : { version: 1 as const, servers: {} };
    if (!data) throw Error("Invalid organization");
    return { data, error: "" };
  } catch {
    return {
      data: { version: 1 as const, servers: {} },
      error:
        "Saved server organization could not be read. Connection profiles are available.",
    };
  }
}
export function FleetProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [initial] = useState(load);
  const [data, setData] = useState<FleetData>(initial.data);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<ServerProfile | null>(null);
  useEffect(() => {
    if (dirty) writePreference(fleetKey, JSON.stringify(data));
  }, [data, dirty]);
  const metadata = (id: string) => data.servers[id] ?? emptyOrganization();
  const rename = async (profile: ServerProfile, name: string) => {
    const trimmed = name.trim();
    if (trimmed === profile.name) return;
    const updated = await sshApi.saveProfile({
      id: profile.id,
      name: trimmed,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      identityFile: profile.identityFile ?? null,
      passwordAllowed: profile.passwordAllowed !== false,
    });
    queryClient.setQueryData<ServerProfile[]>(profileQueryKey, (profiles) =>
      profiles?.map((item) => (item.id === updated.id ? updated : item)),
    );
    await queryClient.invalidateQueries({ queryKey: profileQueryKey });
  };
  const update = (id: string, patch: Partial<Organization>) => {
    setDirty(true);
    setData((old) => ({
      ...old,
      servers: {
        ...old.servers,
        [id]: { ...(old.servers[id] ?? emptyOrganization()), ...patch },
      },
    }));
  };
  return (
    <Context.Provider
      value={{
        data,
        error: initial.error,
        metadata,
        update,
        edit: setEditing,
        reorder: (ids) => {
          setDirty(true);
          setData((old) => ({
            ...old,
            servers: {
              ...old.servers,
              ...Object.fromEntries(
                ids.map((id, order) => [
                  id,
                  { ...(old.servers[id] ?? emptyOrganization()), order },
                ]),
              ),
            },
          }));
        },
        remove: (id) => {
          setDirty(true);
          setData((old) => {
            const servers = { ...old.servers };
            delete servers[id];
            return { ...old, servers };
          });
        },
      }}
    >
      {children}
      {editing && (
        <OrganizationEditor
          key={editing.id}
          profile={editing}
          value={metadata(editing.id)}
          onSave={async (patch, name) => {
            await rename(editing, name);
            update(editing.id, patch);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </Context.Provider>
  );
}
export function EnvironmentBadge({
  environment,
}: {
  environment: Environment;
}) {
  if (environment === "none") return null;
  const colors = {
    production: "border-red-400/30 bg-red-400/10 text-red-300",
    staging: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    development: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  };
  return (
    <span
      className={`inline-flex shrink-0 rounded border px-1.5 py-0.5 text-[10px] capitalize ${colors[environment]}`}
    >
      {environment}
    </span>
  );
}
function OrganizationField({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {help && (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );
}
function OrganizationEditor({
  profile,
  value,
  onSave,
  onClose,
}: {
  profile: ServerProfile;
  value: Organization;
  onSave: (metadata: Organization, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [name, setName] = useState(profile.name);
  const [tags, setTags] = useState(value.tags.join(", "));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Organize {profile.name}</DialogTitle>
          <DialogDescription>
            Saved on this device. Active server sessions stay open.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={async (event) => {
            event.preventDefault();
            const serverName = name.trim();
            const invalidName = Array.from(serverName).some((character) => {
              const code = character.charCodeAt(0);
              return code < 32 || (code >= 127 && code <= 159);
            });
            if (
              !serverName ||
              Array.from(serverName).length > 80 ||
              invalidName
            ) {
              setError("Use a server name between 1 and 80 characters.");
              return;
            }
            const next = {
              ...draft,
              project: draft.project.trim(),
              tags: [
                ...new Set(
                  tags
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                ),
              ],
            };
            if (
              !sanitizeFleet({ version: 1, servers: { [profile.id]: next } })
            ) {
              setError(
                "Use a project up to 80 characters and up to 12 tags of 32 characters each.",
              );
              return;
            }
            setError("");
            setSaving(true);
            try {
              await onSave(next, serverName);
              onClose();
            } catch (saveError) {
              setError(safeError(saveError));
            } finally {
              setSaving(false);
            }
          }}
        >
          <OrganizationField
            id="fleet-name"
            label="Server name"
            help="Shown in fleet cards and VPS tabs. The address stays as connection detail."
          >
            <Input
              id="fleet-name"
              aria-describedby="fleet-name-help"
              value={name}
              required
              maxLength={80}
              disabled={saving}
              placeholder="e.g. Production web"
              onChange={(event) => setName(event.target.value)}
            />
          </OrganizationField>
          <OrganizationField
            id="fleet-project"
            label="Project grouping"
            help="Optional. Groups this server with related servers in Fleet."
          >
            <Input
              id="fleet-project"
              aria-describedby="fleet-project-help"
              value={draft.project}
              maxLength={80}
              disabled={saving}
              placeholder="e.g. Customer portal"
              onChange={(event) =>
                setDraft({ ...draft, project: event.target.value })
              }
            />
          </OrganizationField>
          <OrganizationField
            id="fleet-tags"
            label="Tags"
            help="Separate tags with commas."
          >
            <Input
              id="fleet-tags"
              aria-describedby="fleet-tags-help"
              value={tags}
              maxLength={395}
              disabled={saving}
              placeholder="api, database, eu-west"
              onChange={(event) => setTags(event.target.value)}
            />
          </OrganizationField>
          <div className="space-y-2">
            <span className="block text-sm font-medium">Environment</span>
            <Select
              value={draft.environment}
              onValueChange={(environment) => {
                if (environment) setDraft({ ...draft, environment });
              }}
              disabled={saving}
            >
              <SelectTrigger aria-label="Environment" className="w-full">
                <SelectValue>
                  {draft.environment === "none"
                    ? "Unassigned"
                    : draft.environment[0].toUpperCase() +
                      draft.environment.slice(1)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {environments.map((environment) => (
                  <SelectItem key={environment} value={environment}>
                    {environment === "none"
                      ? "Unassigned"
                      : environment[0].toUpperCase() + environment.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label
            htmlFor="fleet-favorite"
            className="flex items-center gap-2 text-sm"
          >
            <Checkbox
              id="fleet-favorite"
              checked={draft.favorite}
              disabled={saving}
              onCheckedChange={(favorite) => setDraft({ ...draft, favorite })}
            />
            Favorite server
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" disabled={saving} />}
            >
              Cancel
            </DialogClose>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save organization"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
