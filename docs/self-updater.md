# VPS Pilot self-updater

VPS Pilot checks its own GitHub release channel once, four seconds after launch.
The top bar also has **Check for updates**. Available updates show release notes,
a persistent notice, **Skip this version**, and **Remind me later**. Skipped
versions persist on this device; a manual check can still show them. Later hides
the notice until the next launch. Only explicit **Update and restart** downloads,
verifies the signature, installs, and restarts the app. An update closes SSH
connections and terminal sessions; finish remote work first.

The app uses the official Tauri updater and process plugins. Disk Vacuum supplied
the reference behavior; its app identifier, release channel, state, and signing
credentials are never shared with VPS Pilot.

## Signing setup

The public key in `src-tauri/tauri.conf.json` belongs to VPS Pilot. Its matching
private key was generated locally at `.tauri/vps-pilot-updater.key` (ignored by
Git, file mode 0600). The key has no password and must be backed up securely.
Never commit it, print it in logs, or copy Disk Vacuum's credentials.

Before publishing, add the private key's contents to this repository's GitHub
Actions secret `TAURI_SIGNING_PRIVATE_KEY`. Leave
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` unset for this key. Use GitHub's secret UI or
pipe the key file directly into the secret CLI; do not paste its contents into a
shell command. The release workflow fails if signing credentials are missing.
Do not replace the public key after distributing updater-enabled builds without
a key migration plan: existing installations only trust their embedded key.

For local signed bundles, set `TAURI_SIGNING_PRIVATE_KEY` to the absolute path of
the private key before `bun tauri build`. Do not expose its contents in command
history. No private key is needed for frontend builds or Rust checks.

## Releases and versions

The existing release workflow keeps its immutable `vVERSION-build.N` tags. The
updater manifest uses the embedded semantic app version, not the CI tag. Increase
the version together in `package.json`, `src-tauri/tauri.conf.json`, and
`src-tauri/Cargo.toml`, and refresh `src-tauri/Cargo.lock` before an update release.
Update `release-notes.md` before publishing; these notes appear in the app and
on GitHub. Rebuilding the same version does not offer an update to users already
on it.
`scripts/check-release.ts` validates version alignment in CI.

Each platform build signs its updater bundles. Only after all builds succeed does
the publish job assemble `latest.json` from the actual signed assets, add it to
checksums, and publish the release. It refuses missing artifacts or signatures.
The endpoint is:
`https://github.com/khalids01/vps-pilot/releases/latest/download/latest.json`.

Linux includes AppImage, Debian, and RPM targets; Windows includes NSIS and MSI;
macOS includes Intel and Apple Silicon app archives. Package-manager installs
may request local administrator authorization during installation. macOS
notarization and OS distribution signing remain separate from updater signing.

## Validation

Browser tests mock native updater IPC to exercise discovery, skip/later behavior,
explicit install consent, progress, failures, and restart fallback without
replacing this application. A real end-to-end update must additionally be tested
from an installed, signed older release to a signed newer release on each OS.
Previously distributed builds without the updater need a manual installation
once. No release was published as part of adding this feature.
