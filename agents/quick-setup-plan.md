# Quick Setup, SSH Access, Firewall and interface clarity

Status: proposal for review; planning only. Prepared 2026-11-01 against local
HEAD `f037baa` (`feat: refine Docker workspace and add reviewed cleanup`). The
working tree was clean before this document. No remote was fetched, no VPS was
contacted, and no application code or mutation gates are changed by this plan.
“Current repository” below means this inspected checkout, not an independently
verified upstream revision.

## 1. Scope, constraints and decisions for review

Deliver a clearer shared dark theme, an optional Quick Setup checklist, a durable
SSH Access page and a dedicated UFW page, backed by one typed configuration and
execution system. Quick Setup composes management capabilities; it does not own
another installer or SSH/firewall executor. Existing installations and workloads
are the baseline to preserve, not obstacles to clear.

Read `goal.md`, `plan.md`, `supported-systems.md`, and relevant feature validation
notes before implementation. This new request limits this increment to planning
until review, despite older general implementation authorization.

Two existing policies need explicit reconciliation in the reviewed implementation:

- `goal.md` says app profiles never modify SSH config. Proposed exception: a
  separate, opt-in, reviewed local SSH-config export/update action. Saving an app
  profile still never implicitly edits `~/.ssh/config`. Reads remain read-only.
- The exact Disk Vacuum theme requirement is superseded for this proposed phase
  by the requested forest-green/mint identity with improved clarity. Change only
  VPS Pilot tokens/components; keep Disk Vacuum independent and untouched.

Keep production system/service/firewall/proxy gates closed until each new adapter
passes its own disposable-VM matrix. Existing dedicated SFTP and Docker permissions
are not authorization to edit system files or SSH credentials through those APIs.
No permanent privileged helper, public listener, production test, automatic fleet
inspection, partition formatter, filesystem resize, reboot, unattended full upgrade,
or cloud firewall write is part of the initial increment.

No screenshot image files accompanied the pasted requirements available here.
Visual findings below come from code, not a claim to have reviewed the referenced
screenshots. Review actual desktop screenshots during the theme phase.

## 2. Findings from the inspected repository

| Area and evidence | Existing behavior to reuse | Gap / extension |
| --- | --- | --- |
| `src-tauri/src/ssh/mod.rs` | russh connections, host-key challenges/pins, connection IDs, runtime jobs/streams and profile revisions | One live handle per profile; verification needs a separate candidate connection that does not replace it |
| `src-tauri/src/ssh/auth.rs` | Password, explicit private key, Unix agent and default key authentication; zeroized secret inputs | Does not expose trusted authentication-method evidence; ordinary fallback/none authentication cannot prove a specific key worked |
| `src-tauri/src/ssh/store.rs` | Validated profiles, endpoint-based host trust, migration into local SQL | Profile updates require disconnection; no migration-aware staged endpoint commit |
| `src-tauri/src/ssh/config.rs`, `command.rs` | Bounded read-only SSH config discovery and pasted-command parsing; unsupported conditions/forwarding are blocked | No preserving writer, alias ownership, local key inventory or key generation; never execute Match exec/ProxyCommand for discovery |
| `src-tauri/src/ssh/discovery.rs` | Fixed unprivileged inspection commands; OS, identity, packages, services, storage, listeners and basic UFW output | No cohesive setup snapshot, effective SSH policy, structured desired-state diff or full UFW semantics; unprivileged UFW may fail |
| `src-tauri/src/ssh/structured.rs` | Bounded reports, partial/unavailable states and simple firewall projection | Numbered display rules are insufficient as stable identities or evidence for safe edits |
| `src-tauri/src/ssh/actions.rs` | Typed actions, 120-second single-use reviews bound to connection/profile, exact commands, stale preconditions, sudo stream input | `UfwStatus` is privileged read-only; no UFW writes or SSH mutation action. Generic service changes are production-disabled. No independent rollback scheduler |
| `services.rs`, `catalog.rs` | Protected infrastructure services, supported-service preflight, software ownership/conflict evidence | Reuse detection/policy concepts, but do not bypass protected SSH service rules through generic lifecycle actions |
| `streams.rs`, `monitor.rs` | Per-server bounded channels, backpressure and lightweight monitoring; stream cap of 12 | Reserve capacity for recovery and independent verification; do not run setup discovery inside the sampler |
| `files.rs`, `files/operations.rs` | Reviewed SFTP writes, canonical-path protections and bounded operations | Intentionally protect SSH/system paths. Keep these protections; new security adapters need separate narrow policies |
| `docker/manager.rs`, `docker_manager.py` | Dedicated review, dependency evidence, backups and real disposable-VM precedent | Reuse protocol patterns and existing Docker projections. Do not make Docker cleanup/install policy a firewall authorization path |
| `src-tauri/src/database.rs` | App-owned rusqlite DB; schema v1 is a validated `documents(key,value)` table, settings, compare-and-swap | No security-operation journal or key metadata schema; use a small explicit versioned migration, not arbitrary frontend document writes |
| `src/features/ssh/remote-workspace.tsx` | Per-server command/metrics providers; retained terminals, Docker and Files across navigation | Firewall is generic inspection plus actions. Add retained feature state; provider currently keyed by profile revision can reset on profile commit |
| `remote-actions.tsx`, `command-activity.tsx` | Review/execute UI, per-tool reports and bounded memory-only console | Extract shared typed review flow without retaining credentials; security operations must survive page navigation and report uncertain outcomes |
| `report-types.ts`, `structured-report.tsx` | Human-readable reports, table sorting/filtering/pagination and partial evidence | New domain models need typed rules/policy rather than generic string arrays; replace regex-only status coloring gradually |
| `workspace.tsx`, `fixtures.ts`, `preferences.ts`, `command-palette.tsx` | Tool IDs, saved selection, fleet navigation and palette | Tool registry is duplicated between shell/sample/remote navigation; add both new IDs consistently and preserve old saved selections |
| `src/components/ui/*`, `action-review.tsx` | Base UI themed buttons, inputs, selects, dialogs, tabs, tooltips, menus and checkbox | Reuse primitives; consolidate review patterns carefully rather than assuming sample review equals native execution approval |
| `src/styles/globals.css` | Forest/mint OKLCH tokens, Manrope, shared semantic variables | Most surfaces/borders share hue 155–160; no dedicated warning/info or table/shell roles; translucent surfaces compound contrast |
| Tests and `tests/fixtures/README.md` | Browser mocks, native SSH tests, disposable OpenSSH/systemd containers, KVM Docker launcher and policy tests | Containers/Alpine Docker validation do not certify Ubuntu/Debian SSH socket activation, actual UFW connectivity or rollback |

Documentation drift: introductory blanket “all mutations disabled” statements in
`plan.md` and `supported-systems.md` are older than the dedicated enabled
Docker/SFTP paths described in `goal.md` and implemented in code. During reviewed
implementation, reconcile documentation by capability; do not broadly enable
`changes_enabled` or describe the whole application as either writable or read-only.

## 3. Navigation and page structure

Keep one top-level VPS tab per server and its current sidebar. Add **Quick Setup**
after Overview and **SSH Access** near Firewall. Keep the existing Firewall tool ID,
replacing its generic report with the new page. Preserve Overview, Terminal, Files,
Docker, Proxy, Services, Network and Processes and their session lifetimes.

Quick Setup opens dedicated SSH Access, Firewall and Docker views using the same
server ID, snapshot and selected action. Returning restores checklist selections.
The command palette adds navigation only; selecting a page must not connect,
change configuration or execute commands. The new pages initially offer **Inspect
server**. Once inspected, reuse cached evidence with its observation time; Refresh
is explicit. Do not infer setup state for unopened fleet servers.

Examples (illustrative values only; never ship these as connected-server data):

```text
[VPS tabs: production • | staging | +]
Overview       Quick Setup                         Inspected 2 min ago [Refresh]
Quick Setup    Existing applications detected. Select only changes you need.
Terminal       Category          Current state              Next action
Files          System            Debian / timezone UTC       Review timezone
Docker         Users and SSH     Key login not verified      Open SSH Access
SSH Access     Security          UFW inactive                Open Firewall
Firewall       Essentials        Git and curl installed      No change
...            Docker            Existing Compose workloads  Open Docker
               Resources         No swap / storage healthy   Review swap
               [2 selected]                         [Review selected actions]
[Command console: target, exact safe command, bounded output, result]
```

```text
SSH Access                                  [Inspect / Refresh]
Effective policy for deploy from current client       Observed just now
Password login  Enabled     Public key  Enabled       Root  prohibit-password
Listeners      :22          Active SSH connections    [View]
[Policy] [Authorized keys] [Local keys] [Local SSH config] [Recovery]
Authorized key    Fingerprint        Restrictions        Action
Laptop           SHA256:...         no forwarding       Rotate…
[Add public key]   [Verify independent key login]

Firewall                                      Inactive [Review enable…]
Incoming: deny   Outgoing: allow       Cloud firewall: unknown
SSH path: verified on :22             Docker published ports: separate warning
[Rules] [Listeners] [Recovery]
Action   Protocol  Destination  Source         Family   Explanation
Allow    TCP       22           current subnet IPv4     Allows SSH from ...
[Add rule] [SSH] [HTTP] [HTTPS]       [Review 1 pending change]
```

Page content uses the workspace page scroll. Avoid nested vertical tables/forms
and sticky local tabs, following the latest Docker correction. Allow horizontal
table overflow and bounded console/terminal output. A narrow inspector/review can
be a dismissible overlay with predictable focus return.

## 4. Interface and dark-theme strategy

Incrementally replace hardcoded shades with semantic roles. Retain existing
Tailwind/shadcn token contracts while adding shell, content, elevated, control,
table-header, row-hover, selection, success, warning and neutral-information roles.
The following are starting candidates, not measured acceptance values:

| Role | Candidate | Use |
| --- | --- | --- |
| Shell | `#0b1210` | Tab frame and app perimeter |
| Sidebar | `#101a16` | Slight forest identity, quieter navigation |
| Main content | `#151b18` | Primary reading surface |
| Elevated | `#1e2622` | Popovers, dialogs and occasional grouped surfaces |
| Control / table header | `#28312c` | Distinguishable editable and column surfaces |
| Border | `#3d4841` | Neutral separators, strengthened for required control boundaries |
| Primary / secondary text | `#f0f3f1` / `#b1bcb5` | Readable neutral text, not green-tinted body copy |
| Mint action | `#84d9b0` with dark text | Main action and selection accents |
| Success / warning / danger | `#86d6a4` / `#f0c779` / `#ff999e` | Status text with icon and label, separately tested backgrounds |

Measure actual rendered, composited colors rather than asserting these candidates
pass. Normal text including placeholders/secondary text targets 4.5:1; large text
3:1; necessary UI boundaries, focus and graphical indicators 3:1. Test hover,
selection, error, popover, autofill and reduced-opacity states. Disabled controls
must still explain why an action is unavailable. Color never carries status alone.

Use 13–14px table/body text, 12–13px supporting text, 18–20px page headings,
tabular numbers for ports/time, and monospace only for exact paths/commands/keys.
Keep Manrope, 4/8px spacing rhythm, 32–36px typical controls and at least 24px
interactive targets. Prefer row dividers, headings and whitespace over nested
cards. Reduce mint glows and the body gradient; ordinary borders/statuses stay
neutral. Use plain wording first, expandable technical evidence second.

Create shared typed status, inline notice, evidence timestamp, page state,
settings row, rule table and change review compositions on existing Base UI
primitives. Every field needs a label and associated error; icon-only controls
need names; dialogs trap/restore focus. Check keyboard operation, 200% zoom,
reduced motion, screen reader announcements and focus obscuring. Keep terminal,
editor and log contrast consistent without changing their interaction semantics.

Roll out tokens/shared controls first, then new pages, then existing Overview,
reports, Files and Docker in small visual regressions. Do not rewrite every page
or make CSS changes to Disk Vacuum.

## 5. Shared detection, planning and execution architecture

### Ownership and boundaries

Rust owns evidence, validation, plans, approvals, privileged execution and recovery.
React owns selection, explanation, forms and presenting native outcomes. No IPC
accepts arbitrary shell, config paths, rollback scripts or caller-declared safety.
Use existing russh, tokio, serde, rusqlite, zeroize and Base UI packages; new
packages need maintenance/license/platform evaluation at implementation time.

Add an internal `ssh::configuration` module with focused setup, SSH-access,
firewall and recovery adapters. Reuse existing connections, streams, preflight
projections and console. Extract common review identity/expiry/locking into shared
support used by new adapters; avoid a broad rewrite of validated Docker/Files.
Eventually coordinate overlapping protected changes through one per-server
resource lock shared with other managers. This lock is not protection against an
external administrator; re-read fingerprints and fail closed on interference.
Never hold a global runtime mutex throughout a multi-minute transaction.

### Proposed typed contracts

- `ServerCapabilities`: distro/version/architecture, binaries, init/backend,
  permissions, service/socket ownership, unsupported reasons and observation time.
- `Observation<T>`: profile ID/revision, connection generation, value, source,
  collected time, completeness (`complete`, `partial`, `unavailable`), fingerprint
  and permission failures. Unknown is never equivalent to absent or disabled.
- `ConfigurationItem`: stable category/item ID, current/desired summaries, status
  (`configured`, `attention`, `missing`, `unknown`, `conflict`, `unsupported`),
  ownership, risks, evidence references and supported action IDs.
- `ChangeIntent`: typed operation and validated parameters; no shell text.
- `ChangePlan`: native plan ID, exact target, evidence hashes, ordered dependency
  graph, no-op/conflict results, before/after diff, downtime, safe command previews,
  required privileges, backups, recovery strategy and approval expiration.
- `ChangeOperation`: operation/step IDs, state, result/reconciliation state,
  cancellation boundary, verified effects and recovery deadline.
- `RecoveryRecord`: remote transaction ID, rollback artifact hashes, scheduler
  identity, prior state, deadlines, finalization proof and minimal local reference.

Retain existing 120-second approval semantics unless evidence justifies a reviewed
change. Fresh per-command approvals bind to exact plan/step/server/connection and
state; changing selection invalidates the whole affected dependency plan. Overall
batch review never substitutes for a sudo modal. Show commands with confidential
payloads passed through protected stdin/files and described safely; redact before
console/event creation, not only before persistence.

### Discovery and overhead

Batch small bounded probes over the existing connection, deduplicate concurrent
requests by server/generation/domain, cache across pages, and expose age. No
periodic package, listener, key, service or firewall inspection; Refresh and
preflight trigger these probes. Keep configuration inspection outside the 1/2/5s
sampler. Pause new discovery for disconnected/closed workspaces and cancel pending
reads when safe; navigating does not destroy an already running operation.

Initial engineering bounds to validate: 30-second timeout per normal probe,
1 MiB maximum projected response per domain, 1,000 rules/key entries per bounded
collection, and one configuration mutation per server. Paginate or report
truncation; incomplete critical evidence blocks mutation. Package execution needs
its own bounded phase deadlines and cancellation rules, not a 30-second kill that
leaves a package manager interrupted. Reserve stream slots for verification.

## 6. Quick Setup workflows

Inspect once on request; show incremental category results and preserve successful
observations if another probe fails. Classify fresh/partial/existing based on
evidence and let the user inspect details; classification never authorizes action.
No default “apply everything”, no forced wizard completion, and no automatic
package index refresh during detection. Existing package metadata may be stale.

| Category | Inspect | Selectable action / preservation rule |
| --- | --- | --- |
| System | `/etc/os-release`, architecture, hostname, timezone, package manager/source and cached update age | Change hostname/timezone separately; refresh package indexes only as a reviewed write; package updates preview versions, service restarts, disk needs and reboot implications |
| Users/SSH | Current identity, bounded relevant accounts/groups, sudo access evidence, effective SSH policy and auth evidence | Open SSH Access; later create an explicit non-root admin with verified privileges before changing root policy; never infer sudo rights from group membership alone |
| Security | UFW, Fail2ban installation/service/config ownership, unattended-update package/config/timer | Delegate UFW; install/configure Fail2ban and automatic security updates individually with owned diffs; account for bans affecting current admin |
| Essentials | Git, curl, CA certificates and explicit named utilities with package ownership | Install only selected missing packages; preserve alternate installs, repositories and user defaults |
| Docker | Engine/Compose source, version, daemon access, live/stopped workloads and reservations | Open existing Docker management; a new tested installer/update adapter is needed, not an assumption that existing deployment support installs Engine |
| Resources | Existing memory/storage snapshots, swap, mounts, free space and filesystem capabilities | Optional bounded swap-file plan only after filesystem checks; existing swap preserved. Disk configuration is inspection/guidance initially; no partition/resize/destructive storage changes |

Select individual items, reveal dependencies, and explain why an action is
blocked. A required dependency is explicitly added/reviewed or the dependent
action stays unavailable. Plans include already-satisfied no-ops. Reinspect before
execution, stop dependent steps on failure, and show unrelated optional steps as
not run until explicitly continued. No automatic reinstall, downgrade, purge,
repository replacement, daemon restart or reboot.

Package operations need dpkg/apt lock handling, pending-reboot and interrupted
package-state detection, trusted signed repository policy, bounded output and
service-impact review. Package removal/downgrade is not a general rollback.
Docker upgrades on active deployments require a separate downtime/compatibility
review; remain unavailable until tested. Resource tuning must never silently
change kernel defaults, mount options or consume reserved application disk space.

## 7. SSH Access and local key management

### Inspection and effective policy

Use a distro adapter to locate the actual daemon executable/configuration,
service aliases, drop-ins, invocation flags and socket activation. Inspect
`sshd -T` with explicit `-C` connection context when supported, compare listener
state, and use `sshd -t` for validation. Include user, client source, local
address/port and relevant Match context; don't present one user's result as global
policy. Discover Include ordering, cloud-init/provider ownership, custom daemon
paths, multiple daemons and systemd socket generators. Block unsupported edits
instead of appending a guessed `99-*.conf` that may not take effect.

Read PasswordAuthentication, PubkeyAuthentication, PermitRootLogin,
AuthenticationMethods, keyboard-interactive/PAM, Allow/Deny users/groups,
AuthorizedKeysFile/Command and certificate trust. “Disable password login” needs
an explicit explanation of password vs keyboard-interactive paths; preserve MFA
requirements and block transformations the adapter cannot model. Do not change
PAM or external identity providers to make a simple switch appear to work.
Show root policy as exact supported choices with explanations; prevent disabling
the only verified administrative identity. Active connection metadata is bounded
and contextual; do not collect command lines or treat connection presence as
proof of its authentication method.

### Keys

1. List bounded local public key fingerprints/path references and agent identities
   without recursively scanning the computer or disclosing private material.
2. Generate an Ed25519 key locally using an audited maintained API already
   available through the SSH stack if supported, otherwise evaluate a maintained
   library. Never pass passphrases via command-line arguments. Offer encryption,
   explicit destination, no-clobber creation, platform permissions/ACL checks and
   atomic cleanup of incomplete generation. Private key bytes stay in native
   memory/local protected files; never send to renderer, VPS, SQLite or console.
3. Existing key selection records only path/fingerprint; encrypted/agent/hardware
   keys have explicit supported/unavailable states. Unix agent support today does
   not prove Windows agent or hardware-key support; validate separately.
4. Install only a selected public key for a verified target account/home/effective
   authorized-keys path. Preserve comments, options, unrelated lines, ownership
   and modes; reject symlinks, ambiguous paths and externally managed sources.
   Use a narrow dedicated adapter, not a relaxation of Files protections.
5. Parse restrictions and fingerprints; don't flatten `from=`, forced commands,
   certificates or unknown entries. Show opaque preserved lines read-only.
6. Rotate additively: add new key, verify independent key-only authentication and
   required privileges, then separately review removing the exact old key. Never
   remove all verified access or delete local private keys as a rotation side effect.

### Local SSH configuration

Keep config discovery read-only. New opt-in export/update uses exact alias/path
review, preserving comments, ordering, wildcard/Include/Match scopes and file
permissions, with a protected local backup and compare-before-atomic-write.
Do not reserialize the whole file through the discovery parser. Prefer an
explicitly owned simple Host block; overlapping/conditional aliases are blocked
for automatic editing and offer a copyable proposal instead. Do not execute
config directives to discover effective settings. Review alias collisions and
verify the app's supported resolution after writing. Never replace known_hosts
or accept a changed host key to make migration pass.

App profile synchronization is separate from SSH-config writing. Keep previous
endpoint/pin references until verified finalization. A candidate port may share a
server's existing host key, but promotion requires explicit binding to the known
server identity; never auto-trust an arbitrary candidate fingerprint. Stable
server/workspace identity remains the same across a verified endpoint revision.

## 8. Firewall rule management

Distinguish missing UFW, installed inactive, active, unavailable permission,
unsupported backend and unknown. Inspect verbose defaults and numbered IPv4/IPv6
rules plus supported persistent/backend configuration and relevant listeners.
Privileged reads retain their own approval modal. Don't parse a failed read as
“disabled” or an empty ruleset. Preserve unmanaged before/after rules, application
profiles, logging and backend configuration; unknown critical semantics block edits.

Typed rule fields: direction, allow/deny/reject/limit where supported, TCP/UDP/any,
validated single port/range, source/destination address or CIDR, source/destination
port where supported, interface, address family and comment. Presets only fill
fields; SSH uses verified active/candidate ports rather than assuming 22. HTTP
and HTTPS presets do not claim an application is running. Treat routed/forwarded
rules and complex unparsed rules as read-only initially, with a visible reason.

Identify rules by semantic content, occurrence and snapshot hash. Numbered rule
indices shift; never execute deletion against a cached number. Re-fetch and map
the exact reviewed target immediately before execution, handling duplicate rules
and IPv4/IPv6 paired expansion explicitly. Rule editing is a staged replacement
with preserved ordering and no unsafe gap; if ordering cannot be preserved, block
or require a separately supported explicit replacement plan.

Show plain explanations such as “Allows TCP connections to port 443 from any IPv4
address.” Show rule order, default policy and listener evidence separately. Default
incoming/outgoing changes, enable, disable and deletions are reviewed operations,
not immediate toggles. Disabling UFW may expose services and is dangerous even
when it does not threaten SSH. Never add broad temporary allow-all rules.

Protection evaluates actual server-observed administrative source, target user,
interface, local address/port, IPv4/IPv6 family, rule ordering/defaults and planned
post-change state. Source NAT/proxies, multiple admins and public-to-private port
mapping require explicit evidence; the client profile port may differ from the
server's listener. Preserve more than the current TCP flow: require a fresh
verified connection before retiring protection.

A listener is not proof of public reachability. Show independent evidence labels:
listener, UFW policy, Docker publication and cloud/provider reachability unknown.
Do not claim to inspect or change cloud ACLs without a provider integration.
Docker-published ports need a distinct warning and existing Docker inventory;
do not silently alter Docker's chains or claim a UFW deny secures them. A
successful app connection tests only that origin/address family, not the Internet.

## 9. Safe change transactions and lockout prevention

### Transaction states

```text
inspect -> plan -> review -> backup -> arm recovery -> revalidate
        -> stage/apply -> independent verification -> finalize -> complete
                               | failure/deadline/disconnect
                               v
                       rollback pending -> rolled back / recovery failed
```

Also represent no-op, rejected, stale, canceled-before-apply, partially completed,
unknown outcome and local-finalization-pending. A timeout is not proof of rollback
or success. An unknown security result blocks conflicting changes until reconciled.

### Recovery mechanism

Use a narrowly scoped root-owned, per-operation rollback artifact and independently
scheduled server-side job, preferably a tested systemd timer/service on supported
systemd hosts. It must run without the desktop, the initiating SSH channel, cached
sudo tickets or an interactive password. No permanent privileged daemon is needed.
Backups include validated config/rules, permissions, service/socket state and hashes;
protect directories/files, reject writable parents/symlinks, and never build a
root-executed script from unvalidated strings.

A transient timer is a candidate for disconnect/crash recovery, not sufficient
proof of reboot recovery. Initially block planned reboots; test unplanned reboot
handling. Either validate a durable one-shot boot recovery unit with conservative
startup ordering or classify that adapter as incapable and keep risky automation
disabled. A desktop countdown, `sleep` in an SSH shell or scheduled command that
still needs sudo is not recovery. Scheduler creation must be verified before
changes; failure to arm means nothing risky is applied.

Propose a 180-second verification window, configurable only within tested bounds.
Use server monotonic timing for the deadline, display local remaining time as an
estimate, and stop issuing mutating steps near expiry. Test actual package/service
latencies before fixing the bound. Rollback is idempotent, exact-resource scoped,
locally serialized against finalization and writes a bounded machine-readable
status. Do not overwrite unrelated externally changed resources blindly: preserve
recovery evidence and surface manual intervention when safe restoration is unclear.

Every interactive app-triggered sudo command, including backup/scheduler/apply/
finalize operations, gets its own explicit modal even with cached credentials.
Before arming, review and explicitly authorize the exact unattended rollback
payload, target resources, trigger and deadline as part of scheduler creation.
The independently running rollback cannot request a new modal after the app has
crashed; this advance recovery authorization must be documented in reviewed policy.
Refusing a later approval leaves armed recovery intact. Never disable automatic
recovery merely because navigation, cancellation or an approval timeout occurred.

### SSH migration sequence

1. Inspect effective auth, privileges, listener/service/socket control, UFW/cloud
   limitations, existing workloads and recovery support. Block unknown critical
   ownership or unmanaged firewall paths that cannot be preserved.
2. Prove selected-key authentication through a new transport with password/none/
   fallback disabled. Verify host identity, exact user, key fingerprint, proposed
   authentication policy and required administrative capability. An existing
   authenticated channel is insufficient.
3. Plan old and new access together. Add narrowly scoped new-port firewall
   allowance before exposing a new listener. Ask for provider ACL preparation
   where needed, but require an actual connection test rather than trusting a checkbox.
4. Back up, validate the exact proposed SSH configuration, arm and verify recovery,
   then re-read all critical fingerprints before applying.
5. Stage old and new SSH ports concurrently using a tested daemon/socket strategy.
   Respect Ubuntu/Debian service aliases and socket activation; do not guess that
   restarting sshd applies a socket-owned ListenStream. Preserve original transport.
6. Establish a second independent candidate connection using only the proposed
   user/key/port and verified host identity; verify privileges. For authentication
   changes, verify actual effective post-change policy, not just a successful login.
7. Display the verified result and impacted terminals. Finalize remote recovery
   disarm only through the native transaction protocol with verified proof and
   scheduler acknowledgement; never race a timer by deleting files optimistically.
8. Commit verified profile/optional reviewed local config using compare-and-swap.
   If local writing fails after remote success, show old/new verified endpoints
   and retry local finalization only; do not rerun remote mutations.
9. Retire the old port/rule/key only as a separately reviewed protected transaction
   with its own recovery and new-connection check. Don't bundle access removal
   before the new path and local reference are durable.
10. Offer reconnect using updated profile. With affected running sessions, warn
    and let the user retain the old transport until a safe handoff or explicitly
    consent to termination. Do not automatically replay terminal commands.

Current one-handle-per-profile storage, disconnect-only edits and
`CommandActivityProvider key={profile.revision}` need a narrowly designed staged
promotion path: candidate handles live under transaction IDs, workspace identity
and bounded chart/console history stay stable, and older streams retain their
connection generation until closed. Profile edits outside this workflow keep
their current disconnected requirement.

### Firewall transactions and cancellation

Enable/default-policy/delete/edit operations use the same backup/armed-recovery/
new-connection verification protocol. Refuse removal of the only adequate SSH
allowance or any change with incomplete effective-access evidence. Restoring UFW
files alone is insufficient: rollback must restore operational state and verify
listeners/rules/connectivity in fixtures. Avoid indiscriminate netfilter restores
that erase concurrent Docker or provider-managed rules.

Cancel before apply performs cleanup only. After apply, cancel stops future
optional work but does not remove recovery; show “restoring access” or “awaiting
verification” until the server state is reconciled. App close, laptop sleep and
SSH loss do not cancel rollback. Never auto-retry remote mutations on restart.

## 10. Local data and secret handling

Preserve schema-v1 documents/settings/profile migration. Add a small versioned
schema migration for a bounded native-owned operation journal only after its
allowlist is reviewed. Candidate fields: operation ID, stable profile ID, adapter,
intent kind, step/status, timestamps, remote recovery ID/deadline, safe error code,
verified endpoint references and reconciliation flag. Keep unresolved rows until
resolved; cap completed rows (proposal: 100/server, 30 days) without deleting
remote backups as an incidental desktop retention action.

Do not persist raw commands, output, full discovery snapshots, metrics, config
contents/diffs, private/public key lines, passwords, passphrases, tokens or scripts.
Local key metadata may contain path, algorithm, fingerprint and a user label;
store no key material. Diffs and selections remain in per-workspace memory.
Remote rollback references are native-generated opaque IDs with validated owned
paths; SQLite must never become a way to supply arbitrary root rollback targets.

If remote configuration backups contain secrets, retain them only in protected
remote operation directories with explicit recovery/retention controls. The Files
integration must protect new recovery namespaces. No secret output is forwarded
to the console; passphrase/password inputs are cleared after use and zeroized in
Rust where feasible. OS credential storage remains a future explicit feature.
Newer/corrupt local schemas fail without resetting existing data.

On app restart, show unresolved recovery records first. Offer bounded read-only
reconciliation after a user-established connection, identify running/expired/
completed recovery, and request a fresh plan before any further remote write.
No automatic connection or destructive replay follows journal restoration.

## 11. Page and operation states

| State | Presentation and behavior |
| --- | --- |
| Empty / not inspected | Brief purpose and Inspect server; no sample policy, no install recommendation from absent evidence |
| Loading | Per-category progress and cancel for reads; preserve older evidence labeled stale; prevent duplicate probes |
| Configured | Plain current state and timestamp; optional supported change, not a demand to reconfigure |
| Partially configured | Distinguish missing items from unknown/permission denied; select only independent known-safe actions |
| Error / unsupported | Explain what failed and whether changes occurred; explicit Retry/inspect details; no automatic retry |
| Disconnected | Cached read-only evidence marked disconnected with age; mutation disabled; drafts retained; recovery status remains visible |
| Dangerous change | Amber impact or red destructive warning, exact target/diff, SSH access evidence, downtime, recovery deadline and per-command approval |
| Stale/conflicting | Explain changed resource/ownership; invalidate review and offer fresh inspection |
| Applying / verifying | Named step, bounded progress, console link and cancellation semantics; no false percentage for unknown work |
| Rolled back / partial / unknown | Separate verified restorations, remaining effects and uncertain steps; recovery instructions and safe endpoint references |

Security warnings use specific explanations (“This removes the only verified SSH
allowance”) rather than raw stderr. Technical detail stays expandable. Denied
privileged inspection is not a failure of the entire server. Disabled controls
explain prerequisites and how to resolve them without forcing a risky change.

## 12. File-by-file implementation approach

All entries below are proposed future edits, not files created by this planning task.

| File / group | Planned change |
| --- | --- |
| `agents/goal.md`, `agents/plan.md`, `agents/supported-systems.md` | Record reviewed scope/policy exceptions; distinguish capability gates and exact VM-certified platforms |
| `agents/quick-setup-plan.md` | Track phase completion and evidence without silently changing agreed safety requirements |
| `src/styles/globals.css` | Add measured surface/status roles, reduce chroma/glow and document token usage |
| `src/components/ui/{button,input,select,checkbox,dialog,tabs,tooltip,menu,popover}.tsx` | Audit contrast, focus, disabled states and compact sizing; keep Base UI behavior |
| New `src/components/{configuration-status,evidence-time,page-state,change-review}.tsx` | Shared accessible domain presentation composed from existing controls |
| `src/components/action-review.tsx`, `src/features/ssh/remote-actions.tsx` | Extract compatible review composition; keep native approval ownership and legacy safety behavior |
| `src/features/workspace/{fixtures,preferences,command-palette,workspace}.tsx/.ts` | Add tool IDs/labels and navigation, validate persisted IDs, consolidate registry if useful without moving unrelated state |
| `src/features/ssh/remote-workspace.tsx` | Mount retained new views, bypass generic Firewall renderer, preserve stable identity across verified endpoint migration |
| New `src/features/ssh/configuration/{types,api,query-keys,operation-store}.ts` | Typed IPC contract, generation-scoped cache, per-server drafts and native operation subscriptions |
| New `src/features/ssh/{quick-setup,ssh-access,firewall}/` components | Checklist, policy/key/config forms, rule/listener table and recovery views; no duplicate execution |
| `src/features/ssh/{api,report-types,inspection-data}.ts`, `structured-report.tsx` | Integrate typed security observations and shared semantic statuses while retaining generic report support |
| `src/features/ssh/command-activity.tsx` | Safe structured event projection and honest partial/unknown state; memory-only raw output |
| New `src-tauri/src/ssh/configuration/{mod,model,detect,plan,transaction,recovery}.rs` | Native bounded observations, DAG validation, shared locking, review tokens, transaction state and rollback protocol |
| New `src-tauri/src/ssh/configuration/{setup,ssh_access,firewall}.rs` and distro adapters | Narrow allowlisted operations; no frontend-provided scripts or generic privileged file editing |
| `src-tauri/src/ssh/{mod,auth,store}.rs` | Isolated candidate transports, strict selected-key auth evidence, staged verified profile promotion and endpoint trust |
| `src-tauri/src/ssh/config.rs` plus new `local_keys.rs`, `config_writer.rs` | Preserve read-only discovery; add separately reviewed local key/config capabilities and platform tests |
| `src-tauri/src/ssh/{actions,streams,services,discovery,structured}.rs` | Reuse approvals/streaming/detection; add safe adapters without opening generic protected-service gates |
| `src-tauri/src/ssh/files.rs`, `files/operations.rs` | Protect recovery metadata paths; never relax SSH/system path guards |
| `src-tauri/src/database.rs` | Strict minimal journal migration/retention and native-only updates; profile/config commit consistency |
| `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json` | Register narrowly typed commands; add permissions only if demonstrably required |
| `src-tauri/Cargo.toml`, `package.json`, lockfiles | Change only if an evaluated missing capability requires a dependency; reuse installed packages first |
| New domain unit tests and `tests/browser/*` | Meaningful policy/state/interaction coverage with clearly synthetic data |
| `tests/fixtures/README.md`, new security VM launcher/scenarios/results | Isolated Debian/Ubuntu actual SSH/UFW rollback tests, supported-matrix evidence and reproducible teardown |

## 13. Development phases and acceptance criteria

### Phase 0 — Review and safety specification

Confirm policy exceptions, initial actions and unsupported cases, independent
recovery authorization and tested-platform requirements. Pin VM images and identify
a concrete backend/service/socket fixture matrix. No feature implementation before
plan review.

Acceptance: reviewed scope lists approved actions, deferred actions and gates;
no claim of current production certification; architecture preserves independent
app identity and existing authorization policies.

### Phase 1 — Shared readability and page scaffolds

Introduce semantic tokens/components and navigation, with explicit uninspected
states. Apply shared theme to representative existing tables/forms/console before
broad rollout. No remote writes.

Acceptance: measured AA contrast in actual states, keyboard/zoom/narrow-screen
checks, mint identity retained, no native unthemed controls, no auto-connection or
new sampler, and terminal/Docker/Files navigation regressions pass.

### Phase 2 — Typed read-only detection and Quick Setup

Implement shared observations and per-server cache, then read-only Quick Setup,
SSH policy and UFW/listener views. Reuse existing Docker/catalog/storage evidence.

Acceptance: fresh/partial/existing fixture states, missing binaries, permission
failures, cloud unknowns and partial results are accurate; timestamps/incomplete
states visible; no repeated navigation probes, periodic discovery or installation;
critical incomplete evidence blocks planning. Measure fixture overhead without
changing the monitoring budget or contacting the important VPS.

### Phase 3 — Native plans, approvals and recovery foundation

Add typed desired-state plans, stale checks, per-server conflict locks, minimal
journal, exact backups and independently scheduled rollback. Test with fixture-only
mutation authorization before exposing any risky production action.

Acceptance: expired/replayed/wrong-server/connection/profile approvals fail natively;
every sudo step has explicit approval; rollback payload is preauthorized and runs
without desktop/SSH/sudo cache; apply cannot start without verified recovery;
crash/reboot/race/partial states reconcile honestly; generic gates stay closed.

### Phase 4 — Local keys and additive authorized-key workflow

Implement local generation/discovery, reviewed preserving config export and
strict independent key verification. Add public-key installation/rotation under
its own tested native capability after recovery prerequisites where applicable.

Acceptance: encrypted keys and existing entries preserved; no-clobber/permission/
symlink/stale tests pass on supported desktop platforms; private bytes never cross
IPC or enter server/log/history; independent proof names the exact key; removing
old access is blocked until alternate admin access is verified. Local config
failure never silently overwrites profiles or server policy.

### Phase 5 — UFW transactions

Implement typed common rules, exact preflight, presets, defaults and reviewed
activation/deactivation. Enable individual operations only after real VM evidence.

Acceptance: IPv4/IPv6 ordering/duplicate/index-shift tests pass; enable/removal
cannot lose verified admin access; rollback restores actual network state after
app termination; Docker/cloud limitations are visible; no raw global netfilter
restore, force path or inferred public exposure.

### Phase 6 — SSH policy/port migration and verified reconnect

Compose firewall readiness, recovery, strict candidate connection and staged profile
promotion. Support each tested daemon/socket mode explicitly; unsupported modes
stay read-only. Offer reconnect with session impact warning.

Acceptance: password/root/public-key policy and dual-port migration pass separate
Debian/Ubuntu daemon/socket VM scenarios; old path stays until verification; new
transport proves exact auth and privileges; rejected approvals/timer races/local
write failure/host mismatch/disconnect never report false success; no session loss
without warning, no history reset or terminal replay.

### Phase 7 — Selected setup mutations and rollout

Add essential packages, hostname/timezone, then individually tested Fail2ban,
security-update, Docker install/update and swap adapters. Defer an adapter if its
ownership/recovery story is incomplete. Roll shared presentation through remaining
pages in small increments and publish updated support/validation documentation.

Acceptance: selected actions only, already-configured items no-op, existing
workloads/repositories/users preserved, dependency failures stop dependents,
package/database changes never promise automatic rollback, no unreviewed reboot
or storage surgery. Each enabled action has distro/architecture-specific evidence
and a native gate independent of unrelated service/firewall/proxy capabilities.

## 14. Verification and release gates

Run `bun run check`, `bun run build`, relevant frontend unit/browser tests and
`cargo check --locked --manifest-path src-tauri/Cargo.toml`. For Rust changes run
native policy/transaction tests and strict all-target Clippy. Keep expensive
integration checks targeted to the changed capability; don't treat browser mocks
as native or network recovery proof.

Meaningful coverage matrix:

- Unit/property cases: rule/IP/range validation, SSH Match/Include policy,
  key options/fingerprints, config preserving edits, desired-state no-op/conflicts,
  DAG ordering, redaction, expiry/replay and journal migrations.
- Native protocol: direct IPC attempts cannot bypass gates; target/revision binding,
  cancel boundaries, concurrent review/execution, secret stdin, no fallback in
  candidate authentication and profile-promotion races.
- UI/browser: all page states, individual action selection, readable summaries,
  accessible approvals, navigation retention, palette navigation only, two-server
  isolation, stale review invalidation and narrow layouts/zoom.
- Desktop: native WebKit rendering, OS key file picker/ACLs, Linux/macOS/Windows
  paths, focus, encrypted key input, sleep/wake and consented reconnect/session loss.
- Disposable VMs: Debian 12 x86_64 and Ubuntu 24.04 x86_64 first; certify aarch64
  separately before enabling it. These are candidate adapter targets, not a claim
  of security-support lifecycle suitability for all future releases.
- VM scenarios: fresh and already configured hosts; manual/cloud-init config,
  service vs socket activation, IPv4/IPv6, NAT/forwarded ports, duplicate/reordered
  rules, default deny, insufficient sudo, multiple admins, Docker published ports,
  no UFW, competing firewall managers and out-of-band changes.
- Recovery faults: drop original/candidate transport, crash desktop, sleep laptop,
  reject sudo midway, expire timer during verification/finalize, fail scheduler,
  disk full, invalid config, reload error, reboot and failed rollback. Capture
  before/after rules/config/service/listeners plus actual independent SSH probes.
- Package/resource cases: locks, stale indexes, interrupted upgrade, restarts,
  insufficient disk, existing Docker ownership/workloads, swap and unsupported
  filesystem. Verify preservation, not only command exit status.

The security fixture launcher must create new marked guests, generated keys,
private profiles, loopback-only management endpoints and isolated network paths.
Use VM console/hypervisor control as the test oracle when SSH is intentionally
broken. Scope all firewall changes inside guests; never alter host firewall or
use the default Docker daemon. Pin and verify image artifacts, bound resources,
and tear down only owned fixtures. Existing Alpine Docker tests are useful
infrastructure precedent, not a substitute for the new OS matrix.

Record versions, architecture, backend, daemon/socket mode, scenarios/results and
known limits in `supported-systems.md` plus a dedicated validation report. A
capability may be enabled only for its validated combinations; missing fixture
resources mean keeping it gated, never substituting the user's important VPS.
A release must also regression-test existing profiles/trust, local DB migration,
first-launch behavior, open-tab monitoring/session lifetime and current Docker/
Files native safety paths.

## 15. Primary technical references

Consult installed versions' manuals and upstream guidance again during
implementation. References inform adapter design; the application must still
prove behavior in its supported fixtures.

- [OpenSSH server configuration, Ubuntu 24.04](https://manpages.ubuntu.com/manpages/noble/man5/sshd_config.5.html):
  authentication methods, PAM interactions and conditional policy mean a single
  password toggle cannot represent every effective authentication policy.
- [systemd-run, version 252](https://www.freedesktop.org/software/systemd/man/252/systemd-run.html):
  transient services/timers are a candidate scheduling primitive; independence
  from the desktop does not by itself establish durable reboot recovery.
- [Docker packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/):
  published container traffic can bypass UFW's usual filtering path. Show Docker
  publication separately and avoid asserting that UFW alone secures it.

## Implementation progress — 2026-11-01

The user requested step-by-step implementation after receiving this plan.
Phase 0 is authorized to proceed with the constraints above. Phase 1 now adds
neutral forest surfaces, mint actions without glow, brighter text, explicit
success/warning/info roles and shared typed configuration status/notice controls.
Quick Setup and SSH Access are available in the sidebar and command palette,
with honest uninspected states and links to existing tools. SSH Access separates
saved local connection settings from unknown effective server policy. Existing
Firewall inspections/review remain available; no new native action is enabled.

Read-only detection, real configuration selection, key generation/writes,
firewall transactions and recovery are subsequent phases. These scaffold pages
intentionally offer no simulated Inspect or Apply action. This increment does
not establish full application WCAG conformance: token contrast is checked, but
remaining legacy styles and native accessibility still require a broader audit.

Validation of this increment: `bun run check`, `bun run build`, Rust
`cargo check --locked`, and all 27 frontend unit tests pass. The 41-scenario
remote-workspace browser run passed 39 scenarios; two were interrupted by a Vite
full-page reload while this document was edited during the run. A subsequent
six-scenario targeted run passed both affected metrics tests plus overview,
palette, configuration/session-preservation and token contrast checks. Desktop
and 700px-wide scaffold screenshots were inspected. Contrast checks cover
semantic text on five core surfaces, primary action text, input boundary and
focus tokens; this is not a complete native/accessibility certification.
No server was contacted and no Rust mutation capability changed. Phase 2 typed
read-only configuration detection is next; native WebKit/OS accessibility review
and the remaining legacy-style audit remain outstanding.

## Read-only detection increment — 2026-11-01

The user requested committing the current work and implementing as much of this
plan as practical. Commit `4d6bae4` contains the planning, shared theme improvements,
persistent original-source themes and initial setup/SSH scaffolds.

Implemented the next read-only slice:

- One fixed native Python 3 probe over the current verified SSH connection,
  returning projected typed evidence for system, essentials, resources, security,
  Docker CLI, default SSH policy, UFW and listeners. No package index refresh,
  installation, configuration writes, sudo, helper or public listener.
- Native 30-second collection limit, 128 KiB response limit, strict section/field
  validation, three-second subprocess limits, one inspection per server and a
  current-connection check before accepting evidence. Runtime locking is released
  during collection so existing terminals/metrics can proceed.
- Connection generation IDs are now exposed with native statuses. A shared manual
  query cache scopes results by server/generation and survives page/Home navigation.
  No initial load, periodic probe or automatic retry. Reconnecting marks previous
  evidence stale; disconnection disables inspection and selection review.
- Quick Setup has per-category inspection states, expandable evidence, individual
  review selection and a server-bound evidence review. The review never claims
  to prepare or execute change commands; action planning remains later work.
- SSH Access shows saved profile settings separately from policy evidence and
  independent-key/privilege verification. Default `sshd -T -C` output is always
  partial: runtime flags, custom daemon configuration and Match Host are not
  certified. No private keys/authorized-key contents or authentication secrets
  are collected. No privilege escalation is attempted.
- Firewall has UFW status/defaults/rules, IPv4/IPv6 display, listening sockets and
  cloud/Docker limitations. Existing approved sudo UFW status reading remains
  available separately. Displayed rules are not deletion identities; firewall
  management stays gated.

This is a substantial Phase 2 read-only foundation, not completion of all Phase 2
or later acceptance criteria. Package ownership/update candidates, full daemon/
socket activation evidence, configured Fail2ban/update timers, account/key
inventory, detection-specific cancel UI, benchmarked overhead report and native
WebKit accessibility remain follow-ups. Docker workload detection continues to
use its existing workspace instead of duplicating engine queries here. No
change execution or recovery gate was enabled.

Command Code v1.84.0 was present. A bounded `cmd --yolo -p` code-writing attempt
with no session persistence failed before edits with authentication failure and
an instruction to run `cmd login`. No code in this increment was authored by
that CLI; implementation continued in Codex. Existing `.commandcode/` content
was left untouched and excluded from commits.

Validation for the read-only slice: check/build and strict all-target Rust Clippy
passed; all 34 frontend unit tests and 59 native tests passed (five opt-in
integration tests skipped in the ordinary native run). Seven local probe policy
cases cover permission failure, inactive defaults, bounded output, comments and
partial SSH evidence. The real disposable OpenSSH/native probe + existing PTY/
monitor integration passed; it is not a destructive VM or overhead certification.
The full 58-scenario browser run passed 57; one older assertion needed scoping
now that SSH Access has both policy and listener sections. Its targeted rerun,
plus configuration caching/failure/stale-connection and sudo-review regressions,
passed. Actual setup/firewall/narrow-layout screenshots were inspected. Rule
rows now preserve numeric order and include family and plain-English explanation;
resource values use readable units. There was no important-VPS contact.

## Expanded read-only evidence — 2026-11-01

Implemented the next detection slice using Command Code and independent Codex
review. Command Code authored the probe expansion and regression cases; Codex
reviewed its output, corrected identity binding, integrated the UI/native bridge
and validated the result. Bounded runs hit their turn limits, so the same saved
conversation was resumed rather than creating unrelated sessions. All Command
Code processes exited; no background CLI was left running.

Saved Command Code conversation: `vps-pilot-readonly-detection-20261101`, exact
resume ID `4425f033-7206-44a0-9785-a7a7c72a7435`. Follow
`agents/codex-use-cmd.md` for subsequent bounded work and independent review.

- Fixed-list dpkg package status/version and executable ownership evidence;
  other package managers remain unknown. Ownership queries reject wildcard
  paths without hiding detected executable presence.
- Cached update counts and cache timestamps only: no refresh or live candidate
  resolution. Missing, malformed, truncated and future-dated caches are qualified.
- Allowlisted systemd properties for SSH service/socket units, Fail2ban and
  unattended-upgrade scheduling. Unit activity does not prove which daemon
  accepted the current connection. No unit commands/environment are projected.
- Bounded local passwd/group account summaries, without NSS enumeration or
  password/GECOS/home projection. Group membership does not prove sudo access.
- Current authenticated account's standard authorized_keys fingerprints and
  restriction-presence metadata. Native profile identity is sent as bounded JSON
  on stdin and must match the remote UID and local passwd entry before home
  reads. Directory-descriptor traversal rejects symlinks in every home ancestor,
  .ssh and final file; only bounded regular files are read. Raw public blobs,
  comments and option values are omitted. Framing checks do not prove mathematical
  key validity or successful login; alternate AuthorizedKeysFile/Command sources
  are not inventoried. Default sshd policy evidence remains partial.
- SSH Access separates server policy, local users and public-key metadata;
  Quick Setup links to existing Software management. Inspection remains manual,
  connection-bound, cached in memory and never periodically refreshed.

Validation: 42 probe and four identity Python tests, 34 frontend unit tests,
59 native tests (five opt-in fixtures excluded), check/build and strict all-target
Clippy passed. Six targeted browser scenarios passed with installed Chrome,
including cache/stale-connection behavior, layout, public metadata separation and
sudo rejection. The initial browser launch failed because the expected bundled
browser was absent; no application assertions ran in that attempt. The real
loopback disposable OpenSSH/native integration passed, independently matching
the fixture public-key fingerprint while excluding its raw public blob. Its
configuration probe took about 303 ms in this fixture; this single measurement
is not a resource-budget or distribution compatibility certification. The
640px screenshot was inspected. No important-VPS contact or mutation gate change.

Still outstanding: actual update candidate resolution, complete daemon/runtime
policy discovery, detection cancellation UI, broader distro/overhead validation,
native WebKit accessibility and all later privileged planning/recovery gates.

## Disposable discovery benchmark — 2026-11-02

Committed the expanded detection increment and Command Code usage guide as
`698158a`. Implemented the next Phase 2 validation requirement: a reproducible
one-shot discovery overhead driver and checked-in scalar-only result. The
driver uses local rootless Podman, an existing immutable Debian fixture image,
no network/host mounts, a read-only root and bounded CPU/memory/processes. It
validates all eight evidence sections, never logs evidence values, and verifies
its unique ownership nonce before removing its guest. No package installs,
image pulls, important-VPS access or production gate changes.

Five warm-cache measured trials after one warmup took 82.60–82.95 ms each,
using 79.95–80.57 ms CPU per trial and up to 20,160 KiB maximum individual-process
RSS. Each projected response was 6,687 bytes, with three ready and five partial
sections. See `tests/fixtures/configuration-benchmark-results.json` for source
SHA256, image ID and per-trial measurements. RSS is not summed process-tree
peak; this guest lacks systemd PID 1 and an active SSH daemon. Transport,
desktop rendering, cold caches, broad distributions and representative service
loads remain unmeasured. No manual-discovery CPU budget was invented and the
existing lightweight monitoring budget is unchanged.

The real disposable benchmark completed and removed its guest. Additional checks
verified invalid trial rejection, existing report preservation and SIGTERM
cleanup after observing the owned container alive. Check/build, 34 frontend unit
tests, 46 probe/identity Python tests, Rust check/strict Clippy and 59 native
tests passed (five opt-in tests excluded). This increment changes fixture tools
and documentation; application probe/UI/native behavior is unchanged.

The resumed Command Code chat stalled without edits and was interrupted; exit
130 was confirmed before replacement. Codex implemented the driver. A fresh
bounded review named `vps-pilot-configuration-benchmark-review-20261102` completed
with exit 0 and identified cleanup/error-path concerns. Codex added ownership
type checks, bounded cleanup retries, distinct cleanup errors, streaming output
limits and child-reaping race handling. Eight local-only failure-path tests pass.
Actual reruns exposed Podman's default stop grace exceeding the cleanup timeout;
the owned guests were removed after nonce verification and cleanup now explicitly
uses zero stop grace. The final five-trial run and SIGTERM cleanup check passed;
no benchmark guests or Command Code processes remain. The host's 64 KiB capture
bound applies to scalar wrapper reports, separate from the guest's 128 KiB raw
evidence validation bound. No raw evidence is returned to the host.
README now includes an Appearance/configuration discovery test walkthrough.
Detection cancellation, broader daemon/distro coverage, native accessibility and
privileged transaction/recovery work remain outstanding.

## Inspection cancellation — 2026-11-02

Committed the missing desktop configuration-command permissions and a cross-file
IPC permission regression test as `007ad74`; the user confirmed inspection now
works. Implemented the next read-only slice: Cancel inspection on Quick Setup,
SSH Access and Firewall, plus cancellation through the existing Command console.

Native cancellation binds to profile, connection generation and a per-request
UUID. It prevents probe execution after canceled channel opening or interrupts
collection, closes only that SSH channel,
releases the per-server lease and checks cancellation again before publication.
Bounded, 60-second early-cancel records handle IPC scheduling races. Wrong or
delayed requests cannot cancel another active request/generation. This stops
collection; SSH channel closure is not a guarantee that an arbitrary remote
child immediately terminates. The fixed probe retains its existing deadlines.
Channel confirmation uses its existing network timeout rather than dropping a
pending russh open future, so a late-confirmed channel can be explicitly closed.

The frontend waits for cancellation acknowledgement and the inspection to settle;
it retains previous evidence, suppresses canceled errors in favor of an explicit
notice and discards late successful responses after an accepted cancellation.
Cancellation errors stay visible and permit retry; beginning another cancellation
clears the prior error. No automatic retry, reconnect, inspection or mutation was
introduced. Cached navigation and independent shells remain intact.

Command Code's fresh saved chat `vps-pilot-inspection-cancel-20261102` authored
the request-bound browser mocks and first two regression scenarios. It stopped
at the 12-turn limit (exit 8); Codex reviewed its edits, ran the tests independently
and added early-cancel/late-success cases and the cancellation-error reset fix.
The CLI process exited and was not left running.

Validation: 35 frontend unit tests, native check/strict Clippy and 63 native tests
passed (five opt-in integrations excluded). Six focused native cancellation/
parser/lease cases include a real in-process SSH transport with a held read,
request/connection rejection, channel-close observation, manual retry and a
shell that remains usable. The delayed-open transport regression confirms that
canceling before channel confirmation closes the resulting channel without an
exec request and leaves the shell usable. Seven browser scenarios passed, followed by a
four-scenario cancellation run including failure/retry, retained evidence,
early cancellation and late-success discard. Check/build and the real disposable
OpenSSH/probe/PTY/monitor integration also passed. No important-VPS contact or
mutation gate changes.

## Native readiness review foundation — 2026-11-02

User requested a Command Code first implementation workflow. Updated and
committed `agents/codex-use-cmd.md` as `8af868f`: Codex specifies/reviews/verifies;
Command Code writes the main backend, UI and tests, with bounded same-chat fixes
and candid fallback reporting. No promise of a particular cost reduction.

Implemented the first read-only slice toward Phase 3; this is not an executable
desired-state ChangePlan or recovery transaction:

- Every accepted inspection receives a native snapshot UUID and a bounded
  memory-only native cache entry, tied to profile revision and connection.
  Source evidence expires after five minutes. Publication checks cancellation
  under the same mutex as cancellation, so a canceled read cannot replace the
  previous cached snapshot. Failed reads leave previous evidence intact.
- Review accepts only snapshot/server/connection IDs and one to six unique
  allowlisted category IDs. It takes evidence from native memory, never from
  renderer-provided values. Live connection, current profile revision, source
  identity, age and in-flight inspections are checked natively.
- Native reviews expire after 120 seconds, are bounded to 100 memory entries,
  and never authorize execution. Rechecking preserves ID/expiry and rejects
  refreshed, expired or mismatched sources. Review/recheck opens no SSH channel
  and runs no command. Per-item fixed blockers distinguish incomplete evidence;
  even ready evidence remains blocked pending validated recovery prerequisites.
- Quick Setup presents source time, expiry, blockers and category next steps.
  Explicit retry creates a new review. Context/selection changes and closing a
  pending dialog discard late responses. The frontend also rejects unexpected
  executable or wrong-context replies. The dialog scrolls within the viewport
  and supports six categories at an 800×600 window. No reviews enter SQLite,
  localStorage or command output; existing shells and inspection cache survive.

Command Code authored the Rust implementation, React UI, model guards, native
tests and browser mocks/scenarios. Saved implementation chat:
`vps-pilot-native-review-20261102`. Initial backend/frontend runs reached finite
turn caps; their processes exited before explicit resumes. Codex independently
reviewed and returned specific cache-publication, permissions, stale-response,
expiry retry and dialog-size findings for Command Code to implement. A fresh
bounded `vps-pilot-review-polish-20261102` chat handles final common-blocker/copy
cleanup after the implementation chat became long. Codex wrote workflow/progress
documentation and performed independent validation rather than taking over the
feature implementation.

Independent validation before final presentation cleanup: check/build, all 37
frontend unit tests, strict all-target Rust Clippy and 72 native tests passed
(five opt-in integrations excluded from that native run). The real disposable
OpenSSH/probe/PTY/monitor integration also passed with native review/recheck,
unchanged expiry and forged identity rejection. Twenty browser scenarios passed,
including readiness reviews, expiry/retry/late responses, six-category keyboard/
viewport checks, appearance persistence and relevant Files/Docker/cancellation
regressions. Desktop and 800×600 screenshots were inspected. Browser tests use
a mocked bridge; native WebKit accessibility is not certified. No important-VPS
contact, new dependencies or mutation gate changes.

Final presentation cleanup deduplicates blockers shared by all categories and
keeps partial/unavailable-specific explanations beside their items. Product copy
uses inspection/review terms rather than implementation details. Command Code
authored these edits too; its finite polish run exited at its turn cap before
running browser checks. Codex independently reran check/build and all five new
readiness-review browser scenarios successfully, then inspected the updated
screenshots. All task-owned Command Code processes exited.

Remaining Phase 3 work: typed desired-state action plans, stronger action-specific
fresh preflight, shared mutation conflict locks, protected backups, minimal
journaling, independent rollback and disposable Debian/Ubuntu recovery tests.
No privileged workflow is enabled by this readiness review increment.

## Quick Setup and console redesign — authorized 2026-11-02

User approved the proposed visual cleanup and explicitly invoked the
`command-code` skill. The implementation scope is presentation and local console
preferences, with existing read-only/review/cancel policies intact:

- Compact category checklist with evidence summaries and honest detection labels;
  grouped detail evidence and related navigation in a right-side panel.
- One compact inspection header and read-only hint; selection actions appear
  only when categories are selected. Preserve unknown/truncated evidence and
  original source caveats in details.
- Concise readiness review metadata and category blockers; no newly enabled
  application/installation actions.
- Action-oriented command console, structured inspection summaries and closed
  technical details for exact commands/raw output. Keep monitoring separate and
  privileged command approval previews explicit.
- Pointer/keyboard panel resizing and per-server persistence of height/collapsed
  state only through the existing local document store. No commands, output,
  snapshots or credentials are persisted.

Command Code implementation session: `vps-pilot-clean-setup-console-20261102`.
Codex independently reviews real probe compatibility, disclosure/focus behavior,
native preference whitelists and navigation/cancellation regressions. Existing
server sessions and samplers must survive UI changes; opening details or changing
panel layout must not run any remote inspection.

Implemented and independently verified this redesign. Command Code wrote the
checklist, native-field summary helpers, grouped details panel, concise review,
readable/resizeable console, typed local preference adapter, SQLite validation
and tests. Codex wrote documentation, reviewed the implementation and returned
specific fixes for real probe field names, missing source caveats, package
grouping, summary column spacing and clamped-height resize dead zones.

Per-server console documents use `vps-pilot:command-console:v1:<UUID>` with only
version, expanded and height fields. Native validation rejects unknown fields,
invalid IDs, invalid types and heights outside 144–600; preference hydration
projects only those safe fields. Window shrink clamps visible height without
overwriting the preferred value; user pointer/keyboard resize starts at the
visible value. Only technical details are collapsed, not discarded. All
privileged approval previews and native execution gates remain unchanged.

Validation: check/build, all 43 frontend unit tests, Rust check/strict all-target
Clippy and 73 native tests passed (five opt-in integrations excluded). Native
tests include an actual SQLite reopen and strict console-document validation.
The full 59-scenario remote workspace browser run passed 58; one assertion
incorrectly expected collapsed command text to be absent from the DOM. Codex
made a trivial test integration correction to assert hidden-before/open-visible
behavior while retaining the exact command/output checks. Its rerun, plus both
new console scenarios, passed all three. Earlier focused layout/configuration
and console runs also passed. Screenshots at desktop/narrow widths were
inspected, including structured summary and six-category checklist. No native
WebKit certification or important-VPS contact is claimed.

Bounded Command Code runs stopped at turn caps where noted in their outputs;
useful edits were reviewed and the same named session was resumed for concrete
remaining work. Final resize fixes finished with exit 0. All task-owned CLI
processes exited; no implementation process was left idle. Changes remain in
the working tree for review; no commit was requested for this redesign.
