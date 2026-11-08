# Quick Setup — guided fresh VPS provisioning

Status: implementation authorized 2026-11-04 after the user reviewed this plan.
Plan and preceding interface work committed as `4a7e3b3`. Implement in dependency
order; production server changes remain subject to the capability-specific
recovery/validation gates below. Never test provisioning on the important VPS.

## Purpose and relationship to existing work

Replace the current Quick Setup checklist with a useful, resumable wizard that
takes a fresh VPS from initial root access to verified administrator key access,
a configured firewall, an optional application stack, and selected tools.
Keep the interface simple enough to complete without copying terminal commands.

This is the current product direction for Quick Setup. The older
`agents/quick-setup-plan.md` remains the record of existing inspection/review
infrastructure and its validation; its checklist is not the target experience.
Reuse that infrastructure and the existing SSH Access, Firewall, Software and
Docker capabilities rather than building competing executors. Follow
`agents/goal.md`; this plan does not override its approval or production gates.

Use the Command Code workflow in
`agents/codex-use-cmd.md` when implementation is requested: Codex specifies,
reviews and verifies; bounded Command Code runs write coherent implementation
slices. Preserve all existing uncommitted work.

## Agreed requirements

- Start with root SSH access, create a separate administrator with verified sudo
  access, then migrate to key-only SSH on a user-selected port.
- Make SSH key creation, selection, passphrases, storage and backup understandable
  inside the app. Never lose the working endpoint or silently replace a key.
- Configure UFW together with SSH so the replacement access is tested before
  removing existing access. Account for provider firewalls and IPv4/IPv6.
- Offer Dokploy, a JavaScript/PM2 stack, a container foundation for other stacks,
  or no application stack. Offer Docker/Podman where compatible.
- Offer optional developer tools, including Herdr and Neovim, with an optional
  LazyVim setup and a practical privileged-editing workflow.
- Offer Bun, NVM/Node, uv and a small curated set of useful optional tools.
- Use trusted official sources and stable versions. Neovim specifically uses
  the latest compatible stable official release, with an optional official
  LazyVim starter. Preserve existing editor configuration.
- Save non-secret progress across desktop restarts. Resume by reconciling actual
  remote state, never by automatically replaying an interrupted command.
- Keep everything accessible from Quick Setup, with progressive disclosure of
  commands and diagnostics rather than a page of configuration dumps.

## Wizard and interaction contract

| Step | Main decision | Completion evidence |
| --- | --- | --- |
| 1. Connect and inspect | Root credentials, host identity, supported OS | Verified host and bounded preflight |
| 2. Administrator | New/existing administrator and sudo behavior | Correct account ownership and verified privilege access |
| 3. SSH key | Existing key, agent key, or generate a key | Separate connection authenticates as the administrator with the selected key |
| 4. SSH and firewall | Target port, key-only policy, required ingress | Independent target connection, working sudo, recovery prerequisites and firewall checks |
| 5. Application stack | Dokploy, JavaScript/PM2, containers, or skip | Compatible dependency plan and port/storage review |
| 6. Developer tools | Editor and optional interactive utilities | Selected tools and configuration ownership verified |
| 7. Runtimes and utilities | Runtime versions and optional utilities | User-scoped installation and shell behavior verified |
| 8. Review and finish | Approve exact changes, run and verify | Per-step outcomes and saved final connection profile |

Steps 1–4 form a security checkpoint. They must support their own exact review,
execution and verification before application installation; the final step must
not misleadingly present earlier security changes as pending. Stack/tool steps
collect choices, then use the final installation review. Completed security
steps remain visible in the final summary.

- Use a step indicator, one clear primary action, short explanatory text and a
  compact summary of prior choices. Back navigation preserves draft choices.
- Distinguish planned, inspecting, awaiting approval, running, verified, skipped,
  blocked, failed and outcome-unknown states. Detection is not verification.
- Existing servers receive an adapt/skip path, never a forced fresh install.
  Existing workloads, keys, users and configuration are protected by default.
- Show target identity at every risky review. Shared themed controls, keyboard
  navigation, focus restoration, readable narrow layouts and all existing themes
  are acceptance requirements.
- Keep exact non-secret commands and raw diagnostics under Technical details;
  retain explicit sudo approval previews. Every app-triggered sudo command
  retains its individual approval requirement from `goal.md`.
- Closing the wizard or switching tabs does not destroy the working connection.
  Closing the app must not defeat an armed remote recovery mechanism.
- Cancel stops future actions. It does not imply completed changes were undone.
  Never offer a misleading universal rollback for installed application data.

## Secure access transaction

Implement this as a native, typed transaction rather than renderer-generated
shell commands. Keep a working connection and the old saved endpoint until the
replacement path has been independently proved.

1. Verify the initial host fingerprint; inspect OS, SSH daemon/service/socket
   activation, effective account-specific policy, listeners, UFW/backend state,
   existing accounts and competing configuration. Unknown evidence blocks risky
   changes. Confirm provider console/rescue availability and describe limitations.
2. Create or explicitly adopt the selected administrator. Validate the username,
   home ownership and sudo policy; validate sudoers before committing changes.
   Do not assume a group membership proves privilege access. Keep SSH password
   authentication separate from the account password used for sudo.
3. Generate or select a key locally. Before generation, settle secure durable
   storage, passphrase and recovery/backup choices. Install only the public key
   with correct ownership and permissions; append without replacing other keys.
4. Open an independent candidate SSH connection as that administrator. Disable
   authentication fallback for this test and record proof of the selected public
   key authentication method and host identity. Verify sudo through that path.
5. Review exact changes and protected backup identities. Arm and verify a remote
   timed recovery mechanism before risky SSH/UFW edits. It must survive desktop
   exit and transport loss; an app timer alone is insufficient. Refuse execution
   when reliable recovery cannot be established for the supported environment.
6. Add firewall allowance for the target SSH port before enabling restrictive
   policy. Check collisions and relevant address families. Require the user to
   confirm necessary provider firewall changes; app-side UFW cannot make those.
7. Temporarily retain the old SSH listener/access allowance while introducing
   the target port. Validate SSH configuration before the appropriate reload;
   handle socket activation explicitly rather than assuming a service reload.
8. Verify a new independent connection on the target port, selected key and new
   account, including sudo. An existing SSH channel or listening socket does not
   prove a fresh connection works. Preserve host trust across the port change
   only through verified same-server identity, never blanket host-key acceptance.
9. Apply key-only policy, and review any root-login restriction as an explicit
   choice. Reconnect again after the restrictive policy and final UFW state.
   Retire old listeners/rules only after replacement access succeeds; verify
   once more after cleanup before disarming recovery.
10. Atomically promote the verified endpoint/profile and record completion.
    Retain bounded old/new endpoint metadata and backup references for recovery.
    Handle profile persistence failure explicitly; never discard the verified
    connection just because a local write failed.

The wizard may suggest a valid unused high port, including 50,000–60,000+, but
must validate 1–65535, conflicts and OS ephemeral-port implications. A high port
is a preference, not proof of security. Do not remove arbitrary pre-existing
firewall rules or promise that Docker-published ports obey UFW ingress policy.

Recovery restores only transaction-owned changes and verifies configuration
identity before overwriting anything changed externally. Define handling of
reboot, expired recovery deadlines, concurrent administrators and app restarts.
If the result is uncertain, stop, reconcile and show recovery guidance; do not
retry mutations automatically. Never guarantee immunity to provider/network
failures or a missing out-of-band recovery channel.

## Local keys and durable state

- Private keys remain local in an explicitly selected protected key file or a
  supported secure storage mechanism. Do not store key contents, passwords,
  passphrases, command output or credentials in SQLite, logs or CLI prompts.
- Public fingerprints and opaque key references can identify saved keys.
  Passphrases/passwords are transient unless separately authorized OS credential
  storage is available. Explain that losing a passphrase may make a key unusable.
- Export/backup is user initiated, destination reviewed, with overwrite
  protection and appropriate permissions. Do not force cloud upload or force
  an unencrypted backup. Losing a backup must not erase the primary key.
- Existing agent keys may be usable without being exportable; explain agent
  availability and recovery implications. Never claim the app backed them up.
- Use explicit versioned native SQLite schemas/validation for drafts and the
  minimal operation journal: server identity, choices, step status, endpoint
  candidates, installed version/source metadata and recovery references.
- Security reviews/approvals remain short-lived and memory-only. Persisting
  progress never persists authorization. On resume, re-inspect and reapprove;
  never trust a stale success badge or execute directly from a saved draft.

## Application stack choices

| Choice | Desired behavior and limits |
| --- | --- |
| Dokploy | Official documented Docker + Dokploy installation path, presented as one guided operation with visible substeps. Docker required; do not offer Podman as a substitute. Review orchestration, storage and required public ports. |
| JavaScript / PM2 | Node through NVM, PM2, optional Bun, optional Docker or Podman. Define user, boot persistence and service environment; installing NVM in an interactive shell alone is insufficient. |
| Other stacks / containers | Docker or Podman foundation only initially. Do not claim application-language provisioning beyond the implemented catalog. |
| Skip | Complete secure base access without an application platform. |

Detect and block incompatible existing engines, orchestration/proxy ownership,
occupied ports and unsupported distributions. Never replace an existing engine,
join/create a cluster, open a dashboard broadly or adopt existing data silently.
Resolve stack-required runtimes/tools into one dependency plan; do not reinstall
the same dependency through different catalog entries. Verify Docker/Podman
network exposure separately from UFW, including IPv6 where enabled.

## Optional developer tools and runtimes

Initial candidate catalog, subject to source/support validation before shipping:

- Editor: Neovim only, or Neovim + LazyVim. Resolve the latest compatible stable
  official Neovim build for the OS/architecture. Show prerequisites and preserve
  existing Neovim configuration/data with an explicit backup/adoption decision.
  Use the official LazyVim starter at a recorded revision; do not describe a
  moving branch or its plugin graph as a versioned stable release.
- Privileged editing: prefer `sudoedit` with the user's editor/configuration.
  Validate editor invocation and dependencies; do not broadly preserve the
  entire environment through sudo, share root-owned plugin caches or install
  user plugins as root to make the editor appear to work.
- Multiplexer: Herdr as requested. Existing `agents/plan.md` already records the
  user-confirmed source, https://herdr.dev/docs/install/ (now redirects to
  https://herdr.dev/tui/docs/install/). Its official documentation describes
  stable-channel Linux releases. Validate exact artifact integrity and supported
  systems before enabling installation. Tmux can be an optional separate choice.
- Utilities: Git, curl, ripgrep, fd, fzf, jq, btop and unzip as a small initial
  shortlist. Distinguish dependencies from user-selected optional tools.
- Runtimes: Bun, NVM + Node, uv/Python tooling. Offer supported stable/LTS
  choices where the project provides them, explain the default, and pin the
  resolved version for the reviewed operation. No nightly/pre-release defaults.
- Install user tools for the selected administrator, with correct ownership
  and bounded shell integration. Verify a fresh login shell and noninteractive
  service use separately. Do not promise that NVM/Bun PATH applies to sudo.

## Trusted installation source policy

Before implementing an installer, consult current primary project documentation
and record its official source, supported OS/architectures, dependencies,
privilege needs, version resolution, verification method and uninstall limits.
This planning document does not certify current URLs, latest versions or commands.

- Allow only official project distributions/documented repositories or supported
  distribution repositories. Clearly label distro stable packages, which may
  differ from upstream latest stable. Neovim's requested upstream release route
  must not silently fall back to an older distro build.
- Fetch over validated TLS from allowlisted official locations; account for
  documented release/CDN redirects without allowing arbitrary source injection.
- Resolve versions once for review, record artifact identity/digest and recheck
  before execution. A new upstream release requires a refreshed plan, not a
  silent switch from the version the user reviewed.
- Verify official signatures/checksums when published. Disclose absent publisher
  verification; a locally computed digest alone does not prove authenticity.
- Treat upstream installer scripts as reviewed installation artifacts: download,
  inspect/validate the supported revision and integrity, then execute only after
  explicit preview. Never blindly pipe a changing remote script into root shell.
- Account for transitive sources: LazyVim plugins, language tooling and package
  managers fetch more than the first official installer. Pin and document the
  supported dependency path; block undocumented third-party bootstrap sources.
- If the project has no stable releases or a verifiable supported route, show
  the limitation and block/omit the installer until an explicit policy decision.
  Do not silently substitute a community binary or unofficial install script.

## Implementation phases and acceptance gates

1. **Specification and UX shell.** Map the existing components/native contracts;
   build wizard drafts, step navigation, empty/existing-server states and source
   catalog types. No remote writes. Review real desktop/narrow screenshots.
2. **Keys and administrator foundation.** Implement local key lifecycle, secure
   storage references, account/sudo adapter, independent candidate connections
   and strict authentication proof. Validate in disposable SSH fixtures before
   enabling the corresponding narrow native capabilities.
3. **Recovery and SSH/UFW migration.** Implement protected backups, native conflict
   locks, exact action reviews, minimal journaling and independently scheduled
   rollback. Exercise actual network reachability and failure recovery on
   disposable Debian/Ubuntu VMs before enabling any production access changes.
4. **Trusted installer foundation and application stacks.** Implement resolved
   source manifests, dependencies, preflight, operation-specific approvals and
   post-install verification. Add Docker/Dokploy and Node/PM2 paths, then Podman
   where validated. Preserve existing dedicated Docker/SFTP safety boundaries.
5. **Optional catalog.** Add official Neovim/LazyVim, Herdr, utilities,
   Bun, NVM/Node and uv with per-tool compatibility/verification tests. Unsupported
   combinations remain visibly unavailable rather than optimistic installs.
6. **Resume, recovery and release validation.** Reconcile app crashes, transport
   loss and remote reboot; complete first-run UX, diagnostics and documentation.
   Update `agents/supported-systems.md` per capability and tested architecture;
   never infer provisioning support from SSH terminal support alone.

Each phase is independently reviewable. Do not enable all system mutations to
ship one adapter. Exact native preconditions, fresh approval, bounded output,
per-server serialization and secret redaction are mandatory throughout.

## Validation and definition of done

- After implementation changes run `bun run check`, `bun run build`, appropriate
  frontend/browser tests and relevant Rust check/test/strict Clippy checks.
- Use disposable full VMs for UFW and SSH recovery; containers or mocked browser
  tests alone do not certify firewall reachability, boot or socket activation.
  Never provision, stress-test or deliberately break the user's important VPS.
- Cover wrong key/passphrase, missing key file/agent, changed host identity,
  failed sudo, occupied port, provider firewall blockage, IPv6, UFW enablement,
  socket-activated SSH, invalid config and recovery scheduler failure.
- Cover disconnect/crash at every access-transition boundary, rollback while the
  desktop is closed, local persistence failure, stale/replayed reviews, concurrent
  remote edits and cancellation before/after an irreversible install step.
- Cover checksum mismatch, source redirect/version changes, unsupported CPU/OS,
  installer partial failure, existing config and fresh-shell/service PATH.
- Verify key permissions and redaction, reboot persistence where required,
  resumed progress, final key-only login on the target port and working sudo.
- Verify wizard accessibility, themes, narrow layouts, truthful progress and
  session survival across Home/Settings/server navigation. No duplicate probes,
  new background scans or accidental command replay.
- Finish with a concise saved connection summary, installed versions/sources,
  unresolved manual provider tasks and recovery/backup references. Never claim
  success until independent access and the selected installation checks pass.

## Open decisions to settle during specification

- Herdr source identity is resolved from the prior user-confirmed project link;
  exact stable artifact/version/integrity resolution still needs implementation.
- Define the first supported provisioning OS/version/architecture matrix from
  actual VM coverage, not the older inspection matrix.
- Choose generated-key storage/export UX and cross-platform credential support.
- Choose the default root-login restriction, initial high-port suggestion and
  how provider-console recovery readiness is captured.
- Verify official Dokploy installation/version behavior and whether it can meet
  the resolved-artifact policy without an undocumented installer fork.
- Define LazyVim plugin revision/update policy and installation support where
  an upstream tool has no versioned stable artifacts.

These questions do not block this plan. Resolve them before dependent installers
or access-changing capabilities are implemented or enabled.

## Implementation record — 2026-11-04

- Baseline commit `4a7e3b3` includes the preceding console/checklist refinement
  and this provisioning plan. Local `.commandcode/` and Python cache directories
  were excluded from the commit and remain untouched.
- Primary implementation conversation: `vps-pilot-guided-setup-20261104`.
  First bounded run stopped at its 45-turn limit with partial wizard/model and
  native draft-validation work. It was resumed in the same conversation for
  concrete review findings, browser integration and verification.
- Codex found malformed/oversized draft preservation gaps, required-runtime
  presentation issues and overly technical product copy during review; these
  were returned to Command Code for correction before accepting the increment.
- Herdr identity was already recorded in `agents/plan.md`; the official install
  documentation was checked at https://herdr.dev/tui/docs/install/.
  Source identity is resolved, not artifact integrity or installer certification.

No production provisioning capability is enabled by an interface-only increment.
Record actual verification results and remaining phase gates here as work lands.

Phase 1 delivered the eight-step draft wizard as the default Quick Setup view,
with explicit access to the existing server inspection. Choices persist per
server in strictly validated non-secret documents. Invalid stored drafts stay
untouched and display an explicit reset path, including malformed/empty/oversized
and future-version legacy records. Dokploy requires Docker; JavaScript requires
NVM/Node; LazyVim contributes deduplicated Git/ripgrep/fd dependencies. Herdr is
selectable for planning but no installer is enabled. Invalid username/port fields
block forward navigation. All step states remain planned/unverified.

Independent verification: 53 frontend tests, build/check, Rust formatting and
strict all-target Clippy passed. Native suite passed 76 tests with five opt-in
fixtures excluded; the final stricter missing-engine contract regression also
passed. Seventeen focused browser regressions passed, followed by both invalid
draft and legacy hydration cases. Browser validation uses a mocked native bridge;
it is not production provisioning or native WebKit certification.

Phase 2 local-key slice uses a separate bounded Command Code conversation,
`vps-pilot-setup-local-keys-20261104`. It adds real Ed25519 generation and
passphrase encryption through the existing SSH cryptography library, protected
Unix app-owned key files, restart discovery and explicit native-dialog encrypted
backup export. Only an optional opaque generated key ID enters a server draft;
legacy drafts lacking it remain valid. There is no key deletion, overwrite,
public-key installation, agent import or login verification in this slice.
Windows generation is explicitly unavailable pending native ACL implementation.

Codex returned worker-lifetime generation locking, atomic backup publication,
directory-sync error handling, ownership/mode validation, React StrictMode and
cross-operation UI races to Command Code for repair. The CLI authored these
repairs and the meaningful native/browser regressions. Bounded runs reached
their turn limits and exited before exact named resumes. Codex directly made
two small integration repairs: matching native/frontend rejection of explicit
null key IDs and clearer selected-choice indicators/header wording. No new
package was introduced; existing rand moved from test-only to production
dependencies, with the lockfile unchanged.

Remaining implementation: administrator creation/adoption and sudo verification;
existing-file/agent key selection and server-side public-key installation;
independent candidate connections with strict key-auth proof; reviewed SSH/UFW
transactions, backups, journals and autonomous remote rollback; resolved trusted
installer manifests and stack/tool installation adapters; full disposable-VM
recovery validation. The wizard and local key vault do not make a fresh VPS
provisioning workflow complete. All server-changing setup gates remain closed.

Final independent key-slice verification: check/build, Rust format/check/strict
all-target Clippy, 54 frontend tests and 84 native tests passed (five opt-in
server fixtures excluded). Native tests use actual temporary encrypted keys,
correct/wrong passphrases, protected files, restart listing, backup no-overwrite
and an aborted caller while the worker continues. Browser tests exercise
StrictMode, transient secrets, selection persistence, busy operations, backup
success/cancel/failure and discovery after leaving a pending generation.

The full 64-scenario remote workspace browser run passed 63; the existing
resource-tooltip case intermittently failed to show its CPU tooltip. Without
changing that test or its implementation, it passed twice in isolation alongside
both new key-flow scenarios (six successful reruns). This is not a claim of one
clean 64/64 run. Desktop/narrow screenshots were inspected. Codex also disabled
creation when the vault listing is unavailable, with a focused browser check.
No important-VPS contact, server mutation or native WebKit certification occurred.
All task-owned Command Code processes exited; saved chats do not need idle CLIs.

## Visual refinement — 2026-11-05

The user rejected the first wizard presentation as cluttered and asked for a
clean interface understandable at a glance. This refinement is presentation
work within the existing implemented feature boundaries:

- Quiet desktop step rail and compact mobile step picker, with one focused form.
- Plain selectable rows, concise descriptions and a compact engine selector.
- No permanent draft-summary card, per-step status pills or repeated warnings.
- Grouped final review; source details and storage paths are disclosed on demand.
- Selected key and backup are the default post-generation view; another-key
  creation and other stored keys are explicit disclosures.
- Existing validation, draft persistence, unavailable execution, secret clearing,
  mutation gates and pending-operation handling remain mandatory.

Command Code conversation: `vps-pilot-setup-ui-refinement-20261105`. Codex reviews
actual desktop/mobile screenshots and independently verifies the relevant flows.
This increment does not change palettes, native permissions, crypto, draft
schemas or provisioning gates. No commit was requested for this refinement.

Implemented through bounded same-chat Command Code runs, with concrete
screenshot findings returned for a second pass: shorter copy, flat active-step
marker, inline engine choice, two-column utilities on wide screens, compact
selected-key default and clearer radio indicators. Mobile selection returns
keyboard focus to its trigger. Codex directly scoped form/heading/disclosure IDs
per mounted workspace and added a two-server label/focus/isolation regression.
Busy-state tests still cover choosing another stored key during held exports;
the new disclosures do not weaken secret/persistence/cancellation checks.

Independent verification: `bun run check`, `bun run build`, all 54 frontend unit
tests and `cargo check --locked` passed. All six focused browser scenarios passed,
covering the wizard, invalid/legacy draft preservation, key creation/backups and
existing inspection/navigation with retained shells. Actual desktop, 800px and
430px layouts were checked, and desktop/narrow screenshots inspected. No native
code or permission changed; native WebKit accessibility is not newly certified.
All three task-owned CLI runs reached their finite caps and exited; useful work
was reviewed and resumed by exact session name. No idle CLI process remains.

## Standard SSH workflow and in-app completion — 2026-11-05

The user clarified the original requirement: keys belong in `~/.ssh`, with a
matching public file and a reviewed entry in `~/.ssh/config`. Routine VPS
management must be completable inside VPS Pilot, including prompts and recovery;
an external Linux terminal must not be a required final step. The existing
app-owned vault was an implementation increment, not the intended final key
location. This requirement supersedes that location for newly generated keys.

- New encrypted key pairs use app-owned, collision-resistant filenames in the
  standard SSH directory; existing user keys are neither enumerated as app-owned
  nor overwritten. Keep secure permissions and private material out of SQLite.
- Existing app-vault keys remain discoverable. Explicit copying into `~/.ssh`
  preserves the old key, fingerprint, key ID and any existing profile references.
  Never silently move/delete keys or overwrite a conflicting destination.
- Before treating a target user/port/key as usable, test it through a separate
  connection with the trusted server identity and exactly the selected key.
  No password/agent/default-key/none fallback can count as this proof.
- A local config export must use the verified target and trusted key reference,
  show the exact app-owned entry for approval, preserve unrelated file bytes,
  detect alias/source conflicts and keep a protected backup. Normal profile
  saving still does not implicitly edit the local SSH config.
- Preserve the original working SSH connection throughout verification. Local
  export is not server hardening, public-key installation or an SSH/UFW migration.
- Initial adapters may block unsupported conditional/include configurations
  rather than risk changing their behavior. Explain the limitation in the app;
  do not claim a completed workflow or require an external terminal workaround.

Primary implementation conversation: `vps-pilot-standard-ssh-20261105`. Tests
must inject temporary homes and SSH directories; never inspect credentials or
write the developer's real SSH directory/config as part of implementation tests.

Standard key storage is implemented by Command Code. New files use
`~/.ssh/vps-pilot_<UUID>` plus `.pub`; legacy copying retains the original key and
ID. Root ownership/modes, symlinks, unrelated files, matching public sidecars,
bounded scans, ciphertext conflicts and partially published keys are covered.
Codex reviewed the native changes, finished browser-fixture integration and added
the explicit copy/failure/no-automatic-migration scenario. An older native test
still expected fallback on a conflicting ID; its assertion was corrected to
require refusal while preserving the legacy key's visible metadata.

Independent storage-slice checks: build/check, all 54 frontend tests and strict
all-target Clippy passed. The corrected combined native suite passed 99 cases
with five opt-in server fixtures excluded before the config adapter. Three
key-flow browser cases passed, including legacy copy on explicit request and
saved-reference preservation. No real-home or VPS writes.

Config/proof implementation uses a new bounded conversation,
`vps-pilot-verified-ssh-config-20261105`, because the native trust/approval boundary
differs from file storage. The original working SSH connection must stay intact.
OpenSSH configuration semantics reference: https://man.openbsd.org/ssh_config
(consulted 2026-11-05); preserve first-value precedence and global directive scope.

The native proof/config adapter is implemented. Proofs use a separate connection
with the exact selected key, pinned source identity and desired account/port.
Memory-only proofs and single-use reviews expire after at most 120 seconds and
bind source profile/revision/connection, key fingerprint/ciphertext/location and
target. Config export requires a matching protected standard `.pub` sidecar.
Native preview excludes existing config contents. Writes preserve unrelated
bytes, validate app-owned block schemas, reject alias collisions and unsupported
Include/Match/ambiguous syntax, retain private backups and use a cross-process
file lock plus source checks and staged publication. Arbitrary editors do not
participate in that advisory lock; do not claim absolute exclusion of them.

Independent native validation after review fixes: `cargo check`, strict
all-target Clippy and the full suite passed: **115 passed, 5 ignored**. Loopback
fixtures cover separate account/port, wrong key/passphrase/host identity, source
session survival, expiry/context/tampering and config backup/preservation,
collision/stale/reject/replay/public-sidecar cases. Codex completed the small
indented-marker guard left unfinished at the CLI turn cap and tightened inherited
host-trust checks, with a regression test. No actual user home or VPS was used.

Frontend implementation conversation: `vps-pilot-ssh-access-ui-20261105`, with
the native contract handed off explicitly to keep the UI task focused. Account
creation, public-key installation, SSH/UFW migration and installer/recovery
adapters remain unavailable; neither local config export nor key-login proof
completes those security checkpoints.

The frontend flow is implemented under the selected standard key: explicit
passphrase unlock, separate key-login verification, native config preview,
cancel/reject and explicit save. Proofs/reviews never enter saved drafts. Key
operations and access operations exclude each other; context changes invalidate
late replies, expiry blocks saving, and an approved save is not advertised as
canceled. A successful save refreshes SSH-config discovery without replacing the
source profile or disconnecting it. Legacy keys require explicit standard copy.

Final independent checks: `bun run check`, `bun run build`, all **54** frontend
unit tests, Rust check/strict Clippy/full **115 passed, 5 ignored** native suite,
and **12** focused browser scenarios passed. Desktop and 430px screenshots were
reviewed, including the full save dialog. Codex completed a targeted expiry-test
repair after repeated timing assumptions failed: a clock jump and click in one
browser task exercises the handler guard before its timer, asserts rejection and
zero save RPCs, and does not force-enable controls. Command Code wrote the main
feature/backend/UI and tests; all bounded CLI runs have exited. Tests never used
the actual SSH directory/config, user agent or important VPS. No commit made in
this slice; the user's preceding UI refinement remains in the working tree.

## Administrator, firewall and source visibility — 2026-11-05

The user requested visible new/existing administrator password controls, an
explanation of all three SSH-key strategies, UFW rules, per-package installation
sources and additional useful developer tools. Keep this increment within the
existing draft/preview milestone: do not imply that account creation, password
verification, public-key installation, firewall changes or package installers
execute today. Never test these against the important VPS.

- New-account password/confirmation and existing-account sudo-password controls
  are transient preparation only. Explain their purpose and current execution
  limit. Never reset an existing password or save any secret in a draft, native
  database, history or IPC. Clear on account/mode/step/server changes and reset.
- Show a proposed UFW allow table with protected current/target SSH TCP ports,
  explicit HTTP/HTTPS choices and bounded custom TCP/UDP ports. Preserve older
  drafts when adding optional rule fields; enforce identical strict validation
  in TypeScript and Rust. Keep-current means no proposed UFW changes. A plan is
  neither live UFW state nor provider/IPv6/Docker firewall verification.
- Every application/engine/editor/utility/runtime needs a reachable planned
  source disclosure, with official documentation and the intended channel.
  Resolved-item selection reasons are not installation sources. Official pages
  were checked on 2026-11-05; runtime versions/checksums/downloads still need
  verification when executable adapters are implemented. Distinguish signed
  distribution packages from latest upstream stable releases. Preserve the
  Neovim official stable-release and LazyVim starter requirements.
- Add optional tmux, bat, eza, rsync and direnv; leave them unselected by default.
  Do not auto-authorize direnv or edit shell startup files in this increment.

Official references include [Dokploy installation](https://docs.dokploy.com/docs/core/installation),
[Docker installation](https://docs.docker.com/engine/install/),
[Docker/UFW interaction](https://docs.docker.com/engine/network/packet-filtering-firewalls/#docker-and-ufw),
[Ubuntu firewall guidance](https://ubuntu.com/server/docs/how-to/security/firewalls/),
[Neovim releases](https://github.com/neovim/neovim/releases),
[LazyVim installation](https://www.lazyvim.org/installation), and the
user-confirmed [Herdr TUI installation](https://herdr.dev/tui/docs/install/).
Do not substitute a different project named Herdr.

Command Code implementation conversation: `vps-pilot-setup-details-20261105`.
Preserve the preceding uncommitted SSH/storage/UI work; no commit is requested.

Implemented: optional transient new-account password/confirmation and existing
sudo-password fields; clearing across invalid username edits, mode/step/reset,
connection and visibility changes (including kept-mounted server tabs, Home and
Settings); compact SSH strategy explanations; protected current/target SSH rule
previews, HTTP/HTTPS and 16 bounded custom TCP/UDP rules; per-option source
disclosures and resolved-source summary; optional tmux/bat/eza/rsync/direnv.
Older v1 drafts remain valid, with absent rule fields defaulting safely. Secrets
are not sent or stored. Firewall and package choices persist; actual account,
UFW and installer execution remains unavailable.

Independent final checks: `bun run check` (zero warnings), `bun run build`, all
**58** frontend unit tests, **11** native database tests, `cargo check`, strict
all-target Clippy and **15** relevant browser scenarios passed. Existing SSH key
generation, copy, proof, config review, expiry and delayed-reply regressions are
included. Desktop and 430px screenshots reviewed. No real home/VPS/agent access,
dependency changes, commits or idle Command Code processes. The broader native
suite was not repeated for this draft/UI increment; prior SSH-native validation
is recorded above.

Command Code wrote the primary model/catalog/UI/native validation and tests.
Codex specified and reviewed, added the missed LazyVim source mapping/assertion,
completed small lint/copy/screenshot repairs, and independently verified. The
JavaScript/PM2 source mapping and compact source-row layout were returned to the
same CLI chat for correction; the original Next-in-viewport assertion passed
without being removed or weakened. Existing uncommitted work remains intact.

## Named keys, existing-key selection and runtime cards — 2026-11-05

The user requested implementation after committing the previous work as
`8794d9b` (native SSH keys/config) and `147a8b1` (Quick Setup UI/details).

- Existing-key strategy must offer an actual native file picker. Preserve the
  original private/public files; persist only a native-owned opaque reference
  and public identity metadata. Revalidate it after restart and before use.
- New keys accept an explicit basename under `~/.ssh` and an optional passphrase.
  Empty means an unencrypted private file; nonempty uses encryption. This is the
  user's explicit update to the earlier encrypted-only policy. Protection and
  backup labels must reflect the actual file. No extra approval flow is needed.
- Filename availability checks cover both `name` and `name.pub`, including
  directories and dangling symlinks, without creating directories on input.
  Report conflicts beneath the filename field and disable creation until the
  latest name is checked. Native creation independently rechecks and publishes
  without overwriting, even if a file appears after the UI check. Preserve any
  partially published private key with a recoverable native reference.
- Keep existing UUID/legacy keys and opaque draft IDs compatible. Named and
  user-selected files need bounded, protected reference metadata, surviving app
  restarts without moving/renaming user keys. No secrets in those records.
- Selected/named/unencrypted keys must work with the independent exact-key login
  proof and reviewed config export; do not leave a picker that only stores an
  unusable path. Config identity paths are generated from native references,
  safely quoted and revalidated; renderer paths/text are never trusted.
- Remove all Source controls from Application stack. Runtime choices become
  grouped selectable cards: JavaScript/TypeScript (Bun, Node.js through NVM),
  Python (uv, Python) and Go. Preserve existing choices and PM2's Node requirement.
- Final Review displays selected package sources directly in a tidy summary.
  Show exact commands only when an implemented native preflight produces them;
  unavailable installers must not be represented by invented final commands.

New Python and Go source references checked on 2026-11-05:
[Python on Unix](https://docs.python.org/3/using/unix.html) and
[official Go installation](https://go.dev/doc/install). Python can use supported
distribution-maintained stable packages; do not overwrite system Python or imply
that a distribution version is latest upstream. No installers execute here.

Native key implementation conversation:
`vps-pilot-named-existing-keys-20261105`. Test only temporary homes and explicit
loopback fixtures; never inspect the actual user's keys, agent or important VPS.

Implementation and verification completed for this scope:

- Native filename checks and no-clobber publication cover both private/public
  names. Named and selected keys persist through protected opaque references;
  existing files retain their bytes and permissions. Plaintext keys use direct
  exact-key verification; encrypted keys retain the transient unlock dialog.
- Existing key selection, optional passphrases, language runtime cards and
  directly visible final source summaries are implemented. Server provisioning
  adapters remain pending; no account/firewall/installer execution was enabled.
- Command Code wrote the primary implementation in the native conversation above,
  `vps-pilot-key-picker-ui-20261105` and `vps-pilot-runtime-review-20261105`.
  Codex reviewed integration and independently verified it, with a small Rust
  comparison/lint repair and browser timing/screenshot repairs. All CLI runs
  terminated; saved conversations require no idle process.
- `bun run check`, `bun run build`, and `bun test src`: passed (61 unit tests).
  Native suite: 133 passed, 5 intentionally ignored; formatting, cargo check,
  strict all-target Clippy passed. Two loopback named/external-key login/config
  tests also passed after the lint repair. Browser coverage includes 19 relevant
  scenarios; the single asynchronous error-locator timing failure was repaired
  and its focused rerun passed without weakening the collision assertions.
- Native tests used temporary homes and loopback fixtures; browser tests used
  mocked IPC. No actual user keys, agent, SSH config or important VPS was touched.

## Current connection verification and durable save feedback — 2026-11-06

Authorized correction: the SSH key step tests the selected key on the currently
connected profile account and port, not the planned administrator/port. Clearly
separate actual proof from planned access. Explain public-key installation is a
prerequisite; keep future-access verification disabled until provisioning exists.
Retain exact native proof/review bindings, original session and expiry guards.

Expose per-VPS document save status and retry. Keep current pending choices on
failure; serialize writes and ignore stale acknowledgments for newer values.
Persist valid choices and current step promptly to existing SQLite documents;
never persist temporary secrets or fabricate success. Verify per-server isolation,
rapid edits, failure/retry, navigation and restart hydration with mocked IPC.

Command Code implementation conversation:
`vps-pilot-current-access-draft-saving-20261106`.

Implemented and verified for this increment:

- Key tests now use the connected profile account/port and show planned access
  separately with verification disabled. Native proof and config review still
  bind the exact independently tested target. Rejection explains public-key
  installation is a prerequisite and does not pretend to confirm a diagnosis.
  This increment does not install public keys, create accounts or harden SSH/UFW.
- Immediate per-document writes expose saving/saved/error state, retain failed
  latest values for retry, ignore stale acknowledgments and hydrate saved state.
  Document recovery clears only the corresponding persistence warning after all
  failed documents recover. Temporary passwords/passphrases remain unsaved.
- Command Code wrote implementation and regression coverage. Codex specified and
  independently reviewed/verified it, with small product-copy and recovery-banner
  integration repairs. No VPS or actual user SSH files/agent were contacted.
- Validation: bun check/build and 67 src unit tests passed; all 23 relevant browser
  scenarios passed, including current tester:22 vs planned deploy:52022, rejection,
  held writes, retry, server isolation, reload, proof expiry and stale reviews.
  Focused recovery cases were rerun after banner fixes. Native cargo check and
  formatting passed; no native behavior changed in this increment.

## Reviewed current-account public-key installation — 2026-11-06

Implement native read-only preparation, explicit review/confirm, single-use
application and rejection. Only the selected public key and current source
account may be used; no renderer-supplied paths/commands/key text. Preserve
existing authorization bytes/options, reject duplicate-key escalation, detect
stale remote files and unsafe paths, create protected backups, keep current
session/password/port/UFW unchanged. Follow installation with independent exact-key
verification; retain honest failure and uncertain-result feedback. Test real file
operations only in temporary homes and loopback fixtures. Broader provisioning
adapters remain pending. Named implementation chat:
`vps-pilot-public-key-install-20261106`.

Implementation verified for the public-key installation/sidebar increment:

- Native review/apply/reject IPC resolves the selected public header locally,
  derives the current account from the active profile and remote passwd record,
  and runs the bounded native helper on that existing authenticated channel.
  No private key or passphrase is uploaded. Reviews are expiring, source/key/host
  bound, single-use and explicitly confirmed. Existing bytes/options remain;
  an existing file gets a protected backup. Unsafe/stale files and duplicate-key
  escalation are refused. Password/port/UFW/daemon settings remain untouched.
- The GUI exposes installation review, apply result/backup, cancellation, expiry
  and uncertain outcomes. It locks competing key/config operations and keeps
  installation separate from the independent selected-key proof. The reviewed
  mutation and bounded result metadata also appear in the command console.
- Shared official shadcn/Base UI sidebar composition is container-scoped below
  the existing tabs/stats headers: 256px expanded, 56px collapsed, reduced-motion
  support, accessible icon labels/tooltips and mobile disclosure. Collapse is
  saved in the validated workspace document. The footer shows runtime version
  and current/new update details without extra update-check polling.
- Independent checks passed: bun check/build, 68 src unit tests, native 142 passed
  with 5 intentionally ignored, Rust formatting and strict all-target Clippy.
  Browser coverage: 33 relevant scenarios passed across the main run and focused
  reruns; final installation flow passed again after command-console integration.
- Native fixtures execute the actual installer in private temporary homes and
  authenticate over real loopback SSH from the resulting authorization file;
  the original PTY stays alive. No important VPS, real user SSH files or agents
  were used. Early fixture failures were fixed by explicitly protecting temp
  ancestors and setting the intended fixture modes, preserving production checks.
- Command Code wrote native/sidebar/frontend implementation and tests in named
  sessions. Codex reviewed, integrated and independently verified the result,
  with focused safety-review requests, fixture/test-selector/lint repairs and
  command-console integration. CLI processes exited; no idle sessions are needed.


## Staged administrator access increment — 2026-11-07

Implemented reviewed root-to-administrator creation/adoption, selected public-key
installation under the target account via runuser, independent pinned-host key
SSH and explicit sudo-to-root verification, and promotion of the retained live
connection into a separate profile. Original root access remains available;
nonsecret wizard choices carry over, progress survives restart and requires a
fresh live proof. New/existing mode is enforced; existing passwords/groups and
keys are preserved. Fresh-home collision checks run before useradd, sudoers is
validated, native reviews bind connection/host/key/file evidence and expire.

Native helper tests use temporary account-command fixtures; loopback SSH tests
gate actual selected-key authentication on the installed authorized_keys file.
No host users, real SSH files or production VPS are changed. SSH port, password
or root-login restrictions, UFW recovery and application installers remain
pending; supported execution is limited to Debian 12+ and Ubuntu 22.04+ with the
required tools already installed. No reboot or automatic replay occurs.

Validation for this increment: `bun run check`, `bun run build`, release-version
validation, 69 Bun tests, Cargo fmt and Clippy with warnings denied passed. The
full native library suite passed 149 tests (5 intentionally ignored); the staged
access and helper fixtures were rechecked after review fixes. Thirty relevant
browser scenarios passed across the main run and focused reruns, including
root-to-administrator handoff, no automatic promotion retry, transient credential
clearing on hidden workspaces, draft persistence and existing key-install guards.
These are temporary-home/loopback and mocked-browser checks, not a claim of
full-VM SSH/UFW recovery validation.

## Per-step workflow foundation — 2026-11-08

Each wizard step now exposes explicit Scan existing, Review this step, observed
configuration and recovery guidance. Scans use the shared on-demand native
configuration inspection, with cancellation, current connection binding, bounded
output and the existing command panel. Reviews use native configuration preflight
and validate server/revision/connection/snapshot/category selection before display.
Access reviews route to the existing exact administrator/key review/apply/verify
workflow. Other apply actions are explicitly unavailable rather than executing
invented shell commands. Scan evidence is not package-specific verification.

Only validated nonsecret scan/review checkpoints are persisted per VPS. Evidence,
commands, errors, credentials and proofs stay out of history. Restart requires
fresh evidence. Expired/disconnected reviews cannot route to access actions.

Still required to fulfill the complete execution design: maintained official-source
install adapters with exact command/artifact reviews, item ownership/dependencies,
independent version/postcondition checks, partial operation journals, rescan-bound
failed-item retries and selected safe rollback; native SSH/UFW recovery validation.
These are not implemented or represented as complete in this release.
