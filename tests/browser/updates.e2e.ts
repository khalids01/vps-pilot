import { expect, test } from "@playwright/test";

async function mockDesktop(page: import("@playwright/test").Page, mode = "available") {
  await page.addInitScript((mode) => {
    let callbackId = 0;
    const calls: string[] = [];
    Object.assign(window, {
      isTauri: true,
      __updateCalls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => ++callbackId,
        unregisterCallback: () => {},
        invoke: async (cmd: string, args: Record<string, any> = {}) => {
          calls.push(cmd);
          if (cmd === "app_bootstrap") return {
            settings:{liveStats:true,intervalSeconds:1,visibleStats:["cpu","ram","storage","diskIo","network"],zoomPercent:100},
            documents:JSON.parse(localStorage.getItem("__fixture_update_docs") ?? "{}")
          };
          if (cmd === "app_save_document") {
            const docs=JSON.parse(localStorage.getItem("__fixture_update_docs") ?? "{}");
            if(!args.import || docs[args.key] === undefined)docs[args.key]=args.value;
            localStorage.setItem("__fixture_update_docs",JSON.stringify(docs));
            return docs[args.key];
          }
          if (cmd === "app_apply_zoom" || cmd === "app_save_settings") return;
          if (cmd === "plugin:app|version") return "0.1.0";
          if (cmd === "plugin:updater|check") {
            if (mode === "offline") throw new Error("Release channel is unavailable");
            if (mode === "current") return null;
            return { rid: 12, currentVersion: "0.1.0", version: "0.2.0", body: "Improved terminal layouts", rawJson: {} };
          }
          if (cmd === "plugin:updater|download_and_install") {
            args.onEvent.onmessage({ event: "Started", data: { contentLength: 100 } });
            args.onEvent.onmessage({ event: "Progress", data: { chunkLength: 50 } });
            await new Promise(resolve => setTimeout(resolve, 150));
            if (mode === "bad-signature") throw new Error("Signature verification failed");
            return;
          }
          if (cmd === "plugin:process|restart") throw new Error("Restart unavailable in fixture");
          if (cmd === "ssh_profiles" || cmd === "ssh_statuses" || cmd === "ssh_config_hosts") return [];
          return null;
        },
      },
    });
  }, mode);
}

async function openUpdates(page: import("@playwright/test").Page) {
  if (!await page.getByRole("main", { name: "Application settings" }).isVisible())
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("main", { name: "Application settings" }).getByRole("button", { name: "Check for updates", exact: true }).click();
}

const calls = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).__updateCalls as string[]);

test("update requires consent, reports progress, and retains restart fallback", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await openUpdates(page);
  await expect(page.getByText("Improved terminal layouts", { exact: true })).toBeVisible();
  await expect(page.getByText(/closes all SSH connections/)).toBeVisible();
  expect(await calls(page)).not.toContain("plugin:updater|download_and_install");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  await expect(page.getByRole("button", { name: "Restart VPS Pilot" })).toBeVisible();
  expect((await calls(page)).filter(cmd => cmd === "plugin:updater|download_and_install")).toHaveLength(1);
  await page.getByRole("button", { name: "Restart later" }).click();
  await page.getByRole("button", { name: /Restart required/ }).click();
  await expect(page.getByRole("button", { name: "Restart VPS Pilot" })).toBeVisible();
});

test("skipped version survives relaunch and a manual check still offers it", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await openUpdates(page);
  await page.getByRole("button", { name: "Skip this version" }).click();
  await page.reload();
  await page.waitForTimeout(4500);
  await expect(page.getByRole("button", { name: /Update available/ })).toHaveCount(0);
  await openUpdates(page);
  await expect(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  expect(await calls(page)).not.toContain("plugin:updater|download_and_install");
});

test("later dismisses the notice until next launch", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await openUpdates(page);
  await page.getByRole("button", { name: "Remind me later" }).click();
  await expect(page.getByRole("button", { name: /Update available/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: /Update available/ })).toBeVisible({ timeout: 10_000 });
  expect(await calls(page)).not.toContain("plugin:updater|download_and_install");
});

for (const mode of ["offline", "current", "bad-signature"]) {
  test(`updater handles ${mode} without restarting`, async ({ page }) => {
    await mockDesktop(page, mode);
    await page.goto("/");
    await openUpdates(page);
    if (mode === "bad-signature") await page.getByRole("button", { name: "Update", exact: true }).click();
    if (mode === "current") await expect(page.getByText("VPS Pilot is up to date", { exact: true })).toBeVisible();
    else await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
    expect(await calls(page)).not.toContain("plugin:process|restart");
  });
}

test("Settings preserves server navigation and only available updates appear in the sidebar footer", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  const sidebar = page.getByRole("navigation", { name: "Production tools", exact: true });
  await expect(sidebar.getByRole("button", { name: "Check for updates", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /Update available/ })).toBeVisible({ timeout: 10_000 });
  const notice = await sidebar.getByRole("button", { name: /Update available/ }).boundingBox();
  const bounds = await sidebar.boundingBox();
  expect(notice!.y).toBeGreaterThan(bounds!.y + bounds!.height / 2);
  const settings = sidebar.getByRole("button", { name: "Settings", exact: true });
  await settings.click();
  await expect(sidebar.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "VPS workspaces" })).toBeVisible();
  const content = page.getByRole("main", { name: "Application settings" });
  await expect(content.getByRole("heading", { name: "Application updates" })).toBeVisible();
  const mainBounds = await content.boundingBox();
  const sectionBounds = await content.locator("section").first().boundingBox();
  expect(sectionBounds!.width).toBeGreaterThan(mainBounds!.width - 80);
  await sidebar.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(content).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
});
