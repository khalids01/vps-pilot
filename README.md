# VPS Pilot

A Tauri 2 desktop app using React and TypeScript. The current UI preview includes per-VPS tabs, navigation, sample Overview data, and a command panel. Server connections and management are not implemented yet.

## Development

Prerequisites: Bun, Rust, and Tauri 2 platform dependencies (WebKitGTK 4.1 and build tools on Linux).

- `bun install --frozen-lockfile`
- `bun run tauri dev` — desktop development
- `bun run dev` — browser preview on localhost:1430
- `bun run check` — formatting and lint checks
- `bun run build` — frontend production build and typecheck
- `cargo check --manifest-path src-tauri/Cargo.toml --locked` — Rust validation
- `bun run tauri build` — desktop build

Run either desktop development or browser preview at a time. `bun run tauri dev`
starts Vite itself; stop an existing browser preview with Ctrl+C before launching
it. Both use port 1430.

Manrope is bundled locally for consistent typography without a network connection.

TanStack Query and file-based TanStack Router are wired into the app. Zustand is available for future client state. Tailwind 4, shadcn/Base UI, Lucide, and Biome match Disk Vacuum's stack. Global styles copy its exact dark green theme. Shared Button, Input, Select, and Dialog components are ready to use.

See [agents/goal.md](agents/goal.md) for product scope and safeguards. Signing keys, release endpoints, SSH execution, and server features are not configured. The initial generated icon is a placeholder.
