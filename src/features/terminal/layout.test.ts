import { describe, expect, test } from "bun:test";
import { sanitizeLayout } from "./layout";

function layout(serverId = "sample-production") {
  const id = `${serverId}:shell-one`;
  return {
    grid: {
      width: 800,
      height: 400,
      orientation: "HORIZONTAL",
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            size: 800,
            data: { id: "group-one", views: [id], activeView: id },
          },
        ],
      },
    },
    panels: {
      [id]: {
        id,
        contentComponent: "sample-terminal",
        title: "Shell 1",
        params: { serverId, kind: "shell" },
      },
    },
    activeGroup: "group-one",
  };
}

describe("sample terminal layout boundaries", () => {
  test("preserves a valid layout and excludes output and unrecognized parameters", () => {
    const input = layout();
    const panel = input.panels["sample-production:shell-one"];
    Object.assign(panel.params, {
      output: "must not persist",
      command: "must not persist",
      password: "must not persist",
    });
    Object.assign(input, {
      floatingGroups: [{}],
      popoutGroups: [{ url: "https://invalid.example" }],
    });
    const result = sanitizeLayout(input, "sample-production");
    expect(result?.panels[panel.id].params).toEqual({
      serverId: "sample-production",
      kind: "shell",
    });
    expect(result?.floatingGroups).toBeUndefined();
    expect(result?.popoutGroups).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("must not persist");
  });

  test("rejects cross-server panels and arbitrary component types", () => {
    expect(
      sanitizeLayout(layout("sample-staging"), "sample-production"),
    ).toBeNull();
    const input = layout();
    input.panels["sample-production:shell-one"].contentComponent =
      "arbitrary-component";
    expect(sanitizeLayout(input, "sample-production")).toBeNull();
  });

  test("rejects missing, duplicated, and unreferenced panels", () => {
    const input = layout();
    input.grid.root.data[0].data.views.push("missing-panel");
    expect(sanitizeLayout(input, "sample-production")).toBeNull();
    const duplicated = layout();
    duplicated.grid.root.data[0].data.views.push("sample-production:shell-one");
    expect(sanitizeLayout(duplicated, "sample-production")).toBeNull();
    const unreferenced = layout();
    unreferenced.grid.root.data = [];
    expect(sanitizeLayout(unreferenced, "sample-production")).toBeNull();
  });

  test("supports intentionally empty layouts and rejects invalid dimensions", () => {
    const empty = layout();
    empty.panels = {};
    empty.grid.root.data = [];
    expect(sanitizeLayout(empty, "sample-production")?.panels).toEqual({});
    const invalid = layout();
    invalid.grid.width = Number.NaN;
    expect(sanitizeLayout(invalid, "sample-production")).toBeNull();
    expect(sanitizeLayout(null, "sample-production")).toBeNull();
  });

  test("rejects foreign-server parameters even with a matching panel ID", () => {
    const input = layout();
    input.panels["sample-production:shell-one"].params.serverId =
      "sample-staging";
    expect(sanitizeLayout(input, "sample-production")).toBeNull();
  });
});

test("remote layouts discard connection triggers and credentials and restore only their own server", () => {
  const layout = {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: {
              id: "group",
              views: ["remote:panel"],
              activeView: "remote:panel",
            },
          },
        ],
      },
      width: 800,
      height: 600,
      orientation: "HORIZONTAL",
    },
    panels: {
      "remote:panel": {
        id: "remote:panel",
        contentComponent: "terminal",
        title: "Shell",
        params: {
          serverId: "remote",
          kind: "shell",
          start: true,
          password: "discard-me",
          output: "discard-me",
        },
      },
    },
  };
  const sanitized = sanitizeLayout(layout, "remote", "remote");
  expect(sanitized?.panels["remote:panel"].params).toEqual({
    serverId: "remote",
    kind: "shell",
  });
  expect(sanitized?.panels["remote:panel"].tabComponent).toBe("session");
  expect(sanitizeLayout(layout, "foreign", "remote")).toBeNull();
  expect(sanitizeLayout(layout, "remote")).toBeNull();
});
