import {
  ArrowDown,
  ArrowUp,
  FolderOpen,
  Plus,
  RefreshCw,
  Settings2,
  Star,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  address,
  type ConnectionStatus,
  type ServerProfile,
} from "@/features/ssh/api";
import { environments, matchesServer, sortFleet } from "./fleet-data";
import { EnvironmentBadge, useFleet } from "./fleet-store";
import { useFleetHealth } from "./health-cache";

export function FleetHome({
  profiles,
  statuses,
  onOpen,
  onAdd,
  onRefresh,
  loading,
  error,
}: {
  profiles: ServerProfile[];
  statuses: ConnectionStatus[];
  onOpen: (profile: ServerProfile) => void;
  onAdd: () => void;
  onRefresh: () => void;
  loading: boolean;
  error: string;
}) {
  const fleet = useFleet();
  const health = useFleetHealth((state) => state.servers);
  const [query, setQuery] = useState("");
  const [environment, setEnvironment] = useState("all");
  const [favorites, setFavorites] = useState(false);
  const sorted = sortFleet(profiles, fleet.data.servers);
  const filtered = sorted.filter((profile) => {
    const metadata = fleet.metadata(profile.id);
    return (
      matchesServer(profile, metadata, query) &&
      (!favorites || metadata.favorite) &&
      (environment === "all" || metadata.environment === environment)
    );
  });
  const projects = [
    ...new Set(filtered.map((profile) => fleet.metadata(profile.id).project)),
  ].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  return (
    <main
      aria-label="Server fleet"
      className="min-w-0 flex-1 overflow-y-auto p-5 sm:p-8"
    >
      <div className="mx-auto max-w-6xl space-y-7">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="mb-2 text-xs uppercase tracking-widest text-primary">
              Your infrastructure
            </p>
            <h1 className="text-2xl font-medium">Server fleet</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {profiles.length} saved servers ·{" "}
              {
                statuses.filter(
                  (status) =>
                    profiles.some(
                      (profile) => profile.id === status.profileId,
                    ) && status.status === "connected",
                ).length
              }{" "}
              connected ·{" "}
              {
                profiles.filter(
                  (profile) => fleet.metadata(profile.id).favorite,
                ).length
              }{" "}
              favorite
              {profiles.filter((profile) => fleet.metadata(profile.id).favorite)
                .length === 1
                ? ""
                : "s"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onRefresh} disabled={loading}>
              <RefreshCw />
              Refresh list
            </Button>
            <Button onClick={onAdd}>
              <Plus />
              Add server
            </Button>
          </div>
        </header>
        <p className="text-xs text-muted-foreground">
          Latest readings come from your open, connected workspaces. Each
          reading is timestamped. This page does not connect to or scan
          additional servers.
        </p>
        {(error || fleet.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error || fleet.error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Input
            aria-label="Search fleet"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search servers, projects, tags, or addresses…"
            className="min-w-44 flex-1"
          />
          <Select
            value={environment}
            onValueChange={(value) => {
              if (value) setEnvironment(value);
            }}
          >
            <SelectTrigger aria-label="Filter environment">
              <SelectValue>
                {environment === "all"
                  ? "All environments"
                  : environment === "none"
                    ? "Unassigned"
                    : environment[0].toUpperCase() + environment.slice(1)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All environments</SelectItem>
              {environments.map((item) => (
                <SelectItem key={item} value={item}>
                  {item === "none"
                    ? "Unassigned"
                    : item[0].toUpperCase() + item.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={favorites ? "secondary" : "outline"}
            aria-pressed={favorites}
            onClick={() => setFavorites(!favorites)}
          >
            <Star />
            Favorites only
          </Button>
        </div>
        {loading && !profiles.length && (
          <p role="status">Loading saved servers…</p>
        )}
        {!loading && !error && !profiles.length && (
          <section className="rounded-xl border border-dashed p-10 text-center">
            <FolderOpen className="mx-auto mb-4 text-primary" />
            <h2 className="text-lg font-medium">Bring your servers together</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Add a connection or import one from your SSH config, then organize
              it by project.
            </p>
            <Button className="mt-5" onClick={onAdd}>
              Choose a connection
            </Button>
          </section>
        )}
        {profiles.length > 0 && !filtered.length && (
          <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
            No servers match these filters.
          </p>
        )}
        {projects.map((project) => (
          <section
            key={project}
            aria-label={project ? `Project ${project}` : "Unassigned servers"}
            className="space-y-3"
          >
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <FolderOpen className="size-4 text-primary" />
              {project || "No project"}
              <span className="text-muted-foreground">
                (
                {
                  filtered.filter(
                    (profile) => fleet.metadata(profile.id).project === project,
                  ).length
                }
                )
              </span>
            </h2>
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {filtered
                .filter(
                  (profile) => fleet.metadata(profile.id).project === project,
                )
                .map((profile) => {
                  const metadata = fleet.metadata(profile.id);
                  const status = statuses.find(
                    (status) => status.profileId === profile.id,
                  );
                  const cached =
                    health[profile.id]?.revision === profile.revision
                      ? health[profile.id]
                      : undefined;
                  const siblings = sorted.filter((item) => {
                    const other = fleet.metadata(item.id);
                    return (
                      other.project === project &&
                      other.favorite === metadata.favorite
                    );
                  });
                  const index = siblings.findIndex(
                    (item) => item.id === profile.id,
                  );
                  const move = (direction: number) => {
                    const ids = siblings.map((item) => item.id);
                    [ids[index], ids[index + direction]] = [
                      ids[index + direction],
                      ids[index],
                    ];
                    fleet.reorder(ids);
                  };
                  const percent = (value: number | null) =>
                    value === null ? "—" : `${value.toFixed(0)}%`;
                  return (
                    <article
                      key={profile.id}
                      aria-label={`${profile.name} server`}
                      className="min-w-0 rounded-xl border bg-card p-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Button
                            variant="link"
                            className="h-auto max-w-full justify-start p-0 text-base"
                            onClick={() => onOpen(profile)}
                          >
                            <span className="truncate">{profile.name}</span>
                          </Button>
                          <p className="mt-1 break-all text-xs text-muted-foreground">
                            {address(profile)}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${metadata.favorite ? "Unfavorite" : "Favorite"} ${profile.name}`}
                          aria-pressed={metadata.favorite}
                          onClick={() =>
                            fleet.update(profile.id, {
                              favorite: !metadata.favorite,
                            })
                          }
                        >
                          <Star
                            className={
                              metadata.favorite
                                ? "fill-primary text-primary"
                                : "text-muted-foreground"
                            }
                          />
                        </Button>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span
                          className={`text-xs capitalize ${status?.status === "connected" ? "text-primary" : "text-muted-foreground"}`}
                        >
                          {status?.status ?? "Status unavailable"}
                        </span>
                        <EnvironmentBadge environment={metadata.environment} />
                        {metadata.tags.map((tag) => (
                          <span
                            key={tag}
                            className="max-w-full break-words rounded bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                      <div className="mt-4 rounded-lg bg-muted/20 p-3 text-xs text-muted-foreground">
                        {cached ? (
                          <>
                            <dl className="grid grid-cols-3 gap-2 tabular-nums">
                              <div>
                                <dt>CPU</dt>
                                <dd className="mt-1 text-foreground">
                                  {percent(cached.point.cpu)}
                                </dd>
                              </div>
                              <div>
                                <dt>RAM</dt>
                                <dd className="mt-1 text-foreground">
                                  {percent(cached.point.memory)}
                                </dd>
                              </div>
                              <div>
                                <dt>Storage</dt>
                                <dd
                                  className="mt-1 text-foreground"
                                  title={`Capacity observed ${new Date(cached.capacityTime).toLocaleString()}`}
                                >
                                  {percent(cached.point.disk)}
                                </dd>
                              </div>
                            </dl>
                            <p className="mt-3">
                              Cached · last sampled{" "}
                              <time
                                dateTime={new Date(
                                  cached.point.time,
                                ).toISOString()}
                              >
                                {new Date(cached.point.time).toLocaleString()}
                              </time>
                            </p>
                          </>
                        ) : (
                          "No cached health yet. Open and connect this server to collect readings."
                        )}
                      </div>
                      <div className="mt-4 flex items-center justify-between gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onOpen(profile)}
                        >
                          Open workspace
                        </Button>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={index === 0}
                            aria-label={`Move ${profile.name} earlier`}
                            onClick={() => move(-1)}
                          >
                            <ArrowUp />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={index === siblings.length - 1}
                            aria-label={`Move ${profile.name} later`}
                            onClick={() => move(1)}
                          >
                            <ArrowDown />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Organize ${profile.name}`}
                            onClick={() => fleet.edit(profile)}
                          >
                            <Settings2 />
                          </Button>
                        </div>
                      </div>
                    </article>
                  );
                })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
