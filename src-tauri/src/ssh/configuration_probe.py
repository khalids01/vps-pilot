"""One-shot, projected configuration evidence. No writes, sudo, network calls or scans."""
import ipaddress
import json
import os
import platform
import pwd
import re
import selectors
import shutil
import socket
import subprocess
import time

LIMIT = 32768


def clean(value):
    return "".join(c for c in str(value) if c.isprintable())[:512]


def tool(name):
    # Execute system tools only, never a current-directory/user PATH replacement.
    return next((p for root in ("/usr/bin", "/usr/sbin", "/bin", "/sbin")
                 if os.path.isfile(p := root + "/" + name) and os.access(p, os.X_OK)), None)


def run(args):
    if not args[0]:
        return None
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env={**os.environ, "LC_ALL": "C"})
    data = bytearray()
    try:
        deadline = time.monotonic() + 3
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    return None
                chunk = os.read(process.stdout.fileno(), 4096)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > LIMIT:
                    return None
        if process.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
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


def evidence(id, title, values, state="ready", message=None):
    if any(len(str(value)) > 512 for value in values.values()):
        state = "partial"
        message = (message or "") + " Some fields reached the display limit; evidence is incomplete."
    return {"id": id, "title": title, "state": state,
            "values": {clean(k): clean(v) for k, v in values.items()}, "message": message}


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
    return evidence("system", "System", {
        "Operating system": release.get("PRETTY_NAME", "Unknown"),
        "Distribution": release.get("ID", "Unknown"),
        "Version": release.get("VERSION_ID", "Unknown"),
        "Architecture": platform.machine(), "Hostname": socket.gethostname(),
        "Timezone": zone.strip(), "Package updates": "Not checked; package indexes are unchanged",
        "Management support": "Read-only detection; no change capability certified",
    }, "ready" if release else "partial", "Existing configuration is preserved. Updates require a separate reviewed check.")


def essentials():
    names = ("git", "curl", "tar", "unzip")
    values = {name: shutil.which(name) or "Not found in this user's PATH" for name in names}
    values["CA certificate bundle"] = next((p for p in (
        "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt")
        if os.path.isfile(p)), "Not found in standard locations")
    values["attention"] = str(any(not shutil.which(name) for name in names)).lower()
    return evidence("essentials", "Essential software", values,
                    message="Executable presence does not establish package ownership, version or trust.")


def resources():
    text = read("/proc/meminfo") or ""
    fields = dict(re.findall(r"^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$", text, re.M))
    values = {name: fields.get(key, "Unknown") + (" KiB" if key in fields else "") for name, key in (
        ("Memory total", "MemTotal"), ("Memory available", "MemAvailable"),
        ("Swap total", "SwapTotal"), ("Swap free", "SwapFree"))}
    try:
        stat = os.statvfs("/")
        values["Root capacity"] = str(stat.f_blocks * stat.f_frsize) + " bytes"
        values["Root available"] = str(stat.f_bavail * stat.f_frsize) + " bytes"
    except OSError:
        values["Root capacity"] = "Unknown"
    return evidence("resources", "System resources", values, "ready" if len(fields) == 4 else "partial",
                    "One-shot counters and root filesystem capacity. No directory traversal or disk changes.")


def security():
    values = {"UFW installed": "Yes" if tool("ufw") else "Not found in standard system paths",
              "Fail2ban installed": "Yes" if tool("fail2ban-client") else "Not found in standard system paths"}
    # Package installation is distinct from enabled/active protection.
    package = run([tool("dpkg-query"), "-W", "-f=${db:Status-Status}", "unattended-upgrades"])
    values["Automatic updates package"] = "Installed" if package and package.strip() == "installed" else "Unknown or absent"
    return evidence("security", "Security", values, "partial",
                    "Installation alone does not prove protection is configured or active. Alternative security tools may be in use.")


def docker():
    binary = tool("docker")
    version = run([binary, "--version"]) if binary else None
    return evidence("docker", "Docker", {"CLI": binary or "Not found in standard system paths", "CLI version": (version or "Unknown").strip(),
        "Engine and Compose": "Open Docker for workload inventory and Compose evidence",
        "attention": str(not binary).lower()}, "ready" if version or not binary else "partial",
        "No daemon queries, installation, upgrades or changes to existing workloads.")


def ssh():
    user = pwd.getpwuid(os.getuid()).pw_name
    values = {"Current user": user, "UID": str(os.getuid()),
              "Administrative privileges": "Root account" if os.getuid() == 0 else "Not verified; group membership is insufficient",
              "Key authentication": "Not independently verified"}
    parts = os.environ.get("SSH_CONNECTION", "").split()
    context = None
    if len(parts) == 4:
        try:
            ipaddress.ip_address(parts[0]); ipaddress.ip_address(parts[2])
            if all(1 <= int(parts[i]) <= 65535 for i in (1, 3)) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", user):
                context = "user=" + user + ",addr=" + parts[0] + ",laddr=" + parts[2] + ",lport=" + parts[3]
                values.update({"Client address": parts[0], "Server address": parts[2], "Current server port": parts[3]})
        except ValueError:
            pass
    output = run([tool("sshd"), "-T", "-C", context]) if context else None
    allowed = {"passwordauthentication", "pubkeyauthentication", "permitrootlogin", "kbdinteractiveauthentication",
               "authenticationmethods", "usepam", "port", "listenaddress"}
    if output:
        for line in output.splitlines():
            key, _, value = line.partition(" ")
            if key in allowed:
                values[key] = values[key] + ", " + value if key in values else value
    values["Configuration scope"] = "Default sshd invocation; runtime flags and Match Host may differ"
    return evidence("ssh", "Users and SSH", values, "partial",
                    "Default-config evidence only; this does not certify the running daemon's policy or safe access. No sudo was attempted.")


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
    values.update({"Rule " + str(i + 1): rule for i, rule in enumerate(rules)})
    if not default:
        values["Default policies"] = "Unknown; persistent configuration was not inspected"
        return evidence("firewall", "Firewall", values, "partial", "UFW state was observed, but defaults and inactive rules are incomplete.")
    return evidence("firewall", "Firewall", values, message="Rules are an observed display, not stable deletion IDs or a public-reachability guarantee.")


def listeners():
    output = run([tool("ss"), "-H", "-lntu"])
    if output is None:
        return evidence("listeners", "Listening sockets", {}, "unavailable", "Socket information is unavailable.")
    rows = output.splitlines()
    values = {"Socket " + str(i + 1): " ".join(row.split()) for i, row in enumerate(rows[:100])}
    return evidence("listeners", "Listening sockets", values, "partial" if len(rows) > 100 else "ready",
                    "Listening sockets do not prove public reachability. Process arguments are not collected.")


def main():
    sections = []
    for id, title, probe in [("system", "System", system), ("essentials", "Essential software", essentials),
            ("resources", "System resources", resources), ("security", "Security", security),
            ("docker", "Docker", docker), ("ssh", "Users and SSH", ssh),
            ("firewall", "Firewall", firewall), ("listeners", "Listening sockets", listeners)]:
        try:
            sections.append(probe())
        except Exception:
            sections.append(evidence(id, title, {}, "unavailable", "Inspection could not complete. Existing settings are unchanged."))
    print(json.dumps(sections, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
