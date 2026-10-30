import { Expand, Minimize2, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";

/** Changes presentation in place so live terminal channels stay mounted. */
export function TerminalView({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [fullView, setFullView] = useState(false);
  const [optionsVisible, setOptionsVisible] = useState(true);
  const optionsId = useId();

  return (
    <section
      aria-label={label}
      className={`terminal-view flex min-h-96 flex-1 flex-col gap-3 ${fullView ? "terminal-view-full fixed inset-0 z-40 bg-background p-3" : ""}`}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b pb-2">
        <span className="min-w-0 break-words text-xs text-muted-foreground">
          {label}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={optionsVisible}
            aria-controls={optionsId}
            onClick={() => setOptionsVisible((visible) => !visible)}
          >
            <SlidersHorizontal aria-hidden="true" />
            {optionsVisible ? "Hide options" : "Show options"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-pressed={fullView}
            onClick={() => setFullView((full) => !full)}
          >
            {fullView ? (
              <Minimize2 aria-hidden="true" />
            ) : (
              <Expand aria-hidden="true" />
            )}
            {fullView ? "Exit full view" : "Full terminal view"}
          </Button>
        </div>
      </div>
      <div
        id={optionsId}
        className={`terminal-view-content flex min-h-0 flex-1 flex-col gap-3 ${optionsVisible ? "" : "terminal-options-hidden"}`}
      >
        {children}
      </div>
    </section>
  );
}
