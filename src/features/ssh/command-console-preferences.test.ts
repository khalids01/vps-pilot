import { expect, test } from "bun:test";
import {
  commandConsolePreferenceKey,
  commandConsolePreferencePrefix,
  defaultCommandConsolePreference,
  sanitizeCommandConsolePreference,
} from "./command-console-preferences";

const server = "11111111-1111-4111-8111-111111111111";
test("command console preference keys require a real server UUID", () => {
  expect(commandConsolePreferenceKey(server)).toBe(
    `${commandConsolePreferencePrefix}${server}`,
  );
  expect(commandConsolePreferenceKey("not-a-uuid")).toBeNull();
  expect(commandConsolePreferenceKey("")).toBeNull();
  expect(commandConsolePreferenceKey("11111111-1111-4111-8111")).toBeNull();
});
test("command console preference sanitizer keeps only three safe values", () => {
  expect(defaultCommandConsolePreference()).toEqual({
    version: 1,
    expanded: false,
    height: 280,
  });
  expect(
    sanitizeCommandConsolePreference({
      version: 1,
      expanded: true,
      height: 144,
      command: "never persisted",
      output: "never persisted",
      message: "never persisted",
      cancelId: "never persisted",
      entries: [{ command: "never persisted" }],
    }),
  ).toEqual({ version: 1, expanded: true, height: 144 });
  expect(
    sanitizeCommandConsolePreference({
      version: 1,
      expanded: false,
      height: 600,
    }),
  ).toEqual({ version: 1, expanded: false, height: 600 });
});
test("command console preference sanitizer rejects invalid values and bounds", () => {
  for (const value of [
    null,
    undefined,
    "preference",
    [],
    {},
    { version: 2, expanded: true, height: 280 },
    { version: 1, expanded: "true", height: 280 },
    { version: 1, expanded: true, height: "280" },
    { version: 1, expanded: true, height: 280.5 },
    { version: 1, expanded: true, height: 143 },
    { version: 1, expanded: true, height: 601 },
    { version: 1, expanded: true, height: Number.NaN },
    { version: 1, expanded: true, height: Number.POSITIVE_INFINITY },
    { version: 1, expanded: true, height: -280 },
  ])
    expect(sanitizeCommandConsolePreference(value)).toBeNull();
});
