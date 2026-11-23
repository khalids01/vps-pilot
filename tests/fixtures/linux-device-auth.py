#!/usr/bin/env python3
"""Validate the production Linux PAM module in an explicitly selected local Docker context.

No host mounts, host accounts, VPS connections, or real credentials are used.
Run: python3 tests/fixtures/linux-device-auth.py --context desktop-linux
"""
import argparse
import pathlib
import secrets
import shutil
import subprocess
import tempfile
import uuid

MANIFEST = '''[package]
name = "vps-pilot-pam-fixture"
version = "0.1.0"
edition = "2021"
[dependencies]
argon2 = { version = "0.6", features = ["zeroize"] }
pam-client = { version = "0.5", default-features = false }
nix = { version = "0.32", features = ["user"] }
zeroize = "1"
'''
DOCKERFILE = '''FROM rust:1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libpam0g-dev libpam-modules libclang-dev passwd && rm -rf /var/lib/apt/lists/*
WORKDIR /fixture
COPY Cargo.toml ./
COPY src ./src
RUN cargo test && cargo build && useradd --create-home --uid 1001 vpslock_fixture
CMD ["sleep", "infinity"]
'''
MAIN = '''mod linux;
mod app_password;
use zeroize::Zeroizing;
fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == "root" { assert!(linux::account().is_err()); println!("Root account refused"); return; }
    if mode == "unavailable" { assert!(linux::available().is_err()); println!("Missing policy refused"); return; }
    assert_eq!(linux::account().unwrap(), "vpslock_fixture");
    let password = Zeroizing::new(std::fs::read_to_string("/run/vps-lock-test-password").unwrap());
    if mode == "success" {
        assert!(linux::available().is_ok());
        assert!(linux::authenticate(Zeroizing::new(password.to_string())).is_ok());
        assert!(linux::authenticate(Zeroizing::new(format!("{}-incorrect", &*password))).is_err());
        println!("Real non-root login authentication passed; wrong password refused");
    } else {
        assert!(linux::authenticate(password).is_err());
        println!("Expired account or permissive policy refused");
    }
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True, help="Explicit local Unix-socket Docker context")
    args = parser.parse_args()
    docker = ["docker", "--context", args.context]
    endpoint = subprocess.check_output(docker + ["context", "inspect", args.context, "--format", "{{.Endpoints.docker.Host}}"], text=True).strip()
    if not endpoint.startswith("unix://"):
        parser.error("This fixture requires a local Unix-socket Docker context; remote hosts are refused.")
    image = "vps-pilot-linux-auth-fixture:local"
    container = "vps-pilot-linux-auth-" + uuid.uuid4().hex[:12]
    root = pathlib.Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="vps-pilot-pam-") as directory:
        context = pathlib.Path(directory)
        (context / "src").mkdir()
        (context / "Cargo.toml").write_text(MANIFEST)
        (context / "Dockerfile").write_text(DOCKERFILE)
        (context / "src/main.rs").write_text(MAIN)
        shutil.copyfile(root / "src-tauri/src/security/linux.rs", context / "src/linux.rs")
        shutil.copyfile(root / "src-tauri/src/security/app_password.rs", context / "src/app_password.rs")
        subprocess.run(docker + ["build", "-t", image, str(context)], check=True)
    subprocess.run(docker + ["run", "--detach", "--network", "none", "--name", container, image], check=True, stdout=subprocess.DEVNULL)
    try:
        password = secrets.token_urlsafe(32)
        # Fixture secrets travel through stdin only, never arguments, logs, or history.
        subprocess.run(docker + ["exec", "-i", container, "chpasswd"], input=f"vpslock_fixture:{password}\n", text=True, check=True)
        subprocess.run(docker + ["exec", "-i", container, "sh", "-c", "umask 077; cat > /run/vps-lock-test-password; chown vpslock_fixture:vpslock_fixture /run/vps-lock-test-password; chmod 400 /run/vps-lock-test-password"], input=password, text=True, check=True)
        binary = "/fixture/target/debug/vps-pilot-pam-fixture"
        subprocess.run(docker + ["exec", container, binary, "root"], check=True)

        def verify(mode):
            subprocess.run(docker + ["exec", "--user", "1001:1001", "--env", "USER=root", container, binary, mode], check=True)

        verify("success")
        subprocess.run(docker + ["exec", container, "chage", "-E", "0", "vpslock_fixture"], check=True)
        verify("expired")
        subprocess.run(docker + ["exec", container, "chage", "-E", "-1", "vpslock_fixture"], check=True)
        subprocess.run(docker + ["exec", "-i", container, "sh", "-c", "cat > /etc/pam.d/login"], input="auth required pam_permit.so\naccount required pam_permit.so\n", text=True, check=True)
        verify("permissive")
        subprocess.run(docker + ["exec", container, "chmod", "666", "/etc/pam.d/login"], check=True)
        verify("unavailable")
        subprocess.run(docker + ["exec", container, "rm", "/etc/pam.d/login"], check=True)
        verify("unavailable")
    finally:
        subprocess.run(docker + ["rm", "--force", container], check=True, stdout=subprocess.DEVNULL)
    print("Linux PAM fixture checks passed; the disposable account and container were removed.")


if __name__ == "__main__":
    main()
