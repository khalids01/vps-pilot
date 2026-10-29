#!/usr/bin/env bash
set -euo pipefail
# All credentials are disposable and generated into a private temporary directory.
fixture_dir=$(mktemp -d)
fixture_name="vps-pilot-fixture-ssh-$$"
cleanup() {
  podman rm -f "$fixture_name" >/dev/null 2>&1 || true
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/id_ed25519"
fixture_port=$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    print(listener.getsockname()[1])
PY
)
podman run --detach --name "$fixture_name" --label org.vps-pilot.fixture=true --network host --entrypoint /bin/sh localhost/vps-pilot-fixture:debian12 -c 'mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh && ssh-keygen -A >/dev/null && exec /usr/sbin/sshd -D -p "$1" -o ListenAddress=127.0.0.1 -o PasswordAuthentication=no -o PermitRootLogin=prohibit-password' fixture "$fixture_port" >/dev/null
podman cp "$fixture_dir/id_ed25519.pub" "$fixture_name:/root/.ssh/authorized_keys" >/dev/null
podman exec "$fixture_name" chmod 600 /root/.ssh/authorized_keys
fixture_fingerprint=$(podman exec "$fixture_name" ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256 | awk '{print $2}')
VPS_PILOT_OPENSSH_FIXTURE_PORT="$fixture_port" VPS_PILOT_OPENSSH_FIXTURE_IDENTITY="$fixture_dir/id_ed25519" VPS_PILOT_OPENSSH_FIXTURE_FINGERPRINT="$fixture_fingerprint" cargo test --manifest-path src-tauri/Cargo.toml --lib --locked disposable_openssh -- --ignored
