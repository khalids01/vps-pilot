import { ArrowDown, ArrowUp, CircleAlert, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { InspectionReport, InspectionSection } from "./report-types";

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
}
function cell(value: string, label: string) {
  if (label === "ID" && value.length > 20) return value.slice(0, 12);
  if (/(?:bytes|KiB)$/.test(label) && /^\d+$/.test(value))
    return formatBytes(Number(value) * (label.endsWith("KiB") ? 1024 : 1));
  return value || "—";
}
function Metric({
  label,
  value,
  percent,
  detail,
}: {
  label: string;
  value: string;
  percent?: number | null;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-3 text-2xl font-medium tracking-tight tabular-nums">
        {value}
      </p>
      {percent !== null && percent !== undefined && (
        <meter
          className="sr-only"
          min={0}
          max={100}
          value={percent}
          aria-label={label}
        />
      )}
      {percent !== null && percent !== undefined && (
        <div
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"
          aria-hidden="true"
        >
          <div
            className={`h-full rounded-full ${percent > 90 ? "bg-destructive" : "bg-primary"}`}
            style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
          />
        </div>
      )}
      {detail && (
        <p className="mt-3 text-[11px] text-muted-foreground">{detail}</p>
      )}
    </div>
  );
}
function badge(value: string) {
  const good = /^(active|running|up\b|enabled|loaded|allow)/i.test(value);
  const bad = /^(failed|dead|denied|deny|reject|error)/i.test(value);
  return (
    <span
      className={`inline-flex rounded-md px-2 py-1 text-[11px] ${good ? "bg-primary/10 text-primary" : bad ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}
    >
      {value || "Unknown"}
    </span>
  );
}
export function ReportSection({ section }: { section: InspectionSection }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{
    index: number;
    descending: boolean;
  } | null>(null);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    const filtered = section.rows
      .map((row) => {
        const identity = JSON.stringify(row);
        const occurrence = (counts.get(identity) ?? 0) + 1;
        counts.set(identity, occurrence);
        return { row, key: `${identity}:${occurrence}` };
      })
      .filter(({ row }) =>
        row.some((value) => value.toLowerCase().includes(query.toLowerCase())),
      );
    if (!sort) return filtered;
    return [...filtered].sort((a, b) => {
      const left = a.row[sort.index] ?? "";
      const right = b.row[sort.index] ?? "";
      const difference =
        left.trim() !== "" &&
        right.trim() !== "" &&
        Number.isFinite(Number(left)) &&
        Number.isFinite(Number(right))
          ? Number(left) - Number(right)
          : left.localeCompare(right, undefined, { numeric: true });
      return sort.descending ? -difference : difference;
    });
  }, [section.rows, query, sort]);
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / 25) - 1),
  );
  const visible = rows.slice(currentPage * 25, currentPage * 25 + 25);
  return (
    <section
      className="min-w-0 overflow-hidden rounded-xl border bg-card"
      aria-label={section.title}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{section.title}</h3>
          <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {section.rows.length}
            {section.truncated ? "+" : ""}
          </span>
          {section.state === "partial" && badge("Partial")}
        </div>
        {section.rows.length > 8 && (
          <div className="relative">
            <Search className="absolute top-2 left-2 size-3.5 text-muted-foreground" />
            <Input
              className="h-8 w-full pl-7 text-xs sm:w-52"
              aria-label={`Search ${section.title}`}
              placeholder="Filter results…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          </div>
        )}
      </div>
      {section.message && (
        <p
          className={`flex items-start gap-2 px-4 py-3 text-xs leading-relaxed ${section.state === "unavailable" || section.state === "partial" ? "bg-muted/40 text-muted-foreground" : "text-muted-foreground"}`}
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {section.message}
        </p>
      )}
      {visible.length ? (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b bg-muted/20 text-muted-foreground">
              <tr>
                {section.columns.map((column, index) => (
                  <th
                    key={column}
                    scope="col"
                    aria-sort={
                      sort?.index === index
                        ? sort.descending
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                    className="px-4 py-2 font-normal"
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() =>
                        setSort({
                          index,
                          descending:
                            sort?.index === index ? !sort.descending : false,
                        })
                      }
                    >
                      {column.replace(/ (?:bytes|KiB)$/, "")}
                      {sort?.index === index &&
                        (sort.descending ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ArrowUp className="size-3" />
                        ))}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map(({ row, key }) => (
                <tr key={key} className="hover:bg-muted/20">
                  {row.map((value, index) => (
                    <td
                      key={section.columns[index] ?? index}
                      className={`max-w-md px-4 py-3 align-top ${section.columns.length === 1 ? "whitespace-pre-wrap break-words" : "break-words"}`}
                      title={value}
                    >
                      {/^(Status|State|Boot state|Loaded|Action)$/.test(
                        section.columns[index] ?? "",
                      ) ? (
                        badge(value)
                      ) : /^(Used|CPU %|Memory %)$/.test(
                          section.columns[index] ?? "",
                        ) && /^\d+(?:\.\d+)?%?$/.test(value) ? (
                        <span className="tabular-nums">
                          {value}
                          {value.endsWith("%") ? "" : "%"}
                        </span>
                      ) : (
                        cell(value, section.columns[index] ?? "")
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !section.message && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {query
              ? "No matches for this filter."
              : section.state === "unavailable"
                ? "Unavailable. Open the command console for details."
                : section.title === "Failed services"
                  ? "No failed services reported."
                  : "No items found."}
          </p>
        )
      )}
      {(rows.length > 25 || section.truncated) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2">
          <span className="text-[11px] text-muted-foreground">
            {rows.length ? currentPage * 25 + 1 : 0}–
            {Math.min((currentPage + 1) * 25, rows.length)} of {rows.length}
            {section.truncated ? " · Result limit reached" : ""}
          </span>
          <div className="flex gap-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={!currentPage}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={(currentPage + 1) * 25 >= rows.length}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
export function StructuredReport({
  report,
  cpuPercent,
}: {
  report: InspectionReport;
  cpuPercent?: number | null;
}) {
  const overview = report.overview;
  const memory =
    overview?.memoryTotal !== null &&
    overview?.memoryTotal !== undefined &&
    overview.memoryTotal > 0 &&
    overview.memoryAvailable !== null &&
    overview.memoryAvailable >= 0 &&
    overview.memoryAvailable <= overview.memoryTotal
      ? {
          used: overview.memoryTotal - overview.memoryAvailable,
          total: overview.memoryTotal,
          percent: (1 - overview.memoryAvailable / overview.memoryTotal) * 100,
        }
      : null;
  const root = report.sections
    .find((section) => section.title === "Filesystems")
    ?.rows.find((row) => row[5] === "/");
  const disk =
    root && /^\d+%$/.test(root[4]) && Number.parseInt(root[4], 10) <= 100
      ? Number.parseInt(root[4], 10)
      : null;
  return (
    <div className="space-y-4">
      {overview && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              label="CPU"
              value={
                cpuPercent === null || cpuPercent === undefined
                  ? "Collecting…"
                  : `${cpuPercent}%`
              }
              percent={cpuPercent}
              detail={
                cpuPercent === null || cpuPercent === undefined
                  ? "Two completed samples are needed."
                  : "Usage between the last two samples"
              }
            />
            <Metric
              label="Memory"
              value={memory ? `${memory.percent.toFixed(1)}%` : "Unavailable"}
              percent={memory?.percent}
              detail={
                memory
                  ? `${formatBytes(memory.used)} of ${formatBytes(memory.total)}`
                  : undefined
              }
            />
            <Metric
              label="Root filesystem"
              value={disk === null ? "Unavailable" : `${disk}%`}
              percent={disk}
              detail={
                root
                  ? `${formatBytes(Number(root[2]) * 1024)} of ${formatBytes(Number(root[1]) * 1024)}`
                  : undefined
              }
            />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-1 text-xs text-muted-foreground">
            <span>{overview.os ?? "Operating system unavailable"}</span>
            <span>{overview.architecture ?? "Architecture unavailable"}</span>
          </div>
        </>
      )}
      {report.sections.map((section) => (
        <ReportSection key={section.title} section={section} />
      ))}
    </div>
  );
}
