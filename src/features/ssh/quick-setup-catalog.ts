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
  plannedSource: string;
  documentation: readonly string[];
  sourceNote?: string;
  executable: false;
  sourceStatus: "policy-only";
}

const distributionSource =
  "Signed packages from the VPS distribution’s official repositories. Versions depend on its stable release.";

export const quickSetupSourcePolicy =
  "Source policy only: official release pages, URLs, versions, signatures and commands must be rechecked before any installer is implemented. This list is not a verified or executable installer.";
export const quickSetupPlannedSourceNotice =
  "Planned source only. The final version, checksum and exact command must be reviewed when installers are implemented.";
export const quickSetupCatalog = {
  dokploy: {
    id: "dokploy",
    label: "Dokploy",
    category: "application",
    description:
      "Guided Docker-based application platform. Docker is required; Podman is not a substitute.",
    plannedSource:
      "Official documented installation script; it also installs Docker when Docker is absent.",
    documentation: ["https://docs.dokploy.com/docs/core/installation"],
    executable: false,
    sourceStatus: "policy-only",
  },
  "javascript-pm2": {
    id: "javascript-pm2",
    label: "JavaScript / PM2",
    category: "application",
    description:
      "Node.js through NVM with PM2 process ownership and optional container tooling.",
    plannedSource:
      "Node.js stable LTS through the official NVM release, with PM2 from the official npm package.",
    documentation: [
      "https://github.com/nvm-sh/nvm",
      "https://nodejs.org/en/download",
      "https://pm2.keymetrics.io/docs/usage/quick-start/",
    ],
    executable: false,
    sourceStatus: "policy-only",
  },
  containers: {
    id: "containers",
    label: "Container foundation",
    category: "application",
    description:
      "Docker or Podman foundation for other workloads. Application provisioning is not included.",
    plannedSource:
      "Official Docker Engine stable repository or official Podman distribution packages.",
    documentation: [
      "https://docs.docker.com/engine/install/",
      "https://podman.io/docs/installation",
    ],
    executable: false,
    sourceStatus: "policy-only",
  },
  docker: {
    id: "docker",
    label: "Docker",
    category: "engine",
    description: "Container engine. Required by Dokploy.",
    plannedSource: "Official Docker Engine stable repository.",
    documentation: ["https://docs.docker.com/engine/install/"],
    executable: false,
    sourceStatus: "policy-only",
  },
  podman: {
    id: "podman",
    label: "Podman",
    category: "engine",
    description: "Optional container engine for compatible non-Dokploy stacks.",
    plannedSource: "Official Podman distribution packages.",
    documentation: ["https://podman.io/docs/installation"],
    executable: false,
    sourceStatus: "policy-only",
  },
  neovim: {
    id: "neovim",
    label: "Neovim",
    category: "editor",
    description:
      "Latest compatible stable official Neovim release, with privileged editing through sudoedit.",
    plannedSource:
      "Official latest compatible stable Neovim GitHub release; not a distro package or nightly build.",
    documentation: ["https://github.com/neovim/neovim/releases"],
    executable: false,
    sourceStatus: "policy-only",
  },
  "lazyvim-starter": {
    id: "lazyvim-starter",
    label: "LazyVim starter",
    category: "editor",
    description:
      "Optional official starter configuration with an explicitly recorded revision.",
    plannedSource:
      "Official LazyVim starter at a pinned revision verified before installation.",
    documentation: [
      "https://www.lazyvim.org/installation",
      "https://github.com/LazyVim/starter",
    ],
    executable: false,
    sourceStatus: "policy-only",
  },
  git: {
    id: "git",
    label: "Git",
    category: "utility",
    description: "Version control utility.",
    plannedSource: distributionSource,
    documentation: ["https://git-scm.com/install/linux"],
    executable: false,
    sourceStatus: "policy-only",
  },
  curl: {
    id: "curl",
    label: "curl",
    category: "utility",
    description: "HTTP client utility.",
    plannedSource: distributionSource,
    documentation: ["https://curl.se/"],
    executable: false,
    sourceStatus: "policy-only",
  },
  ripgrep: {
    id: "ripgrep",
    label: "ripgrep",
    category: "utility",
    description: "Recursive text search utility.",
    plannedSource: distributionSource,
    documentation: ["https://github.com/BurntSushi/ripgrep"],
    executable: false,
    sourceStatus: "policy-only",
  },
  fd: {
    id: "fd",
    label: "fd",
    category: "utility",
    description: "Fast file finder utility.",
    plannedSource: distributionSource,
    documentation: ["https://github.com/sharkdp/fd"],
    executable: false,
    sourceStatus: "policy-only",
  },
  fzf: {
    id: "fzf",
    label: "fzf",
    category: "utility",
    description: "Interactive fuzzy finder utility.",
    plannedSource: distributionSource,
    documentation: ["https://github.com/junegunn/fzf"],
    executable: false,
    sourceStatus: "policy-only",
  },
  jq: {
    id: "jq",
    label: "jq",
    category: "utility",
    description: "Structured JSON query utility.",
    plannedSource: distributionSource,
    documentation: ["https://jqlang.org/"],
    executable: false,
    sourceStatus: "policy-only",
  },
  btop: {
    id: "btop",
    label: "btop",
    category: "utility",
    description: "Interactive resource monitor utility.",
    plannedSource: distributionSource,
    documentation: ["https://github.com/aristocratos/btop"],
    executable: false,
    sourceStatus: "policy-only",
  },
  unzip: {
    id: "unzip",
    label: "unzip",
    category: "utility",
    description: "Archive extraction utility.",
    plannedSource:
      "Planned OS signed official distribution repository package (distro maintained; supported OS version candidate still to be determined).",
    documentation: ["https://infozip.sourceforge.net/UnZip.html"],
    executable: false,
    sourceStatus: "policy-only",
  },
  herdr: {
    id: "herdr",
    label: "Herdr",
    category: "utility",
    description:
      "Optional terminal multiplexer. Official installer verification is pending.",
    plannedSource:
      "User-confirmed official install documentation. Artifact version, integrity and installer verification remain pending.",
    documentation: ["https://herdr.dev/tui/docs/install/"],
    sourceNote: "Pending installer verification.",
    executable: false,
    sourceStatus: "policy-only",
  },
  tmux: {
    id: "tmux",
    label: "tmux",
    category: "utility",
    description: "Terminal multiplexer for persistent sessions.",
    plannedSource: distributionSource,
    documentation: ["https://github.com/tmux/tmux"],
    executable: false,
    sourceStatus: "policy-only",
  },
  bat: {
    id: "bat",
    label: "bat",
    category: "utility",
    description: "Syntax-highlighted file viewer.",
    plannedSource: distributionSource,
    documentation: ["https://github.com/sharkdp/bat"],
    executable: false,
    sourceStatus: "policy-only",
  },
  eza: {
    id: "eza",
    label: "eza",
    category: "utility",
    description: "Modern directory listing.",
    plannedSource: distributionSource,
    documentation: ["https://github.com/eza-community/eza"],
    executable: false,
    sourceStatus: "policy-only",
  },
  rsync: {
    id: "rsync",
    label: "rsync",
    category: "utility",
    description: "Incremental file transfer and synchronization.",
    plannedSource: distributionSource,
    documentation: ["https://rsync.samba.org/"],
    executable: false,
    sourceStatus: "policy-only",
  },
  direnv: {
    id: "direnv",
    label: "direnv",
    category: "utility",
    description:
      "Per-directory environment loader. No automatic shell configuration changes.",
    plannedSource: distributionSource,
    documentation: ["https://direnv.net/"],
    executable: false,
    sourceStatus: "policy-only",
  },
  bun: {
    id: "bun",
    label: "Bun",
    category: "runtime",
    description: "User-scoped JavaScript runtime and package manager.",
    plannedSource: "Official Bun stable installation channel.",
    documentation: ["https://bun.sh/docs/installation"],
    executable: false,
    sourceStatus: "policy-only",
  },
  "nvm-node": {
    id: "nvm-node",
    label: "NVM + Node.js",
    category: "runtime",
    description:
      "Node.js through NVM with explicit shell and service integration.",
    plannedSource:
      "Official NVM release, installing a stable Node.js LTS release through NVM.",
    documentation: [
      "https://github.com/nvm-sh/nvm",
      "https://nodejs.org/en/download",
    ],
    executable: false,
    sourceStatus: "policy-only",
  },
  uv: {
    id: "uv",
    label: "uv",
    category: "runtime",
    description: "User-scoped Python tooling and environment manager.",
    plannedSource: "Official uv stable installation channel.",
    documentation: ["https://docs.astral.sh/uv/getting-started/installation/"],
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
export function quickSetupCatalogEntry(id: string) {
  return (quickSetupCatalog as Record<string, QuickSetupCatalogEntry>)[id];
}
