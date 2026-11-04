import {
  readPreference,
  writePreference,
} from "@/features/settings/persistence";

export const commandConsolePreferencePrefix = "vps-pilot:command-console:v1:";
export const commandConsoleMinHeight = 144;
export const commandConsoleMaxHeight = 600;
export const commandConsoleDefaultHeight = 280;
export interface CommandConsolePreference {
  version: 1;
  expanded: boolean;
  height: number;
}
export function commandConsolePreferenceKey(serverId: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    serverId,
  )
    ? `${commandConsolePreferencePrefix}${serverId}`
    : null;
}
export function defaultCommandConsolePreference(): CommandConsolePreference {
  return {
    version: 1,
    expanded: false,
    height: commandConsoleDefaultHeight,
  };
}
export function sanitizeCommandConsolePreference(
  value: unknown,
): CommandConsolePreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.expanded !== "boolean" ||
    typeof record.height !== "number" ||
    !Number.isInteger(record.height) ||
    record.height < commandConsoleMinHeight ||
    record.height > commandConsoleMaxHeight
  )
    return null;
  return {
    version: 1,
    expanded: record.expanded,
    height: record.height,
  };
}
export function readCommandConsolePreference(serverId: string) {
  const key = commandConsolePreferenceKey(serverId);
  if (!key) return defaultCommandConsolePreference();
  const raw = readPreference(key);
  if (!raw) return defaultCommandConsolePreference();
  try {
    return (
      sanitizeCommandConsolePreference(JSON.parse(raw)) ??
      defaultCommandConsolePreference()
    );
  } catch {
    return defaultCommandConsolePreference();
  }
}
export function writeCommandConsolePreference(
  serverId: string,
  value: CommandConsolePreference,
) {
  const key = commandConsolePreferenceKey(serverId);
  const clean = sanitizeCommandConsolePreference(value);
  if (!key || !clean) return;
  writePreference(key, JSON.stringify(clean));
}
