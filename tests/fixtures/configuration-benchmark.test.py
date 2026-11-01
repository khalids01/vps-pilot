"""Local-only failure-path checks; no Podman/container/server is invoked."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "benchmark", Path(__file__).with_name("benchmark-configuration.py"))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class BenchmarkSafetyTests(unittest.TestCase):
    def test_transient_inspection_timeout_retries_then_removes_verified_owner(self):
        with patch.object(benchmark, "run", side_effect=[
                b"", subprocess.TimeoutExpired("fixture", 5),
                b"", ('{"' + benchmark.LABEL + '":"nonce"}').encode(), b"",
        ]) as run:
            benchmark.cleanup("owned-name", "nonce")
        self.assertEqual(run.call_args_list[-1].args[0], ["rm", "--force", "--time", "0", "owned-name"])

    def test_unverified_or_null_labels_never_remove_a_container(self):
        for labels in (b"null", b"{}", b'{"foreign":"nonce"}'):
            with self.subTest(labels=labels), patch.object(
                    benchmark, "run", side_effect=[b"", labels]) as run:
                with self.assertRaisesRegex(benchmark.CleanupError, "ownership"):
                    benchmark.cleanup("foreign", "nonce")
                self.assertFalse(any(call.args[0][0] == "rm" for call in run.call_args_list))

    def test_repeated_cleanup_failure_reports_uncertainty(self):
        with patch.object(benchmark, "run", side_effect=subprocess.TimeoutExpired("fixture", 5)) as run:
            with self.assertRaisesRegex(benchmark.CleanupError, "Could not confirm fixture cleanup"):
                benchmark.cleanup("owned-name", "nonce")
        self.assertEqual(run.call_count, 2)

    def test_absent_container_needs_no_removal(self):
        with patch.object(benchmark, "run", return_value=None) as run:
            benchmark.cleanup("absent", "nonce")
        self.assertEqual(run.call_count, 1)

    def child(self, code):
        popen = subprocess.Popen
        return patch.object(benchmark.subprocess, "Popen", side_effect=lambda *a, **kw:
                            popen([sys.executable, "-I", "-S", "-c", code], **kw))

    def test_output_limit_is_enforced_while_child_is_running(self):
        with self.child("import os,time; os.write(1,b'x'*70000); time.sleep(30)"):
            with self.assertRaisesRegex(RuntimeError, "output bound"):
                benchmark.run(["fake"], timeout=2)

    def test_timeout_reaps_child(self):
        with self.child("import time; time.sleep(30)"):
            with self.assertRaises(subprocess.TimeoutExpired):
                benchmark.run(["fake"], timeout=.05)

    def test_bidirectional_backpressure_handles_bounded_input(self):
        code = "import os,sys; os.write(1,b'x'*60000); data=sys.stdin.buffer.read(); os.write(1,str(len(data)).encode())"
        with self.child(code):
            result = benchmark.run(["fake"], data=b"y" * 90000, timeout=2)
        self.assertEqual(result, b"x" * 60000 + b"90000")

    def test_missing_status_is_only_accepted_when_requested(self):
        with self.child("raise SystemExit(1)"):
            self.assertIsNone(benchmark.run(["fake"], missing_ok=True))
        with self.child("raise SystemExit(1)"):
            with self.assertRaises(RuntimeError):
                benchmark.run(["fake"])


if __name__ == "__main__":
    unittest.main()
