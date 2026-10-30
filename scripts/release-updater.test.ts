import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Exercise the actual publish script without publishing a GitHub release.
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const publish = workflow.split("  publish:\n")[1].split("  deploy-downloads:\n")[0];
const script = publish.split("          script: |\n")[1].split("\n").map(line => line.slice(12)).join("\n");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

async function simulate(missingSignature = false) {
  const suffixes = ["_amd64.deb", "_amd64.AppImage", ".x86_64.rpm", "_x64-setup.exe", "_x64_en-US.msi", "_aarch64.dmg", "_x64.dmg", "_aarch64.app.tar.gz", "_x64.app.tar.gz"];
  const assets = suffixes.flatMap((suffix, index) => {
    const name = `VPS.Pilot_0.2.0${suffix}`;
    const artifact = { id: index * 2, name, browser_download_url: `https://github.com/example/vps-pilot/releases/download/v0.2.0-build.99/${name}` };
    return [{ ...artifact }, { ...artifact, id: index * 2 + 1, name: name + ".sig" }];
  }).filter(a => !(missingSignature && a.name.endsWith("_amd64.deb.sig")));
  const uploaded = new Map<string, Buffer>();
  let published = false;
  const github = {
    rest: { repos: {
      listReleases: "releases", listReleaseAssets: "assets",
      deleteReleaseAsset: async () => {},
      uploadReleaseAsset: async ({ name, data }: { name: string; data: Buffer }) => {
        uploaded.set(name, data);
        return { data: { id: 999, name } };
      },
      updateRelease: async () => { published = true; },
    } },
    paginate: async (method: string) => method === "releases" ? [{ id: 42, tag_name: "v0.2.0-build.99", body: "Terminal improvements" }] : assets,
    request: async (_: string, { asset_id }: { asset_id: number }) => ({ data: asset_id === 999 ? uploaded.get("latest.json") : Buffer.from(asset_id % 2 ? "signed-artifact" : "artifact-bytes") }),
  };
  const run = new AsyncFunction("github", "context", "require", "process", script);
  await run(github, { repo: { owner: "example", repo: "vps-pilot" } }, (name: string) => name === "node:fs" ? { readFileSync: (path: string) => path === 'package.json' ? '{"version":"0.2.0"}' : 'Terminal improvements' } : { createHash }, { env: { RELEASE_TAG: "v0.2.0-build.99" } });
  return { uploaded, published };
}

test("release publishes signed targets with the embedded version and checksums the manifest", async () => {
  const { uploaded, published } = await simulate();
  const bytes = uploaded.get("latest.json")!;
  const manifest = JSON.parse(bytes.toString());
  expect(manifest.version).toBe("0.2.0");
  expect(manifest.notes).toBe("Terminal improvements");
  expect(Object.keys(manifest.platforms)).toHaveLength(11);
  expect(manifest.platforms["linux-x86_64-deb"].url).toEndWith("_amd64.deb");
  expect(manifest.platforms["darwin-aarch64"].url).toEndWith("_aarch64.app.tar.gz");
  for (const target of Object.values(manifest.platforms) as { signature: string }[]) expect(target.signature).toBe("signed-artifact");
  expect(uploaded.get("SHA256SUMS.txt")!.toString()).toContain(createHash("sha256").update(bytes).digest("hex") + "  latest.json");
  expect(published).toBe(true);
});

test("release refuses an unsigned updater asset", async () => {
  await expect(simulate(true)).rejects.toThrow("Missing signature");
});
