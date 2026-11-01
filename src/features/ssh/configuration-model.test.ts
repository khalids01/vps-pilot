import { expect, test } from "bun:test";
import {
  type ConfigurationEvidence,
  type ConfigurationReview,
  configurationQueryKey,
  evidenceStatus,
  reviewMatchesContext,
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
