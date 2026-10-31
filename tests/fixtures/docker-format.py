"""Validate native projections with the real Docker CLI and a loopback fake API.
No Docker daemon, existing Docker context, real container or VPS is contacted.
"""
import http.server
import json
import pathlib
import re
import subprocess
import threading

container_id = "a" * 64
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("API-Version", "1.45")
        self.send_header("OSType", "linux")
        self.end_headers()

    def do_GET(self):
        if self.path == "/_ping":
            self.do_HEAD()
            return
        if re.search(r"/containers/json", self.path):
            body = [{"Id": container_id, "Names": ["/fixture"], "Image": "fixture:1",
                     "State": "running", "Status": "Up 1 minute", "Ports": [],
                     "Labels": {"com.docker.compose.project": "fixture-project"}}]
        elif re.search(r"/containers/"+container_id+r"/json", self.path):
            body = {"Id": container_id, "Name": "/fixture", "Config": {
                "Image": "fixture:1", "Env": ["PASSWORD=must-never-cross-ssh", "PORT=8080"]},
                "State": {"Status": "running", "Running": True, "FinishedAt": "0001-01-01T00:00:00Z", "StartedAt": "2026-10-31T00:00:00Z"},
                "HostConfig": {"RestartPolicy": {"Name": "no"}, "NetworkMode": "bridge", "Privileged": False},
                "NetworkSettings": {"Ports": {}}, "Mounts": [], "RestartCount": 0}
        elif re.search(r"/containers/"+container_id+r"/stats", self.path):
            body = {"id": container_id, "name": "/fixture", "read": "2026-10-31T00:00:01Z",
                    "preread": "2026-10-31T00:00:00Z",
                    "cpu_stats": {"cpu_usage": {"total_usage": 200000000, "percpu_usage": [200000000]}, "system_cpu_usage": 2000000000, "online_cpus": 1},
                    "precpu_stats": {"cpu_usage": {"total_usage": 100000000}, "system_cpu_usage": 1000000000},
                    "memory_stats": {"usage": 12582912, "limit": 1073741824, "stats": {}},
                    "networks": {"eth0": {"rx_bytes": 1048576, "tx_bytes": 2097152}},
                    "blkio_stats": {"io_service_bytes_recursive": []}, "pids_stats": {"current": 4}}
        else:
            self.send_error(404)
            return
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
source = pathlib.Path("src-tauri/src/ssh/docker.rs").read_text()
formats = re.findall(r'Query::(?:List|Details|Stats)\s*=>\s*\{?\s*r#"(.*?)"#', source, re.S)
assert len(formats) == 3
host = "tcp://127.0.0.1:" + str(server.server_address[1])
try:
    rows = subprocess.check_output(
        ["docker", "--host", host, "ps", "-a", "--no-trunc", "--format", formats[0]],
        stderr=subprocess.PIPE, timeout=10).decode()
    assert json.loads(rows)["project"] == "fixture-project"
    detail = subprocess.check_output(
        ["docker", "--host", host, "inspect", "--type", "container", "--format", formats[1], "--", container_id],
        stderr=subprocess.PIPE, timeout=10).decode()
    assert "must-never-cross-ssh" not in detail
    assert json.loads(detail)["environment"] == ["PASSWORD", "PORT", None]
    assert json.loads(detail)["health"] == "not configured"
    stats = subprocess.check_output(
        ["docker", "--host", host, "stats", "--no-stream", "--no-trunc", "--format", formats[2], "--", container_id],
        stderr=subprocess.PIPE, timeout=10).decode()
    assert json.loads(stats)["id"] == container_id
    assert json.loads(stats)["cpu"].endswith("%")
    print("Docker CLI list/details/stats projections passed; environment values excluded.")
except subprocess.CalledProcessError as error:
    raise RuntimeError(error.stderr.decode()) from None
finally:
    server.shutdown()
    server.server_close()
