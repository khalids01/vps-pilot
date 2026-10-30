# Live monitoring validation — 2026-10-30

The user authorized a fast, measured monitor. The default is 1 second, with
2-second and 5-second choices. This is a minimum delay after each response,
not a guarantee of exact delivery timing. Network latency and slow sampling
reduce the actual refresh frequency; there are no catch-up bursts.

## Sampler budget and evidence

The initial acceptance budget is **below 1% of one CPU core** averaged over the
test and **below 20 MiB peak RSS** for the remote sampler process. This budget
does not describe total VPS Pilot overhead or guarantee every target VPS will
match these results.

Measured in a disposable rootless Debian 12 x86_64 container with Python 3.11,
isolated Python startup with bytecode writes disabled (-I -S -B), one CPU quota, 128 MiB memory limit, no network,
and only the sampler/benchmark
files mounted read-only. Ten requests at each interval using the final interpreter flags, including process
startup; CPU time comes from child-process resource accounting, and peak RSS
from /proc/PID/status.

| Interval | Elapsed | One-core CPU | Peak RSS | JSON bytes/sample |
| --- | --- | --- | --- | --- |
| 1s | 9.04s | 0.287% | 9,788 KiB | 369 |
| 2s | 18.04s | 0.145% | 9,932 KiB | 369 |
| 5s | 45.04s | 0.058% | 9,744 KiB | 370 |

All three met the sampler budget. Raw results and the exact sampler source hash
are in [monitor-benchmark-results.json](../tests/fixtures/monitor-benchmark-results.json).
Reproduction instructions are in [fixtures README](../tests/fixtures/README.md).

These are short local measurements on one machine. Cold startup is included and
has a noticeable effect on these short-run CPU averages. They exclude SSH encryption,
sshd, network framing/latency, the desktop process, sustained workloads, and
other distributions/architectures. They are not measurements of the user's VPS.
There is no zero-overhead claim and no production VPS was used.

## Runtime safeguards

- One Python process per active monitored VPS, with the SSH user’s existing
  permissions and no privilege elevation, using its existing
  authenticated SSH connection. No upload, installation, daemon, public listener,
  Docker socket access, or sudo. Linux /proc and Python 3 are prerequisites.
- Enabled by default for the active connected VPS; users can disable it in Settings.
  Sampler pauses for inactive VPS tabs,
  hidden documents, and unfocused windows. Badges, popovers and Overview charts
  share the same samples; tooltips never request additional data.
- The Rust side owns the fixed command and allowlists 1s, 2s and 5s. No generic
  shell command is accepted from the UI. Monitoring ignores terminal input.
- One outstanding sample and acknowledgement at a time, a 16 KiB frame limit,
  4-second Python sampling alarm, 5-second SSH request/response deadlines, and
  10-second desktop acknowledgement deadline.
- Samples slower than the chosen interval extend the next delay. Failed streams
  retry after 5, 10, 20, 40, then 60 seconds; pausing cancels retries.
- The Python sampler exits on stdin EOF, unexpected input, or 30 seconds without
  requests. Native close waits for channel cleanup before releasing its singleton
  slot. Reconnects reset CPU and byte-rate baselines.
- Root filesystem capacity and device/interface discovery refresh at most once
  per 60 seconds. No directory scans or repeated inventory queries.
- CPU ignores guest counters already included in other fields. Memory uses
  MemAvailable. Network shows a named interface, preferring the default IPv4
  route. Disk I/O totals base block devices, excluding partitions and stacked/
  virtual devices; this does not attribute I/O to an application or filesystem.
- Counter resets, long sample gaps, unsafe numeric precision, and interface
  switches show unavailable rates rather than fabricated zeroes.
- Desktop history is bounded to 180 points. The command drawer has one grouped
  live entry with the exact command and latest counters; nothing is persisted.

## Verification

Native tests cover counter validation, single-sampler enforcement, server
ownership, acknowledgement backpressure, ignored terminal input, cancellation
and disconnect. The disposable OpenSSH fixture checks actual samples over a
stream longer than 60 seconds and verifies that no sampler process remains
after closing SSH input.

Browser tests verify shared streams across tools, inactive tab/window pause,
retry backoff and cancellation, interval changes, hover labels, floating details,
command console integration, and narrow layouts. These mocks do not establish
native Tauri/WebKit focus/minimize behavior; that still needs desktop testing.

Settings (enabled state, interval, visible stats, zoom) persist in the desktop SQLite database. Samples and chart history remain in memory; the sampler performs no database writes. Hiding every stat or opening Settings stops sampling.
