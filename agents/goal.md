# VPS Pilot — product goal

A separate Tauri 2 desktop application using React and TypeScript for managing multiple Linux VPS servers over SSH.

## Current milestone

Milestone 2 now includes real SSH PTYs and a native execution/approval foundation.
Milestone 3 includes read-only Linux inspections, measured Overview values,
automatic lightweight live monitoring, and catalog ownership/conflict preflight, including
Herdr. See `agents/plan.md` for implemented and outstanding work.

The user authorized the remaining scope on 2026-10-29 without intermediate
approval pauses. Their available VPS is important and is **not disposable**.
Do not use it for installation, firewall, proxy rollback, cleanup, or destructive
integration tests. Production builds enforce read-only app actions in Rust;
interactive terminal commands retain normal user-entered shell behavior.
Mutating integrations require a separate disposable VM/VPS and their safety gates
before they can be enabled. Keep real workspaces separate from sample fixtures.

## Agreed scope
- Multiple simultaneous SSH connections and interactive terminal tabs per server.
- Put VPS tabs in the top row. Its plus button offers a connection list (SSH config
  and app-saved profiles) or a separate form to add a connection. Never modify
  SSH config when managing app profiles.
- Each top-level tab owns one VPS workspace, including its sidebar, content,
  terminal sessions, and command panel. Keep their state isolated per server.
- Docker containers, Compose projects, images, volumes, and logs.
- Nginx, Caddy, and Traefik management.
- UFW firewall status and rule management.
- systemd via systemctl: status, start, stop, restart, enable/disable at boot, and logs.
- Live CPU, memory, disk, network, process, and service monitoring.
- Disk scans and safe cleanup with exact previews and confirmation.
- Bottom command panel: target server, exact running commands, live output, and result for app actions.

## Approval and secrets
- Every app-triggered sudo command requires its own explicit approval modal showing server, command, and purpose, even when sudo credentials are cached. Request the password when needed; rejection cancels the operation.
- User-entered interactive terminal commands use normal sudo prompts.
- Never display passwords or secrets in logs or command history. Use the operating system credential store if credential saving is introduced.
- Helper update and uninstall require confirmation.

## Safety to design into future features
- Preserve the active SSH port during UFW changes; design automatic rollback for risky firewall changes.
- Back up configurations, validate before reload, and offer rollback.
- Protect Docker volumes, mounted storage, active files, and application data during cleanup.
- Action history must omit secrets. Do not replay destructive commands automatically after reconnecting.
- Clearly identify the server for every action; initially scope changes to one server at a time.
- Support SSH config import, host fingerprint verification, keys/agents, and optional passwords.
  Parse pasted SSH commands into fields without execution; jump hosts remain later work.
- Define supported Linux distributions and versions before implementing management integrations.
- If a helper is needed, keep it lightweight, preferably Rust, with no public listener or permanently privileged daemon.

## Engineering
- Prefer established, maintained packages over rebuilding standard features. Evaluate reliability, security, licensing, resource usage, and compatibility.
- Stack: Tauri 2/Rust, React 19, TypeScript, Vite, Bun, Tailwind 4, shadcn/Base UI, TanStack Query and Router, Zustand, Lucide, and Biome.
- Match Disk Vacuum's exact dark green theme and shared component style. Use themed shared controls, never visible native selects or unstyled inputs.
- Select SSH and terminal libraries when their features are requested; do not build them during setup.
- Maintain an independent app identifier, repository, build output, and future release/signing configuration.

## Resource overhead rule

The user's important VPS must remain responsive. Treat low monitoring overhead as
a product requirement for every future feature. Never promise zero overhead or
claim a CPU/memory budget without measurement.
- Prefer small, read-only kernel counters (such as /proc/stat, /proc/meminfo,
/proc/net/dev, and /proc/diskstats); batch requests and reuse the SSH connection.
- Share one sampler per server, with no overlapping polls or duplicated samplers
for badges, charts, tooltips, and detail popovers. Tooltips use cached data.
- The user authorized a benchmarked 1-second live mode on 2026-10-30. Offer
1-, 2-, and 5-second choices. Default to 1 second only after the local sampler
meets the documented CPU/memory budget; lower frequency remains selectable.
Pause when the app is hidden, the server is disconnected, or monitoring is unused.
- Cache filesystem capacity for at least 60 seconds. No automatic recursive disk
scans, du/find traversals, package discovery, service enumeration, Docker queries,
GPU probes, or public-IP HTTP lookups in the lightweight sampler.
- Load expensive detail only on explicit request. Bound output, history, timeouts,
and concurrent work; back off on failures or slow responses.
- Validate overhead in disposable local fixtures before enabling new monitoring.
Never benchmark, stress-test, install a daemon on, or run destructive checks
against the user's important VPS.

## Local persistence and settings

The user authorized automatic live stats and a simple local SQL database on
2026-10-30. Every desktop installation must create its app-owned SQLite database
by default. Keep the schema small, versioned, and local to the desktop; no remote
database or VPS database process. Preserve existing profiles, trusted host
fingerprints, workspace layouts, and preferences during migration. Never silently
reset corrupt or newer-version data. Do not persist passwords, private-key contents,
terminal output, commands, or per-second metrics. Store future credentials only in
the OS credential store.

Stats default on for every open, connected VPS. Put monitoring preferences and
visible-stat selection in the Settings page. Keep sampling across Home, Settings
and other open VPS tabs. Pause only when the app window is inactive, stats are
disabled/hidden, or the server disconnects; closing the tab releases its sampler. Keep
fixed-width values, show both network directions, and retain browser-style app
zoom and its setting.

## Multi-VPS workflow increment — authorized 2026-10-30

Implement these three next: server organization (project, tags, environment,
favorite and ordering), a fleet home page, and a Ctrl/Cmd+K command palette.
Keep organization metadata in local SQLite and preserve existing profiles and
SSH configuration files. Fleet views must not connect, inspect, or sample every
server automatically. Show cached health with its observation time and never
present stale data as live. Navigation must preserve running terminal sessions
and monitoring for every open connected workspace. Palette actions navigate only:
opening a tool must not run a command or silently connect.

SFTP/editor, tunnels/jump hosts, streaming log improvements, reusable commands,
and additional mutating management actions remain subsequent work, outside this
increment.


## Open-tab lifetime — corrected by the user, 2026-10-31

An open VPS/project tab owns its ongoing SSH sessions, lightweight sampler,
charts, and workspace state regardless of which app page is visible. Visiting
Home, Settings, or another VPS must not restart streams, clear charts, reconnect,
or replay commands. Preserve one sampler per open connected VPS. Closing,
disconnecting, disabling stats, and whole-window inactivity remain lifecycle
boundaries; returning after a window pause retains bounded chart history.
Fleet home may display updated readings from these existing samplers, but must
never start connections or probes for unopened saved servers.
