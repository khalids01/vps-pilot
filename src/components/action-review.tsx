import { CircleAlert, ShieldCheck } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ActionReviewProps {
  title: string;
  serverName: string;
  address: string;
  purpose: string;
  changes: string[];
  preserved: string[];
  blockedReason: string;
  disabledLabel: string;
  confirmation?: string;
  children?: ReactNode;
}

// A shared review surface, not an execution or sudo-approval implementation.
export function ActionReview({
  title,
  serverName,
  address,
  purpose,
  changes,
  preserved,
  blockedReason,
  disabledLabel,
  confirmation,
  children,
}: ActionReviewProps) {
  const [confirmed, setConfirmed] = useState(false);
  const confirmationId = useId();
  return (
    <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {serverName} · {address}
          <br />
          Sample review · no remote commands will run.
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
        <p className="text-sm leading-relaxed">{purpose}</p>
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Changes to review
          </h3>
          <ul className="list-disc space-y-2 pl-4 text-sm leading-relaxed">
            {changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </section>
        <section className="rounded-lg border bg-muted/30 p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            Preserved resources
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            {preserved.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
        {children}
        <section className="rounded-lg border bg-muted/40 p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <CircleAlert className="size-4 text-primary" aria-hidden="true" />
            Execution unavailable
          </h3>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {blockedReason}
          </p>
        </section>
        {confirmation && (
          <div className="flex items-start gap-3 rounded-lg border p-3">
            <Checkbox
              id={confirmationId}
              className="mt-0.5"
              checked={confirmed}
              onCheckedChange={setConfirmed}
            />
            <label htmlFor={confirmationId} className="text-xs leading-relaxed">
              {confirmation}
            </label>
          </div>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Reviewing this screen does not authorize a command. Every
          app-triggered sudo command will require a separate approval showing
          the server, exact command, and purpose.
        </p>
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          Close review
        </DialogClose>
        <Button disabled variant="secondary">
          {disabledLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
