# VPS Pilot

A Tauri 2 desktop app using React and TypeScript for verified SSH connections,
interactive terminal tabs/splits, SFTP files and reviewed text editing, and read-only Linux inspection. It supports
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

The compact server header keeps connection state and the current action policy visible;
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
- Live monitoring starts for each open, connected VPS by default, with 1-, 2-, or 5-second
  intervals. Inventory snapshots refresh only on request. Snapshots are scoped
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

See [agents/goal.md](agents/goal.md) for product scope and safeguards. Release/updater setup is documented above; mutating server-management integrations remain gated. The app uses the user-selected VPS Pilot icon.

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

Release builds require VPS Pilot updater signing credentials; see the setup below.
Windows packages are unsigned; macOS packages are ad-hoc signed, not notarized.
Updater signing is separate from OS distribution signing.

For a local Linux package: `bun tauri build --bundles deb,appimage`.
Installers are written beneath `src-tauri/target/release/bundle/`.

## Lightweight live metrics

Connect a VPS and live metrics start automatically for its open workspace. Hover a
badge for its label; click CPU, RAM, storage, disk I/O, or network to open the
floating resource panel. Overview shows the same measurements as charts.
The Settings page offers 1s, 2s, and 5s intervals; there is no additional sampler for
charts, tooltips, or detail views.

The target needs Linux /proc, /sys/block, and Python 3 available to the SSH user.
VPS Pilot starts one Python process as the authenticated SSH user over the existing connection,
with isolated startup, site-package hooks disabled, and no bytecode-cache writes.
Nothing is uploaded or installed, no listener is opened, and no sudo is used.
The process stops on SSH input EOF or after 30 seconds without requests.
Missing prerequisites report an error; the app never installs them automatically.

CPU, memory, base-device disk counters, and one network interface are sampled.
Root filesystem capacity is cached for 60 seconds. The sampler does not enumerate
processes, services, packages, containers, or directories. Network prefers the
default IPv4 route's interface, with a non-loopback fallback; it is not a sum of
virtual interfaces. Disk I/O excludes partitions and stacked/virtual devices to
reduce double counting, and is not limited to the root filesystem.

Each open, connected VPS keeps its sampler and chart history while you visit
Home, Settings, or other VPS tabs. Whole-window inactivity pauses sampling;
returning retains chart history. The saved monitoring preference applies after
restart, but saved servers never automatically reconnect.
Failed streams retry with 5–60 second backoff. Slow samples reduce the refresh
rate, requests never overlap, and desktop acknowledgements bound delivery.
Counter history is limited to 180 samples in memory; reconnects reset rate
baselines. The command console retains only the latest counters for the sampler.

See [monitoring validation](agents/monitoring-validation.md) for local benchmark
results, the resource budget, and the limits of that evidence.

## In-app updates

VPS Pilot checks for signed updates after launch. Use **Check for updates** in the
Settings to check manually, review release notes, or update and restart.
Updating closes SSH connections and terminal sessions; finish your work first.
See [self-updater setup](docs/self-updater.md) for signing credentials, release
versions, supported installers, and validation requirements.

### Local settings and data

The desktop app always creates `vps-pilot.sqlite3` in its OS application-config
directory. It uses bundled SQLite with one small versioned documents table.
No database server, account, or VPS installation is needed.

The Settings gear opens a dedicated page for automatic live stats, 1/2/5-second
refresh intervals, visible CPU/RAM/storage/disk/network stats, and app zoom.
Zoom also supports Ctrl/Cmd + plus/minus, Ctrl/Cmd + 0, and Ctrl/Cmd + scroll.
These choices survive a restart. Hiding all stats stops sampling. The header
uses larger fixed-width values and two columns for download/upload speeds.

Saved SSH profiles and trusted host fingerprints migrate from the existing JSON
file. Workspace tabs, tools, sanitized terminal layouts, and the skipped update
version migrate from existing browser preferences. The old sources are retained;
SQL data takes precedence afterward. Restored layouts never reconnect or replay
commands. Passwords, private-key contents, terminal output, commands, and live
metric samples are not saved to SQLite. Read or write errors are reported rather
than silently resetting saved data. See [local database notes](agents/local-database.md).

### Managing a fleet

Use the Home button to see all saved servers grouped by project. Organize each
server with a project, comma-separated tags, Production/Staging/Development
environment, and favorite. Arrow buttons reorder servers within each project's
favorite group. Search matches names, addresses, projects, tags and environments;
the connection picker shares this organization and puts favorites first.
Organization is stored locally without changing connection profiles or closing
running terminals.

Fleet health is explicitly cached and timestamped. It comes from monitoring in open connected
workspaces, which continues while you browse Home; opening or refreshing fleet
home never connects or scans additional servers. Fresh desktop installations start here, while existing workspaces keep
their restored server selection.

Press **Ctrl/Cmd + K** or the search button to open the command palette. Type a
server, project/tag, or tool name, use arrow keys, and press Enter to navigate.
Escape closes the palette. Choosing a server or tool does not connect it, open a
shell, or execute an inspection. Existing terminal sessions stay mounted while
you visit fleet home, Settings, or another server.


### Remote Files

Open **Files** in a connected VPS workspace. It loads root once, including hidden
files. Use breadcrumbs, back/forward/up, or enter an absolute path and select
**Go**. Listings stay open across Home/tools/VPS tabs and are capped at 1,000
entries. Choose list/grid view, filter, or sort by name, size or modified time.
Folder totals are calculated only when requested; cached totals show their
observation time and whether the scan was incomplete.

Click to open; checkboxes and Ctrl/Cmd-click select, Shift selects a range, and dragging empty
space draws a selection rectangle. Copy/Cut/Paste also support Ctrl/Cmd+C/X/V.
Move, rename, folder creation, paste and Delete require a server/path review.
Existing destinations are never overwritten by these operations. **Delete moves
to private server trash**, with a restore action for the latest result during
the same SSH session. Trash retains disk space and is never automatically purged;
copies remain at the reported paths after disconnecting.

**Cancel operation** stops remaining work after the current bounded SFTP request;
completed changes remain. Failed copies may retain a private stage, reported in
the result. There is no automatic retry. System directories and their ancestors,
login/credential paths, known database/container storage, and internal backup/
staging/trash paths are protected by Rust. Moving/deleting mounted storage or a
folder containing a mount point is blocked, using read-only Linux mount data.

Single-click or press Enter to open a regular UTF-8 text file (up to 1 MiB) in the themed CodeMirror editor.
JSON/YAML highlighting, line numbers, search and undo are available. Drafts stay
in memory across tools, Home and VPS tabs. Changing/closing a dirty file asks
before discarding. Save before closing the app; drafts are never stored in SQLite
or command history.

**Review changes** (or Ctrl/Cmd+S in the editor) shows the exact target and a diff before **Back up and save**.
Native reviews expire after two minutes and are bound to the server connection,
file revision and proposed bytes. Files are checked again before replacement.
Existing owner/mode are preserved; ACLs, extended attributes and special mode bits
are not supported for replacement. Editing does not validate app configuration or
reload a service. System directories, SSH credentials and internal backups are
protected from app writes.

Backups are named in the review and success message, in a private adjacent
`.vps-pilot-backup-<name>-<id>/original` file. The folder is mode 700 and
Git-ignored; its original copy is mode 600. Staging also uses private Git-ignored
folders. Failed/interrupted operations can retain a backup or staging folder;
verify the destination before retrying. No backup is silently pruned.

**Upload** selects a local file through the native file picker and requires a
destination review; existing files get the same backup/stale checks. **Download**
uses a native save dialog. **Download ZIP** supports selected files/folders, up
to 100 roots, 10,000 entries and 256 MiB per batch; individual files are limited
to 32 MiB. ZIP archives skip symlinks and reject special devices. Recursive copy
preserves symlinks without following them, ordinary permission bits, and excludes
private backup/staging/trash subtrees. Copies use the SSH user's ownership and
do not preserve ACLs/xattrs. Folder scans have a 20-second budget. Directory paths
are canonicalized. Existing-file replacement requires OpenSSH's atomic rename
extension. SFTP runs as your authenticated SSH user without sudo or a helper.
See [Files implementation notes](agents/files.md).


Files uses compact breadcrumbs (Edit folder path reveals the address input),
search and list/grid controls. Right-click an item for Open, Download, Copy,
Cut, Rename, Move, View details or Move to trash; right-click empty space for
folder actions. The overflow menu provides the same actions without right-click.
Right-clicking a selected item preserves the whole selection. View details
shows metadata in a side panel; folder sizes are calculated there on request.
Per-item download/calculation controls and permission columns are hidden.
Terminal/editor context behavior remains unchanged.

### Docker workspace

Open Docker and select **Load containers**. Inventory includes stopped containers,
state/health text, published ports and Compose project/service groups. There is
no automatic Docker polling. Open a container for configuration, mounts and
environment names; values are masked by the remote Docker format before SSH
transmits them. Command arguments and health-check output are not requested.
**Refresh resource snapshot** reads one CPU/memory/I/O/PID snapshot explicitly.

**Review live logs** previews the exact server/container command before following
the last 200 lines. The remote follow process has a 55-second limit; the existing
client stream also enforces time, output and acknowledgment limits. The display
retains at most 64 KiB. Stop closes that stream without disconnecting SSH. Log
contents stay in the view, outside SQLite and command activity output.

**Open container terminal** checks the full ID and current running state and
opens an interactive /bin/sh using Docker's configured container user. There is
no sudo or fallback to a host shell. Images without /bin/sh report the CLI error.
Container terminals remain mounted across Home/tools/VPS navigation, with at most
four container workspaces per VPS. Their layouts are not persisted or restored
automatically. Normal terminal close confirmation and stream limits apply.

Commands use the SSH user's effective Docker CLI context and socket permissions.
No Docker daemon is installed or Docker group membership changed. Reviewed start/stop/restart and Docker management now use a separate native,
engine-bound protocol validated in a disposable VM. The legacy generic action
endpoint remains disabled. No volume deletion, force removal or system prune is
provided. Images and volume inspections remain under Docker diagnostics.

Docker's supported formatting functions are documented at
[Docker CLI formatting](https://docs.docker.com/engine/cli/formatting/).


Docker management adds **Deploy**, **Images**, **Volumes**, **Networks**,
**Cleanup** and **Activity** views. Start/stop/restart, image pulls and creation of
bridge networks/volumes show fresh server/engine evidence before execution.
Resource inventories and cleanup scans run only on request.

Deploy through the form or Compose editor, or explicitly load an existing server
Compose file into the in-memory editor. Create the application folder in Files
first. Validation checks normalized configuration, resolved local image IDs,
port reservations/listeners, protected paths and host privileges. Images must
already be pulled; builds are not enabled. Existing configuration gets a private
backup, and Activity can load that backup into the editor for a new review.
Deployment waits for readiness for up to 20 seconds. This is configuration
recovery, not automatic image/database rollback; external concurrent writers are
not locked out.

Cleanup considers only unreferenced untagged images, unused non-Compose bridge
networks and eligible standalone stopped containers older than seven days.
Mounted, infrastructure and orchestrator-managed containers remain protected.
Removing a container also removes its writable layer/logs: back up needed files
before confirming its exact name. All volumes and rollback image holds are
protected. Image sizes include shared layers and are not guaranteed freed space.
Build-cache pruning is unavailable without exact dependency evidence.

Plans bind the connection, profile revision, Docker engine, resource evidence and
configuration hashes; they expire after two minutes and are single-use.
Execution rechecks them. Mutations require a local Unix-socket engine on the SSH
host, Python 3 and Docker/Compose access. Interruption can leave changes applied;
inspect uncertain results before retrying. Operations are serialized per VPS;
Activity retains bounded metadata in memory, without config/secrets/output in
SQLite. Log search and pause affect only the cached display.
