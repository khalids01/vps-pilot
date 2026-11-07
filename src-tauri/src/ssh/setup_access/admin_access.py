"""Bounded staged-administrator helper.

Runs only over an existing root SSH channel and only on a narrow Debian/Ubuntu
Linux path. Review mode is read-only. Apply mode creates a new non-root account
with a password supplied on stdin, or explicitly adopts an existing account
without changing its password, groups or sudoers. The helper validates the
system sudoers parse before reporting success. It never edits sshd, the SSH
port or a firewall, never runs a package manager and never returns a password.
"""
import grp
import json
import os
import pwd
import re
import shutil
import subprocess
import sys

MAX_INPUT_BYTES = 64 * 1024
MAX_OUTPUT = 16 * 1024
MAX_PASSWORD_BYTES = 4096
OS_RELEASE = "/etc/os-release"
HOME_ROOT = "/home"
HOME_OWNER_UID = 0
USERNAME = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
SUPPORTED = {"debian": (12, 0), "ubuntu": (22, 4)}
TOOLS = ("useradd", "usermod", "chpasswd", "visudo", "runuser", "sudo", "bash")


def emit(payload):
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if len(data) > MAX_OUTPUT:
        data = b'{"ok":false,"reason":"output_limit"}'
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def fail(reason):
    emit({"ok": False, "reason": reason})
    raise SystemExit(1)


def read_request():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    except OSError:
        fail("io_error")
    if len(raw) > MAX_INPUT_BYTES:
        fail("input_too_large")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        fail("invalid_request")
    if not isinstance(request, dict):
        fail("invalid_request")
    mode = request.get("mode")
    if mode not in ("review", "apply"):
        fail("invalid_request")
    username = request.get("username")
    if not isinstance(username, str) or not USERNAME.match(username) or username == "root":
        fail("invalid_username")
    requested = request.get("requested")
    expected_home = request.get("expectedHome") if mode == "apply" else None
    if mode == "apply" and (not isinstance(expected_home, str) or not expected_home.startswith("/")):
        fail("invalid_request")
    if requested not in ("new", "existing"):
        fail("invalid_request")
    password = request.get("password") if mode == "apply" else None
    expected = request.get("expected") if mode == "apply" else None
    if mode == "apply":
        if not isinstance(expected, dict):
            fail("invalid_request")
        if password is not None and not isinstance(password, str):
            fail("invalid_request")
    return mode, username, requested, password, expected, expected_home


def require_root():
    if not sys.platform.startswith("linux"):
        fail("unsupported_platform")
    if os.geteuid() != 0:
        fail("privilege_required")


def os_release():
    try:
        with open(OS_RELEASE, "r", encoding="utf-8") as handle:
            data = handle.read(8192)
    except OSError:
        fail("unsupported_os")
    values = {}
    for line in data.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"')
    os_id = values.get("ID", "").lower()
    version = values.get("VERSION_ID", "").strip()
    supported = os_id in SUPPORTED
    if not re.match(r"^[0-9]+(\.[0-9]+)*$", version):
        supported = False
    else:
        parts = [int(part) for part in version.split(".")[:2]]
        while len(parts) < 2:
            parts.append(0)
        supported = supported and tuple(parts) >= SUPPORTED[os_id]
    if not supported:
        fail("unsupported_os")
    return os_id, version


def tools():
    missing = [name for name in TOOLS if not shutil.which(name)]
    if missing:
        fail("missing_tools")
    try:
        grp.getgrnam("sudo")
    except KeyError:
        fail("missing_sudo_group")


def validate_sudoers():
    code, _, _ = run(["visudo", "-c", "-q"])
    if code != 0:
        fail("sudoers_invalid")


def snapshot(username):
    try:
        entry = pwd.getpwnam(username)
    except KeyError:
        entry = None
    if entry is None:
        return {
            "username": username,
            "exists": False,
            "uid": 0,
            "gid": 0,
            "home": "",
            "shell": "",
            "homeExists": False,
            "homeMode": 0,
            "homeUid": 0,
            "passwordLocked": False,
        }
    if entry.pw_uid == 0:
        fail("root_target")
    home = entry.pw_dir
    if (
        not isinstance(home, str)
        or not home.startswith("/")
        or home == "/"
        or len(home) > 4096
        or any(ord(character) < 32 or ord(character) == 127 for character in home)
    ):
        fail("home_invalid")
    try:
        info = os.lstat(home)
        home_exists = True
        mode = info.st_mode & 0o7777
        home_uid = info.st_uid
    except FileNotFoundError:
        home_exists, mode, home_uid = False, 0, 0
    except OSError:
        fail("home_invalid")
    return {
        "username": entry.pw_name,
        "exists": True,
        "uid": entry.pw_uid,
        "gid": entry.pw_gid,
        "home": home,
        "shell": entry.pw_shell,
        "homeExists": home_exists,
        "homeMode": mode,
        "homeUid": home_uid,
        "passwordLocked": shadow_locked(entry.pw_name),
    }


def planned_home(username):
    if not re.match(r"^[a-z_][a-z0-9_-]{0,31}$", username):
        fail("invalid_username")
    return HOME_ROOT.rstrip("/") + "/" + username


def preflight_home(username, home_uid):
    home = planned_home(username)
    parent = HOME_ROOT.rstrip("/") or "/"
    try:
        info = os.lstat(parent)
    except OSError:
        fail("home_parent_invalid")
    if not os.path.isdir(parent) or os.path.islink(parent):
        fail("home_parent_invalid")
    if info.st_uid != HOME_OWNER_UID or info.st_mode & 0o022:
        fail("home_parent_invalid")
    try:
        exists = os.path.lexists(home)
    except OSError:
        fail("home_parent_invalid")
    if exists:
        # Never repurpose an orphan home, symlink, file or foreign directory.
        try:
            existing = os.lstat(home)
        except OSError:
            fail("home_collision")
        if os.path.islink(home) or not os.path.isdir(home) or existing.st_uid != home_uid:
            fail("home_collision")
        fail("home_collision")
    return home


def shadow_locked(username):
    try:
        with open("/etc/shadow", "r", encoding="utf-8") as handle:
            for line in handle:
                fields = line.rstrip("\n").split(":")
                if fields and fields[0] == username and len(fields) > 1:
                    return fields[1].startswith("!")
    except OSError:
        return False
    return False


def run(argv, stdin=None):
    try:
        completed = subprocess.run(
            argv,
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        fail("tool_failed")
    return completed.returncode, completed.stdout[:MAX_OUTPUT], completed.stderr[:MAX_OUTPUT]


def valid_password(password):
    if not isinstance(password, str) or password == "":
        fail("password_required")
    encoded = password.encode("utf-8")
    if len(encoded) > MAX_PASSWORD_BYTES:
        fail("password_too_large")
    if any(character in password for character in "\r\n\x00"):
        fail("password_invalid")
    return encoded


def compare(expected, current):
    for name in ("username", "exists"):
        if expected.get(name) != current[name]:
            fail("state_changed")
    if current["exists"]:
        for name in ("uid", "gid", "home", "shell"):
            if expected.get(name) != current[name]:
                fail("state_changed")


def require_mode(requested, current):
    if requested == "new" and current["exists"]:
        fail("account_exists")
    if requested == "existing" and not current["exists"]:
        fail("account_missing")


def apply(username, requested, password, expected, expected_home):
    current = snapshot(username)
    compare(expected, current)
    require_mode(requested, current)
    if planned_home(username) != expected_home:
        fail("state_changed")
    created = False
    if current["exists"]:
        return {"ok": True, "account": "adopted", "snapshot": snapshot(username)}
    encoded = valid_password(password)
    validate_sudoers()
    planned_home(username)
    preflight_home(username, os.getuid())
    code, _, _ = run(["useradd", "--create-home", "--shell", "/bin/bash", "--", username])
    if code != 0:
        fail("account_create_failed")
    created = True
    code, _, _ = run(["chpasswd"], stdin=(username + ":").encode("ascii") + encoded + b"\n")
    if code != 0:
        fail("password_failed")
    code, _, _ = run(["usermod", "-aG", "sudo", username])
    if code != 0:
        fail("sudo_group_failed")
    validate_sudoers()
    result = snapshot(username)
    if not result["exists"] or result["uid"] == 0:
        fail("account_unavailable")
    return {
        "ok": True,
        "account": "created",
        "created": created,
        "snapshot": result,
    }


def main():
    require_root()
    os_id, os_version = os_release()
    tools()
    mode, username, requested, password, expected, expected_home = read_request()
    if mode == "review":
        validate_sudoers()
        current = snapshot(username)
        require_mode(requested, current)
        planned = planned_home(username)
        if requested == "new":
            preflight_home(username, os.getuid())
        emit(
            {
                "ok": True,
                "osId": os_id,
                "osVersion": os_version,
                "account": "create" if not current["exists"] else "adopt",
                "plannedHome": planned,
                "snapshot": current,
            }
        )
        return
    result = apply(username, requested, password, expected, expected_home)
    result["osId"] = os_id
    result["osVersion"] = os_version
    emit(result)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        fail("io_error")
