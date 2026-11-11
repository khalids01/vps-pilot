import { expect, test } from "@playwright/test";
import {
  apiProfileId,
  expectNoUnexpectedNativeCalls,
  installMarketingMock,
  webProfileId,
} from "./marketing-mock";

const output = (name: string) => `docs/screenshots/${name}.png`;

async function blockExternalNetwork(page: import("@playwright/test").Page) {
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.protocol === "data:" ||
      url.protocol === "blob:" ||
      ((url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        (url.port === "1430" || url.port === ""))
    ) {
      await route.continue();
      return;
    }
    blocked.push(request.url());
    await route.abort();
  });
  return blocked;
}

async function capture(
  page: import("@playwright/test").Page,
  name: string,
  blocked: string[],
) {
  await expectNoUnexpectedNativeCalls(page);
  expect(blocked, "Screenshots must not reach non-local network services").toEqual(
    [],
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __marketingCalls?: { cmd: string }[];
              }
            ).__marketingCalls?.filter(
              (call) => call.cmd === "ssh_stream_ack",
            ).length ?? 0,
        ),
      { timeout: 5_000 },
    )
    .toBeGreaterThanOrEqual(4);
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}.xterm-cursor-layer,.xterm-cursor{visibility:hidden!important}",
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(80);
  await page.screenshot({
    path: output(name),
    animations: "disabled",
    caret: "hide",
  });
}

test("capture server fleet", async ({ page }) => {
  const blocked = await blockExternalNetwork(page);
  await installMarketingMock(page, {
    page: "fleet",
    openProfiles: [webProfileId, apiProfileId],
  });
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Storefront web tools" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: "CPU live metrics details" }),
  ).toContainText("%");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __marketingCalls?: { cmd: string }[];
            }
          ).__marketingCalls?.filter(
            (call) => call.cmd === "ssh_monitor_start",
          ).length ?? 0,
      ),
    )
    .toBe(2);
  await page.getByRole("button", { name: "Fleet home" }).click();
  await expect(
    page.getByRole("main", { name: "Server fleet" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page
      .getByRole("main", { name: "Server fleet" })
      .getByRole("button", { name: "Storefront web", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Cached · last sampled/)).toHaveCount(2);
  await capture(page, "fleet-home", blocked);
});

test("capture live overview", async ({ page }) => {
  const blocked = await blockExternalNetwork(page);
  await installMarketingMock(page, { page: "server", tool: "overview" });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Storefront web tools" });
  await expect(nav).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(
    page.getByText("Debian GNU/Linux 12 (bookworm)", { exact: true }),
  ).toBeVisible();
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(page.getByText("Collecting…")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "CPU live metrics details" }),
  ).toContainText("%");
  await capture(page, "overview", blocked);
});

test("capture Docker inventory with a container inspector", async ({ page }) => {
  const blocked = await blockExternalNetwork(page);
  await installMarketingMock(page, { page: "server", tool: "docker" });
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Storefront web tools" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Showing 6 of 6 containers")).toBeVisible();
  await page.getByRole("button", { name: "storefront-web", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Container details" }),
  ).toBeVisible();
  await capture(page, "docker", blocked);
});

test("capture remote files", async ({ page }) => {
  const blocked = await blockExternalNetwork(page);
  await installMarketingMock(page, { page: "server", tool: "files" });
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Storefront web tools" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-file-path="/srv"]')).toBeVisible();
  await page.locator('[data-file-path="/srv"]').click();
  await expect(
    page.locator('[data-file-path="/srv/docker-compose.yml"]'),
  ).toBeVisible();
  await page.locator('[data-file-path="/srv/docker-compose.yml"]').click();
  await expect(
    page.locator('[aria-label="Remote file editor"]'),
  ).toContainText("services:");
  await capture(page, "files", blocked);
});

test("capture a live terminal session", async ({ page }) => {
  const blocked = await blockExternalNetwork(page);
  await installMarketingMock(page, { page: "server", tool: "terminal" });
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Storefront web tools" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "New shell", exact: true }).click();
  await expect(page.locator(".xterm-rows")).toContainText("deploy@web-01", {
    timeout: 15_000,
  });
  await capture(page, "terminal", blocked);
});
