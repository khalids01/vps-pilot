const repository = "https://github.com/khalids01/vps-pilot";
const status = document.querySelector("#release-status");
const downloads = document.querySelector("#downloads");
const platforms = [
  { name: "Linux", formats: [["Debian / Ubuntu · x64", /_amd64\.deb$/, "VPS-Pilot-linux-x64.deb"], ["AppImage · x64", /_amd64\.AppImage$/, "VPS-Pilot-linux-x64.AppImage"], ["RPM · x64", /\.x86_64\.rpm$/, "VPS-Pilot-linux-x64.rpm"]] },
  { name: "Windows", formats: [["Installer · x64", /_x64-setup\.exe$/, "VPS-Pilot-windows-x64-setup.exe"], ["MSI · x64", /_x64_en-US\.msi$/, "VPS-Pilot-windows-x64.msi"]] },
  { name: "macOS", formats: [["Apple Silicon", /_aarch64\.dmg$/, "VPS-Pilot-macos-apple-silicon.dmg"], ["Intel", /_x64\.dmg$/, "VPS-Pilot-macos-intel.dmg"]] },
];
function render(release, latest = false) {
  for (const platform of platforms) {
    const card = document.createElement("article");
    card.className = "download";
    const heading = document.createElement("h3");
    heading.textContent = platform.name;
    card.append(heading);
    let found = false;
    for (const [label, pattern, stableName] of platform.formats) {
      const stable = release?.assets?.find((item) => item.name === stableName);
      const asset = stable || release?.assets?.find((item) => pattern.test(item.name));
      if (!latest) {
        if (!asset) continue;
        try {
          const url = new URL(asset.browser_download_url);
          if (url.origin !== "https://github.com" || !url.pathname.startsWith("/khalids01/vps-pilot/releases/download/")) continue;
        } catch { continue; }
      }
      const link = document.createElement("a");
      link.href = latest || stable
        ? repository + "/releases/latest/download/" + stableName
        : asset.browser_download_url;
      link.textContent = "Download " + label + " ↓";
      link.className = "download-button";
      card.append(link);
      found = true;
    }
    if (!found) {
      const link = document.createElement("a");
      link.href = repository + "/releases";
      link.textContent = "Check GitHub releases ↗";
      card.append(link);
    }
    downloads.append(card);
  }
}
async function load() {
  try {
    const response = await fetch("downloads.json", { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Release lookup failed");
    const release = await response.json();
    if (!release) {
      status.textContent = "The first release is being prepared. Downloads will appear here after it is published.";
      render(null);
      return;
    }
    const latest = platforms.every(platform => platform.formats.every(([, , name]) => release.assets?.some(asset => asset.name === name)));
    status.textContent = latest ? "Download the latest published release." : "Latest release: " + release.tag_name;
    render(release);
  } catch {
    status.textContent = "Download the latest published release.";
    render(null, true);
  }
}
load();
