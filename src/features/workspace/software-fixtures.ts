// UI fixtures only. No package support, discovery, or preflight is implemented.
export const softwareCategories = [
  "All",
  "Containers",
  "Proxies",
  "Deployment",
  "Developer tools",
] as const;
export type SoftwareCategory = (typeof softwareCategories)[number];
export type SoftwareStatus =
  | "Installed"
  | "Not installed"
  | "Conflict"
  | "Protected";

export interface SampleSoftware {
  id: string;
  name: string;
  category: Exclude<SoftwareCategory, "All">;
  status: SoftwareStatus;
  description: string;
  version: string | null;
  source: string;
  scope: string;
  location: string | null;
  protection?: string;
  conflicts?: { port: number; owner: string; purpose: string }[];
}

const docker: SampleSoftware = {
  id: "docker",
  name: "Docker + Compose",
  category: "Containers",
  status: "Installed",
  description: "Container engine and Compose plugin",
  version: "Engine 28.0.4 · Compose 2.34.0",
  source: "Docker package repository",
  scope: "System-wide",
  location: "/usr/bin/docker",
  protection:
    "Running applications depend on Docker. Removal requires a dependency review and must preserve application volumes.",
};

const developerTools: SampleSoftware[] = [
  {
    id: "git",
    name: "Git",
    category: "Developer tools",
    status: "Installed",
    description: "Version control tools",
    version: "2.43.0",
    source: "OS package manager",
    scope: "System-wide",
    location: "/usr/bin/git",
  },
  {
    id: "node",
    name: "Node.js + nvm",
    category: "Developer tools",
    status: "Not installed",
    description: "Node.js runtime with per-user version management",
    version: null,
    source: "Not selected",
    scope: "Linux user must be selected",
    location: null,
  },
  {
    id: "python",
    name: "Python",
    category: "Developer tools",
    status: "Protected",
    description: "System runtime managed by the operating system",
    version: "3.12.3",
    source: "OS package manager",
    scope: "System-wide",
    location: "/usr/bin/python3",
    protection:
      "This Python installation belongs to the operating system. Replacing or removing it can break system tools. App-managed removal is blocked.",
  },
  {
    id: "go",
    name: "Go",
    category: "Developer tools",
    status: "Not installed",
    description: "Go compiler and toolchain",
    version: null,
    source: "Not selected",
    scope: "Installation scope must be selected",
    location: null,
  },
];

function nginx(owner: string): SampleSoftware {
  return {
    id: "nginx",
    name: "Nginx",
    category: "Proxies",
    status: "Conflict",
    description: "Default HTTP / HTTPS ports are already occupied",
    version: null,
    source: "Not selected",
    scope: "System service",
    location: null,
    conflicts: [
      { port: 80, owner, purpose: "HTTP routing" },
      { port: 443, owner, purpose: "HTTPS routing" },
    ],
  };
}

export const sampleCatalogs: Record<string, SampleSoftware[]> = {
  "sample-production": [
    docker,
    {
      id: "dokploy",
      name: "Dokploy",
      category: "Deployment",
      status: "Installed",
      description: "Deployment platform with its own Traefik proxy",
      version: "Not recorded in sample",
      source: "Existing deployment · installed outside VPS Pilot",
      scope: "Docker deployment",
      location: null,
      protection:
        "Dokploy owns its deployment and generated proxy configuration. VPS Pilot must respect that ownership before making changes.",
    },
    {
      id: "traefik",
      name: "Traefik",
      category: "Proxies",
      status: "Installed",
      description: "Dokploy-managed proxy · ports 80 / 443",
      version: "Not recorded in sample",
      source: "Managed by Dokploy",
      scope: "Container: dokploy-traefik",
      location: null,
      protection:
        "Manage routing through Dokploy. Direct edits or removal could interrupt its deployed applications.",
    },
    nginx("dokploy-traefik · managed by Dokploy"),
    ...developerTools,
  ],
  "sample-staging": [
    docker,
    {
      id: "caddy",
      name: "Caddy",
      category: "Proxies",
      status: "Installed",
      description: "Standalone reverse proxy · ports 80 / 443",
      version: "2.9.1",
      source: "Existing OS package installation",
      scope: "System service: caddy.service",
      location: "/usr/bin/caddy",
      protection:
        "Existing staging applications use this proxy. Configuration changes require backup and validation before reload.",
    },
    nginx("caddy.service · standalone Caddy"),
    ...developerTools,
  ],
  "sample-development": [],
};
