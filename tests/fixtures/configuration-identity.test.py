"""Identity-bound projection tests. All account data is synthetic; no real home is read."""
import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import patch

source = pathlib.Path(__file__).resolve().parents[2] / "src-tauri/src/ssh/configuration_probe.py"
spec = importlib.util.spec_from_file_location("identity_probe", source)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

PASSWD = "root:SECRET:0:0:Root:/root:/bin/bash\nalias:OTHERSECRET:0:0:Alias:/home/alias:/bin/bash\ndeploy:x:1000:1000:Deploy:/home/deploy:/bin/bash\n"
GROUPS = "root:x:0:\nsudo:GROUPSECRET:27:alias,deploy\n"


class IdentityTests(unittest.TestCase):
    def setUp(self):
        probe.reset_state()

    def fake_read(self, path, limit):
        return (PASSWD if path == "/etc/passwd" else GROUPS, "ok")

    def test_native_context_is_bounded_and_data_only(self):
        self.assertEqual(probe.read_native_context(io.StringIO('{"authenticatedUser":"alias"}')), "alias")
        for raw in ("[]", "garbage", '{"authenticatedUser":"alias,addr=example"}', '{"authenticatedUser":null}', " " * 1025):
            self.assertIsNone(probe.read_native_context(io.StringIO(raw)))

    def test_same_uid_accounts_use_the_native_authenticated_name(self):
        probe._authenticated_user = "alias"
        with patch.object(probe, "read_bounded_file", side_effect=self.fake_read), patch.object(probe.os, "getuid", return_value=0), patch.object(probe, "authorized_keys_at", return_value={"values": {}, "coverage": "fixture"}) as keys:
            self.assertEqual(probe.local_snapshot()["current"]["name"], "alias")
            probe.authorized_keys_snapshot()
            keys.assert_called_once_with("/home/alias")
            accounts = probe.accounts_snapshot()
        self.assertTrue(accounts["values"]["Local account 1"].startswith("alias:"))
        for private in ("OTHERSECRET", "GROUPSECRET", "/home/alias", "SECRET"):
            self.assertNotIn(private, json.dumps(accounts))

    def test_absent_or_mismatched_identity_never_reads_a_key_file(self):
        for name in (None, "missing", "deploy"):
            probe.reset_state()
            probe._authenticated_user = name
            with patch.object(probe, "read_bounded_file", side_effect=self.fake_read), patch.object(probe.os, "getuid", return_value=0), patch.object(probe, "authorized_keys_at") as keys:
                self.assertIsNone(probe.local_snapshot()["current"])
                result = probe.authorized_keys_snapshot()
                keys.assert_not_called()
                self.assertIn("Unknown", result["coverage"])

    def test_truncated_local_identity_does_not_authorize_home_inspection(self):
        probe._authenticated_user = "alias"
        with patch.object(probe, "read_bounded_file", return_value=(PASSWD, "truncated")), patch.object(probe.os, "getuid", return_value=0), patch.object(probe, "authorized_keys_at") as keys:
            self.assertIsNone(probe.local_snapshot()["current"])
            probe.authorized_keys_snapshot()
            keys.assert_not_called()


if __name__ == "__main__":
    unittest.main()
