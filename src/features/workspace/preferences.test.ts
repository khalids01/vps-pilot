import { describe, expect, test } from "bun:test";
import { defaultPreferences, sanitizePreferences } from "./preferences";

describe("sample workspace preference boundaries", () => {
  test("restores known tabs in order and each server's own preferences", () => {
    const input = defaultPreferences();
    input.openServerIds.reverse();
    input.activeServerId = "sample-staging";
    input.servers["sample-production"].tool = "terminal";
    input.servers["sample-staging"].softwareCategory = "Proxies";
    expect(sanitizePreferences(input)).toEqual(input);
  });

  test("does not reopen intentionally closed tabs or retain an invalid active tab", () => {
    const input = defaultPreferences();
    input.openServerIds = [];
    expect(sanitizePreferences(input)?.activeServerId).toBeNull();
    input.openServerIds = ["sample-staging"];
    expect(sanitizePreferences(input)?.activeServerId).toBe("sample-staging");
  });

  test("filters duplicate and foreign profiles and discards unknown or secret fields", () => {
    const input = defaultPreferences();
    input.openServerIds = [
      "sample-staging",
      "foreign-server",
      "sample-staging",
    ];
    Object.assign(input, {
      credentials: "must not persist",
      commands: "must not persist",
    });
    Object.assign(input.servers["sample-staging"], {
      password: "must not persist",
    });
    const result = sanitizePreferences(input);
    expect(result?.openServerIds).toEqual(["sample-staging"]);
    expect(JSON.stringify(result)).not.toContain("must not persist");
  });

  test("restores safe defaults for invalid tools and scenarios", () => {
    const input = defaultPreferences();
    Object.assign(input.servers["sample-production"], {
      tool: "execute",
      helperScenario: "actually-install",
      softwareCategory: "arbitrary",
      commandExpanded: "yes",
    });
    const result = sanitizePreferences(input)?.servers["sample-production"];
    expect(result).toEqual(defaultPreferences().servers["sample-production"]);
  });

  test("rejects invalid or unsupported preference formats", () => {
    expect(sanitizePreferences(null)).toBeNull();
    expect(
      sanitizePreferences({ ...defaultPreferences(), version: 99 }),
    ).toBeNull();
    expect(
      sanitizePreferences({
        ...defaultPreferences(),
        openServerIds: "production",
      }),
    ).toBeNull();
  });
});

test("restores remote tab IDs and UI preferences without accepting connection metadata", () => {
  const id = "remote:e06e432d-5ca4-4394-8fb1-b96e24becd7f";
  const input = {
    ...defaultPreferences(),
    openServerIds: [id],
    activeServerId: id,
    servers: {
      [id]: {
        tool: "overview",
        commandExpanded: false,
        host: "not-ui-data",
        password: "must not persist",
      },
    },
  };
  const output = sanitizePreferences(input);
  expect(output?.activeServerId).toBe(id);
  expect(output?.servers[id].commandExpanded).toBe(false);
  expect(JSON.stringify(output)).not.toContain("not-ui-data");
  expect(JSON.stringify(output)).not.toContain("must not persist");
});
