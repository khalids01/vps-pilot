export type QuickSetupCatalogCategory =
  | "application"
  | "engine"
  | "editor"
  | "utility"
  | "runtime";
export interface QuickSetupCatalogEntry {
  id: string;
  label: string;
  category: QuickSetupCatalogCategory;
  description: string;
  executable: false;
  sourceStatus: "policy-only";
}
export const quickSetupSourcePolicy =
  "Source policy only: official release pages, URLs, versions, signatures and commands must be rechecked before any installer is implemented. This list is not a verified or executable installer.";
export const quickSetupCatalog = {
  dokploy: {
    id: "dokploy",
    label: "Dokploy",
    category: "application",
    description:
      "Guided Docker-based application platform. Docker is required; Podman is not a substitute.",
    executable: false,
    sourceStatus: "policy-only",
  },
  "javascript-pm2": {
    id: "javascript-pm2",
    label: "JavaScript / PM2",
    category: "application",
    description:
      "Node.js through NVM with PM2 process ownership and optional container tooling.",
    executable: false,
    sourceStatus: "policy-only",
  },
  containers: {
    id: "containers",
    label: "Container foundation",
    category: "application",
    description:
      "Docker or Podman foundation for other workloads. Application provisioning is not included.",
    executable: false,
    sourceStatus: "policy-only",
  },
  docker: {
    id: "docker",
    label: "Docker",
    category: "engine",
    description: "Container engine. Required by Dokploy.",
    executable: false,
    sourceStatus: "policy-only",
  },
  podman: {
    id: "podman",
    label: "Podman",
    category: "engine",
    description: "Optional container engine for compatible non-Dokploy stacks.",
    executable: false,
    sourceStatus: "policy-only",
  },
  neovim: {
    id: "neovim",
    label: "Neovim",
    category: "editor",
    description:
      "Latest compatible stable official Neovim release, with privileged editing through sudoedit.",
    executable: false,
    sourceStatus: "policy-only",
  },
  "lazyvim-starter": {
    id: "lazyvim-starter",
    label: "LazyVim starter",
    category: "editor",
    description:
      "Optional official starter configuration with an explicitly recorded revision.",
    executable: false,
    sourceStatus: "policy-only",
  },
  git: {
    id: "git",
    label: "Git",
    category: "utility",
    description: "Version control utility.",
    executable: false,
    sourceStatus: "policy-only",
  },
  curl: {
    id: "curl",
    label: "curl",
    category: "utility",
    description: "HTTP client utility.",
    executable: false,
    sourceStatus: "policy-only",
  },
  ripgrep: {
    id: "ripgrep",
    label: "ripgrep",
    category: "utility",
    description: "Recursive text search utility.",
    executable: false,
    sourceStatus: "policy-only",
  },
  fd: {
    id: "fd",
    label: "fd",
    category: "utility",
    description: "Fast file finder utility.",
    executable: false,
    sourceStatus: "policy-only",
  },
  fzf: {
    id: "fzf",
    label: "fzf",
    category: "utility",
    description: "Interactive fuzzy finder utility.",
    executable: false,
    sourceStatus: "policy-only",
  },
  jq: {
    id: "jq",
    label: "jq",
    category: "utility",
    description: "Structured JSON query utility.",
    executable: false,
    sourceStatus: "policy-only",
  },
  btop: {
    id: "btop",
    label: "btop",
    category: "utility",
    description: "Interactive resource monitor utility.",
    executable: false,
    sourceStatus: "policy-only",
  },
  unzip: {
    id: "unzip",
    label: "unzip",
    category: "utility",
    description: "Archive extraction utility.",
    executable: false,
    sourceStatus: "policy-only",
  },
  herdr: {
    id: "herdr",
    label: "Herdr",
    category: "utility",
    description:
      "Optional terminal multiplexer. Official installer verification is pending.",
    executable: false,
    sourceStatus: "policy-only",
  },
  bun: {
    id: "bun",
    label: "Bun",
    category: "runtime",
    description: "User-scoped JavaScript runtime and package manager.",
    executable: false,
    sourceStatus: "policy-only",
  },
  "nvm-node": {
    id: "nvm-node",
    label: "NVM + Node.js",
    category: "runtime",
    description:
      "Node.js through NVM with explicit shell and service integration.",
    executable: false,
    sourceStatus: "policy-only",
  },
  uv: {
    id: "uv",
    label: "uv",
    category: "runtime",
    description: "User-scoped Python tooling and environment manager.",
    executable: false,
    sourceStatus: "policy-only",
  },
} as const satisfies Record<string, QuickSetupCatalogEntry>;
export const quickSetupHerdr = {
  id: "herdr",
  label: "Herdr",
  installer: "pending-verification",
  reason:
    "Optional draft tool. Official installer source and version verification is pending.",
} as const;
export function quickSetupCatalogLabel(id: string) {
  return (
    (quickSetupCatalog as Record<string, QuickSetupCatalogEntry>)[id]?.label ??
    id
  );
}
