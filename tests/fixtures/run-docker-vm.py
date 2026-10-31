"""Explicit disposable Docker VM. Uses private downloaded QEMU binaries, not host installation.
Run with VPS_PILOT_VM_TOOLS pointing at an extracted tools/image cache.
No existing Docker daemon or remote VPS is used. Ctrl-C destroys the VM process.
"""
import shutil, secrets, functools, hashlib, http.server, json, os, pathlib, socket, subprocess, tempfile, threading, time
tools = pathlib.Path(os.environ.get("VPS_PILOT_VM_TOOLS", "/tmp/vps-pilot-docker-vm-tools"))
root = tools / "root"
for package in tools.glob("*.deb"):
    subprocess.run(["dpkg-deb", "-x", str(package), str(root)], check=True)
env = dict(os.environ, LD_LIBRARY_PATH=str(root / "usr/lib/x86_64-linux-gnu"))
image = tools / "alpine.qcow2"
assert hashlib.sha512(image.read_bytes()).hexdigest() == (tools / "alpine.sha512").read_text().split()[0]
assert os.access("/dev/kvm", os.R_OK | os.W_OK), "KVM unavailable"
work = pathlib.Path(tempfile.mkdtemp(prefix="vps-pilot-docker-vm-"))
os.chmod(work, 0o700)
subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(work / "key")], check=True)
public = (work / "key.pub").read_text().strip()
password_hash = subprocess.check_output(["openssl","passwd","-6","-stdin"],input=secrets.token_hex(32).encode()).decode().strip()
seed = work / "seed"
seed.mkdir()
(seed / "meta-data").write_text("instance-id: vps-pilot-disposable\nlocal-hostname: docker-fixture\n")
(seed / "user-data").write_text("""#cloud-config
disable_root: false
ssh_pwauth: false
users:
  - name: root
    lock_passwd: false
    passwd: """ + password_hash + """
    ssh_authorized_keys:
      - """ + public + """
write_files:
  - path: /root/.ssh/authorized_keys
    permissions: '0600'
    content: """ + public + """
packages:
  - docker
  - docker-cli-compose
runcmd:
  - [chmod, '0700', /root/.ssh]
  - [rc-update, add, docker, default]
  - [rc-service, docker, start]
  - [touch, /root/vps-pilot-disposable-vm]
""")
(seed / "network-config").write_text("version: 2\nethernets:\n  eth0:\n    match:\n      name: 'en*'\n    dhcp4: true\n")
(seed / "vendor-data").write_text("#cloud-config\n")
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(seed))
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
port = listener.getsockname()[1]
listener.close()
disk = work / "disk.qcow2"
subprocess.run([str(root / "usr/bin/qemu-img"), "create", "-f", "qcow2", "-F", "qcow2", "-b", str(image), str(disk), "6G"], env=env, check=True, stdout=subprocess.DEVNULL)
log = (work / "console.log").open("w")
args = [str(root / "usr/bin/qemu-system-x86_64"), "-L", str(root / "usr/share/qemu"),
        "-bios", str(root / "usr/share/seabios/bios-256k.bin"), "-accel", "kvm", "-cpu", "host",
        "-m", "1536", "-smp", "2", "-display", "none", "-vga", "none", "-serial", "stdio", "-monitor", "none",
        "-drive", "file="+str(disk)+",format=qcow2,if=virtio",
        "-netdev", "user,id=n,hostfwd=tcp:127.0.0.1:"+str(port)+"-:22",
        "-device", "virtio-net-pci,netdev=n,romfile=",
        "-smbios", "type=1,serial=ds=nocloud;s=http://10.0.2.2:"+str(server.server_address[1])+"/"]
process = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT)
metadata = {"host":"127.0.0.1","port":port,"key":str(work/"key"),"work":str(work),"pid":process.pid}
(work / "fixture.json").write_text(json.dumps(metadata))
print(json.dumps(metadata), flush=True)
try:
    while process.poll() is None:
        time.sleep(1)
finally:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    server.shutdown()
    log.close()
    if os.environ.get("VPS_PILOT_KEEP_VM_ARTIFACTS")!="1":
        shutil.rmtree(work)
