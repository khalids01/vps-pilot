const repository = "https://github.com/khalids01/vps-pilot";
const status = document.querySelector("#release-status");
const downloads = document.querySelector("#downloads");
const platforms = [
  { name: "Linux", formats: [["Debian / Ubuntu · x64", /_amd64\.deb$/], ["AppImage · x64", /_amd64\.AppImage$/], ["RPM · x64", /\.x86_64\.rpm$/]] },
  { name: "Windows", formats: [["Installer · x64", /_x64-setup\.exe$/], ["MSI · x64", /_x64_en-US\.msi$/]] },
  { name: "macOS", formats: [["Apple Silicon", /_aarch64\.dmg$/], ["Intel", /_x64\.dmg$/]] },
];
function render(release) {
  for (const platform of platforms) {
    const card = document.createElement("article");
    card.className = "download";
    const heading = document.createElement("h3");
    heading.textContent = platform.name;
    card.append(heading);
    let found = false;
    for (const [label, pattern] of platform.formats) {
      const asset = release?.assets?.find((item) => pattern.test(item.name));
      if (!asset) continue;
      const url = new URL(asset.browser_download_url);
      if (url.origin !== "https://github.com" || !url.pathname.startsWith("/khalids01/vps-pilot/releases/download/")) continue;
      const link = document.createElement("a");
      link.href = url.href;
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
    const response = await fetch("downloads.json", { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Release lookup failed");
    const release = await response.json();
    if (!release) {
      status.textContent = "The first release is being prepared. Downloads will appear here after it is published.";
      render(null);
      return;
    }
    status.textContent = "Latest release: " + release.tag_name;
    render(release);
  } catch {
    status.textContent = "Could not load the download list. You can still browse releases on GitHub.";
    render(null);
  }
}
load();
