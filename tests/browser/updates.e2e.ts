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

const calls = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).__updateCalls as string[]);

test("update requires consent, reports progress, and retains restart fallback", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect(page.getByText("Improved terminal layouts", { exact: true })).toBeVisible();
  await expect(page.getByText(/closes all SSH connections/)).toBeVisible();
  expect(await calls(page)).not.toContain("plugin:updater|download_and_install");
  await page.getByRole("button", { name: "Update and restart" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "50");
  await expect(page.getByRole("button", { name: "Restart VPS Pilot" })).toBeVisible();
  expect((await calls(page)).filter(cmd => cmd === "plugin:updater|download_and_install")).toHaveLength(1);
  await page.getByRole("button", { name: "Restart later" }).click();
  await page.getByRole("button", { name: "App update", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restart VPS Pilot" })).toBeVisible();
});

test("skipped version survives relaunch and a manual check still offers it", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await page.getByRole("button", { name: "Skip this version" }).click();
  await page.reload();
  await page.waitForTimeout(4500);
  await expect(page.getByRole("button", { name: "View update" })).toHaveCount(0);
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect(page.getByRole("button", { name: "Update and restart" })).toBeVisible();
  expect(await calls(page)).not.toContain("plugin:updater|download_and_install");
});

test("later dismisses the notice until next launch", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await page.getByRole("button", { name: "Remind me later" }).click();
  await expect(page.getByRole("button", { name: "View update" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "View update" })).toBeVisible({ timeout: 10_000 });
  expect(await calls(page)).not.toContain("plugin:updater|download_and_install");
});

for (const mode of ["offline", "current", "bad-signature"]) {
  test(`updater handles ${mode} without restarting`, async ({ page }) => {
    await mockDesktop(page, mode);
    await page.goto("/");
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    if (mode === "bad-signature") await page.getByRole("button", { name: "Update and restart" }).click();
    if (mode === "current") await expect(page.getByText("VPS Pilot is up to date.", { exact: true })).toBeVisible();
    else await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
    expect(await calls(page)).not.toContain("plugin:process|restart");
  });
}
