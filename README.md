# VPS Pilot

A Tauri 2 desktop app using React and TypeScript for verified SSH connections,
interactive terminal tabs/splits, and read-only Linux inspection. It supports
passwords, private keys, encrypted keys, Unix agents, and SSH config discovery.
Real server workspaces remain separate from clearly labeled sample workspaces.

**App-triggered changes are disabled in Rust in normal builds.** You can connect
an important VPS for terminals and read-only inspections without enabling software
installation, service changes, proxy edits, firewall changes, or cleanup. Commands
you manually enter in an interactive terminal behave normally. No saved tab or
layout reconnects, opens a shell, or replays a command automatically.

## Development

Prerequisites: Bun, Rust, and Tauri 2 platform dependencies (WebKitGTK 4.1 and build tools on Linux).

- `bun install --frozen-lockfile`
- `bun run tauri dev` — desktop development
- `bun run dev` — browser preview on localhost:1430
- `bun run check` — formatting and lint checks
- `bun run build` — frontend production build and typecheck
- `bun test` — layout, preferences, measurement parsing and conflict-rule tests
- `bun run test:e2e` — browser tests with a mocked desktop bridge
- `cargo check --manifest-path src-tauri/Cargo.toml --locked` — Rust validation
- `cargo test --manifest-path src-tauri/Cargo.toml --lib` — native tests using disposable local SSH fixtures
- `bun run tauri build` — desktop build

Run either desktop development or browser preview at a time. `bun run tauri dev`
starts Vite itself; stop an existing browser preview with Ctrl+C before launching
it. Both use port 1430.

Manrope is bundled locally for consistent typography without a network connection.

## Review real SSH connections

1. Run `bun tauri dev` and click **+**. **Connections** lists SSH config
   entries and app-saved profiles; **New connection** opens the form. Paste
   `ssh deploy@example.com -p 2222 -i ~/.ssh/deploy` and select **Fill details**,
   or enter the fields yourself. Opening a workspace does not connect automatically.
2. Select **Connect**. For a new host, independently compare its SHA256
   fingerprint with a trusted source before accepting it.
3. Leave **Password** blank to use your SSH agent, selected private key, or
   default `~/.ssh/id_ed25519` / `~/.ssh/id_rsa`. If your server needs a password,
   enter it. Encrypted keys have a separate **Key passphrase** field. The host
   key is checked again before authentication. Neither credential is saved.
4. Switch VPS tabs to check connection isolation. Disconnect explicitly, or close
   the real tab and confirm disconnect. Saved profiles remain available.

Connections alone do not open shells or run commands. Select Terminal and New
shell to request a remote PTY, or select Inspect in a tool to run its fixed
read-only inspection. Real tabs show measured data and never use sample metrics.
The browser preview cannot make real SSH connections because it has no native bridge.

Direct password, private-key, Unix SSH-agent, and server-supported `none`
authentication are available. With an explicit identity, the agent is restricted
to that key; otherwise up to three agent identities and two default key files
are tried. Certificates, jump hosts, MFA/keyboard-interactive,
and replacing a changed trusted host key remain later work. Changed host keys block
authentication. Host pins belong to VPS Pilot; system `known_hosts` is unchanged.

The picker reads `~/.ssh/config` and Include files using `ssh2-config`.
Wildcards supply defaults, not individual rows. Refresh reloads the read-only list.
Opening a config entry saves a metadata copy; later config edits do not change it.
HostName, User, Port, the first IdentityFile, and the password-authentication policy
are imported. Proxy/jump/interface requirements remain blocked. Match conditions,
include cycles, and parse errors stop config discovery without hiding app profiles.
Config commands are never executed; private keys are read only during an explicitly
requested, host-verified authentication attempt.

Command paste accepts a destination or config alias, `-p`, `-l`, `-i`, and SSH URLs.
Quoted absolute key paths and `~/` paths are supported. Relative key paths require
an absolute path so the app can locate them. Shell expansion, operators, remote
commands, tunnels, and other SSH options are rejected. Pasted text only fills the
form: it is never executed, recorded in command history, or saved as a command.
Adding, editing, and deleting app profiles never writes to SSH config.

Profiles and public host fingerprints are stored in `ssh-profiles.json` inside
Tauri's app configuration directory. Unix files use mode 0600. Corrupt or externally
changed storage is preserved; restart after another instance changes the file.
No saved profile reconnects automatically after an application restart.

## Real terminals and inspections

The compact server header keeps connection state and read-only mode visible;
**Connection details** reveals host, user, port and key metadata. Inspection results
use resource cards, usage bars, and searchable/sortable tables with pagination.
Permission failures and incomplete results are shown beside the affected section.

A persistent **Command console** bar sits at the bottom of every real VPS
workspace. Expand it for exact commands, streamed raw output, exit status,
duration and cancellation. Its recent history follows the selected server across
tools; background monitoring has a separate group. History and output remain in
memory only and are cleared when the workspace closes or the app restarts.

- Open Terminal on a connected real VPS, then New shell. Add tabs or split
  right/down; drag panels to group them. Rename, previous/next, maximize/restore,
  and confirmed closing are available. Up to 12 SSH streams per VPS are allowed.
- Tool and VPS navigation preserves sessions. Restored layout panes have no live
  SSH session until Start shell is selected. Disconnect ends channels; remote
  child processes may continue running, so inspect before retrying work.
- Overview, Software, Docker, Proxy, Services, Storage, Firewall, Network and
  Processes have fixed read-only inspections. Missing tools and permission errors
  remain visible as partial results. CPU usage needs two completed samples.
- Monitoring is opt-in for Overview, Network and Processes. Snapshots are scoped
  to their server, timestamped, and marked stale while disconnected.
- Reviewed reads provide numbered UFW rules, the last 200 service/container log
  lines and one-level directory scans that do not cross filesystem boundaries.
  Logs and scans can contain sensitive application output; nothing is persisted.
- Every sudo read requires a fresh approval showing server, exact command and
  purpose, including when sudo authorization is cached. Passwords travel only
  through SSH stdin after a sudo prompt. A missing/wrong password ends the attempt.
- Software preflight includes Herdr, Docker/Compose, proxies, Dokploy and runtimes.
  It reports conflicts and missing evidence, including stopped-container port
  reservations. It does not install software or authorize a mutation.

Command output is bounded; interactive output uses acknowledgements for
backpressure. Cancellation reports that a remote process may still be running.
Layouts and tool preferences store metadata only, without terminal input/output
or credentials. Native controls reject another server's stream IDs.

See [supported systems](agents/supported-systems.md), [the implementation
plan](agents/plan.md), and [disposable fixture instructions](tests/fixtures/README.md).
The fixture-tested systemd mutator is disabled in normal builds. Software changes,
Docker mutations, proxy changes, firewall changes and cleanup need their remaining
ownership/recovery checks and disposable VM/VPS validation before being enabled.
The important user VPS must never be used as a destructive test fixture.

## Review the terminal workspace

Run `bun tauri dev` and select Terminal on Production or Staging. Output is
read-only sample text; these sample tabs never start SSH connections or commands.

1. Open shells or logs, split right/down, and drag tabs into another group.
2. Resize a divider, select a session, rename it, and maximize/restore its group.
3. Switch tools and VPS tabs; each VPS keeps its own sessions and layout.
4. Restart the preview or close/reopen a VPS tab to restore its saved layout.
5. Close all sample sessions, open a new one, or reset the layout with confirmation.

Only layout metadata is saved locally. Terminal output is never saved. Reset
affects only the selected VPS. Development shows the disconnected state.

## Review workspace and helper flows

- Drag a VPS tab by its grip. For keyboard reordering, focus the grip, press
  Space, use arrow keys, then Space to drop or Escape to cancel.
- Switch tools and Software categories, hide command output, then restart. Open
  tabs, their order, the selected VPS, and each VPS's view preferences return.
- Open Server helper and choose a sample state to inspect install/update/removal
  reviews. Update and removal acknowledgments reset when each review closes.
- Development demonstrates saved helper information while disconnected.
- Manual helper removal shows a command-format placeholder. No verified command
  exists yet, so copying and execution are disabled.

TanStack Query and file-based TanStack Router are wired into the app. Zustand is available for future client state. Tailwind 4, shadcn/Base UI, Lucide, and Biome match Disk Vacuum's stack. Global styles copy its exact dark green theme. Shared Button, Input, Select, and Dialog components are ready to use.

See [agents/goal.md](agents/goal.md) for product scope and safeguards. Signing keys, release endpoints and mutating server-management integrations are not configured. The initial generated icon is a placeholder.

## Landing page and downloads

The independent static landing page lives in `website/`. Preview it with
`python3 -m http.server 4174 --directory website`.
Its download list reads a same-origin downloads.json manifest generated during
deployment from the published GitHub release. Visitor browsers do not call the
GitHub API. First-release and offline states retain a GitHub releases fallback.

`.github/workflows/pages.yml` deploys that directory on main-branch changes.
Set repository **Settings → Pages → Source** to **GitHub Actions**.
The live custom domain is https://vpspilot.skycanvasstudio.com/.
The custom domain is configured in GitHub Pages settings.

### Publishing a desktop release

1. Match versions in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml` (including the Cargo lockfile).
2. Run the checks below and commit the intended release changes.
3. Push to `main` (or run the release workflow manually on main).

The release workflow builds Linux x64 (DEB, RPM, AppImage), Windows x64
(NSIS and MSI), and macOS Apple Silicon / Intel (DMG). It checks version
consistency, frontend checks/tests, and native tests before packaging.
All platform jobs upload to a draft; only a complete set is published, with
`SHA256SUMS.txt`. A failed matrix leaves the draft unpublished.
Each main-branch push builds an immutable release tag such as
`v0.1.0-build.12`, bound to that commit. The successful release workflow then
deploys the site with its download manifest, retaining the previous download
release until the complete platform set succeeds. No manual tag is required.

No signing credentials or updater keys are required by this initial workflow.
Windows packages are unsigned; macOS packages are ad-hoc signed, not notarized.
This does not enable in-app automatic updates or any server-side mutation.

For a local Linux package: `bun tauri build --bundles deb,appimage`.
Installers are written beneath `src-tauri/target/release/bundle/`.
