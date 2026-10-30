import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8")
  .split("[lib]")[0]
  .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (pkg.version !== config.version || pkg.version !== cargo) {
  throw new Error("package.json, tauri.conf.json, and Cargo.toml versions must match");
}
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : process.argv[2];
if (tag && tag !== `v${pkg.version}`) {
  throw new Error(`Release tag must be v${pkg.version}`);
}
console.log(`Release version verified: ${pkg.version}`);
