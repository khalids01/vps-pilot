import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const result = Bun.spawnSync(
  ["bunx", "playwright", "test", "--config", "playwright.screenshots.config.ts"],
  { stdout: "inherit", stderr: "inherit" },
);
if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);

const source = "docs/screenshots";
const destination = "website/assets/screenshots";
await mkdir(destination, { recursive: true });
for (const file of await readdir(source)) {
  if (file.endsWith(".png")) {
    await copyFile(join(source, file), join(destination, file));
  }
}
console.log(`Updated README and website screenshots from ${source}.`);
