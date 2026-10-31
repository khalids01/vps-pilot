"""Fixed Docker management protocol. JSON input/output only; never print raw config/stderr."""
import datetime as dt
import hashlib
import fcntl
import json
import os
import pathlib
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile

LIMIT = 250
HEX = re.compile(r"^[a-f0-9]{64}$")
NAME = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,62}$")
IMAGE = re.compile(r"^[a-z0-9][a-zA-Z0-9_./:@-]{0,254}$")
PROTECTED = ("/etc", "/usr", "/bin", "/sbin", "/lib", "/boot", "/proc", "/sys", "/dev", "/run", "/var/lib", "/var/log")
INFRA = ("dokploy", "coolify", "traefik", "portainer", "sshd", "postgres", "mysql", "mariadb", "mongo", "redis", "etcd", "vault")
class Refused(Exception):
    pass
def cli(args, stdin=None):
    try:
        result = subprocess.run(["docker"] + args, input=stdin, text=True, capture_output=True, timeout=45)
    except subprocess.TimeoutExpired:
        raise Refused("Docker timed out. Its operation may still be running; inspect before retrying.")
    if result.returncode:
        raise Refused("Docker rejected this request. Check permissions, dependencies and Docker/Compose support; no automatic retry.")
    if len(result.stdout) > 2 * 1024 * 1024:
        raise Refused("Docker response exceeded its safety limit.")
    return result.stdout
def lines(args):
    values = [json.loads(line) for line in cli(args).splitlines() if line.strip()]
    if len(values) > LIMIT:
        raise Refused("More than 250 resources; narrow this workload outside this view.")
    return values
def engine():
    value = json.loads(cli(["info", "--format", '{"id":{{json .ID}},"version":{{json .ServerVersion}}}']))
    if not value.get("id"):
        raise Refused("Docker engine identity could not be verified.")
    endpoint=os.environ.get("DOCKER_HOST") if not os.environ.get("DOCKER_CONTEXT") else None
    if not endpoint:
        endpoint=json.loads(cli(["context","inspect","--format",'{{json .Endpoints.docker.Host}}']))
    value["localSocket"]=isinstance(endpoint,str) and endpoint.startswith("unix://")
    return value
def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
def safe_path(value):
    path = os.path.realpath(value)
    if not path.startswith("/") or path == "/" or any(path == p or path.startswith(p + "/") or p.startswith(path + "/") for p in PROTECTED):
        raise Refused("System paths and their ancestors are protected.")
    if any(part.startswith(".vps-pilot-") or part in (".ssh", ".aws", ".kube", ".gnupg") for part in pathlib.Path(path).parts):
        raise Refused("Credential and internal backup paths are protected.")
    return path
def old_enough(value):
    try:
        instant = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (dt.datetime.now(dt.timezone.utc) - instant).total_seconds() >= 7 * 86400
    except (ValueError, TypeError):
        return False
def retention_path():
    return pathlib.Path(os.path.expanduser("~/.local/state/vps-pilot/docker-image-retention.json"))
def read_retention():
    path=retention_path()
    safe_path(str(path))
    if not path.exists():
        return {}
    if path.is_symlink() or path.stat().st_size>512*1024:
        raise Refused("Image retention metadata is unsafe or oversized.")
    value=json.loads(path.read_text())
    if not isinstance(value,dict) or any(not isinstance(ids,list) or len(ids)>4096 or any(not isinstance(i,str) or not re.fullmatch(r"sha256:[a-f0-9]{64}",i) for i in ids) for ids in value.values()):
        raise Refused("Image retention metadata is invalid; cleanup is blocked.")
    return value
def retain_images(engine_id,ids):
    if not ids:
        return
    path=retention_path()
    safe_path(str(path))
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    if path.parent.is_symlink() or path.parent.stat().st_uid!=os.getuid():
        raise Refused("Private retention directory ownership changed.")
    path.parent.chmod(0o700)
    fd=os.open(str(path.parent/"retention.lock"),os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX)
        value=read_retention()
        value[engine_id]=sorted(set(value.get(engine_id,[])+ids))
        if len(value[engine_id])>4096:
            raise Refused("Image retention limit reached; no images were discarded.")
        out,stage=tempfile.mkstemp(prefix="retention-",dir=path.parent)
        try:
            with os.fdopen(out,"w") as stream:
                json.dump(value,stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(stage,path)
        finally:
            if os.path.exists(stage):
                os.unlink(stage)
    finally:
        os.close(fd)
def snapshot():
    identity = engine()
    retained=read_retention().get(identity["id"],[])
    listing = lines(["ps", "-a", "--no-trunc", "--format", '{"id":{{json .ID}}}'])
    ids = [r["id"] for r in listing]
    if any(not HEX.fullmatch(i) for i in ids):
        raise Refused("Invalid container identity.")
    template = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"imageName":{{json .Config.Image}},"state":{{json .State.Status}},"created":{{json .Created}},"finished":{{json .State.FinishedAt}},"started":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"privileged":{{json .HostConfig.Privileged}},"networkMode":{{json .HostConfig.NetworkMode}},"pidMode":{{json .HostConfig.PidMode}},"orchestrator":{{json (index .Config.Labels "com.docker.swarm.service.id")}},"pod":{{json (index .Config.Labels "io.kubernetes.pod.name")}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}'
    containers = lines(["inspect", "--type", "container", "--format", template, "--"] + ids) if ids else []
    for c in containers:
        c["networks"] = list((c["networks"] or {}).keys())
        c["mounts"] = [{k:m.get(k) for k in ("Type", "Name", "Source", "Destination", "RW")} for m in c["mounts"] or []]
        c["protectedReason"] = protect(c)
        c["fingerprint"] = fingerprint(c)
    image_rows = lines(["image", "ls", "--all", "--no-trunc", "--format", '{"id":{{json .ID}}}'])
    image_ids = sorted(set(r["id"] for r in image_rows))
    images = []
    if image_ids:
        raw = json.loads(cli(["image", "inspect", "--"] + image_ids))
        for i in raw:
            refs = [c["name"] for c in containers if c["image"] == i["Id"]]
            refs += ["image "+child["Id"] for child in raw if child.get("Parent")==i["Id"]]
            tags = i.get("RepoTags") or []
            images.append({"kind":"image","id":i["Id"],"name":", ".join(tags) or i["Id"][:19],"tags":tags,"bytes":i["Size"],"created":i["Created"],"references":refs,
                           "reason":"Referenced by containers/images" if refs else "Retained for application rollback" if i["Id"] in retained else "Tagged images are retained for redeploy/rollback" if tags else "Younger than seven days" if not old_enough(i["Created"]) else ""})
    volume_rows = lines(["volume", "ls", "--format", '{"name":{{json .Name}},"driver":{{json .Driver}}}'])
    volumes = [{"kind":"volume","id":v["name"],"name":v["name"],"driver":v["driver"],"references":[c["name"] for c in containers if any(m.get("Name")==v["name"] for m in c["mounts"])],"reason":"Persistent data is always protected from cleanup","bytes":None} for v in volume_rows]
    network_rows = lines(["network", "ls", "--no-trunc", "--format", '{"id":{{json .ID}}}'])
    network_ids = [n["id"] for n in network_rows]
    networks = []
    if network_ids:
        raw = json.loads(cli(["network", "inspect", "--"] + network_ids))
        for n in raw:
            refs = [c["name"] for c in containers if n["Name"] in c["networks"]]
            reason = ("Built-in or infrastructure network" if n["Name"] in ("bridge","host","none") or n.get("Ingress") or n.get("ConfigOnly") or n["Driver"]!="bridge"
                      else "Referenced by containers, including stopped containers" if refs
                      else "Compose-managed network" if (n.get("Labels") or {}).get("com.docker.compose.project")
                      else "Younger than seven days" if not old_enough(n.get("Created")) else "")
            networks.append({"kind":"network","id":n["Id"],"name":n["Name"],"driver":n["Driver"],"references":refs,"reason":reason,"bytes":None})
    stopped = [{"kind":"container","id":c["id"],"name":c["name"],"references":[],"bytes":None,
                "reason":c["protectedReason"] or ("Not stopped" if c["state"]!="exited" else "Mounted data is protected" if c["mounts"] else "Compose-managed container" if c["project"] else "Stopped less than seven days ago" if not old_enough(c["finished"]) else "")} for c in containers]
    resources = images + networks + volumes + stopped
    for r in resources:
        r["eligible"] = not r["reason"]
        r["fingerprint"] = fingerprint(r)
    return {"engine":identity,"containers":containers,"images":images,"networks":networks,"volumes":volumes,"cleanup":resources,
            "observedAt":int(dt.datetime.now(dt.timezone.utc).timestamp()),"buildCache":"Not eligible: exact cache dependency evidence is not available"}
def protect(c):
    if c.get("orchestrator") or c.get("pod"):
        return "Orchestrator-managed container is protected"
    name = (str(c["name"]) + " " + str(c.get("project") or "") + " " + c["imageName"]).lower()
    if any(word in name for word in INFRA):
        return "Infrastructure/database container is protected"
    if c["privileged"] or c["networkMode"]=="host" or c["pidMode"]=="host":
        return "Host-integrated container is protected"
    for mount in c["mounts"]:
        if mount["Type"] == "bind":
            try:
                safe_path(mount["Source"])
            except Refused:
                return "Host system/credential mount is protected"
            if "docker.sock" in mount["Source"]:
                return "Docker socket mount is protected"
    return ""
def validate_name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value):
        raise Refused("Use a name up to 63 characters: lowercase letters, digits, dot, underscore or hyphen.")
def unsafe_service(service):
    return bool(service.get("privileged") or service.get("network_mode") not in (None,"","bridge","none")
        or service.get("pid") not in (None,"","private") or service.get("ipc") not in (None,"","private","shareable")
        or any(service.get(key) for key in ("cap_add","devices","device_cgroup_rules","sysctls","volumes_from","use_api_socket","security_opt","post_start","pre_stop"))
        or service.get("cgroup")=="host")

def compose(content, directory, project):
    validate_name(project)
    directory = safe_path(directory)
    if not os.path.isdir(directory) or directory in ("/root","/home","/srv","/opt","/tmp"):
        raise Refused("Choose an existing application folder, not a home/system root.")
    if not isinstance(content,str) or len(content.encode())>1024*1024:
        raise Refused("Compose content must be at most 1 MiB.")
    config = json.loads(cli(["compose","--project-name",project,"--project-directory",directory,"-f","-","config","--format","json"],content))
    services = config.get("services") or {}
    if not services or len(services)>25:
        raise Refused("Deploy one to 25 services at a time.")
    summary, reasons = [], []
    for kind in ("configs","secrets"):
        for definition in (config.get(kind) or {}).values():
            if definition.get("external"):
                reasons.append("External "+kind+" require a separate supported workflow")
            if definition.get("file"):
                try:
                    safe_path(definition["file"])
                except Refused:
                    reasons.append("Protected "+kind+" file source")
    for name,s in services.items():
        if unsafe_service(s):
            reasons.append(name+": host integration/extra privileges are protected")
        if any(word in (project+" "+name).lower() for word in INFRA):
            reasons.append(name+": infrastructure/database deployment requires its supported workflow")
        image = s.get("image")
        if not image or not IMAGE.fullmatch(image) or s.get("build"):
            reasons.append(name+": use a previously pulled image; builds are not enabled")
        elif not cli_image_exists(image):
            reasons.append(name+": image is not local; review a pull first")
        for m in s.get("volumes") or []:
            if m.get("type")=="bind":
                try:
                    safe_path(m.get("source",""))
                except Refused:
                    reasons.append(name+": protected bind source")
                if "docker.sock" in m.get("source",""):
                    reasons.append(name+": Docker socket mounts are protected")
        ports = [str(p.get("published","")) for p in s.get("ports") or []]
        if any(p in ("22","2375","2376") for p in ports):
            reasons.append(name+": SSH and Docker control ports are protected")
        summary.append({"name":name,"containerName":s.get("container_name"),"image":image,"imageId":cli(["image","inspect","--format","{{.Id}}","--",image]).strip() if image and cli_image_exists(image) else None,"ports":ports,"environment":list((s.get("environment") or {}).keys()),"mounts":[{"type":v.get("type"),"source":v.get("source"),"target":v.get("target")} for v in s.get("volumes") or []]})
    target = os.path.join(directory,"compose.yaml")
    if os.path.lexists(target) and (os.path.islink(target) or not os.path.isfile(target)):
        raise Refused("Compose destination must be a regular file, never a symbolic link.")
    existing = pathlib.Path(target).read_bytes() if os.path.exists(target) else b""
    if len(existing)>1024*1024:
        raise Refused("Existing Compose file exceeds the backup limit.")
    return {"directory":directory,"project":project,"target":target,"services":summary,"blocked":sorted(set(reasons)),
            "volumes":config.get("volumes") or {},"networks":config.get("networks") or {},
            "configHash":fingerprint(config),"contentHash":hashlib.sha256(content.encode()).hexdigest(),"originalHash":hashlib.sha256(existing).hexdigest(),"exists":os.path.exists(target),"originalStat":file_stat(target)}
def file_stat(target):
    if not os.path.lexists(target):
        return None
    value=os.lstat(target)
    if not stat.S_ISREG(value.st_mode):
        raise Refused("Compose target is not a regular file.")
    return [value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_mode]
def cli_image_exists(ref):
    try:
        cli(["image","inspect","--format","{{.Id}}","--",ref])
        return True
    except Refused:
        return False
def check_application(plan,snap,project,update):
    existing=[c for c in snap["containers"] if c["project"]==project]
    if existing and not update:
        plan["blocked"].append("This application name already exists. Choose another name or explicitly enable updating the existing application.")
    if existing and any(not c.get("workingDir") or os.path.realpath(c["workingDir"])!=plan["directory"] for c in existing):
        plan["blocked"].append("Existing application belongs to another folder, or its folder could not be verified.")
    names=set()
    for service in plan["services"]:
        name=service.get("containerName")
        if not name:
            continue
        if name in names:
            plan["blocked"].append(service["name"]+": duplicate container name.")
        names.add(name)
        if any(c["name"].lstrip("/")==name and (c["project"]!=project or c.get("service")!=service["name"]) for c in snap["containers"]):
            plan["blocked"].append(service["name"]+": container name already belongs to another container.")
    for kind in ("volumes","networks"):
        for definition in plan.get(kind,{}).values():
            if definition.get("external"):
                plan["blocked"].append("External "+kind+" require a separate supported workflow; existing application resources are protected.")
            resource=definition.get("name")
            if resource and any(r["name"]==resource for r in snap.get(kind,[])):
                references=[c for c in snap["containers"] if
                    any(m.get("Type")=="volume" and m.get("Name")==resource for m in c.get("mounts",[]))] if kind=="volumes" else [
                    c for c in snap["containers"] if resource in (c.get("networks") or {})]
                if not existing or not references or any(c["project"]!=project for c in references):
                    plan["blocked"].append("Existing "+kind+" resource is not exclusively owned by this application.")
    for service in plan["services"]:
        for mount in service.get("mounts",[]):
            source=mount.get("source")
            if mount.get("type")!="bind" or not source:
                continue
            source=os.path.realpath(source)
            for c in snap["containers"]:
                if c["project"]==project:
                    continue
                for current in c.get("mounts",[]):
                    other=os.path.realpath(current.get("Source") or "/")
                    if current.get("Type")=="bind" and (source==other or source.startswith(other.rstrip("/")+"/") or other.startswith(source.rstrip("/")+"/")):
                        plan["blocked"].append(service["name"]+": host folder overlaps another container's mounted data.")
    plan["updateExisting"]=bool(update)
    plan["applicationEvidence"]=[{key:c.get(key) for key in ("id","image","state","started","restarts","service","workingDir","ports","mounts","networks")} for c in existing]

def check_ports(plan,snap,project):
    reserved=set()
    owned=set()
    for container in snap["containers"]:
        updating=container["project"]==project and container.get("service") in {s["name"] for s in plan["services"]}
        ports=owned if updating and container.get("state") in ("running","paused") else reserved
        if updating and container.get("state") not in ("running","paused"):
            continue
        for key,bindings in (container.get("ports") or {}).items():
            protocol=key.rsplit("/",1)[-1]
            for binding in bindings or []:
                ports.add((protocol,str(binding.get("HostPort",""))))
    listening=set()
    try:
        for protocol in ("tcp","udp"):
            for suffix in ("","6"):
                for line in pathlib.Path("/proc/net/"+protocol+suffix).read_text().splitlines()[1:]:
                    fields=line.split()
                    if protocol=="tcp" and fields[3]!="0A":
                        continue
                    listening.add((protocol,str(int(fields[1].rsplit(":",1)[1],16))))
    except (OSError,IndexError,ValueError):
        plan["blocked"].append("Host port availability could not be verified.")
        return
    requested=set()
    for service in plan["services"]:
        for published in service["ports"]:
            if not published:
                continue
            if published in requested:
                plan["blocked"].append(service["name"]+": duplicate published port "+published+".")
            requested.add(published)
            if not published.isdigit() or not 1<=int(published)<=65535:
                plan["blocked"].append(service["name"]+": use a single explicit published port per mapping.")
            elif ("tcp",published) in reserved or ("udp",published) in reserved or any((p,published) in listening and (p,published) not in owned for p in ("tcp","udp")):
                plan["blocked"].append(service["name"]+": published port "+published+" is reserved or already listening.")
def preview(request):
    action=request["action"]
    snap=snapshot()
    plan={"action":action,"engine":snap["engine"],"name":"","target":request.get("target",""),"warning":"No automatic retry or rollback. Completed changes remain applied.","blocked":[]}
    target=request.get("target","")
    if not snap["engine"]["localSocket"]:
        plan["blocked"].append("Mutations require a Docker engine on this SSH host's local Unix socket.")
    if action in ("start","stop","restart"):
        c=next((c for c in snap["containers"] if c["id"]==target),None)
        if not c:
            raise Refused("Container is no longer available.")
        if c["protectedReason"]:
            raise Refused(c["protectedReason"])
        if action=="start" and c["state"] not in ("exited","created") or action in ("stop","restart") and c["state"]!="running":
            raise Refused("Container state is incompatible; refresh first.")
        plan.update(name=c["name"],fingerprint=c["fingerprint"],command=shlex.join(["docker",action]+(["--time","10"] if action in ("stop","restart") else [])+["--",target]))
    elif action=="cleanup":
        r=next((r for r in snap["cleanup"] if r["id"]==target and r["kind"]==request.get("kind")),None)
        if not r or not r["eligible"]:
            raise Refused(r["reason"] if r else "Resource is unavailable.")
        if r["kind"]=="volume":
            raise Refused("Volume deletion is never a cleanup action.")
        args={"image":["image","rm"],"network":["network","rm"],"container":["rm"]}[r["kind"]]
        plan.update(name=r["name"],kind=r["kind"],fingerprint=r["fingerprint"],command="docker "+" ".join(args)+" -- "+target)
        if r["kind"]=="container":
            plan["warning"]="This irreversibly deletes the container writable layer and logs. Back up needed files first. Volumes are not removed. No automatic retry or rollback."
    elif action in ("pull","createNetwork","createVolume"):
        if action=="pull":
            if not isinstance(target,str) or not IMAGE.fullmatch(target) or "://" in target or "@" in target and not re.search(r"@sha256:[a-f0-9]{64}$",target):
                raise Refused("Use a valid image reference without credentials or whitespace.")
            args=["image","pull","--",target]
        else:
            validate_name(target)
            collection=snap["networks"] if action=="createNetwork" else snap["volumes"]
            if any(r["name"]==target for r in collection):
                raise Refused("A resource with this name already exists.")
            args=["network","create","--driver","bridge","--",target] if action=="createNetwork" else ["volume","create","--",target]
        plan.update(name=target,command="docker "+" ".join(args))
        if action=="pull" and cli_image_exists(target):
            plan["retainImages"]=[cli(["image","inspect","--format","{{.Id}}","--",target]).strip()]
    elif action=="deploy":
        if any(c["project"]==target and c["protectedReason"] for c in snap["containers"]):
            raise Refused("Existing project contains protected infrastructure or database containers.")
        c=compose(request["content"],request["directory"],target)
        engine_blockers=plan["blocked"]
        plan.update(c)
        plan["blocked"]+=engine_blockers
        check_application(plan,snap,target,request.get("updateExisting") is True)
        check_ports(plan,snap,target)
        plan["file"]=c["target"]
        plan["target"]=target
        plan["name"]=target
        plan["retainImages"]=sorted(set(c["image"] for c in snap["containers"] if c["project"]==target))
        plan["command"]=shlex.join(["docker","compose","--project-name",target,"--project-directory",c["directory"],"-f",c["target"],"up","-d","--no-build","--pull","never","--wait","--wait-timeout","20"])
    else:
        raise Refused("Unsupported operation.")
    return plan
def execute(request):
    expected=request["plan"]
    current=preview(request["request"])
    if fingerprint(current)!=fingerprint(expected):
        raise Refused("Docker state or dependencies changed after review. Nothing was changed.")
    if current.get("blocked"):
        raise Refused("This deployment has unresolved safety checks.")
    action=current["action"]
    target=current["target"]
    backup=None
    retain_images(current["engine"]["id"],current.get("retainImages",[]))
    if action in ("start","stop","restart"):
        args=[action]
        if action in ("stop","restart"):
            args+=["--time","10"]
        args+=["--",target]
    elif action=="cleanup":
        args={"image":["image","rm"],"network":["network","rm"],"container":["rm"]}[current["kind"]]+["--",target]
    elif action=="pull":
        args=["image","pull","--",target]
    elif action=="createNetwork":
        args=["network","create","--driver","bridge","--",target]
    elif action=="createVolume":
        args=["volume","create","--",target]
    elif action=="deploy":
        directory=current["directory"]
        if safe_path(directory)!=directory:
            raise Refused("Deployment directory changed.")
        target_path=pathlib.Path(current["file"])
        if current["exists"]:
            folder=pathlib.Path(tempfile.mkdtemp(prefix=".vps-pilot-compose-backup-",dir=directory))
            folder.chmod(0o700)
            (folder/".gitignore").write_text("*\n")
            backup=folder/"compose.yaml"
            backup.write_bytes(target_path.read_bytes())
            backup.chmod(0o600)
        fd,stage=tempfile.mkstemp(prefix=".vps-pilot-compose-stage-",dir=directory)
        try:
            with os.fdopen(fd,"w") as out:
                out.write(request["request"]["content"])
                out.flush()
                os.fsync(out.fileno())
            original=target_path.read_bytes() if target_path.exists() else b""
            if safe_path(directory)!=directory or file_stat(str(target_path))!=current["originalStat"] or hashlib.sha256(original).hexdigest()!=current["originalHash"]:
                raise Refused("Compose file changed during staging. Backup retained.")
            os.replace(stage,target_path)
        finally:
            if os.path.exists(stage):
                os.unlink(stage)
        args=["compose","--project-name",target,"--project-directory",directory,"-f",str(target_path),"up","-d","--no-build","--pull","never","--wait","--wait-timeout","20"]
    try:
        cli(args)
    except Refused:
        return {"status":"uncertain","message":"Docker did not confirm success. Changes/configuration may already be applied. Inspect before retrying.","backup":str(backup) if backup else None}
    result=snapshot()
    if action in ("start","restart","stop"):
        container=next((c for c in result["containers"] if c["id"]==target),None)
        wanted="exited" if action=="stop" else "running"
        if not container or container["state"]!=wanted:
            return {"status":"uncertain","message":"Post-action state was not confirmed. Inspect before retrying.","backup":None}
    return {"status":"completed","message":"Docker confirmed the operation; inventory was refreshed.","backup":str(backup) if backup else None,"snapshot":result}
def main(request):
    if request["mode"]=="snapshot":
        return snapshot()
    if request["mode"]=="preview":
        return preview(request["request"])
    if request["mode"]=="execute":
        return execute(request)
    raise Refused("Unknown Docker request.")
if __name__=="__main__":
    try:
        raw=sys.stdin.buffer.readline(1100000)
        if len(raw)>=1100000:
            raise Refused("Request exceeds its safety limit.")
        print(json.dumps({"ok":True,"value":main(json.loads(raw))},separators=(",",":")))
    except Refused as error:
        print(json.dumps({"ok":False,"error":str(error)}))
    except Exception:
        print(json.dumps({"ok":False,"error":"Docker evidence was incomplete or unsupported. Nothing was retried."}))
