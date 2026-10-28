import {
  CircleAlert,
  Container,
  Info,
  Network,
  Package,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { type ReactNode, useState } from "react";
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
import type { SampleServer } from "./fixtures";
import {
  type SampleSoftware,
  type SoftwareCategory,
  type SoftwareStatus,
  sampleCatalogs,
  softwareCategories,
} from "./software-fixtures";

function SoftwareStatusBadge({ status }: { status: SoftwareStatus }) {
  const needsAttention = status === "Conflict";
  const Icon = needsAttention
    ? CircleAlert
    : status === "Protected"
      ? ShieldCheck
      : null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${needsAttention ? "bg-destructive/10 text-destructive" : status === "Installed" ? "bg-primary/10 text-primary" : "bg-secondary text-secondary-foreground"}`}
    >
      {Icon && <Icon className="size-3.5" aria-hidden="true" />}
      {status}
    </span>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b py-3 last:border-0 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

function SoftwareReview({
  item,
  server,
}: {
  item: SampleSoftware;
  server: SampleServer;
}) {
  const isInstall =
    item.status === "Not installed" || item.status === "Conflict";
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isInstall ? `Review ${item.name} installation` : item.name}
        </DialogTitle>
        <DialogDescription>
          {server.name} · {server.address}
          <br />
          Sample review only. No commands will run.
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto pr-1">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {item.category} · sample inventory
          </span>
          <SoftwareStatusBadge status={item.status} />
        </div>
        {item.conflicts && (
          <section
            aria-label="Installation conflict"
            className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4"
          >
            <h3 className="flex items-center gap-2 text-sm font-medium text-destructive">
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
              Default installation blocked
            </h3>
            <p className="mt-2 text-sm leading-relaxed">
              Ports 80 and 443 already belong to an existing proxy on{" "}
              {server.name}. Starting Nginx with its default configuration could
              interrupt deployed applications.
            </p>
            <dl className="mt-3 divide-y divide-destructive/20">
              {item.conflicts.map((conflict) => (
                <div key={conflict.port} className="py-3">
                  <dt className="text-xs font-medium">
                    TCP {conflict.port} · {conflict.purpose}
                  </dt>
                  <dd className="mt-1 break-words text-xs text-muted-foreground">
                    {conflict.owner}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              VPS Pilot will not stop the existing proxy, overwrite its
              configuration, or move deployed applications to make this
              installation succeed.
            </p>
          </section>
        )}
        {item.protection && (
          <section className="mb-4 rounded-lg border bg-muted/40 p-4">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck
                className="size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              {item.status === "Protected"
                ? "OS-managed runtime"
                : "Existing installation ownership"}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {item.protection}
            </p>
          </section>
        )}
        <dl>
          <Detail label="Target server">
            {server.name}{" "}
            <span className="text-muted-foreground">· {server.address}</span>
          </Detail>
          <Detail label="Version">
            {item.version ?? "Must be selected before installation"}
          </Detail>
          <Detail label="Source / owner">{item.source}</Detail>
          <Detail label="Scope">{item.scope}</Detail>
          {item.location && (
            <Detail label="Executable">
              <code className="break-all text-xs">{item.location}</code>
            </Detail>
          )}
        </dl>
        {isInstall && !item.conflicts && (
          <section className="mt-4 rounded-lg border bg-muted/40 p-4">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Info
                className="size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              Installation checks are pending
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Before installation is available, VPS Pilot must verify OS
              support, existing installations, dependencies, paths, and service
              or port conflicts. Version, source, and installation scope must be
              chosen first.
            </p>
            {item.id === "node" && (
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                nvm belongs to a Linux user. The review must identify that user
                and must not silently change their default Node.js version.
              </p>
            )}
          </section>
        )}
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {isInstall
            ? "A real installation review will show exact changes and commands after server discovery. Every app-triggered sudo command needs its own approval."
            : "Management and uninstall are unavailable in this UI preview. Removal will require ownership and dependency checks, with configuration and application data preserved by default."}
        </p>
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          Close review
        </DialogClose>
        <Button
          disabled
          variant={item.status === "Conflict" ? "destructive" : "secondary"}
        >
          {item.status === "Conflict"
            ? "Install blocked"
            : item.status === "Protected"
              ? "Removal blocked"
              : isInstall
                ? "Install unavailable in preview"
                : "Management unavailable in preview"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function Software({
  server,
  category,
  onCategoryChange,
}: {
  server: SampleServer;
  category: SoftwareCategory;
  onCategoryChange: (category: SoftwareCategory) => void;
}) {
  const [reviewId, setReviewId] = useState<string | null>(null);
  const catalog = sampleCatalogs[server.id] ?? [];
  const review = catalog.find((item) => item.id === reviewId);
  const items = catalog.filter(
    (item) => category === "All" || item.category === category,
  );

  if (!server.available)
    return (
      <section className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
        <Unplug
          className="mb-4 size-7 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="text-lg font-medium">Software inventory unavailable</h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          This disconnected sample has no discovery data. Software status and
          installation checks remain unknown.
        </p>
      </section>
    );

  return (
    <>
      <fieldset
        className="mb-5 flex flex-wrap gap-2"
        aria-label="Software categories"
      >
        {softwareCategories.map((name) => (
          <Button
            key={name}
            size="sm"
            variant={category === name ? "secondary" : "ghost"}
            aria-pressed={category === name}
            onClick={() => onCategoryChange(name)}
          >
            {name}
          </Button>
        ))}
      </fieldset>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          {items.length} {items.length === 1 ? "entry" : "entries"} ·{" "}
          {server.name}
        </p>
        <p>Sample versions and ownership · no live discovery</p>
      </div>
      {items.length ? (
        <div className="divide-y rounded-xl border bg-card/60 px-4 sm:px-5">
          {items.map((item) => {
            const Icon =
              item.category === "Containers"
                ? Container
                : item.category === "Proxies"
                  ? Network
                  : Package;
            return (
              <article
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-4 py-5"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="rounded-lg bg-secondary p-2.5 text-primary">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-sm font-medium">{item.name}</h2>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {item.description}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {item.version ? `Sample: ${item.version}` : item.scope}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <SoftwareStatusBadge status={item.status} />
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`${item.status === "Conflict" ? "View conflict for" : item.status === "Not installed" ? "Review installation of" : "View details for"} ${item.name}`}
                    onClick={() => setReviewId(item.id)}
                  >
                    {item.status === "Conflict"
                      ? "View conflict"
                      : item.status === "Not installed"
                        ? "Review install"
                        : "Details"}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="rounded-xl border border-dashed p-8 text-center">
          <h2 className="text-sm font-medium">
            No sample entries in this category
          </h2>
          <p className="mt-2 text-xs text-muted-foreground">
            Choose another category to explore {server.name}'s inventory.
          </p>
        </section>
      )}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) setReviewId(null);
        }}
      >
        {review && (
          <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl">
            <SoftwareReview item={review} server={server} />
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
