// Deliberately fictional. These fixtures never represent a real SSH connection.
export const toolIds = [
  "overview",
  "terminal",
  "software",
  "docker",
  "proxy",
  "services",
  "storage",
  "firewall",
  "helper",
  "network",
  "processes",
] as const;
export type ToolId = (typeof toolIds)[number];

export interface SampleServer {
  id: string;
  name: string;
  address: string;
  description: string;
  available: boolean;
  metrics: {
    cpu: number;
    memoryUsed: number;
    memoryTotal: number;
    diskUsed: number;
    diskTotal: number;
  };
  software: {
    name: string;
    description: string;
    status: string;
    tool: ToolId;
  }[];
  activity: { command: string; output: string }[];
}

export const sampleServers: SampleServer[] = [
  {
    id: "sample-production",
    name: "Production",
    address: "deploy@203.0.113.24",
    description: "Ubuntu · 4 vCPU · 8 GB RAM",
    available: true,
    metrics: {
      cpu: 12,
      memoryUsed: 2.8,
      memoryTotal: 8,
      diskUsed: 38,
      diskTotal: 80,
    },
    software: [
      {
        name: "Docker + Compose",
        description: "Container engine · 6 running containers",
        status: "Running",
        tool: "docker",
      },
      {
        name: "Dokploy + Traefik",
        description: "Deployment platform · ports 80 / 443 in use",
        status: "Running",
        tool: "proxy",
      },
      {
        name: "Server helper",
        description: "Not installed · discovery would use SSH",
        status: "Not installed",
        tool: "helper",
      },
    ],
    activity: [
      {
        command: "docker ps --format '{{.Names}}'",
        output: "web, api, postgres, redis, dokploy, dokploy-traefik",
      },
      {
        command: "ss -ltn",
        output: "Listening TCP ports include 22, 80, 443, 3000",
      },
    ],
  },
  {
    id: "sample-staging",
    name: "Staging",
    address: "deploy@198.51.100.12",
    description: "Ubuntu · 2 vCPU · 4 GB RAM",
    available: true,
    metrics: {
      cpu: 4,
      memoryUsed: 1.1,
      memoryTotal: 4,
      diskUsed: 12,
      diskTotal: 40,
    },
    software: [
      {
        name: "Docker + Compose",
        description: "Container engine · 2 running containers",
        status: "Running",
        tool: "docker",
      },
      {
        name: "Caddy",
        description: "Standalone proxy · ports 80 / 443 in use",
        status: "Running",
        tool: "proxy",
      },
      {
        name: "Server helper",
        description: "Not installed · discovery would use SSH",
        status: "Not installed",
        tool: "helper",
      },
    ],
    activity: [
      {
        command: "docker ps --format '{{.Names}}'",
        output: "staging-web, staging-api",
      },
      { command: "systemctl is-active caddy", output: "active" },
    ],
  },
  {
    id: "sample-development",
    name: "Development",
    address: "dev@192.0.2.8",
    description: "No sample discovery available",
    available: false,
    metrics: {
      cpu: 0,
      memoryUsed: 0,
      memoryTotal: 0,
      diskUsed: 0,
      diskTotal: 0,
    },
    software: [],
    activity: [],
  },
];
