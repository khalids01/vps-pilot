"""Explicit real Docker tests in the app-created disposable VM only."""
import json, os, pathlib, shlex, subprocess, time, uuid

metadata_path=pathlib.Path(os.environ["VPS_PILOT_DOCKER_VM_FILE"])
assert str(metadata_path).startswith("/tmp/vps-pilot-docker-vm-")
meta=json.loads(metadata_path.read_text())
assert meta["host"]=="127.0.0.1"
base=["ssh","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","UserKnownHostsFile="+str(metadata_path.parent/"known_hosts"),"-i",meta["key"],"-p",str(meta["port"]),"root@127.0.0.1"]
def remote(args,content=None,check=True):
    return subprocess.run(base+[shlex.join(args)],input=content,text=True,capture_output=True,check=check,timeout=120).stdout.strip()
assert remote(["test","-f","/root/vps-pilot-disposable-vm"])==""
script=pathlib.Path("src-tauri/src/ssh/docker_manager.py").read_text()
def rpc(payload,ok=True):
    raw=remote(["python3","-I","-S","-c",script],json.dumps(payload)+"\n")
    response=json.loads(raw)
    assert response["ok"]==ok, response.get("error","unexpected success")
    return response.get("value") if ok else response["error"]
def plan(request):
    return rpc({"mode":"preview","request":request})
def run(request):
    evidence=plan(request)
    result=rpc({"mode":"execute","request":request,"plan":evidence})
    assert result["status"]=="completed", result["message"]
    return result

suffix=uuid.uuid4().hex[:10]
volume_name="fixture-cleanup-volume-"+suffix
network_name="fixture-cleanup-network-"+suffix
container_name="fixture-cleanup-container-"+suffix
remote(["docker","pull","alpine:3.24"])
remote(["docker","volume","create",volume_name])
remote(["docker","network","create",network_name])
container=remote(["docker","run","-d","--name",container_name,"alpine:3.24","sleep","1"])
remote(["docker","wait",container])
image=remote(["docker","commit",container])
remote(["rc-service","chronyd","stop"],check=False)
current=int(remote(["date","+%s"]))
remote(["date","-s","@"+str(current+9*86400)])
request={"action":"systemPrune","target":"system","allImages":False}
evidence=plan(request)
assert not evidence["blocked"], evidence["blocked"]
assert "--volumes" not in evidence["command"] and "--force" not in evidence["command"] and "--all" not in evidence["command"]
assert any(r["id"]==image for r in evidence["items"])
result=rpc({"mode":"execute","request":request,"plan":evidence})
assert result["status"]=="completed"
assert isinstance(result["reclaimedBytes"],int)
assert remote(["docker","ps","-a","--filter","id="+container,"--format","{{.ID}}"])==""
assert remote(["docker","image","ls","--no-trunc","--filter","dangling=true","--format","{{.ID}}"]).find(image)<0
assert network_name not in remote(["docker","network","ls","--format","{{.Name}}"]).splitlines()
assert volume_name in remote(["docker","volume","ls","--format","{{.Name}}"]).splitlines()
# Retain an untagged image for rollback and protect mounted/infrastructure data.
protected_name="fixture-postgres-protected-"+suffix
protected=remote(["docker","create","--name",protected_name,"-v",volume_name+":/data","alpine:3.24","sleep","3600"])
held=remote(["docker","commit",protected])
engine_id=rpc({"mode":"snapshot"})["engine"]["id"]
hold_script="ns={'__name__':'fixture'};exec("+repr(script)+",ns);ns['retain_images']("+repr(engine_id)+",["+repr(held)+"])"
remote(["python3","-I","-S","-c",hold_script])
current=int(remote(["date","+%s"]))
remote(["date","-s","@"+str(current+9*86400)])
evidence=plan(request)
assert any("Container" in r for r in evidence["blocked"])
assert any("rollback" in r for r in evidence["blocked"])
rpc({"mode":"execute","request":request,"plan":evidence},ok=False)
assert protected in remote(["docker","ps","-a","--no-trunc","--format","{{.ID}}"]).splitlines()
assert volume_name in remote(["docker","volume","ls","--format","{{.Name}}"]).splitlines()
print("Real disposable VM: system prune reclaimed space; volumes, protected stopped workloads and rollback holds preserved.")
# Release only fixture-owned test objects to exercise the explicit --all mode.
remote(["docker","rm","--",protected])
remote(["docker","image","rm","--",held])
remote(["docker","tag","alpine:3.24","fixture-unused:"+suffix])
# The containerd image store also ages the newly created tag reference.
current=int(remote(["date","+%s"]))
remote(["date","-s","@"+str(current+9*86400)])
all_request=dict(request,allImages=True)
evidence=plan(all_request)
assert not evidence["blocked"], evidence["blocked"]
assert "--all" in evidence["command"]
result=rpc({"mode":"execute","request":all_request,"plan":evidence})
assert result["status"]=="completed"
assert remote(["docker","image","ls","--filter","reference=fixture-unused:"+suffix,"--format","{{.ID}}"])==""
assert volume_name in remote(["docker","volume","ls","--format","{{.Name}}"]).splitlines()
# Actual BuildKit cache, not just an empty df response.
# Restore real time for package TLS; age only disposable data after building.
remote(["date","-s","@"+str(int(time.time()))])
remote(["apk","add","docker-cli-buildx"])
remote(["docker","pull","alpine:3.24"])
build_dir="/srv/fixture-cache-"+suffix
remote(["mkdir","-p",build_dir])
remote(["python3","-c","import pathlib;pathlib.Path("+repr(build_dir+"/Dockerfile")+").write_text('FROM alpine:3.24\\nRUN echo cleanup-fixture >/cache-example\\n')"])
remote(["docker","build","--progress","plain","-t","fixture-cache:"+suffix,build_dir])
current=int(remote(["date","+%s"]))
remote(["date","-s","@"+str(current+9*86400)])
evidence=plan(request)
assert evidence["cache"]["records"]>0, evidence["cache"]
assert not evidence["blocked"], evidence["blocked"]
result=rpc({"mode":"execute","request":request,"plan":evidence})
assert result["status"]=="completed"
assert isinstance(result["reclaimedBytes"],int)
assert plan(request)["cache"]["records"]<evidence["cache"]["records"]
assert volume_name in remote(["docker","volume","ls","--format","{{.Name}}"]).splitlines()
print("Real disposable VM: --all removes unused tags; BuildKit cache prune completes; volume remains protected.")

# A stopped standalone container can make its own image/network reclaimable.
# Running infrastructure and volumes must survive the same system prune.
running_name="fixture-traefik-running-"+suffix
remote(["docker","run","-d","--name",running_name,"alpine:3.24","sleep","3600"])
seed=remote(["docker","create","alpine:3.24"])
cascade_image=remote(["docker","commit",seed])
remote(["docker","rm","--",seed])
cascade_network=remote(["docker","network","create","fixture-cascade-"+suffix])
cascade_container=remote(["docker","run","-d","--name","fixture-cascade-"+suffix,"--network",cascade_network,cascade_image,"sleep","1"])
remote(["docker","wait",cascade_container])
current=int(remote(["date","+%s"]))
remote(["date","-s","@"+str(current+9*86400)])
evidence=plan(request)
assert not evidence["blocked"],evidence["blocked"]
assert all(any(r["id"]==target for r in evidence["items"]) for target in (cascade_image,cascade_container,cascade_network))
result=rpc({"mode":"execute","request":request,"plan":evidence})
assert result["status"]=="completed"
assert remote(["docker","inspect","--format","{{.State.Running}}",running_name])=="true"
assert remote(["docker","ps","-a","--filter","id="+cascade_container,"--format","{{.ID}}"])==""
assert cascade_network not in remote(["docker","network","ls","--no-trunc","--format","{{.ID}}"]).splitlines()
assert cascade_image not in remote(["docker","image","ls","--all","--no-trunc","--format","{{.ID}}"]).splitlines()
assert volume_name in remote(["docker","volume","ls","--format","{{.Name}}"]).splitlines()
print("Real disposable VM: dependent image/network cleaned after stopped container; running infrastructure and volumes preserved.")
