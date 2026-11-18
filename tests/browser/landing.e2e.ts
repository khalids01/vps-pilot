import { expect, test } from "@playwright/test";

for (const metadata of ["stale", "unavailable"]) {
  test("release metadata is handled consistently when " + metadata, async ({page}) => {
    await page.route("**/downloads.json", route => metadata === "unavailable" ? route.abort() : route.fulfill({json:{tag_name:"v0.1.0",assets:[{name:"VPS-Pilot-linux-x64.deb",browser_download_url:"https://example.com/old.deb"}]}}));
    await page.goto("/website/");
    const links = page.locator("#downloads .download-button");
    await expect(links).toHaveCount(7);
    for (const link of await links.all()) await expect(link).toHaveAttribute("href",metadata === "unavailable" ? "https://github.com/khalids01/vps-pilot/releases" : "https://github.com/khalids01/vps-pilot/releases/tag/v0.1.0");
    await expect(page.locator(".version")).toHaveText(metadata === "unavailable" ? "Release unavailable" : "v0.1.0");
    await expect(page.locator('a[href*="example.com"]')).toHaveCount(0);
  });
}

test("all supported installers match the displayed published version",async({page})=>{
  await page.goto("/website/");
  const names=["VPS-Pilot-linux-x64.deb","VPS-Pilot-linux-x64.AppImage","VPS-Pilot-linux-x64.rpm","VPS-Pilot-windows-x64-setup.exe","VPS-Pilot-windows-x64.msi","VPS-Pilot-macos-apple-silicon.dmg","VPS-Pilot-macos-intel.dmg"];
  await expect(page.locator(".version")).toHaveText(/v\d+\.\d+\.\d+/);
  const tag = await page.locator(".version").textContent();
  for(const name of names)await expect(page.locator('#downloads a[href$="/'+name+'"]')).toHaveAttribute("href", `https://github.com/khalids01/vps-pilot/releases/download/${tag}/${name}`);
});

test("landing page uses generated local app screenshots and a single clear hero",async({page})=>{
  const external:string[]=[];
  page.on("request",request=>{
    const url=new URL(request.url());
    if(url.origin!=="http://127.0.0.1:1430")external.push(request.url());
  });
  await page.goto("/website/");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator(".hero-shot img")).toHaveAttribute("src","assets/screenshots/overview.png");
  await expect(page.locator(".preview")).toHaveCount(0);
  await expect(page.locator("blockquote")).toHaveCount(0);
  await page.locator("#screenshots").scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>[...document.images].every(image=>image.complete));
  const images=page.locator("main img");
  const count=await images.count();
  expect(count).toBeGreaterThanOrEqual(5);
  for(let index=0;index<count;index++){
    const image=images.nth(index);
    await expect(image).toHaveAttribute("alt",/./);
    expect(await image.evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBeGreaterThan(1000);
  }
  expect(external).toEqual([]);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
