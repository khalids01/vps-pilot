# VPS Pilot

A fresh Tauri 2 desktop app using React and TypeScript. The foundation includes a themed welcome screen and shared UI components. Server connections and management are not implemented yet.

## Development

Prerequisites: Bun, Rust, and Tauri 2 platform dependencies (WebKitGTK 4.1 and build tools on Linux).

- `bun install --frozen-lockfile`
- `bun run tauri dev` — desktop development
- `bun run dev` — browser preview on localhost:1430
- `bun run check` — formatting and lint checks
- `bun run build` — frontend production build and typecheck
- `cargo check --manifest-path src-tauri/Cargo.toml --locked` — Rust validation
- `bun run tauri build` — desktop build

TanStack Query and file-based TanStack Router are wired into the app. Zustand is available for future client state. Tailwind 4, shadcn/Base UI, Lucide, and Biome match Disk Vacuum's stack. Global styles copy its exact dark green theme. Shared Button, Input, Select, and Dialog components are ready to use.

See [agents/goal.md](agents/goal.md) for product scope and safeguards. Signing keys, release endpoints, SSH execution, and server features are not configured. The initial generated icon is a placeholder.
