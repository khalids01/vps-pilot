import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { formatBytes } from "./structured-report";

export interface CleanupResource {
  kind: "image" | "container" | "network" | "volume";
  id: string;
  name: string;
  bytes: number | null;
  eligible: boolean;
  reason: string;
  references: string[];
  fingerprint: string;
  created?: string;
  stoppedAt?: string;
  project?: string;
}
export interface CleanupRequest {
  action: string;
  target: string;
  kind?: string;
  targets?: { id: string; kind: string }[];
  allImages?: boolean;
}
export interface CleanupResult {
  status: string;
  message: string;
  reclaimedBytes?: number | null;
  items?: {
    id: string;
    kind: string;
    name: string;
    status: string;
    message: string;
  }[];
}
const key = (r: CleanupResource) => `${r.kind}:${r.id}`;
const categories = [
  ["image", "Images"],
  ["container", "Stopped containers"],
  ["network", "Networks"],
  ["cache", "Build cache"],
] as const;
function age(r: CleanupResource, observedAt: number) {
  const date = Date.parse(r.stoppedAt || r.created || "");
  return Number.isFinite(date)
    ? `${Math.max(0, Math.floor((observedAt * 1000 - date) / 86400000))} days`
    : "Unknown";
}
export function DockerCleanup({
  resources,
  loaded,
  observedAt,
  busy,
  connected,
  onRefresh,
  onReview,
  cancelable,
  cancelRequested,
  result,
  progress,
}: {
  resources: CleanupResource[];
  loaded: boolean;
  observedAt: number;
  busy: boolean;
  connected: boolean;
  onRefresh: () => void;
  onReview: (request: CleanupRequest) => void;
  cancelable: boolean;
  cancelRequested: boolean;
  result: CleanupResult | null;
  progress: string;
}) {
  const id = useId();
  const [category, setCategory] = useState<string>("image"),
    [search, setSearch] = useState("");
  const [showProtected, setShowProtected] = useState(false),
    [allImages, setAllImages] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const eligible = resources.filter((r) => r.eligible && r.kind !== "volume");
  const selectedResources = eligible.filter((r) => selected.has(key(r)));
  const visible = resources.filter(
    (r) =>
      r.kind === category &&
      (showProtected || r.eligible) &&
      `${r.name} ${r.id} ${r.project || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const candidates = visible.filter((r) => r.eligible);
  const known = eligible.filter((r) => r.bytes !== null);
  const estimate = known.reduce((n, r) => n + (r.bytes || 0), 0);
  function toggle(r: CleanupResource, checked: boolean) {
    setSelected((old) => {
      const next = new Set(
        eligible.filter((item) => old.has(key(item))).map(key),
      );
      if (checked && next.size < 20) next.add(key(r));
      else if (!checked) next.delete(key(r));
      return next;
    });
  }
  return (
    <section aria-label="Docker cleanup" className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold">Clean up Docker</h3>
          <p className="text-sm text-muted-foreground">
            Review unused resources before removing them. Volumes stay
            protected.
          </p>
          {loaded && (
            <p className="text-xs text-muted-foreground">
              Updated {new Date(observedAt * 1000).toLocaleTimeString()}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          disabled={!connected || busy}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </header>
      <dl className="grid grid-cols-3 gap-4 border-y py-4">
        <div>
          <dt className="text-xs text-muted-foreground">Eligible items</dt>
          <dd className="mt-1 text-lg font-semibold">
            {loaded ? eligible.length : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            Potential cleanup size
          </dt>
          <dd className="mt-1 text-lg font-semibold">
            {!loaded
              ? "—"
              : !eligible.length
                ? "0 B"
                : known.length
                  ? formatBytes(estimate)
                  : "Unknown"}
          </dd>
          <p className="text-xs text-muted-foreground">
            Shared layers; {eligible.length - known.length} sizes unknown
          </p>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Selected</dt>
          <dd className="mt-1 text-lg font-semibold">
            {selectedResources.length}
            <span className="text-xs font-normal text-muted-foreground">
              {" "}
              / 20 max
            </span>
          </dd>
        </div>
      </dl>
      <nav
        aria-label="Cleanup categories"
        className="flex shrink-0 gap-2 overflow-x-auto pb-1"
      >
        {categories.map(([value, label]) => (
          <Button
            key={value}
            variant={category === value ? "secondary" : "ghost"}
            size="sm"
            aria-current={category === value ? "page" : undefined}
            onClick={() => setCategory(value)}
          >
            {label}
            {value !== "cache" && (
              <span className="text-xs text-muted-foreground">
                {eligible.filter((r) => r.kind === value).length}
              </span>
            )}
          </Button>
        ))}
      </nav>
      {category === "cache" ? (
        <div className="space-y-2 rounded-lg border p-5">
          <h4 className="font-medium">Build cache</h4>
          <p className="text-sm text-muted-foreground">
            Unused build cache can be cleared through Advanced cleanup below.
            Review system prune to inspect Docker's cache totals. Clearing it
            may make future builds slower; cache mounts can lose cached
            contents.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              aria-label="Search cleanup items"
              className="min-w-40 flex-1"
              placeholder="Search cleanup items…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <label htmlFor={id} className="flex items-center gap-2 text-sm">
              <Checkbox
                id={id}
                checked={showProtected}
                onCheckedChange={(v) => setShowProtected(v === true)}
              />
              Show protected items
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={
                busy || !candidates.length || selectedResources.length >= 20
              }
              onClick={() =>
                setSelected((old) => {
                  const next = new Set(
                    eligible.filter((r) => old.has(key(r))).map(key),
                  );
                  for (const r of candidates) {
                    if (next.size >= 20) break;
                    next.add(key(r));
                  }
                  return next;
                })
              }
            >
              Select eligible
            </Button>
          </div>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-left text-sm">
              <thead className="bg-card text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 p-3">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="p-3">Resource</th>
                  <th className="p-3">Size</th>
                  <th className="p-3">Age</th>
                  <th className="p-3">Details</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={key(r)} className="border-t">
                    <td className="p-3">
                      <Checkbox
                        aria-label={`Select ${r.name}`}
                        checked={r.eligible && selected.has(key(r))}
                        disabled={
                          !r.eligible ||
                          busy ||
                          (!selected.has(key(r)) &&
                            selectedResources.length >= 20)
                        }
                        onCheckedChange={(v) => toggle(r, v === true)}
                      />
                    </td>
                    <td className="max-w-80 p-3">
                      <Tooltip content={r.name}>
                        <p className="truncate font-medium">
                          {r.kind === "image" && r.name.startsWith("sha256:")
                            ? "Untagged image"
                            : r.name.replace(/^\//, "")}
                        </p>
                      </Tooltip>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {r.project ||
                          (r.kind === "container"
                            ? "Standalone container"
                            : r.kind === "image"
                              ? "Image"
                              : "Network")}
                      </p>
                      {!r.eligible && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {r.reason}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-3 text-xs">
                      {r.bytes === null ? "Unknown" : formatBytes(r.bytes)}
                    </td>
                    <td className="whitespace-nowrap p-3 text-xs">
                      {age(r, observedAt)}
                      {r.stoppedAt && (
                        <span className="block text-muted-foreground">
                          since stopped
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-xs">
                      <details>
                        <summary className="cursor-pointer">
                          View details
                        </summary>
                        <div className="mt-2 max-w-80 space-y-2 break-all">
                          <p>{r.id}</p>
                          <p>
                            {r.eligible
                              ? "Unused and at least seven days old."
                              : r.reason}
                          </p>
                          {r.references.length > 0 && (
                            <p>Used by {r.references.join(", ")}</p>
                          )}
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {!loaded
                  ? busy
                    ? "Loading cleanup resources…"
                    : "Use Refresh to load cleanup resources."
                  : showProtected
                    ? "No matching resources."
                    : "No eligible items in this category. Protected items are hidden."}
              </p>
            )}
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <div>
          <p className="text-sm">{selectedResources.length} items selected</p>
          <p className="text-xs text-muted-foreground">
            Seven-day minimum. Review exact targets before removal.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={busy || !selectedResources.length}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </Button>
          <Button
            disabled={busy || !connected || !selectedResources.length}
            onClick={() =>
              onReview({
                action: "cleanupBatch",
                target: "selected",
                targets: selectedResources.map((r) => ({
                  id: r.id,
                  kind: r.kind,
                })),
              })
            }
          >
            Review cleanup
          </Button>
        </div>
      </div>
      {(cancelable || result) && (
        <section
          aria-label="Cleanup result"
          className="space-y-3 rounded-lg border p-4"
        >
          {cancelable ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="status">
                {cancelRequested
                  ? "Stopping after the current item…"
                  : progress}
              </p>
            </div>
          ) : (
            <>
              <p className="font-medium">{result?.message}</p>
              <p className="text-sm text-muted-foreground">
                {result?.reclaimedBytes != null
                  ? `Docker reported reclaimed space: ${formatBytes(result.reclaimedBytes)}`
                  : "Actual reclaimed space was not reported. Resource sizes are estimates."}
              </p>
            </>
          )}
          {result?.items?.map((r) => (
            <div
              key={`${r.kind}:${r.id}`}
              className="flex flex-wrap justify-between gap-2 border-t pt-2 text-sm"
            >
              <span className="break-all">{r.name}</span>
              <span
                className={
                  ["failed", "uncertain"].includes(r.status)
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {r.status}
              </span>
              <p className="w-full text-xs text-muted-foreground">
                {r.message}
              </p>
            </div>
          ))}
        </section>
      )}
      <details className="rounded-xl border p-4">
        <summary className="cursor-pointer font-medium">
          Advanced cleanup · Docker system prune
        </summary>
        <div className="mt-5 space-y-4">
          <p className="text-sm text-muted-foreground">
            Prunes unused Docker data, including build cache. Containers, images
            and networks use a fixed seven-day creation cutoff. Global prune
            cannot exclude individual items, so protected workloads, shared data
            or rollback images can block it.
          </p>
          <label
            htmlFor={`${id}-all`}
            className="flex items-center gap-3 text-sm"
          >
            <Checkbox
              id={`${id}-all`}
              checked={allImages}
              disabled={busy}
              onCheckedChange={(v) => setAllImages(v === true)}
            />
            Also remove unused tagged images (--all)
          </label>
          <p className="text-xs text-muted-foreground">
            Off by default. Volumes are never included. There is no Docker dry
            run: the review is an estimate, not an exact deletion list. System
            prune cannot be canceled once submitted.
          </p>
          <Button
            variant="outline"
            disabled={!connected || busy}
            onClick={() =>
              onReview({ action: "systemPrune", target: "system", allImages })
            }
          >
            Review system prune
          </Button>
        </div>
      </details>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          Protected volumes (
          {resources.filter((r) => r.kind === "volume").length})
        </summary>
        <p className="mt-2">
          Persistent volumes are excluded from every cleanup action.
        </p>
        <div className="mt-2 space-y-1">
          {resources
            .filter((r) => r.kind === "volume")
            .map((r) => (
              <p key={r.id} className="break-all">
                {r.name}
              </p>
            ))}
        </div>
      </details>
    </section>
  );
}
