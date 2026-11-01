import { CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

const states = {
  unknown: { label: "Not inspected", icon: CircleDashed, style: "text-info" },
  configured: { label: "Inspected", icon: CircleCheck, style: "text-success" },
  partial: {
    label: "Partial evidence",
    icon: TriangleAlert,
    style: "text-warning",
  },
  unavailable: { label: "Unavailable", icon: CircleDashed, style: "text-info" },
  attention: {
    label: "Needs attention",
    icon: TriangleAlert,
    style: "text-warning",
  },
} as const;

/** Status is supplied by typed evidence, never inferred from display text. */
export function ConfigurationStatus({ state }: { state: keyof typeof states }) {
  const { label, icon: Icon, style } = states[state];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${style}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}

export function ConfigurationNotice({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <aside className="border-l-2 border-warning py-1 pl-4" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-1 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </aside>
  );
}
