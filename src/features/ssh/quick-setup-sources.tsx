import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  quickSetupCatalogEntry,
  quickSetupPlannedSourceNotice,
} from "./quick-setup-catalog";
import type { QuickSetupResolvedItem } from "./quick-setup-model";

export function NoPlannedSource({ className }: { className?: string }) {
  return (
    <p
      className={`px-2 pb-2 text-xs leading-relaxed text-muted-foreground ${className ?? ""}`}
    >
      No verified installation source is available for this option.
    </p>
  );
}

export function PlannedSourceDisclosure({
  entryId,
  className,
  inline,
}: {
  entryId: string;
  className?: string;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  if (entryId === "") return null;
  const entry = quickSetupCatalogEntry(entryId);
  if (!entry) return <NoPlannedSource className={className} />;
  return (
    <div className={inline ? "contents" : className}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Source for ${entry.label}`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
        className={`-ml-2 h-7 text-xs text-muted-foreground ${
          inline ? "col-start-2 row-start-1 justify-self-end" : ""
        }`}
      >
        Source
      </Button>
      {open && (
        <div
          id={detailId}
          className={`space-y-1 text-xs leading-relaxed text-muted-foreground ${
            inline ? "col-span-2 row-start-2" : ""
          }`}
        >
          <p>
            <span className="font-medium text-foreground/80">
              Planned source:
            </span>{" "}
            {entry.plannedSource}
          </p>
          <p>
            {entry.documentation.map((url, index) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                aria-label={`${entry.label} official documentation${entry.documentation.length > 1 ? ` ${index + 1}` : ""}`}
                className="mr-2 inline-block text-primary underline underline-offset-2"
              >
                {entry.documentation.length > 1
                  ? `Official documentation ${index + 1}`
                  : "Official documentation"}
              </a>
            ))}
          </p>
          <p>{quickSetupPlannedSourceNotice}</p>
          {entry.sourceNote && (
            <p className="text-warning">{entry.sourceNote}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function QuickSetupResolvedSources({
  items,
}: {
  items: QuickSetupResolvedItem[];
}) {
  const headingId = `${useId()}-resolved-sources`;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-sm font-medium">
        Planned installation sources
      </h3>
      {items.length ? (
        <ul className="divide-y divide-border/70 border-y border-border/70">
          {items.map((item) => (
            <li key={item.id} className="space-y-0.5 py-2">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm">{item.label}</span>
                <span className="text-xs text-muted-foreground">
                  {item.sources.join(" · ")}
                </span>
              </div>
              <PlannedSourceDisclosure entryId={item.id} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          No catalog items selected.
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {quickSetupPlannedSourceNotice}
      </p>
    </section>
  );
}
