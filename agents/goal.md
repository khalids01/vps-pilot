# VPS Pilot — product goal

A separate Tauri 2 desktop application using React and TypeScript for managing multiple Linux VPS servers over SSH.

## Current milestone
Fresh project foundation only. Implement management features only when requested by the user.

## Agreed scope
- Multiple simultaneous SSH connections and interactive terminal tabs per server.
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
- Support SSH config import and host fingerprint verification; plan key/agent authentication and jump hosts.
- Define supported Linux distributions and versions before implementing management integrations.
- If a helper is needed, keep it lightweight, preferably Rust, with no public listener or permanently privileged daemon.

## Engineering
- Prefer established, maintained packages over rebuilding standard features. Evaluate reliability, security, licensing, resource usage, and compatibility.
- Stack: Tauri 2/Rust, React 19, TypeScript, Vite, Bun, Tailwind 4, shadcn/Base UI, TanStack Query and Router, Zustand, Lucide, and Biome.
- Match Disk Vacuum's exact dark green theme and shared component style. Use themed shared controls, never visible native selects or unstyled inputs.
- Select SSH and terminal libraries when their features are requested; do not build them during setup.
- Maintain an independent app identifier, repository, build output, and future release/signing configuration.
