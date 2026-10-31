const repository = "https://github.com/khalids01/vps-pilot";
const platforms = [
  { name: "Linux", formats: [
    ["Debian / Ubuntu · x64", "VPS-Pilot-linux-x64.deb"],
    ["AppImage · x64", "VPS-Pilot-linux-x64.AppImage"],
    ["RPM · x64", "VPS-Pilot-linux-x64.rpm"],
  ] },
  { name: "Windows", formats: [
    ["Installer · x64", "VPS-Pilot-windows-x64-setup.exe"],
    ["MSI · x64", "VPS-Pilot-windows-x64.msi"],
  ] },
  { name: "macOS", formats: [
    ["Apple Silicon", "VPS-Pilot-macos-apple-silicon.dmg"],
    ["Intel", "VPS-Pilot-macos-intel.dmg"],
  ] },
];
// These names are required on every release before it can become latest.
// No cached manifest, version-specific URLs or browser API lookup is involved.
document.querySelector("#release-status").textContent = "Download the latest published release.";
const downloads = document.querySelector("#downloads");
for (const platform of platforms) {
  const card = document.createElement("article");
  card.className = "download";
  const heading = document.createElement("h3");
  heading.textContent = platform.name;
  card.append(heading);
  for (const [label, name] of platform.formats) {
    const link = document.createElement("a");
    link.href = repository + "/releases/latest/download/" + name;
    link.textContent = "Download " + label + " ↓";
    link.className = "download-button";
    card.append(link);
  }
  downloads.append(card);
}
