"""Bounded Quick Setup public-key installation helper.

Reads exactly one JSON request from stdin. Review mode is read-only. Apply mode
rechecks the reviewed snapshot, keeps a protected backup of an existing
authorized_keys file and appends only the selected public key for the current
effective account.

This helper never uses sudo, installs software, reloads a daemon, edits SSH
daemon/port/firewall configuration, removes existing keys, follows a symlink to
an attacker-controlled path, or reads private-key material. It reports bounded
structured metadata only; existing authorized-key contents and raw errors are
never returned.
"""
import base64
import fcntl
import hashlib
import json
import os
import pwd
import re
import secrets
import stat
import sys

MAX_FILE_BYTES = 1024 * 1024
MAX_INPUT_BYTES = 64 * 1024
MAX_PUBLIC_LINE = 8191
MAX_BACKUP_TRIES = 8
OUTPUT_LIMIT = 16 * 1024
AUTHORIZED_KEYS = "authorized_keys"
SSH_DIR = ".ssh"
VIRTUAL_ROOTS = ("/proc", "/sys", "/dev", "/run")
KEY_TYPE = re.compile(r"^(ssh-[a-z0-9@.-]+|ecdsa-sha2-[a-z0-9@.-]+|sk-[a-z0-9@.-]+)$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")


def emit(payload):
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if len(data) > OUTPUT_LIMIT:
        data = b'{"ok":false,"reason":"output_limit"}'
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def fail(reason):
    emit({"ok": False, "reason": reason})
    raise SystemExit(1)


def require_platform():
    for name in ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK", "O_CLOEXEC", "O_APPEND"):
        if not hasattr(os, name) and name != "O_CLOEXEC":
            fail("unsupported_platform")


def cloexec():
    return getattr(os, "O_CLOEXEC", 0)


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
    key_type, blob = parse_public_line(request.get("publicKey"))
    expected = request.get("expected") if mode == "apply" else None
    if mode == "apply" and not isinstance(expected, dict):
        fail("invalid_request")
    return mode, key_type, blob, expected


def parse_public_line(value):
    if not isinstance(value, str) or not value or len(value) > MAX_PUBLIC_LINE:
        fail("invalid_public_key")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        fail("invalid_public_key")
    tokens = value.split()
    if len(tokens) < 2:
        fail("invalid_public_key")
    key_type, blob = tokens[0], tokens[1]
    if not KEY_TYPE.match(key_type):
        fail("invalid_public_key")
    try:
        decoded = base64.b64decode(blob, validate=True)
    except (ValueError, TypeError):
        fail("invalid_public_key")
    if not decoded or len(decoded) > MAX_PUBLIC_LINE:
        fail("invalid_public_key")
    return key_type, blob


def current_account():
    uid = os.getuid()
    try:
        entry = pwd.getpwuid(uid)
    except KeyError:
        fail("account_unavailable")
    name = entry.pw_name
    home = entry.pw_dir
    if not isinstance(name, str) or not name or len(name) > 64:
        fail("account_unavailable")
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        fail("account_unavailable")
    if (
        not isinstance(home, str)
        or not home.startswith("/")
        or len(home) > 4096
        or any(ord(character) < 32 or ord(character) == 127 for character in home)
    ):
        fail("home_invalid")
    normalized = home.rstrip("/") or "/"
    if normalized == "/" or any(
        normalized == root or normalized.startswith(root + "/") for root in VIRTUAL_ROOTS
    ):
        fail("home_invalid")
    return uid, name, normalized


def open_dir(path, label, dir_fd=None):
    try:
        return os.open(
            path,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | cloexec(),
            dir_fd=dir_fd,
        )
    except FileNotFoundError:
        return None
    except OSError:
        fail(label)


def check_dir(fd, uid, label, ancestor=False):
    try:
        info = os.fstat(fd)
    except OSError:
        fail(label)
    if not stat.S_ISDIR(info.st_mode):
        fail(label)
    if uid is not None and info.st_uid != uid:
        fail(label)
    writable = info.st_mode & 0o022
    if writable and not (ancestor and info.st_mode & 0o1000):
        fail(label)
    return info


def check_ancestor(fd, uid, label):
    try:
        info = os.fstat(fd)
    except OSError:
        fail(label)
    if not stat.S_ISDIR(info.st_mode):
        fail(label)
    owner = info.st_uid
    if owner != 0 and owner != uid:
        fail(label)
    if info.st_mode & 0o022 and not (
        info.st_mode & 0o1000 and owner in (0, uid)
    ):
        fail(label)
    return info


def open_home(home, uid):
    parts = [part for part in home.split("/") if part]
    fd = open_dir("/", "home_invalid")
    if fd is None:
        fail("home_invalid")
    try:
        info = check_ancestor(fd, uid, "home_invalid")
        for index, part in enumerate(parts):
            next_fd = open_dir(part, "home_invalid", fd)
            if next_fd is None:
                fail("home_invalid")
            os.close(fd)
            fd = next_fd
            if index == len(parts) - 1:
                info = check_dir(fd, uid, "home_invalid")
            else:
                info = check_ancestor(fd, uid, "home_invalid")
        return fd, info
    except BaseException:
        os.close(fd)
        raise


def read_all(fd):
    chunks = []
    total = 0
    while True:
        try:
            chunk = os.read(fd, min(65536, MAX_FILE_BYTES + 1 - total))
        except OSError:
            fail("io_error")
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_FILE_BYTES:
            fail("file_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


def open_read_only(dir_fd, name, uid, label):
    try:
        fd = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | cloexec(),
            dir_fd=dir_fd,
        )
    except FileNotFoundError:
        return None, None
    except OSError:
        fail(label)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            fail(label)
        if info.st_uid != uid or info.st_nlink != 1:
            fail(label)
        if info.st_mode & 0o022:
            fail(label)
        if info.st_size > MAX_FILE_BYTES:
            fail("file_too_large")
        return info, read_all(fd)
    finally:
        os.close(fd)


def iter_tokens(line):
    current = []
    quote = None
    escaped = False
    started = False
    for character in line:
        if escaped:
            current.append(character)
            escaped = False
            started = True
        elif quote:
            if character == "\\":
                escaped = True
            elif character == quote:
                quote = None
            else:
                current.append(character)
            started = True
        elif character in "\"'":
            quote = character
            started = True
        elif character.isspace():
            if started:
                yield "".join(current)
                current = []
                started = False
        else:
            current.append(character)
            started = True
    if quote or escaped:
        raise ValueError
    if started:
        yield "".join(current)


def parse_entries(data):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    entries = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key_type = None
        blob = None
        option_seen = False
        count = 0
        try:
            for token in iter_tokens(stripped):
                count += 1
                if count > 64:
                    return None
                if key_type is None:
                    if KEY_TYPE.match(token):
                        key_type = token
                    else:
                        option_seen = True
                else:
                    blob = token
                    # Everything after the blob is an ignored trailing comment;
                    # never tokenize it (apostrophes and quotes are allowed there).
                    break
        except ValueError:
            return None
        if key_type is None or blob is None:
            return None
        try:
            decoded = base64.b64decode(blob, validate=True)
        except (ValueError, TypeError):
            return None
        if not decoded:
            return None
        entries.append((key_type, blob, option_seen))
    return entries


def snapshot(uid, name, home, home_info, ssh_info, file_info, data, key_type, blob):
    entries = parse_entries(data) if file_info is not None else []
    if entries is None:
        fail("malformed_keys")
    matching = [entry for entry in entries if entry[0] == key_type and entry[1] == blob]
    already = bool(matching)
    restricted = any(entry[2] for entry in matching)
    return {
        "username": name,
        "home": home,
        "homeUid": home_info.st_uid,
        "homeMode": home_info.st_mode & 0o7777,
        "homeDev": home_info.st_dev,
        "homeIno": home_info.st_ino,
        "sshExists": ssh_info is not None,
        "sshUid": ssh_info.st_uid if ssh_info is not None else 0,
        "sshMode": (ssh_info.st_mode & 0o7777) if ssh_info is not None else 0,
        "sshDev": ssh_info.st_dev if ssh_info is not None else 0,
        "sshIno": ssh_info.st_ino if ssh_info is not None else 0,
        "fileExists": file_info is not None,
        "fileUid": file_info.st_uid if file_info is not None else 0,
        "fileMode": (file_info.st_mode & 0o7777) if file_info is not None else 0,
        "fileSize": file_info.st_size if file_info is not None else 0,
        "fileDev": file_info.st_dev if file_info is not None else 0,
        "fileIno": file_info.st_ino if file_info is not None else 0,
        "fileDigest": hashlib.sha256(data).hexdigest() if file_info is not None else "",
        "alreadyPresent": already,
        "restrictedPresent": restricted,
        "appendNewline": bool(file_info is not None and data and not data.endswith(b"\n")),
    }


def inspect(uid, name, home, key_type, blob):
    home_fd, home_info = open_home(home, uid)
    try:
        ssh_fd = open_dir(SSH_DIR, "ssh_unsafe", home_fd)
        try:
            ssh_info = None
            file_info, data = None, b""
            if ssh_fd is not None:
                ssh_info = check_dir(ssh_fd, uid, "ssh_unsafe")
                file_info, data = open_read_only(ssh_fd, AUTHORIZED_KEYS, uid, "file_unsafe")
            return snapshot(
                uid, name, home, home_info, ssh_info, file_info, data, key_type, blob
            )
        finally:
            if ssh_fd is not None:
                os.close(ssh_fd)
    finally:
        os.close(home_fd)


def require_bool(expected, name):
    value = expected.get(name)
    if not isinstance(value, bool):
        fail("invalid_request")
    return value


def require_int(expected, name):
    value = expected.get(name)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        fail("invalid_request")
    return value


def require_text(expected, name, limit):
    value = expected.get(name)
    if not isinstance(value, str) or len(value) > limit:
        fail("invalid_request")
    return value


def compare_expected(expected, current):
    if require_text(expected, "username", 64) != current["username"]:
        fail("state_changed")
    if require_text(expected, "home", 4096) != current["home"]:
        fail("state_changed")
    for name in ("sshExists", "fileExists", "alreadyPresent", "restrictedPresent", "appendNewline"):
        if require_bool(expected, name) != current[name]:
            fail("state_changed")
    for name in ("sshUid", "sshMode", "fileUid", "fileMode", "fileSize", "homeUid", "homeMode"):
        if require_int(expected, name) != current[name]:
            fail("state_changed")
    for name in ("homeDev", "homeIno"):
        if require_int(expected, name) != current[name]:
            fail("state_changed")
    digest = require_text(expected, "fileDigest", 64)
    if not digest and current["fileExists"]:
        fail("invalid_request")
    if digest and not DIGEST.match(digest):
        fail("invalid_request")
    if digest != current["fileDigest"]:
        fail("state_changed")
    if current["sshExists"]:
        if require_int(expected, "sshDev") != current["sshDev"]:
            fail("state_changed")
        if require_int(expected, "sshIno") != current["sshIno"]:
            fail("state_changed")
    if current["fileExists"]:
        if require_int(expected, "fileDev") != current["fileDev"]:
            fail("state_changed")
        if require_int(expected, "fileIno") != current["fileIno"]:
            fail("state_changed")


def write_all(fd, data):
    view = memoryview(data)
    written = 0
    while written < len(view):
        try:
            count = os.write(fd, view[written:])
        except OSError:
            fail("append_failed")
        if count <= 0:
            fail("append_failed")
        written += count


def sync_dir(fd):
    try:
        os.fsync(fd)
    except OSError:
        fail("io_error")


def create_backup(ssh_fd, uid, data):
    for _ in range(MAX_BACKUP_TRIES):
        name = "authorized_keys.vps-pilot-backup-" + secrets.token_hex(16)
        try:
            fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | cloexec(),
                0o600,
                dir_fd=ssh_fd,
            )
        except FileExistsError:
            continue
        except OSError:
            fail("backup_failed")
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1:
                fail("backup_failed")
            os.fchmod(fd, 0o600)
            write_all(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        sync_dir(ssh_fd)
        return name
    fail("backup_failed")


def create_new_file(ssh_fd, uid, key_type, blob):
    payload = (key_type + " " + blob + "\n").encode("ascii")
    try:
        fd = os.open(
            AUTHORIZED_KEYS,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | cloexec(),
            0o600,
            dir_fd=ssh_fd,
        )
    except FileExistsError:
        fail("newfile_exists")
    except OSError:
        fail("io_error")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1:
            fail("file_unsafe")
        os.fchmod(fd, 0o600)
        info = os.fstat(fd)
        if info.st_mode & 0o7777 != 0o600:
            fail("file_unsafe")
        write_all(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_dir(ssh_fd)


def append_existing(ssh_fd, uid, key_type, blob, expected):
    file_info, data = open_read_only(ssh_fd, AUTHORIZED_KEYS, uid, "file_unsafe")
    if file_info is None:
        fail("state_changed")
    entries = parse_entries(data)
    if entries is None:
        fail("malformed_keys")
    if any(entry[0] == key_type and entry[1] == blob for entry in entries):
        fail("state_changed")
    backup_name = create_backup(ssh_fd, uid, data)
    payload = (key_type + " " + blob + "\n").encode("ascii")
    if data and not data.endswith(b"\n"):
        payload = b"\n" + payload
    try:
        fd = os.open(
            AUTHORIZED_KEYS,
            os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK | cloexec(),
            dir_fd=ssh_fd,
        )
    except OSError:
        fail("append_failed")
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != uid
            or info.st_nlink != 1
            or info.st_dev != file_info.st_dev
            or info.st_ino != file_info.st_ino
            or info.st_dev != expected["fileDev"]
            or info.st_ino != expected["fileIno"]
            or info.st_mode & 0o7777 != expected["fileMode"]
        ):
            fail("state_changed")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("busy")
        except OSError:
            fail("append_failed")
        recheck_info, recheck_data = open_read_only(ssh_fd, AUTHORIZED_KEYS, uid, "file_unsafe")
        if recheck_info is None:
            fail("state_changed")
        if recheck_info.st_dev != file_info.st_dev or recheck_info.st_ino != file_info.st_ino:
            fail("state_changed")
        if hashlib.sha256(recheck_data).hexdigest() != expected["fileDigest"]:
            fail("state_changed")
        recheck_entries = parse_entries(recheck_data)
        if recheck_entries is None:
            fail("malformed_keys")
        if any(entry[0] == key_type and entry[1] == blob for entry in recheck_entries):
            fail("state_changed")
        write_all(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_dir(ssh_fd)
    return backup_name


def apply(uid, name, home, key_type, blob, expected):
    current = inspect(uid, name, home, key_type, blob)
    compare_expected(expected, current)
    home_fd, home_info = open_home(home, uid)
    try:
        if (
            home_info.st_uid != expected["homeUid"]
            or home_info.st_mode & 0o7777 != expected["homeMode"]
            or home_info.st_dev != expected["homeDev"]
            or home_info.st_ino != expected["homeIno"]
        ):
            fail("state_changed")
        if current["alreadyPresent"]:
            return {"ok": True, "status": "alreadyPresent", "backupPath": None}
        ssh_fd = open_dir(SSH_DIR, "ssh_unsafe", home_fd)
        created_dir = False
        if ssh_fd is None:
            if expected["sshExists"]:
                fail("state_changed")
            try:
                os.mkdir(SSH_DIR, 0o700, dir_fd=home_fd)
            except FileExistsError:
                fail("newfile_exists")
            except OSError:
                fail("io_error")
            created_dir = True
            ssh_fd = open_dir(SSH_DIR, "ssh_unsafe", home_fd)
            if ssh_fd is None:
                fail("io_error")
            os.fchmod(ssh_fd, 0o700)
            info = check_dir(ssh_fd, uid, "ssh_unsafe")
            if info.st_mode & 0o7777 != 0o700:
                fail("ssh_unsafe")
        else:
            info = check_dir(ssh_fd, uid, "ssh_unsafe")
            if (
                info.st_uid != expected["sshUid"]
                or info.st_mode & 0o7777 != expected["sshMode"]
                or info.st_dev != expected["sshDev"]
                or info.st_ino != expected["sshIno"]
            ):
                fail("state_changed")
        try:
            if not current["fileExists"]:
                create_new_file(ssh_fd, uid, key_type, blob)
                if created_dir:
                    sync_dir(home_fd)
                return {"ok": True, "status": "installed", "backupPath": None}
            backup = append_existing(ssh_fd, uid, key_type, blob, expected)
            if created_dir:
                sync_dir(home_fd)
            return {
                "ok": True,
                "status": "installed",
                "backupPath": os.path.join(home, SSH_DIR, backup) if backup else None,
            }
        finally:
            os.close(ssh_fd)
    finally:
        os.close(home_fd)


def main():
    require_platform()
    mode, key_type, blob, expected = read_request()
    uid, name, home = current_account()
    if mode == "review":
        emit({"ok": True, "snapshot": inspect(uid, name, home, key_type, blob)})
        return
    emit(apply(uid, name, home, key_type, blob, expected))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        fail("io_error")
