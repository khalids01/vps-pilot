import { expect, test } from "bun:test";
import {
  type ConfigurationEvidence,
  configurationQueryKey,
  evidenceStatus,
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
