#!/usr/bin/env python3
"""Measure configuration discovery only in an owned, network-isolated local guest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
import uuid

IMAGE = "localhost/vps-pilot-fixture:debian12"
LABEL = "org.vps-pilot.configuration-benchmark"
MAX_CAPTURE = 65536

# The guest waits for a fresh child on every trial. Linux wait4 accounts for
# descendants that the probe reaped; ru_maxrss is NOT summed process-tree memory.
GUEST = r'''
import json, os, platform, signal, subprocess, sys, tempfile, time
payload = json.loads(sys.stdin.buffer.read(100000))
with tempfile.TemporaryFile() as output:
    start = time.monotonic()
    child = subprocess.Popen(
        [sys.executable, '-I', '-S', '-B', '-u', '-c', payload['source']],
        stdin=subprocess.PIPE, stdout=output, stderr=subprocess.DEVNULL,
        start_new_session=True)
    child.stdin.write(b'{"authenticatedUser":"root"}')
    child.stdin.close()
    while True:
        pid, status, usage = os.wait4(child.pid, os.WNOHANG)
        if pid:
            child.returncode = os.waitstatus_to_exitcode(status)
            break
        if time.monotonic() - start > 35:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.wait4(child.pid, 0)
            child.returncode = -signal.SIGKILL
            raise RuntimeError('probe timeout')
        time.sleep(0.005)
    elapsed = time.monotonic() - start
    if child.returncode != 0 or output.tell() > 131072:
        raise RuntimeError('probe exit/output bound')
    output.seek(0)
    raw = output.read(131073)
sections = json.loads(raw)
ids = {'system','essentials','resources','security','docker','ssh','firewall','listeners'}
if (not isinstance(sections, list) or len(sections) != 8
        or {s['id'] for s in sections} != ids
        or any(s['state'] not in ('ready','partial','unavailable') for s in sections)):
    raise RuntimeError('invalid evidence')
states = {state: sum(s['state'] == state for s in sections)
          for state in ('ready','partial','unavailable')}
distro = {}
try:
    with open('/etc/os-release') as stream:
        for line in stream.read(4096).splitlines():
            key, sep, value = line.partition('=')
            if sep and key in ('ID','VERSION_ID'):
                distro[key] = value.strip('"')[:80]
except OSError:
    pass
print(json.dumps({'wallSeconds': elapsed, 'userCpuSeconds': usage.ru_utime,
    'systemCpuSeconds': usage.ru_stime, 'maxProcessRssKiB': usage.ru_maxrss,
    'outputBytes': len(raw), 'sectionStates': states,
    'environment': {'python': platform.python_version(),
                    'kernel': platform.release(), 'distro': distro}}))
'''


class CleanupError(RuntimeError):
    pass


def run(args, *, data=None, timeout=15, missing_ok=False):
    """Capture bounded results without ever forwarding commands/raw errors."""
    process = subprocess.Popen(
        ["podman", "--remote=false", *args], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    output = bytearray()
    pending = memoryview(data or b"")
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            os.set_blocking(process.stdout.fileno(), False)
            selector.register(process.stdout, selectors.EVENT_READ)
            if pending:
                os.set_blocking(process.stdin.fileno(), False)
                selector.register(process.stdin, selectors.EVENT_WRITE)
            else:
                process.stdin.close()
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired("local fixture", timeout)
                for key, _ in selector.select(remaining):
                    if key.fileobj is process.stdin:
                        try:
                            pending = pending[os.write(process.stdin.fileno(), pending[:4096]):]
                        except BlockingIOError:
                            continue
                        if not pending:
                            selector.unregister(process.stdin)
                            process.stdin.close()
                    else:
                        try:
                            chunk = os.read(process.stdout.fileno(), 4096)
                        except BlockingIOError:
                            continue
                        if not chunk:
                            selector.unregister(process.stdout)
                        output.extend(chunk)
                        if len(output) > MAX_CAPTURE:
                            raise RuntimeError("Local fixture exceeded its output bound.")
        process.wait(timeout=max(0.001, deadline - time.monotonic()))
        if missing_ok and process.returncode == 1:
            return None
        if process.returncode:
            raise RuntimeError("Local fixture command failed.")
        return bytes(output)
    except BaseException:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
        raise
    finally:
        process.stdin.close()
        process.stdout.close()


def cleanup(name, token):
    # A transient inspection/removal error gets one bounded retry. Never remove
    # a container whose ownership cannot be verified, and never report that as
    # successful cleanup. Names contain only our generated non-secret nonce.
    for _ in range(2):
        try:
            if run(["container", "exists", name], missing_ok=True, timeout=5) is None:
                return
            labels = json.loads(run(["inspect", "--format", "{{json .Config.Labels}}", name], timeout=5))
            if not isinstance(labels, dict) or labels.get(LABEL) != token:
                raise CleanupError("Fixture ownership could not be verified: " + name)
            run(["rm", "--force", "--time", "0", name], timeout=15)
            return
        except CleanupError:
            raise
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
            continue
    raise CleanupError("Could not confirm fixture cleanup; inspect the local container: " + name)


def benchmark(trials):
    if run(["info", "--format", "{{.Host.Security.Rootless}}"]).strip() != b"true":
        raise RuntimeError("This benchmark requires local rootless Podman.")
    image_id = run(["image", "inspect", IMAGE, "--format", "{{.Id}}"])
    image_id = image_id.decode("ascii").strip()
    if not image_id or len(image_id) > 80:
        raise RuntimeError("Invalid fixture image identity.")
    source = (Path(__file__).resolve().parents[2]
              / "src-tauri/src/ssh/configuration_probe.py").read_bytes()
    payload = json.dumps({"source": source.decode("utf-8")}).encode()
    if len(payload) >= 100000:
        raise RuntimeError("Probe exceeds the benchmark input bound.")
    token = uuid.uuid4().hex
    name = "vps-pilot-fixture-configuration-" + token
    report = None
    try:
        run(["run", "--detach", "--pull=never", "--name", name,
             "--label", "org.vps-pilot.fixture=true", "--label", LABEL + "=" + token,
             "--network", "none", "--read-only", "--tmpfs", "/run:rw,size=8m",
             "--tmpfs", "/tmp:rw,size=8m", "--memory", "128m", "--cpus", "1",
             "--pids-limit", "32", "--cap-drop=all", "--security-opt", "no-new-privileges",
             "--entrypoint", "/usr/bin/sleep", image_id, "infinity"])
        results = []
        for index in range(trials + 1):
            result = json.loads(run(
                ["exec", "--interactive", name, "python3", "-I", "-S", "-B", "-u", "-c", GUEST],
                data=payload, timeout=40))
            if index:
                results.append(result)
        report = {
            "scope": "One-shot probe in disposable Debian guest; excludes SSH, Podman exec startup and desktop rendering.",
            "sourceSha256": hashlib.sha256(source).hexdigest(),
            "image": IMAGE, "imageId": image_id,
            "limits": {"memoryMiB": 128, "cpus": 1, "pids": 32, "network": "none", "readOnlyRoot": True},
            "warmupTrials": 1, "measuredTrials": trials,
            "environment": results[0]["environment"],
            "limitations": [
                "Warm-cache sequential trials, not cold-start or fleet-load certification.",
                "Guest has no systemd PID 1, active SSH daemon or representative installed security packages.",
                "CPU includes waited descendants; RSS is the largest individual process, not summed tree peak.",
                "Guest measurement-wrapper CPU is excluded; writable tmpfs is shared across trials.",
                "No automatic pass/fail resource budget is asserted for manual discovery.",
            ],
            "results": [{k: v for k, v in result.items() if k != "environment"} for result in results],
        }
    finally:
        cleanup(name, token)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trials", type=int, default=5, help="1..10 measured trials plus one warmup")
    parser.add_argument("--output", type=Path, help="Create a new JSON report file; existing files are preserved")
    args = parser.parse_args()
    if not 1 <= args.trials <= 10:
        parser.error("--trials must be between 1 and 10")
    if args.output and args.output.exists():
        parser.error("--output already exists")
    # Let finally clean up the exact owned guest on both Ctrl+C and SIGTERM.
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        report = benchmark(args.trials)
        encoded = json.dumps(report, indent=2) + "\n"
        if args.output:
            with args.output.open("x", encoding="utf-8") as stream:
                stream.write(encoded)
        print(encoded, end="")
        return 0
    except CleanupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired, KeyboardInterrupt):
        print("Configuration benchmark failed or was interrupted; no raw probe evidence was logged.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
