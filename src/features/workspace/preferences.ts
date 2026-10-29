import { useEffect, useState } from "react";
import { sampleServers, type ToolId, toolIds } from "./fixtures";
import { type SoftwareCategory, softwareCategories } from "./software-fixtures";

export type HelperScenario = "not-installed" | "installed" | "update";
export interface ServerPreferences {
  tool: ToolId;
  commandExpanded: boolean;
  softwareCategory: SoftwareCategory;
  helperScenario: HelperScenario;
}
export interface WorkspacePreferences {
  version: 1;
  openServerIds: string[];
  activeServerId: string | null;
  servers: Record<string, ServerPreferences>;
}
export const workspacePreferenceKey = "vps-pilot:sample-workspace:v1";

export const isRemoteTabId = (id: string) =>
  /^remote:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    id,
  );
export const newServerPreferences = (): ServerPreferences => ({
  tool: "overview",
  commandExpanded: true,
  softwareCategory: "All",
  helperScenario: "not-installed",
});
export function defaultPreferences(): WorkspacePreferences {
  return {
    version: 1,
    openServerIds: sampleServers.map((server) => server.id),
    activeServerId: sampleServers[0].id,
    servers: Object.fromEntries(
      sampleServers.map((server) => [
        server.id,
        {
          tool: "overview",
          commandExpanded: true,
          softwareCategory: "All",
          helperScenario:
            server.id === "sample-staging"
              ? "update"
              : server.available
                ? "not-installed"
                : "installed",
        },
      ]),
    ),
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Persist UI preferences only. Reconstruct known sample IDs and fields instead
// of accepting arbitrary server profiles, credentials, or commands from storage.
export function sanitizePreferences(
  value: unknown,
): WorkspacePreferences | null {
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.openServerIds) ||
    value.openServerIds.length > 103
  )
    return null;
  const result = defaultPreferences();
  result.openServerIds = [
    ...new Set(
      value.openServerIds.filter(
        (id): id is string =>
          typeof id === "string" &&
          (isRemoteTabId(id) ||
            sampleServers.some((server) => server.id === id)),
      ),
    ),
  ];
  result.activeServerId =
    typeof value.activeServerId === "string" &&
    result.openServerIds.includes(value.activeServerId)
      ? value.activeServerId
      : (result.openServerIds[0] ?? null);
  for (const id of result.openServerIds)
    if (isRemoteTabId(id)) result.servers[id] = newServerPreferences();
  if (record(value.servers)) {
    for (const id of [
      ...new Set([...result.openServerIds, ...Object.keys(value.servers)]),
    ].slice(0, 128)) {
      if (isRemoteTabId(id)) result.servers[id] = newServerPreferences();
    }
    for (const id of Object.keys(result.servers)) {
      const raw = value.servers[id];
      if (!record(raw)) continue;
      const preference = result.servers[id];
      if (toolIds.some((tool) => tool === raw.tool))
        preference.tool = raw.tool as ToolId;
      if (typeof raw.commandExpanded === "boolean")
        preference.commandExpanded = raw.commandExpanded;
      if (
        softwareCategories.some((category) => category === raw.softwareCategory)
      )
        preference.softwareCategory = raw.softwareCategory as SoftwareCategory;
      if (
        raw.helperScenario === "not-installed" ||
        raw.helperScenario === "installed" ||
        raw.helperScenario === "update"
      )
        preference.helperScenario = raw.helperScenario;
    }
  }
  return result;
}
function loadPreferences(): {
  preferences: WorkspacePreferences;
  notice: string;
} {
  try {
    const raw = localStorage.getItem(workspacePreferenceKey);
    if (!raw) return { preferences: defaultPreferences(), notice: "" };
    const parsed =
      raw.length <= 64_000 ? sanitizePreferences(JSON.parse(raw)) : null;
    return {
      preferences: parsed ?? defaultPreferences(),
      notice: parsed
        ? ""
        : "Saved workspace preferences were invalid. The default sample workspace was restored.",
    };
  } catch {
    return {
      preferences: defaultPreferences(),
      notice:
        "Workspace preferences could not be read. Using the default sample workspace.",
    };
  }
}
export function useWorkspacePreferences() {
  const [initial] = useState(loadPreferences);
  const [preferences, setPreferences] = useState(initial.preferences);
  const [notice, setNotice] = useState(initial.notice);
  useEffect(() => {
    try {
      localStorage.setItem(workspacePreferenceKey, JSON.stringify(preferences));
    } catch {
      setNotice(
        "Workspace changes are kept for this session. Local saving is unavailable.",
      );
    }
  }, [preferences]);
  return { preferences, setPreferences, notice };
}
