import { expect, test } from "@playwright/test";

const api = "**/downloads.json";

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
  await page.route(api, (route) => route.fulfill({ json: null }));
  await page.goto("/website/");
  await expect(page.getByRole("status")).toContainText(
    "first release is being prepared",
  );
  await expect(
    page.getByRole("link", { name: "Check GitHub releases" }),
  ).toHaveCount(3);
});

test("landing page keeps a release fallback when the manifest is unavailable", async ({
  page,
}) => {
  await page.route(api, (route) => route.abort());
  await page.goto("/website/");
  await expect(page.getByRole("status")).toContainText(
    "Download the latest published release",
  );
  await expect(
    page.locator("#downloads .download-button"),
  ).toHaveCount(7);
});

test("all desktop installer formats have direct download buttons without browser API calls", async ({ page }) => {
  let apiCalls = 0;
  page.on("request", request => {
    if (request.url().startsWith("https://api.github.com/")) apiCalls++;
  });
  const names = [
    "VPS.Pilot_0.1.0_amd64.deb", "VPS.Pilot_0.1.0_amd64.AppImage",
    "VPS.Pilot-0.1.0-1.x86_64.rpm", "VPS.Pilot_0.1.0_x64-setup.exe",
    "VPS.Pilot_0.1.0_x64_en-US.msi", "VPS.Pilot_0.1.0_aarch64.dmg",
    "VPS.Pilot_0.1.0_x64.dmg"
  ];
  await page.route(api, route => route.fulfill({json: {
    tag_name: "v0.1.0-build.2",
    assets: names.map(name => ({
      name,
      browser_download_url: "https://github.com/khalids01/vps-pilot/releases/download/v0.1.0-build.2/" + name
    }))
  }}));
  await page.goto("/website/");
  await expect(page.locator("#downloads .download-button")).toHaveCount(7);
  await expect(page.getByRole("link", {name: "Check GitHub releases"})).toHaveCount(0);
  expect(apiCalls).toBe(0);
});


test("cached download metadata still links every installer to GitHub latest",async({page})=>{
 const names=["VPS-Pilot-linux-x64.deb","VPS-Pilot-linux-x64.AppImage","VPS-Pilot-linux-x64.rpm","VPS-Pilot-windows-x64-setup.exe","VPS-Pilot-windows-x64.msi","VPS-Pilot-macos-apple-silicon.dmg","VPS-Pilot-macos-intel.dmg"];
 await page.route(api,route=>route.fulfill({json:{tag_name:"v0.2.0-old-build",assets:names.map(name=>({name,browser_download_url:"https://github.com/khalids01/vps-pilot/releases/download/v0.2.0-old-build/"+name}))}}));
 await page.goto("/website/");
 const links=page.locator("#downloads .download-button");
 await expect(links).toHaveCount(7);
 for(const link of await links.all()) await expect(link).toHaveAttribute("href",/^https:\/\/github.com\/khalids01\/vps-pilot\/releases\/latest\/download\//);
 await expect(page.getByRole("status")).not.toContainText("old-build");
});
