import { Orientation, type SerializedDockview } from "dockview-react";
import { readPreference } from "@/features/settings/persistence";

export const MAX_SAMPLE_SESSIONS = 12;
export type SessionKind = "shell" | "logs";
export const layoutKey = (
  serverId: string,
  mode: "sample" | "remote" = "sample",
) => `vps-pilot:${mode}-terminal:v1:${serverId}`;

type GridNode = SerializedDockview["grid"]["root"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Rebuild only allowed layout metadata. Output, commands, credentials, foreign
// server panels, popouts, and arbitrary component parameters are never restored.
export function sanitizeLayout(
  value: unknown,
  serverId: string,
  mode: "sample" | "remote" = "sample",
): SerializedDockview | null {
  if (!record(value) || !record(value.panels) || !record(value.grid))
    return null;
  const entries = Object.entries(value.panels);
  if (entries.length > MAX_SAMPLE_SESSIONS) return null;
  const panels: SerializedDockview["panels"] = {};
  for (const [id, panel] of entries) {
    if (
      !id.startsWith(`${serverId}:`) ||
      id.length > 120 ||
      !record(panel) ||
      panel.id !== id ||
      panel.contentComponent !==
        (mode === "remote" ? "terminal" : "sample-terminal") ||
      !record(panel.params) ||
      panel.params.serverId !== serverId ||
      !(mode === "remote" ? ["shell"] : ["shell", "logs"]).includes(
        String(panel.params.kind),
      )
    )
      return null;
    panels[id] = {
      id,
      contentComponent: mode === "remote" ? "terminal" : "sample-terminal",
      ...(mode === "remote" ? { tabComponent: "session" } : {}),
      title:
        typeof panel.title === "string"
          ? panel.title.slice(0, 60)
          : "Sample terminal",
      params: { serverId, kind: panel.params.kind },
      renderer: "always",
      minimumWidth: 160,
      minimumHeight: 100,
    };
  }
  const seenPanels = new Set<string>();
  const seenGroups = new Set<string>();
  function gridNode(node: unknown, depth = 0): GridNode | null {
    if (!record(node) || depth > MAX_SAMPLE_SESSIONS) return null;
    const size =
      typeof node.size === "number" &&
      Number.isFinite(node.size) &&
      node.size >= 0
        ? node.size
        : undefined;
    if (
      node.type === "branch" &&
      Array.isArray(node.data) &&
      node.data.length <= MAX_SAMPLE_SESSIONS
    ) {
      const children = node.data.map((child) => gridNode(child, depth + 1));
      if (children.some((child) => child === null)) return null;
      return { type: "branch", data: children as GridNode[], size };
    }
    if (
      node.type !== "leaf" ||
      !record(node.data) ||
      typeof node.data.id !== "string" ||
      seenGroups.has(node.data.id) ||
      !Array.isArray(node.data.views) ||
      !node.data.views.length
    )
      return null;
    const views: string[] = [];
    for (const id of node.data.views) {
      if (
        typeof id !== "string" ||
        panels[id] === undefined ||
        seenPanels.has(id)
      )
        return null;
      seenPanels.add(id);
      views.push(id);
    }
    seenGroups.add(node.data.id);
    return {
      type: "leaf",
      size,
      data: {
        id: node.data.id,
        views,
        activeView:
          typeof node.data.activeView === "string" &&
          views.includes(node.data.activeView)
            ? node.data.activeView
            : views[0],
      },
    };
  }
  const root = gridNode(value.grid.root);
  if (!root || seenPanels.size !== entries.length) return null;
  const { width, height, orientation } = value.grid;
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0 ||
    (orientation !== Orientation.HORIZONTAL &&
      orientation !== Orientation.VERTICAL)
  )
    return null;
  return {
    grid: { root, width, height, orientation },
    panels,
    activeGroup:
      typeof value.activeGroup === "string" && seenGroups.has(value.activeGroup)
        ? value.activeGroup
        : undefined,
  };
}

export function readLayout(
  serverId: string,
  mode: "sample" | "remote" = "sample",
): {
  layout: SerializedDockview | null;
  notice?: string;
} {
  try {
    const raw = readPreference(layoutKey(serverId, mode));
    if (!raw) return { layout: null };
    if (raw.length > 128_000)
      return {
        layout: null,
        notice: "Saved layout was invalid. A fresh workspace was opened.",
      };
    const layout = sanitizeLayout(JSON.parse(raw), serverId, mode);
    return layout
      ? { layout }
      : {
          layout: null,
          notice: "Saved layout was invalid. A fresh workspace was opened.",
        };
  } catch {
    return {
      layout: null,
      notice: "Saved layout could not be read. Using a fresh workspace.",
    };
  }
}
