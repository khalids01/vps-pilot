import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Exercise the actual publish script without publishing a GitHub release.
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const publish = workflow.split("  publish:\n")[1].split("  deploy-downloads:\n")[0];
const script = publish.split("          script: |\n")[1].split("\n").map(line => line.slice(12)).join("\n");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

async function simulate(missingSignature = false, failInstallerCopy = false, wrongRelease = false) {
  const suffixes = ["_amd64.deb", "_amd64.AppImage", ".x86_64.rpm", "_x64-setup.exe", "_x64_en-US.msi", "_aarch64.dmg", "_x64.dmg", "_aarch64.app.tar.gz", "_x64.app.tar.gz"];
  const assets = suffixes.flatMap((suffix, index) => {
    const name = `VPS.Pilot_0.2.0${suffix}`;
    const artifact = { id: index * 2, name, browser_download_url: `https://github.com/example/vps-pilot/releases/download/v0.2.0-build.99/${name}` };
    return [{ ...artifact }, { ...artifact, id: index * 2 + 1, name: name + ".sig" }];
  }).filter(a => !(missingSignature && a.name.endsWith("_amd64.deb.sig")));
  const uploaded = new Map<string, Buffer>();
  let published = false;
  const uploadedById = new Map<number,Buffer>();
  const github = {
    rest: { repos: {
      getRelease: async ({ release_id }: { release_id: number }) => { expect(release_id).toBe(42); return {data: {id:42, tag_name: wrongRelease ? "different-tag" : "v0.2.0-build.99", draft:true, target_commitish:"commit", body:"Terminal improvements"}}; }, listReleaseAssets: "assets",
      deleteReleaseAsset: async () => {},
      uploadReleaseAsset: async ({ name, data }: { name: string; data: Buffer }) => {
        if(failInstallerCopy && name==="VPS-Pilot-macos-apple-silicon.dmg")throw new Error("Installer copy failed");
        uploaded.set(name, data);
        const id=1000+uploaded.size;
        uploadedById.set(id,data);
        return { data: { id, name } };
      },
      updateRelease: async () => { published = true; },
    } },
    paginate: async (method: string) => method === "releases" ? [{ id: 42, tag_name: "v0.2.0-build.99", body: "Terminal improvements" }] : assets,
    request: async (_: string, { asset_id }: { asset_id: number }) => ({ data: uploadedById.has(asset_id) ? uploadedById.get(asset_id) : Buffer.from(asset_id % 2 ? "signed-artifact" : "artifact-bytes") }),
  };
  const run = new AsyncFunction("github", "context", "require", "process", script);
  await run(github, { repo: { owner: "example", repo: "vps-pilot" }, sha: "commit" }, (name: string) => name === "node:fs" ? { readFileSync: (path: string) => path === 'package.json' ? '{"version":"0.2.0"}' : 'Terminal improvements' } : { createHash }, { env: { RELEASE_ID: "42", RELEASE_TAG: "v0.2.0-build.99" } });
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
  for(const name of ["VPS-Pilot-linux-x64.deb","VPS-Pilot-linux-x64.AppImage","VPS-Pilot-linux-x64.rpm","VPS-Pilot-windows-x64-setup.exe","VPS-Pilot-windows-x64.msi","VPS-Pilot-macos-apple-silicon.dmg","VPS-Pilot-macos-intel.dmg"]){
    expect(uploaded.get(name)!.toString()).toBe("artifact-bytes");
    expect(uploaded.get("SHA256SUMS.txt")!.toString()).toContain("  "+name);
  }
  expect(published).toBe(true);
});

test("release refuses an unsigned updater asset", async () => {
  await expect(simulate(true)).rejects.toThrow("Missing signature");
});


test("release refuses to publish when a permanent installer copy fails",async()=>{
  await expect(simulate(false,true)).rejects.toThrow("Installer copy failed");
});

test("publisher refuses a different release identity", async () => {
  await expect(simulate(false, false, true)).rejects.toThrow("Release identity mismatch");
});
test("every build uploads to the one prepared draft", () => {
  expect(workflow).toContain("releaseId: ${{ needs.prepare.outputs.release_id }}");
  expect(workflow).toContain("RELEASE_ID: ${{ needs.prepare.outputs.release_id }}");
  expect(publish).not.toContain("listReleases");
});

const prepare = workflow.split("  prepare:\n")[1].split("  build:\n")[0];
const prepareScript = prepare.split("          script: |\n")[1].split("\n").map(line => line.slice(12)).join("\n");
async function prepareDraft(existing: unknown[] = []) {
  const outputs = new Map<string, string>();
  let creates = 0;
  const release = {id: 42, tag_name: "v0.2.0-build.99", target_commitish: "commit", draft: true};
  const github = {paginate: async () => existing, rest: {repos: {
    listReleases: "releases",
    createRelease: async (request: unknown) => { creates++; expect(request).toMatchObject({target_commitish: "commit", draft: true}); return {data: release}; },
  }}};
  await new AsyncFunction("github", "context", "require", "core", prepareScript)(github,
    {repo: {owner: "example", repo: "vps-pilot"}, runNumber: 99, sha: "commit"},
    () => ({readFileSync: () => '{"version":"0.2.0"}'}),
    {setOutput: (key: string, value: string) => outputs.set(key, value)});
  return {outputs, creates, release};
}
test("prepare creates one draft, and reruns reuse that exact draft", async () => {
  const first = await prepareDraft();
  expect(first.creates).toBe(1);
  expect(first.outputs.get("release_id")).toBe("42");
  const again = await prepareDraft([first.release]);
  expect(again.creates).toBe(0);
  expect(again.outputs.get("release_id")).toBe("42");
  await expect(prepareDraft([first.release, first.release])).rejects.toThrow("Multiple release drafts");
  await expect(prepareDraft([{...first.release, target_commitish:"other"}])).rejects.toThrow("Release identity mismatch");
});
