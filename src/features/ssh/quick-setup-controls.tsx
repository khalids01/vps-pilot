import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

export function ChoiceGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <fieldset aria-label={label} className="min-w-0">
      <legend className="sr-only">{label}</legend>
      <div className="divide-y divide-border/70 border-y border-border/70">
        {children}
      </div>
    </fieldset>
  );
}

export function ChoiceRow({
  selected,
  label,
  description,
  disabled,
  onClick,
}: {
  selected: boolean;
  label: string;
  description?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className="flex h-auto w-full items-start justify-between gap-4 rounded-none px-2 py-3 text-left font-normal whitespace-normal aria-pressed:bg-muted/50"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        {description && (
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className={`mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border ${
          selected ? "border-primary" : "border-muted-foreground"
        }`}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
    </Button>
  );
}

export function CheckRow({
  id,
  label,
  hint,
  requiredNote,
  checked,
  disabled,
  className,
  onToggle,
}: {
  id: string;
  label: string;
  hint?: string;
  requiredNote?: string;
  checked: boolean;
  disabled?: boolean;
  className?: string;
  onToggle: () => void;
}) {
  const describedBy = [
    hint ? `${id}-hint` : null,
    requiredNote ? `${id}-required` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={`flex items-start justify-between gap-4 py-2.5 ${className ?? ""}`}
    >
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
        {hint && (
          <p
            id={`${id}-hint`}
            className="mt-0.5 text-xs leading-relaxed text-muted-foreground"
          >
            {hint}
          </p>
        )}
        {requiredNote && (
          <p id={`${id}-required`} className="mt-0.5 text-xs text-warning">
            {requiredNote}
          </p>
        )}
      </div>
      <Checkbox
        id={id}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy || undefined}
        onCheckedChange={onToggle}
        className="mt-0.5"
      />
    </div>
  );
}
