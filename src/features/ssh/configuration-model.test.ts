import { expect, test } from "bun:test";
import {
  type ConfigurationEvidence,
  type ConfigurationReview,
  configurationQueryKey,
  evidenceStatus,
  reviewMatchesContext,
  setupStatus,
  setupSummary,
} from "./configuration-model";

test("incomplete configuration evidence never becomes a configured recommendation", () => {
  const evidence: ConfigurationEvidence = {
    id: "ssh",
    title: "SSH",
    state: "partial",
    values: { attention: "true" },
    message: null,
  };
  expect(evidenceStatus(undefined)).toBe("unknown");
  expect(evidenceStatus(evidence)).toBe("unknown");
  expect(evidenceStatus({ ...evidence, state: "unavailable" })).toBe("unknown");
  expect(evidenceStatus({ ...evidence, state: "ready" })).toBe("attention");
  expect(
    evidenceStatus({
      ...evidence,
      state: "ready",
      values: { attention: "false" },
    }),
  ).toBe("configured");
  expect(
    evidenceStatus({
      ...evidence,
      state: "ready",
      values: { attention: "yes" },
    }),
  ).toBe("configured");
});
const section = (
  values: Record<string, string>,
  state: ConfigurationEvidence["state"] = "ready",
): ConfigurationEvidence => ({
  id: "fixture",
  title: "Fixture",
  state,
  values,
  message: null,
});
test("Quick Setup status labels observed completeness without implying safety", () => {
  expect(setupStatus(undefined)).toBe("unchecked");
  expect(setupStatus(section({}, "partial"))).toBe("incomplete");
  expect(setupStatus(section({}, "unavailable"))).toBe("incomplete");
  expect(setupStatus(section({ attention: "true" }))).toBe("attention");
  expect(setupStatus(section({ attention: "false" }))).toBe("detected");
  expect(setupStatus(section({}))).toBe("detected");
});
test("Quick Setup summaries use only bounded observed fields", () => {
  expect(setupSummary("system", undefined)).toBe("Inspection needed");
  expect(
    setupSummary(
      "system",
      section({
        "Operating system": "Debian GNU/Linux 12",
        Timezone: "UTC",
        "Cached updates": "5 updates (cached)",
      }),
    ),
  ).toBe("Debian GNU/Linux 12 · Timezone UTC · 5 updates (cached)");
  expect(setupSummary("system", section({ Hostname: "fixture" }))).toBe(
    "Details unavailable",
  );
  expect(
    setupSummary(
      "essentials",
      section({ git: "/usr/bin/git", curl: "Not found", attention: "true" }),
    ),
  ).toBe("Git detected · curl not found");
  expect(setupSummary("essentials", section({ git: "/usr/bin/git" }))).toBe(
    "Git detected",
  );
  expect(setupSummary("ssh", section({ "Current user": "tester" }))).toBe(
    "User tester · Key verification unavailable",
  );
  expect(
    setupSummary(
      "ssh",
      section({ "Key authentication": "Not independently verified" }),
    ),
  ).toBe("Key verification: Not independently verified");
  expect(
    setupSummary(
      "security",
      section({
        "fail2ban.service ActiveState": "active",
        "apt-daily-upgrade.timer ActiveState": "active",
      }),
    ),
  ).toBe("fail2ban.service active · Unattended upgrades active");
  expect(
    setupSummary(
      "docker",
      section({ CLI: "/usr/bin/docker", "CLI version": "29.0" }),
    ),
  ).toBe("CLI /usr/bin/docker · 29.0");
  expect(
    setupSummary(
      "resources",
      section({ "Memory total": "8388608 KiB", "Swap total": "0 KiB" }),
    ),
  ).toBe("Memory 8 GiB · Swap 0 B");
  expect(setupSummary("resources", section({}))).toBe("Details unavailable");
});
test("Quick Setup summaries match the native probe projection", () => {
  expect(
    setupSummary(
      "essentials",
      section({
        Git: "/usr/bin/git",
        Curl: "/usr/bin/curl",
        Tar: "Not found in this user's PATH",
        Unzip: "Unknown",
        "CA certificate bundle": "/etc/ssl/certs/ca-certificates.crt",
        "Package git": "Installed version 2.39.5",
        "Git executable ownership": "Package git (exact path /usr/bin/git)",
        "Package curl": "Installed version 8.5.0",
        "Running status":
          "Installation does not prove a process is running or in use",
      }),
    ),
  ).toBe("Git detected · curl detected");
  expect(
    setupSummary(
      "essentials",
      section({
        Git: "Unknown",
        Curl: "Not found in this user's PATH",
      }),
    ),
  ).toBe("Git status unknown · curl not found");
  expect(
    setupSummary(
      "essentials",
      section({
        "Package git": "Installed version 2.39.5",
      }),
    ),
  ).toBe("Git package installed");
  expect(
    setupSummary(
      "essentials",
      section({
        "Package git":
          "Unknown; no package record returned (not proof it is absent)",
      }),
    ),
  ).toBe("Git status unknown");
  expect(
    setupSummary(
      "security",
      section({
        "Fail2ban installed": "Yes",
        "Security unit fail2ban.service":
          "LoadState=loaded ActiveState=active UnitFileState=enabled",
        "Security unit apt-daily-upgrade.timer":
          "LoadState=loaded ActiveState=inactive UnitFileState=static",
      }),
    ),
  ).toBe("fail2ban.service active · Unattended upgrades inactive");
  expect(
    setupSummary(
      "security",
      section({
        "Fail2ban installed": "Yes",
        "Security unit fail2ban.service":
          "LoadState=loaded UnitFileState=enabled",
      }),
    ),
  ).toBe("fail2ban.service state unknown");
  expect(
    setupSummary("security", section({ "Fail2ban installed": "Yes" })),
  ).toBe("Details unavailable");
});
test("configuration caches separate servers and authenticated connection generations", () => {
  expect(configurationQueryKey("alpha", "one")).not.toEqual(
    configurationQueryKey("beta", "one"),
  );
  expect(configurationQueryKey("alpha", "one")).not.toEqual(
    configurationQueryKey("alpha", "two"),
  );
});
const review = (
  overrides: Partial<ConfigurationReview> = {},
): ConfigurationReview => ({
  id: "review-1",
  profileId: "alpha",
  connectionId: "generation-1",
  profileRevision: "revision-1",
  snapshotId: "snapshot-1",
  observedAt: 1,
  expiresAt: 2,
  canExecute: false,
  items: [
    {
      id: "system",
      title: "System",
      evidenceState: "ready",
      blockers: ["Execution unavailable."],
      nextStep: "Verify directly.",
    },
    {
      id: "ssh",
      title: "Users and SSH",
      evidenceState: "partial",
      blockers: ["Execution unavailable.", "Partial."],
      nextStep: "Verify independently.",
    },
  ],
  ...overrides,
});
const context = {
  profileId: "alpha",
  connectionId: "generation-1",
  profileRevision: "revision-1",
  snapshotId: "snapshot-1",
  selected: ["system", "ssh"],
};
test("review guard binds identity, evidence, selection and disabled execution", () => {
  expect(reviewMatchesContext(review(), context)).toEqual({ ok: true });
  expect(
    reviewMatchesContext(review(), { ...context, selected: ["ssh", "system"] }),
  ).toEqual({ ok: true });
  expect(reviewMatchesContext(review({ canExecute: true }), context).ok).toBe(
    false,
  );
  expect(reviewMatchesContext(review({ profileId: "beta" }), context).ok).toBe(
    false,
  );
  expect(
    reviewMatchesContext(review({ connectionId: "generation-2" }), context).ok,
  ).toBe(false);
  expect(
    reviewMatchesContext(review({ profileRevision: "revision-2" }), context).ok,
  ).toBe(false);
  expect(
    reviewMatchesContext(review({ snapshotId: "snapshot-2" }), context).ok,
  ).toBe(false);
  expect(
    reviewMatchesContext(review(), { ...context, connectionId: null }).ok,
  ).toBe(false);
  expect(
    reviewMatchesContext(review(), { ...context, selected: ["system"] }).ok,
  ).toBe(false);
  expect(
    reviewMatchesContext(review(), {
      ...context,
      selected: ["system", "docker"],
    }).ok,
  ).toBe(false);
  expect(
    reviewMatchesContext(
      review({ items: [review().items[0], review().items[0]] }),
      context,
    ).ok,
  ).toBe(false);
});
test("ready evidence stays a review label and never becomes configured or executable", () => {
  const current = review();
  expect(current.canExecute).toBe(false);
  expect(current.items[0].evidenceState).toBe("ready");
  expect(reviewMatchesContext(current, context)).toEqual({ ok: true });
});
