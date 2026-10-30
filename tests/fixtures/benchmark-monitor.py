#!/usr/bin/env python3
"""Local Linux sampler benchmark. Never run on the user's production VPS."""
import argparse
import json
import pathlib
import resource
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--samples", type=int, default=30)
args = parser.parse_args()
if args.samples < 5 or args.samples > 120:
    parser.error("Use 5 to 120 samples per interval")
script = pathlib.Path(__file__).resolve().parents[2] / "src-tauri/src/ssh/sampler.py"
results = []
for interval in (1, 2, 5):
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.monotonic()
    process = subprocess.Popen(
        [sys.executable, "-I", "-S", "-B", "-u", str(script)], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, text=True,
    )
    peak_kib = 0
    bytes_received = 0
    latencies = []
    for index in range(args.samples):
        sent = time.monotonic()
        process.stdin.write("sample\n")
        process.stdin.flush()
        line = process.stdout.readline()
        data = json.loads(line)
        assert data["memoryTotal"] > 0 and data["cpuTotal"] >= data["cpuIdle"]
        bytes_received += len(line.encode())
        latencies.append((time.monotonic() - sent) * 1000)
        status = pathlib.Path(f"/proc/{process.pid}/status").read_text()
        peak_kib = max(peak_kib, int(next(line.split()[1] for line in status.splitlines() if line.startswith("VmHWM:"))))
        if index + 1 < args.samples:
            time.sleep(interval)
    process.stdin.close()
    assert process.wait(timeout=5) == 0, "Sampler must exit on EOF"
    elapsed = time.monotonic() - start
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = (after.ru_utime + after.ru_stime) - (before.ru_utime + before.ru_stime)
    result = {
        "intervalSeconds": interval, "samples": args.samples,
        "elapsedSeconds": round(elapsed, 2), "cpuSeconds": round(cpu, 4),
        "oneCoreCpuPercent": round(100 * cpu / elapsed, 3),
        "peakRssKiB": peak_kib, "bytesPerSample": round(bytes_received / args.samples),
        "maxRequestMs": round(max(latencies), 2),
        "budgetPassed": cpu / elapsed < 0.01 and peak_kib < 20480,
    }
    results.append(result)
    print(json.dumps(result), flush=True)
print(json.dumps({"scope": "local Linux sampler process only; excludes SSH transport and desktop rendering", "results": results}), flush=True)
if not all(result["budgetPassed"] for result in results):
    sys.exit(1)
