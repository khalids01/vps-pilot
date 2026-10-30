import { expect, test } from "@playwright/test";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

const section = (title: string, columns: string[], rows: string[][], state = rows.length ? "ready" : "empty", message: string | null = null) => ({ title, columns, rows, state, message, truncated: false });
const reports = {
  overview: { overview: { os: "Debian GNU/Linux 12", architecture: "x86_64", memoryTotal: 8589934592, memoryAvailable: 4294967296, cpuTotal: 1000, cpuIdle: 800 }, sections: [section("Filesystems", ["Filesystem", "Total KiB", "Used KiB", "Available KiB", "Used", "Mount"], [["/dev/vda1", "104857600", "41943040", "62914560", "40%", "/"]]), section("Failed services", ["Service", "Loaded", "State", "Detail", "Description"], [])] },
  docker: { overview: null, sections: [section("Containers", ["ID", "Name", "Image", "Status", "Ports"], Array.from({ length: 30 }, (_, index) => [index.toString(16).padStart(64, "a"), `web-${String(index).padStart(2, "0")}`, "nginx:stable", index === 29 ? "Exited (0)" : "Up 2 hours", index === 29 ? "" : "0.0.0.0:8080->80/tcp"])), section("Compose projects", ["Project", "Status", "Configuration"], [["website", "running(2)", "/srv/compose.yml"]]), section("Volumes", ["Name", "Driver", "Scope"], [["app-data", "local", "local"]])] },
  services: { overview: null, sections: [section("Service state", ["Service", "Loaded", "State", "Detail", "Description"], [["app.service", "loaded", "active", "running", "Application worker"]]), section("Boot enablement", ["Service", "Boot state", "Preset"], [["app.service", "enabled", "enabled"]])] },
  storage: { overview: null, sections: [section("Filesystems", ["Filesystem", "Total KiB", "Used KiB", "Available KiB", "Used", "Mount"], [["/dev/vda1", "104857600", "41943040", "62914560", "40%", "/"]]), section("Mount boundaries", ["Mount", "Source", "Filesystem", "Options"], [["/srv/data", "/dev/vdb1", "ext4", "rw"]]), section("Block devices", ["Device", "Type", "Size bytes", "Filesystem", "Mounts"], [["vda1", "part", "107374182400", "ext4", "/"]])] },
  firewall: { overview: null, sections: [section("Firewall rules", ["Rule", "Destination", "Action", "Source"], [["1", "22/tcp", "ALLOW IN", "Anywhere"]], "ready", "UFW is active.")] },
  software: { overview: null, sections: [section("Packages", ["Package", "Version", "State"], [["git", "2.39.5", "installed"]]), section("Detected software", ["Software", "Executable"], [["git", "/usr/bin/git"]])] },
  processes: { overview: null, sections: [section("Processes", ["PID", "Parent PID", "User", "CPU %", "Memory %", "RSS KiB", "Elapsed", "Process"], [["100", "1", "app", "2.1", "1.0", "1024", "01:00", "worker"], ["200", "1", "app", "21.5", "2.0", "2048", "02:00", "server"]])] },
  proxy: { overview: null, sections: [section("Proxy service ownership", ["Service", "State", "Boot state", "Configuration"], [["nginx.service", "active", "enabled", "/etc/nginx/nginx.conf"]])] },
  network: { overview: null, sections: [section("Network counters", ["Interface", "Received bytes", "Sent bytes"], [["eth0", "1048576", "2097152"]])] },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ first, second, reports }) => {
    const profiles = [
      { id: first, revision: "a", name: "Fixture Alpha", host: "alpha.invalid", username: "tester", port: 22 },
      { id: second, revision: "b", name: "Fixture Beta", host: "beta.invalid", username: "tester", port: 2222 },
    ];
    if (!localStorage.getItem("vps-pilot:sample-workspace:v1")) localStorage.setItem("vps-pilot:sample-workspace:v1", JSON.stringify({ version: 1, openServerIds: [`remote:${first}`, `remote:${second}`], activeServerId: `remote:${first}`, servers: {} }));
    const calls: { cmd: string; profileId?: string; intervalSeconds?: number }[] = [];
    const streams = new Map<string, { output: { onmessage: (value: unknown) => void }; sequence: number; timer?: ReturnType<typeof setInterval>; pending?: boolean }>();
    let next = 0;
    Object.assign(window, {
      isTauri: true,
      __calls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => ++next,
        unregisterCallback: () => {},
        invoke: async (cmd: string, args: Record<string, any> = {}) => {
          // No credentials or user terminal input are retained by the mock.
          calls.push({ cmd, profileId: args.profileId, ...(cmd === "ssh_monitor_start" ? {intervalSeconds: args.intervalSeconds} : {}) });
          if (cmd === "app_bootstrap") {
            if ((window as any).__databaseUnavailable) throw new Error("Fixture database unavailable");
            return {
              settings: JSON.parse(localStorage.getItem("__fixture_settings") ?? JSON.stringify({liveStats:true,intervalSeconds:1,visibleStats:["cpu","ram","storage","diskIo","network"],zoomPercent:100})),
              documents: JSON.parse(localStorage.getItem("__fixture_documents") ?? "{}"),
            };
          }
          if (cmd === "app_save_settings") {
            if ((window as any).__databaseSaveFailure) throw new Error("Fixture save failure");
            localStorage.setItem("__fixture_settings", JSON.stringify(args.settings));
            return args.settings;
          }
          if (cmd === "app_save_document") {
            const docs = JSON.parse(localStorage.getItem("__fixture_documents") ?? "{}");
            if (!args.import || docs[args.key] === undefined) docs[args.key] = args.value;
            localStorage.setItem("__fixture_documents", JSON.stringify(docs));
            return docs[args.key];
          }
          if (cmd === "app_apply_zoom") {
            (window as any).__appliedZoom = args.zoomPercent;
            return;
          }
          if (cmd === "ssh_profiles") return profiles;
          if (cmd === "ssh_statuses") return profiles.map((profile) => ({ profileId: profile.id, status: "connected", error: null }));
          if (cmd === "ssh_config_hosts") return [];
          if (cmd === "ssh_monitor_describe") return "exec python3 -I -S -B -u -c '# bounded live sampler fixture'";
          if (cmd === "ssh_monitor_start") {
            if ((window as any).__monitorFailures > 0) {
              (window as any).__monitorFailures--;
              throw new Error("Fixture sampler failure.");
            }
            const id = crypto.randomUUID();
            const stream = {output: args.output, sequence: 0, timer: undefined as ReturnType<typeof setInterval> | undefined, pending: false};
            streams.set(id, stream);
            const emit = () => {
              if (!streams.has(id) || stream.pending) return;
              stream.pending = true;
              const sequence = ++stream.sequence;
              stream.output.onmessage({type: "metrics", id, sequence, sample: {
                uptime: 1000 + sequence * args.intervalSeconds,
                cpuTotal: 10000 + sequence * 100, cpuIdle: 5000 + sequence * 50,
                memoryTotal: 8589934592, memoryAvailable: 4294967296, swapTotal: 0, swapFree: 0,
                networkInterface: "eth0", networkReceived: 1000 + sequence * 1000, networkSent: 2000 + sequence * 500,
                diskRead: 10000 + sequence * 2000, diskWritten: 20000 + sequence * 3000,
                capacity: {total: 107374182400, free: 64424509440, available: 59055800320}, capacityAge: sequence
              }});
            };
            setTimeout(emit, 20);
            stream.timer = setInterval(emit, args.intervalSeconds * 1000);
            return {id, command: "exec python3 -I -S -B -u -c '# bounded live sampler fixture'"};
          }
          if (cmd === "ssh_stream_ack") {
            const stream = streams.get(args.id);
            if (stream?.sequence === args.sequence) stream.pending = false;
          }
          if (cmd === "ssh_inspection_describe") return "uname -m";
          if (cmd === "ssh_action_review") return { id: crypto.randomUUID(), profileId: args.profileId, serverName: profiles.find((p) => p.id === args.profileId)?.name, address: "tester@alpha.invalid:22", command: "sudo -S -p '[VPS Pilot sudo password] ' -- /usr/sbin/ufw status numbered", purpose: "Read UFW status. No rules change.", privileged: true, expiresInSeconds: 120, evidence: null };
          if (["ssh_terminal_open", "ssh_inspection_run", "ssh_action_execute"].includes(cmd)) {
            const id = crypto.randomUUID();
            const output = args.output;
            streams.set(id, { output, sequence: 1 });
            if (cmd === "ssh_inspection_run" && (window as any).__holdInspections) return { id, command: "uname -m" };
            setTimeout(() => {
              if (!streams.has(id)) return;
              const text = cmd === "ssh_terminal_open" ? `${args.profileId} shell ready\r\n` : "=== Architecture ===\nx86_64\n";
              output.onmessage({ type: "data", id, sequence: 1, data: Array.from(new TextEncoder().encode(text)) });
              if (cmd !== "ssh_terminal_open") {
                const report = (reports as any)[args.kind ?? "firewall"];
                output.onmessage({ type: "inspection", id, report });
                streams.delete(id); output.onmessage({ type: "closed", id, code: 0, message: "Completed." });
              }
            }, 20);
            return cmd === "ssh_inspection_run" ? { id, command: "uname -m" } : id;
          }
          if (cmd === "ssh_terminal_input") {
            const stream = streams.get(args.id);
            if (stream) stream.output.onmessage({ type: "data", id: args.id, sequence: ++stream.sequence, data: args.data });
          }
          if (cmd === "ssh_stream_close") {
            const stream = streams.get(args.id);
            clearInterval(stream?.timer);
            streams.delete(args.id);
            stream?.output.onmessage({ type: "closed", id: args.id, code: null, message: "Session closed." });
          }
          return null;
        },
      },
    });
  }, { first, second, reports });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fixture Alpha", exact: true })).toBeVisible();
});

test("restoring VPS tabs does not connect or open terminals; inspection stays server-bound", async ({ page }) => {
  const initial = await page.evaluate(() => (window as any).__calls);
  expect(initial.some((call: any) => ["ssh_connect", "ssh_terminal_open", "ssh_inspection_run"].includes(call.cmd))).toBe(false);
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page.getByRole("button", { name: "Show command console", exact: true }).click();
  await expect(page.getByText("Exact command", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Fixture Beta/ }).click();
  await expect(page.getByRole("heading", { name: "Fixture Beta", exact: true })).toBeVisible();
  await expect(page.getByText("No inspection yet.", { exact: false })).toBeVisible();
  const inspections = await page.evaluate(() => (window as any).__calls.filter((call: any) => call.cmd === "ssh_inspection_run"));
  expect(inspections).toEqual([{ cmd: "ssh_inspection_run", profileId: first }]);
});

test("sudo rejection executes nothing; fresh approval runs only on its server without persistence", async ({ page }) => {
  await page.getByRole("navigation", { name: "Fixture Alpha tools" }).getByRole("button", { name: "Firewall", exact: true }).click();
  await page.getByRole("button", { name: "Review command", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Fixture Alpha");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__calls.filter((call: any) => call.cmd === "ssh_action_execute"))).toEqual([]);
  await page.getByRole("button", { name: "Review command", exact: true }).click();
  await page.getByLabel("Sudo password (when needed)").fill("disposable-ui-secret");
  await page.getByRole("button", { name: "Approve and run", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Show command console", exact: true }).click();
  await expect(page.getByRole("region", { name: "Fixture Alpha command console" })).toContainText("Completed.");
  const executions = await page.evaluate(() => (window as any).__calls.filter((call: any) => call.cmd === "ssh_action_execute"));
  expect(executions).toEqual([{ cmd: "ssh_action_execute", profileId: first }]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("disposable-ui-secret");
});

test("live terminals survive navigation, require close confirmation, and restore without opening SSH", async ({ page }, testInfo) => {
  const nav = page.getByRole("navigation", { name: "Fixture Alpha tools" });
  await nav.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "New shell", exact: true }).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  await nav.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to servers", exact: true }).click();
  await nav.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  expect((await page.evaluate(() => (window as any).__calls.filter((call: any) => call.cmd === "ssh_terminal_open"))).length).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("live-terminals.png") });
  await page.getByRole("button", { name: "Close active session", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("can interrupt");
  await page.getByRole("button", { name: "Keep session", exact: true }).click();
  await page.reload();
  await page.getByRole("navigation", { name: "Fixture Alpha tools" }).getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start shell on Fixture Alpha", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__calls.filter((call: any) => call.cmd === "ssh_terminal_open"))).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("shell ready");
});

test("narrow real workspaces keep terminal and inspection controls accessible", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(page.getByRole("button", { name: "Inspect", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Fixture Alpha tools" }).getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("button", { name: "New shell", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Show command console", exact: true }).click();
  const drawerBounds = await page.getByRole("region", { name: "Fixture Alpha command console" }).boundingBox();
  expect(drawerBounds && drawerBounds.y + drawerBounds.height <= 900).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("narrow-terminals.png") });
});


test("automatic metrics share one stream and pause for inactive tabs and windows", async ({ page }) => {
  const starts = () => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_monitor_start"));
  await expect.poll(async () => (await starts()).length).toBe(1);
  await expect(page.getByRole("button", {name: "Start live metrics", exact: true})).toHaveCount(0);
  await page.getByRole("navigation", {name: "Fixture Alpha tools"}).getByRole("button", {name: "Network", exact: true}).click();
  expect((await starts()).length).toBe(1);
  await page.getByRole("tab", { name: /Fixture Beta/ }).click();
  await expect.poll(async () => (await starts()).length).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_stream_close").length)).toBe(1);
  await page.getByRole("tab", { name: /Fixture Alpha/ }).click();
  await expect.poll(async () => (await starts()).length).toBe(3);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {get: () => "hidden", configurable: true});
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_stream_close").length)).toBe(3);
  await page.clock.fastForward(5100);
  expect((await starts()).length).toBe(3);
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_inspection_run").length)).toBe(0);
});

test("production UI exposes read-only service operations", async ({ page }) => {
  await page.getByRole("navigation", { name: "Fixture Alpha tools" }).getByRole("button", { name: "Services", exact: true }).click();
  await expect(page.getByText("Read-only mode:", { exact: false })).toBeVisible();
  await page.getByRole("combobox", { name: "Service operation" }).click();
  await expect(page.getByRole("option", { name: "restart", exact: true })).toBeDisabled();
  await expect(page.getByRole("option", { name: "Read logs", exact: true })).toBeEnabled();
});


test("structured overview keeps raw output in the bottom drawer and connection details collapsed", async ({ page }, testInfo) => {
  const workspace = page.getByRole("tabpanel");
  await expect(workspace.getByText("SSH agent / default keys", { exact: true })).toBeHidden();
  await workspace.getByText("Connection details", { exact: true }).click();
  await expect(workspace.getByText("SSH agent / default keys", { exact: true })).toBeVisible();
  await workspace.getByText("Connection details", { exact: true }).click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByRole("meter", { name: "Memory", exact: true })).toHaveAttribute("value", "50");
  await expect(page.getByRole("region", { name: "Filesystems", exact: true })).toContainText("40 GiB");
  await expect(page.getByRole("main").locator("pre")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("structured-overview.png") });
  const consolePanel = page.getByRole("region", { name: "Fixture Alpha command console" });
  await expect(consolePanel).toContainText("Overview inspection");
  await page.getByRole("button", { name: "Show command console", exact: true }).click();
  await expect(consolePanel).toContainText("uname -m");
  await expect(consolePanel).toContainText("x86_64");
  await page.getByRole("navigation", { name: "Fixture Alpha tools" }).getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(consolePanel).toContainText("uname -m");
  await page.getByRole("tab", { name: /Fixture Beta/ }).click();
  await expect(page.getByRole("region", { name: "Fixture Beta command console" })).toContainText("Actions (0)");
  await expect(page.getByRole("region", { name: "Fixture Beta command console" })).not.toContainText("Overview inspection");
  await page.getByRole("tab", { name: /Fixture Alpha/ }).click();
  await expect(consolePanel).toContainText("uname -m");
  await page.screenshot({ path: testInfo.outputPath("persistent-console.png") });
});

test("Docker, Services, Storage and other inspections render application tables", async ({ page }, testInfo) => {
  const nav = page.getByRole("navigation", { name: "Fixture Alpha tools" });
  await nav.getByRole("button", { name: "Docker", exact: true }).click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  const containers = page.getByRole("region", { name: "Containers", exact: true });
  await expect(containers).toContainText("web-00");
  await expect(containers.getByRole("row")).toHaveCount(26);
  await containers.getByRole("button", { name: "Next", exact: true }).click();
  await expect(containers).toContainText("web-29");
  await containers.getByRole("textbox", { name: "Search Containers" }).fill("web-07");
  await expect(containers.getByRole("row")).toHaveCount(2);
  await expect(containers).toContainText("web-07");
  await page.screenshot({ path: testInfo.outputPath("docker-content.png") });
  for (const tool of ["Services", "Storage", "Software", "Proxy", "Network", "Firewall"]) {
    await nav.getByRole("button", { name: tool, exact: true }).click();
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    await expect(page.getByRole("main").getByRole("table").first()).toBeVisible();
    await expect(page.getByRole("main").locator("pre")).toHaveCount(0);
  }
  await nav.getByRole("button", { name: "Processes", exact: true }).click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  const processes = page.getByRole("region", { name: "Processes", exact: true });
  await processes.getByRole("button", { name: "CPU %", exact: true }).click();
  await processes.getByRole("button", { name: "CPU %", exact: true }).click();
  await expect(processes.getByRole("row").nth(1)).toContainText("server");
});

test("drawer can cancel running commands and coalesces monitoring separately", async ({ page }) => {
  await page.evaluate(() => { (window as any).__holdInspections = true; });
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page.getByRole("button", { name: "Show command console", exact: true }).click();
  await page.getByRole("button", { name: "Cancel command", exact: true }).click();
  await expect(page.getByRole("region", { name: "Fixture Alpha command console" })).toContainText("Cancelled.");
  await page.evaluate(() => { (window as any).__holdInspections = false; });
  await expect(page.getByRole("button", {name: "Monitoring (1)", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Monitoring (1)", exact: true}).click();
  await expect(page.getByRole("group", {name: "Recent commands"}).getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("region", {name: "Fixture Alpha command console"})).toContainText("exec python3");
  await page.getByRole("button", {name: "Cancel command", exact: true}).click();
  await page.getByRole("button", {name: "Settings", exact: true}).click();
  await expect(page.getByRole("checkbox", {name: "Enable live stats automatically"})).not.toBeChecked();
});

test("compact resource badges show themed tooltips and cached floating details", async ({page}, testInfo) => {
  const bar = page.getByRole("region", {name: "Live server metrics"});
  const header = page.getByRole("tabpanel").getByRole("banner");
  await expect(header.getByRole("region", {name: "Live server metrics"})).toBeVisible();
  await expect(header).not.toContainText("tester@alpha.invalid:22");
  const name = header.getByRole("heading", {name: "Fixture Alpha", exact: true});
  await name.hover();
  await expect(page.getByRole("tooltip")).toContainText("tester@alpha.invalid:22");
  const network = bar.getByRole("button", {name: "Network live metrics details"});
  const cpuBadge = bar.getByRole("button", {name: "CPU live metrics details"});
  const beforeWidths = await bar.getByRole("button").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  const nameBounds = await name.boundingBox();
  const cpuBounds = await cpuBadge.boundingBox();
  expect(Math.abs((nameBounds!.y + nameBounds!.height / 2) - (cpuBounds!.y + cpuBounds!.height / 2))).toBeLessThan(8);
  await expect(network).toContainText("↓ 1,000 B/s");
  await expect(network).toContainText("↑ 500 B/s");
  const afterWidths = await bar.getByRole("button").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  expect(afterWidths).toEqual(beforeWidths);
  await expect(bar.getByRole("button", {name: "RAM live metrics details"})).toContainText("50.0%");
  const cpu = bar.getByRole("button", {name: "CPU live metrics details"});
  await expect(cpu).toContainText("50.0%");
  await cpu.hover();
  await expect(page.getByRole("tooltip")).toContainText("CPU:");
  await cpu.click();
  const popup = page.getByRole("dialog", {name: "Live resource usage"});
  await expect(popup).toContainText("Capacity cached for 60s");
  await expect(popup.getByRole("img", {name: "CPU history, measured samples only"})).toBeVisible();
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_monitor_start").length)).toBe(1);
  await page.screenshot({path: testInfo.outputPath("live-metrics-popover.png")});
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await page.getByRole("button", {name: "Settings", exact: true}).click();
  await page.getByRole("button", {name: "5 seconds", exact: true}).click();
  await page.getByRole("button", {name: "Back to servers", exact: true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_monitor_start").at(-1)?.intervalSeconds)).toBe(5);
  await page.setViewportSize({width: 430, height: 900});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await bar.getByRole("button", {name: "RAM live metrics details"}).click();
  await expect(page.getByRole("dialog", {name: "Live resource usage"})).toBeVisible();
  await page.screenshot({path: testInfo.outputPath("live-metrics-mobile.png")});
});

test("failed monitoring backs off and disabling in Settings cancels retries", async ({page}) => {
  await page.getByRole("button", {name: "Settings", exact: true}).click();
  await page.getByRole("checkbox", {name: "Enable live stats automatically"}).uncheck();
  await page.evaluate(() => { (window as any).__monitorFailures = 2; (window as any).__calls.length = 0; });
  await page.getByRole("checkbox", {name: "Enable live stats automatically"}).check();
  await page.getByRole("button", {name: "Back to servers", exact: true}).click();
  await expect(page.getByRole("region", {name: "Live server metrics"})).toBeVisible();
  await page.clock.fastForward(5100);
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_monitor_start").length)).toBe(2);
  await page.getByRole("button", {name: "Settings", exact: true}).click();
  await page.getByRole("checkbox", {name: "Enable live stats automatically"}).uncheck();
  await page.clock.fastForward(20100);
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_monitor_start").length)).toBe(2);
});

test("settings persist chosen stats and interval, with no per-sample database writes", async ({page}, testInfo) => {
  await page.getByRole("button", {name: "Settings", exact: true}).click();
  await page.getByRole("checkbox", {name: "CPU", exact: true}).uncheck();
  await page.getByRole("checkbox", {name: "Disk activity", exact: true}).uncheck();
  await page.getByRole("button", {name: "2 seconds", exact: true}).click();
  await expect(page.getByRole("main", {name: "Application settings"})).toContainText("Saved on this device");
  await page.screenshot({path:testInfo.outputPath("settings.png")});
  await page.getByRole("button", {name: "Back to servers", exact: true}).click();
  const bar=page.getByRole("region",{name:"Live server metrics"});
  await expect(bar.getByRole("button",{name:"CPU live metrics details"})).toHaveCount(0);
  await expect(bar.getByRole("button",{name:"RAM live metrics details"})).toBeVisible();
  const before=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="app_save_settings").length);
  await page.clock.fastForward(5100);
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="app_save_settings").length)).toBe(before);
  await page.reload();
  await expect(bar.getByRole("button",{name:"CPU live metrics details"})).toHaveCount(0);
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await expect(page.getByRole("checkbox",{name:"CPU",exact:true})).not.toBeChecked();
  await expect(page.getByRole("button",{name:"2 seconds",exact:true})).toHaveAttribute("aria-pressed","true");
  for(const label of ["RAM","Storage capacity","Network download and upload"]) await page.getByRole("checkbox",{name:label,exact:true}).uncheck();
  await page.getByRole("button",{name:"Back to servers",exact:true}).click();
  const count=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_monitor_start").length);
  await page.clock.fastForward(10100);
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_monitor_start").length)).toBe(count);
});

test("browser-style zoom shortcuts persist and reset without reaching terminal input", async ({page}) => {
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Terminal",exact:true}).click();
  await page.getByRole("button",{name:"New shell",exact:true}).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  await page.locator(".xterm-helper-textarea").first().focus();
  const inputCount=await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_terminal_input").length);
  await page.keyboard.press("Control+=");
  expect(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_terminal_input").length)).toBe(inputCount);
  await expect.poll(()=>page.evaluate(()=>(window as any).__appliedZoom)).toBe(110);
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>(window as any).__appliedZoom)).toBe(110);
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await expect(page.getByLabel("Zoom level")).toContainText("110%");
  await page.keyboard.press("Control+-");
  await expect(page.getByLabel("Zoom level")).toContainText("100%");
  await page.keyboard.press("Meta+=");
  await expect(page.getByLabel("Zoom level")).toContainText("110%");
  await page.keyboard.press("Control+0");
  await expect(page.getByLabel("Zoom level")).toContainText("100%");
});

test("local database save failure is visible and does not replace saved settings", async ({page}) => {
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  const before=await page.evaluate(()=>localStorage.getItem("__fixture_settings"));
  await page.evaluate(()=>{(window as any).__databaseSaveFailure=true;});
  await page.getByRole("button",{name:"5 seconds",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Settings could not be saved");
  expect(await page.evaluate(()=>localStorage.getItem("__fixture_settings"))).toBe(before);
});
