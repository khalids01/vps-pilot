import { expect, test } from "@playwright/test";

for (const metadata of ["stale", "unavailable"]) {
  test("latest downloads remain correct when website metadata is " + metadata, async ({page}) => {
    let lookups=0;
    page.on("request", request=>{
      if(request.url().includes("/downloads.json") || request.url().startsWith("https://api.github.com/")) lookups++;
    });
    await page.route("**/downloads.json",route=>metadata==="unavailable"?route.abort():route.fulfill({json:{
      tag_name:"v0.1.0",
      assets:[{name:"old_aarch64.dmg",browser_download_url:"https://example.com/old.dmg"}]
    }}));
    await page.goto("/website/");
    const links=page.locator("#downloads .download-button");
    await expect(links).toHaveCount(7);
    for(const link of await links.all()) await expect(link).toHaveAttribute("href",/^https:\/\/github.com\/khalids01\/vps-pilot\/releases\/latest\/download\//);
    await expect(page.getByRole("status")).toHaveText("Download the latest published release.");
    await expect(page.locator('a[href*="example.com"]')).toHaveCount(0);
    expect(lookups).toBe(0);
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

test("all supported installers have permanent latest-release download links",async({page})=>{
  await page.goto("/website/");
  const names=["VPS-Pilot-linux-x64.deb","VPS-Pilot-linux-x64.AppImage","VPS-Pilot-linux-x64.rpm","VPS-Pilot-windows-x64-setup.exe","VPS-Pilot-windows-x64.msi","VPS-Pilot-macos-apple-silicon.dmg","VPS-Pilot-macos-intel.dmg"];
  for(const name of names)await expect(page.locator('#downloads a[href$="/'+name+'"]')).toHaveCount(1);
});
