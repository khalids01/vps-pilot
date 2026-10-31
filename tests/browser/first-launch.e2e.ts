import { expect, test } from "@playwright/test";

test("fresh launch opens Home without automatically opening sample server tabs",async({page})=>{
  await page.goto("/");
  await expect(page.getByRole("main",{name:"Server fleet"})).toBeVisible();
  await expect(page.getByRole("tablist",{name:"VPS workspaces"}).getByRole("tab")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("main",{name:"Server fleet"})).toBeVisible();
  await expect(page.getByRole("tablist",{name:"VPS workspaces"}).getByRole("tab")).toHaveCount(0);
});
