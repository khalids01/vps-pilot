export function sections(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /^=== ([^\r\n]+) ===\r?$/gm;
  let previous: { name: string; start: number } | null = null;
  for (const match of text.matchAll(pattern)) {
    if (previous)
      result[previous.name] = text.slice(previous.start, match.index).trim();
    previous = { name: match[1], start: (match.index ?? 0) + match[0].length };
  }
  if (previous) result[previous.name] = text.slice(previous.start).trim();
  return result;
}
function available(value: string | undefined) {
  return value && !value.includes("[section failed:") ? value : undefined;
}
export type CpuSample = { total: number; idle: number };
export function cpuSample(text: string): CpuSample | null {
  const match = /^cpu\s+([\d ]+)\s*$/m.exec(text);
  if (!match) return null;
  const values = match[1].trim().split(/\s+/).slice(0, 8).map(Number);
  if (
    values.length < 4 ||
    values.some((v) => !Number.isSafeInteger(v) || v < 0)
  )
    return null;
  return {
    total: values.reduce((sum, v) => sum + v, 0),
    idle: values[3] + (values[4] ?? 0),
  };
}
export function cpuUsage(
  previous: CpuSample | null,
  current: CpuSample | null,
): number | null {
  if (!previous || !current) return null;
  const elapsed = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (elapsed <= 0 || idle < 0 || idle > elapsed) return null;
  return Math.round((1 - idle / elapsed) * 1000) / 10;
}
export function overviewData(text: string) {
  const data = sections(text);
  const memory = available(data["Memory (KiB)"]);
  const total = Number(/^MemTotal:\s+(\d+) kB$/m.exec(memory ?? "")?.[1]);
  const free = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(memory ?? "")?.[1]);
  const disk = available(data.Filesystems)
    ?.split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((fields) => fields.length === 6 && fields[5] === "/");
  const diskPercent =
    disk && /^\d+%$/.test(disk[4]) ? Number.parseInt(disk[4], 10) : null;
  const pretty = /^PRETTY_NAME=(.+)$/m
    .exec(available(data["Operating system"]) ?? "")?.[1]
    .replace(/^(["'])(.*)\1$/, "$2");
  return {
    os: pretty ?? "Unavailable",
    arch: available(data.Architecture) ?? "Unavailable",
    memory:
      Number.isFinite(total) &&
      Number.isFinite(free) &&
      total > 0 &&
      free >= 0 &&
      free <= total
        ? {
            totalKiB: total,
            usedKiB: total - free,
            percent: Math.round((1 - free / total) * 1000) / 10,
          }
        : null,
    diskPercent:
      diskPercent !== null && diskPercent >= 0 && diskPercent <= 100
        ? diskPercent
        : null,
    cpu: cpuSample(available(data["CPU counters"]) ?? ""),
    partial: text.includes("[section failed:"),
  };
}
