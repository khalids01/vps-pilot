"""Fixed read-only Docker database adapter. Private request arrives over stdin."""
import json
import os
import re
import subprocess
import sys
import threading

MAX_LIST = 1024 * 1024


class DatabaseError(ValueError):
    pass


def checked(value, limit=256):
    if not isinstance(value, str) or len(value.encode()) > limit or any(ord(c) < 32 for c in value):
        raise DatabaseError("Invalid database parameter.")
    return value


def build(request):
    engine = request["engine"]
    user = checked(request.get("username", ""))
    password = checked(request.get("password", ""), 4096)
    database = checked(request.get("database", ""))
    auth = checked(request.get("authDatabase", "admin"))
    backup = request["operation"] == "backup"
    if engine not in ("postgres", "mysql", "mariadb", "mongodb") or request["operation"] not in ("list", "backup"):
        raise DatabaseError("Unsupported database operation.")
    if backup and (not database or database.startswith("-")):
        raise DatabaseError("Choose a database without a leading dash.")
    if engine == "postgres":
        from urllib.parse import quote
        uri = "postgresql://127.0.0.1:5432/" + quote(database if backup else "postgres", safe="")
        if user:
            uri += "?user=" + quote(user, safe="")
        args = ["pg_dump", "--no-password", "--format=custom", "--dbname=" + uri] if backup else ["psql", "-X", "--no-password", "--dbname=" + uri, "-A", "-t", "-c", "SELECT COALESCE(json_agg(datname ORDER BY datname),'[]'::json) FROM pg_database WHERE datallowconn AND NOT datistemplate"]
        # Credentials are stdin data, never part of docker exec argv or config.
        script = 'IFS= read -r PGPASSWORD || exit 90; export PGPASSWORD; exec "$@"'
        return ["sh", "-c", script, "vps-pilot-db", *args], (password + "\n").encode()
    if engine in ("mysql", "mariadb"):
        tool = ("mariadb-dump" if engine == "mariadb" else "mysqldump") if backup else ("mariadb" if engine == "mariadb" else "mysql")
        args = [tool, "--no-defaults", "--protocol=TCP", "--host=127.0.0.1", "--port=3306", "--default-character-set=utf8mb4"]
        if user:
            args.append("--user=" + user)
        args += ["--single-transaction", "--quick", "--hex-blob", "--routines", "--events", "--triggers", "--databases", database] if backup else ["--batch", "--skip-column-names", "--execute=SHOW DATABASES"]
        script = 'IFS= read -r MYSQL_PWD || exit 90; export MYSQL_PWD; exec "$@"'
        return ["sh", "-c", script, "vps-pilot-db", *args], (password + "\n").encode()
    if backup:
        args = ["mongodump", "--host=127.0.0.1", "--port=27017", "--archive", "--gzip", "--db=" + database, "--config=/dev/stdin"]
        if user:
            args += ["--username=" + user, "--authenticationDatabase=" + auth]
        return args, json.dumps({"password": password}).encode() if user else b"{}"
    # Script is private stdin, not eval/URI argv; JSON literals cannot inject JS.
    script = 'const c = new Mongo("mongodb://127.0.0.1:27017");\n'
    if user:
        script += 'if (!c.getDB(' + json.dumps(auth) + ').auth(' + json.dumps(user) + ',' + json.dumps(password) + ')) { quit(3); }\n'
    script += 'const r=c.getDB("admin").runCommand({listDatabases:1,nameOnly:true}); if(!r.ok) {quit(4);} print(JSON.stringify(r.databases.map(x=>x.name)));\n'
    return ["mongosh", "--quiet", "--norc", "--nodb", "--file", "/dev/stdin"], script.encode()


def docker_json(args):
    result = subprocess.run(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=True)
    if len(result.stdout) > MAX_LIST:
        raise DatabaseError("Docker metadata exceeds its limit.")
    return json.loads(result.stdout)


def main():
    line = sys.stdin.buffer.readline(16385)
    if len(line) > 16384:
        raise DatabaseError("Database request exceeds its limit.")
    request = json.loads(line)
    container = request["container"]
    if not re.fullmatch(r"[a-f0-9]{64}", container):
        raise DatabaseError("Choose an exact container ID.")
    args, private = build(request)
    engine_id = docker_json(["info", "--format", "{{json .ID}}"])
    # Project only identity/state; never inspect container credential values.
    state = docker_json(["inspect", "--type", "container", "--format", '{{json .Id}}', "--", container])
    identity = docker_json(["inspect", "--type", "container", "--format", '{"image":{{json .Image}},"started":{{json .State.StartedAt}},"running":{{json .State.Running}}}', "--", container])
    if state != container or identity.get("running") is not True:
        raise DatabaseError("Container is no longer running. Refresh inventory.")
    binding = {"engineId": engine_id, "imageId": identity["image"], "startedAt": identity["started"]}
    if request["operation"] == "backup" and any(request.get(k) != v for k, v in binding.items()):
        raise DatabaseError("Docker engine or container changed. List databases again.")
    child = subprocess.Popen(["docker", "exec", "-i", container, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    def send():
        try:
            child.stdin.write(private)
            child.stdin.close()
        except (BrokenPipeError, OSError):
            pass
    threading.Thread(target=send, daemon=True).start()
    if request["operation"] == "backup":
        try:
            while True:
                chunk = child.stdout.read(65536)
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
        except BrokenPipeError:
            child.terminate()
            raise DatabaseError("Backup connection closed.")
        if child.wait() != 0:
            raise DatabaseError("Backup failed. Check credentials, backup privileges and the native dump tool inside the container. No complete backup was saved.")
        after_engine = docker_json(["info", "--format", "{{json .ID}}"])
        after = docker_json(["inspect", "--type", "container", "--format", '{"image":{{json .Image}},"started":{{json .State.StartedAt}},"running":{{json .State.Running}}}', "--", container])
        if after_engine != engine_id or after != identity:
            raise DatabaseError("Container or engine changed during the backup. No complete backup was saved.")
    else:
        output = child.stdout.read(MAX_LIST + 1)
        if len(output) > MAX_LIST:
            child.terminate()
            raise DatabaseError("Database list exceeds its limit.")
        if child.wait() != 0:
            raise DatabaseError("Cannot list databases. Check credentials, authentication database, privileges and the native client inside the container.")
        names = output.decode().splitlines() if request["engine"] in ("mysql", "mariadb") else json.loads(output)
        if not isinstance(names, list) or len(names) > 1000:
            raise DatabaseError("Database list is unsupported or exceeds 1,000 entries.")
        names = [checked(name) for name in names]
        print(json.dumps({**binding, "databases": names}))


if __name__ == "__main__":
    try:
        main()
    except (DatabaseError, KeyError) as error:
        # Only our fixed errors are returned; do not forward DB output/tracebacks.
        allowed = str(error) if isinstance(error, DatabaseError) else "Unsupported database response."
        print(allowed, file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Database operation failed. Check Python 3, Docker socket access, client tools and credentials; no sudo is attempted.", file=sys.stderr)
        sys.exit(1)
