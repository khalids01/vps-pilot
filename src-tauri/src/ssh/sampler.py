# Executed over an existing SSH channel, never installed. Linux + Python 3 only.
# Each stdin request produces one bounded JSON sample. EOF stops the process.
import json
import os
import select
import signal
import sys
import time

capacity = None
capacity_at = -60.0
interface = None
devices = set()
topology_at = -60.0


def read(path):
    with open(path, "r", encoding="ascii") as source:
        return source.read(262144)


def sample():
    global capacity, capacity_at, interface, devices, topology_at
    now = time.monotonic()
    with open("/proc/stat", "r", encoding="ascii") as source:
        cpu = [int(v) for v in source.readline(4096).split()[1:9]]
    memory = {}
    for line in read("/proc/meminfo").splitlines():
        key, value = line.split(":", 1)
        memory[key] = int(value.split()[0]) * 1024
    if now - topology_at >= 60:
        topology_at = now
        interface = None
        for line in read("/proc/net/route").splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 4 and fields[1] == "00000000" and int(fields[3], 16) & 1:
                interface = fields[0]
                break
        devices = {
            name for name in os.listdir("/sys/block")
            if not name.startswith(("loop", "ram", "zram", "sr", "fd", "dm-", "md"))
        }
    network = {}
    for line in read("/proc/net/dev").splitlines()[2:]:
        name, values = line.split(":", 1)
        fields = values.split()
        network[name.strip()] = (int(fields[0]), int(fields[8]))
    if interface not in network:
        interface = next((name for name in network if name != "lo" and not name.startswith(("veth", "br-", "docker", "virbr"))), None)
    rx, tx = network.get(interface, (None, None))
    disk_read = disk_write = 0
    disk_found = False
    for line in read("/proc/diskstats").splitlines():
        fields = line.split()
        if len(fields) >= 10 and fields[2] in devices:
            disk_found = True
            disk_read += int(fields[5]) * 512
            disk_write += int(fields[9]) * 512
    if now - capacity_at >= 60:
        capacity_at = now
        try:
            fs = os.statvfs("/")
            capacity = {
                "total": fs.f_blocks * fs.f_frsize,
                "free": fs.f_bfree * fs.f_frsize,
                "available": fs.f_bavail * fs.f_frsize,
            }
        except OSError:
            capacity = None
    return {
        "uptime": float(read("/proc/uptime").split()[0]),
        "cpuTotal": sum(cpu),
        "cpuIdle": cpu[3] + cpu[4],
        "memoryTotal": memory["MemTotal"],
        "memoryAvailable": memory["MemAvailable"],
        "swapTotal": memory.get("SwapTotal", 0),
        "swapFree": memory.get("SwapFree", 0),
        "networkInterface": interface,
        "networkReceived": rx,
        "networkSent": tx,
        "diskRead": disk_read if disk_found else None,
        "diskWritten": disk_write if disk_found else None,
        "capacity": capacity,
        "capacityAge": max(0, int(now - capacity_at)),
    }


def timed_out(_signum, _frame):
    raise TimeoutError()


signal.signal(signal.SIGALRM, timed_out)
# Stop even if a disconnected client leaves the channel half-open.
while select.select([sys.stdin], [], [], 30)[0]:
    if sys.stdin.readline(32) != "sample\n":
        break
    try:
        signal.alarm(4)
        print(json.dumps(sample(), separators=(",", ":")), flush=True)
    except (OSError, ValueError, KeyError, IndexError):
        # No filesystem paths, command output, credentials, or environment in errors.
        sys.exit(1)
    finally:
        signal.alarm(0)
