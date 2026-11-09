# Disposable integration fixtures

These fixtures never target an existing VPS. They use rootless Podman, fixed
fixture labels, generated credentials, and temporary app-profile storage.

Build the Debian fixture:

```sh
podman build --network host -t localhost/vps-pilot-fixture:debian12 -f tests/fixtures/Containerfile tests/fixtures
```

Build-time package scripts cannot start services (`policy-rc.d` denies startup).
Host networking during the build permits package downloads where pasta/slirp is
unavailable. Runtime systemd checks use no network:

```sh
podman run -d --name vps-pilot-fixture-systemd --label org.vps-pilot.fixture=true --network none --systemd always --memory 512m --pids-limit 256 localhost/vps-pilot-fixture:debian12
VPS_PILOT_CONTAINER_FIXTURE=vps-pilot-fixture-systemd cargo test --manifest-path src-tauri/Cargo.toml --lib --locked disposable_systemd_container -- --ignored
podman rm -f vps-pilot-fixture-systemd
```

The lifecycle test refuses containers without the fixture name prefix and label.
It starts/restarts/stops and enables/disables only `vps-pilot-fixture.service`.

Run real OpenSSH/PTY validation:

```sh
./tests/fixtures/run-ssh.sh
```

The script creates a separate container listening only on an ephemeral loopback
port. It generates a private key in a mode-0700 temporary directory, compares the
server fingerprint with its public host key, and deletes the container and key on
exit. SSH fixture credentials never enter profile storage, logs, or command
arguments. The test verifies actual PTY command output and partial Linux
inspection reporting when systemd is unavailable.

Browser checks use a mocked desktop bridge, two fictional server profiles, and
synthetic output:

```sh
bunx playwright install chromium
bun run test:e2e
# Or use installed Chrome:
PLAYWRIGHT_CHROME=/usr/bin/google-chrome bun run test:e2e
```

Browser mocks do not establish native WebKit behavior or privileged-installation
safety. Native default tests use in-process disposable SSH servers and never
connect to a real server or reuse the user's SSH agent.

## Live sampler benchmark

This benchmark is explicitly local/disposable. Never run it on the important VPS.
Build the fixture above, then run a network-isolated, resource-limited container:

```sh
podman run --rm --name vps-pilot-fixture-monitor-benchmark \
  --label org.vps-pilot.fixture=true --network none \
  --memory 128m --cpus 1 --pids-limit 32 \
  --volume "$PWD/src-tauri/src/ssh/sampler.py:/workspace/src-tauri/src/ssh/sampler.py:ro" \
  --volume "$PWD/tests/fixtures/benchmark-monitor.py:/workspace/tests/fixtures/benchmark-monitor.py:ro" \
  localhost/vps-pilot-fixture:debian12 \
  python3 -u /workspace/tests/fixtures/benchmark-monitor.py --samples 10
```

This command compares 10 requests at each 1-, 2-, and 5-second interval, including process
startup, with a budget below 1% of one CPU core and below 20 MiB peak RSS.
The script defaults to 30 samples per interval when --samples is omitted.
It measures only the sampler, excluding SSH transport and desktop rendering.
The OpenSSH test separately verifies real typed samples and remote process exit
after closing the stream. Browser tests cover sharing, pause, backoff,
interval changes, tooltips, popover details, and narrow layouts.

### SFTP Files fixture

Run `bash tests/fixtures/run-ssh.sh disposable_openssh_sftp` for just the
file-operation integration test. It creates a unique folder under the disposable
container's root home, exercises listing/edit/upload/stale checks and private
Git-ignored backups, and removes only its own test files. The wrapper destroys
the labeled container afterward. No production VPS is used.


The SFTP fixture also exercises the file-manager operation engine: bounded
recursive copies, mode/symlink preservation, ZIP downloads with link exclusions,
single-use/no-overwrite review, cancellation leaving only private partial data,
trash/restore and rename. Cleanup touches only the test's unique fixture path.
Linux mount-boundary parsing and protected system/data paths have native unit
tests. None of these checks may run against an important or production VPS.

Docker-specific checks:
- python3 tests/fixtures/docker-format.py runs the actual Docker CLI against a
  temporary loopback fake Engine API, with an explicit --host. It never uses an
  existing/default daemon or container, and validates list/details/stats formats
  plus omission of environment values.
- bash tests/fixtures/run-ssh.sh disposable_openssh_container_style verifies the
  real SSH PTY+exec channel branch used by container shells.
These two checks alone do not validate lifecycle mutations. The separate real-VM
matrix below validates the dedicated protocol. Never substitute the important VPS
or default Docker daemon.


### Real disposable Docker VM

run-docker-vm.py requires KVM, SSH/OpenSSL and a private downloaded QEMU/image
cache (VPS_PILOT_VM_TOOLS, default /tmp/vps-pilot-docker-vm-tools).
No host Docker daemon or package installation. On Debian use apt-get download
for qemu-system-x86/common/data, seabios, qemu-utils and runtime libraries;
place .deb files in the cache. The launcher extracts them under cache/root.
Cache an official Alpine cloud-init QCOW2 as alpine.qcow2 with its matching
official SHA-512 file as alpine.sha512; it verifies the image before boot.

Validated image: Alpine 3.24.2 x86_64 cloud-init r2, from
https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/cloud/.
Run python3 tests/fixtures/run-docker-vm.py in a separate terminal. It prints
the private fixture.json path and creates a unique ephemeral SSH key/disk,
loopback SSH forwarding, and Docker inside the guest. Wait for cloud-init and
the guest marker. If initial Docker startup failed, start it only in that
explicitly identified guest. Requires 1.5 GiB RAM, two virtual CPUs and a sparse
6 GiB disposable disk.

Use the exact generated metadata path:

    VPS_PILOT_DOCKER_VM_FILE=/tmp/vps-pilot-docker-vm-EXAMPLE/fixture.json python3 tests/fixtures/docker-management-vm.py
    VPS_PILOT_DOCKER_VM_FILE=/tmp/vps-pilot-docker-vm-EXAMPLE/fixture.json cargo test --locked --manifest-path src-tauri/Cargo.toml --lib disposable_docker_vm_bound_approvals -- --ignored
    python3 tests/fixtures/docker-policy.test.py

The matrix changes only the guest clock by nine days for age-based cleanup.
It tests lifecycle/create/pull/deploy/config backups, stale/unsafe refusals and
exact resource cleanup while preserving volumes. Native tests verify approval
binding/replay/disconnect. Tests reject non-loopback/non-generated metadata and
require the disposable guest marker.

Stop the launcher with Ctrl-C afterward: it terminates QEMU, closes its seed HTTP
server and removes ephemeral keys/disks/metadata unless explicitly retaining
artifacts. Downloaded tools/image remain reusable. Never use an important VPS.


### Cleanup expansion matrix

On a fresh app-created marked disposable VM, run docker-cleanup-vm.py with
VPS_PILOT_DOCKER_VM_FILE set to its generated fixture.json. This is destructive
only inside that guest: it tests default system prune, --all, actual BuildKit
cache, rollback holds, protected stopped/mounted workloads, dependent resource
cleanup, and preservation of running infrastructure and volumes. It installs
docker-cli-buildx inside the guest for the cache fixture, never on the host.
The guest clock is deliberately moved for seven-day policy tests, and restored
for TLS downloads. Rerun with a fresh VM if a failed run left protected fixture
objects. The native ignored disposable_docker_vm_bound_approvals test also
checks native typed confirmation, batch cancellation, exact removals, stale
targets and replay. Stop the VM launcher after all tests.

### Configuration discovery

`python3 -B tests/fixtures/configuration-probe.test.py` runs mocked local policy
cases for metadata parsing, permission failures, rule families/comment suppression,
output limits and SSH policy uncertainty. It never contacts a VPS.

`bash tests/fixtures/run-ssh.sh disposable_openssh_runs_real_pty_and_reports_partial_inspections`
now also executes the real fixed configuration probe through the native API,
checks server/connection identity, wrong-generation rejection, Debian detection
and partial SSH policy evidence, then exercises the preexisting PTY/monitor flow.
The disposable OpenSSH container is destroyed afterward. This is not UFW/SSH
mutation or rollback certification, and is not an overhead benchmark.

### Configuration discovery overhead

With local rootless Podman and the Debian fixture image already built above:

```sh
python3 -B tests/fixtures/benchmark-configuration.py
# Optionally preserve a report at a new path:
python3 -B tests/fixtures/benchmark-configuration.py --trials 5 --output /tmp/vps-pilot-configuration-results.json
```

The driver requires local rootless Podman, never pulls an image and creates only
its own uniquely named, nonce-labeled guest. It has no networking or host mounts,
a read-only root, temporary /tmp and /run, and limits of 128 MiB, one CPU and 32
processes. Cleanup verifies the nonce before removing the guest with zero stop
grace, retries transient failures and explicitly reports uncertain cleanup rather
than claiming success. Missing image,
unsupported resource controls, timeout and invalid evidence fail the run without
printing raw probe output. Existing report files are preserved.

One warmup precedes 1–10 sequential measured invocations (five by default). Each
uses the actual probe with native-style JSON identity on stdin. The guest measures
probe elapsed time and Linux wait4 CPU usage, including reaped descendants. RSS
is the largest individual process, **not total process-tree peak memory**. Output
records only byte counts and section-state totals. No evidence values, keys or
hostname are recorded. Reports include source SHA256 and immutable image ID.

See `configuration-benchmark-results.json` for the checked-in Debian 12 result.
These are warm-cache one-shot measurements; the guest has no running SSH daemon
or systemd PID 1 and few installed packages. SSH transport, Podman exec startup,
desktop rendering, active-systemd and broader distribution/load measurements
remain outside this benchmark. It does not change or certify the live monitoring
budget, and does not enable any configuration mutation.

`python3 -B tests/fixtures/configuration-benchmark.test.py` checks bounded output,
bidirectional pipe backpressure, timeout/reaping and cleanup failure/ownership
cases locally, without launching Podman or contacting any server.

Docker database protocol tests: `python3 tests/fixtures/docker-database.test.py`.
They run the actual remote adapter against a private temporary Docker CLI fixture,
exercise all four engine command paths, binary streaming, identity mismatch and
credential-safe errors. They never contact Docker or a database. Native tests
cover request validation, cancellation leases and private no-overwrite local
staging; browser fixtures cover review/download/failure/cancel/credential lifetime.
These fixtures do not establish restoration compatibility with every real server
version. Validate restores separately on disposable databases before relying on
production backups; never use the important user VPS for integration tests.


### Six-step provisioning — November 2026

`python3 -B tests/fixtures/setup-packages.test.py` exercises the bundled adapters
without contacting a server or writing to the host home. Native setup-package
unit tests validate typed selections, reviews, progress and concurrency. Browser
coverage is selected by `six-step setup|staged administrator|guided access`.
Browser mocks establish UI behavior, not privileged integration safety.

The `setup-*-vm.py` scripts are destructive **inside a disposable guest only**.
They refuse execution outside a root container, use loopback SSH and assert the
VM marker. Never substitute a production address/key. Stage source/scripts into
a private local directory (avoid network-filesystem Docker mounts):

```sh
docker build -f tests/fixtures/setup-vm.Containerfile -t vps-pilot-setup-fixture .
fixture_dir=$(mktemp -d /tmp/vps-pilot-setup.XXXXXX)
chmod 700 "$fixture_dir"
mkdir "$fixture_dir/source"
cp src-tauri/src/ssh/setup_*.py "$fixture_dir/source/"
cp tests/fixtures/setup-*-vm.py tests/fixtures/setup-vm-boot.py "$fixture_dir/"
docker run -d --name vps-pilot-setup-fixture --label org.vps-pilot.fixture=true   --memory 4g --cpus 3 -v "$fixture_dir:/fixture"   -v "$fixture_dir/source:/source:ro" vps-pilot-setup-fixture   python3 -u /fixture/setup-vm-boot.py
```

Wait for `Disposable Debian VM ready` in container logs. The boot driver downloads
and checksum-checks a Debian 12 arm64 cloud image, generates ephemeral SSH keys,
and starts a 24 GiB QEMU guest with systemd. SSH ports are exposed only within the
container; Docker publishes no host ports. Initial host-key acceptance is confined
to this generated local guest; subsequent requests require its pinned identity.

On a fresh guest, run **one** security path: `setup-security-vm.py` tests timed
recovery and success; `setup-security-socket-vm.py` expects socket activation;
`setup-security-reboot-vm.py` exercises reboot recovery and socket activation after
the first security success. Read each script's starting-state assertions. Start
from a new fixture directory for a different sequence. After successful migration,
`setup-stacks-vm.py` installs Docker and Dokploy through the hardened guest port.
`setup-wrapper-vm.py` then tests the actual sudo wrapper and both checkpoint
messages with another SSH-only apply (existing Docker networking is preserved).
Copy each selected script into the container or execute its `/fixture/` path.
`setup-user-tools-integration.py` runs in a disposable Debian container with a
`fixture` user and sudo/runuser prerequisites; it must never run on the host.

Observed on Debian 12 arm64: all eight user-tool installers and repeat-install
skips; Docker engine/Compose; Dokploy services, proxy and loopback dashboard;
interrupted platform retry; key/sudo verification; SSH/UFW migration, client-loss
rollback, real reboot recovery and socket activation. LazyVim plugin hydration,
PM2 boot startup, other OS/CPU combinations and native WebKit rendering remain
outside those claims. No important VPS was contacted.

After validation, stop/remove the exact fixture container, then remove its private
`fixture_dir` (including generated keys and disks). Never run global Docker prune.
The test tools/image may be retained for reuse.
