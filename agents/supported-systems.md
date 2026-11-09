# Supported systems and validation boundaries

VPS Pilot's SSH terminals are independent of the management-integration matrix.
They require an SSH server with supported host-key/authentication algorithms and
remote PTY support. Read-only Linux inspections require the individual tools
shown in each exact command; missing tools and permissions produce partial or
unavailable results rather than sample values.

## Initial management matrix

| System | Architecture | Fixture-tested change implementation | Validation |
| --- | --- | --- | --- |
| Debian 12 | x86_64 | Noncritical systemd lifecycle controls; disabled in normal builds | Native SSH safety fixtures and a disposable rootless Debian systemd container |
| Debian 12 | aarch64 | None yet | Candidate; requires an architecture-specific fixture |
| Ubuntu 24.04 | x86_64 / aarch64 | None yet | Candidate; requires distro-specific integration fixtures |
| Other systems | Any | None | SSH terminals remain available; inspections report individual failures |

All app-triggered mutations are hard-disabled in Rust in normal builds. Only
in-process disposable fixtures opt into the tested service implementation. The
user's important VPS is not a destructive test environment.

The Debian service integration requires a canonical loaded unit, a stable job
state, a known systemd fragment path, matching on-disk configuration, no drop-ins,
a supported long-running unit type, and no hard lifecycle dependents. Connection,
networking, storage, security, container-engine, proxy, and deployment-platform
services are protected. Approvals expire after two minutes and are bound to the
profile revision and current authenticated connection. Preconditions are re-read
before execution; app changes serialize per server. An interrupted change must
be reconciled against stable systemd job state before another change is reviewed.
Result verification reads ActiveState or UnitFileState and returns a nonzero exit
when the expected state is absent. These checks do not establish general safety
for arbitrary service definitions or their external side effects.

Software installation/removal, proxy configuration changes, UFW rule changes,
and file cleanup are not enabled by this matrix. Catalog preflight distinguishes
known conflicts from missing evidence and cannot authorize mutations. No helper
is currently required by the implemented SSH functionality.

## Validation still required before a release

- Native Tauri/WebKit interaction, sustained terminal throughput, reconnects,
  resource cleanup, keyboard/focus and narrow layouts.
- Full disposable VPS/VM testing for supported distributions and architectures.
- Recovery/rollback fixtures for firewall and proxy changes before enabling them.
- Exact data-ownership and race checks before enabling cleanup or software removal.
- Dokploy/Traefik deployment fixture and existing manual installations.

Container checks supplement native SSH fixtures. They do not establish firewall
connectivity rollback or VM boot/recovery behavior.

## Live metrics prerequisites

The automatically enabled live sampler (configurable in Settings) requires Linux /proc counters, /sys/block, and Python 3
for the authenticated SSH user. Debian 12 x86_64 is exercised with real OpenSSH
in a rootless disposable container. Other Linux distributions are not certified
by that test. No remote package installation, permanent helper, privileged
process, or public monitoring port is introduced. Unsupported prerequisites
leave manual inspections and interactive terminals available.

See [monitoring-validation.md](monitoring-validation.md) for the sampler budget,
benchmark method, and transport/performance limitations.

## Explicit configuration snapshot — 2026-11-01

Quick Setup, SSH Access and Firewall share an explicit one-shot Python 3 probe
on the existing verified SSH transport. No new supported mutation combination
is established by this probe. Missing utilities/permissions remain partial or
unavailable, not empty success. Default daemon policy output does not certify
runtime invocation or recovery safety. Current-user PATH evidence does not
establish software package ownership. UFW/listener evidence does not establish
Internet reachability or Docker/cloud firewall coverage. See quick-setup-plan.md
for bounds, remaining detection scope and validation evidence.

## Guided provisioning exceptions — 2026-11-09

The original blanket mutation statements above describe the earlier milestone.
`setup-provisioning` is now a narrow exception; generic systemd/UFW/proxy/cleanup
mutation gates remain unchanged. Remote installers accept Debian 12/13 and Ubuntu
22.04/24.04/26.04/26.10 on x86_64/arm64, with official repositories and required
Python/account tools. This is the compatibility filter, not certification of every
combination. Existing binaries/configuration are preserved; unsupported evidence
blocks the corresponding operation.

Observed integration coverage for this increment:

- Debian 12 arm64 full QEMU VM: real Docker CE installation and daemon/Compose
  checks; pinned Dokploy/PostgreSQL/Traefik deployment, interrupted-install resume
  and dashboard health; SSH/UFW staged migration; independent key login/sudo; password/root
  restriction; retirement of the old listener; timed recovery after client loss;
  recovery across a real VM reboot; socket-activated migration and recovery.
- Debian 12 arm64 disposable container: real Bun, uv, NVM/Node LTS, PM2, Go,
  latest stable Neovim, Herdr and pinned LazyVim starter installation; independent
  executable/configuration checks and skip-on-retry. LazyVim plugin downloads and
  PM2 boot startup are not represented as completed by installing their packages.
- Native Rust loopback/temporary-home tests cover host/key identity, authentication
  fallback refusal, credentials, account/key installation, persistence and approvals.
  Mocked browser tests cover presentation/state, not privileged safety.

Other distribution/architecture combinations still require their own integration
coverage before being called certified. No important VPS was used. SSH migration
refuses translated SSH ports, custom effective SSH policies/listen addresses,
unsafe configuration paths, unsupported service semantics and incompatible UFW
networking. The preset requires UFW IPv6 filtering and preserves existing rules;
Docker-published ports are not claimed to be protected by UFW.


Local checks: `bun run check`, `bun run build`, 28 focused Bun tests, 21 Python
adapter tests, and nine targeted browser cases passed. The Rust suite passed
160 tests with five existing integration tests ignored. A final focused native
suite also passed after the retry hardening. Clippy passed with warnings denied
except the repository's existing `clippy::nonminimal_bool` findings in unrelated
adapters. Build output retains Vite's large-chunk advisory. Because this checkout
is on SMB and its installed tools targeted Linux, frontend checks used a frozen-
lockfile local mirror with macOS tool binaries; no project dependency changes were
needed. Native Tauri/WebKit and other OS/CPU combinations still need release QA.
