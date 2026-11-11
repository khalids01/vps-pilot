import type { Page } from "@playwright/test";

export const webProfileId = "11111111-1111-4111-8111-111111111111";
export const apiProfileId = "22222222-2222-4222-8222-222222222222";
export const stagingProfileId = "33333333-3333-4333-8333-333333333333";
export const analyticsProfileId = "44444444-4444-4444-8444-444444444444";

type Tool = "overview" | "docker" | "files" | "terminal";

interface MockOptions {
  page: "fleet" | "server";
  tool?: Tool;
  openProfiles?: string[];
}

const fixedNow = Date.parse("2026-11-11T10:30:00Z");

export const marketingAllowedCommands = [
  "app_bootstrap",
  "app_save_settings",
  "app_save_document",
  "app_apply_zoom",
  "plugin:app|version",
  "plugin:updater|check",
  "ssh_profiles",
  "ssh_statuses",
  "ssh_monitor_describe",
  "ssh_monitor_start",
  "ssh_stream_ack",
  "ssh_stream_close",
  "ssh_inspection_describe",
  "ssh_inspection_run",
  "ssh_docker_query",
  "ssh_files_list",
  "ssh_file_read",
  "ssh_terminal_open",
  "ssh_terminal_input",
  "ssh_terminal_resize",
  "ssh_action_reject",
] as const;

const profiles = [
  {
    id: webProfileId,
    revision: "web-01",
    name: "Storefront web",
    host: "web-01.example.net",
    username: "deploy",
    port: 22,
    identityFile: "~/.ssh/id_ed25519",
    passwordAllowed: false,
  },
  {
    id: apiProfileId,
    revision: "api-01",
    name: "Storefront API",
    host: "api-01.example.net",
    username: "deploy",
    port: 22,
    identityFile: "~/.ssh/id_ed25519",
    passwordAllowed: false,
  },
  {
    id: stagingProfileId,
    revision: "staging",
    name: "Storefront staging",
    host: "staging.example.net",
    username: "deploy",
    port: 2222,
    identityFile: "~/.ssh/id_ed25519",
    passwordAllowed: false,
  },
  {
    id: analyticsProfileId,
    revision: "analytics",
    name: "Analytics worker",
    host: "analytics.example.net",
    username: "ubuntu",
    port: 22,
    identityFile: "~/.ssh/id_ed25519",
    passwordAllowed: false,
  },
];

const fleet = {
  version: 1,
  servers: {
    [webProfileId]: {
      project: "Storefront",
      tags: ["nginx", "ubuntu"],
      environment: "production",
      favorite: true,
      order: 0,
    },
    [apiProfileId]: {
      project: "Storefront",
      tags: ["docker", "postgres"],
      environment: "production",
      favorite: true,
      order: 1,
    },
    [stagingProfileId]: {
      project: "Storefront",
      tags: ["caddy", "preview"],
      environment: "staging",
      favorite: false,
      order: 2,
    },
    [analyticsProfileId]: {
      project: "Data",
      tags: ["python", "worker"],
      environment: "development",
      favorite: false,
      order: 3,
    },
  },
};

const webContainerId =
  "9f2c1a7e4b6d8c0f3a5e7b9d1c2f4a6b8d0e2f4a6c8b0d2e4f6a8c0b2d4e6f8a";

const containers = [
  {
    id: webContainerId,
    name: "storefront-web",
    image: "nginx:1.27-alpine",
    state: "running",
    status: "Up 14 days (healthy)",
    ports: "0.0.0.0:80->80/tcp",
    project: "storefront",
    service: "web",
  },
  {
    id: "b".repeat(64),
    name: "storefront-api",
    image: "ghcr.io/example/storefront-api:2.4.1",
    state: "running",
    status: "Up 14 days (healthy)",
    ports: "127.0.0.1:3000->3000/tcp",
    project: "storefront",
    service: "api",
  },
  {
    id: "c".repeat(64),
    name: "storefront-worker",
    image: "ghcr.io/example/storefront-api:2.4.1",
    state: "running",
    status: "Up 14 days",
    ports: "",
    project: "storefront",
    service: "worker",
  },
  {
    id: "d".repeat(64),
    name: "storefront-postgres",
    image: "postgres:16-alpine",
    state: "running",
    status: "Up 14 days (healthy)",
    ports: "5432/tcp",
    project: "storefront",
    service: "postgres",
  },
  {
    id: "e".repeat(64),
    name: "storefront-redis",
    image: "redis:7.4-alpine",
    state: "running",
    status: "Up 14 days",
    ports: "6379/tcp",
    project: "storefront",
    service: "redis",
  },
  {
    id: "f".repeat(64),
    name: "storefront-migrate",
    image: "ghcr.io/example/storefront-api:2.4.1",
    state: "exited",
    status: "Exited (0) 2 weeks ago",
    ports: "",
    project: "storefront",
    service: "migrate",
  },
];

const containerDetails = {
  id: webContainerId,
  name: "/storefront-web",
  image: "nginx:1.27-alpine",
  status: "running",
  started: "2026-10-28T07:12:44Z",
  restarts: 0,
  health: "healthy",
  restartPolicy: "unless-stopped",
  networkMode: "storefront_default",
  privileged: false,
  mounts: [
    {
      Type: "volume",
      Source: "storefront_static",
      Destination: "/usr/share/nginx/html",
      RW: false,
    },
    {
      Type: "bind",
      Source: "/srv/storefront/nginx.conf",
      Destination: "/etc/nginx/conf.d/default.conf",
      RW: false,
    },
  ],
  environment: ["NGINX_ENTRYPOINT_QUIET_LOGS", "TZ", "STORE_ID"],
};

const overviewReport = {
  overview: {
    os: "Debian GNU/Linux 12 (bookworm)",
    architecture: "x86_64",
    memoryTotal: 8589934592,
    memoryAvailable: 5368709120,
    cpuTotal: 1000000,
    cpuIdle: 700000,
  },
  sections: [
    {
      title: "Filesystems",
      columns: [
        "Filesystem",
        "Total KiB",
        "Used KiB",
        "Available KiB",
        "Used",
        "Mount",
      ],
      rows: [["/dev/vda1", "83886080", "33554432", "46137344", "40%", "/"]],
      state: "ready",
      message: null,
      truncated: false,
    },
    {
      title: "Failed services",
      columns: ["Service", "Loaded", "State", "Detail", "Description"],
      rows: [],
      state: "empty",
      message: "No failed services reported.",
      truncated: false,
    },
  ],
};

const composeFile = `services:
  web:
    image: nginx:1.27-alpine
    restart: unless-stopped
    ports:
      - "80:80"
    volumes:
      - storefront_static:/usr/share/nginx/html:ro

  api:
    image: ghcr.io/example/storefront-api:2.4.1
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://app@postgres:5432/storefront
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes:
      - storefront_pgdata:/var/lib/postgresql/data

volumes:
  storefront_static:
  storefront_pgdata:
`;

const directories: Record<string, unknown> = {
  "/": {
    path: "/",
    parent: "/",
    truncated: false,
    entries: [
      entry("/home", "directory", null),
      entry("/srv", "directory", null),
      entry("/var", "directory", null),
      entry("/opt", "directory", null),
      entry("/tmp", "directory", null),
    ],
  },
  "/srv": {
    path: "/srv",
    parent: "/",
    truncated: false,
    entries: [
      entry("/srv/storefront", "directory", null),
      entry("/srv/backups", "directory", null),
      entry("/srv/deploy.sh", "file", 1840, 33261),
      entry("/srv/docker-compose.yml", "file", 2147, 33188),
      entry("/srv/README.md", "file", 1204, 33188),
    ],
  },
};

function entry(
  path: string,
  kind: "directory" | "file",
  size: number | null,
  permissions = kind === "directory" ? 16877 : 33188,
) {
  return {
    name: path.split("/").pop(),
    path,
    kind,
    size,
    permissions,
    modified: 1794300000,
    uid: 1000,
    gid: 1000,
  };
}

function sample(sequence: number, uptime: number) {
  return {
    uptime,
    cpuTotal: 1000000 + sequence * 200,
    cpuIdle: 700000 + sequence * 155,
    memoryTotal: 8589934592,
    memoryAvailable: 5368709120 - sequence * 25165824,
    swapTotal: 2147483648,
    swapFree: 2147483648,
    networkInterface: "eth0",
    networkReceived: 100000000 + sequence * 480000,
    networkSent: 50000000 + sequence * 120000,
    diskRead: 240000000 + sequence * 900000,
    diskWritten: 120000000 + sequence * 460000,
    capacity: {
      total: 85899345920,
      free: 51539607552,
      available: 47244640256,
    },
    capacityAge: 12 + sequence,
  };
}

const samples = [1, 2, 3, 4].map((sequence) =>
  sample(sequence, 172800 + sequence * 2),
);

export async function installMarketingMock(
  page: Page,
  options: MockOptions,
): Promise<void> {
  await page.addInitScript(
    ({ profiles, fleet, containers, containerDetails, overviewReport, composeFile, directories, samples, fixedNow, options, webProfileId, allowedCommands }) => {
      const target = window as typeof window & {
        isTauri?: boolean;
        __marketingMock?: boolean;
        __marketingCalls?: { cmd: string; args: Record<string, unknown> }[];
        __marketingUnexpectedCalls?: string[];
        __TAURI_INTERNALS__?: Record<string, unknown>;
      };
      const workspaceKey = "vps-pilot:sample-workspace:v1";
      const fleetKey = "vps-pilot:fleet:v1";
      const selected = options.tool ?? "overview";
      const serverPreferences = {
        tool: selected,
        commandExpanded: false,
        softwareCategory: "All",
        helperScenario: "installed",
      };
      const openProfiles =
        options.openProfiles ??
        (options.page === "server" ? [webProfileId] : []);
      const tabIds = openProfiles.map((id: string) => "remote:" + id);
      const workspace = openProfiles.length
        ? {
            version: 1,
            page: "server",
            openServerIds: tabIds,
            activeServerId: tabIds[0],
            sidebarCollapsed: false,
            servers: Object.fromEntries(
              tabIds.map((id: string) => [id, serverPreferences]),
            ),
          }
        : {
            version: 1,
            page: "fleet",
            openServerIds: [],
            activeServerId: null,
            sidebarCollapsed: false,
            servers: {},
          };
      const documents = {
        [workspaceKey]: JSON.stringify(workspace),
        [fleetKey]: JSON.stringify(fleet),
      };
      const settings = {
        liveStats: true,
        intervalSeconds: 2,
        visibleStats: ["cpu", "ram", "storage", "diskIo", "network"],
        zoomPercent: 100,
        theme: "forest-mint",
      };
      const calls: { cmd: string; args: Record<string, unknown> }[] = [];
      const unexpected: string[] = [];
      const streams = new Map<string, { output: { onmessage: (value: unknown) => void }; sequence: number }>();
      const allowed = new Set(allowedCommands);
      let callback = 0;
      let inspectionRuns = 0;
      const RealDate = Date;
      class FixedDate extends RealDate {
        constructor(...args: ConstructorParameters<typeof Date>) {
          if (args.length === 0) super(fixedNow);
          else super(...args);
        }
        static now() {
          return fixedNow;
        }
      }
      window.Date = FixedDate as DateConstructor;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.hasFocus = () => true;

      const emit = (streamId: string, message: unknown) => {
        const stream = streams.get(streamId);
        if (stream) stream.output.onmessage(message);
      };
      const emitMetrics = (streamId: string) => {
        const stream = streams.get(streamId);
        if (!stream) return;
        samples.forEach((value: unknown, index: number) => {
          stream.sequence = index + 1;
          emit(streamId, {
            type: "metrics",
            id: streamId,
            sequence: index + 1,
            sample: value,
          });
        });
      };

      Object.assign(target, {
        isTauri: true,
        __marketingMock: true,
        __marketingCalls: calls,
        __marketingUnexpectedCalls: unexpected,
        __TAURI_INTERNALS__: {
          transformCallback: () => ++callback,
          unregisterCallback: () => {},
          invoke: async (cmd: string, args: Record<string, any> = {}) => {
            calls.push({
              cmd,
              args: Object.fromEntries(
                Object.entries(args).filter(
                  ([key, value]) =>
                    typeof value !== "function" &&
                    key !== "output" &&
                    key !== "onProgress" &&
                    key !== "onEvent",
                ),
              ),
            });
            if (!allowed.has(cmd)) {
              unexpected.push(cmd);
              throw new Error("Unexpected native call: " + cmd);
            }
            if (cmd === "app_bootstrap") {
              return { settings, documents };
            }
            if (cmd === "app_save_settings") return args.settings;
            if (cmd === "app_save_document") return args.value;
            if (cmd === "app_apply_zoom") return;
            if (cmd === "plugin:app|version") return "0.2.9";
            if (cmd === "plugin:updater|check") return null;
            if (cmd === "ssh_profiles") return profiles;
            if (cmd === "ssh_statuses") {
              return profiles.map((profile: { id: string }, index: number) => ({
                profileId: profile.id,
                connectionId: "connection-" + index,
                status: "connected",
                error: null,
                authenticationMethod: "key",
                setupAccessVerified: true,
              }));
            }
            if (cmd === "ssh_monitor_describe") {
              return "exec python3 -I -S -B -u -c '# read-only /proc sampler'";
            }
            if (cmd === "ssh_monitor_start") {
              const id = "metrics-" + crypto.randomUUID();
              streams.set(id, { output: args.output, sequence: 0 });
              setTimeout(() => emitMetrics(id), 30);
              return {
                id,
                command:
                  "exec python3 -I -S -B -u -c '# read-only /proc sampler'",
              };
            }
            if (cmd === "ssh_stream_ack") return;
            if (cmd === "ssh_stream_close") {
              streams.delete(args.id);
              return;
            }
            if (cmd === "ssh_inspection_describe") {
              return "uname -a; cat /proc/meminfo; df -k";
            }
            if (cmd === "ssh_inspection_run") {
              const id = "inspection-" + crypto.randomUUID();
              const run = ++inspectionRuns;
              const report =
                args.kind === "overview"
                  ? {
                      ...overviewReport,
                      overview: overviewReport.overview
                        ? {
                            ...overviewReport.overview,
                            cpuTotal:
                              overviewReport.overview.cpuTotal + run * 200,
                            cpuIdle: overviewReport.overview.cpuIdle + run * 160,
                          }
                        : null,
                    }
                  : { overview: null, sections: [] };
              streams.set(id, { output: args.output, sequence: 1 });
              setTimeout(() => {
                emit(id, {
                  type: "data",
                  id,
                  sequence: 1,
                  data: Array.from(
                    new TextEncoder().encode(
                      "=== System ===\nDebian GNU/Linux 12 (bookworm)\nx86_64\n",
                    ),
                  ),
                });
                emit(id, {
                  type: "inspection",
                  id,
                  report,
                });
                emit(id, {
                  type: "closed",
                  id,
                  code: 0,
                  message: "Completed.",
                });
                streams.delete(id);
              }, 30);
              return { id, command: "uname -a; cat /proc/meminfo; df -k" };
            }
            if (cmd === "ssh_docker_query") {
              if (args.query === "list") {
                return {
                  data: containers,
                  command: "docker ps --format '{{json .}}'",
                  lifecycleEnabled: true,
                };
              }
              if (args.query === "details") {
                return {
                  data: [containerDetails],
                  command: "docker inspect -- storefront-web",
                  lifecycleEnabled: true,
                };
              }
              return {
                data: [
                  {
                    id: args.container,
                    cpu: "0.42%",
                    memory: "18.4MiB / 1GiB",
                    memoryPercent: "1.8%",
                    network: "2.1MB / 840kB",
                    disk: "6.2MB / 0B",
                    pids: "9",
                  },
                ],
                command: "docker stats --no-stream -- storefront-web",
                lifecycleEnabled: true,
              };
            }
            if (cmd === "ssh_files_list") {
              return (
                directories[args.path as keyof typeof directories] ??
                directories["/"]
              );
            }
            if (cmd === "ssh_file_read") {
              return {
                path: args.path,
                content: composeFile,
                revision: "1",
                size: composeFile.length,
                permissions: 33188,
              };
            }
            if (cmd === "ssh_terminal_open") {
              const id = "terminal-" + crypto.randomUUID();
              streams.set(id, { output: args.output, sequence: 1 });
              setTimeout(() => {
                emit(id, {
                  type: "data",
                  id,
                  sequence: 1,
                  data: Array.from(
                    new TextEncoder().encode(
                      "Linux web-01 6.1.0-30-amd64 #1 SMP PREEMPT_DYNAMIC x86_64\r\n" +
                        "Last login: Wed Nov 11 10:28:41 2026 from 198.51.100.24\r\n" +
                        "deploy@web-01:~$ uptime\r\n" +
                        " 10:30:02 up 14 days,  3:18,  1 user,  load average: 0.18, 0.22, 0.19\r\n" +
                        "deploy@web-01:~$ docker compose ps\r\n" +
                        "NAME                IMAGE                                      STATUS\r\n" +
                        "storefront-web      nginx:1.27-alpine                          Up 14 days (healthy)\r\n" +
                        "storefront-api      ghcr.io/example/storefront-api:2.4.1       Up 14 days (healthy)\r\n" +
                        "storefront-worker   ghcr.io/example/storefront-api:2.4.1       Up 14 days\r\n" +
                        "storefront-postgres postgres:16-alpine                         Up 14 days (healthy)\r\n" +
                        "deploy@web-01:~$ ",
                    ),
                  ),
                });
              }, 40);
              return id;
            }
            if (cmd === "ssh_terminal_input") return;
            if (cmd === "ssh_terminal_resize") return;
            if (cmd === "ssh_action_reject") return;
            throw new Error("Unhandled allowed native call: " + cmd);
          },
        },
      });
    },
    {
      profiles,
      fleet,
      containers,
      containerDetails,
      overviewReport,
      composeFile,
      directories,
      samples,
      fixedNow,
      options,
      webProfileId,
      allowedCommands: marketingAllowedCommands,
    },
  );
}

export async function expectNoUnexpectedNativeCalls(page: Page) {
  const state = await page.evaluate(() => {
    const target = window as typeof window & {
      __marketingCalls?: { cmd: string }[];
      __marketingUnexpectedCalls?: string[];
    };
    return {
      calls: (target.__marketingCalls ?? []).map((call) => call.cmd),
      unexpected: target.__marketingUnexpectedCalls ?? [],
    };
  });
  if (state.unexpected.length) {
    throw new Error(
      "Unexpected native calls during screenshots: " +
        state.unexpected.join(", "),
    );
  }
}
