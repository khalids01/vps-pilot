import { describe, expect, test } from "bun:test";
import { cpuUsage, overviewData, sections } from "./inspection-data";

describe("remote inspection data", () => {
  test("reports only measured values and distinguishes partial failures", () => {
    const data = overviewData(`=== Operating system ===
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
=== Architecture ===
x86_64
=== CPU counters ===
cpu 100 0 50 750 100 0 0 0 20 0
=== Memory (KiB) ===
MemTotal: 1000 kB
MemFree: 100 kB
MemAvailable: 250 kB
=== Filesystems ===
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 10000 4000 6000 40% /
=== Failed services ===
permission denied
[section failed: exit 1]`);
    expect(data.os).toBe("Debian GNU/Linux 12 (bookworm)");
    expect(data.memory?.percent).toBe(75);
    expect(data.diskPercent).toBe(40);
    expect(data.cpu).toEqual({ total: 1000, idle: 850 });
    expect(data.partial).toBe(true);
    expect(cpuUsage(data.cpu, { total: 1100, idle: 900 })).toBe(50);
  });
  test("missing, failed and malformed measurements remain unavailable", () => {
    expect(overviewData("").memory).toBeNull();
    expect(
      overviewData(
        "=== Memory (KiB) ===\nMemTotal: 1000 kB\nMemAvailable: 1500 kB",
      ).memory,
    ).toBeNull();
    expect(
      overviewData(
        "=== Filesystems ===\n/dev/vda1 100 50 50 50% /\n[section failed: exit 1]",
      ).diskPercent,
    ).toBeNull();
    expect(cpuUsage(null, { total: 10, idle: 5 })).toBeNull();
    expect(
      cpuUsage({ total: 20, idle: 10 }, { total: 10, idle: 5 }),
    ).toBeNull();
    expect(sections("no section output")).toEqual({});
  });
});
