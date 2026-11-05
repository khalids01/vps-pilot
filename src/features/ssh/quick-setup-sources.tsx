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

const documentationLinkLabels: Record<string, string> = {
  "https://docs.dokploy.com/docs/core/installation": "Dokploy installation",
  "https://github.com/nvm-sh/nvm": "NVM project",
  "https://nodejs.org/en/download": "Node.js downloads",
  "https://pm2.keymetrics.io/docs/usage/quick-start/": "PM2 quick start",
  "https://docs.docker.com/engine/install/": "Docker Engine installation",
  "https://podman.io/docs/installation": "Podman installation",
  "https://github.com/neovim/neovim/releases": "Neovim releases",
  "https://www.lazyvim.org/installation": "LazyVim installation",
  "https://github.com/LazyVim/starter": "LazyVim starter",
  "https://git-scm.com/install/linux": "Git for Linux",
  "https://curl.se/": "curl project",
  "https://github.com/BurntSushi/ripgrep": "ripgrep project",
  "https://github.com/sharkdp/fd": "fd project",
  "https://github.com/junegunn/fzf": "fzf project",
  "https://jqlang.org/": "jq project",
  "https://github.com/aristocratos/btop": "btop project",
  "https://infozip.sourceforge.net/UnZip.html": "UnZip project",
  "https://herdr.dev/tui/docs/install/": "Herdr TUI installation",
  "https://github.com/tmux/tmux": "tmux project",
  "https://github.com/sharkdp/bat": "bat project",
  "https://github.com/eza-community/eza": "eza project",
  "https://rsync.samba.org/": "rsync project",
  "https://direnv.net/": "direnv project",
  "https://bun.sh/docs/installation": "Bun installation",
  "https://docs.astral.sh/uv/getting-started/installation/": "uv installation",
  "https://docs.python.org/3/using/unix.html": "Python on Unix",
  "https://www.python.org/downloads/": "Official Python downloads",
  "https://go.dev/doc/install": "Go installation",
  "https://go.dev/dl/": "Official Go downloads",
};
function documentationLinkLabel(url: string) {
  return documentationLinkLabels[url] ?? new URL(url).hostname;
}
const resolvedSourceGroups = [
  { id: "application", title: "Application" },
  { id: "engine", title: "Container engine" },
  { id: "editor", title: "Editor" },
  { id: "utility", title: "Utilities" },
  { id: "runtime", title: "Runtimes" },
] as const;

export function QuickSetupResolvedSources({
  items,
}: {
  items: QuickSetupResolvedItem[];
}) {
  const headingId = `${useId()}-resolved-sources`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="text-sm font-medium">
        Planned installation sources
      </h3>
      {items.length ? (
        resolvedSourceGroups.map((group) => {
          const groupItems = items.filter(
            (item) =>
              (quickSetupCatalogEntry(item.id)?.category ?? "utility") ===
              group.id,
          );
          if (!groupItems.length) return null;
          return (
            <div key={group.id} className="space-y-1">
              <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.title}
              </h4>
              <ul className="divide-y divide-border/70 border-y border-border/70">
                {groupItems.map((item) => {
                  const entry = quickSetupCatalogEntry(item.id);
                  return (
                    <li key={item.id} className="py-2.5">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm">{item.label}</span>
                        <span className="text-xs text-muted-foreground">
                          {item.sources.join(" · ")}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        <span className="font-medium text-foreground/80">
                          Planned source:
                        </span>{" "}
                        {entry?.plannedSource ??
                          "No verified installation source is available."}
                      </p>
                      {entry?.documentation.length ? (
                        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                          {entry.documentation.map((url) => (
                            <a
                              key={url}
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary underline underline-offset-2"
                            >
                              {documentationLinkLabel(url)}
                            </a>
                          ))}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      ) : (
        <p className="text-xs text-muted-foreground">
          No catalog items selected.
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {quickSetupPlannedSourceNotice} Exact install commands stay unavailable
        until a native OS, version, checksum and preflight review produces them
        for your acceptance. Applying this plan would require accepting these
        sources or those reviewed commands; this review is not execution.
      </p>
    </section>
  );
}
