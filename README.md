# VPS Pilot

A Tauri 2 desktop app using React and TypeScript. It supports saved SSH profiles, host fingerprint verification, and direct password authentication. Sample workspaces provide the planned monitoring, Software, terminal docking, and helper UI. Real interactive terminals and server management are not implemented yet.

## Development

Prerequisites: Bun, Rust, and Tauri 2 platform dependencies (WebKitGTK 4.1 and build tools on Linux).

- `bun install --frozen-lockfile`
- `bun run tauri dev` — desktop development
- `bun run dev` — browser preview on localhost:1430
- `bun run check` — formatting and lint checks
- `bun run build` — frontend production build and typecheck
- `bun test` — terminal-layout and workspace-preference boundary tests
- `cargo check --manifest-path src-tauri/Cargo.toml --locked` — Rust validation
- `cargo test --manifest-path src-tauri/Cargo.toml --lib` — native tests using disposable local SSH fixtures
- `bun run tauri build` — desktop build

Run either desktop development or browser preview at a time. `bun run tauri dev`
starts Vite itself; stop an existing browser preview with Ctrl+C before launching
it. Both use port 1430.

Manrope is bundled locally for consistent typography without a network connection.

## Review real SSH connections

1. Run `bun tauri dev` and click **+** in the top VPS tab row. Choose
   **Choose a connection** for SSH config entries and app-saved profiles, or
   **Add a new connection** for a separate hostname/IP, port, username, and name
   form. Opening a profile creates a real VPS tab without connecting automatically.
2. Select **Verify and connect**. For a new host, independently compare the
   displayed SHA256 fingerprint with a trusted source before accepting it.
3. Enter the SSH password. The host key is checked again before authentication.
   Passwords are used transiently and are never saved in profiles or preferences.
4. Switch VPS tabs to check connection isolation. Disconnect explicitly, or close
   the real tab and confirm disconnect. Saved profiles remain available.

This increment opens authenticated SSH connections only; it runs no remote
commands and does not open a shell. Real tabs show no sample metrics or inventory.
The browser preview cannot create real connections because it has no native bridge.

Only direct password authentication is currently supported. Keys, agents, jump
hosts, host certificates, interactive PTYs, and replacing a
changed trusted key are later work. A changed host key blocks authentication.
Host pins belong to VPS Pilot's trust store; system `known_hosts` is not modified.

The connection picker reads `~/.ssh/config`, including named hosts in `Include`
files, using `ssh2-config`. Wildcards supply defaults, not individual rows. The
list is read-only; **Refresh list** reloads it. Opening a config entry saves a
metadata copy in VPS Pilot; subsequent config edits do not alter that copy.
Only HostName, User, and Port are imported. Keys and other settings are not
applied; entries requiring proxies, jump hosts, a specific local interface, or
disabling password authentication are blocked. Unsupported Match conditions,
include cycles, and parse errors stop config discovery without hiding app-saved
profiles. No SSH config commands are executed and no identity file is read.
Adding, editing, or deleting app profiles never writes to your SSH config.

Profiles and public host fingerprints are stored in `ssh-profiles.json` inside
Tauri's app configuration directory. Unix files use mode 0600. Corrupt or externally
changed storage is preserved; restart after another instance changes the file.
No saved profile reconnects automatically after an application restart.

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

See [agents/goal.md](agents/goal.md) for product scope and safeguards. Signing keys, release endpoints, remote command execution, and server management are not configured. The initial generated icon is a placeholder.
