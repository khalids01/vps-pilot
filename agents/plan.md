# VPS Pilot implementation plan

Status: Milestone 1, shell and Software UI committed; terminal UI reviewed. The
expanded helper, VPS-tab reordering, and workspace-persistence batch awaits review.

This plan records the scope agreed with the user on 2026-10-29. Read
`agents/goal.md` first. This document expands that goal; it does not authorize
unrelated features or changes to Disk Vacuum. Build incrementally in the order
below, keeping each milestone reviewable.

## Approved interface

Use the existing exact dark green theme and shared themed controls. Preserve VPS
Pilot's independent identifier, repository, build output, and release setup.

- Top browser-style tabs: one VPS connection per tab, with name, connection state,
  close action, reordering, overflow handling, and an add-server action.
- Left navigation within the selected server: Overview, Terminal, Software,
  Docker, Proxy, Services, Storage, Firewall, and Server helper.
- Main workspace: the selected tool, with local tabs only when needed. Terminal
  supports multiple sessions, grouped tabs, and horizontal/vertical splits.
- Bottom command panel: selected server, app action, exact safe-to-display
  commands, live output, progress, cancellation where supported, and result.
- Persistent server context: make the target unmistakable in the workspace,
  command panel, approval dialogs, and destructive actions.
- Overview starts with CPU, memory, disk, and detected software. Add network,
  process, and service details without turning the initial screen into a dense
  dashboard.
- Hide complexity behind feature views and explicit review steps. Provide clear
  empty, loading, disconnected, unsupported, stale, denied, and failure states.
- Switching server tabs preserves each server's terminal workspace. Restoring
  saved layouts never automatically reconnects or reruns commands.

The user approved an interactive concept showing Overview, split terminals,
Software, blocked Nginx installation, and helper setup. It used sample data and
was not functional application code. Detailed management screens still need
implementation within this structure.

## Architecture and library choices

- Keep Tauri 2/Rust, React 19, TypeScript, Vite, Bun, Tailwind 4, shared
  shadcn/Base UI controls, TanStack Query/Router, Zustand, Lucide, and Biome.
- Proposed server tabs: Base UI Tabs with dnd-kit for reordering. Tab closing,
  overflow, connection indicators, and focus behavior remain application work.
- Proposed terminal workspace: Dockview's open-source core. Evaluate FlexLayout
  as the alternative if compatibility, accessibility, or licensing requires it;
  install one docking library, not both.
- Proposed terminal renderer: `@xterm/xterm` with maintained fit/search/link
  addons as needed. Verify rendering and resizing in the supported Tauri
  webviews before adding optional acceleration.
- Revalidate maintenance, licenses, security, React compatibility, resource cost,
  and required features when selecting packages. Do not depend on paid docking
  features for the approved layout.
- Select a maintained Rust SSH implementation during the connection milestone.
  Require host verification, independent sessions, remote PTYs, resize, streamed
  output, cancellation, and a path to keys, agents, SSH config, and jump hosts.
- Rust owns connections, credentials, command execution, approvals, and helper
  lifecycle. The frontend requests typed actions, not unrestricted shell strings.
- Scope query keys, subscriptions, layouts, sessions, and action history by stable
  server IDs. Runtime-version tools also carry the target Linux user.
- Keep connection state, discovery, action execution, integrations, and helper
  transport separate. An optional helper must not become a prerequisite for SSH.

## Server protection rules

Treat an existing deployment as something to preserve. Installation is never
permission to interrupt another workload.

1. Discover the OS/version, architecture, privileges, existing packages and
   installation sources, services, containers, listeners, published container
   ports, relevant configuration, and deployment-platform ownership.
2. Check declared port reservations and inactive configurations as well as live
   listeners. A currently stopped service can still conflict later.
3. Build an action-specific preflight report. Distinguish verified facts,
   unsupported configurations, unknown ownership, and stale discovery.
4. Block mutations with a known unresolved conflict or a material unresolved
   safety question. Explain the owner and affected resources. Read-only
   inspection remains available where supported.
5. Show exact changes and commands, dependencies, affected services, potential
   downtime, data handling, and available recovery before approval.
6. Recheck the relevant state immediately before execution. Serialize conflicting
   mutations per server. If the plan changes, invalidate approvals and request a
   new review. Stop if an external change invalidates a precondition.
7. Never automatically stop, replace, uninstall, or reconfigure an existing
   application to free a port or satisfy a dependency.
8. Verify the result and affected existing services. Report partial completion
   honestly; offer recovery only when it has been designed and validated.

Example: when Dokploy-managed Traefik owns ports 80/443, block a default Nginx
installation/start. Show the owning container/platform and affected ports.
Coexistence requires a separately supported, explicitly reviewed configuration;
do not promise that merely changing a port makes it safe.

## Approval, execution, and secrets

- Every app-triggered sudo command gets its own explicit modal showing server,
  exact command, and purpose, even with cached sudo credentials. A batch review
  does not replace these approvals. Rejection cancels the pending operation.
- Bind approval to the server identity, exact action/command, and current plan.
  Switching server tabs cannot retarget an operation or its approval.
- User-entered interactive terminal commands retain normal shell/sudo behavior.
- Never place passwords, tokens, private keys, or other secrets in command
  arguments, shell history, persisted terminal buffers, app history, or logs.
  Use secure input channels and omit secret values from command previews.
- App output may itself contain secrets: define suppression/redaction before
  enabling persistence. Do not persist raw interactive terminal content by
  default. The app cannot fully control a remote user's own shell configuration.
- Use the OS credential store if credential saving is introduced. Keep secrets
  out of frontend persistence and layout serialization.
- Support bounded output and backpressure. Cancellation and disconnects must
  report whether a remote operation may still be running.
- Never automatically retry destructive operations after reconnect. Reinspect
  state and reconcile the result before offering another action.

## Milestone 1: application shell and UI

- Implement the approved navigation with explicit sample fixtures until the
  backend exists. Never present sample status as a real connected server.
- Build server tabs, shared status indicators, main workspace, command panel,
  reusable review dialogs, and empty/error states.
- Add terminal docking with sample panels, theme integration, keyboard access,
  sensible minimum sizes, and layout persistence without credentials or output.
- Add Software and helper lifecycle screens, including the conflict example.
- Closing a live tab/session must explain which sessions will end. Confirm when
  activity could be interrupted, then dispose subscriptions and resources.

Completion: the user can navigate the complete shell, switch server contexts,
rearrange terminal panels, and inspect the proposed review flows. No remote
management actions run in this milestone.

## Milestone 2: SSH and real terminals

- Implement server profiles, connection lifecycle, host fingerprint verification,
  and clear host-key-change handling. Never silently accept an unknown key.
- Implement authentication, secure credential handling, SSH config import, and
  document support for keys, agents, and jump hosts. Expose only working options.
- Connect xterm to separate remote PTY sessions through typed Tauri events/IPC.
  Propagate terminal resizing and safely handle stream disposal and disconnects.
- Keep sessions alive across tool/server navigation. Connection recovery must
  distinguish preserved remote sessions from newly created sessions.
- Implement the action execution and approval foundation before privileged work.

Completion: simultaneous connections, independent terminal sessions, reliable
resizing, verified host identity, and no cross-server commands or output.

## Milestone 3: supported systems and read-only discovery

- Publish the exact supported distro/version/architecture matrix before enabling
  management integrations. Start with a small tested set; do not claim universal
  Linux support. Other systems may still use SSH terminals.
- Implement structured discovery and ownership tracking. Detect manually
  installed software and distinguish it from software installed by VPS Pilot.
- Populate Overview, Software inventory, service status, and proxy ownership.
- Add safe read-only monitoring of CPU, memory, disk, network, processes, and
  services, with timestamps and unavailable states instead of fabricated values.
- Test discovery against real port conflicts, externally managed deployments,
  insufficient privileges, missing utilities, and unsupported distributions.

Completion: supported servers show verified inventory and monitoring, and the
preflight engine explains conflicts and unknowns without modifying the server.

## Milestone 4: optional helper lifecycle

First measure what SSH alone can provide. If a helper is needed, implement a
small Rust executable accessed over the existing authenticated SSH transport,
with no public listener or permanently privileged daemon. Define supported
versions, architectures, protocol compatibility, and resource limits.

- Installation: inspect compatibility and existing installations; verify the
  artifact's authenticity/integrity before execution; preview version, paths,
  permissions, any service integration, exact commands, and removal behavior.
- Launch unprivileged and constrain its operations. Privileged work must still
  pass the desktop's per-command approval rule, with enforcement in Rust.
- Upgrade: require confirmation, validate compatibility, and retain a supported
  recovery path. Do not silently replace an externally installed executable.
- Desktop uninstall: preview the exact helper-owned files/processes/service
  entries involved, then require confirmation and applicable sudo approvals.
- Manual uninstall: provide an exact server-specific command after installation,
  with correct quoting and no secrets. Save it locally and make it available
  without an active connection. The uninstall capability must be self-contained
  on the VPS and work without the desktop application.
- Uninstall only verified helper-owned resources. Refuse ambiguous ownership;
  never recursively delete guessed directories. Preserve applications, Docker
  volumes, mounted storage, proxy configuration, certificates, and user data.
- Make uninstall safe to repeat and describe interrupted/removal-failure states.
  If the command needs the helper binary, remove that binary last.
- After removal, show which features still work over SSH and which need the
  helper. Do not silently reinstall it.

Completion: tested install, update, desktop removal, manual SSH removal without
the desktop, interrupted operations, compatibility mismatch, and repeated removal.
Finalize actual paths and commands during implementation; the concept does not
establish a real executable path or CLI contract.

## Milestone 5: software catalog and controlled changes

Implement integrations individually after preflight and approvals work. A catalog
entry must define detection, supported systems, installation scope/source,
dependencies, version choices, owned resources, conflict checks, verification,
uninstall semantics, and recovery limits. Hide unavailable actions or explain
why they are disabled; generic install/uninstall scripts are insufficient.

Initial scope:

- Docker Engine and Compose.
- Nginx, Caddy, and Traefik; distinguish standalone installations from instances
  managed by Dokploy or another platform.
- Dokploy deployment-platform detection and management to a clearly documented
  supported extent. Verify the user's intended name before extending to another
  product. Do not promise full platform management just from detection.
- Git, Node.js, nvm, Python, and Go. Show versions, executable paths, Linux user,
  and system/package-manager ownership. Protect OS-managed Python and system
  dependencies. Never change a user's default runtime silently.
- The utility described as "harder" remains unidentified. Confirm its exact name
  before implementing its catalog entry. Other tools are added only on request.

Uninstall defaults to preserving data/configuration. Any purge must be separate,
explicit, and supported by exact ownership and dependency checks. Block removal
that would break active dependents or where ownership is unknown. Repeated
requests must not create duplicate repositories, users, services, or installs.

Completion: each enabled catalog action passes its supported-system and conflict
scenarios, shows a concrete review, and verifies the resulting state. Installing
Docker must not imply permission to change or remove dependent deployments.

## Milestone 6: management tools

Deliver each tool as a separate reviewable increment:

- Docker: containers, Compose projects, images, volumes, and logs. Show exact
  targets and dependencies before removal; protect persistent volumes and active
  deployments. Never add broad automatic prune behavior.
- Proxy: inspect ownership, back up configuration, validate before reload, and
  offer supported rollback. Use the owning platform's supported interface when
  it controls configuration; do not overwrite generated files.
- systemd: inspect, start, stop, restart, boot enable/disable, and logs. Preserve
  connection-critical services and show expected impact.
- UFW: status/rules with active SSH-port protection. Require a tested automatic
  rollback mechanism for risky changes and verify connectivity before committing.
- Storage: read-only scans first. Cleanup uses exact previews and confirmation,
  protects mounted storage, active files, volumes, and application data, and
  revalidates targets at execution time.

Completion: each enabled tool has verified read behavior, target-specific
reviews, required approvals, result verification, and realistic failure handling.

## Validation and release gates

- After changes run `bun run check` and `bun run build`. For Rust changes run
  relevant formatting, compilation, lint, and tests; normally
  `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`,
  `cargo check --manifest-path src-tauri/Cargo.toml`, and targeted tests, with
  Clippy as appropriate. Report environment failures instead of claiming success.
- Test meaningful behavior: server isolation, approval binding, host-key changes,
  conflict detection, stale plans, ownership, secret handling, uninstall safety,
  and partial failures. Avoid tests that only mirror trivial UI implementation.
- Use disposable VPS/VM fixtures for privileged and destructive integration
  checks. Never test installations, proxy replacement, firewall changes, or
  cleanup against the user's production server as routine validation.
- Check terminal behavior, tab overflow, focus, keyboard navigation, resize,
  reconnect, resource cleanup, and theme consistency in supported desktop builds.
- Test a deployed Dokploy/Traefik fixture: a default Nginx install is blocked and
  existing services remain untouched. Test external installations and unknown
  ownership as well as resources installed by VPS Pilot.
- Do not expose an action as supported until its safety checks and failure
  behavior have been validated. Record remaining limits plainly.

## Next implementation increment

The first review checkpoint was approved and committed as `12e2af0`: themed shell,
accessible server tabs, closing/reopening sample profiles, per-server navigation
state, sample Overview, disconnected state, collapsible per-server command
activity, and locally bundled Manrope typography.

The second checkpoint was approved and committed as `0b8da7e`: sample Software catalog, category filtering,
versions/ownership/scope details, server-specific Nginx port-conflict review,
protected system Python, and pending runtime installation review. Production's
conflict identifies Dokploy-managed Traefik; Staging identifies Caddy. Filters
remain independent across open VPS tabs. Installation, management, and removal
remain disabled; this is not a discovery or preflight implementation.

Browser checks passed for these sample flows, empty/disconnected states, dialog
focus restoration, and narrow layouts. The UI checks do not establish real-server
installation safety.

The third checkpoint was reviewed and adds Dockview's MIT core and xterm.js with
its fit addon (currently in the working tree):

- Read-only sample shell/log output, up to 12 sessions per VPS.
- New tabs, horizontal/vertical splits, pointer-based docking/grouping and
  resizing, rename, maximize/restore, keyboard-accessible session controls,
  closing all tabs, and reset with confirmation.
- Terminal instances stay mounted when navigating tools or switching VPS tabs.
- Per-VPS layout persistence stores only allowlisted metadata (panel IDs/titles,
  sample type, server ID, layout geometry); no output, commands, or credentials.
  Restore never opens SSH connections or executes commands. Invalid layouts
  fall back to defaults. Storage failures remain visible without blocking use.
- Server-to-server panel drops are rejected. Popouts/floating windows and
  enterprise docking features are not enabled.
- Lazy loading keeps the terminal dependencies out of the initial Overview
  screen. The terminal bundle still produces Vite's large-chunk advisory.
- Focused layout-boundary tests cover metadata filtering, cross-server panels,
  invalid components/geometry, missing/duplicate panels, and empty layouts.
  Browser coverage checks workspace interactions and sample state isolation.

The user requested larger UI batches after reviewing the terminal workspace.
The fourth checkpoint includes:

- VPS tab reordering with the maintained `@dnd-kit/react` sortable controls,
  dedicated drag handles, and keyboard reordering. Reordering preserves server
  identity and the active workspace. Terminal docking remains a separate scope.
- Allowlisted local workspace preferences: open-tab order, selected VPS, each
  server's selected tool, command-panel visibility, Software category, and helper
  sample scenario. Intentionally closed tabs remain closed after restart.
- Preference validation drops foreign profiles, duplicates, and unknown fields;
  corrupt storage falls back to defaults, while unavailable storage allows
  continued in-memory use. Preferences never contain credentials or commands.
- Helper lifecycle screens with not-installed, installed, update-available, and
  disconnected examples. Overview reflects the selected helper sample state.
- Shared action-review and themed checkbox controls. Helper install/update/remove
  reviews show their target, expected changes, protected resources, pending exact
  command plan, and confirmation acknowledgments for update/removal. These are
  reviews, not execution or per-command sudo approval implementations.
- The manual-removal section explains offline availability after a verified
  installation. Its placeholder command cannot be copied as a working command.
  Actual signed releases, verified paths, executable commands, and ownership
  manifests remain part of the helper backend milestone.
- Browser coverage of helper reviews, pointer/keyboard reordering, restoring
  per-server state, empty/disconnected views, narrow layouts, and storage errors.
  Focused preference tests enforce metadata and server-identity boundaries.

No Rust changes, backend, SSH execution, or remote operations were added. Core
Milestone 1 shell, terminal, Software, and helper review flows are available for
UI review. Detailed Docker/Proxy/Services/Storage/Firewall screens still show
explicit placeholders and remain for their integration milestones.

Pause for user review before the next increment. After that review, continue
with agreed corrections. Confirm the core UI review before starting Milestone 2
SSH implementation. Maintain significant review checkpoints as requested by the
user; do not implement the remaining backend and management milestones at once.

Do not install software or helpers on any VPS while building the UI. Revisit
library compatibility and the exact supported-server matrix at their respective
milestones rather than introducing unrequested integrations during setup.
