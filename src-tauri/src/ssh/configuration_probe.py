"""One-shot, projected configuration evidence. No requested writes, sudo, external network probes or scans."""
import base64
import binascii
import hashlib
import ipaddress
import json
import os
import platform
import re
import selectors
import shutil
import socket
import stat
import struct
import subprocess
import sys
import time

LIMIT = 32768
PER_PROCESS_SECONDS = 3.0
PROBE_BUDGET_SECONDS = 25.0
OUTPUT_BUDGET = 120 * 1024
ACCOUNT_LIMIT = 16
AUTHORIZED_KEY_LIMIT = 32
AUTHORIZED_KEYS_BYTES = 262144
LOCAL_FILE_BYTES = 65536
UPDATES_FILE = "/var/lib/update-notifier/updates-available"
UPDATE_STAMP = "/var/lib/apt/periodic/update-success-stamp"
ESSENTIAL_PACKAGES = ("git", "curl", "tar", "unzip", "ca-certificates")
SECURITY_PACKAGES = ("ufw", "fail2ban", "unattended-upgrades", "openssh-server")
DOCKER_PACKAGES = ("docker.io", "docker-ce", "docker-ce-cli", "docker-compose-plugin",
                   "docker-compose-v2", "containerd.io")
INCOMPLETE_PACKAGE_STATES = {"unknown", "half-installed", "unpacked", "half-configured",
                             "triggers-awaited", "triggers-pending"}
SYSTEMD_UNITS = ("ssh.service", "sshd.service", "ssh.socket", "sshd.socket",
                 "fail2ban.service", "unattended-upgrades.service", "apt-daily-upgrade.timer")
SYSTEMD_FIELDS = ("Id", "LoadState", "ActiveState", "UnitFileState", "FragmentPath",
                  "DropInPaths", "Listen", "NextElapseUSecRealtime", "LastTriggerUSec")
SUPPORTED_KEY_TYPES = ("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256",
                       "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
                       "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com")
CERT_SUFFIX = "-cert-v01@openssh.com"
NON_INTERACTIVE_SHELLS = ("", "/bin/false", "/usr/bin/false", "/bin/sync", "/usr/bin/sync",
                          "/bin/true", "/usr/bin/true", "/sbin/nologin", "/usr/sbin/nologin")

_deadline = None
_packages = None
_ownership = None
_systemd = None
_updates = None
_detected = None
_local = None
_authenticated_user = None


def reset_state():
    global _deadline, _packages, _ownership, _systemd, _updates, _detected, _local, _authenticated_user
    _deadline = time.monotonic() + PROBE_BUDGET_SECONDS
    _packages = None
    _ownership = None
    _systemd = None
    _updates = None
    _detected = None
    _local = None
    _authenticated_user = None


def read_native_context(stream):
    try:
        raw = stream.read(1025)
        if len(raw) > 1024:
            return None
        context = json.loads(raw)
        name = context.get("authenticatedUser") if isinstance(context, dict) else None
        return name if isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", name) else None
    except (OSError, ValueError, UnicodeError):
        return None


def budget_remaining():
    global _deadline
    if _deadline is None:
        _deadline = time.monotonic() + PROBE_BUDGET_SECONDS
    return max(0.0, _deadline - time.monotonic())


def budget_exhausted():
    return budget_remaining() <= 0.05


def printable(value, limit):
    text = str(value)
    if any(not character.isprintable() for character in text):
        text = " ".join(text.split())
    text = "".join(character for character in text if character.isprintable()).strip()
    return text[:limit]


def tool(name):
    # Execute system tools only, never a current-directory/user PATH replacement.
    return next((p for root in ("/usr/bin", "/usr/sbin", "/bin", "/sbin")
                 if os.path.isfile(p := root + "/" + name) and os.access(p, os.X_OK)), None)


def run(args, accepted_exit=()):
    if not args or not isinstance(args[0], str) or not os.path.isabs(args[0]):
        return None
    remaining = budget_remaining()
    if remaining <= 0.05:
        return None
    deadline = time.monotonic() + min(PER_PROCESS_SECONDS, remaining)
    try:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env={**os.environ, "LC_ALL": "C"})
    except (OSError, ValueError):
        return None
    data = bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                wait = deadline - time.monotonic()
                if wait <= 0 or not selector.select(wait):
                    return None
                chunk = os.read(process.stdout.fileno(), 4096)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > LIMIT:
                    return None
        code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        if code != 0 and code not in accepted_exit:
            return None
        return data.decode("utf-8", errors="strict")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


def read(path):
    try:
        with open(path, encoding="utf-8") as stream:
            value = stream.read(LIMIT + 1)
        return value if len(value) <= LIMIT else None
    except (OSError, UnicodeError):
        return None


def read_bounded_file(path, limit):
    try:
        with open(path, "rb") as stream:
            data = stream.read(limit + 1)
    except OSError:
        return None, "unavailable"
    if len(data) > limit:
        return data[:limit].decode("utf-8", errors="replace"), "truncated"
    try:
        return data.decode("utf-8", errors="strict"), "ok"
    except UnicodeError:
        return data.decode("utf-8", errors="replace"), "invalid-encoding"


def read_regular_no_follow(path, limit):
    try:
        before = os.lstat(path)
    except FileNotFoundError:
        return b"", "missing", None
    except OSError:
        return b"", "unavailable", None
    if stat.S_ISLNK(before.st_mode):
        return b"", "symlink", before
    if not stat.S_ISREG(before.st_mode):
        return b"", "special", before
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                             | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return b"", "unavailable", None
    info = before
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return b"", "special", info
        chunks = bytearray()
        while len(chunks) <= limit:
            chunk = os.read(descriptor, min(4096, limit + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        if len(chunks) > limit:
            return bytes(chunks[:limit]), "truncated", info
        return bytes(chunks), "ok", info
    except OSError:
        return b"", "unavailable", info
    finally:
        os.close(descriptor)


def regular_mtime(path):
    try:
        info = os.lstat(path)
    except OSError:
        return None
    return int(info.st_mtime) if stat.S_ISREG(info.st_mode) else None


def evidence(id, title, values, state="ready", message=None):
    projected = {}
    changed = False
    for raw_key, raw_value in values.items():
        key = printable(raw_key, 80)
        value = printable(raw_value, 512)
        if not key:
            changed = True
            continue
        if key != str(raw_key) or len(str(raw_key)) > 80:
            changed = True
        if value != str(raw_value) or len(str(raw_value)) > 512:
            changed = True
        if key in projected:
            changed = True
            continue
        projected[key] = value
    if len(projected) > 110:
        projected = dict(list(projected.items())[:110])
        changed = True
    if changed and state == "ready":
        state = "partial"
    if changed:
        message = (message or "") + " Some values were normalized or truncated; evidence is incomplete."
    message = printable(message, 1024) if message else None
    return {"id": id, "title": printable(title, 80), "state": state,
            "values": projected, "message": message}


def os_values(text):
    result = {}
    for line in (text or "").splitlines():
        key, sep, value = line.partition("=")
        if sep and key in ("PRETTY_NAME", "ID", "VERSION_ID"):
            result[key] = value.strip().strip('"').strip("'")
    return result


def system():
    release = os_values(read("/etc/os-release"))
    zone = read("/etc/timezone")
    if not zone:
        try:
            zone = os.path.realpath("/etc/localtime").split("/zoneinfo/", 1)[1]
        except (OSError, IndexError):
            zone = "Unknown"
    package_manager = ("dpkg/apt detected" if tool("dpkg-query")
                       else "Unsupported or unknown; only Debian package records are read")
    return evidence("system", "System", {
        "Operating system": release.get("PRETTY_NAME", "Unknown"),
        "Distribution": release.get("ID", "Unknown"),
        "Version": release.get("VERSION_ID", "Unknown"),
        "Architecture": platform.machine(), "Hostname": socket.gethostname(),
        "Timezone": zone.strip(), "Package manager": package_manager,
        "Package updates": "Cached update evidence is reported under Security; no package index refresh was performed",
        "Management support": "Read-only detection; no change capability certified",
    }, "ready" if release else "partial", "Existing configuration is preserved. Updates require a separate reviewed check.")


def package_snapshot():
    global _packages
    if _packages is not None:
        return _packages
    names = ESSENTIAL_PACKAGES + SECURITY_PACKAGES + DOCKER_PACKAGES
    binary = tool("dpkg-query")
    result = {"supported": bool(binary), "complete": False, "reason": None, "packages": {}}
    if not binary:
        result["reason"] = "dpkg-query not found; other package systems are unsupported"
        _packages = result
        return result
    output = run([binary, "-W", "-f=${binary:Package}\\t${db:Status-Status}\\t${Version}\\n"]
                 + list(names), accepted_exit=(1,))
    if output is None:
        result["reason"] = ("package query unavailable or probe budget exhausted"
                            if budget_exhausted() else "package query unavailable")
        _packages = result
        return result
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) != 3:
            continue
        raw_name, status, version = (field.strip() for field in fields)
        name = raw_name.split(":", 1)[0]
        if name not in names:
            continue
        if status not in ("installed", "not-installed", "config-files", "half-installed",
                          "unpacked", "half-configured", "triggers-awaited", "triggers-pending"):
            status = "unknown"
        result["packages"][name] = {"status": status, "version": printable(version, 512)}
    result["complete"] = (all(name in result["packages"] for name in names)
                          and not any(record["status"] in INCOMPLETE_PACKAGE_STATES
                                      for record in result["packages"].values()))
    _packages = result
    return result


def packages_complete(names):
    snapshot = package_snapshot()
    if not snapshot["supported"]:
        return False
    return all(name in snapshot["packages"]
               and snapshot["packages"][name]["status"] not in INCOMPLETE_PACKAGE_STATES
               for name in names)


def package_display(name):
    snapshot = package_snapshot()
    if not snapshot["supported"]:
        return "Unknown; dpkg-query unavailable (other package systems are unsupported)"
    record = snapshot["packages"].get(name)
    if not record:
        return "Unknown; no package record returned (not proof it is absent)"
    status, version = record["status"], record["version"]
    if status == "installed":
        return "Installed" + (" version " + version if version else "")
    if status == "not-installed":
        return "Not installed (package record present)"
    if status == "config-files":
        return "Removed; configuration files remain"
    if status == "unknown":
        return "Unknown package state (not interpreted)"
    return "Package state " + status + " (incomplete)"


def valid_display_path(path):
    return (isinstance(path, str) and os.path.isabs(path) and 1 <= len(path) <= 512
            and all(character.isprintable() for character in path))


def safe_search_path(path):
    return (valid_display_path(path)
            and not any(character in path for character in "*?[\\"))


def safe_component(component):
    return (isinstance(component, str) and component not in ("", ".", "..")
            and "/" not in component and all(character.isprintable() for character in component))


def one_hop(path):
    try:
        if not os.path.islink(path):
            return None
        target = os.readlink(path)
    except OSError:
        return None
    if not os.path.isabs(target):
        target = os.path.join(os.path.dirname(path), target)
    target = os.path.normpath(target)
    return target if valid_display_path(target) and target != path else None


def detected_executables():
    global _detected
    if _detected is not None:
        return _detected
    found = {}
    for name in ("git", "curl", "tar", "unzip"):
        path = shutil.which(name)
        if path:
            path = os.path.normpath(path)
            if valid_display_path(path):
                found[name] = path
    docker = tool("docker")
    if docker and valid_display_path(docker):
        found["docker"] = os.path.normpath(docker)
    _detected = found
    return found


def parse_ownership(output, requested):
    owners = {}
    for line in (output or "").splitlines():
        owner_text, sep, path = line.rpartition(": ")
        if not sep:
            continue
        path = path.strip()
        if path not in requested:
            continue
        names = []
        for item in owner_text.split(","):
            item = item.strip()
            if re.fullmatch(r"[a-z0-9][a-z0-9+.-]{0,63}(?::[a-z0-9-]+)?", item) and item not in names:
                names.append(item)
        if names:
            owners[path] = names
    return owners


def ownership_snapshot():
    global _ownership
    if _ownership is not None:
        return _ownership
    detected = detected_executables()
    requested, unsafe = {}, {}
    for label, path in detected.items():
        if not safe_search_path(path):
            unsafe[label] = path
            continue
        requested.setdefault(path, []).append(label)
        hop = one_hop(path)
        if hop and safe_search_path(hop):
            requested.setdefault(hop, []).append(label)
    binary = tool("dpkg-query")
    result = {"supported": bool(binary), "requested": requested, "unsafe": unsafe,
              "owners": {}, "reason": None}
    if not binary:
        result["reason"] = "dpkg-query not found; executable ownership is unverified"
        _ownership = result
        return result
    if not requested:
        result["reason"] = ("detected paths contain dpkg glob characters; ownership was not queried"
                            if unsafe else "no detected executables to query")
        _ownership = result
        return result
    output = run([binary, "-S"] + sorted(requested), accepted_exit=(1,))
    if output is None:
        result["reason"] = ("ownership query unavailable or probe budget exhausted"
                            if budget_exhausted() else "ownership query unavailable")
        _ownership = result
        return result
    result["owners"] = parse_ownership(output, set(requested))
    _ownership = result
    return result


def ownership_exact(label):
    path = detected_executables().get(label)
    if not path or not safe_search_path(path):
        return False
    snapshot = ownership_snapshot()
    if path in snapshot["owners"]:
        return True
    hop = one_hop(path)
    return bool(hop and safe_search_path(hop) and hop in snapshot["owners"])


def ownership_display(label):
    path = detected_executables().get(label)
    if not path:
        return "Not detected"
    if not safe_search_path(path):
        return ("Observed at " + path + "; ownership unverified because the path contains "
                "dpkg glob characters and was not used as a search pattern")
    snapshot = ownership_snapshot()
    if not snapshot["supported"]:
        return "Unverified; dpkg-query unavailable (other package systems are unsupported)"
    direct = snapshot["owners"].get(path)
    if direct:
        return "Package " + ", ".join(direct) + " (exact path " + path + ")"
    hop = one_hop(path)
    if hop and safe_search_path(hop) and snapshot["owners"].get(hop):
        return ("Package " + ", ".join(snapshot["owners"][hop]) + " (exact path " + hop
                + ", one symlink hop from " + path + ")")
    if snapshot["reason"]:
        return "Unverified; " + snapshot["reason"]
    return "Unverified; no exact package ownership match (not proof the file is unowned)"


def essentials():
    detected = detected_executables()
    values = {name.capitalize(): detected.get(name) or "Not found in this user's PATH"
              for name in ("git", "curl", "tar", "unzip")}
    values["CA certificate bundle"] = next((p for p in (
        "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt")
        if os.path.isfile(p)), "Not found in standard locations")
    values["attention"] = str(any(name not in detected for name in ("git", "curl", "tar", "unzip"))).lower()
    for name in ESSENTIAL_PACKAGES:
        values["Package " + name] = package_display(name)
    for name in ("git", "curl", "tar", "unzip"):
        if name in detected:
            values[name.capitalize() + " executable ownership"] = ownership_display(name)
    values["Running status"] = "Installation does not prove a process is running or in use"
    detected_essentials = [name for name in ("git", "curl", "tar", "unzip") if name in detected]
    ownership = ownership_snapshot()
    state = "ready" if packages_complete(ESSENTIAL_PACKAGES) else "partial"
    if not ownership["supported"] or any(not ownership_exact(name) for name in detected_essentials):
        state = "partial"
    if budget_exhausted():
        state = "partial"
    return evidence("essentials", "Essential software", values, state,
                    "Executable presence does not establish package ownership, version or trust. "
                    "Package installation does not prove a process is running.")


def resources():
    text = read("/proc/meminfo") or ""
    fields = dict(re.findall(r"^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$", text, re.M))
    values = {name: fields.get(key, "Unknown") + (" KiB" if key in fields else "") for name, key in (
        ("Memory total", "MemTotal"), ("Memory available", "MemAvailable"),
        ("Swap total", "SwapTotal"), ("Swap free", "SwapFree"))}
    try:
        statvfs = os.statvfs("/")
        values["Root capacity"] = str(statvfs.f_blocks * statvfs.f_frsize) + " bytes"
        values["Root available"] = str(statvfs.f_bavail * statvfs.f_frsize) + " bytes"
    except OSError:
        values["Root capacity"] = "Unknown"
    return evidence("resources", "System resources", values, "ready" if len(fields) == 4 else "partial",
                    "One-shot counters and root filesystem capacity. No directory traversal or disk changes.")


def cached_updates():
    global _updates
    if _updates is not None:
        return _updates
    data, status, info = read_regular_no_follow(UPDATES_FILE, 4096)
    result = {"count": None, "security": None, "mtime": None, "stamp": None,
              "status": status, "stamp_status": "missing"}
    if status in ("ok", "truncated"):
        if info is not None:
            result["mtime"] = int(info.st_mtime)
        text = data.decode("utf-8", errors="replace")
        count = re.search(r"(?im)^\s*(\d{1,6})\s+updates?\s+can\s+be\s+applied", text)
        if count:
            result["count"] = int(count.group(1))
        security = re.search(r"(?im)^\s*(\d{1,6})\s+(?:of\s+these\s+)?updates?\s+(?:are|is)\s+security\s+updates?", text)
        if security:
            result["security"] = int(security.group(1))
    stamp = regular_mtime(UPDATE_STAMP)
    if stamp is not None:
        result["stamp"] = stamp
        result["stamp_status"] = "ok"
    _updates = result
    return result


def age_text(mtime):
    if mtime is None:
        return "Unknown"
    now = int(time.time())
    try:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime))
    except (OSError, ValueError, OverflowError):
        return "Unrecognized timestamp (age unavailable)"
    if mtime > now:
        return stamp + " (future timestamp; age unknown, clock skew possible)"
    age = max(0, now - mtime)
    return stamp + " (age " + str(age) + "s)"


def update_values():
    updates = cached_updates()
    truncated = updates["status"] == "truncated"
    values = {}
    if updates["count"] is None:
        values["Cached updates"] = (
            "Unknown; cached file was truncated and no recognized numeric count was available "
            "(not zero updates)" if truncated
            else "Unknown; no recognized numeric count in the local cache (not zero updates)")
    elif truncated:
        values["Cached updates"] = (str(updates["count"]) + " reported by a truncated cached file; "
                                    "incomplete, not a current package check")
    else:
        values["Cached updates"] = (str(updates["count"])
                                    + " reported by cached metadata; not a current package check")
    if updates["security"] is None:
        values["Cached security updates"] = (
            "Unknown; cached file was truncated and no recognized numeric security count was available"
            if truncated else "Unknown; no recognized numeric security count")
    elif truncated:
        values["Cached security updates"] = (str(updates["security"])
                                             + " reported by a truncated cached file; "
                                             "incomplete, not a current package check")
    else:
        values["Cached security updates"] = (str(updates["security"])
                                             + " reported by cached metadata; not a current package check")
    if updates["status"] in ("ok", "truncated"):
        values["Update cache source"] = (UPDATES_FILE + " (cached; "
                                         + ("read was truncated; evidence is incomplete"
                                            if truncated else "bounded read") + ")")
    else:
        values["Update cache source"] = ("Unavailable; " + updates["status"]
                                         + " (unknown, not zero updates)")
    if truncated:
        values["Update cache completeness"] = "Incomplete; cached file was truncated"
    elif updates["status"] == "ok":
        if updates["count"] is None and updates["security"] is None:
            values["Update cache completeness"] = "No recognized numeric count in the bounded cached read"
        else:
            values["Update cache completeness"] = "Bounded cached read; not a current package check"
    else:
        values["Update cache completeness"] = "Unknown; cached file is missing or unreadable"
    if updates["mtime"] is None:
        values["Update cache age"] = "Unknown; cached file timestamp unavailable"
    else:
        values["Update cache age"] = ("mtime " + age_text(updates["mtime"])
                                      + "; cached observation, not current")
    if updates["stamp"] is None:
        values["Update index stamp"] = ("Unknown; " + UPDATE_STAMP
                                        + " not found or not a regular file; no package index refresh was performed")
    else:
        values["Update index stamp"] = ("mtime " + age_text(updates["stamp"])
                                        + "; cached timestamp, not a current check")
    return values


def safe_state(value):
    value = printable(value, 64)
    return (value if len(value) <= 32 and re.fullmatch(r"[a-z][a-z0-9-]{0,31}", value)
            else "Unrecognized (not interpreted)")


def safe_listen(value):
    value = printable(value, 512)
    return (value if value and len(value) <= 160
            and re.fullmatch(r"[0-9A-Fa-f:.,\[\]%_/* -]{1,160}", value)
            else "Unrecognized socket data")


def safe_timer(value):
    value = printable(value, 32)
    if value in ("", "n/a"):
        return "n/a"
    return value if re.fullmatch(r"\d{1,18}", value) else "Unrecognized"


def safe_path(value):
    value = printable(value, 512)
    return value if re.fullmatch(r"/[A-Za-z0-9._/@:+-]{0,510}", value) else "Unrecognized path"


def parse_systemd_show(output):
    units = {}
    current = None
    pending = {}
    for line in (output or "").splitlines():
        if not line.strip():
            current = None
            pending = {}
            continue
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        if key == "Id":
            unit = value.strip()
            current = unit if unit in SYSTEMD_UNITS else None
            if current:
                units[current] = pending
            pending = {}
            continue
        if key not in SYSTEMD_FIELDS:
            continue
        if current is not None:
            units[current][key] = value.strip()
        else:
            pending[key] = value.strip()
    return units


def systemd_unit_value(unit, units):
    data = units.get(unit)
    if not data:
        return "Not reported by systemd (unit may be absent or access-limited)"
    parts = []
    for field in ("LoadState", "ActiveState", "UnitFileState"):
        if field in data:
            parts.append(field + "=" + safe_state(data[field]))
    if data.get("FragmentPath"):
        parts.append("fragment=" + safe_path(data["FragmentPath"]))
    if data.get("DropInPaths", "").strip():
        parts.append("drop-ins present (contents not read)")
    else:
        parts.append("no drop-ins reported")
    if unit.endswith(".socket") and data.get("Listen"):
        parts.append("Listen=" + safe_listen(data["Listen"]))
    if unit.endswith(".timer"):
        if data.get("NextElapseUSecRealtime"):
            parts.append("next=" + safe_timer(data["NextElapseUSecRealtime"]))
        if data.get("LastTriggerUSec"):
            parts.append("last=" + safe_timer(data["LastTriggerUSec"]))
    return "; ".join(parts) if parts else "Reported without recognized state fields"


def ssh_activation_model(units):
    service_active = any(units.get(unit, {}).get("ActiveState") == "active"
                         for unit in ("ssh.service", "sshd.service"))
    socket_active = any(units.get(unit, {}).get("ActiveState") == "active"
                        for unit in ("ssh.socket", "sshd.socket"))
    if service_active and socket_active:
        return ("Both service and socket units report active; this does not prove this "
                "connection's activation path")
    if socket_active:
        return ("Socket unit reports active; this does not prove this connection used "
                "socket activation")
    if service_active:
        return ("Service unit reports active; this does not prove this connection used "
                "the service unit")
    if any(units.get(unit, {}).get("LoadState") == "loaded"
           for unit in ("ssh.service", "sshd.service", "ssh.socket", "sshd.socket")):
        return "Units loaded, but no active SSH service or socket was observed"
    return "Unknown; no active SSH service or socket evidence"


def ssh_dropin_summary(units):
    checked = [unit for unit in ("ssh.service", "sshd.service", "ssh.socket", "sshd.socket")
               if unit in units]
    if not checked:
        return ("Unknown; no SSH units reported by systemd" if units
                else "Unknown; systemd evidence unavailable")
    present = [unit for unit in checked if units[unit].get("DropInPaths", "").strip()]
    if present:
        return "Drop-ins present for " + ", ".join(present) + "; contents were not read"
    return "No drop-ins reported for checked SSH units"


def systemd_values(units, available):
    values = {}
    for unit in ("ssh.service", "sshd.service", "ssh.socket", "sshd.socket"):
        values["SSH unit " + unit] = (systemd_unit_value(unit, units) if available
                                      else "Unknown; systemd evidence unavailable")
    values["SSH activation model"] = (ssh_activation_model(units) if available
                                      else "Unknown; systemd evidence unavailable")
    values["SSH drop-ins"] = (ssh_dropin_summary(units) if available
                              else "Unknown; systemd evidence unavailable")
    for unit in ("fail2ban.service", "unattended-upgrades.service", "apt-daily-upgrade.timer"):
        values["Security unit " + unit] = (systemd_unit_value(unit, units) if available
                                           else "Unknown; systemd evidence unavailable")
    return values


def ssh_systemd_values(snapshot):
    return {key: value for key, value in snapshot["values"].items() if key.startswith("SSH ")}


def security_systemd_values(snapshot):
    return {key: value for key, value in snapshot["values"].items()
            if key.startswith("Security unit ")}


def systemd_snapshot():
    global _systemd
    if _systemd is not None:
        return _systemd
    binary = tool("systemctl")
    if not binary:
        _systemd = {"available": False, "units": {}, "values": systemd_values({}, False),
                    "reason": "systemctl not found"}
        return _systemd
    output = run([binary, "show", "--no-pager"]
                 + ["--property=" + field for field in SYSTEMD_FIELDS] + list(SYSTEMD_UNITS),
                 accepted_exit=(1,))
    if output is None:
        _systemd = {"available": False, "units": {}, "values": systemd_values({}, False),
                    "reason": ("systemd query unavailable or probe budget exhausted"
                               if budget_exhausted() else "systemd query unavailable")}
        return _systemd
    units = parse_systemd_show(output)
    available = bool(units)
    _systemd = {"available": available, "units": units, "values": systemd_values(units, available),
                "reason": None if available else "no recognized units returned"}
    return _systemd


def fail2ban_jail_count():
    binary = tool("fail2ban-client")
    if not binary:
        return None, "fail2ban-client not found"
    output = run([binary, "status"])
    if output is None:
        return None, "status unavailable without additional privileges or probe budget exhausted"
    match = re.search(r"(?im)^\s*(?:[|`]-)?\s*Number of jail:\s*(\d{1,6})", output)
    if match:
        return int(match.group(1)), None
    match = re.search(r"(?im)^\s*(?:[|`]-)?\s*Jail list:\s*(.*)$", output)
    if match and len(match.group(1)) <= 4096:
        names = [item.strip() for item in match.group(1).split(",") if item.strip()]
        if len(names) <= 1000:
            return len(names), None
    return None, "unrecognized status output (not interpreted)"


def apt_periodic_values():
    binary = tool("apt-config")
    result = {"unattended": None, "update_lists": None, "reason": None}
    if not binary:
        result["reason"] = "apt-config not found"
        return result
    output = run([binary, "shell", "UNATTENDED_UPGRADE", "APT::Periodic::Unattended-Upgrade",
                  "UPDATE_PACKAGE_LISTS", "APT::Periodic::Update-Package-Lists"])
    if output is None:
        result["reason"] = ("apt-config query unavailable or probe budget exhausted"
                            if budget_exhausted() else "apt-config query unavailable")
        return result
    for line in output.splitlines():
        match = re.match(r"\s*([A-Z_][A-Z0-9_]*)=['\"]?([^'\"\s;]*)['\"]?;?\s*$", line)
        if not match:
            continue
        name, value = match.group(1), match.group(2).strip()
        if name not in ("UNATTENDED_UPGRADE", "UPDATE_PACKAGE_LISTS") or not value:
            continue
        parsed = value if re.fullmatch(r"\d{1,4}|always", value, re.I) else "Unrecognized value (not interpreted)"
        if name == "UNATTENDED_UPGRADE":
            result["unattended"] = parsed
        else:
            result["update_lists"] = parsed
    if result["unattended"] is None and result["update_lists"] is None:
        result["reason"] = "no recognized periodic configuration values"
    return result


def security():
    values = {
        "UFW installed": "Yes" if tool("ufw") else "Not found in standard system paths",
        "Fail2ban installed": "Yes" if tool("fail2ban-client") else "Not found in standard system paths",
        "UFW package": package_display("ufw"),
        "Fail2ban package": package_display("fail2ban"),
        "Unattended-upgrades package": package_display("unattended-upgrades"),
        "OpenSSH server package": package_display("openssh-server"),
    }
    try:
        values.update(security_systemd_values(systemd_snapshot()))
    except Exception:
        values["Security unit evidence"] = "Unknown; systemd evidence could not be projected"
    values.update(update_values())
    jails, reason = fail2ban_jail_count()
    values["Fail2ban jails"] = (str(jails) + " reported by status (jail names and contents not retained)"
                                if jails is not None else "Unknown; " + (reason or "status unavailable"))
    apt = apt_periodic_values()
    values["Unattended upgrade configuration"] = (apt["unattended"] or
                                                  "Unknown; key not set or apt-config unavailable")
    values["Update package lists configuration"] = (apt["update_lists"] or
                                                    "Unknown; key not set or apt-config unavailable")
    if apt["reason"]:
        values["Periodic update configuration"] = apt["reason"]
    values["Security coverage"] = ("Installation, cached metadata, configuration, service and timer "
                                   "observations do not certify active protection or coverage. "
                                   "Unknown does not imply disabled.")
    return evidence("security", "Security", values, "partial",
                    "No sudo, package index refresh or external network probe was requested. Installation is "
                    "separate from service/timer activity; none proves protection.")


def docker():
    detected = detected_executables()
    binary = detected.get("docker") or tool("docker")
    version = run([binary, "--version"]) if binary else None
    values = {"CLI": binary or "Not found in standard system paths",
              "CLI version": printable(version.strip(), 256) if version else "Unknown",
              "Engine and Compose": "Open Docker for workload inventory and Compose evidence",
              "attention": str(not binary).lower()}
    for name in DOCKER_PACKAGES:
        values["Package " + name] = package_display(name)
    if binary:
        values["Docker CLI executable ownership"] = ownership_display("docker")
    values["Running status"] = ("CLI version is not proof the daemon is running; no daemon query was made"
                                if version else "CLI runtime state unknown; no daemon query was made")
    state = "ready" if packages_complete(DOCKER_PACKAGES) else "partial"
    if binary and (version is None or not ownership_exact("docker")):
        state = "partial"
    if budget_exhausted():
        state = "partial"
    return evidence("docker", "Docker", values, state,
                    "No daemon queries, installation, upgrades or changes to existing workloads. "
                    "Installed packages do not prove the daemon is running.")


def valid_account_name(name):
    return bool(re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}", name))


def parse_passwd(text):
    accounts = {}
    for line in (text or "").splitlines():
        fields = line.split(":")
        if len(fields) < 7:
            continue
        name, _, uid, gid, _, home, shell = fields[:7]
        if not valid_account_name(name) or not uid.isdigit() or not gid.isdigit():
            continue
        uid_value, gid_value = int(uid), int(gid)
        if uid_value > 4294967294 or gid_value > 4294967294:
            continue
        accounts[name] = {"name": name, "uid": uid_value, "gid": gid_value,
                          "home": home, "shell": shell}
    return accounts


def parse_groups(text):
    by_gid = {}
    members = {}
    for line in (text or "").splitlines():
        fields = line.split(":")
        if len(fields) < 4:
            continue
        name, _, gid, member_text = fields[:4]
        if not valid_account_name(name) or not gid.isdigit():
            continue
        by_gid.setdefault(int(gid), name)
        members[name] = {member.strip() for member in member_text.split(",")
                         if valid_account_name(member.strip())}
    return by_gid, members


def account_field(account, by_gid, member_groups, group_ok):
    primary = by_gid.get(account["gid"], "unknown") if group_ok else "unknown (group file unavailable)"
    if group_ok:
        supplementary = sorted(name for name, members in member_groups.items()
                               if account["name"] in members and name != primary)
        shown = supplementary[:8]
        text = (account["name"] + ": UID " + str(account["uid"]) + "; primary group " + primary
                + "; supplementary groups " + (", ".join(shown) if shown else "none reported"))
        if len(supplementary) > 8:
            text += " (more groups omitted)"
        privileged = [name for name in [primary] + supplementary if name in ("sudo", "wheel")]
        if privileged:
            text += "; " + ", ".join(privileged) + " membership reported (not proof of sudo privilege)"
    else:
        text = (account["name"] + ": UID " + str(account["uid"])
                + "; primary group unknown; group membership unknown")
    return printable(text, 512)


def project_accounts(passwd_text, group_text, current_uid, passwd_status="ok", group_status="ok", current_name=None):
    if passwd_text is None:
        return {"values": {}, "complete": False,
                "coverage": ("Unknown; /etc/passwd is unavailable. No local accounts were enumerated. "
                             "No network directory service enumeration was performed.")}
    accounts = parse_passwd(passwd_text)
    group_ok = group_text is not None
    by_gid, member_groups = parse_groups(group_text or "")
    matches = [account for account in accounts.values() if account["uid"] == current_uid]
    current = accounts.get(current_name) if current_name else (matches[0] if len(matches) == 1 else None)
    if current is not None and current["uid"] != current_uid:
        current = None
    uid_zero = sorted((account for account in accounts.values() if account["uid"] == 0),
                      key=lambda account: account["name"])
    sudo_members = set()
    if group_ok:
        for group in ("sudo", "wheel"):
            sudo_members.update(member_groups.get(group, set()))
    interactive = sorted((account for account in accounts.values()
                          if account["uid"] >= 1000 and account["shell"].startswith("/")
                          and account["shell"] not in NON_INTERACTIVE_SHELLS),
                         key=lambda account: account["name"])
    ordered, seen = [], set()

    def add(account):
        if account and account["name"] not in seen:
            seen.add(account["name"])
            ordered.append(account)

    add(current)
    for account in uid_zero:
        add(account)
    for name in sorted(sudo_members):
        add(accounts.get(name))
    for account in interactive:
        add(account)
    shown = ordered[:ACCOUNT_LIMIT]
    values = {"Local account " + str(index): account_field(account, by_gid, member_groups, group_ok)
              for index, account in enumerate(shown, start=1)}
    limited = len(ordered) > ACCOUNT_LIMIT
    coverage = ("Bounded local /etc/passwd and /etc/group reads only; current user, "
                + str(len(uid_zero)) + " UID 0 account(s), " + str(len(sudo_members))
                + " explicit sudo/wheel member(s), " + str(len(interactive))
                + " interactive local user(s); showing " + str(len(shown)) + " of "
                + str(len(ordered)) + " selected (limit " + str(ACCOUNT_LIMIT) + "). "
                + "Group membership is not proof of sudo privilege. "
                + "No network directory service enumeration was performed.")
    if current is None:
        coverage += (" The authenticated UID was not found in the bounded local passwd file; "
                     "identity and home evidence are unavailable and no NSS/getent fallback was used.")
    if passwd_status != "ok" or group_status != "ok":
        coverage += (" Local file evidence is " + passwd_status + "/" + group_status
                     + " and may be incomplete.")
    return {"values": values, "coverage": coverage,
            "complete": not limited and passwd_status == "ok" and group_status == "ok"}


def local_snapshot():
    global _local
    if _local is not None:
        return _local
    passwd_text, passwd_status = read_bounded_file("/etc/passwd", LOCAL_FILE_BYTES)
    group_text, group_status = read_bounded_file("/etc/group", LOCAL_FILE_BYTES)
    accounts = parse_passwd(passwd_text) if passwd_text is not None else {}
    current = accounts.get(_authenticated_user) if _authenticated_user and passwd_status == "ok" else None
    if current is not None and current["uid"] != os.getuid():
        current = None
    _local = {"passwd": passwd_text, "passwd_status": passwd_status,
              "group": group_text, "group_status": group_status,
              "accounts": accounts, "current": current}
    return _local


def accounts_snapshot():
    local = local_snapshot()
    return project_accounts(local["passwd"], local["group"], os.getuid(),
                            local["passwd_status"], local["group_status"],
                            local["current"]["name"] if local["current"] else None)


def parse_ssh_strings(blob):
    strings, offset = [], 0
    while offset < len(blob):
        if offset + 4 > len(blob):
            return None
        length = struct.unpack(">I", blob[offset:offset + 4])[0]
        offset += 4
        if length > len(blob) - offset or length > 8192:
            return None
        strings.append(blob[offset:offset + length])
        offset += length
        if len(strings) > 16:
            return None
    return strings or None


def decode_base64_token(token):
    if not isinstance(token, str) or not token or len(token) > 16384:
        return None
    if len(token) % 4 != 0 or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", token):
        return None
    try:
        return base64.b64decode(token, validate=True)
    except (ValueError, binascii.Error):
        return None


def positive_mpint(data):
    if not data or data[0] & 0x80:
        return False
    if len(data) > 1 and data[0] == 0 and (data[1] & 0x80) == 0:
        return False
    return int.from_bytes(data, "big") > 0


def sec1_point(curve, data):
    sizes = {b"nistp256": 32, b"nistp384": 48, b"nistp521": 66}
    size = sizes.get(curve)
    if size is None or not data:
        return False
    if data[0] == 0x04:
        return len(data) == 1 + 2 * size
    if data[0] in (0x02, 0x03):
        return len(data) == 1 + size
    return False


def printable_application(data):
    return bool(data) and len(data) <= 256 and all(32 <= byte < 127 for byte in data)


def validate_public_blob(keytype, blob):
    strings = parse_ssh_strings(blob)
    if not strings:
        return False
    try:
        algorithm = strings[0].decode("ascii")
    except UnicodeDecodeError:
        return False
    if algorithm != keytype:
        return False
    if keytype == "ssh-ed25519":
        return len(strings) == 2 and len(strings[1]) == 32
    if keytype == "ssh-rsa":
        return (len(strings) == 3 and positive_mpint(strings[1])
                and positive_mpint(strings[2]))
    curves = {"ecdsa-sha2-nistp256": b"nistp256", "ecdsa-sha2-nistp384": b"nistp384",
              "ecdsa-sha2-nistp521": b"nistp521"}
    if keytype in curves:
        return (len(strings) == 3 and strings[1] == curves[keytype]
                and sec1_point(strings[1], strings[2]))
    if keytype == "sk-ssh-ed25519@openssh.com":
        return (len(strings) == 3 and len(strings[1]) == 32
                and printable_application(strings[2]))
    if keytype == "sk-ecdsa-sha2-nistp256@openssh.com":
        return (len(strings) == 4 and strings[1] == b"nistp256"
                and sec1_point(strings[1], strings[2])
                and printable_application(strings[3]))
    return False


def fingerprint(blob):
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")


def authorized_fields(line):
    tokens, current, quoted, escaped = [], [], False, False
    for character in line:
        if escaped:
            current.append(character)
            escaped = False
        elif character == "\\" and quoted:
            current.append(character)
            escaped = True
        elif character == '"':
            quoted = not quoted
            current.append(character)
        elif character.isspace() and not quoted:
            if current:
                tokens.append("".join(current))
                current = []
                if len(tokens) >= 3:
                    break
        else:
            current.append(character)
    if current and len(tokens) < 3:
        tokens.append("".join(current))
    return tokens


def looks_like_key_type(token):
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9@._+-]{0,63}", token))


def looks_like_base64(token):
    return (isinstance(token, str) and len(token) >= 16 and len(token) % 4 == 0
            and bool(re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", token)))


def classify_authorized_line(line):
    stripped = line.strip()
    if not stripped:
        return "blank", None, None, False
    if stripped.startswith("#"):
        return "comment", None, None, False
    if stripped.startswith("@"):
        return "marker", None, None, False
    tokens = authorized_fields(stripped)
    if not tokens:
        return "malformed", None, None, False
    for index in (0, 1):
        if index < len(tokens) and (tokens[index] in SUPPORTED_KEY_TYPES
                                    or tokens[index].endswith(CERT_SUFFIX)):
            if index + 1 >= len(tokens):
                return "malformed", None, None, index > 0
            return "entry", tokens[index], tokens[index + 1], index > 0
    if len(tokens) >= 2 and looks_like_key_type(tokens[0]) and looks_like_base64(tokens[1]):
        return "entry", tokens[0], tokens[1], False
    if len(tokens) >= 3 and looks_like_key_type(tokens[1]) and looks_like_base64(tokens[2]):
        return "entry", tokens[1], tokens[2], True
    return "malformed", None, None, False


def parse_authorized_keys_text(text):
    values = {}
    counts = {"framed": 0, "unsupported": 0, "malformed": 0, "duplicate": 0}
    seen, entries = {}, 0
    for line in (text or "").splitlines():
        kind, keytype, token, options = classify_authorized_line(line)
        if kind in ("blank", "comment"):
            continue
        entries += 1
        if kind == "marker":
            counts["unsupported"] += 1
            field = "Unsupported marker entry (not hashed)"
        elif kind == "malformed":
            counts["malformed"] += 1
            field = "Malformed public key entry rejected (not hashed)"
        elif keytype.endswith(CERT_SUFFIX):
            counts["unsupported"] += 1
            field = ("Unsupported SSH certificate entry (not hashed); "
                     + ("restricted options present" if options else "no restricted options"))
        elif keytype not in SUPPORTED_KEY_TYPES:
            counts["unsupported"] += 1
            field = ("Unsupported key type entry (not hashed); "
                     + ("restricted options present" if options else "no restricted options"))
        else:
            blob = decode_base64_token(token)
            if blob is None or not validate_public_blob(keytype, blob):
                counts["malformed"] += 1
                field = "Malformed public key entry rejected (not hashed)"
            else:
                value = fingerprint(blob)
                duplicate_of = seen.get(value)
                if duplicate_of is None:
                    seen[value] = entries
                else:
                    counts["duplicate"] += 1
                counts["framed"] += 1
                field = (keytype + "; " + value + "; "
                         + ("restricted options present" if options else "no restricted options"))
                if duplicate_of is not None:
                    field += "; duplicate of Authorized key " + str(duplicate_of)
        if field and entries <= AUTHORIZED_KEY_LIMIT:
            values["Authorized key " + str(entries)] = field
    coverage = ("Standard ~/.ssh/authorized_keys was read as a bounded, no-follow regular file; "
                + str(counts["framed"]) + " frame-valid, " + str(counts["unsupported"]) + " unsupported, "
                + str(counts["malformed"]) + " malformed, " + str(counts["duplicate"])
                + " duplicate entry(ies); " + str(min(entries, AUTHORIZED_KEY_LIMIT)) + " of "
                + str(entries) + " entries shown (limit " + str(AUTHORIZED_KEY_LIMIT) + "). "
                + "Comments and option values were not reported. SSH framing validation is not proof "
                + "of mathematical key validity or working login. The standard path may differ from "
                + "the running daemon's effective authorization source (AuthorizedKeysFile/"
                + "AuthorizedKeysCommand), and no key is proven to work until a separate independent "
                + "connection verifies it.")
    if entries > AUTHORIZED_KEY_LIMIT:
        coverage += " Entry cap reached; evidence is incomplete."
    return {"values": values, "coverage": coverage, "complete": entries <= AUTHORIZED_KEY_LIMIT}


def unknown_authorized_keys(reason):
    return {"values": {}, "complete": False,
            "coverage": ("Unknown; " + reason + ". This does not prove no keys are authorized. "
                         "The standard path may differ from the running daemon's effective "
                         "authorization source, and no key is proven to work until a separate "
                         "independent connection verifies it.")}


def rejected_authorized_keys(reason):
    return {"values": {}, "complete": False,
            "coverage": ("Rejected; " + reason + ". No key file was read, no symlink was followed "
                         "and no other user's key file was inspected. The standard path may differ "
                         "from the running daemon's effective authorization source.")}


def open_directory_chain(path):
    if not valid_display_path(path) or any(part == ".." for part in path.split("/")):
        return None, "unsafe", None
    flags = (os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
             | getattr(os, "O_NOFOLLOW", 0))
    if not getattr(os, "O_DIRECTORY", 0) or not getattr(os, "O_NOFOLLOW", 0):
        return None, "unsupported", None
    try:
        directory = os.open("/", flags)
    except OSError:
        return None, "unavailable", None
    for component in [part for part in path.split("/") if part not in ("", ".")]:
        if not safe_component(component):
            os.close(directory)
            return None, "unsafe", None
        try:
            next_directory = os.open(component, flags, dir_fd=directory)
        except FileNotFoundError:
            os.close(directory)
            return None, "missing", None
        except OSError:
            try:
                info = os.stat(component, dir_fd=directory, follow_symlinks=False)
            except OSError:
                info = None
            os.close(directory)
            if info is not None and stat.S_ISLNK(info.st_mode):
                return None, "component-symlink", info
            if info is not None and not stat.S_ISDIR(info.st_mode):
                return None, "component-special", info
            return None, "unavailable", info
        os.close(directory)
        directory = next_directory
        try:
            info = os.fstat(directory)
        except OSError:
            os.close(directory)
            return None, "unavailable", None
        if not stat.S_ISDIR(info.st_mode):
            os.close(directory)
            return None, "component-special", info
    try:
        return directory, "ok", os.fstat(directory)
    except OSError:
        os.close(directory)
        return None, "unavailable", None


def read_authorized_keys_file(home):
    directory, status, info = open_directory_chain(os.path.join(home, ".ssh"))
    if status != "ok":
        return b"", status, info
    try:
        if not getattr(os, "O_NOFOLLOW", 0):
            return b"", "unsupported", None
        file_flags = (os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                      | getattr(os, "O_NONBLOCK", 0))
        try:
            descriptor = os.open("authorized_keys", file_flags, dir_fd=directory)
        except FileNotFoundError:
            return b"", "missing-file", None
        except OSError:
            try:
                info = os.stat("authorized_keys", dir_fd=directory, follow_symlinks=False)
            except OSError:
                return b"", "unavailable", None
            if stat.S_ISLNK(info.st_mode):
                return b"", "file-symlink", info
            if not stat.S_ISREG(info.st_mode):
                return b"", "file-special", info
            return b"", "unavailable", info
        info = None
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                return b"", "file-special", info
            chunks = bytearray()
            while len(chunks) <= AUTHORIZED_KEYS_BYTES:
                chunk = os.read(descriptor, min(4096, AUTHORIZED_KEYS_BYTES + 1 - len(chunks)))
                if not chunk:
                    break
                chunks.extend(chunk)
            if len(chunks) > AUTHORIZED_KEYS_BYTES:
                return bytes(chunks[:AUTHORIZED_KEYS_BYTES]), "truncated", info
            return bytes(chunks), "ok", info
        except OSError:
            return b"", "unavailable", info
        finally:
            os.close(descriptor)
    finally:
        os.close(directory)


def authorized_keys_at(home):
    if not valid_display_path(home):
        return unknown_authorized_keys("current user home directory is unavailable")
    data, status, _ = read_authorized_keys_file(home)
    if status == "unsafe":
        return rejected_authorized_keys("home path contains unsafe components")
    if status == "unsupported":
        return rejected_authorized_keys("no-follow directory traversal is unsupported")
    if status == "component-symlink":
        return rejected_authorized_keys("home directory or ~/.ssh component is a symlink")
    if status == "component-special":
        return rejected_authorized_keys("home directory or ~/.ssh component is not a directory")
    if status == "missing":
        return unknown_authorized_keys("home directory or standard ~/.ssh directory is absent")
    if status == "unavailable":
        return unknown_authorized_keys("home directory or ~/.ssh directory is unreadable")
    if status == "missing-file":
        return unknown_authorized_keys("standard ~/.ssh/authorized_keys is absent")
    if status == "file-symlink":
        return rejected_authorized_keys("authorized_keys is a symlink")
    if status == "file-special":
        return rejected_authorized_keys("authorized_keys is not a regular file")
    if status not in ("ok", "truncated"):
        return unknown_authorized_keys("standard ~/.ssh/authorized_keys could not be read safely")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeError:
        return unknown_authorized_keys("standard ~/.ssh/authorized_keys is not valid UTF-8 text")
    result = parse_authorized_keys_text(text)
    if status == "truncated":
        result["coverage"] += " The file read reached its size bound; evidence is incomplete."
        result["complete"] = False
    return result


def authorized_keys_snapshot():
    local = local_snapshot()
    current = local["current"]
    if current is None:
        return unknown_authorized_keys(
            "native authenticated name and current UID could not be matched with complete local passwd metadata; "
            "no NSS fallback or another account's key file was used")
    home = current.get("home")
    if not isinstance(home, str) or not home:
        return unknown_authorized_keys(
            "local passwd entry for the authenticated UID has no usable home directory")
    return authorized_keys_at(home)


def ssh():
    local = local_snapshot()
    current_account = local["current"]
    user = current_account["name"] if current_account else "Unknown"
    values = {"Current user": user, "UID": str(os.getuid()),
              "Administrative privileges": ("Root account" if os.getuid() == 0
                                            else "Not verified; group membership is insufficient"),
              "Key authentication": "Not independently verified"}
    if current_account is None:
        values["Current user identity"] = ("Unavailable; native authenticated name and current UID could not be "
                                           "matched with complete local passwd metadata (no NSS/getent fallback)")
    parts = os.environ.get("SSH_CONNECTION", "").split()
    context = None
    if current_account is not None and len(parts) == 4:
        try:
            ipaddress.ip_address(parts[0])
            ipaddress.ip_address(parts[2])
            if all(1 <= int(parts[index]) <= 65535 for index in (1, 3)) and re.fullmatch(
                    r"[a-zA-Z0-9_.-]{1,64}", user):
                context = ("user=" + user + ",addr=" + parts[0] + ",laddr=" + parts[2]
                           + ",lport=" + parts[3])
                values.update({"Client address": parts[0], "Server address": parts[2],
                               "Current server port": parts[3]})
        except ValueError:
            pass
    sshd = tool("sshd")
    output = run([sshd, "-T", "-C", context]) if context and sshd else None
    allowed = {"passwordauthentication", "pubkeyauthentication", "permitrootlogin",
               "kbdinteractiveauthentication", "authenticationmethods", "usepam", "port",
               "listenaddress"}
    if output:
        for line in output.splitlines():
            key, _, value = line.partition(" ")
            if key in allowed:
                values[key] = values[key] + ", " + value if key in values else value
    values["Configuration scope"] = "Default sshd invocation; runtime flags and Match Host may differ"
    try:
        values.update(ssh_systemd_values(systemd_snapshot()))
    except Exception:
        values["SSH activation model"] = "Unknown; systemd evidence could not be projected"
    try:
        accounts = accounts_snapshot()
        values.update(accounts["values"])
        values["Account coverage"] = accounts["coverage"]
    except Exception:
        values["Account coverage"] = "Unknown; local account evidence could not be projected"
    try:
        keys = authorized_keys_snapshot()
        values.update(keys["values"])
        values["Authorized key coverage"] = keys["coverage"]
    except Exception:
        values["Authorized key coverage"] = "Unknown; local authorized-key evidence could not be projected"
    return evidence("ssh", "Users and SSH", values, "partial",
                    "Default-config and local-file evidence only; this does not certify the running "
                    "daemon's policy, account privileges or safe access. No sudo was attempted. "
                    "Key authentication is not independently verified.")


def firewall():
    binary = tool("ufw")
    if not binary:
        return evidence("firewall", "Firewall", {"UFW installed": "Not found", "Cloud firewall": "Unknown"}, "partial",
                        "Other host or provider firewalls may be active. Missing UFW is not proof of public exposure.")
    output = run([binary, "status", "verbose"])
    values = {"UFW installed": "Yes", "Cloud firewall": "Unknown", "Docker published ports": "Separate from UFW filtering"}
    if not output:
        return evidence("firewall", "Firewall", values, "partial", "UFW status is unavailable without additional privileges. No sudo was attempted.")
    match = re.search(r"^Status: (active|inactive)$", output, re.M)
    if not match:
        return evidence("firewall", "Firewall", values, "partial", "Unrecognized or incomplete UFW output.")
    values["Status"] = match[1]
    default = re.search(r"^Default: ([^\n]+)$", output, re.M)
    if default:
        values["Default policies"] = default[1]
    rules = []
    for line in output.splitlines():
        # Comments can contain arbitrary private text: omit them at the source.
        line = line.split("#", 1)[0].strip()
        if re.search(r"\b(ALLOW|DENY|REJECT|LIMIT)(?:\s+(?:IN|OUT|FWD))?\s{2,}", line):
            rules.append(line)
    if len(rules) > 100:
        return evidence("firewall", "Firewall", values, "partial", "More than 100 rules; incomplete evidence cannot authorize changes.")
    values.update({"Rule " + str(index + 1): rule for index, rule in enumerate(rules)})
    if not default:
        values["Default policies"] = "Unknown; persistent configuration was not inspected"
        return evidence("firewall", "Firewall", values, "partial", "UFW state was observed, but defaults and inactive rules are incomplete.")
    return evidence("firewall", "Firewall", values, message="Rules are an observed display, not stable deletion IDs or a public-reachability guarantee.")


def listeners():
    output = run([tool("ss"), "-H", "-lntu"])
    if output is None:
        return evidence("listeners", "Listening sockets", {}, "partial",
                        "Socket information is unavailable; this does not prove there are no listeners.")
    rows = output.splitlines()
    values = {"Socket " + str(index + 1): " ".join(row.split()) for index, row in enumerate(rows[:100])}
    return evidence("listeners", "Listening sockets", values, "partial" if len(rows) > 100 else "ready",
                    "Listening sockets do not prove public reachability. Process arguments are not collected.")


def bounded_sections(sections):
    def encoded():
        return json.dumps(sections, ensure_ascii=True, separators=(",", ":")).encode("utf-8")

    if len(encoded()) <= OUTPUT_BUDGET:
        return sections
    for limit in (40, 8):
        for section in sections:
            if len(section["values"]) > limit:
                section["values"] = dict(list(section["values"].items())[:limit])
                section["state"] = "partial"
                section["message"] = printable((section.get("message") or "")
                                               + " Output bound reached; values were truncated.", 1024)
                if len(encoded()) <= OUTPUT_BUDGET:
                    return sections
    return sections


def main():
    global _authenticated_user
    reset_state()
    _authenticated_user = read_native_context(sys.stdin)
    sections = []
    for id, title, probe in [("system", "System", system), ("essentials", "Essential software", essentials),
            ("resources", "System resources", resources), ("security", "Security", security),
            ("docker", "Docker", docker), ("ssh", "Users and SSH", ssh),
            ("firewall", "Firewall", firewall), ("listeners", "Listening sockets", listeners)]:
        try:
            sections.append(probe())
        except Exception:
            sections.append(evidence(id, title, {}, "unavailable", "Inspection could not complete. Existing settings are unchanged."))
    print(json.dumps(bounded_sections(sections), ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
