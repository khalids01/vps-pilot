"""Local policy tests with mocked metadata/tools; never connects to a VPS."""
import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).resolve().parents[2] / "src-tauri/src/ssh/configuration_probe.py"
spec = importlib.util.spec_from_file_location("configuration_probe", path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_release_is_parsed_as_data_never_executed(self):
        self.assertEqual(probe.os_values('PRETTY_NAME="Debian"\nID=debian\nSECRET=private'),
                         {"PRETTY_NAME": "Debian", "ID": "debian"})

    def test_firewall_permission_failure_is_not_inactive(self):
        with patch.object(probe, "tool", return_value="/usr/sbin/ufw"), patch.object(probe, "run", return_value=None):
            result = probe.firewall()
        self.assertEqual(result["state"], "partial")
        self.assertNotIn("Status", result["values"])
        self.assertEqual(result["values"]["UFW installed"], "Yes")

    def test_firewall_preserves_families_and_omits_comments(self):
        text = "Status: active\nDefault: deny (incoming), allow (outgoing)\n22/tcp    ALLOW IN    Anywhere # private-note\n22/tcp (v6)    ALLOW IN    Anywhere (v6)\n"
        with patch.object(probe, "tool", return_value="/usr/sbin/ufw"), patch.object(probe, "run", return_value=text):
            result = probe.firewall()
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["values"]["Status"], "active")
        self.assertIn("(v6)", result["values"]["Rule 2"])
        self.assertNotIn("private-note", str(result))

    def test_inactive_firewall_does_not_fabricate_persistent_defaults(self):
        with patch.object(probe, "tool", return_value="/usr/sbin/ufw"), patch.object(probe, "run", return_value="Status: inactive\n"):
            result = probe.firewall()
        self.assertEqual(result["state"], "partial")
        self.assertEqual(result["values"]["Status"], "inactive")
        self.assertIn("Unknown", result["values"]["Default policies"])

    def test_oversized_rules_are_partial_not_authoritative(self):
        text = "Status: active\n" + "22/tcp    ALLOW IN    Anywhere\n" * 101
        with patch.object(probe, "tool", return_value="/usr/sbin/ufw"), patch.object(probe, "run", return_value=text):
            result = probe.firewall()
        self.assertEqual(result["state"], "partial")
        self.assertNotIn("Rule 1", result["values"])

    def test_subprocess_output_is_bounded_and_errors_are_not_evidence(self):
        self.assertIsNone(probe.run([sys.executable, "-c", "print('a' * 40000)"]))
        self.assertIsNone(probe.run([sys.executable, "-c", "raise SystemExit(1)"]))
        self.assertEqual(probe.run([sys.executable, "-c", "print('ok')"]), "ok\n")

    def test_ssh_remains_partial_even_when_default_policy_is_readable(self):
        with patch.dict(probe.os.environ, {"SSH_CONNECTION": "127.0.0.1 43210 127.0.0.1 22"}), patch.object(probe, "tool", return_value="/usr/sbin/sshd"), patch.object(probe, "run", return_value="passwordauthentication no\nsecret private\npermitrootlogin prohibit-password\n"):
            result = probe.ssh()
        self.assertEqual(result["state"], "partial")
        self.assertEqual(result["values"]["passwordauthentication"], "no")
        self.assertNotIn("secret", result["values"])
        self.assertEqual(result["values"]["Key authentication"], "Not independently verified")


if __name__ == "__main__":
    unittest.main()
