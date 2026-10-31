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
suffix=uuid.uuid4().hex[:8]
volume_name="fixture-data-"+suffix
network_name="fixture-network-"+suffix
container_name="fixture-app-"+suffix
protected_name="fixture-postgres-"+suffix
project_name="fixture-compose-"+suffix
application_dir="/srv/"+project_name
run({"action":"pull","target":"alpine:3.24"})
run({"action":"createVolume","target":volume_name})
run({"action":"createNetwork","target":network_name})
container=remote(["docker","run","-d","--name",container_name,"alpine:3.24","sleep","3600"])
assert len(container)==64
for action in ("stop","start","restart"):
    run({"action":action,"target":container})
stale=plan({"action":"stop","target":container})
remote(["docker","stop","--time","1",container])
assert rpc({"mode":"execute","request":{"action":"stop","target":container},"plan":stale},ok=False)
protected=remote(["docker","create","--name",protected_name,"alpine:3.24","sleep","3600"])
assert "protected" in rpc({"mode":"preview","request":{"action":"start","target":protected}},ok=False)
snap=rpc({"mode":"snapshot"})
volume=next(v for v in snap["cleanup"] if v["kind"]=="volume" and v["name"]==volume_name)
assert not volume["eligible"]
rpc({"mode":"preview","request":{"action":"cleanup","target":volume_name,"kind":"volume"}},ok=False)
remote(["mkdir","-p",application_dir])
content=json.dumps({"services":{"app":{"image":"alpine:3.24","command":["sleep","3600"],"environment":{"PASSWORD":"fixture-secret-never-logged"}}}})
request={"action":"deploy","target":project_name,"directory":application_dir,"content":content}
# Stopped Docker reservations and host TCP listeners must both block publication.
busy_name="fixture-port-"+suffix
remote(["docker","create","--name",busy_name,"-p","18080:80","alpine:3.24","sleep","3600"])
collision=dict(request,content=json.dumps({"services":{"app":{"image":"alpine:3.24","ports":["18080:80"]}}}))
assert any("reserved" in value for value in plan(collision)["blocked"])
listener='import socket,time; s=socket.socket(); s.bind(("0.0.0.0",18443)); s.listen(); time.sleep(120)'
remote(["python3","-c","import subprocess,time; subprocess.Popen(['python3','-c',"+repr(listener)+"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)"])
collision=dict(request,content=json.dumps({"services":{"app":{"image":"alpine:3.24","ports":["18443:80"]}}}))
assert any("already listening" in value for value in plan(collision)["blocked"])
collision=dict(request,content=json.dumps({"services":{"app":{"image":"alpine:3.24","container_name":container_name}}}))
assert any("container name" in value for value in plan(collision)["blocked"])
evidence=plan(request)
assert "fixture-secret-never-logged" not in json.dumps(evidence)
assert evidence["services"][0]["environment"]==["PASSWORD"]
assert not evidence["blocked"], evidence["blocked"]
run(request)
# Second deployment verifies explicit updates and private config backup creation.
assert plan(request)["blocked"], "Existing project must require explicit update"
request["updateExisting"]=True
other_dir=application_dir+"-other"
remote(["mkdir","-p",other_dir])
assert any("another folder" in value for value in plan(dict(request,directory=other_dir))["blocked"])
result=run(request)
assert result["backup"]
assert remote(["stat","-c","%a",result["backup"]])=="600"
bad=dict(request,content=json.dumps({"services":{"app":{"image":"alpine:3.24","privileged":True}}}))
assert plan(bad)["blocked"]
dangling=remote(["docker","commit",container])
remote(["rc-service","chronyd","stop"],check=False)
future=int(remote(["date","+%s"]))+9*86400
remote(["date","-u","-s","@"+str(future)])
snap=rpc({"mode":"snapshot"})
for kind,target in [("image",dangling),("network",next(n["id"] for n in snap["networks"] if n["name"]==network_name)),("container",container)]:
    candidate=next(r for r in snap["cleanup"] if r["kind"]==kind and r["id"]==target)
    assert candidate["eligible"], candidate["reason"]
    run({"action":"cleanup","kind":kind,"target":target})
assert next(v for v in rpc({"mode":"snapshot"})["volumes"] if v["name"]==volume_name)
print("Real VM: lifecycle, identity/stale checks, protected resources, Compose deploy/backup, pull/create and age-based cleanup passed.")
