import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const destination = process.argv[2] || "_site";
const release = JSON.parse(readFileSync("website/downloads.json", "utf8"));
if (release !== null && (typeof release.tag_name !== "string" || !/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(release.tag_name) || !Array.isArray(release.assets))) {
  throw new Error("Invalid public release manifest");
}
mkdirSync(destination, { recursive: true });
cpSync("website", destination, { recursive: true });
const data = JSON.stringify(release).replaceAll("<", "\\u003c");
let html = readFileSync("website/index.html", "utf8").replace(
  '<script id="release-data" type="application/json">null</script>',
  `<script id="release-data" type="application/json">${data}</script>`,
);
if (release) {
  html = html.replaceAll("Release information pending", release.tag_name)
    .replace("Loading published release…", `${release.tag_name} · Latest published release`)
    .replace('<span data-version></span>', `<span data-version>${release.tag_name}</span>`);
}
writeFileSync(`${destination}/index.html`, html);
