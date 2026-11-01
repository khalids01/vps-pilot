import { expect, test } from "@playwright/test";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

const section = (title: string, columns: string[], rows: string[][], state = rows.length ? "ready" : "empty", message: string | null = null) => ({ title, columns, rows, state, message, truncated: false });
const reports = {
  overview: { overview: { os: "Debian GNU/Linux 12", architecture: "x86_64", memoryTotal: 8589934592, memoryAvailable: 4294967296, cpuTotal: 1000, cpuIdle: 800 }, sections: [section("Filesystems", ["Filesystem", "Total KiB", "Used KiB", "Available KiB", "Used", "Mount"], [["/dev/vda1", "104857600", "41943040", "62914560", "40%", "/"]]), section("Failed services", ["Service", "Loaded", "State", "Detail", "Description"], [])] },
  docker: { overview: null, sections: [section("Containers", ["ID", "Name", "Image", "Status", "Ports"], Array.from({ length: 30 }, (_, index) => [index.toString(16).padStart(64, "a"), `web-${String(index).padStart(2, "0")}`, "nginx:stable", index === 29 ? "Exited (0)" : "Up 2 hours", index === 29 ? "" : "0.0.0.0:8080->80/tcp"])), section("Compose projects", ["Project", "Status", "Configuration"], [["website", "running(2)", "/srv/compose.yml"]]), section("Volumes", ["Name", "Driver", "Scope"], [["app-data", "local", "local"]])] },
  services: { overview: null, sections: [section("Service state", ["Service", "Loaded", "State", "Detail", "Description"], [["app.service", "loaded", "active", "running", "Application worker"]]), section("Boot enablement", ["Service", "Boot state", "Preset"], [["app.service", "enabled", "enabled"]])] },
  storage: { overview: null, sections: [section("Filesystems", ["Filesystem", "Total KiB", "Used KiB", "Available KiB", "Used", "Mount"], [["/dev/vda1", "104857600", "41943040", "62914560", "40%", "/"]]), section("Mount boundaries", ["Mount", "Source", "Filesystem", "Options"], [["/srv/data", "/dev/vdb1", "ext4", "rw"]]), section("Block devices", ["Device", "Type", "Size bytes", "Filesystem", "Mounts"], [["vda1", "part", "107374182400", "ext4", "/"]])] },
  firewall: { overview: null, sections: [section("Firewall rules", ["Rule", "Destination", "Action", "Source"], [["1", "22/tcp", "ALLOW IN", "Anywhere"]], "ready", "UFW is active.")] },
  software: { overview: null, sections: [section("Packages", ["Package", "Version", "State"], [["git", "2.39.5", "installed"]]), section("Detected software", ["Software", "Executable"], [["git", "/usr/bin/git"]])] },
  processes: { overview: null, sections: [section("Processes", ["PID", "Parent PID", "User", "CPU %", "Memory %", "RSS KiB", "Elapsed", "Process"], [["100", "1", "app", "2.1", "1.0", "1024", "01:00", "worker"], ["200", "1", "app", "21.5", "2.0", "2048", "02:00", "server"]])] },
  proxy: { overview: null, sections: [section("Proxy service ownership", ["Service", "State", "Boot state", "Configuration"], [["nginx.service", "active", "enabled", "/etc/nginx/nginx.conf"]])] },
  network: { overview: null, sections: [section("Network counters", ["Interface", "Received bytes", "Sent bytes"], [["eth0", "1048576", "2097152"]])] },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ first, second, reports }) => {
    const profiles = [
      { id: first, revision: "a", name: "Fixture Alpha", host: "alpha.invalid", username: "tester", port: 22 },
      { id: second, revision: "b", name: "Fixture Beta", host: "beta.invalid", username: "tester", port: 2222 },
    ];
    if (!localStorage.getItem("vps-pilot:sample-workspace:v1")) localStorage.setItem("vps-pilot:sample-workspace:v1", JSON.stringify({ version: 1, openServerIds: [`remote:${first}`, `remote:${second}`], activeServerId: `remote:${first}`, servers: {} }));
    const calls: { cmd: string; profileId?: string; intervalSeconds?: number }[] = [];
    const streams = new Map<string, { output: { onmessage: (value: unknown) => void }; sequence: number; timer?: ReturnType<typeof setInterval>; pending?: boolean }>();
    const remoteFiles=new Map(profiles.flatMap(profile=>[
      [`${profile.id}:/home/tester/app.yaml`,{content:"port: 3000\r\n",revision:"1"}],
      [`${profile.id}:/home/tester/notes.txt`,{content:"fixture notes\n",revision:"1"}],
    ]));
    const fileReviews=new Map<string,any>();
    const directories=new Set(profiles.flatMap(p=>["/home/tester/assets","/home/tester/.config"].map(path=>p.id+":"+path)));
    for(const p of profiles)remoteFiles.set(p.id+":/home/tester/.env",{content:"fixture-only",revision:"1"});
    const operationReviews=new Map<string,any>();
    let pendingOperation:((value:any)=>void)|null=null;
    let webState="running";
    const managementPlans=new Map<string,any>();
    let cleanupRemoved=false;
    const managementSnapshot=()=>({
      engine:{id:"fixture-engine-id",version:"29.0"},observedAt:1793400000,buildCache:"Exact cache evidence is unavailable",
      images:[{kind:"image",id:"sha256:"+"d".repeat(64),name:"dangling-fixture",bytes:1048576,references:[],reason:"",eligible:true,fingerprint:"image1"}],
      volumes:[{kind:"volume",id:"database-data",name:"database-data",bytes:null,references:["db"],reason:"Persistent data is always protected",eligible:false,fingerprint:"volume1",driver:"local"}],
      networks:[],
      cleanup:[...(!cleanupRemoved?[{kind:"image",id:"sha256:"+"d".repeat(64),name:"dangling-fixture",bytes:1048576,references:[],reason:"",eligible:true,fingerprint:"image1"}]:[]),
      {kind:"image",id:"sha256:"+"e".repeat(64),name:"rollback-image",bytes:2097152,references:[],reason:"Retained for application rollback",eligible:false,fingerprint:"held"},
      ...((window as any).__twoCleanup?[{kind:"network",id:"n".repeat(64),name:"old-network",bytes:null,references:[],reason:"",eligible:true,fingerprint:"network"}]:[]),
      {kind:"volume",id:"database-data",name:"database-data",bytes:null,references:["db"],reason:"Persistent data is always protected",eligible:false,fingerprint:"volume1"}]
    });
    let next = 0;
    Object.assign(window, {
      isTauri: true,
      __calls: calls,
      __fixtureRemoteFiles:remoteFiles,
      __TAURI_INTERNALS__: {
        transformCallback: () => ++next,
        unregisterCallback: () => {},
        invoke: async (cmd: string, args: Record<string, any> = {}) => {
          // No credentials or user terminal input are retained by the mock.
          calls.push({ cmd, profileId: args.profileId, ...(cmd==="ssh_docker_query"?{query:args.query}:{}), ...(cmd==="ssh_terminal_open"&&args.container?{container:args.container}:{}), ...(cmd === "ssh_monitor_start" ? {intervalSeconds: args.intervalSeconds} : {}) });
          if (cmd === "app_bootstrap") {
            if ((window as any).__databaseUnavailable) throw new Error("Fixture database unavailable");
            return {
              settings: JSON.parse(localStorage.getItem("__fixture_settings") ?? JSON.stringify({liveStats:true,intervalSeconds:1,visibleStats:["cpu","ram","storage","diskIo","network"],zoomPercent:100})),
              documents: JSON.parse(localStorage.getItem("__fixture_documents") ?? "{}"),
            };
          }
          if (cmd === "app_save_settings") {
            if ((window as any).__databaseSaveFailure) throw new Error("Fixture save failure");
            localStorage.setItem("__fixture_settings", JSON.stringify(args.settings));
            return args.settings;
          }
          if (cmd === "app_save_document") {
            const docs = JSON.parse(localStorage.getItem("__fixture_documents") ?? "{}");
            if (!args.import || docs[args.key] === undefined) docs[args.key] = args.value;
            localStorage.setItem("__fixture_documents", JSON.stringify(docs));
            return docs[args.key];
          }
          if (cmd === "app_apply_zoom") {
            (window as any).__appliedZoom = args.zoomPercent;
            return;
          }
          if(cmd==="ssh_files_list"){
            const path=args.path;
            const meta=(path:string,kind:string,size=14)=>({name:path.split("/").pop(),path,kind,size,permissions:kind==="directory"?16877:33184,modified:1700000000,uid:1000,gid:1000});
            const children=(key:string)=>key.startsWith(args.profileId+":"+path+(path==="/"?"":"/"))&&key.slice(args.profileId.length+1).split("/").slice(0,-1).join("/")===path;
            const entries=path==="/"?[meta("/home","directory"),meta("/etc","directory")]:path==="/home"?[meta("/home/tester","directory")]:[
              ...[...directories].filter(children).map(key=>meta(key.slice(args.profileId.length+1),"directory")),
              ...[...remoteFiles.keys()].filter(children).map(key=>meta(key.slice(args.profileId.length+1),"file")),
              ...(path==="/home/tester"?[meta("/home/tester/link.yaml","symlink")]:[])
            ];
            return {path,parent:path==="/"?null:path.split("/").slice(0,-1).join("/")||"/",truncated:false,entries};
          }
          if(cmd==="ssh_files_size")return {path:args.path,bytes:1024,entries:3,complete:true,observedAt:1700000000};
          if(cmd==="ssh_files_review_operation"){
            const input=args.input,token=crypto.randomUUID();
            const items=input.kind==="mkdir"?[{source:"",destination:input.destination+"/"+input.name,kind:"directory"}]:input.paths.map((path:string)=>({source:path,destination:["copy","move"].includes(input.kind)?input.destination+"/"+(input.name??path.split("/").pop())+(input.kind==="copy"?" copy":""):input.kind==="trash"?"/home/tester/.vps-pilot-trash-fixture/original":null,kind:"file"}));
            const review={token,profileId:args.profileId,serverName:"Fixture Alpha",operation:input.kind,items,entries:items.length,bytes:14,expiresInSeconds:120,excludedEntries:0,localDestination:input.kind==="download"?"/fixture/download.zip":null};
            operationReviews.set(token,review);return review;
          }
          if(cmd==="ssh_files_reject_operation"){operationReviews.delete(args.token);return;}
          if(cmd==="ssh_files_execute_operation"){
            const plan=operationReviews.get(args.token);operationReviews.delete(args.token);
            if(!plan)throw "Review expired.";
            if((window as any).__holdFileOperation){
              args.output.onmessage({completed:0,total:plan.items.length,bytes:0,current:plan.items[0].source});
              return new Promise(resolve=>{pendingOperation=resolve;});
            }
            const completed=plan.items.map((item:any)=>{
              const key=args.profileId+":"+item.source,data=remoteFiles.get(key);
              if(plan.operation==="copy"&&data)remoteFiles.set(args.profileId+":"+item.destination,{...data});
              if(plan.operation==="move"&&data){remoteFiles.delete(key);remoteFiles.set(args.profileId+":"+item.destination,{...data});}
              if(plan.operation==="mkdir")directories.add(args.profileId+":"+item.destination);
              if(plan.operation==="trash")remoteFiles.delete(key);
              return {...item,restoreId:plan.operation==="trash"?crypto.randomUUID():null};
            });return {status:"completed",completed,retained:[],error:null};
          }
          if(cmd==="ssh_files_cancel"){if(pendingOperation){pendingOperation({status:"cancelled",completed:[],retained:[],error:"File operation cancelled."});pendingOperation=null;return true;}return false;}
          if(cmd==="ssh_file_read") {
            const file=remoteFiles.get(`${args.profileId}:${args.path}`);
            if(!file)throw "Remote file does not exist.";
            return {path:args.path,...file,size:file.content.length,permissions:33184};
          }
          if(cmd==="ssh_file_review" || cmd==="ssh_file_upload") {
            if((window as any).__remoteFileChanged)throw "The file changed since it was opened. Reload it and review your changes again.";
            if(cmd==="ssh_file_upload" && (window as any).__uploadCancelled)return null;
            const path=cmd==="ssh_file_upload"?"/home/tester/upload.txt":args.path;
            const current=remoteFiles.get(`${args.profileId}:${path}`);
            const token=crypto.randomUUID();
            const result={token,profileId:args.profileId,serverName:profiles.find(profile=>profile.id===args.profileId)?.name,path,backupPath:current?"/home/tester/.vps-pilot-backup-fixture":null,operation:cmd==="ssh_file_upload"?"upload":"edit",bytes:cmd==="ssh_file_upload"?15:new TextEncoder().encode(args.content).length,expiresInSeconds:120};
            fileReviews.set(token,{...result,content:cmd==="ssh_file_upload"?"uploaded fixture":args.content,revision:current?.revision});
            return result;
          }
          if(cmd==="ssh_file_commit") {
            const review=fileReviews.get(args.token);
            fileReviews.delete(args.token);
            if(!review || review.profileId!==args.profileId)throw "File review unavailable.";
            if((window as any).__fileSaveFailure)throw "The destination changed after review. No replacement was made.";
            const revision=String(Number(review.revision??"0")+1);
            remoteFiles.set(`${args.profileId}:${review.path}`,{content:review.content,revision});
            return {path:review.path,backupPath:review.backupPath,revision};
          }
          if(cmd==="ssh_file_reject"){fileReviews.delete(args.token);return;}
          if(cmd==="ssh_file_download")return true;
          if (cmd === "ssh_profiles") return profiles;
          if (cmd === "ssh_statuses") return profiles.map((profile) => ({ profileId: profile.id, connectionId: (window as any).__configurationDisconnected && profile.id===first ? null : `connection-${profile.id}-${(window as any).__connectionGeneration??1}`, status: (window as any).__configurationDisconnected && profile.id===first ? "disconnected" : "connected", error: null }));
          if(cmd === "ssh_configuration_describe") return "python3 [fixed read-only configuration probe]";
          if(cmd === "ssh_configuration_snapshot") {
            if((window as any).__configurationFailure) throw "Fixture configuration unavailable";
            if((window as any).__holdConfiguration) await new Promise(resolve=>{(window as any).__releaseConfiguration=resolve;});
            const evidence=(id:string,title:string,values:Record<string,string>,state="ready",message:string|null=null)=>({id,title,values,state,message});
            return {profileId:args.profileId,connectionId:args.connectionId,observedAt:Date.now(),sections:[
              evidence("system","System",{"Operating system":args.profileId===first?"Debian GNU/Linux 12":"Ubuntu 24.04",Hostname:"fixture-host",Timezone:"UTC","Cached updates":"5 updates (cached; not a current update check)","Update cache timestamp":"2026-10-30 00:00:00 UTC"}),
              evidence("essentials","Essential software",{git:"/usr/bin/git","git package":"git 2.39.5 (installed)","git ownership":"git: /usr/bin/git",curl:"Not found",attention:"true"}),
              evidence("resources","System resources",{"Memory total":"8388608 KiB","Swap total":"0 KiB"}),
              evidence("security","Security",{"Fail2ban installed":"Installed","fail2ban.service ActiveState":"active","Fail2ban jail count":"2","apt-daily-upgrade.timer ActiveState":"active","Automatic update configuration":"1 (observed setting, not proof of execution)"},"partial","Installation alone does not establish protection."),
              evidence("docker","Docker",{CLI:"/usr/bin/docker","CLI version":"Docker fixture"}),
              evidence("ssh","Users and SSH",{"Current user":"tester","Current server port":"22",passwordauthentication:"no",pubkeyauthentication:"yes","Key authentication":"Not independently verified","ssh.socket ActiveState":"active","Local account 1":"tester · UID 1000 · sudo group (privileges not verified)","Local accounts coverage":"Local metadata only; network accounts not enumerated","Authorized key 1":"ssh-ed25519 · SHA256:fixturePublicFingerprint · Restricted options present (values hidden)","Authorized key source":"Authenticated account standard file; daemon source not verified"},"partial","Default invocation only; runtime flags may differ."),
              evidence("firewall","Firewall",{Status:"active","Default policies":"deny (incoming), allow (outgoing)","Rule 1":"22/tcp ALLOW IN Anywhere","Rule 2":"22/tcp (v6) ALLOW IN Anywhere (v6)","Cloud firewall":"Unknown"}),
              evidence("listeners","Listening sockets",{"Socket 1":"tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*"},"ready","Listeners do not prove public reachability."),
            ]};
          }
          if (cmd === "ssh_config_hosts") return [];
          if(cmd==="ssh_docker_snapshot" && (window as any).__failDockerResources)throw "Resource inventory unavailable.";
          if(cmd==="ssh_docker_snapshot")return {snapshot:managementSnapshot(),enabled:true};
          if(cmd==="ssh_docker_review"){
            const request=JSON.parse(args.request),token=crypto.randomUUID();
            (window as any).__lastDockerUpdate=request.updateExisting;
            const evidence={action:request.action,target:request.target,name:request.action==="cleanup"?"dangling-fixture":request.target==="a".repeat(64)?"web":request.target,command:"docker "+request.action+" -- "+request.target,warning:"No automatic rollback or retry.",engine:{id:"fixture-engine-id",version:"29.0"},blocked:[] as string[],services:[] as any[]};
            if(request.action==="cleanupBatch"){
              Object.assign(evidence,{confirmation:"DELETE "+request.targets.length,items:request.targets.map((t:any)=>{const r=managementSnapshot().cleanup.find(r=>r.id===t.id&&r.kind===t.kind);return {kind:t.kind,target:t.id,name:r?.name??t.id};})});
            }
            if(request.action==="systemPrune"){
              Object.assign(evidence,{name:"Docker system prune",confirmation:"PRUNE",items:[],cache:{records:2,active:0,size:"2MB",reclaimable:"1MB"},allImages:request.allImages,
                command:"docker system prune --filter until=123"+(request.allImages?" --all":""),warning:"No Docker dry run exists. This is a preflight estimate, not an exact deletion list. Volumes are never included.",
                blocked:(window as any).__blockedPrune?["Protected workload blocks global prune"]:[]});
            }
            if(request.action==="deploy"){
              const content=request.content;
              evidence.services=[{name:"app",image:"alpine:3.24",ports:["8080"],environment:content.includes("PASSWORD")?["PASSWORD"]:[]}];
              if(content.includes("privileged"))evidence.blocked=["Host privileges are protected"];
            }
            managementPlans.set(token,{request,evidence});return {token,serverName:"Fixture Alpha",evidence,enabled:true};
          }
          if(cmd==="ssh_docker_cancel"){
            (window as any).__resolveCleanup?.();return;
          }
          if(cmd==="ssh_docker_reject"){managementPlans.delete(args.token);return;}
          if(cmd==="ssh_docker_execute"){
            const plan=managementPlans.get(args.token);managementPlans.delete(args.token);
            if(!plan)throw "Review expired or already used.";
            if((window as any).__dockerStale)throw "Docker state changed after review; nothing was changed.";
            if(plan.request.action==="cleanupBatch"){
              args.progress.onmessage({stage:"cleanupReady",message:"Removing selected resources"});
              if((window as any).__holdCleanup)return new Promise(resolve=>{
                (window as any).__resolveCleanup=()=>{cleanupRemoved=true;resolve({status:"cancelled",message:"Removed 1 of 2 selected resources. Remaining items were canceled.",items:plan.evidence.items.map((item:any,index:number)=>({kind:item.kind,id:item.target,name:item.name,status:index?"skipped":"removed",message:index?"Not started: canceled.":"Removed."})),snapshot:managementSnapshot()});};
              });
              cleanupRemoved=true;
              return {status:"completed",message:"Removed selected resources.",items:plan.evidence.items.map((item:any)=>({kind:item.kind,id:item.target,name:item.name,status:"removed",message:"Removed."})),reclaimedBytes:null,snapshot:managementSnapshot()};
            }
            if(plan.request.action==="systemPrune")return {status:"completed",message:"Docker system prune completed.",reclaimedBytes:1048576,snapshot:managementSnapshot()};
            if(plan.request.action==="cleanup")cleanupRemoved=true;
            if(plan.request.action==="stop")webState="exited";
            if(plan.request.action==="start"||plan.request.action==="restart")webState="running";
            args.progress.onmessage({stage:"finished",message:"Operation finished"});
            return {status:"completed",message:"Docker confirmed the operation",backup:plan.request.action==="deploy"?"/srv/my-app/.vps-pilot-compose-backup-fixture/compose.yaml":null,snapshot:managementSnapshot()};
          }
          if(cmd==="ssh_docker_query"){
            if(args.query==="list" && (window as any).__failDockerList)throw "Container inventory unavailable.";

            const id="a".repeat(64),secondId="b".repeat(64);
            const data=args.query==="list"?[
              {id,name:"web",image:"nginx:stable",state:webState,status:webState==="running"?"Up 2 hours (healthy)":"Exited (0)",ports:"8080->80/tcp",project:"website",service:"web"},
              {id:secondId,name:"worker",image:"worker:1",state:"exited",status:"Exited (0)",ports:"",project:"website",service:"worker"},
              {id:"c".repeat(64),name:"standalone",image:"worker:1",state:"running",status:"Up 1 hour",ports:"",project:"",service:""}
            ]:args.query==="details"?[{
              id:args.container,name:args.container===id?"/web":"/worker",image:"nginx:stable",status:args.container===id?webState:"exited",started:"2026-10-31T00:00:00Z",restarts:0,health:"healthy",restartPolicy:"unless-stopped",networkMode:"website_default",privileged:false,mounts:[{Type:"volume",Source:"/fixture/html",Destination:"/usr/share/nginx/html",RW:false}],environment:["DATABASE_PASSWORD","PORT",null]
            }]:[{id:args.container,cpu:"1.25%",memory:"12MiB / 1GiB",memoryPercent:"1.2%",network:"1MB / 2MB",disk:"3MB / 0B",pids:"4"}];
            return {data,command:"docker projected fixture",lifecycleEnabled:false};
          }
          if (cmd === "ssh_monitor_describe") return "exec python3 -I -S -B -u -c '# bounded live sampler fixture'";
          if (cmd === "ssh_monitor_start") {
            if ((window as any).__monitorFailures > 0) {
              (window as any).__monitorFailures--;
              throw new Error("Fixture sampler failure.");
            }
            const id = crypto.randomUUID();
            const stream = {output: args.output, sequence: 0, timer: undefined as ReturnType<typeof setInterval> | undefined, pending: false};
            streams.set(id, stream);
            const emit = () => {
              if (!streams.has(id) || stream.pending) return;
              stream.pending = true;
              const sequence = ++stream.sequence;
              stream.output.onmessage({type: "metrics", id, sequence, sample: {
                uptime: 1000 + sequence * args.intervalSeconds,
                cpuTotal: 10000 + sequence * 100, cpuIdle: 5000 + sequence * 50,
                memoryTotal: 8589934592, memoryAvailable: 4294967296, swapTotal: 0, swapFree: 0,
                networkInterface: "eth0", networkReceived: 1000 + sequence * 1000, networkSent: 2000 + sequence * 500,
                diskRead: 10000 + sequence * 2000, diskWritten: 20000 + sequence * 3000,
                capacity: {total: 107374182400, free: 64424509440, available: 59055800320}, capacityAge: sequence
              }});
            };
            setTimeout(emit, 20);
            stream.timer = setInterval(emit, args.intervalSeconds * 1000);
            return {id, command: "exec python3 -I -S -B -u -c '# bounded live sampler fixture'"};
          }
          if (cmd === "ssh_stream_ack") {
            const stream = streams.get(args.id);
            if (stream?.sequence === args.sequence) stream.pending = false;
          }
          if (cmd === "ssh_inspection_describe") return "uname -m";
          if(cmd==="ssh_action_review"&&args.action.type==="dockerFollow")return {id:"docker-log-plan",command:"timeout -k 2s 55s docker logs --follow --tail 200 -- "+args.action.container,purpose:"Follow logs",serverName:"Fixture Alpha"};
          if(cmd==="ssh_action_execute"&&args.planId==="docker-log-plan"){
            const id=crypto.randomUUID();
            streams.set(id,{output:args.output,sequence:1});
            setTimeout(()=>args.output.onmessage({type:"data",id,sequence:1,data:Array.from(new TextEncoder().encode("fixture application ready\n"))}),20);
            return id;
          }
          if (cmd === "ssh_action_review") return { id: crypto.randomUUID(), profileId: args.profileId, serverName: profiles.find((p) => p.id === args.profileId)?.name, address: "tester@alpha.invalid:22", command: "sudo -S -p '[VPS Pilot sudo password] ' -- /usr/sbin/ufw status numbered", purpose: "Read UFW status. No rules change.", privileged: true, expiresInSeconds: 120, evidence: null };
          if (["ssh_terminal_open", "ssh_inspection_run", "ssh_action_execute"].includes(cmd)) {
            const id = crypto.randomUUID();
            const output = args.output;
            streams.set(id, { output, sequence: 1 });
            if (cmd === "ssh_inspection_run" && (window as any).__holdInspections) return { id, command: "uname -m" };
            setTimeout(() => {
              if (!streams.has(id)) return;
              const text = cmd === "ssh_terminal_open" ? `${args.profileId} shell ready\r\n` : "=== Architecture ===\nx86_64\n";
              output.onmessage({ type: "data", id, sequence: 1, data: Array.from(new TextEncoder().encode(text)) });
              if (cmd !== "ssh_terminal_open") {
                const report = (reports as any)[args.kind ?? "firewall"];
                output.onmessage({ type: "inspection", id, report });
                streams.delete(id); output.onmessage({ type: "closed", id, code: 0, message: "Completed." });
              }
            }, 20);
            return cmd === "ssh_inspection_run" ? { id, command: "uname -m" } : id;
          }
          if (cmd === "ssh_terminal_input") {
            const stream = streams.get(args.id);
            if (stream) stream.output.onmessage({ type: "data", id: args.id, sequence: ++stream.sequence, data: args.data });
          }
          if (cmd === "ssh_stream_close") {
            const stream = streams.get(args.id);
            clearInterval(stream?.timer);
            streams.delete(args.id);
            stream?.output.onmessage({ type: "closed", id: args.id, code: null, message: "Session closed." });
          }
          return null;
        },
      },
    });
  }, { first, second, reports });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Fixture Alpha tools", exact: true })).toBeVisible({timeout:15000});
});

test("restoring VPS tabs does not connect or open terminals; inspection stays server-bound", async ({ page }) => {
  const initial = await page.evaluate(() => (window as any).__calls);
  expect(initial.some((call: any) => ["ssh_connect", "ssh_terminal_open", "ssh_inspection_run"].includes(call.cmd))).toBe(false);
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page.getByRole("button", { name: "Show command console", exact: true }).click();
  await expect(page.getByText("Exact command", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Fixture Beta/ }).click();
  await expect(page.getByRole("navigation", { name: "Fixture Beta tools", exact: true })).toBeVisible();
  await expect(page.getByText("No inspection yet.", { exact: false })).toBeVisible();
  const inspections = await page.evaluate(() => (window as any).__calls.filter((call: any) => call.cmd === "ssh_inspection_run"));
  expect(inspections).toEqual([{ cmd: "ssh_inspection_run", profileId: first }]);
});

test("sudo rejection executes nothing; fresh approval runs only on its server without persistence", async ({ page }) => {
  await page.getByRole("navigation", { name: "Fixture Alpha tools" }).getByRole("button", { name: "Firewall", exact: true }).click();
  await page.getByRole("button", { name: "Review command", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Fixture Alpha");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__calls.filter((call: any) => call.cmd === "ssh_action_execute"))).toEqual([]);
  await page.getByRole("button", { name: "Review command", exact: true }).click();
  await page.getByLabel("Sudo password (when needed)").fill("disposable-ui-secret");
  await page.getByRole("button", { name: "Approve and run", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Show command console", exact: true }).click();
  await expect(page.getByRole("region", { name: "Fixture Alpha command console" })).toContainText("Completed.");
  const executions = await page.evaluate(() => (window as any).__calls.filter((call: any) => call.cmd === "ssh_action_execute"));
  expect(executions).toEqual([{ cmd: "ssh_action_execute", profileId: first }]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("disposable-ui-secret");
});

test("live terminals survive navigation, require close confirmation, and restore without opening SSH", async ({ page }, testInfo) => {
  const nav = page.getByRole("navigation", { name: "Fixture Alpha tools" });
  await nav.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "New shell", exact: true }).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  await nav.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Overview",exact:true}).click();
  await nav.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  expect((await page.evaluate(() => (window as any).__calls.filter((call: any) => call.cmd === "ssh_terminal_open"))).length).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("live-terminals.png") });
  await page.getByRole("button", { name: "Close active session", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("can interrupt");
  await page.getByRole("button", { name: "Keep session", exact: true }).click();
  await page.reload();
  await page.getByRole("navigation", { name: "Fixture Alpha tools" }).getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start shell on Fixture Alpha", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__calls.filter((call: any) => call.cmd === "ssh_terminal_open"))).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("shell ready");
});

test("narrow real workspaces keep terminal and inspection controls accessible", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(page.getByRole("button", { name: "Inspect", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Fixture Alpha tools" }).getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("button", { name: "New shell", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Show command console", exact: true }).click();
  const drawerBounds = await page.getByRole("region", { name: "Fixture Alpha command console" }).boundingBox();
  expect(drawerBounds && drawerBounds.y + drawerBounds.height <= 900).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("narrow-terminals.png") });
});


test("open VPS tabs keep one sampler each across navigation and pause only with the app", async ({ page }) => {
  const starts=()=>page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_monitor_start"));
  const closes=()=>page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_stream_close"));
  await expect.poll(async()=>(await starts()).length).toBe(2);
  expect((await starts()).map((call:any)=>call.profileId).sort()).toEqual([first,second]);
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Network",exact:true}).click();
  await page.getByRole("tab",{name:/Fixture Beta/}).click();
  await expect(page.getByRole("button",{name:"CPU live metrics details"})).toContainText("50.0%");
  await page.getByRole("tab",{name:/Fixture Alpha/}).click();
  await page.getByRole("button",{name:"Fleet home",exact:true}).click();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  expect((await starts()).length).toBe(2);
  expect((await closes()).length).toBe(0);
  expect(await page.evaluate(()=>(window as any).__calls.some((call:any)=>["ssh_connect","ssh_disconnect","ssh_inspection_run"].includes(call.cmd)))).toBe(false);
  await page.evaluate(()=>{
    Object.defineProperty(document,"visibilityState",{get:()=>"hidden",configurable:true});
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async()=>(await closes()).length).toBe(2);
  await page.clock.fastForward(5100);
  expect((await starts()).length).toBe(2);
  await page.evaluate(()=>{
    Object.defineProperty(document,"visibilityState",{get:()=>"visible",configurable:true});
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async()=>(await starts()).length).toBe(4);
  await page.getByRole("button",{name:"Close Fixture Beta SSH tab",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Disconnect and close",exact:true}).click();
  await expect.poll(async()=>(await closes()).filter((call:any)=>call.profileId===second).length).toBe(2);
  expect((await closes()).filter((call:any)=>call.profileId===first).length).toBe(1);
  await page.clock.fastForward(5100);
  expect((await starts()).length).toBe(4);
});

test("production UI exposes read-only service operations", async ({ page }) => {
  await page.getByRole("navigation", { name: "Fixture Alpha tools" }).getByRole("button", { name: "Services", exact: true }).click();
  await expect(page.getByText("Read-only mode:", { exact: false })).toBeVisible();
  await page.getByRole("combobox", { name: "Service operation" }).click();
  await expect(page.getByRole("option", { name: "restart", exact: true })).toBeDisabled();
  await expect(page.getByRole("option", { name: "Read logs", exact: true })).toBeEnabled();
});


test("structured overview keeps raw output in the bottom drawer and connection details collapsed", async ({ page }, testInfo) => {
  const workspace = page.getByRole("tabpanel");
  await expect(workspace.getByText("SSH agent / default keys", { exact: true })).toBeHidden();
  await workspace.getByText("Connection details", { exact: true }).click();
  await expect(workspace.getByText("SSH agent / default keys", { exact: true })).toBeVisible();
  await workspace.getByText("Connection details", { exact: true }).click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByRole("meter", { name: "Memory", exact: true })).toHaveAttribute("value", "50");
  await expect(page.getByRole("region", { name: "Filesystems", exact: true })).toContainText("40 GiB");
  await expect(page.getByRole("main").locator("pre")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("structured-overview.png") });
  const consolePanel = page.getByRole("region", { name: "Fixture Alpha command console" });
  await expect(consolePanel).toContainText("Overview inspection");
  await page.getByRole("button", { name: "Show command console", exact: true }).click();
  await expect(consolePanel).toContainText("uname -m");
  await expect(consolePanel).toContainText("x86_64");
  await page.getByRole("navigation", { name: "Fixture Alpha tools" }).getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(consolePanel).toContainText("uname -m");
  await page.getByRole("tab", { name: /Fixture Beta/ }).click();
  await expect(page.getByRole("region", { name: "Fixture Beta command console" })).toContainText("Actions (0)");
  await expect(page.getByRole("region", { name: "Fixture Beta command console" })).not.toContainText("Overview inspection");
  await page.getByRole("tab", { name: /Fixture Alpha/ }).click();
  await expect(consolePanel).toContainText("uname -m");
  await page.screenshot({ path: testInfo.outputPath("persistent-console.png") });
});

test("Docker diagnostics and other inspections render application tables", async ({ page }, testInfo) => {
  const nav = page.getByRole("navigation", { name: "Fixture Alpha tools" });
  await nav.getByRole("button", { name: "Docker", exact: true }).click();
  await page.getByRole("navigation",{name:"Docker sections"}).getByRole("button",{name:"Diagnostics",exact:true}).click();
  const containers = page.getByRole("region", { name: "Containers", exact: true });
  await expect(containers).toContainText("web-00");
  await expect(containers.getByRole("row")).toHaveCount(26);
  await containers.getByRole("button", { name: "Next", exact: true }).click();
  await expect(containers).toContainText("web-29");
  await containers.getByRole("textbox", { name: "Search Containers" }).fill("web-07");
  await expect(containers.getByRole("row")).toHaveCount(2);
  await expect(containers).toContainText("web-07");
  await page.screenshot({ path: testInfo.outputPath("docker-content.png") });
  for (const tool of ["Services", "Proxy", "Network"]) {
    await nav.getByRole("button", { name: tool, exact: true }).click();
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    await expect(page.getByRole("main").getByRole("table").first()).toBeVisible();
    await expect(page.getByRole("main").locator("pre")).toHaveCount(0);
  }
  await nav.getByRole("button", { name: "Processes", exact: true }).click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  const processes = page.getByRole("region", { name: "Processes", exact: true });
  await processes.getByRole("button", { name: "CPU %", exact: true }).click();
  await processes.getByRole("button", { name: "CPU %", exact: true }).click();
  await expect(processes.getByRole("row").nth(1)).toContainText("server");
});

test("drawer can cancel running commands and coalesces monitoring separately", async ({ page }) => {
  await page.evaluate(() => { (window as any).__holdInspections = true; });
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page.getByRole("button", { name: "Show command console", exact: true }).click();
  await page.getByRole("button", { name: "Cancel command", exact: true }).click();
  await expect(page.getByRole("region", { name: "Fixture Alpha command console" })).toContainText("Cancelled.");
  await page.evaluate(() => { (window as any).__holdInspections = false; });
  await expect(page.getByRole("button", {name: "Monitoring (1)", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Monitoring (1)", exact: true}).click();
  await expect(page.getByRole("group", {name: "Recent commands"}).getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("region", {name: "Fixture Alpha command console"})).toContainText("exec python3");
  await page.getByRole("button", {name: "Cancel command", exact: true}).click();
  await page.getByRole("button", {name: "Settings", exact: true}).click();
  await expect(page.getByRole("checkbox", {name: "Enable live stats automatically"})).not.toBeChecked();
});

test("compact resource badges show themed tooltips and cached floating details", async ({page}, testInfo) => {
  const bar = page.getByRole("region", {name: "Live server metrics"});
  const header = page.getByRole("tabpanel").getByRole("banner");
  await expect(header.getByRole("region", {name: "Live server metrics"})).toBeVisible();
  await expect(header).not.toContainText("tester@alpha.invalid:22");
  const name = page.getByRole("tab",{name:/Fixture Alpha/}).getByText("Fixture Alpha",{exact:true});
  await name.hover();
  await expect(page.getByRole("tooltip")).toContainText("tester@alpha.invalid:22");
  const network = bar.getByRole("button", {name: "Network live metrics details"});
  const beforeWidths = await bar.getByRole("button").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  await expect(network).toContainText("↓ 1,000 B/s");
  await expect(network).toContainText("↑ 500 B/s");
  const afterWidths = await bar.getByRole("button").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  expect(afterWidths).toEqual(beforeWidths);
  await expect(bar.getByRole("button", {name: "RAM live metrics details"})).toContainText("50.0%");
  const cpu = bar.getByRole("button", {name: "CPU live metrics details"});
  await expect(cpu).toContainText("50.0%");
  await cpu.hover();
  await expect(page.getByRole("tooltip")).toContainText("CPU:");
  await cpu.click();
  const popup = page.getByRole("dialog", {name: "Live resource usage"});
  await expect(popup).toContainText("Capacity cached for 60s");
  await expect(popup.getByRole("img", {name: "CPU history, measured samples only"})).toBeVisible();
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_monitor_start" && c.profileId === "11111111-1111-4111-8111-111111111111").length)).toBe(1);
  await page.screenshot({path: testInfo.outputPath("live-metrics-popover.png")});
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await page.getByRole("button", {name: "Settings", exact: true}).click();
  await page.getByRole("button", {name: "5 seconds", exact: true}).click();
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Overview",exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_monitor_start").at(-1)?.intervalSeconds)).toBe(5);
  await page.setViewportSize({width: 430, height: 900});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await bar.getByRole("button", {name: "RAM live metrics details"}).click();
  await expect(page.getByRole("dialog", {name: "Live resource usage"})).toBeVisible();
  await page.screenshot({path: testInfo.outputPath("live-metrics-mobile.png")});
});

test("failed monitoring backs off and disabling in Settings cancels retries", async ({page}) => {
  await page.getByRole("button", {name: "Settings", exact: true}).click();
  await page.getByRole("checkbox", {name: "Enable live stats automatically"}).uncheck();
  await page.evaluate(() => { (window as any).__monitorFailures = 4; (window as any).__calls.length = 0; });
  await page.getByRole("checkbox", {name: "Enable live stats automatically"}).check();
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Overview",exact:true}).click();
  await expect(page.getByRole("region", {name: "Live server metrics"})).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_monitor_start").length)).toBe(2);
  await page.clock.fastForward(5100);
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_monitor_start").length)).toBe(4);
  await page.getByRole("button", {name: "Settings", exact: true}).click();
  await page.getByRole("checkbox", {name: "Enable live stats automatically"}).uncheck();
  await page.clock.fastForward(20100);
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === "ssh_monitor_start").length)).toBe(4);
});

test("settings persist chosen stats and interval, with no per-sample database writes", async ({page}, testInfo) => {
  await page.getByRole("button", {name: "Settings", exact: true}).click();
  await page.getByRole("checkbox", {name: "CPU", exact: true}).uncheck();
  await page.getByRole("checkbox", {name: "Disk activity", exact: true}).uncheck();
  await page.getByRole("button", {name: "2 seconds", exact: true}).click();
  await expect(page.getByRole("main", {name: "Application settings"})).toContainText("Saved on this device");
  await page.screenshot({path:testInfo.outputPath("settings.png")});
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Overview",exact:true}).click();
  const bar=page.getByRole("region",{name:"Live server metrics"});
  await expect(bar.getByRole("button",{name:"CPU live metrics details"})).toHaveCount(0);
  await expect(bar.getByRole("button",{name:"RAM live metrics details"})).toBeVisible();
  const before=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="app_save_settings").length);
  await page.clock.fastForward(5100);
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="app_save_settings").length)).toBe(before);
  await page.reload();
  await expect(bar.getByRole("button",{name:"CPU live metrics details"})).toHaveCount(0);
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await expect(page.getByRole("checkbox",{name:"CPU",exact:true})).not.toBeChecked();
  await expect(page.getByRole("button",{name:"2 seconds",exact:true})).toHaveAttribute("aria-pressed","true");
  for(const label of ["RAM","Storage capacity","Network download and upload"]) await page.getByRole("checkbox",{name:label,exact:true}).uncheck();
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Overview",exact:true}).click();
  const count=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_monitor_start").length);
  await page.clock.fastForward(10100);
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_monitor_start").length)).toBe(count);
});

test("browser-style zoom shortcuts persist and reset without reaching terminal input", async ({page}) => {
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Terminal",exact:true}).click();
  await page.getByRole("button",{name:"New shell",exact:true}).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  await page.locator(".xterm-helper-textarea").first().focus();
  const inputCount=await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_terminal_input").length);
  await page.keyboard.press("Control+=");
  expect(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_terminal_input").length)).toBe(inputCount);
  await expect.poll(()=>page.evaluate(()=>(window as any).__appliedZoom)).toBe(110);
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>(window as any).__appliedZoom)).toBe(110);
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await expect(page.getByLabel("Zoom level")).toContainText("110%");
  await page.keyboard.press("Control+-");
  await expect(page.getByLabel("Zoom level")).toContainText("100%");
  await page.keyboard.press("Meta+=");
  await expect(page.getByLabel("Zoom level")).toContainText("110%");
  await page.keyboard.press("Control+0");
  await expect(page.getByLabel("Zoom level")).toContainText("100%");
});

test("local database save failure is visible and does not replace saved settings", async ({page}) => {
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  const before=await page.evaluate(()=>localStorage.getItem("__fixture_settings"));
  await page.evaluate(()=>{(window as any).__databaseSaveFailure=true;});
  await page.getByRole("button",{name:"5 seconds",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Settings could not be saved");
  expect(await page.evaluate(()=>localStorage.getItem("__fixture_settings"))).toBe(before);
});

test("fleet organization and ordering persist and are searchable in the connection picker", async ({page},testInfo)=>{
  await page.getByRole("button",{name:"Fleet home",exact:true}).click();
  const fleet=page.getByRole("main",{name:"Server fleet"});
  await fleet.getByRole("button",{name:"Move Fixture Beta earlier",exact:true}).click();
  await expect(fleet.getByRole("article").first()).toHaveAttribute("aria-label","Fixture Beta server");
  await page.clock.fastForward(300);
  await page.reload();
  await expect(page.getByRole("main",{name:"Server fleet"}).getByRole("article").first()).toHaveAttribute("aria-label","Fixture Beta server");
  await page.getByRole("button",{name:"Organize Fixture Alpha",exact:true}).click();
  const editor=page.getByRole("dialog",{name:"Organize Fixture Alpha"});
  await editor.getByLabel("Project",{exact:true}).fill("Portal");
  await editor.getByLabel("Tags",{exact:true}).fill("api, eu-west");
  await editor.getByRole("combobox",{name:"Environment",exact:true}).click();
  await page.getByRole("option",{name:"Production",exact:true}).click();
  await editor.getByRole("checkbox",{name:"Favorite server"}).check();
  await editor.getByRole("button",{name:"Save organization",exact:true}).click();
  await expect(fleet.getByRole("region",{name:"Project Portal"})).toContainText("Fixture Alpha");
  await expect(fleet.getByRole("article",{name:"Fixture Alpha server"})).toContainText("production");
  await page.clock.fastForward(300);
  await page.reload();
  await expect(fleet.getByRole("region",{name:"Project Portal"})).toContainText("eu-west");
  await fleet.getByRole("button",{name:"Favorites only",exact:true}).click();
  await expect(fleet.getByRole("article")).toHaveCount(1);
  await fleet.getByRole("combobox",{name:"Filter environment"}).click();
  await page.getByRole("option",{name:"Staging",exact:true}).click();
  await expect(fleet.getByText("No servers match these filters.",{exact:true})).toBeVisible();
  await fleet.getByRole("combobox",{name:"Filter environment"}).click();
  await page.getByRole("option",{name:"Production",exact:true}).click();
  await expect(fleet.getByRole("article")).toHaveCount(1);
  await page.screenshot({path:testInfo.outputPath("fleet-home.png")});
  await page.getByRole("button",{name:"New VPS tab",exact:true}).click();
  await page.getByRole("textbox",{name:"Search connections",exact:true}).fill("Portal api");
  await expect(page.getByRole("button",{name:"Open Fixture Alpha",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Open Fixture Beta",exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__calls.some((call:any)=>["ssh_connect","ssh_save_profile","ssh_inspection_run"].includes(call.cmd)))).toBe(false);
});

test("fleet home preserves terminals, sampler identity and continuously advancing history",async({page})=>{
  await expect(page.getByRole("button",{name:"CPU live metrics details"})).toContainText("50.0%");
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Terminal",exact:true}).click();
  await page.getByRole("button",{name:"New shell",exact:true}).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  await page.getByRole("button",{name:"CPU live metrics details",exact:true}).click();
  const chart=page.getByRole("dialog",{name:"Live resource usage"}).getByRole("img",{name:"CPU history, measured samples only"});
  const points=()=>chart.locator("polyline").evaluateAll(lines=>lines.reduce((sum,line)=>sum+(line.getAttribute("points")?.trim().split(/\s+/).filter(Boolean).length??0),0));
  const beforePoints=await points();
  await page.keyboard.press("Escape");
  const starts=await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_monitor_start").length);
  await page.getByRole("button",{name:"Fleet home",exact:true}).click();
  const fleet=page.getByRole("main",{name:"Server fleet"});
  await expect(fleet.getByRole("article",{name:"Fixture Alpha server"})).toContainText("Cached · last sampled");
  const timestamp=fleet.getByRole("article",{name:"Fixture Alpha server"}).locator("time");
  const beforeTime=await timestamp.getAttribute("datetime");
  await page.clock.runFor(2100);
  await expect.poll(()=>timestamp.getAttribute("datetime")).not.toBe(beforeTime);
  expect(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_stream_close").length)).toBe(0);
  expect(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_monitor_start").length)).toBe(starts);
  await fleet.getByRole("button",{name:"Favorite Fixture Alpha",exact:true}).click();
  await fleet.getByRole("article",{name:"Fixture Alpha server"}).getByRole("button",{name:"Open workspace",exact:true}).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_terminal_open").length)).toBe(1);
  expect(await page.evaluate(()=>(window as any).__calls.some((call:any)=>["ssh_connect","ssh_disconnect","ssh_inspection_run"].includes(call.cmd)))).toBe(false);
  await page.getByRole("button",{name:"CPU live metrics details",exact:true}).click();
  expect(await points()).toBeGreaterThan(beforePoints);
});

test("command palette opens an unopened server tool by keyboard without remote execution",async({page},testInfo)=>{
  await page.evaluate(first=>{
    const docs=JSON.parse(localStorage.getItem("__fixture_documents")??"{}");
    docs["vps-pilot:sample-workspace:v1"]=JSON.stringify({version:1,page:"server",openServerIds:[`remote:${first}`],activeServerId:`remote:${first}`,servers:{}});
    localStorage.setItem("__fixture_documents",JSON.stringify(docs));
  },first);
  await page.reload();
  await expect(page.getByRole("navigation",{name:"Fixture Alpha tools",exact:true})).toBeVisible();
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Terminal",exact:true}).click();
  await page.getByRole("button",{name:"New shell",exact:true}).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  await page.locator(".xterm-helper-textarea").first().focus();
  const inputs=await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_terminal_input").length);
  await page.keyboard.press("Control+k");
  const palette=page.getByRole("dialog",{name:"Go to…",exact:true});
  await expect(palette.getByRole("combobox",{name:"Search servers and tools"})).toBeFocused();
  expect(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_terminal_input").length)).toBe(inputs);
  await palette.getByRole("combobox").fill("Beta docker");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await page.screenshot({path:testInfo.outputPath("command-palette.png")});
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole("navigation",{name:"Fixture Beta tools"}).getByRole("button",{name:"Docker",exact:true})).toHaveAttribute("aria-current","page");
  expect(await page.evaluate(()=>(window as any).__calls.some((call:any)=>["ssh_connect","ssh_inspection_run"].includes(call.cmd)))).toBe(false);
  await page.keyboard.press("Meta+k");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await palette.getByRole("combobox").fill("fleet home");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main",{name:"Server fleet"})).toBeVisible();
  await page.setViewportSize({width:430,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("Files loads root automatically and preserves a reviewed CRLF draft through navigation without storing contents",async({page},testInfo)=>{
  const nav=page.getByRole("navigation",{name:"Fixture Alpha tools"});
  await nav.getByRole("button",{name:"Files",exact:true}).click();
  const files=page.getByRole("region",{name:"Fixture Alpha files"});
  await expect(files.getByRole("heading",{name:"Files",exact:true})).toBeVisible();
  await expect(files.getByRole("button",{name:"home",exact:true})).toBeVisible();
  await files.getByRole("button",{name:"Edit folder path"}).click();
  await files.getByRole("textbox",{name:"Remote folder path"}).fill("/home/tester");
  await files.getByRole("button",{name:"Go",exact:true}).click();
  await files.getByRole("button",{name:"app.yaml",exact:true}).click();
  const editor=files.getByRole("textbox",{name:"Remote file editor",exact:true});
  await expect(editor).toContainText("port: 3000");
  await expect(files).toContainText("Matches last opened/saved version");
  await editor.fill("port: 4000");
  await expect(files).toContainText("Unsaved changes");
  await page.getByRole("button",{name:"Fleet home",exact:true}).click();
  await page.getByRole("article",{name:"Fixture Alpha server"}).getByRole("button",{name:"Open workspace",exact:true}).click();
  await expect(editor).toContainText("port: 4000");
  expect(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_file_read").length)).toBe(1);
  await files.getByRole("button",{name:"notes.txt",exact:true}).click();
  await page.getByRole("dialog",{name:"Discard unsaved changes?",exact:true}).getByRole("button",{name:"Keep editing",exact:true}).click();
  await expect(editor).toContainText("port: 4000");
  await editor.focus();
  await page.keyboard.press("Control+s");
  const review=page.getByRole("dialog",{name:"Review file changes",exact:true});
  await expect(review).toContainText("Fixture Alpha");
  await expect(review).toContainText("/home/tester/.vps-pilot-backup-fixture");
  expect(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_file_commit").length)).toBe(0);
  await page.screenshot({path:testInfo.outputPath("file-change-preview.png")});
  await review.getByRole("button",{name:"Cancel",exact:true}).click();
  await files.getByRole("button",{name:"Review changes",exact:true}).click();
  await review.getByRole("button",{name:"Back up and save",exact:true}).click();
  await expect(files).toContainText("Matches last opened/saved version");
  await expect(files).toContainText("Saved. Backup:");
  expect(await page.evaluate(first=>(window as any).__fixtureRemoteFiles.get(`${first}:/home/tester/app.yaml`).content,first)).toBe("port: 4000");
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain("port: 4000");
  await page.getByRole("button",{name:"Show command console",exact:true}).click();
  await expect(page.getByRole("region",{name:"Fixture Alpha command console"})).not.toContainText("port: 4000");
});

test("Files reports stale/save failures, retains drafts and never automatically retries a write",async({page})=>{
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Files",exact:true}).click();
  const files=page.getByRole("region",{name:"Fixture Alpha files"});
  await files.getByRole("button",{name:"Edit folder path"}).click();
  await files.getByRole("textbox",{name:"Remote folder path"}).fill("/home/tester");
  await files.getByRole("button",{name:"Go",exact:true}).click();
  await files.getByRole("button",{name:"app.yaml",exact:true}).click();
  const editor=files.getByRole("textbox",{name:"Remote file editor"});
  await editor.fill("keep this unsaved draft");
  await page.evaluate(()=>{(window as any).__remoteFileChanged=true;});
  await files.getByRole("button",{name:"Review changes",exact:true}).click();
  await expect(files.getByRole("alert")).toContainText("changed since it was opened");
  await expect(editor).toContainText("keep this unsaved draft");
  await page.evaluate(()=>{(window as any).__remoteFileChanged=false;(window as any).__fileSaveFailure=true;});
  await files.getByRole("button",{name:"Review changes",exact:true}).click();
  await page.getByRole("dialog",{name:"Review file changes"}).getByRole("button",{name:"Back up and save",exact:true}).click();
  await expect(files.getByRole("alert")).toContainText("destination changed after review");
  await expect(editor).toContainText("keep this unsaved draft");
  await page.clock.fastForward(5100);
  expect(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_file_commit").length)).toBe(1);
  expect(await page.evaluate(first=>(window as any).__fixtureRemoteFiles.get(`${first}:/home/tester/app.yaml`).content,first)).toBe("port: 3000\r\n");
});

test("Files transfers require upload review and buffers stay isolated between open VPS tabs",async({page},testInfo)=>{
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Files",exact:true}).click();
  const alpha=page.getByRole("region",{name:"Fixture Alpha files"});
  await alpha.getByRole("button",{name:"Edit folder path"}).click();
  await alpha.getByRole("textbox",{name:"Remote folder path"}).fill("/home/tester");
  await alpha.getByRole("button",{name:"Go",exact:true}).click();
  await alpha.getByRole("button",{name:"Upload",exact:true}).click();
  const upload=page.getByRole("dialog",{name:"Review file upload",exact:true});
  await expect(upload).toContainText("/home/tester/upload.txt");
  await upload.getByRole("button",{name:"Cancel",exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__calls.filter((call:any)=>call.cmd==="ssh_file_commit").length)).toBe(0);
  await alpha.getByRole("button",{name:"Upload",exact:true}).click();
  await upload.getByRole("button",{name:"Confirm upload",exact:true}).click();
  await expect(alpha).toContainText("Uploaded new file.");
  await alpha.getByRole("button",{name:"app.yaml",exact:true}).click({button:"right"});
  await page.getByRole("menuitem",{name:"Download",exact:true}).click();
  await expect(alpha).toContainText("Downloaded to your chosen location.");
  await alpha.getByRole("button",{name:"app.yaml",exact:true}).click();
  await alpha.getByRole("textbox",{name:"Remote file editor"}).fill("alpha-only draft");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox",{name:"Search servers and tools"}).fill("Beta files");
  await page.keyboard.press("Enter");
  const beta=page.getByRole("region",{name:"Fixture Beta files"});
  await beta.getByRole("button",{name:"Edit folder path"}).click();
  await beta.getByRole("textbox",{name:"Remote folder path"}).fill("/home/tester");
  await beta.getByRole("button",{name:"Go",exact:true}).click();
  await beta.getByRole("button",{name:"app.yaml",exact:true}).click();
  await expect(beta.getByRole("textbox",{name:"Remote file editor"})).toContainText("port: 3000");
  await page.getByRole("tab",{name:/Fixture Alpha/}).click();
  await expect(alpha.getByRole("textbox",{name:"Remote file editor"})).toContainText("alpha-only draft");
  await page.screenshot({path:testInfo.outputPath("remote-files.png")});
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain("alpha-only draft");
});

async function openFileManager(page:import("@playwright/test").Page){
  await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Files",exact:true}).click();
  const files=page.getByRole("region",{name:"Fixture Alpha files"});
  await expect(files.getByRole("button",{name:"home",exact:true})).toBeVisible();
  await files.getByRole("button",{name:"Edit folder path"}).click();
  await files.getByRole("textbox",{name:"Remote folder path"}).fill("/home/tester");
  await files.getByRole("button",{name:"Go",exact:true}).click();
  await expect(files.getByRole("button",{name:"app.yaml",exact:true})).toBeVisible();
  return files;
}
test("File manager loads hidden items, preserves listings and requests folder sizes only explicitly",async({page})=>{
  const files=await openFileManager(page);
  await expect(files.getByRole("button",{name:".env",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_files_size").length)).toBe(0);
  await expect(files.getByRole("button",{name:"Calculate",exact:true})).toHaveCount(0);
  await files.getByRole("button",{name:"assets",exact:true}).click({button:"right"});
  await page.getByRole("menuitem",{name:"View details",exact:true}).click();
  await files.getByRole("complementary",{name:"File details"}).getByRole("button",{name:"Calculate size",exact:true}).click();
  await expect(files).toContainText("1 KiB");
  const count=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_files_list").length);
  await page.getByRole("button",{name:"Fleet home",exact:true}).click();
  await page.getByRole("article",{name:"Fixture Alpha server"}).getByRole("button",{name:"Open workspace",exact:true}).click();
  await expect(files.getByRole("button",{name:".env",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_files_list").length)).toBe(count);
  await files.getByRole("button",{name:"View options",exact:true}).click();
  await page.getByRole("menuitem",{name:"Hide hidden files",exact:true}).click();
  await expect(files.getByRole("button",{name:".env",exact:true})).toHaveCount(0);
});
test("File manager clipboard and folder creation require review, and delete offers restore",async({page})=>{
  const files=await openFileManager(page);
  await files.getByRole("checkbox",{name:"Select app.yaml",exact:true}).check();
  await files.getByRole("button",{name:"notes.txt",exact:true}).click({modifiers:["Control"]});
  await expect(files).toContainText("2 selected");
  await files.getByRole("button",{name:"Copy",exact:true}).click();
  await files.getByRole("button",{name:"File actions",exact:true}).click();
  await page.getByRole("menuitem",{name:"Paste",exact:true}).click();
  const review=page.getByRole("dialog",{name:"Confirm copy",exact:true});
  await expect(review).toContainText("app.yaml");
  await review.getByRole("button",{name:"Cancel",exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_files_execute_operation").length)).toBe(0);
  await files.getByRole("button",{name:"File actions",exact:true}).click();
  await page.getByRole("menuitem",{name:"Paste",exact:true}).click();
  await review.getByRole("button",{name:"Confirm copy",exact:true}).click();
  await expect(files.getByRole("button",{name:"app.yaml copy",exact:true})).toBeVisible();
  await files.getByRole("button",{name:"New folder",exact:true}).click();
  await page.getByRole("dialog",{name:"New folder",exact:true}).getByRole("textbox",{name:"Item name"}).fill("release-files");
  await page.getByRole("button",{name:"Review operation",exact:true}).click();
  await page.getByRole("dialog",{name:"Confirm create folder",exact:true}).getByRole("button",{name:"Confirm create folder",exact:true}).click();
  await expect(files.getByRole("button",{name:"release-files",exact:true})).toBeVisible();
  await files.getByRole("checkbox",{name:"Select notes.txt",exact:true}).check();
  await files.getByRole("button",{name:"Move to trash",exact:true}).click();
  const trash=page.getByRole("dialog",{name:"Confirm delete to trash",exact:true});
  await expect(trash).toContainText("private server trash");
  await trash.getByRole("button",{name:"Confirm delete to trash",exact:true}).click();
  await expect(files.getByRole("button",{name:"notes.txt",exact:true})).toHaveCount(0);
  await expect(files.getByRole("button",{name:"Restore deleted items",exact:true})).toBeEnabled();
});
test("File manager rectangle and range selection work and protected roots cannot be deleted",async({page},testInfo)=>{
  const files=await openFileManager(page);
  await files.getByRole("button",{name:"Grid view",exact:true}).click();
  const grid=files.getByRole("grid",{name:"Remote files"});
  await grid.scrollIntoViewIfNeeded();
  const bounds=(await grid.boundingBox())!;
  const rows=grid.locator("[data-file-path]");
  const firstBox=(await rows.nth(0).boundingBox())!;
  const secondBox=(await rows.nth(1).boundingBox())!;
  await page.mouse.move(bounds.x+3,bounds.y+bounds.height-8);
  await page.mouse.down();
  await page.mouse.move(secondBox.x+secondBox.width-3,firstBox.y+3,{steps:10});
  await expect(files.getByTestId("file-selection-rectangle")).toBeVisible();
  await page.mouse.up();
  await expect(grid.locator('[aria-selected="true"]')).toHaveCount(2);
  await rows.nth(0).click({modifiers:["Control"]});
  await rows.nth(2).click({modifiers:["Shift"]});
  await expect(grid.locator('[aria-selected="true"]')).toHaveCount(3);
  await page.screenshot({path:testInfo.outputPath("file-manager-grid.png")});
  await files.getByRole("button",{name:"Root /",exact:true}).click();
  await files.getByRole("button",{name:"etc",exact:true}).click({button:"right"});
  await expect(page.getByRole("menuitem",{name:"Move to trash",exact:true})).toBeDisabled();
  await expect(page.getByRole("menuitem",{name:"Cut",exact:true})).toBeDisabled();
});
test("File manager cancellation stops a running batch without disconnecting a VPS",async({page})=>{
  const files=await openFileManager(page);
  await files.getByRole("checkbox",{name:"Select app.yaml",exact:true}).check();
  await files.getByRole("checkbox",{name:"Select notes.txt",exact:true}).check();
  await files.getByRole("button",{name:"File actions",exact:true}).click();
  await page.getByRole("menuitem",{name:"Download ZIP",exact:true}).click();
  const review=page.getByRole("dialog",{name:"Confirm download zip",exact:true});
  await expect(review).toContainText("/fixture/download.zip");
  await page.evaluate(()=>{(window as any).__holdFileOperation=true;});
  await review.getByRole("button",{name:"Confirm download zip",exact:true}).click();
  await files.getByRole("button",{name:"Cancel operation",exact:true}).click();
  await expect(files).toContainText("Operation cancelled");
  await expect(files.getByRole("button",{name:"app.yaml",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_disconnect").length)).toBe(0);
});

test("File manager context menus preserve selected items and distinguish background actions",async({page},testInfo)=>{
  const files=await openFileManager(page);
  await files.getByRole("checkbox",{name:"Select app.yaml",exact:true}).check();
  await files.getByRole("checkbox",{name:"Select notes.txt",exact:true}).check();
  await files.getByRole("button",{name:"notes.txt",exact:true}).click({button:"right"});
  await expect(page.getByRole("menuitem",{name:"Download ZIP",exact:true})).toBeVisible();
  await expect(page.getByRole("menuitem",{name:"View details",exact:true})).toBeDisabled();
  await expect(page.locator('[aria-label="Remote files"] [aria-selected="true"]')).toHaveCount(2);
  await page.keyboard.press("Escape");
  await files.getByRole("button",{name:".env",exact:true}).click({button:"right"});
  await expect(page.locator('[aria-label="Remote files"] [aria-selected="true"]')).toHaveCount(1);
  await page.getByRole("menuitem",{name:"View details",exact:true}).click();
  await expect(files.getByRole("complementary",{name:"File details"})).toContainText("/home/tester/.env");
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_file_read").length)).toBe(0);
  await files.getByRole("grid").click({button:"right",position:{x:5,y:5}});
  await expect(page.getByRole("menuitem",{name:"New folder",exact:true})).toBeVisible();
  await expect(page.getByRole("menuitem",{name:"View details",exact:true})).toHaveCount(0);
  await expect(page.locator('[aria-label="Remote files"] [aria-selected="true"]')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath("file-manager-context.png")});
});
test("File manager single-click opening and overflow details preserve drafts on narrow screens",async({page},testInfo)=>{
  const files=await openFileManager(page);
  await files.getByRole("button",{name:"app.yaml",exact:true}).click();
  const editor=files.getByRole("textbox",{name:"Remote file editor",exact:true});
  await editor.fill("preserve this draft");
  await files.getByRole("checkbox",{name:"Select notes.txt",exact:true}).check();
  await files.getByRole("button",{name:"File actions",exact:true}).click();
  await page.getByRole("menuitem",{name:"View details",exact:true}).click();
  await expect(editor).not.toBeVisible();
  await expect(files.getByRole("complementary",{name:"File details"})).toContainText("/home/tester/notes.txt");
  await page.setViewportSize({width:720,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("file-manager-details.png")});
  await files.getByRole("button",{name:"Close file details",exact:true}).click();
  await expect(editor).toContainText("preserve this draft");
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_file_read").length)).toBe(1);
  await files.getByRole("button",{name:"assets",exact:true}).click();
  await expect(files.getByRole("grid")).toContainText("This folder is empty");
  await expect(editor).toContainText("preserve this draft");
});

test("Docker workspace loads automatically once, groups Compose and masks details",async({page})=>{
 const nav=page.getByRole("navigation",{name:"Fixture Alpha tools"});
 await nav.getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_query" && c.query==="list").length)).toBe(1);
 await expect(docker.getByRole("status",{name:"Container results"})).toContainText("Showing 3 of 3 containers");
 const filter=docker.getByRole("combobox",{name:"Container project filter"});
 await expect(filter).toContainText("All projects");
 await filter.click();
 await page.getByRole("option",{name:/website.*2 containers/}).click();
 await expect(filter).toContainText("website");
 await expect(docker.getByRole("button",{name:"worker",exact:true})).toBeVisible();
 await expect(docker.getByRole("button",{name:"standalone",exact:true})).toHaveCount(0);
 await filter.click();
 await page.getByRole("option",{name:"All projects",exact:true}).click();
 await expect(docker.getByRole("button",{name:"standalone",exact:true})).toBeVisible();
 await docker.getByRole("button",{name:"web",exact:true}).click();
 const detail=docker.getByRole("region",{name:"Container details",exact:true});
 await detail.getByText("Environment · values always masked",{exact:true}).click();
 await expect(detail).toContainText("DATABASE_PASSWORD=••••••");
 await detail.getByRole("button",{name:"Refresh resource snapshot",exact:true}).click();
 await expect(detail).toContainText("1.25%");
 await expect(detail.getByRole("button",{name:"Review start",exact:true})).toBeDisabled();
 await expect(detail.getByRole("button",{name:"Review stop",exact:true})).toBeEnabled();
 const queries=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_query").length);
 await page.getByRole("button",{name:"Fleet home",exact:true}).click();
 await page.getByRole("article",{name:"Fixture Alpha server"}).getByRole("button",{name:"Open workspace",exact:true}).click();
 await expect(detail).toContainText("DATABASE_PASSWORD");
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_query").length)).toBe(queries);
 expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain("DATABASE_PASSWORD");
});
test("Docker logs require review and container terminals stay alive across navigation",async({page},testInfo)=>{
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await expect(docker.getByRole("status",{name:"Container results"})).toContainText("Showing 3 of 3 containers");
 await docker.getByRole("button",{name:"web",exact:true}).click();
 await docker.getByRole("button",{name:"Review live logs",exact:true}).click();
 await page.getByRole("dialog",{name:"Follow container logs?",exact:true}).getByRole("button",{name:"Cancel",exact:true}).click();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_action_execute").length)).toBe(0);
 await docker.getByRole("button",{name:"Review live logs",exact:true}).click();
 await page.getByRole("dialog",{name:"Follow container logs?",exact:true}).getByRole("button",{name:"Follow logs",exact:true}).click();
 await expect(docker.getByRole("region",{name:"Container live logs",exact:true})).toContainText("fixture application ready");
 await docker.getByRole("button",{name:"Stop logs",exact:true}).click();
 await docker.getByRole("navigation",{name:"Container detail views"}).getByRole("button",{name:"Terminal",exact:true}).click();
 await docker.getByRole("button",{name:"Open container terminal",exact:true}).click();
 await expect(docker.getByRole("textbox",{name:"Fixture Alpha interactive terminal",exact:true})).toBeVisible();
 const count=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_terminal_open").length);
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_terminal_open").at(-1).container)).toBe("a".repeat(64));
 const closed=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_stream_close").length);
 await docker.getByRole("button",{name:"Close details",exact:true}).click();
 await expect(docker.getByRole("complementary",{name:"Container inspector"})).toBeHidden();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_stream_close").length)).toBe(closed);
 await docker.getByRole("button",{name:"Open container details",exact:true}).click();
 await expect(docker.getByRole("textbox",{name:"Fixture Alpha interactive terminal",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Fleet home",exact:true}).click();
 await page.getByRole("article",{name:"Fixture Alpha server"}).getByRole("button",{name:"Open workspace",exact:true}).click();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_terminal_open").length)).toBe(count);
 await page.screenshot({path:testInfo.outputPath("docker-workspace.png")});
});

test("Docker cleanup defaults to eligible items, protects data and reviews a selected batch",async({page},testInfo)=>{
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await docker.getByRole("navigation",{name:"Docker sections"}).getByRole("button",{name:"Cleanup",exact:true}).click();
 const cleanup=docker.getByRole("region",{name:"Docker cleanup",exact:true});
 await expect(cleanup.getByRole("checkbox",{name:"Select dangling-fixture",exact:true})).toBeVisible();
 await expect(cleanup.getByRole("checkbox",{name:"Select rollback-image",exact:true})).toHaveCount(0);
 await cleanup.getByRole("checkbox",{name:"Show protected items",exact:true}).check();
 await expect(cleanup.getByRole("checkbox",{name:"Select rollback-image",exact:true})).toBeDisabled();
 await page.screenshot({path:testInfo.outputPath("docker-cleanup-initial.png")});


 await cleanup.getByRole("button",{name:"Select eligible",exact:true}).click();
 await cleanup.getByRole("button",{name:"Review cleanup",exact:true}).click();
 const review=page.getByRole("dialog",{name:"Review Docker operation",exact:true});
 await expect(review).toContainText("dangling-fixture");
 await expect(review.getByRole("button",{name:"Remove selected",exact:true})).toBeDisabled();
 await review.getByRole("button",{name:"Cancel",exact:true}).click();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_execute").length)).toBe(0);
 await cleanup.getByRole("button",{name:"Review cleanup",exact:true}).click();
 await review.getByRole("textbox",{name:"Confirm cleanup resource name"}).fill("DELETE 1");
 await review.getByRole("button",{name:"Remove selected",exact:true}).click();
 await expect(cleanup.getByRole("region",{name:"Cleanup result",exact:true})).toContainText("Removed selected resources");
 await expect(cleanup.getByRole("checkbox",{name:"Select dangling-fixture",exact:true})).toHaveCount(0);
 await cleanup.getByText("Protected volumes (1)",{exact:true}).click();
 await expect(cleanup).toContainText("database-data");
 await page.screenshot({path:testInfo.outputPath("docker-cleanup.png")});
});

test("Docker lifecycle reviews refresh state and stale evidence is never retried",async({page})=>{
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await expect(docker.getByRole("status",{name:"Container results"})).toContainText("Showing 3 of 3 containers");
 await docker.getByRole("button",{name:"web",exact:true}).click();
 await docker.getByRole("button",{name:"Review stop",exact:true}).click();
 const review=page.getByRole("dialog",{name:"Review Docker operation",exact:true});
 await review.getByRole("button",{name:"Confirm operation",exact:true}).click();
 await expect(docker.getByRole("button",{name:"Review stop",exact:true})).toBeDisabled();
 await expect(docker.getByRole("button",{name:"Review start",exact:true})).toBeEnabled();
 await docker.getByRole("button",{name:"Review start",exact:true}).click();
 await page.evaluate(()=>{(window as any).__dockerStale=true;});
 await review.getByRole("button",{name:"Confirm operation",exact:true}).click();
 await expect(docker.getByRole("alert")).toContainText("state changed");
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_execute").length)).toBe(2);
});

test("Compose deployment keeps secrets out of preview/history and blocks unsafe configuration",async({page})=>{
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await docker.getByRole("navigation",{name:"Docker sections"}).getByRole("button",{name:"Run application",exact:true}).click();
 await docker.getByRole("button",{name:"Add environment variable",exact:true}).click();
 await docker.getByRole("textbox",{name:"Environment name 1",exact:true}).fill("PASSWORD");
 await docker.getByLabel("Environment value 1",{exact:true}).fill("docker-compose-secret-fixture");
 await docker.getByRole("button",{name:"Review application",exact:true}).click();
 const review=page.getByRole("dialog",{name:"Review Docker operation",exact:true});
 await expect(review).toContainText("PASSWORD");
 await expect(review).not.toContainText("docker-compose-secret-fixture");
 await review.getByRole("button",{name:"Run application",exact:true}).click();
 await docker.getByRole("navigation",{name:"Docker sections"}).getByRole("button",{name:"Activity",exact:true}).click();
 await expect(docker.getByRole("region",{name:"Docker operation history"})).toContainText("completed");
 expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain("docker-compose-secret-fixture");
 await docker.getByRole("navigation",{name:"Docker sections"}).getByRole("button",{name:"Run application",exact:true}).click();
 await docker.getByRole("button",{name:"Use Compose file",exact:true}).click();
 await docker.getByRole("textbox",{name:"Compose YAML editor",exact:true}).fill("services:\n  app:\n    image: alpine:3.24\n    privileged: true\n");
 await docker.getByRole("button",{name:"Review application",exact:true}).click();
 await expect(review).toContainText("Host privileges are protected");
 await expect(review.getByRole("button",{name:"Run application",exact:true})).toBeDisabled();
});

test("Docker log search and pause do not start new server requests",async({page})=>{
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await expect(docker.getByRole("status",{name:"Container results"})).toContainText("Showing 3 of 3 containers");
 await docker.getByRole("button",{name:"web",exact:true}).click();
 await docker.getByRole("button",{name:"Review live logs",exact:true}).click();
 await page.getByRole("dialog",{name:"Follow container logs?",exact:true}).getByRole("button",{name:"Follow logs",exact:true}).click();
 const logs=docker.getByRole("region",{name:"Container live logs",exact:true});
 await expect(logs).toContainText("fixture application ready");
 const requests=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>["ssh_docker_query","ssh_action_review","ssh_action_execute"].includes(c.cmd)).length);
 await logs.getByRole("textbox",{name:"Search container logs"}).fill("no matching text");
 await expect(logs).not.toContainText("fixture application ready");
 await logs.getByRole("button",{name:"Pause display",exact:true}).click();
 await logs.getByRole("textbox",{name:"Search container logs"}).fill("ready");
 await expect(logs).toContainText("fixture application ready");
 await logs.getByRole("button",{name:"Resume display",exact:true}).click();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>["ssh_docker_query","ssh_action_review","ssh_action_execute"].includes(c.cmd)).length)).toBe(requests);
});

test("Compose import requires confirmation and keeps file contents out of activity/persistence",async({page})=>{
 await page.evaluate(first=>{(window as any).__fixtureRemoteFiles.set(first+":/srv/my-app/compose.yaml",{content:"services:\n  app:\n    image: alpine:3.24\n    environment:\n      PASSWORD: explicit-compose-file-secret\n",revision:"1"});},first);
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await docker.getByRole("navigation",{name:"Docker sections"}).getByRole("button",{name:"Run application",exact:true}).click();
 await docker.getByRole("button",{name:"Use Compose file",exact:true}).click();
 await docker.getByRole("button",{name:"Load existing Compose file",exact:true}).click();
 const confirm=page.getByRole("dialog",{name:"Load Compose configuration?",exact:true});
 await expect(confirm).toContainText("may contain credentials");
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_file_read").length)).toBe(0);
 await confirm.getByRole("button",{name:"Load into editor",exact:true}).click();
 await expect(docker.getByRole("textbox",{name:"Compose YAML editor",exact:true})).toContainText("explicit-compose-file-secret");
 expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain("explicit-compose-file-secret");
 await page.getByRole("button",{name:"Show command console",exact:true}).click();
 await expect(page.getByRole("region",{name:"Fixture Alpha command console",exact:true})).not.toContainText("explicit-compose-file-secret");
});


test("Docker layout keeps filters aligned, forms spaced and repeated server details out of the header",async({page},testInfo)=>{
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await expect(docker.getByRole("status",{name:"Container results"})).toContainText("Showing 3 of 3 containers");
 const filter=await docker.getByRole("combobox",{name:"Container project filter"}).boundingBox();
 const search=await docker.getByRole("textbox",{name:"Search containers"}).boundingBox();
 const table=await docker.locator("table").first().boundingBox();
 expect(filter&&search&&table).toBeTruthy();
 expect(Math.abs(filter!.y-search!.y)).toBeLessThan(2);
 expect(search!.x-filter!.x-filter!.width).toBeGreaterThanOrEqual(12);
 expect(table!.y-search!.y-search!.height).toBeGreaterThanOrEqual(20);
 const header=page.getByRole("tabpanel").getByRole("banner");
 await expect(header).not.toContainText("Fixture Alpha");
 await expect(header).not.toContainText("Connected");
 const sidebar=page.getByRole("navigation",{name:"Fixture Alpha tools"});
 expect(await sidebar.evaluate(el=>getComputedStyle(el).scrollbarWidth)).toBe("none");
 await page.screenshot({path:testInfo.outputPath("docker-containers.png")});
 await docker.getByRole("button",{name:"Run application",exact:true}).click();
 await expect(docker.getByRole("group",{name:"Ports",exact:true})).toBeVisible();
 await docker.getByRole("checkbox",{name:"Update an existing application with this name and folder"}).check();
 await docker.getByRole("button",{name:"Review application",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__lastDockerUpdate)).toBe(true);
 await page.getByRole("dialog",{name:"Review Docker operation",exact:true}).getByRole("button",{name:"Cancel",exact:true}).click();
 await page.screenshot({path:testInfo.outputPath("docker-application.png")});
 await page.setViewportSize({width:480,height:900});
 const mobileFilter=await docker.getByRole("textbox",{name:"Deployment image"}).boundingBox();
 expect(mobileFilter!.x+mobileFilter!.width).toBeLessThanOrEqual(480);
});

test("Docker counts, filters and inspector stay separate without refreshing cached inventory",async({page},testInfo)=>{
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await expect(docker.getByRole("status",{name:"Container results"})).toContainText("Showing 3 of 3 containers");
 await expect(docker.locator("table:visible")).toHaveCount(1);
 const results=docker.getByRole("status",{name:"Container results"});
 await expect(results).toContainText("Showing 3 of 3 containers");
 await expect(results).toContainText("1 Compose project");
 const filter=docker.getByRole("combobox",{name:"Container project filter"});
 const before=await filter.boundingBox();
 await filter.click();
 const popup=page.getByRole("listbox");
 await expect(popup).toBeVisible();
 await expect.poll(async()=>(await popup.boundingBox())!.width).toBeGreaterThanOrEqual(before!.width-1);
 await page.getByRole("option",{name:"Standalone containers",exact:true}).click();
 await expect(results).toContainText("Showing 1 of 3 containers");
 await docker.getByRole("combobox",{name:"Container state filter"}).click();
 await page.getByRole("option",{name:"Stopped",exact:true}).click();
 await expect(results).toContainText("Showing 0 of 3 containers");
 await docker.getByRole("button",{name:"Clear filters",exact:true}).click();
 await expect(results).toContainText("Showing 3 of 3 containers");
 const queries=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_query").length);
 await docker.getByRole("button",{name:"web",exact:true}).click();
 const inspector=docker.getByRole("complementary",{name:"Container inspector"});
 await expect(inspector).toBeVisible();
 const table=await docker.locator("table").first().boundingBox(),panel=await inspector.boundingBox();
 expect(panel!.x).toBeGreaterThan(table!.x+table!.width);
 await page.screenshot({path:testInfo.outputPath("docker-inspector.png")});
 await inspector.getByRole("navigation",{name:"Container detail views"}).getByRole("button",{name:"Logs",exact:true}).click();
 await expect(inspector.getByRole("button",{name:"Review live logs",exact:true})).toBeVisible();
 await inspector.getByRole("button",{name:"Close details",exact:true}).click();
 await expect(inspector).toBeHidden();
 await docker.getByRole("textbox",{name:"Search containers"}).fill("worker");
 await docker.getByRole("navigation",{name:"Docker sections"}).getByRole("button",{name:"Images",exact:true}).click();
 await docker.getByRole("navigation",{name:"Docker sections"}).getByRole("button",{name:"Containers",exact:true}).click();
 await expect(docker.getByRole("textbox",{name:"Search containers"})).toHaveValue("worker");
 // The standalone container also uses worker:1; search includes image names.
 await expect(results).toContainText("Showing 2 of 3 containers");
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_query").length)).toBe(queries+1);
 await page.setViewportSize({width:430,height:900});
 await docker.getByRole("button",{name:"worker",exact:true}).click();
 await expect(inspector).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath("docker-inspector-mobile.png")});
});

test("Docker resource tabs load once, share cached inventory and refresh explicitly",async({page})=>{
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await expect(docker.getByRole("status",{name:"Container results"})).toBeVisible();
 const tabs=docker.getByRole("navigation",{name:"Docker sections"});
 await tabs.getByRole("button",{name:"Images",exact:true}).click();
 await expect(docker.getByRole("button",{name:"Actions for dangling-fixture",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_snapshot").length)).toBe(1);
 for(const tab of ["Volumes","Networks","Cleanup","Images"])await tabs.getByRole("button",{name:tab,exact:true}).click();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_snapshot").length)).toBe(1);
 await docker.getByRole("region",{name:"Docker images",exact:true}).getByRole("button",{name:"Refresh",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_snapshot").length)).toBe(2);
 await tabs.getByRole("button",{name:"Containers",exact:true}).click();
 await docker.getByRole("button",{name:"Refresh containers",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_query"&&c.query==="list").length)).toBe(2);
});

test("failed automatic Docker loads wait for Refresh instead of retrying",async({page})=>{
 await page.evaluate(()=>{(window as any).__failDockerList=true;(window as any).__failDockerResources=true;});
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await expect(docker.getByRole("alert")).toContainText("Container inventory unavailable");
 await page.getByRole("button",{name:"Fleet home",exact:true}).click();
 await page.getByRole("article",{name:"Fixture Alpha server"}).getByRole("button",{name:"Open workspace",exact:true}).click();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_query").length)).toBe(1);
 await page.evaluate(()=>(window as any).__failDockerList=false);
 await docker.getByRole("button",{name:"Refresh containers",exact:true}).click();
 await expect(docker.getByRole("status",{name:"Container results"})).toBeVisible();
 const tabs=docker.getByRole("navigation",{name:"Docker sections"});
 await tabs.getByRole("button",{name:"Images",exact:true}).click();
 await expect(docker.getByRole("alert")).toContainText("Resource inventory unavailable");
 await tabs.getByRole("button",{name:"Networks",exact:true}).click();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_snapshot").length)).toBe(1);
 await page.evaluate(()=>(window as any).__failDockerResources=false);
 await docker.getByRole("region",{name:"Docker networks",exact:true}).getByRole("button",{name:"Refresh",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_snapshot").length)).toBe(2);
});

test("system prune is advanced, typed and blocked by protected resource evidence",async({page})=>{
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await docker.getByRole("navigation",{name:"Docker sections"}).getByRole("button",{name:"Cleanup",exact:true}).click();
 const cleanup=docker.getByRole("region",{name:"Docker cleanup",exact:true});
 await cleanup.getByText("Advanced cleanup · Docker system prune",{exact:true}).click();
 const all=cleanup.getByRole("checkbox",{name:"Also remove unused tagged images (--all)",exact:true});
 await expect(all).not.toBeChecked();
 await cleanup.getByRole("button",{name:"Review system prune",exact:true}).click();
 const review=page.getByRole("dialog",{name:"Review Docker operation",exact:true});
 await expect(review).toContainText("No Docker dry run");
 await expect(review).not.toContainText("--volumes");
 await expect(review.getByRole("button",{name:"Run system prune",exact:true})).toBeDisabled();
 await review.getByRole("textbox",{name:"Confirm cleanup resource name"}).fill("PRUNE");
 await review.getByRole("button",{name:"Run system prune",exact:true}).click();
 await expect(cleanup.getByRole("region",{name:"Cleanup result",exact:true})).toContainText("Docker reported reclaimed space");
 await page.evaluate(()=>(window as any).__blockedPrune=true);
 await all.check();
 await cleanup.getByRole("button",{name:"Review system prune",exact:true}).click();
 await expect(review).toContainText("--all");
 await expect(review).toContainText("Protected workload");
 await review.getByRole("textbox",{name:"Confirm cleanup resource name"}).fill("PRUNE");
 await expect(review.getByRole("button",{name:"Run system prune",exact:true})).toBeDisabled();
});

test("canceling cleanup preserves completed results and skips remaining selections",async({page})=>{
 await page.evaluate(()=>{(window as any).__twoCleanup=true;(window as any).__holdCleanup=true;});
 await page.getByRole("navigation",{name:"Fixture Alpha tools"}).getByRole("button",{name:"Docker",exact:true}).click();
 const docker=page.getByRole("region",{name:"Fixture Alpha Docker",exact:true});
 await docker.getByRole("navigation",{name:"Docker sections"}).getByRole("button",{name:"Cleanup",exact:true}).click();
 const cleanup=docker.getByRole("region",{name:"Docker cleanup",exact:true});
 await cleanup.getByRole("checkbox",{name:"Select dangling-fixture",exact:true}).check();
 await cleanup.getByRole("navigation",{name:"Cleanup categories"}).getByRole("button",{name:/Networks/}).click();
 await cleanup.getByRole("checkbox",{name:"Select old-network",exact:true}).check();
 await cleanup.getByRole("button",{name:"Review cleanup",exact:true}).click();
 const review=page.getByRole("dialog",{name:"Review Docker operation",exact:true});
 await review.getByRole("textbox",{name:"Confirm cleanup resource name"}).fill("DELETE 2");
 await review.getByRole("button",{name:"Remove selected",exact:true}).click();
 await docker.getByRole("button",{name:"Cancel remaining items",exact:true}).click();
 const result=cleanup.getByRole("region",{name:"Cleanup result",exact:true});
 await expect(result).toContainText("removed");
 await expect(result).toContainText("skipped");
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_docker_cancel").length)).toBe(1);
});

test("configuration pages preserve shells and never inspect or mutate on navigation", async ({page}, testInfo) => {
  const nav=page.getByRole("navigation",{name:"Fixture Alpha tools"});
  await nav.getByRole("button",{name:"Terminal",exact:true}).click();
  await page.getByRole("button",{name:"New shell",exact:true}).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  const before=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>/ssh_(terminal_open|stream_close|inspection_run|action_execute|connect)/.test(c.cmd)));
  await nav.getByRole("button",{name:"Quick Setup",exact:true}).click();
  const setup=page.getByRole("region",{name:"Quick Setup",exact:true});
  await expect(setup.getByText("Not inspected",{exact:true})).toHaveCount(6);
  await expect(setup.getByRole("button",{name:"Inspect server",exact:true})).toBeEnabled();
  await page.screenshot({path:testInfo.outputPath("quick-setup.png")});
  await setup.getByRole("button",{name:"Open SSH Access",exact:true}).click();
  const access=page.getByRole("region",{name:"SSH Access",exact:true});
  await expect(access.getByText("SSH server policy",{exact:true})).toBeVisible();
  await expect(access.getByRole("region",{name:"SSH server policy",exact:true}).getByText("Not inspected",{exact:true})).toBeVisible();
  await expect(access.getByText("tester",{exact:true})).toBeVisible();
  await page.setViewportSize({width:700,height:800});
  await page.screenshot({path:testInfo.outputPath("ssh-access-narrow.png")});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await nav.getByRole("button",{name:"Terminal",exact:true}).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>/ssh_(terminal_open|stream_close|inspection_run|action_execute|connect)/.test(c.cmd)))).toEqual(before);
});

test("shared theme text and input boundaries meet contrast targets",async({page})=>{
  const ratios=await page.evaluate(()=>{
    const color=(name:string)=>{
      const node=document.createElement("span");
      node.style.color=`var(--${name})`;
      document.body.append(node);
      const channels=getComputedStyle(node).color.match(/[\d.]+/g)!.slice(0,3).map(Number);
      node.remove();
      const linear=channels.map(v=>{const c=v/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;});
      return linear[0]*0.2126+linear[1]*0.7152+linear[2]*0.0722;
    };
    const ratio=(a:string,b:string)=>{const x=color(a),y=color(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
    return {
      text:["foreground","muted-foreground","success","warning","destructive","info"].flatMap(text=>["background","card","secondary","sidebar","accent"].map(bg=>({pair:`${text}/${bg}`,value:ratio(text,bg)}))),
      primary:ratio("primary","primary-foreground"),
      boundary:ratio("input","background"),
      focus:ratio("ring","background"),
    };
  });
  for(const pair of ratios.text) expect(pair.value,pair.pair).toBeGreaterThanOrEqual(4.5);
  expect(ratios.primary).toBeGreaterThanOrEqual(4.5);
  expect(ratios.boundary).toBeGreaterThanOrEqual(3);
  expect(ratios.focus).toBeGreaterThanOrEqual(3);
});

test("Appearance previews apply themes in place and restore each choice after restart",async({page},testInfo)=>{
  const nav=page.getByRole("navigation",{name:"Fixture Alpha tools"});
  await nav.getByRole("button",{name:"Terminal",exact:true}).click();
  await page.getByRole("button",{name:"New shell",exact:true}).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  const sessions=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>["ssh_terminal_open","ssh_stream_close"].includes(c.cmd)));
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  const appearance=page.getByRole("region",{name:"Appearance",exact:true});
  await expect(appearance.getByRole("radio")).toHaveCount(4);
  await appearance.getByRole("radio",{name:"Tokyo Night",exact:true}).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme","tokyo-night");
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("__fixture_settings")??"{}").theme)).toBe("tokyo-night");
  await appearance.scrollIntoViewIfNeeded();
  await appearance.screenshot({path:testInfo.outputPath("appearance-themes.png")});
  await nav.getByRole("button",{name:"Terminal",exact:true}).click();
  await expect(page.getByText(/Connected · normal shell/)).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>["ssh_terminal_open","ssh_stream_close"].includes(c.cmd)))).toEqual(sessions);
  // xterm's viewport is recolored through options without replacing its SSH session.
  await expect(page.locator(".xterm-scrollable-element").first()).toHaveCSS("background-color","rgb(22, 22, 30)");
  for(const [name,id] of [["Tokyo Night","tokyo-night"],["One Dark Pro","one-dark-pro"],["GitHub Dark","github-dark"],["Forest Mint","forest-mint"]]){
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await appearance.getByRole("radio",{name,exact:true}).check();
    await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("__fixture_settings")??"{}").theme)).toBe(id);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme",id);
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await expect(appearance.getByRole("radio",{name,exact:true})).toBeChecked();
    await nav.getByRole("button",{name:"Overview",exact:true}).click();
  }
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await appearance.getByRole("radio",{name:"Forest Mint",exact:true}).focus();
  await page.keyboard.press("ArrowRight");
  await expect(appearance.getByRole("radio",{name:"Tokyo Night",exact:true})).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme","tokyo-night");
});

test("failed theme saves are visible and retain the last saved selection after restart",async({page})=>{
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("radio",{name:"GitHub Dark",exact:true}).check();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("__fixture_settings")??"{}").theme)).toBe("github-dark");
  await page.evaluate(()=>{(window as any).__databaseSaveFailure=true;});
  await page.getByRole("radio",{name:"One Dark Pro",exact:true}).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme","one-dark-pro");
  await expect(page.getByRole("alert")).toContainText("Settings could not be saved");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme","github-dark");
});

test("theme changes recolor the remote editor and retain unsaved drafts",async({page})=>{
  const nav=page.getByRole("navigation",{name:"Fixture Alpha tools"});
  await nav.getByRole("button",{name:"Files",exact:true}).click();
  const files=page.getByRole("region",{name:"Fixture Alpha files"});
  await files.getByRole("button",{name:"Edit folder path"}).click();
  await files.getByRole("textbox",{name:"Remote folder path"}).fill("/home/tester");
  await files.getByRole("button",{name:"Go",exact:true}).click();
  await files.getByRole("button",{name:"app.yaml",exact:true}).click();
  const editor=files.getByRole("textbox",{name:"Remote file editor",exact:true});
  await editor.fill("port: 4567");
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("radio",{name:"GitHub Dark",exact:true}).check();
  await nav.getByRole("button",{name:"Files",exact:true}).click();
  await expect(editor).toContainText("port: 4567");
  await expect(files.locator(".cm-editor")).toHaveCSS("background-color","rgb(13, 17, 23)");
  await expect(files).toContainText("Unsaved changes");
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_file_read").length)).toBe(1);
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_file_commit").length)).toBe(0);
});

test("Tokyo Night and One Dark Pro use original workbench fills without changing GitHub Dark",async({page},testInfo)=>{
  const nav=page.getByRole("navigation",{name:"Fixture Alpha tools"});
  for(const [name,id,foreground,button] of [
    ["Tokyo Night","tokyo-night","rgb(169, 177, 214)","rgba(61, 89, 161, 0.867)"],
    ["One Dark Pro","one-dark-pro","rgb(171, 178, 191)","rgb(64, 71, 84)"],
    ["GitHub Dark","github-dark","rgb(230, 237, 243)","rgb(121, 192, 255)"],
  ]){
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("radio",{name,exact:true}).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme",id);
    await page.getByRole("region",{name:"Appearance",exact:true}).screenshot({path:testInfo.outputPath(`${id}-picker.png`)});
    await nav.getByRole("button",{name:"Overview",exact:true}).click();
    await expect(page.locator("body")).toHaveCSS("color",foreground);
    await expect(page.getByRole("button",{name:"Inspect",exact:true})).toHaveCSS("background-color",button);
    await page.screenshot({path:testInfo.outputPath(`${id}-workspace.png`)});
  }
});

test("configuration inspection is explicit, shared across tools and retained across Home",async({page},testInfo)=>{
  const nav=page.getByRole("navigation",{name:"Fixture Alpha tools"});
  await nav.getByRole("button",{name:"Quick Setup",exact:true}).click();
  const setup=page.getByRole("region",{name:"Quick Setup",exact:true});
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_configuration_snapshot"))).toHaveLength(0);
  await setup.getByRole("button",{name:"Inspect server",exact:true}).click();
  await expect(setup.getByText("Partial evidence",{exact:true})).toHaveCount(2);
  await expect(setup.getByText("Needs attention",{exact:true})).toHaveCount(1);
  await setup.getByRole("checkbox",{name:"Select Essential software",exact:true}).check();
  await setup.getByRole("checkbox",{name:"Select Users and SSH",exact:true}).check();
  await setup.getByRole("button",{name:"Review selection",exact:true}).click();
  const review=page.getByRole("dialog",{name:"Review setup selection",exact:true});
  await expect(review).toContainText("Fixture Alpha");
  await expect(review).toContainText("Execution is unavailable");
  await review.getByRole("button",{name:"Close review",exact:true}).click();
  await page.screenshot({path:testInfo.outputPath("quick-setup-inspected.png")});
  await setup.getByRole("button",{name:"Open SSH Access",exact:true}).click();
  const ssh=page.getByRole("region",{name:"SSH Access",exact:true});
  await expect(ssh).toContainText("Not independently verified");
  await expect(ssh).toContainText("Default invocation only");
  await nav.getByRole("button",{name:"Firewall",exact:true}).click();
  const firewall=page.getByRole("region",{name:"Firewall",exact:true});
  await expect(firewall.getByRole("table").getByRole("row")).toHaveCount(3);
  await expect(firewall).toContainText("Allows incoming connections");
  await expect(firewall).toContainText("22/tcp (v6)");
  await expect(firewall).toContainText("Cloud/provider restrictions are unknown");
  await page.screenshot({path:testInfo.outputPath("firewall-inspected.png")});
  await page.getByRole("button",{name:"Fleet home",exact:true}).click();
  await page.getByRole("article",{name:"Fixture Alpha server"}).getByRole("button",{name:"Open workspace",exact:true}).click();
  await nav.getByRole("button",{name:"Quick Setup",exact:true}).click();
  await expect(setup.getByRole("checkbox",{name:"Select Essential software",exact:true})).toBeChecked();
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_configuration_snapshot"))).toHaveLength(1);
  await setup.getByRole("button",{name:"Refresh configuration",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_configuration_snapshot").length)).toBe(2);
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain("fixture-host");
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_action_execute"))).toHaveLength(0);
});

test("configuration failures do not retry and connection changes mark cached evidence stale",async({page})=>{
  const nav=page.getByRole("navigation",{name:"Fixture Alpha tools"});
  await nav.getByRole("button",{name:"Quick Setup",exact:true}).click();
  const setup=page.getByRole("region",{name:"Quick Setup",exact:true});
  await page.evaluate(()=>{(window as any).__configurationFailure=true;});
  await setup.getByRole("button",{name:"Inspect server",exact:true}).click();
  await expect(setup.getByRole("alert")).toContainText("Fixture configuration unavailable");
  await page.clock.fastForward(10000);
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_configuration_snapshot"))).toHaveLength(1);
  await page.evaluate(()=>{(window as any).__configurationFailure=false;});
  await setup.getByRole("button",{name:"Inspect server",exact:true}).click();
  await expect(setup.getByRole("button",{name:"Refresh configuration",exact:true})).toBeEnabled();
  await page.evaluate(()=>{(window as any).__connectionGeneration=2;});
  await page.clock.fastForward(2100);
  await expect(setup).toContainText("Previous connection; stale evidence");
  await expect(setup.getByRole("checkbox",{name:"Select System",exact:true})).toBeDisabled();
  await setup.getByRole("button",{name:"Refresh configuration",exact:true}).click();
  await expect(setup).not.toContainText("Previous connection; stale evidence");
  await page.evaluate(()=>{(window as any).__configurationDisconnected=true;});
  await page.clock.fastForward(2100);
  await expect(setup).toContainText("Server disconnected");
  await expect(setup.getByRole("button",{name:"Refresh configuration",exact:true})).toBeDisabled();
});

test("expanded read-only evidence separates package caches, local users and public-key metadata",async({page},testInfo)=>{
  const nav=page.getByRole("navigation",{name:"Fixture Alpha tools"});
  await nav.getByRole("button",{name:"Quick Setup",exact:true}).click();
  const setup=page.getByRole("region",{name:"Quick Setup",exact:true});
  await setup.getByRole("button",{name:"Inspect server",exact:true}).click();
  await expect(setup.getByRole("button",{name:"Refresh configuration",exact:true})).toBeEnabled();
  const system=setup.getByRole("heading",{name:"System",exact:true}).locator("..");
  await system.locator("summary").click();
  await expect(setup).toContainText("5 updates (cached; not a current update check)");
  const essentials=setup.getByRole("heading",{name:"Essential software",exact:true}).locator("..");
  await essentials.locator("summary").click();
  await expect(setup).toContainText("git 2.39.5 (installed)");
  const security=setup.getByRole("heading",{name:"Security",exact:true}).locator("..");
  await security.locator("summary").click();
  await expect(setup).toContainText("fail2ban.service ActiveState");
  await expect(setup).toContainText("apt-daily-upgrade.timer ActiveState");
  await setup.getByRole("button",{name:"Open SSH Access",exact:true}).click();
  const ssh=page.getByRole("region",{name:"SSH Access",exact:true});
  await expect(ssh.getByRole("region",{name:"SSH server policy",exact:true})).toContainText("ssh.socket ActiveState");
  const users=ssh.getByRole("region",{name:"Local users",exact:true});
  await expect(users).toContainText("UID 1000");
  await expect(users).toContainText("does not prove administrative privileges");
  const keys=ssh.getByRole("region",{name:"Authorized public keys",exact:true});
  await expect(keys).toContainText("SHA256:fixturePublicFingerprint");
  await expect(keys).toContainText("Restricted options present (values hidden)");
  await expect(keys).toContainText("not working login methods");
  await expect(keys).not.toContainText("UID 1000");
  await expect(users).not.toContainText("SHA256:fixturePublicFingerprint");
  await expect(ssh.getByRole("region",{name:"SSH server policy",exact:true})).not.toContainText("SHA256:fixturePublicFingerprint");
  await page.screenshot({path:testInfo.outputPath("ssh-users-and-keys.png")});
  await page.setViewportSize({width:640,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("ssh-users-and-keys-narrow.png")});
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_configuration_snapshot"))).toHaveLength(1);
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain("fixturePublicFingerprint");
  expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==="ssh_action_execute"))).toHaveLength(0);
});
