import { describe, expect, test } from "bun:test";
import { defaultPreferences, sanitizePreferences } from "./preferences";

describe("workspace preference boundaries", () => {
  test("fresh installations start on Home with no open server tabs", () => {
    const preferences = defaultPreferences();
    expect(preferences.page).toBe("fleet");
    expect(preferences.openServerIds).toEqual([]);
    expect(preferences.activeServerId).toBeNull();
  });
  test("restores known tabs in order and each server's own preferences", () => {
    const input = defaultPreferences();
    input.openServerIds = [
      "sample-development",
      "sample-staging",
      "sample-production",
    ];
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

  test("restores the non-secret sidebar collapse preference and defaults missing values", () => {
    const input = defaultPreferences();
    expect(input.sidebarCollapsed).toBe(false);
    expect(
      sanitizePreferences({ ...input, sidebarCollapsed: true })
        ?.sidebarCollapsed,
    ).toBe(true);
    expect(
      sanitizePreferences({ ...input, sidebarCollapsed: "yes" })
        ?.sidebarCollapsed,
    ).toBe(false);
    const legacy: Record<string, unknown> = { ...input };
    delete legacy.sidebarCollapsed;
    expect(sanitizePreferences(legacy)?.sidebarCollapsed).toBe(false);
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

test("untouched legacy demo startup opens Home without removing customized sessions", () => {
  const legacy = {
    ...defaultPreferences(),
    page: "server",
    openServerIds: [
      "sample-production",
      "sample-staging",
      "sample-development",
    ],
    activeServerId: "sample-production",
  };
  const result = sanitizePreferences(legacy);
  expect(result?.openServerIds).toEqual([]);
  expect(result?.page).toBe("fleet");
  expect(result?.activeServerId).toBeNull();
  legacy.servers["sample-production"].tool = "terminal";
  expect(sanitizePreferences(legacy)?.openServerIds).toEqual(
    legacy.openServerIds,
  );
});
