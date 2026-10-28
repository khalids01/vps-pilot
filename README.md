# VPS Pilot

A Tauri 2 desktop app using React and TypeScript. The UI preview includes reorderable VPS tabs, saved per-server navigation, sample Overview data, a Software catalog with conflict and ownership reviews, a dockable terminal workspace, helper lifecycle reviews, and a command panel. Server connections and management are not implemented yet.

## Development

Prerequisites: Bun, Rust, and Tauri 2 platform dependencies (WebKitGTK 4.1 and build tools on Linux).

- `bun install --frozen-lockfile`
- `bun run tauri dev` — desktop development
- `bun run dev` — browser preview on localhost:1430
- `bun run check` — formatting and lint checks
- `bun run build` — frontend production build and typecheck
- `bun test` — terminal-layout and workspace-preference boundary tests
- `cargo check --manifest-path src-tauri/Cargo.toml --locked` — Rust validation
- `bun run tauri build` — desktop build

Run either desktop development or browser preview at a time. `bun run tauri dev`
starts Vite itself; stop an existing browser preview with Ctrl+C before launching
it. Both use port 1430.

Manrope is bundled locally for consistent typography without a network connection.

## Review the terminal workspace

Run `bun tauri dev` and select Terminal on Production or Staging. Output is
read-only sample text; input, SSH connections, and command execution are disabled.

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

See [agents/goal.md](agents/goal.md) for product scope and safeguards. Signing keys, release endpoints, SSH execution, and server features are not configured. The initial generated icon is a placeholder.
