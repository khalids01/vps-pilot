# VPS Pilot implementation plan

Status: core Milestone 1 UI was committed as `ca55a59`; initial SSH connections
were committed as `11778af`. The working tree now adds real remote PTYs,
read-only inspections/monitoring, native single-use approvals, catalog preflight,
and fixture-tested systemd controls. This does **not** complete all milestones.
App-triggered changes are disabled in Rust in normal builds because the user's
available VPS is important and not disposable.

The user authorized the remaining scope on 2026-10-29 without repeated review
pauses. The old checkpoint pauses below are historical, not a current approval
requirement. Do not run destructive or privileged mutation tests on their VPS.
See `agents/supported-systems.md` and the current progress section below.

This plan records the scope agreed with the user on 2026-10-29. Read
`agents/goal.md` first. This document expands that goal; it does not authorize
unrelated features or changes to Disk Vacuum. Build incrementally in the order
below, keeping each milestone reviewable.

## Approved interface

Use the existing exact dark green theme and shared themed controls. Preserve VPS
Pilot's independent identifier, repository, build output, and release setup.

- Top browser-style tabs: one VPS connection per tab, with name, connection state,
  close action, reordering, overflow handling, and a plus button. Tabs occupy the
  top row; no separate Manage SSH servers header. Plus offers an existing
  connection list (SSH config and app-saved profiles) or a separate add form.
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
- Herdr, identified by the user as https://herdr.dev/docs/install/. Inspect the
  target Linux user, executable path and installation-manager ownership. Preserve
  direct-installer, Homebrew, mise and Nix ownership and existing sessions. Verify
  release/artifact integrity before installation; do not pipe an unchecked online
  installer into a shell. Other tools are added only on request.

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

The user approved committing the full UI batch and continuing. Commit `ca55a59`
contains the terminal, helper, tab-reordering, and persistence work.

The first Milestone 2 checkpoint implements:

- Rust `russh` 0.65 client with direct password authentication, bounded network
  waits, keepalives, immediate cancellation, independent per-profile handles,
  connection status polling, and explicit disconnect. No shell or remote command
  channel is opened.
- Native saved-profile create/edit/delete with input validation. Profiles and
  SHA256 host pins use app-owned storage, private Unix permissions, atomic
  replacement, size limits, a write lock, and external-change detection. Invalid
  or externally changed files are not silently overwritten.
- A credential-free probe rejects the presented key while recording a host-review
  challenge. Unknown keys require explicit trust; changed pins cannot be replaced
  in this increment. Authentication uses a fresh, single-use, expiring challenge
  bound to the exact profile revision and rechecks the pinned key before sending
  a password. Passwords are not saved, logged, or routed through query mutations.
- Main-window-only Tauri capabilities for the ten specific SSH discovery/lifecycle/import IPC
  commands; no generic shell, arbitrary file, or remote-execution permission.
- Plus-button connection picker, separate add form, and real VPS tabs with profile address and connection
  state. Closing a real tab confirms disconnect; closing does not delete its
  saved profile. Real tabs never use sample metrics, inventory, or terminal data.
- Failed authentication clears the password and requires explicit verification
  before retry. Cancelled or stale UI requests cannot reopen a dismissed dialog
  or publish a late connection. Profile edits invalidate outstanding reviews.
- Restored workspace tabs do not initiate new connections. Authentication handles
  remain in Rust memory only and are not restored on application restart.
- Local disposable SSH fixtures cover trust-before-authentication, changed keys
  between review and login, challenge expiration, profile changes, wrong passwords,
  independent connections, cancellation, persistence, and storage error handling.
  Browser UI tests use a mocked desktop bridge; native WebKit interaction still
  needs user review. No production VPS was used for validation.

The connection picker uses a compact list with search, source headings, and inline
edit/remove actions. Its Connections / New connection tabs replace the earlier
choice cards and long explanations. The new form accepts a pasted SSH command,
then fills editable fields without saving the raw command or executing anything.
Only destination/config alias, -p, -l, -i, and SSH URLs are accepted; operators,
expansion, tunnels, unknown options, and remote commands are rejected. Private keys
can also be selected through the existing native file picker.

Config discovery uses `ssh2-config` 0.9 with logging disabled, including scoped
Include files. Opening stores an app-owned metadata copy and never writes back.
HostName/User/Port, the first IdentityFile, and password-authentication policy are
imported. Proxy/jump/interface requirements are blocked. Match/unknown directives
and cycles fail closed without hiding app profiles. Config commands never execute.

Password entry is optional: authentication supports none (when allowed by the
server), selected private keys, Unix agents, and default id_ed25519/id_rsa files.
Explicit identities restrict agent signatures to the selected key. Without an
identity, at most three agent keys and two default files are tried. Encrypted keys
use a separate transient passphrase. File reads/decryption run off the async worker;
key buffers, passwords, and passphrases are zeroized where owned by Rust. No key
contents or credentials are serialized or returned to the frontend. App-owned
profiles store only an optional key path and authentication policy alongside the
existing metadata. Existing profiles remain compatible. Config key-only profiles
never send a supplied password. Host pins, challenge binding, cancellation, and
independent connection lifecycles remain enforced before all authentication methods.

Validation includes disposable local key-only/none/password SSH fixtures, encrypted
key failure/retry, a disposable Unix agent, metadata preservation, parser rejection,
and a mocked desktop UI covering blank-password submission and command paste.
Browser screenshots were checked at desktop and narrow sizes. No production VPS
is used for testing.

Current limits: app-owned host pins, no changed-key replacement UI, full SSH config
execution, jump hosts, certificates, MFA/keyboard-interactive, PTYs, discovery, or
server management. These remain explicit future increments.

This checkpoint originally paused for review. The user subsequently authorized
the remaining work; implementation now follows the progress recorded below.

Do not install software or helpers on any VPS while building the UI. Revisit
library compatibility and the exact supported-server matrix at their respective
milestones rather than introducing unrequested integrations during setup.


## Current implementation progress — 2026-10-29

Implemented in the current working tree:

- Real xterm/Dockview terminals use separate russh PTYs, bounded input queues,
  acknowledged output, resize propagation, session limits, and server-bound
  controls. Sessions remain mounted through tool/server navigation. Rename,
  grouping, splits, maximize/restore, previous/next and confirmed closing are
  available. Layout persistence discards output, credentials and start triggers;
  restored panes require an explicit Start shell action. Reconnect never replays
  commands or silently creates replacement sessions.
- Fixed Rust-defined inspections cover Overview, package/runtime inventory,
  containers/Compose/images/volumes, proxy/listener ownership, systemd status,
  mounts/filesystems, UFW, network counters and processes without command-line
  arguments. Section failures survive the aggregate exit status. Overview derives
  memory/disk measurements and CPU deltas from actual samples. Monitoring is
  opt-in, bounded and scoped to the selected tool/server.
- Native single-use action reviews bind server/profile revision, connection,
  exact command and two-minute expiry. Rejection executes nothing. Sudo prompts
  use a separate SSH stdin path; no password is passed as a command argument or
  persisted. Missing/incorrect passwords terminate the attempt. Cached sudo still
  requires a new approval. Reviewed reads include UFW rules, service journals,
  bounded container logs and one-level scans without crossing filesystems.
- Software preflight covers Docker/Compose, Nginx, Caddy, Traefik, Dokploy, Git,
  Node.js, nvm, Python, Go and Herdr. It inspects package/executable ownership,
  listeners, service configuration and stopped-container port reservations.
  Known conflicts and missing evidence are separate; neither grants permission
  to install. System Python is protected. No software installer runs.
- A narrow Debian 12 x86_64 systemd change implementation has protected-service,
  dependency, canonical identity, unit configuration, stable job-state and stale
  plan checks. It serializes mutations, reconciles interrupted state, and verifies
  resulting ActiveState/UnitFileState. **Normal builds hard-disable all such
  changes in Rust**, including direct IPC calls. Only disposable fixture tests
  enable this implementation. The UI disables these options.
- Shared themed controls, per-server tool preferences, lazy terminal loading,
  command/output state, timestamped partial/disconnected results and sample/real
  separation remain in place. No helper is needed for these SSH functions.

Validation:

- Unit tests cover metrics parsing, partial/missing measurements, allowlisted
  remote layout metadata, sample workspace boundaries and catalog conflict rules.
- Native SSH fixtures cover PTY isolation/resize/disposal, acknowledgements,
  session limits, trust/authentication, sudo stdin, approval binding/expiry/reuse,
  protected services, stale plans, serialization and the production read-only gate.
- A rootless Debian 12 systemd container validates real start/restart/stop and
  boot enable/disable with postcondition checks on its disposable fixture unit.
- A separate loopback-only OpenSSH container validates actual key-authenticated
  remote PTY output and partial inspection handling. Its generated key and
  container are deleted automatically. No user VPS is used.
- Playwright uses two fictional server profiles and a mocked desktop bridge to
  check restore-without-connect, server isolation, rejection/approval, secret-free
  persistence, session survival and inactive layout restoration, and narrow UI.
  This does not establish native WebKit behavior.

Outstanding:

- Native Tauri/WebKit interaction and full disposable VM/VPS integration checks.
- Complete structured inventory/source ownership and the Dokploy/Traefik fixture.
- Catalog-specific install/update/uninstall executors, verified downloads,
  dependencies, resource manifests, recovery and data-preservation checks.
- Docker/Compose mutations and dependency-aware removal; proxy editing with
  configuration backups, validation/reload and tested rollback; UFW rule changes
  with SSH protection and tested automatic rollback; cleanup with exact ownership,
  open-file/mount protections and execution-time target checks.
- Optional helper lifecycle only if SSH measurements establish a need. No helper
  binary, release, installation path or uninstall command has been invented.
- Broader distro/architecture support and release/signing validation.

The important user VPS may be connected for explicitly requested SSH and read-only
inspection. It is not an acceptable substitute for disposable destructive test
fixtures. Do not claim these remaining milestones are complete or enable their
actions on the strength of mocked tests or read-only preflight output.

## UX refinement — 2026-10-30

The user approved restoring the bottom command console, compacting connection
context, and replacing terminal-style inspection output with application views.

- Real VPS workspaces now have a persistent expandable bottom console shared by
  ordinary inspections and reviewed sudo actions. It shows exact commands before
  dispatch, live bounded output, exit status, duration, cancellation, and recent
  in-memory history. Monitoring is grouped separately and replaces its previous
  completed sample. Histories, selected entries and drawer expansion stay scoped
  to each open server workspace; terminal input and credentials never enter them.
- A compact connection header keeps the server, address, connection state and
  read-only mode visible. Host/user/port/key metadata is behind Connection details.
- Rust produces typed presentation reports from fixed read-only output formats.
  Overview has measured resource cards and usage bars. Other tools render
  searchable, sortable, paginated tables for containers, Compose, images, volumes,
  services, packages, runtime paths, filesystems, mounts, devices, firewall rules,
  network interfaces/routes/counters/listeners, processes, logs and directory sizes.
  Raw output lives in the console instead of the main content area.
- Missing permissions, malformed output, unavailable tools, partial results and
  confirmed empty results remain distinct. Report capture and displayed rows have
  bounds. Stopped containers with empty published-port fields are preserved.
- Explicit Inspect/Refresh and opt-in monitoring behavior is preserved. This UX
  work does not add automatic initial discovery, enable mutations, or use the
  user's important VPS as a test fixture.
- Native parser/stream tests cover the presentation contract, failure states,
  numeric limits, nested JSON, missing port fields and row bounds. Browser mocks
  cover all tool views, drawer persistence/isolation, sorting/filtering/pagination,
  cancel, monitoring grouping, responsive layouts and secret-free persistence.
  The loopback OpenSSH fixture also validates measured overview parsing against
  actual Linux output. Native WebKit acceptance remains a separate release check.

### Landing page and release distribution — 2026-10-30

- Added independent static green-themed landing page in website/ with responsive
  workspace illustration, current-feature descriptions, explicit read-only scope,
  release-asset downloads, and no-release/offline fallbacks.
- Added GitHub Pages deployment for website/ and tag-triggered desktop release
  matrix: Linux x64, Windows x64, macOS ARM64 and Intel. Complete asset validation,
  version checks, draft staging, and SHA256SUMS precede publication.
- No custom domain, updater integration, production VPS access, or signing
  credentials introduced. GitHub-hosted builds require the workflows to be pushed;
  Pages requires GitHub Actions selected as its repository source.
- Validation: bun run check/build, 16 frontend tests, cargo fmt/check and
  43 native tests passed; three landing-page browser tests passed. Actual local
  DEB (6.50 MiB) and AppImage (87.76 MiB) bundles generated successfully.
  Windows/macOS packaging and hosted workflows have not run yet.
