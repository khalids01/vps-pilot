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
import type { ServerProfile } from "@/features/ssh/api";
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
  const [initial] = useState(load);
  const [data, setData] = useState<FleetData>(initial.data);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<ServerProfile | null>(null);
  useEffect(() => {
    if (dirty) writePreference(fleetKey, JSON.stringify(data));
  }, [data, dirty]);
  const metadata = (id: string) => data.servers[id] ?? emptyOrganization();
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
          onSave={(patch) => update(editing.id, patch)}
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
function OrganizationEditor({
  profile,
  value,
  onSave,
  onClose,
}: {
  profile: ServerProfile;
  value: Organization;
  onSave: (metadata: Organization) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [tags, setTags] = useState(value.tags.join(", "));
  const [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
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
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
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
            onSave(next);
            onClose();
          }}
        >
          <label htmlFor="fleet-project" className="block space-y-2 text-sm">
            <span>Project</span>
            <Input
              id="fleet-project"
              value={draft.project}
              maxLength={80}
              placeholder="e.g. Customer portal"
              onChange={(event) =>
                setDraft({ ...draft, project: event.target.value })
              }
            />
          </label>
          <label htmlFor="fleet-tags" className="block space-y-2 text-sm">
            <span>Tags</span>
            <Input
              id="fleet-tags"
              aria-describedby="fleet-tags-help"
              value={tags}
              maxLength={395}
              placeholder="api, database, eu-west"
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <p id="fleet-tags-help" className="text-xs text-muted-foreground">
            Separate tags with commas.
          </p>
          <div className="space-y-2">
            <span className="text-sm">Environment</span>
            <Select
              value={draft.environment}
              onValueChange={(environment) => {
                if (environment) setDraft({ ...draft, environment });
              }}
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
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit">Save organization</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
