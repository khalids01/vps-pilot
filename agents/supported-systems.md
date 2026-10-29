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
