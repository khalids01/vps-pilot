"""Local policy tests with mocked metadata/tools; never connects to a VPS."""
import base64
import hashlib
import importlib.util
import os
import pathlib
import struct
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).resolve().parents[2] / "src-tauri/src/ssh/configuration_probe.py"
spec = importlib.util.spec_from_file_location("configuration_probe", path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def ed25519_blob(seed=0):
    key = (struct.pack(">I", seed) + bytes(28))[:32]
    return (struct.pack(">I", len(b"ssh-ed25519")) + b"ssh-ed25519"
            + struct.pack(">I", len(key)) + key)


def ssh_string(value):
    data = value.encode("ascii") if isinstance(value, str) else value
    return struct.pack(">I", len(data)) + data


def ssh_blob(*parts):
    return b"".join(ssh_string(part) for part in parts)


def key_token(blob):
    return base64.b64encode(blob).decode("ascii")


def key_fingerprint(blob):
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")


class ProbeTests(unittest.TestCase):
    def setUp(self):
        probe.reset_state()

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
        policy = "passwordauthentication no\nsecret private\npermitrootlogin prohibit-password\n"
        with patch.dict(probe.os.environ, {"SSH_CONNECTION": "127.0.0.1 43210 127.0.0.1 22"}), \
                patch.object(probe, "tool", return_value="/usr/sbin/sshd"), \
                patch.object(probe, "run", return_value=policy), \
                patch.object(probe, "local_snapshot",
                             return_value={"current": {"name": "tester", "home": "/home/tester"}}), \
                patch.object(probe, "systemd_snapshot", return_value={"values": {}}), \
                patch.object(probe, "accounts_snapshot",
                             return_value={"values": {}, "coverage": "Synthetic account coverage"}), \
                patch.object(probe, "authorized_keys_snapshot",
                             return_value={"values": {}, "coverage": "Synthetic key coverage"}):
            result = probe.ssh()
        self.assertEqual(result["state"], "partial")
        self.assertEqual(result["values"]["passwordauthentication"], "no")
        self.assertNotIn("secret", result["values"])
        self.assertEqual(result["values"]["Key authentication"], "Not independently verified")

    def test_package_evidence_and_partial_ownership(self):
        def fake_tool(name):
            return "/usr/bin/dpkg-query" if name == "dpkg-query" else None

        def fake_which(name):
            return {"git": "/usr/bin/git", "curl": "/usr/bin/curl"}.get(name)

        def fake_run(args, accepted_exit=()):
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-W":
                return "git\tinstalled\t1:2.39\ncurl\tinstalled\t8.0\n"
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-S":
                return "git: /usr/bin/git\n"
            return None

        with patch.object(probe, "tool", side_effect=fake_tool), \
                patch.object(probe.shutil, "which", side_effect=fake_which), \
                patch.object(probe, "run", side_effect=fake_run):
            result = probe.essentials()
        self.assertEqual(result["state"], "partial")
        self.assertIn("Installed version 1:2.39", result["values"]["Package git"])
        self.assertIn("Package git", result["values"]["Git executable ownership"])
        self.assertIn("Unverified", result["values"]["Curl executable ownership"])

    def test_dpkg_wildcard_is_not_treated_as_exact_ownership(self):
        def fake_tool(name):
            return "/usr/bin/dpkg-query" if name == "dpkg-query" else None

        def fake_run(args, accepted_exit=()):
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-W":
                return "git\tinstalled\t1\n"
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-S":
                return "git: /usr/bin/git*\ndiversion by dash from: /usr/bin/git\n"
            return None

        with patch.object(probe, "tool", side_effect=fake_tool), \
                patch.object(probe.shutil, "which", return_value="/usr/bin/git"), \
                patch.object(probe, "run", side_effect=fake_run):
            result = probe.essentials()
        self.assertIn("Unverified", result["values"]["Git executable ownership"])
        self.assertNotIn("/usr/bin/git*", str(result))

    def test_package_and_ownership_queries_are_cached_per_snapshot(self):
        calls = []

        def fake_tool(name):
            return "/usr/bin/dpkg-query" if name == "dpkg-query" else None

        def fake_which(name):
            return {"git": "/usr/bin/git", "curl": "/usr/bin/curl"}.get(name)

        def fake_run(args, accepted_exit=()):
            calls.append(tuple(args))
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-W":
                return "git\tinstalled\t1\ncurl\tinstalled\t2\n"
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-S":
                return "git: /usr/bin/git\n"
            return None

        with patch.object(probe, "tool", side_effect=fake_tool), \
                patch.object(probe.shutil, "which", side_effect=fake_which), \
                patch.object(probe, "run", side_effect=fake_run):
            probe.essentials()
            probe.docker()
        self.assertEqual(len([call for call in calls if call[1] == "-W"]), 1)
        self.assertEqual(len([call for call in calls if call[1] == "-S"]), 1)

    def test_essentials_completeness_ignores_optional_docker_alternatives(self):
        def fake_tool(name):
            if name == "dpkg-query":
                return "/usr/bin/dpkg-query"
            if name == "docker":
                return "/usr/bin/docker"
            return None

        def fake_which(name):
            return {name: "/usr/bin/" + name for name in ("git", "curl", "tar", "unzip")}.get(name)

        def fake_run(args, accepted_exit=()):
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-W":
                return "\n".join(name + "\tinstalled\t1" for name in probe.ESSENTIAL_PACKAGES) + "\n"
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-S":
                return "\n".join(name + ": /usr/bin/" + name
                                 for name in ("git", "curl", "tar", "unzip")) + "\n"
            return None

        with patch.object(probe, "tool", side_effect=fake_tool), \
                patch.object(probe.shutil, "which", side_effect=fake_which), \
                patch.object(probe, "run", side_effect=fake_run):
            result = probe.essentials()
        self.assertEqual(result["state"], "ready")
        self.assertIn("Package git", result["values"]["Git executable ownership"])
        self.assertNotIn("Docker CLI executable ownership", result["values"])
        self.assertTrue(probe.packages_complete(probe.ESSENTIAL_PACKAGES))
        self.assertFalse(probe.packages_complete(probe.DOCKER_PACKAGES))

    def test_essentials_missing_relevant_owner_stays_partial(self):
        def fake_tool(name):
            return "/usr/bin/dpkg-query" if name == "dpkg-query" else None

        def fake_which(name):
            return {name: "/usr/bin/" + name for name in ("git", "curl", "tar", "unzip")}.get(name)

        def fake_run(args, accepted_exit=()):
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-W":
                return "\n".join(name + "\tinstalled\t1" for name in probe.ESSENTIAL_PACKAGES) + "\n"
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-S":
                return "\n".join(name + ": /usr/bin/" + name
                                 for name in ("curl", "tar", "unzip")) + "\n"
            return None

        with patch.object(probe, "tool", side_effect=fake_tool), \
                patch.object(probe.shutil, "which", side_effect=fake_which), \
                patch.object(probe, "run", side_effect=fake_run):
            result = probe.essentials()
        self.assertEqual(result["state"], "partial")
        self.assertIn("Unverified", result["values"]["Git executable ownership"])

    def test_glob_like_detected_path_is_displayed_but_not_searched(self):
        glob_path = "/opt/tools/git[1]/git"
        calls = []

        def fake_tool(name):
            return "/usr/bin/dpkg-query" if name == "dpkg-query" else None

        def fake_which(name):
            return glob_path if name == "git" else None

        def fake_run(args, accepted_exit=()):
            calls.append(tuple(args))
            if args[0] == "/usr/bin/dpkg-query" and args[1] == "-W":
                return "git\tinstalled\t1\n"
            return None

        with patch.object(probe, "tool", side_effect=fake_tool), \
                patch.object(probe.shutil, "which", side_effect=fake_which), \
                patch.object(probe, "run", side_effect=fake_run):
            result = probe.essentials()
        self.assertEqual(result["values"]["Git"], glob_path)
        self.assertIn("Observed at " + glob_path, result["values"]["Git executable ownership"])
        self.assertIn("unverified", result["values"]["Git executable ownership"])
        self.assertNotIn("Package ", result["values"]["Git executable ownership"])
        self.assertEqual([call for call in calls if call[1] == "-S"], [])

    def test_cached_updates_absent_is_unknown_not_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(probe, "UPDATES_FILE", os.path.join(directory, "missing")), \
                    patch.object(probe, "UPDATE_STAMP", os.path.join(directory, "missing-stamp")):
                values = probe.update_values()
        self.assertIn("Unknown", values["Cached updates"])
        self.assertNotEqual(values["Cached updates"].split()[0], "0")
        self.assertIn("not zero", values["Update cache source"])
        self.assertIn("Unknown", values["Update index stamp"])

    def test_cached_updates_stale_is_labeled_cached_not_current(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = os.path.join(directory, "updates-available")
            stamp = os.path.join(directory, "update-success-stamp")
            with open(cache, "w", encoding="utf-8") as stream:
                stream.write("12 updates can be applied immediately.\n"
                             "3 of these updates are security updates.\nprivate free text\n")
            with open(stamp, "w", encoding="utf-8") as stream:
                stream.write("cached")
            old = time.time() - 7200
            os.utime(cache, (old, old))
            os.utime(stamp, (old, old))
            with patch.object(probe, "UPDATES_FILE", cache), \
                    patch.object(probe, "UPDATE_STAMP", stamp):
                values = probe.update_values()
        self.assertIn("12 reported by cached metadata", values["Cached updates"])
        self.assertIn("3 reported by cached metadata", values["Cached security updates"])
        self.assertIn("cached", values["Update cache source"])
        self.assertIn("age", values["Update cache age"])
        self.assertIn("cached timestamp", values["Update index stamp"])
        self.assertNotIn("private free text", str(values))
        self.assertNotIn("can be applied", str(values))

    def test_cached_updates_future_timestamp_is_not_fresh(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = os.path.join(directory, "updates-available")
            stamp = os.path.join(directory, "update-success-stamp")
            with open(cache, "w", encoding="utf-8") as stream:
                stream.write("0 updates can be applied immediately.\n")
            with open(stamp, "w", encoding="utf-8") as stream:
                stream.write("cached")
            future = time.time() + 3600
            os.utime(cache, (future, future))
            os.utime(stamp, (future, future))
            with patch.object(probe, "UPDATES_FILE", cache), \
                    patch.object(probe, "UPDATE_STAMP", stamp):
                values = probe.update_values()
        self.assertIn("future timestamp", values["Update cache age"])
        self.assertIn("age unknown", values["Update cache age"])
        self.assertNotIn("age 0s", values["Update cache age"])
        self.assertIn("future timestamp", values["Update index stamp"])
        self.assertIn("cached metadata", values["Cached updates"])

    def test_cached_updates_truncated_is_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = os.path.join(directory, "updates-available")
            with open(cache, "w", encoding="utf-8") as stream:
                stream.write("12 updates can be applied immediately.\n")
                stream.write("x" * 5000)
            with patch.object(probe, "UPDATES_FILE", cache), \
                    patch.object(probe, "UPDATE_STAMP", os.path.join(directory, "missing-stamp")):
                values = probe.update_values()
        self.assertIn("truncated", values["Cached updates"])
        self.assertIn("incomplete", values["Cached updates"])
        self.assertEqual(values["Update cache completeness"], "Incomplete; cached file was truncated")
        self.assertIn("incomplete", values["Update cache source"])
        self.assertNotIn("x" * 100, str(values))

    def test_cached_updates_malformed_count_is_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = os.path.join(directory, "updates-available")
            with open(cache, "w", encoding="utf-8") as stream:
                stream.write("no numeric update count here\n")
            with patch.object(probe, "UPDATES_FILE", cache), \
                    patch.object(probe, "UPDATE_STAMP", os.path.join(directory, "missing-stamp")):
                values = probe.update_values()
        self.assertIn("Unknown", values["Cached updates"])
        self.assertIn("No recognized numeric count", values["Update cache completeness"])
        self.assertNotIn("no numeric update count here", str(values))

    def test_systemd_unavailable_is_partial_and_unknown(self):
        with patch.object(probe, "tool", return_value=None):
            snapshot = probe.systemd_snapshot()
        self.assertFalse(snapshot["available"])
        self.assertIn("Unknown", snapshot["values"]["SSH activation model"])
        self.assertIn("Unknown", snapshot["values"]["Security unit fail2ban.service"])
        self.assertIn("systemctl not found", snapshot["reason"])

    def test_systemd_distinguishes_service_and_socket_activation(self):
        service_text = "\n".join([
            "Id=ssh.service", "LoadState=loaded", "ActiveState=active",
            "UnitFileState=enabled", "FragmentPath=/lib/systemd/system/ssh.service",
            "DropInPaths=", "Listen=", "",
            "Id=ssh.socket", "LoadState=not-found", "ActiveState=inactive", "UnitFileState=",
        ])
        with patch.object(probe, "tool",
                          side_effect=lambda name: "/usr/bin/systemctl" if name == "systemctl" else None), \
                patch.object(probe, "run", return_value=service_text):
            snapshot = probe.systemd_snapshot()
        self.assertEqual(snapshot["values"]["SSH activation model"],
                         "Service unit reports active; this does not prove this connection used the service unit")
        self.assertIn("no drop-ins reported", snapshot["values"]["SSH unit ssh.service"])

        probe.reset_state()
        socket_text = "\n".join([
            "Id=ssh.service", "LoadState=not-found", "ActiveState=inactive", "",
            "Id=ssh.socket", "LoadState=loaded", "ActiveState=active",
            "UnitFileState=enabled", "DropInPaths=/etc/systemd/system/ssh.socket.d/override.conf",
            "Listen=[::]:22",
        ])
        with patch.object(probe, "tool",
                          side_effect=lambda name: "/usr/bin/systemctl" if name == "systemctl" else None), \
                patch.object(probe, "run", return_value=socket_text):
            snapshot = probe.systemd_snapshot()
        self.assertEqual(snapshot["values"]["SSH activation model"],
                         "Socket unit reports active; this does not prove this connection used socket activation")
        self.assertIn("drop-ins present", snapshot["values"]["SSH unit ssh.socket"])
        self.assertIn("Listen=[::]:22", snapshot["values"]["SSH unit ssh.socket"])

    def test_systemd_allowlist_ignores_commands_and_treats_injection_as_data(self):
        text = "\n".join([
            "Id=ssh.service", "LoadState=loaded", "ActiveState=active; touch /tmp/pwned",
            "UnitFileState=SECRET-COMMAND", "FragmentPath=/bin/sh -c SECRET",
            "DropInPaths=/etc/systemd/system/ssh.service.d/override.conf",
            "ExecStart=/bin/sh -c SECRETEXEC", "Environment=SECRETENV=1",
            "Listen=SECRETLISTEN",
        ])
        with patch.object(probe, "tool",
                          side_effect=lambda name: "/usr/bin/systemctl" if name == "systemctl" else None), \
                patch.object(probe, "run", return_value=text):
            snapshot = probe.systemd_snapshot()
        rendered = str(snapshot["values"])
        for secret in ("touch", "SECRETEXEC", "SECRETENV", "SECRET-COMMAND", "SECRET"):
            self.assertNotIn(secret, rendered)
        self.assertIn("drop-ins present", snapshot["values"]["SSH unit ssh.service"])
        self.assertIn("Unrecognized", snapshot["values"]["SSH unit ssh.service"])

    def test_systemd_accepts_partial_exit_and_parses_non_first_id(self):
        calls = []

        def fake_run(args, accepted_exit=()):
            calls.append(tuple(accepted_exit))
            return "\n".join([
                "LoadState=loaded", "Id=ssh.service", "ActiveState=active",
                "UnitFileState=enabled", "DropInPaths=", "",
                "LoadState=not-found", "Id=ssh.socket", "ActiveState=inactive",
            ])

        with patch.object(probe, "tool",
                          side_effect=lambda name: "/usr/bin/systemctl" if name == "systemctl" else None), \
                patch.object(probe, "run", side_effect=fake_run):
            snapshot = probe.systemd_snapshot()
        self.assertTrue(calls)
        self.assertIn(1, calls[0])
        self.assertTrue(snapshot["available"])
        self.assertEqual(snapshot["units"]["ssh.service"]["LoadState"], "loaded")
        self.assertEqual(snapshot["units"]["ssh.service"]["ActiveState"], "active")
        self.assertEqual(snapshot["units"]["ssh.socket"]["LoadState"], "not-found")
        self.assertIn("Service unit reports active", snapshot["values"]["SSH activation model"])
        self.assertIn("does not prove this connection", snapshot["values"]["SSH activation model"])
        self.assertIn("Not reported", snapshot["values"]["SSH unit sshd.service"])

    def test_fail2ban_projects_only_numeric_jail_count(self):
        output = "Status\n|- Number of jail:\t2\n`- Jail list:\tsshd, SECRETJAIL\n"
        with patch.object(probe, "tool", return_value="/usr/bin/fail2ban-client"), \
                patch.object(probe, "run", return_value=output):
            count, reason = probe.fail2ban_jail_count()
        self.assertEqual(count, 2)
        self.assertIsNone(reason)
        self.assertNotIn("SECRETJAIL", str((count, reason)))

    def test_apt_periodic_values_are_data_not_evaluated(self):
        output = "UNATTENDED_UPGRADE='1';\nUPDATE_PACKAGE_LISTS='always';\n"
        with patch.object(probe, "tool", return_value="/usr/bin/apt-config"), \
                patch.object(probe, "run", return_value=output):
            values = probe.apt_periodic_values()
        self.assertEqual(values["unattended"], "1")
        self.assertEqual(values["update_lists"], "always")

        injection = "UNATTENDED_UPGRADE='$(id)';"
        with patch.object(probe, "tool", return_value="/usr/bin/apt-config"), \
                patch.object(probe, "run", return_value=injection):
            values = probe.apt_periodic_values()
        self.assertEqual(values["unattended"], "Unrecognized value (not interpreted)")
        self.assertNotIn("$(id)", str(values))

    def test_security_keeps_installation_activity_and_cache_separate(self):
        with patch.object(probe, "tool",
                          side_effect=lambda name: "/usr/bin/" + name
                          if name in ("ufw", "fail2ban-client") else None), \
                patch.object(probe, "package_display", side_effect=lambda name: "Installed version 1"), \
                patch.object(probe, "systemd_snapshot",
                             return_value={"values": {"Security unit fail2ban.service": "ActiveState=active"}}), \
                patch.object(probe, "update_values", return_value={"Cached updates": "Unknown"}), \
                patch.object(probe, "fail2ban_jail_count", return_value=(2, None)), \
                patch.object(probe, "apt_periodic_values",
                             return_value={"unattended": "1", "update_lists": "1", "reason": None}):
            result = probe.security()
        self.assertEqual(result["state"], "partial")
        self.assertEqual(result["values"]["Fail2ban package"], "Installed version 1")
        self.assertEqual(result["values"]["Fail2ban jails"],
                         "2 reported by status (jail names and contents not retained)")
        self.assertEqual(result["values"]["Security unit fail2ban.service"], "ActiveState=active")
        self.assertEqual(result["values"]["Cached updates"], "Unknown")
        self.assertIn("Unknown does not imply disabled", result["values"]["Security coverage"])

    def test_local_accounts_are_bounded_and_password_fields_are_omitted(self):
        passwd_lines = [
            "root:SECRETROOT:0:0:root:/root:/bin/bash",
            "admin:SECRETADMIN:0:0:admin:/home/admin:/bin/bash",
            "deploy:SECRETDEPLOY:1000:1000:Deploy:/home/deploy:/bin/bash",
        ]
        for index in range(20):
            passwd_lines.append("user" + str(index) + ":SECRET" + str(index) + ":"
                                + str(1001 + index) + ":" + str(1001 + index)
                                + ":User:/home/user" + str(index) + ":/bin/bash")
        groups = "\n".join([
            "root:x:0:", "admin:x:0:", "deploy:x:1000:",
            "sudo:x:27:deploy,user1", "wheel:x:10:admin",
        ])
        result = probe.project_accounts("\n".join(passwd_lines), groups, 1000)
        accounts = {key: value for key, value in result["values"].items()
                    if key.startswith("Local account ")}
        self.assertEqual(result["values"]["Local account 1"].split(":", 1)[0], "deploy")
        self.assertLessEqual(len(accounts), 16)
        self.assertIn("not proof of sudo privilege", result["values"]["Local account 1"])
        self.assertIn("limit 16", result["coverage"])
        self.assertTrue(any("UID 0" in value for value in accounts.values()))
        self.assertNotIn("SECRET", str(result))
        self.assertFalse(result["complete"])

    def test_local_accounts_missing_file_is_unknown_not_empty(self):
        result = probe.project_accounts(None, "sudo:x:27:deploy\n", 1000, "unavailable", "ok")
        self.assertEqual(result["values"], {})
        self.assertIn("Unknown", result["coverage"])
        self.assertNotIn("Local account", str(result))

    def test_authorized_keys_projects_algorithm_fingerprint_and_options_only(self):
        blob = ed25519_blob()
        token = key_token(blob)
        restricted_token = key_token(ed25519_blob(1))
        expected = key_fingerprint(blob)
        text = "\n".join([
            "ssh-ed25519 " + token + " SECRETCOMMENT",
            'command="touch /tmp/pwned",no-pty ssh-ed25519 ' + restricted_token + " OTHERCOMMENT",
            "ssh-ed25519 " + token + " DUPLICATECOMMENT",
            "ssh-ed25519 NOT_BASE64 malformed-comment",
            "ssh-ed25519-cert-v01@openssh.com AAAA cert-comment",
            "# SECRETONLYCOMMENT",
        ])
        result = probe.parse_authorized_keys_text(text)
        values = result["values"]
        self.assertIn(expected, values["Authorized key 1"])
        self.assertIn("no restricted options", values["Authorized key 1"])
        self.assertIn("restricted options present", values["Authorized key 2"])
        self.assertIn("duplicate of Authorized key 1", values["Authorized key 3"])
        self.assertIn("Malformed", values["Authorized key 4"])
        self.assertIn("Unsupported SSH certificate", values["Authorized key 5"])
        for secret in ("SECRETCOMMENT", "OTHERCOMMENT", "DUPLICATECOMMENT",
                       "touch /tmp/pwned", "SECRETONLYCOMMENT"):
            self.assertNotIn(secret, str(result))
        self.assertNotIn("NOT_BASE64", values["Authorized key 4"])
        self.assertNotIn("AAAA", values["Authorized key 5"])
        self.assertIn("1 duplicate", result["coverage"])

    def test_authorized_keys_rejects_symlink_and_special_file(self):
        with tempfile.TemporaryDirectory() as home:
            home = os.path.realpath(home)
            ssh_dir = os.path.join(home, ".ssh")
            os.mkdir(ssh_dir)
            target = os.path.join(home, "real_keys")
            with open(target, "w", encoding="utf-8") as stream:
                stream.write("ssh-ed25519 " + key_token(ed25519_blob()) + " synthetic\n")
            link = os.path.join(ssh_dir, "authorized_keys")
            os.symlink(target, link)
            result = probe.authorized_keys_at(home)
            self.assertIn("Rejected", result["coverage"])
            self.assertNotIn("Authorized key 1", result["values"])

            os.unlink(link)
            os.mkfifo(link)
            result = probe.authorized_keys_at(home)
            self.assertIn("Rejected", result["coverage"])
            self.assertNotIn("Authorized key 1", result["values"])

    def test_authorized_keys_rejects_ssh_directory_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            root = os.path.realpath(root)
            real = os.path.join(root, "real")
            home = os.path.join(root, "home")
            os.mkdir(real)
            os.mkdir(home)
            os.symlink(real, os.path.join(home, ".ssh"))
            result = probe.authorized_keys_at(home)
        self.assertIn("Rejected", result["coverage"])
        self.assertIn("component is a symlink", result["coverage"])
        self.assertNotIn("Authorized key 1", result["values"])

    def test_authorized_keys_missing_is_unknown_not_zero(self):
        with tempfile.TemporaryDirectory() as home:
            result = probe.authorized_keys_at(os.path.realpath(home))
        self.assertIn("Unknown", result["coverage"])
        self.assertNotIn("Authorized key 1", result["values"])

    def test_authorized_keys_reads_home_with_brackets(self):
        with tempfile.TemporaryDirectory() as root:
            root = os.path.realpath(root)
            home = os.path.join(root, "home[1]")
            ssh_dir = os.path.join(home, ".ssh")
            os.makedirs(ssh_dir)
            blob = ed25519_blob()
            with open(os.path.join(ssh_dir, "authorized_keys"), "w", encoding="utf-8") as stream:
                stream.write("ssh-ed25519 " + key_token(blob) + " synthetic\n")
            result = probe.authorized_keys_at(home)
        self.assertIn(key_fingerprint(blob), result["values"]["Authorized key 1"])

    def test_authorized_keys_rejects_symlink_home_and_ancestor(self):
        with tempfile.TemporaryDirectory() as root:
            root = os.path.realpath(root)
            real_home = os.path.join(root, "real-home")
            ssh_dir = os.path.join(real_home, ".ssh")
            os.makedirs(ssh_dir)
            with open(os.path.join(ssh_dir, "authorized_keys"), "w", encoding="utf-8") as stream:
                stream.write("ssh-ed25519 " + key_token(ed25519_blob()) + " synthetic\n")
            home_link = os.path.join(root, "home-link")
            os.symlink(real_home, home_link)
            result = probe.authorized_keys_at(home_link)
            self.assertIn("Rejected", result["coverage"])
            self.assertIn("component is a symlink", result["coverage"])
            self.assertNotIn("Authorized key 1", result["values"])

            ancestor_real = os.path.join(root, "ancestor-real")
            nested_home = os.path.join(ancestor_real, "nested", "home")
            os.makedirs(os.path.join(nested_home, ".ssh"))
            with open(os.path.join(nested_home, ".ssh", "authorized_keys"),
                      "w", encoding="utf-8") as stream:
                stream.write("ssh-ed25519 " + key_token(ed25519_blob()) + " synthetic\n")
            ancestor_link = os.path.join(root, "ancestor-link")
            os.symlink(ancestor_real, ancestor_link)
            result = probe.authorized_keys_at(os.path.join(ancestor_link, "nested", "home"))
            self.assertIn("Rejected", result["coverage"])
            self.assertIn("component is a symlink", result["coverage"])
            self.assertNotIn("Authorized key 1", result["values"])

    def test_authorized_keys_rejects_parent_components(self):
        with tempfile.TemporaryDirectory() as root:
            root = os.path.realpath(root)
            os.makedirs(os.path.join(root, "home", ".ssh"))
            result = probe.authorized_keys_at(os.path.join(root, "home", "..", "home"))
        self.assertIn("Rejected", result["coverage"])
        self.assertIn("unsafe components", result["coverage"])
        self.assertNotIn("Authorized key 1", result["values"])

    def test_authorized_keys_rejects_missing_no_follow_support(self):
        with tempfile.TemporaryDirectory() as home:
            home = os.path.realpath(home)
            os.makedirs(os.path.join(home, ".ssh"))
            with patch.object(probe.os, "O_NOFOLLOW", 0):
                result = probe.authorized_keys_at(home)
        self.assertIn("Rejected", result["coverage"])
        self.assertIn("no-follow directory traversal is unsupported", result["coverage"])
        self.assertNotIn("Authorized key 1", result["values"])

    def test_authorized_keys_directory_swap_does_not_redirect_pinned_read(self):
        with tempfile.TemporaryDirectory() as root:
            root = os.path.realpath(root)
            home = os.path.join(root, "home")
            ssh_dir = os.path.join(home, ".ssh")
            os.makedirs(ssh_dir)
            original = ed25519_blob(11)
            other = ed25519_blob(12)
            with open(os.path.join(ssh_dir, "authorized_keys"), "w", encoding="utf-8") as stream:
                stream.write("ssh-ed25519 " + key_token(original) + " original\n")
            other_dir = os.path.join(root, "other-ssh")
            os.mkdir(other_dir)
            with open(os.path.join(other_dir, "authorized_keys"), "w", encoding="utf-8") as stream:
                stream.write("ssh-ed25519 " + key_token(other) + " other\n")
            old_dir = os.path.join(home, "old-ssh")
            real_open = os.open
            swapped = {"done": False}

            def swapping_open(path, flags, mode=0o777, *, dir_fd=None):
                if path == "authorized_keys" and dir_fd is not None and not swapped["done"]:
                    swapped["done"] = True
                    os.rename(ssh_dir, old_dir)
                    os.symlink(other_dir, ssh_dir)
                return real_open(path, flags, mode, dir_fd=dir_fd)

            with patch.object(probe.os, "open", side_effect=swapping_open):
                result = probe.authorized_keys_at(home)
        self.assertTrue(swapped["done"])
        self.assertIn(key_fingerprint(original), result["values"]["Authorized key 1"])
        self.assertNotIn(key_fingerprint(other), str(result))

    def test_authorized_keys_entry_cap(self):
        lines = ["ssh-ed25519 " + key_token(ed25519_blob(seed)) + " capped"
                 for seed in range(33)]
        result = probe.parse_authorized_keys_text("\n".join(lines))
        self.assertEqual(len(result["values"]), 32)
        self.assertIn("Authorized key 32", result["values"])
        self.assertNotIn("Authorized key 33", result["values"])
        self.assertIn("32 of 33", result["coverage"])
        self.assertIn("Entry cap reached", result["coverage"])
        self.assertFalse(result["complete"])

    def test_public_blob_framing_accepts_known_public_shapes(self):
        fixtures = {
            "ssh-ed25519": ed25519_blob(),
            "ssh-rsa": ssh_blob("ssh-rsa", b"\x01\x00\x01", b"\x00\x80" + bytes(126)),
            "ecdsa-sha2-nistp256": ssh_blob("ecdsa-sha2-nistp256", "nistp256",
                                            b"\x04" + bytes(64)),
            "sk-ssh-ed25519@openssh.com": ssh_blob("sk-ssh-ed25519@openssh.com",
                                                   bytes(32), "ssh:"),
            "sk-ecdsa-sha2-nistp256@openssh.com": ssh_blob(
                "sk-ecdsa-sha2-nistp256@openssh.com", "nistp256",
                b"\x04" + bytes(64), "ssh:"),
        }
        for keytype, blob in fixtures.items():
            self.assertTrue(probe.validate_public_blob(keytype, blob), keytype)

    def test_public_blob_framing_rejects_malformed_sk_ecdsa_and_rsa(self):
        rsa_e = b"\x01\x00\x01"
        rsa_n = b"\x00\x80" + bytes(126)
        malformed = [
            ("sk-ssh-ed25519@openssh.com",
             ssh_blob("sk-ssh-ed25519@openssh.com", bytes(32))),
            ("sk-ssh-ed25519@openssh.com",
             ssh_blob("sk-ssh-ed25519@openssh.com", bytes(32), b"")),
            ("sk-ssh-ed25519@openssh.com",
             ssh_blob("sk-ssh-ed25519@openssh.com", bytes(31), "ssh:")),
            ("sk-ssh-ed25519@openssh.com",
             ssh_blob("sk-ssh-ed25519@openssh.com", bytes(32), "ssh:", b"extra")),
            ("sk-ecdsa-sha2-nistp256@openssh.com",
             ssh_blob("sk-ecdsa-sha2-nistp256@openssh.com", "nistp256",
                      b"\x04" + bytes(64))),
            ("sk-ecdsa-sha2-nistp256@openssh.com",
             ssh_blob("sk-ecdsa-sha2-nistp256@openssh.com", "nistp384",
                      b"\x04" + bytes(64), "ssh:")),
            ("sk-ecdsa-sha2-nistp256@openssh.com",
             ssh_blob("sk-ecdsa-sha2-nistp256@openssh.com", "nistp256",
                      b"\x04" + bytes(63), "ssh:")),
            ("ecdsa-sha2-nistp256",
             ssh_blob("ecdsa-sha2-nistp256", "nistp384", b"\x04" + bytes(64))),
            ("ecdsa-sha2-nistp256",
             ssh_blob("ecdsa-sha2-nistp256", "nistp256", b"\x04" + bytes(63))),
            ("ecdsa-sha2-nistp256",
             ssh_blob("ecdsa-sha2-nistp256", "nistp256", b"\x05" + bytes(64))),
            ("ecdsa-sha2-nistp256",
             ssh_blob("ecdsa-sha2-nistp256", "nistp256", b"\x04" + bytes(64), b"extra")),
            ("ssh-rsa", ssh_blob("ssh-rsa", b"", rsa_n)),
            ("ssh-rsa", ssh_blob("ssh-rsa", rsa_e, b"\x00")),
            ("ssh-rsa", ssh_blob("ssh-rsa", b"\x80\x01", rsa_n)),
            ("ssh-rsa", ssh_blob("ssh-rsa", rsa_e, b"\x80" + bytes(127))),
            ("ssh-rsa", ssh_blob("ssh-rsa", rsa_e, b"\x00\x01")),
            ("ssh-rsa", ssh_blob("ssh-rsa", rsa_e, rsa_n, b"extra")),
            ("ssh-rsa", b"\x00\x00\x00\x07ssh-rsa"),
            ("ssh-ed25519", ed25519_blob() + b"\x00"),
            ("ssh-ed25519", ssh_blob("ssh-rsa", rsa_e, rsa_n)),
        ]
        for keytype, blob in malformed:
            self.assertFalse(probe.validate_public_blob(keytype, blob), keytype)

    def test_authorized_keys_accepts_framed_rsa_ecdsa_and_sk_with_framing_caveat(self):
        fixtures = [
            ("ssh-rsa", ssh_blob("ssh-rsa", b"\x01\x00\x01", b"\x00\x80" + bytes(126))),
            ("ecdsa-sha2-nistp256",
             ssh_blob("ecdsa-sha2-nistp256", "nistp256", b"\x04" + bytes(64))),
            ("sk-ssh-ed25519@openssh.com",
             ssh_blob("sk-ssh-ed25519@openssh.com", bytes(32), "ssh:")),
            ("sk-ecdsa-sha2-nistp256@openssh.com",
             ssh_blob("sk-ecdsa-sha2-nistp256@openssh.com", "nistp256",
                      b"\x04" + bytes(64), "ssh:")),
        ]
        text = "\n".join(keytype + " " + key_token(blob) + " synthetic"
                         for keytype, blob in fixtures)
        result = probe.parse_authorized_keys_text(text)
        self.assertEqual(len(result["values"]), 4)
        self.assertIn("4 frame-valid", result["coverage"])
        self.assertIn("framing validation is not proof of mathematical key validity",
                      result["coverage"])
        for index, (keytype, blob) in enumerate(fixtures, start=1):
            self.assertIn(key_fingerprint(blob),
                          result["values"]["Authorized key " + str(index)])

    def test_evidence_enforces_display_bounds_and_demotes(self):
        result = probe.evidence("system", "T", {"k" * 90: "v" * 600})
        self.assertEqual(result["state"], "partial")
        self.assertLessEqual(max(len(key) for key in result["values"]), 80)
        self.assertLessEqual(max(len(value) for value in result["values"].values()), 512)
        result = probe.evidence("system", "T", {"key" + str(index): "v" for index in range(120)})
        self.assertLessEqual(len(result["values"]), 110)
        self.assertEqual(result["state"], "partial")

    def test_budget_exhaustion_stays_unknown_and_partial(self):
        with patch.object(probe, "_deadline", time.monotonic() - 1):
            self.assertIsNone(probe.run([sys.executable, "-c", "print('ok')"]))
            with patch.object(probe, "tool",
                              side_effect=lambda name: "/usr/bin/dpkg-query"
                              if name == "dpkg-query" else None), \
                    patch.object(probe.shutil, "which", return_value=None):
                result = probe.essentials()
                reason = probe.package_snapshot()["reason"]
        self.assertEqual(result["state"], "partial")
        self.assertIn("budget", reason)
        self.assertIn("Unknown", result["values"]["Package git"])


if __name__ == "__main__":
    unittest.main()
