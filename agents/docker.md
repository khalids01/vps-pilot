# Docker management — 2026-10-31

## Implemented

Retained per-VPS Docker workspace, one shared project Select, explicit container/
Compose inventory, projected details, masked environment keys and on-demand
resource snapshots. No automatic Docker polling, daemon installation, sudo,
group membership changes or default-host Docker testing.

Management views: Deploy, Images, Volumes, Networks, Cleanup and Activity.
Dedicated Rust commands carry a fixed isolated Python stdlib program over the
verified SSH connection, with JSON requests on stdin. No user shell fragments,
config or credentials are interpolated into commands/history. Python 3 and
Docker/Compose are prerequisites; errors never forward raw config/stderr.

Supported operations: reviewed start/stop/restart, image pull, bridge-network/
volume creation, Compose deployment and eligible one-resource cleanup. The
legacy AppAction::DockerChange route remains disabled; it is not a bypass.

## Review, boundaries and safety

Up to eight pending plans, 1 MiB private input per plan, 120-second lifetime.
Plans bind profile/revision/connection, engine ID, exact request and evidence.
Claiming an approval consumes it, including wrong-server attempts. Disconnect
invalidates pending plans. Requests are zeroized on drop. One manager operation
per VPS, four globally. Runtime lock is released after opening the SSH channel,
so long queries do not hold every other server's connection/stream control lock.

Native runner has a 180-second deadline and 2 MiB output cap; subprocesses have
45-second deadlines. Inventory caps 250 entries per resource class. Progress
reports revalidation and completion through a channel. There is no deceptive
"cancel rollback": once requested, Docker may continue after interruption.
Uncertain outcomes stay visible and never trigger an automatic retry.

Mutations require a local Unix-socket Docker engine on the SSH host. Inspecting
a changed/remote context cannot authorize a mutation against another endpoint.
No force, prune-all, volume removal, global daemon/service restart, Compose down,
automatic image builds or database rollback.

Container protections: infrastructure/database names/projects/images; host
network/PID integration; privileged mode; protected host mounts, Docker socket;
Swarm/Kubernetes ownership. State, start/restart evidence and dependencies are
checked again before executing. Removing a stopped container deletes its writable
layer/logs; exact typed-name approval is required and the risk is disclosed.

## Compose

Form or YAML/JSON editor; optional explicit SFTP import (with content-replacement/
credential warning). Drafts remain in memory. Validation uses Compose's normalized
JSON on the server; only summaries, env names and hashes cross back. Resolved
local image IDs and normalized configuration hashes bind reviews, including
expanded environment changes. Missing images require a separate reviewed pull.
Protected host privileges/mounts/control ports and existing infrastructure
projects block deployment. Ports are checked against all container reservations,
including stopped containers, and bounded kernel listener tables.

Existing application folder required. compose.yaml must be regular, never a
symlink; content/stat evidence detects external changes. Private mode-700,
Git-ignored backup contains a mode-600 original. New config is mode-600, fsynced
and atomically published. CLI up uses --no-build --pull never --wait with a
20-second readiness window. Failed up may already have changed config/containers.
Activity offers previous config loading for a new review; this does not promise
image or persistent-data rollback. Concurrency checks are optimistic, not locks
against external writers changing files/tags at the last instant.

Prior image IDs from pulls/deployments are held in private per-user,
engine-keyed ~/.local/state/vps-pilot/docker-image-retention.json. Writes are
atomic, mode-600, under a private directory and file lock. Malformed/oversized
metadata fails closed; holds are never automatically evicted. Files protects this
namespace and its parent roots from writes/deletion. Separate administrators
outside this app are not coordinated by this per-user metadata.

## Cleanup

One exact resource per approval, typed exact name; no blind pruning.
- Image: untagged, unreferenced by all containers/parent images, not held for
  rollback, older than seven days. No --force.
- Network: unreferenced (including stopped containers), bridge, non-built-in,
  non-Compose/non-ingress/config-only, older than seven days.
- Container: exited standalone, no mounts, no infrastructure/orchestrator/host
  integration, stopped more than seven days. No -v or --force.
- Volumes: always protected, even with zero references. No volume deletion API.
- Build cache: unsupported because exact dependency evidence is unavailable.

No recursive data/volume scans, claimed zero-cost monitoring or guaranteed freed
space. Image sizes include shared layers. Unknown sizes remain Unknown.

## Logs and terminal retention

Reviewed logs use a 55-second remote timeout plus existing client output/ack
bounds, 64 KiB visible buffer. Local search/pause starts no new requests. Log
contents stay outside activity output and SQLite. Environment values in inspect
never cross SSH. Explicit Compose editing is a separate user-requested secret
file read and is never logged/persisted locally.

Container PTYs validate full ID/running state, then fixed docker exec /bin/sh as
configured user, without host-shell fallback. Existing PTY backpressure/close
confirmation/navigation retention remain. Container layouts do not overwrite
host layouts and never automatically reopen on application restart.

## Real validation and remaining limitations

Validated in an app-created, loopback-only KVM VM: Alpine 3.24, Docker Engine
29.9.2, Compose 5.6.1. Real cases: lifecycle, stale refusal, create volume/network,
pull, deploy/readiness/config backup, host privilege denial, protected workloads/
volumes, older dangling image/network/container removal. Native SSH integration
checks wrong-server token consumption, replay rejection, stale state and
disconnect invalidation. This enables only the dedicated management protocol.

Fixtures:
- run-docker-vm.py: downloaded private QEMU tools/image, no host package install;
  metadata/keys/disks in private /tmp; only loopback SSH forwarding.
- docker-management-vm.py: refuses non-generated metadata/non-loopback host and
  requires the disposable guest marker; never uses a default Docker daemon.
- Docker Rust ignored VM test uses the explicit generated fixture JSON.
- docker-policy.test.py: pure safety tests, no daemon.
- docker-format.py: actual CLI against a loopback fake API, mask/schema checks.
- Existing native, browser, SSH PTY and SFTP regressions remain required.

Not implemented: image builds, registry credential storage, volume backup/restore,
automatic database/image rollback, bulk destructive execution, backup/retention
purging and persistent cross-launch operation history. These are not simulated
as success. Never use the important VPS for any of these tests.


### Creation preflight and UX refinement

Run application replaces the Deploy label. Existing applications require explicit
update selection and matching canonical Compose working-directory labels. Review
evidence binds existing application IDs/state/start/restart/mount/network evidence.
Container-name collisions, cross-application bind overlaps and existing external/
shared named data/network resources block creation. Port ownership exemptions
apply only to the same running application service; another service or a stopped
container cannot hide a host listener. Unknown listener availability blocks.
Additional namespace/socket, lifecycle-hook and host-privilege shortcuts and
protected config/secret file sources are refused. Preflight is repeated at
execution, with Docker's own bind checks as the final guard against concurrent
external changes. This is not a security certification of arbitrary image code.
