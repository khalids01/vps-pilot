import { expect, test } from "bun:test";
import { softwareSafety } from "./software-safety";

test("preflight blocks inactive platform port reservations and unsupported systems", () => {
  const text = `=== Operating system ===\nID=debian\nVERSION_ID="12"\n=== Architecture ===\nx86_64\n=== Container reservations and platform ownership ===\n/dokploy-traefik traefik {"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"80"}]} dokploy\n=== Selected executable ===\nNot found on SSH user PATH`;
  const report = softwareSafety(text, "nginx");
  expect(report.status).toBe("Blocked");
  expect(report.blockers.some((reason) => reason.includes("Dokploy"))).toBe(
    true,
  );
  expect(softwareSafety("", "git").status).toBe("Blocked");
});
test("absence of known conflicts never grants mutation permission", () => {
  const text =
    '=== Operating system ===\nID=ubuntu\nVERSION_ID="24.04"\n=== Architecture ===\naarch64\n=== Selected executable ===\nNot found on SSH user PATH';
  const report = softwareSafety(text, "herdr");
  expect(report.status).toBe("Needs verification");
  expect(
    report.unknowns.some((reason) => reason.includes("artifact integrity")),
  ).toBe(true);
  expect(
    report.unknowns.some((reason) => reason.includes("No validated")),
  ).toBe(true);
  expect(softwareSafety(text, "python").status).toBe("Blocked");
});
