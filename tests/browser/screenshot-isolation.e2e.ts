import { expect, test } from "@playwright/test";
import {
  expectNoUnexpectedNativeCalls,
  installMarketingMock,
  marketingAllowedCommands,
} from "../screenshots/marketing-mock";

async function blockExternal(page: import("@playwright/test").Page) {
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.protocol === "data:" ||
      url.protocol === "blob:"
    ) {
      await route.continue();
      return;
    }
    blocked.push(url.href);
    await route.abort();
  });
  return blocked;
}

test("screenshot bridge rejects native calls outside its synthetic allowlist", async ({
  page,
}) => {
  await installMarketingMock(page, { page: "fleet" });
  await page.goto("/");
  await expect(page.getByRole("main", { name: "Server fleet" })).toBeVisible({
    timeout: 15_000,
  });

  const result = await page.evaluate(async () => {
    const target = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
      __marketingCalls: { cmd: string }[];
      __marketingUnexpectedCalls: string[];
      __marketingMock?: boolean;
      isTauri?: boolean;
    };
    let rejected = false;
    try {
      await target.__TAURI_INTERNALS__.invoke("ssh_delete_profile", {
        profileId: "fictional-profile",
      });
    } catch {
      rejected = true;
    }
    return {
      rejected,
      mock: target.__marketingMock === true,
      tauri: target.isTauri === true,
      calls: target.__marketingCalls.map((call) => call.cmd),
      unexpected: target.__marketingUnexpectedCalls,
      storageKeys: Object.keys(localStorage),
      cookie: document.cookie,
    };
  });

  expect(result.rejected).toBe(true);
  expect(result.mock).toBe(true);
  expect(result.tauri).toBe(true);
  expect(result.unexpected).toEqual(["ssh_delete_profile"]);
  expect(result.calls).toContain("ssh_delete_profile");
  for (const command of result.calls.filter(
    (command) => command !== "ssh_delete_profile",
  )) {
    expect(marketingAllowedCommands).toContain(command);
  }
  expect(result.storageKeys.filter((key) => key.startsWith("vps-pilot"))).toEqual(
    [],
  );
  expect(result.cookie).toBe("");
});

test("screenshot bridge never reaches non-local network or real app storage", async ({
  page,
}) => {
  const blocked = await blockExternal(page);
  await installMarketingMock(page, { page: "server", tool: "overview" });
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Storefront web tools" }),
  ).toBeVisible({ timeout: 15_000 });

  const fetchBlocked = await page.evaluate(async () => {
    try {
      await fetch("https://example.com/marketing-isolation", {
        mode: "no-cors",
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(fetchBlocked).toBe(true);
  expect(blocked).toContain("https://example.com/marketing-isolation");

  const storage = await page.evaluate(() => ({
    keys: Object.keys(localStorage),
    documents: Object.entries(localStorage).filter(([key]) =>
      key.startsWith("vps-pilot"),
    ),
  }));
  expect(storage.keys.filter((key) => key.startsWith("vps-pilot"))).toEqual([]);
  expect(storage.documents).toEqual([]);
  await expectNoUnexpectedNativeCalls(page);
});
