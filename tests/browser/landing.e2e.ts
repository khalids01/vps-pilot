import { expect, test } from "@playwright/test";

const api = "https://api.github.com/repos/khalids01/vps-pilot/releases/latest";

test("landing page maps real release assets and fits mobile", async ({ page }) => {
  await page.route(api, (route) =>
    route.fulfill({
      json: {
        tag_name: "v0.1.0",
        assets: [
          {
            name: "VPS.Pilot_0.1.0_amd64.deb",
            browser_download_url:
              "https://github.com/khalids01/vps-pilot/releases/download/v0.1.0/VPS.Pilot_0.1.0_amd64.deb",
          },
          {
            name: "unsafe_x64-setup.exe",
            browser_download_url: "https://example.com/untrusted.exe",
          },
        ],
      },
    }),
  );
  await page.goto("/website/");
  await expect(page.getByRole("status")).toHaveText("Latest release: v0.1.0");
  await expect(
    page.getByRole("link", { name: "Debian / Ubuntu · x64" }),
  ).toHaveAttribute("href", /github.com\/khalids01\/vps-pilot\/releases\/download/);
  await expect(page.locator('a[href*="example.com"]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("landing page explains an unpublished first release", async ({ page }) => {
  await page.route(api, (route) => route.fulfill({ status: 404, json: {} }));
  await page.goto("/website/");
  await expect(page.getByRole("status")).toContainText(
    "first release is being prepared",
  );
  await expect(
    page.getByRole("link", { name: "Check GitHub releases" }),
  ).toHaveCount(3);
});

test("landing page keeps a release fallback when the API is unavailable", async ({
  page,
}) => {
  await page.route(api, (route) => route.abort());
  await page.goto("/website/");
  await expect(page.getByRole("status")).toContainText(
    "Could not load the download list",
  );
  await expect(
    page.getByRole("link", { name: "Check GitHub releases" }),
  ).toHaveCount(3);
});
