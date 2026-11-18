const repository = "https://github.com/khalids01/vps-pilot";
const platforms = [
  {
    name: "Linux",
    icon: ">_",
    description:
      "A portable AppImage or native packages for Debian, Ubuntu, Fedora and RHEL. x64 desktops.",
    formats: [
      ["AppImage", "VPS-Pilot-linux-x64.AppImage"],
      ["Debian / Ubuntu", "VPS-Pilot-linux-x64.deb"],
      ["Fedora / RHEL", "VPS-Pilot-linux-x64.rpm"],
    ],
  },
  {
    name: "macOS",
    icon: "⌘",
    description:
      "Native builds for Apple Silicon and Intel Macs. Choose the architecture of your Mac.",
    note: "Ad-hoc signed; not Apple notarized.",
    formats: [
      ["Apple Silicon", "VPS-Pilot-macos-apple-silicon.dmg"],
      ["Intel", "VPS-Pilot-macos-intel.dmg"],
    ],
  },
  {
    name: "Windows",
    icon: "⊞",
    description:
      "A standard setup executable or Windows Installer package. Both for 64-bit Windows.",
    note: "Unsigned installers may show a publisher warning.",
    formats: [
      ["Setup .exe", "VPS-Pilot-windows-x64-setup.exe"],
      ["Installer .msi", "VPS-Pilot-windows-x64.msi"],
    ],
  },
];
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function render(release) {
  const valid =
    release &&
    typeof release.tag_name === "string" &&
    /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(release.tag_name) &&
    Array.isArray(release.assets);
  const tag = valid ? release.tag_name : null;
  const releaseUrl = tag
    ? `${repository}/releases/tag/${encodeURIComponent(tag)}`
    : `${repository}/releases`;
  for (const node of document.querySelectorAll("[data-version]"))
    node.textContent = tag || "Release unavailable";
  document.querySelector("#release-status").textContent = tag
    ? `${tag} · Latest published release`
    : "Release information is unavailable. Find installers on GitHub Releases.";
  document.querySelector("#release-link").href = releaseUrl;
  const downloads = document.querySelector("#downloads");
  downloads.replaceChildren();
  for (const platform of platforms) {
    const card = element("article", "", "download-card");
    const top = element("div", "", "platform-top");
    top.append(
      element("span", platform.icon, "platform-icon"),
      element("span", tag ? "DESKTOP" : "RELEASES", "badge"),
    );
    card.append(
      top,
      element("h3", platform.name),
      element("p", platform.description),
    );
    const list = element("ul", "");
    for (const [label, name] of platform.formats) {
      // Resolve only assets on this exact release, never a moving /latest link.
      const asset =
        valid &&
        release.assets.find(
          (item) =>
            item.name === name &&
            item.browser_download_url ===
              `${repository}/releases/download/${encodeURIComponent(tag)}/${name}`,
        );
      const item = element("li", "");
      const link = element(
        "a",
        asset ? `${label} ↓` : `${label} ↗`,
        "download-button",
      );
      link.href = asset ? asset.browser_download_url : releaseUrl;
      if (!asset) link.title = "Check availability on GitHub Releases";
      item.append(link);
      list.append(item);
    }
    card.append(list);
    if (platform.note)
      card.append(element("p", platform.note, "platform-note"));
    downloads.append(card);
  }
}
// Pages embeds its build-time snapshot, so version and installers travel together.
// The same-origin fallback makes the source page previewable without a build.
async function loadRelease() {
  try {
    const embedded = JSON.parse(
      document.querySelector("#release-data").textContent,
    );
    if (embedded) return render(embedded);
    const response = await fetch("downloads.json", { cache: "no-cache" });
    if (!response.ok) throw new Error("Release metadata unavailable");
    render(await response.json());
  } catch {
    render(null);
  }
}
loadRelease();
