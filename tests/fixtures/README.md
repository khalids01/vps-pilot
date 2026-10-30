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
