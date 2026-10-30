export interface MetricSample {
  uptime: number;
  cpuTotal: number;
  cpuIdle: number;
  memoryTotal: number;
  memoryAvailable: number;
  swapTotal: number;
  swapFree: number;
  networkInterface: string | null;
  networkReceived: number | null;
  networkSent: number | null;
  diskRead: number | null;
  diskWritten: number | null;
  capacity: { total: number; free: number; available: number } | null;
  capacityAge: number;
}
export interface MetricPoint {
  time: number;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  received: number | null;
  sent: number | null;
  read: number | null;
  written: number | null;
}
function counter(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}
export function metricPoint(
  previous: MetricSample | null,
  sample: MetricSample,
): MetricPoint {
  const seconds = previous ? sample.uptime - previous.uptime : 0;
  const validDelta = seconds > 0 && seconds <= 30;
  const rate = (current: number | null, old: number | null) =>
    validDelta && counter(current) && counter(old) && current >= old
      ? (current - old) / seconds
      : null;
  let cpu: number | null = null;
  if (
    previous &&
    validDelta &&
    [
      sample.cpuTotal,
      sample.cpuIdle,
      previous.cpuTotal,
      previous.cpuIdle,
    ].every(counter)
  ) {
    const total = sample.cpuTotal - previous.cpuTotal;
    const idle = sample.cpuIdle - previous.cpuIdle;
    if (total > 0 && idle >= 0 && idle <= total) cpu = 100 * (1 - idle / total);
  }
  const sameInterface = previous?.networkInterface === sample.networkInterface;
  const fs = sample.capacity;
  return {
    time: Date.now(),
    cpu,
    memory:
      counter(sample.memoryTotal) &&
      sample.memoryTotal > 0 &&
      counter(sample.memoryAvailable) &&
      sample.memoryAvailable <= sample.memoryTotal
        ? 100 * (1 - sample.memoryAvailable / sample.memoryTotal)
        : null,
    disk:
      fs &&
      counter(fs.total) &&
      fs.total > 0 &&
      counter(fs.free) &&
      fs.free <= fs.total
        ? 100 * (1 - fs.free / fs.total)
        : null,
    received: sameInterface
      ? rate(sample.networkReceived, previous?.networkReceived ?? null)
      : null,
    sent: sameInterface
      ? rate(sample.networkSent, previous?.networkSent ?? null)
      : null,
    read: rate(sample.diskRead, previous?.diskRead ?? null),
    written: rate(sample.diskWritten, previous?.diskWritten ?? null),
  };
}
