# Read-only, bounded snapshot of incoming TCP connections on this SSH listener.
import ipaddress
import json
import os
import sys


def endpoint(value, ipv6):
    host, port = value.split(":")
    raw = bytes.fromhex(host)
    raw = b"".join(raw[i:i + 4][::-1] for i in range(0, len(raw), 4))
    return str(ipaddress.ip_address(raw)), int(port, 16)


def snapshot(connection, read):
    parts = connection.split()
    if len(parts) != 4:
        raise ValueError("SSH listener unavailable")
    port = int(parts[3])
    if not 1 <= port <= 65535:
        raise ValueError("SSH listener unavailable")
    rows = []
    for path, ipv6 in [("/proc/net/tcp", False), ("/proc/net/tcp6", True)]:
        try:
            content = read(path)
        except FileNotFoundError:
            if ipv6:
                continue
            raise
        if len(content) >= 1048576:
            raise ValueError("Connection table exceeds snapshot limit")
        for line in content.splitlines()[1:]:
            fields = line.split()
            if len(fields) < 4 or fields[3] != "01":
                continue
            local, local_port = endpoint(fields[1], ipv6)
            if local_port == port:
                peer, peer_port = endpoint(fields[2], ipv6)
                rows.append({"peer": peer, "port": peer_port, "local": local})
    return {"port": port, "connections": rows}


def read(path):
    with open(path, encoding="ascii") as source:
        return source.read(1048576)


if __name__ == "__main__":
    try:
        print(json.dumps(snapshot(os.environ.get("SSH_CONNECTION", ""), read)))
    except (OSError, ValueError):
        print(json.dumps({"error": "Incoming SSH connections unavailable"}))
        sys.exit(0)
