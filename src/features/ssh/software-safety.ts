import { sections } from "./inspection-data";

export const catalogItems = [
  {
    id: "docker",
    name: "Docker Engine / Compose",
    scope: "System packages and dependent deployments",
  },
  {
    id: "nginx",
    name: "Nginx",
    scope: "System service and proxy configuration",
  },
  {
    id: "caddy",
    name: "Caddy",
    scope: "System service, configuration and certificates",
  },
  {
    id: "traefik",
    name: "Traefik",
    scope: "Standalone or platform-owned proxy",
  },
  {
    id: "dokploy",
    name: "Dokploy",
    scope: "Deployment platform and its containers",
  },
  { id: "git", name: "Git", scope: "System or user-owned executable" },
  {
    id: "node",
    name: "Node.js",
    scope: "Selected SSH user's runtime; preserve its default",
  },
  { id: "nvm", name: "nvm", scope: "Selected SSH user's runtime manager" },
  {
    id: "python",
    name: "Python",
    scope: "OS Python is protected; user environments are separate",
  },
  { id: "go", name: "Go", scope: "System or user-owned toolchain" },
  {
    id: "herdr",
    name: "Herdr",
    scope:
      "User installation; preserve installer / Homebrew / mise / Nix ownership",
  },
] as const;
export type CatalogId = (typeof catalogItems)[number]["id"];
export function softwareSafety(text: string, software: CatalogId) {
  const data = sections(text);
  const blockers: string[] = [];
  const unknowns: string[] = [];
  const os = data["Operating system"] ?? "";
  const distro = /^ID=(.+)$/m.exec(os)?.[1].replace(/"/g, "");
  const version = /^VERSION_ID=(.+)$/m.exec(os)?.[1].replace(/"/g, "");
  const candidate =
    (distro === "ubuntu" && version === "24.04") ||
    (distro === "debian" && version === "12");
  if (!candidate || !["x86_64", "aarch64"].includes(data.Architecture ?? ""))
    blockers.push(
      "System is outside the initial Ubuntu 24.04 / Debian 12 x86_64 and aarch64 candidate matrix. SSH terminals remain available.",
    );
  const proxy = ["nginx", "caddy", "traefik", "dokploy"].includes(software);
  const listeners = data.Listeners ?? "";
  const containers =
    data["Container reservations and platform ownership"] ?? "";
  if (
    proxy &&
    (/(?:[:\]])(?:80|443)\s/.test(listeners) ||
      /"HostPort"\s*:\s*"(?:80|443)"/.test(containers))
  ) {
    blockers.push(
      /dokploy/i.test(containers)
        ? "Dokploy-managed containers reserve web ports. Preserve the platform-owned proxy and deployments."
        : "An existing listener or container reserves port 80 or 443. Resolve ownership and coexistence before any proxy installation.",
    );
  }
  const path = data["Selected executable"];
  if (path && path !== "Not found on SSH user PATH")
    blockers.push(
      `Existing executable: ${path}. Its source and owner must be preserved; do not overwrite it.`,
    );
  if (software === "python")
    blockers.push(
      "System Python and OS package dependencies are protected. A separate user environment and exact Linux user must be selected.",
    );
  if (software === "herdr")
    unknowns.push(
      "Herdr release version, artifact integrity, existing sessions, and installation-manager ownership must be verified before install/update/removal.",
    );
  for (const key of [
    "Listeners",
    "Service reservations",
    "Container reservations and platform ownership",
    "Proxy configuration reservations",
    "Package ownership",
  ]) {
    if (!data[key] || data[key].includes("[section failed:"))
      unknowns.push(`${key} is unavailable or incomplete.`);
  }
  unknowns.push(
    "No validated installation/removal executor exists for this catalog entry. This report does not authorize a mutation.",
  );
  return {
    blockers,
    unknowns,
    status: blockers.length ? "Blocked" : "Needs verification",
  };
}
