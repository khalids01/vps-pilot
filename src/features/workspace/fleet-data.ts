import type { ServerProfile } from "@/features/ssh/api";

export const fleetKey = "vps-pilot:fleet:v1";
export const environments = [
  "none",
  "production",
  "staging",
  "development",
] as const;
export type Environment = (typeof environments)[number];
export interface Organization {
  project: string;
  tags: string[];
  environment: Environment;
  favorite: boolean;
  order: number;
}
export interface FleetData {
  version: 1;
  servers: Record<string, Organization>;
}
export const emptyOrganization = (): Organization => ({
  project: "",
  tags: [],
  environment: "none",
  favorite: false,
  order: 0,
});
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" &&
  value.length <= limit &&
  !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
export function sanitizeFleet(value: unknown): FleetData | null {
  if (
    !record(value) ||
    value.version !== 1 ||
    !record(value.servers) ||
    Object.keys(value.servers).length > 100
  )
    return null;
  const servers: Record<string, Organization> = {};
  for (const [id, raw] of Object.entries(value.servers)) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        id,
      ) ||
      !record(raw) ||
      !text(raw.project, 80) ||
      !Array.isArray(raw.tags) ||
      raw.tags.length > 12 ||
      !raw.tags.every((tag) => text(tag, 32) && tag.trim().length > 0) ||
      typeof raw.favorite !== "boolean" ||
      !environments.includes(raw.environment as Environment) ||
      !Number.isInteger(raw.order) ||
      (raw.order as number) < 0 ||
      (raw.order as number) > 1000000
    )
      return null;
    servers[id] = {
      project: raw.project.trim(),
      tags: [...new Set(raw.tags.map((tag) => tag.trim()))],
      environment: raw.environment as Environment,
      favorite: raw.favorite,
      order: raw.order as number,
    };
  }
  return { version: 1, servers };
}
export function sortFleet(
  profiles: ServerProfile[],
  servers: FleetData["servers"],
) {
  return [...profiles].sort(
    (a, b) =>
      Number(servers[b.id]?.favorite ?? false) -
        Number(servers[a.id]?.favorite ?? false) ||
      (servers[a.id]?.order ?? 0) - (servers[b.id]?.order ?? 0) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}
export function matchesServer(
  profile: ServerProfile,
  organization: Organization,
  query: string,
) {
  const haystack =
    `${profile.name} ${profile.host} ${profile.username} ${organization.project} ${organization.tags.join(" ")} ${organization.environment}`.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}
