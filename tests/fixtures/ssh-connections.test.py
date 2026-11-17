import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("connections", Path(__file__).resolve().parents[2] / "src-tauri/src/ssh/connections.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Connections(unittest.TestCase):
    def test_other_users_ipv4_ipv6_and_nonstandard_port(self):
        tables = {"/proc/net/tcp": "header\n0: 0100007F:EB0C 0200007F:C001 01\n1: 0100007F:0016 0300007F:C002 01\n2: 0100007F:EB0C 00000000:0000 0A\n", "/proc/net/tcp6": "header\n0: 00000000000000000000000001000000:EB0C 00000000000000000000000001000000:C003 01\n"}
        result = m.snapshot("127.0.0.2 49153 127.0.0.1 60172", tables.__getitem__)
        self.assertEqual(len(result["connections"]), 2)
        self.assertEqual(result["connections"][0]["peer"], "127.0.0.2")
        self.assertEqual(result["connections"][1]["peer"], "::1")
    def test_unknown_is_not_zero(self):
        with self.assertRaises(ValueError):
            m.snapshot("", lambda _: "")
        with self.assertRaises(PermissionError):
            m.snapshot("x 1 y 22", lambda _: (_ for _ in ()).throw(PermissionError()))
    def test_table_is_bounded(self):
        with self.assertRaises(ValueError):
            m.snapshot("x 1 y 22", lambda _: "x" * 1048576)

unittest.main()
