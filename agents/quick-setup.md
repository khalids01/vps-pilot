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
