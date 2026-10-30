import { describe, expect, test } from "bun:test";
import { type MetricSample, metricPoint } from "./live-metrics-data";

const sample: MetricSample = {
  uptime: 100,
  cpuTotal: 1000,
  cpuIdle: 500,
  memoryTotal: 1000,
  memoryAvailable: 400,
  swapTotal: 100,
  swapFree: 50,
  networkInterface: "eth0",
  networkReceived: 100,
  networkSent: 200,
  diskRead: 1000,
  diskWritten: 2000,
  capacity: { total: 1000, free: 300, available: 200 },
  capacityAge: 0,
};
describe("live counter deltas", () => {
  test("warms up rates and uses elapsed server time rather than assuming the selected interval", () => {
    expect(metricPoint(null, sample).cpu).toBeNull();
    expect(metricPoint(null, sample).received).toBeNull();
    const point = metricPoint(sample, {
      ...sample,
      uptime: 102,
      cpuTotal: 1200,
      cpuIdle: 550,
      networkReceived: 500,
    });
    expect(point.cpu).toBe(75);
    expect(point.received).toBe(200);
    expect(point.memory).toBe(60);
    expect(point.disk).toBe(70);
  });
  test("counter resets, reconnect gaps, interface switches, and unsafe integers do not invent rates", () => {
    expect(
      metricPoint(sample, { ...sample, cpuTotal: 10, cpuIdle: 5 }).cpu,
    ).toBeNull();
    expect(
      metricPoint(sample, { ...sample, uptime: 140, networkReceived: 900 })
        .received,
    ).toBeNull();
    expect(
      metricPoint(sample, {
        ...sample,
        uptime: 102,
        networkInterface: "ens3",
        networkReceived: 900,
      }).received,
    ).toBeNull();
    expect(
      metricPoint(sample, { ...sample, uptime: 102, diskRead: 0 }).read,
    ).toBeNull();
    expect(
      metricPoint(sample, {
        ...sample,
        uptime: 102,
        networkReceived: Number.MAX_SAFE_INTEGER + 1,
      }).received,
    ).toBeNull();
  });
});
