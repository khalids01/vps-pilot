"""Isolated protocol/client fixtures. Never contacts Docker or a database."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "src-tauri/src/ssh/docker_database.py"
spec = importlib.util.spec_from_file_location("db_adapter", HELPER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def request(engine="postgres", operation="list"):
    return dict(container="a" * 64, engine=engine, operation=operation,
                username="fixture-user", password="private-fixture-$'secret", authDatabase="admin", database="fixture")


class DatabaseAdapterTests(unittest.TestCase):
    def test_credentials_are_stdin_only_for_every_engine(self):
        for engine in ("postgres", "mysql", "mariadb", "mongodb"):
            for operation in ("list", "backup"):
                r = request(engine, operation)
                args, data = module.build(r)
                self.assertNotIn(r["password"], " ".join(args))
                self.assertIn(r["password"], data.decode())
                self.assertNotIn("--password=" + r["password"], args)

    def test_database_and_username_cannot_inject_shell_options_or_connection_fields(self):
        for engine in ("postgres", "mysql", "mariadb", "mongodb"):
            r = request(engine, "backup")
            r["database"] = "name;$(touch BAD)'?host=evil"
            r["username"] = "user;$(touch BAD)'"
            args, data = module.build(r)
            if engine == "postgres":
                uri = args[-1]
                self.assertIn("postgresql://127.0.0.1:5432/", uri)
                self.assertNotIn("?host=evil", uri)
            elif engine in ("mysql", "mariadb"):
                self.assertEqual(args[-1], r["database"])
                self.assertEqual(args[2], 'IFS= read -r MYSQL_PWD || exit 90; export MYSQL_PWD; exec "$@"')
            else:
                self.assertIn("--db=" + r["database"], args)
        for field in ("password", "username", "database", "authDatabase"):
            r = request(); r[field] = "bad\nvalue"
            with self.assertRaises(ValueError): module.build(r)
        r = request(operation="backup"); r["database"] = "--all-databases"
        with self.assertRaises(ValueError): module.build(r)

    def test_mongodb_auth_is_json_escaped_not_eval_argv(self):
        r = request("mongodb"); r["password"] = '\"); quit(0); //'
        args, data = module.build(r)
        self.assertEqual(args, ["mongosh", "--quiet", "--norc", "--nodb", "--file", "/dev/stdin"])
        self.assertIn(json.dumps(r["password"]), data.decode())
        r["operation"] = "backup"
        _, data = module.build(r)
        self.assertEqual(json.loads(data), {"password": r["password"]})

    def test_actual_helper_projects_metadata_streams_binary_and_rejects_changed_container(self):
        with tempfile.TemporaryDirectory() as directory:
            docker = Path(directory) / "docker"
            docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args=sys.argv[1:]
if args[0]=='info': print(json.dumps('fixture-engine'))
elif args[0]=='inspect':
    print(json.dumps('a'*64) if args[4]=='{{json .Id}}' else json.dumps(dict(image='sha256:fixture',started='fixture-start',running=True)))
elif args[0]=='exec':
    secret=sys.stdin.buffer.read()
    assert b'private-fixture' in secret
    assert not any('private-fixture' in a for a in args)
    if os.environ.get('FIXTURE_DB_FAIL'):
        print('SECRET MUST NOT LEAK',file=sys.stderr);sys.exit(9)
    if any(a in args for a in ['pg_dump','mysqldump','mariadb-dump','mongodump']): sys.stdout.buffer.write(b'PGDMP\\x00fixture-binary\\xff')
    else: print('fixture' if ('mysql' in args or 'mariadb' in args) else json.dumps(['fixture']))
else: sys.exit(8)
''')
            docker.chmod(0o700)
            env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]}
            def run(r, extra=None):
                return subprocess.run([sys.executable, "-I", "-S", str(HELPER)], input=(json.dumps(r)+"\n").encode(), capture_output=True, env={**env, **(extra or {})}, timeout=10)
            for engine in ("postgres", "mysql", "mariadb", "mongodb"):
                r = request(engine)
                result = run(r)
                self.assertEqual(result.returncode, 0, result.stderr)
                evidence = json.loads(result.stdout)
                self.assertEqual(evidence["databases"], ["fixture"])
                r.update(evidence); r["operation"] = "backup"
                result = run(r)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, b"PGDMP\x00fixture-binary\xff")
                r["startedAt"] = "changed"
                result = run(r)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
            result = run(request(), {"FIXTURE_DB_FAIL": "1"})
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b"SECRET MUST NOT LEAK", result.stderr)
            self.assertNotIn(b"private-fixture", result.stderr)


if __name__ == "__main__":
    unittest.main()
