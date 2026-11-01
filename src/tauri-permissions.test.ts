import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { TOML } from "bun";

test("main window permissions cover registered application IPC commands", () => {
  const native = new URL("../src-tauri/", import.meta.url);
  const capability = JSON.parse(
    readFileSync(new URL("capabilities/default.json", native), "utf8"),
  );
  expect(capability.windows).toContain("main");
  expect(capability.local).toBe(true);
  const allowed = new Set<string>();
  for (const file of readdirSync(new URL("permissions/", native))) {
    if (!file.endsWith(".toml")) continue;
    const definitions = TOML.parse(
      readFileSync(new URL(`permissions/${file}`, native), "utf8"),
    );
    for (const permission of definitions.permission) {
      if (capability.permissions.includes(permission.identifier)) {
        for (const command of permission.commands?.allow ?? []) {
          allowed.add(command);
        }
      }
    }
  }
  const source = readFileSync(new URL("src/lib.rs", native), "utf8");
  const handlers = source.match(/tauri::generate_handler!\[([\s\S]*?)\]/)?.[1];
  expect(handlers).toBeDefined();
  const registered = [...handlers.matchAll(/(?:[a-z_]+::)+([a-z_]+)/g)].map(
    (match) => match[1],
  );
  expect(registered.length).toBeGreaterThan(0);
  expect(registered.filter((command) => !allowed.has(command))).toEqual([]);
});
