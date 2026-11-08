import { expect, test } from "bun:test";
import {
  freshSetupSnapshot,
  parseSetupCheckpoints,
  stepCategories,
  stepItems,
} from "./quick-setup-execution-model";
import { defaultQuickSetupDraft } from "./quick-setup-model";

test("step history never accepts verification claims, credentials or unknown fields", () => {
  const good = { version: 1, steps: [{ step: 2, at: 1000, phase: "scanned" }] };
  expect(parseSetupCheckpoints(JSON.stringify(good))).toEqual(good.steps);
  for (const phase of ["verified", "applied", "running", "failed"]) {
    expect(
      parseSetupCheckpoints(
        JSON.stringify({ ...good, steps: [{ ...good.steps[0], phase }] }),
      ),
    ).toBeNull();
  }
  for (const extra of [
    { password: "no" },
    { output: "no" },
    { command: "no" },
    { proofId: "no" },
  ]) {
    expect(
      parseSetupCheckpoints(JSON.stringify({ ...good, ...extra })),
    ).toBeNull();
    expect(
      parseSetupCheckpoints(
        JSON.stringify({ ...good, steps: [{ ...good.steps[0], ...extra }] }),
      ),
    ).toBeNull();
  }
  expect(
    parseSetupCheckpoints(
      JSON.stringify({ ...good, steps: [good.steps[0], good.steps[0]] }),
    ),
  ).toBeNull();
  expect(
    parseSetupCheckpoints(JSON.stringify({ ...good, version: 2 })),
  ).toBeNull();
  expect(parseSetupCheckpoints("bad")).toBeNull();
});
test("cached inspection cannot cross servers, connections or expiry boundaries", () => {
  const snapshot = {
    profileId: "a",
    connectionId: "one",
    observedAt: 1000,
    snapshotId: "x",
    sections: [],
  };
  expect(freshSetupSnapshot(snapshot, "a", "one", 1001)).toBe(true);
  expect(freshSetupSnapshot(snapshot, "b", "one", 1001)).toBe(false);
  expect(freshSetupSnapshot(snapshot, "a", "two", 1001)).toBe(false);
  expect(freshSetupSnapshot(snapshot, "a", null, 1001)).toBe(false);
  expect(freshSetupSnapshot(snapshot, "a", "one", 301000)).toBe(false);
  expect(freshSetupSnapshot(snapshot, "a", "one", 999)).toBe(false);
});
test("step reviews isolate software choices and cover all native preflight categories", () => {
  const draft = defaultQuickSetupDraft();
  draft.tools.utilities = ["git"];
  draft.runtimes = ["uv"];
  expect(stepItems({ ...draft, step: 6 }).map((item) => item.id)).toContain(
    "git",
  );
  expect(stepItems({ ...draft, step: 6 }).map((item) => item.id)).not.toContain(
    "uv",
  );
  expect(stepItems({ ...draft, step: 7 }).map((item) => item.id)).toEqual([
    "uv",
  ]);
  expect(stepCategories(4)).toEqual(["ssh", "security"]);
  expect(stepCategories(8)).toHaveLength(6);
});
