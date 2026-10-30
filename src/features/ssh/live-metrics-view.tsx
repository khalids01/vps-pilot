import {
  ArrowDownUp,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { type StatId, useAppSettings } from "@/features/settings/app-settings";
import { useCommandActivity } from "./command-activity";
import { useLiveMetrics } from "./live-metrics";
import type { MetricPoint } from "./live-metrics-data";
import { formatBytes } from "./structured-report";

const percent = (value: number | null | undefined) =>
  value == null ? "—" : `${value.toFixed(1)}%`;
const bytes = (value: number | null | undefined) =>
  value == null ? "—" : formatBytes(value);
const speed = (value: number | null | undefined) =>
  value == null ? "—" : `${formatBytes(value)}/s`;

function Sparkline({
  values,
  label,
  percent: percentage = false,
}: {
  values: (number | null)[];
  label: string;
  percent?: boolean;
}) {
  const max = percentage
    ? 100
    : Math.max(1, ...values.filter((value): value is number => value !== null));
  const segments: string[] = [];
  let segment = "";
  values.forEach((value, index) => {
    if (value === null) {
      if (segment) segments.push(segment);
      segment = "";
      return;
    }
    segment += `${((index / Math.max(1, values.length - 1)) * 300).toFixed(2)},${(46 - Math.min(1, value / max) * 42).toFixed(2)} `;
  });
  if (segment) segments.push(segment);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 300 50"
      className="mt-3 h-12 w-full text-primary"
      preserveAspectRatio="none"
    >
      <path d="M0 48H300" stroke="currentColor" opacity="0.15" />
      {segments.map((points) => (
        <polyline
          key={points}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
function Resource({
  stat,
  title,
  value,
  detail,
  field,
  percentage,
  children,
}: {
  stat: StatId;
  title: string;
  value: string;
  detail: string;
  field: keyof MetricPoint;
  percentage?: boolean;
  children?: ReactNode;
}) {
  const { history } = useLiveMetrics();
  const { settings } = useAppSettings();
  if (!settings.visibleStats.includes(stat)) return null;
  return (
    <section className="rounded-lg border bg-background/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium">{title}</h3>
        <span className="text-sm font-semibold tabular-nums">{value}</span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>
      <Sparkline
        values={history.map((point) => point[field])}
        label={`${title} history, measured samples only`}
        percent={percentage}
      />
      {children}
    </section>
  );
}
export function LiveMetricsPanel({ expanded = false }: { expanded?: boolean }) {
  const live = useLiveMetrics();
  const { sample, point } = live;
  return (
    <div
      className={`grid gap-3 ${expanded ? "md:grid-cols-2 xl:grid-cols-3" : ""}`}
    >
      <p className="col-span-full text-xs text-muted-foreground">
        {live.fresh
          ? "Measured samples · up to 180 points · rates warm up after two samples"
          : "Not updating · last measurements may be stale"}
      </p>
      <Resource
        stat="cpu"
        title="CPU"
        value={percent(point?.cpu)}
        detail="Across all logical CPUs"
        field="cpu"
        percentage
      />
      <Resource
        stat="ram"
        title="RAM"
        value={percent(point?.memory)}
        detail={
          sample
            ? `${bytes(sample.memoryTotal - sample.memoryAvailable)} used / ${bytes(sample.memoryTotal)} total · swap ${bytes(sample.swapTotal - sample.swapFree)}`
            : "Waiting for memory counters"
        }
        field="memory"
        percentage
      />
      <Resource
        stat="storage"
        title="Root filesystem /"
        value={percent(point?.disk)}
        detail={
          sample?.capacity
            ? `${bytes(sample.capacity.total - sample.capacity.free)} used / ${bytes(sample.capacity.total)} total · ${bytes(sample.capacity.available)} available`
            : "Capacity unavailable"
        }
        field="disk"
        percentage
      >
        <p className="text-[10px] text-muted-foreground">
          Capacity cached for 60s
          {sample?.capacity ? ` · measured ${sample.capacityAge}s ago` : ""}. No
          directory scan.
        </p>
      </Resource>
      <Resource
        stat="diskIo"
        title="Disk activity"
        value={`R ${speed(point?.read)}`}
        detail={`Write ${speed(point?.written)} · base block devices; virtual/stacked devices excluded`}
        field="read"
      >
        <Sparkline
          values={live.history.map((value) => value.written)}
          label="Disk write rate history"
        />
      </Resource>
      <Resource
        stat="network"
        title="Network"
        value={`↓ ${speed(point?.received)}`}
        detail={`Upload ${speed(point?.sent)} · interface ${sample?.networkInterface ?? "unavailable"}`}
        field="received"
      >
        <Sparkline
          values={live.history.map((value) => value.sent)}
          label="Network upload rate history"
        />
      </Resource>
      {point && (
        <p className="col-span-full text-[10px] text-muted-foreground">
          Last sample {new Date(point.time).toLocaleTimeString()}. Charts are
          rendered on this computer.
        </p>
      )}
    </div>
  );
}
export function LiveMetricsBar() {
  const live = useLiveMetrics();
  const { settings } = useAppSettings();
  const log = useCommandActivity();
  const metricButtons = [
    {
      id: "cpu" as StatId,
      label: "CPU",
      width: "w-20",
      icon: Cpu,
      value: percent(live.point?.cpu),
      detail: "CPU use across all logical CPUs",
    },
    {
      id: "ram" as StatId,
      label: "RAM",
      width: "w-20",
      icon: MemoryStick,
      value: percent(live.point?.memory),
      detail: "Memory in use, excluding available memory",
    },
    {
      id: "storage" as StatId,
      label: "Storage",
      width: "w-24",
      icon: HardDrive,
      value: percent(live.point?.disk),
      detail: "Root filesystem capacity used; refreshed once a minute",
    },
    {
      id: "diskIo" as StatId,
      label: "Disk I/O",
      width: "w-32",
      icon: ArrowDownUp,
      value: `R ${speed(live.point?.read)}`,
      detail: `Read ${speed(live.point?.read)}, write ${speed(live.point?.written)}`,
    },
    {
      id: "network" as StatId,
      label: "Network",
      width: "w-56",
      icon: Network,
      value: `↓ ${speed(live.point?.received)} ↑ ${speed(live.point?.sent)}`,
      detail: `Download ${speed(live.point?.received)}, upload ${speed(live.point?.sent)}`,
    },
  ];
  return (
    <section
      aria-label="Live server metrics"
      className="flex min-w-0 max-w-full flex-wrap items-center gap-1"
    >
      <Popover>
        {metricButtons
          .filter((item) => settings.visibleStats.includes(item.id))
          .map(({ label, icon: Icon, value, detail, width }) => (
            <Tooltip
              key={label}
              content={`${label}: ${value}. ${detail ?? ""}. Click for details. ${live.fresh ? "" : "Last result; monitoring is paused or starting."}`}
            >
              <PopoverTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`${label} live metrics details`}
                    className={`h-10 ${width} shrink-0 flex-col gap-0.5 overflow-hidden px-1 text-xs tabular-nums ${live.fresh ? "" : "text-muted-foreground"}`}
                  >
                    {label !== "Network" && (
                      <span className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground">
                        <Icon className="size-3!" />
                        {label}
                      </span>
                    )}
                    {label === "Network" ? (
                      <span className="grid w-full grid-cols-2 gap-1 text-center font-medium">
                        <span className="min-w-0">
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            Download
                          </span>
                          <span className="block truncate">
                            ↓ {speed(live.point?.received)}
                          </span>
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            Upload
                          </span>
                          <span className="block truncate">
                            ↑ {speed(live.point?.sent)}
                          </span>
                        </span>
                      </span>
                    ) : (
                      <span className="block w-full truncate text-center font-medium">
                        {value}
                      </span>
                    )}
                  </Button>
                }
              />
            </Tooltip>
          ))}
        <PopoverContent>
          <PopoverTitle className="mb-2 text-sm font-medium">
            Live resource usage
          </PopoverTitle>
          <p role="status" className="mb-3 text-xs text-muted-foreground">
            {live.state}
          </p>
          {live.runId && (
            <Button
              className="mb-3"
              size="xs"
              variant="ghost"
              onClick={() => log.reveal(live.runId ?? undefined)}
            >
              View sampler command
            </Button>
          )}
          <LiveMetricsPanel />
        </PopoverContent>
      </Popover>
    </section>
  );
}
