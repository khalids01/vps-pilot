"""Narrow Docker/Dokploy provisioning. Preserves existing engines and workloads."""
import gzip, ipaddress, socket

DOCKER_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88'
DOCKER_PACKAGES = ('docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin')

def checked(args, seconds=60, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=seconds,
        env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','LC_ALL':'C','DEBIAN_FRONTEND':'noninteractive'})
    if result.returncode: raise ValueError('Required '+os.path.basename(args[0])+' operation failed')
    if len(result.stdout)>8*1024*1024: raise ValueError('Operation output exceeded its limit')
    return result.stdout

def docker_json(args):
    data = checked(['/usr/bin/docker', *args])
    try: return json.loads(data)
    except (ValueError, TypeError): raise ValueError('Cannot inspect the existing Docker engine')

def stack_conflict(item,check_capacity=True):
    if shutil.which('podman', path='/usr/local/bin:/usr/bin:/bin') or os.path.exists('/var/run/podman/podman.sock'):
        return 'Podman is already present; existing container networking was preserved'
    if item == 'docker':
        if os.path.exists('/var/run/docker.sock') and not shutil.which('docker',path='/usr/bin:/usr/local/bin:/bin'): return 'An existing Docker socket was preserved; its engine needs explicit adoption'
        for package in ('docker.io','podman-docker','docker-compose','containerd','runc'):
            result = subprocess.run(['dpkg-query','-W','-f=${Status}',package], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
            if result.returncode == 0 and result.stdout == b'install ok installed':
                return 'Existing '+package+' conflicts with Docker CE; no packages were removed'
        if os.path.exists('/var/lib/docker') and os.listdir('/var/lib/docker'):
            return 'Existing Docker data needs explicit adoption; it was preserved'
        return None
    owned=read_dokploy_ledger()
    if owned and owned.get('swarm'):
        return dokploy_owned_conflict(owned)
    if os.path.lexists('/etc/dokploy'):
        return 'Existing /etc/dokploy was preserved; inspect the previous platform installation'
    if not shutil.which('ss'): return 'Cannot check required ports: ss is missing'
    occupied=set()
    for protocol,arguments in [('tcp',['ss','-H','-ltn']),('udp',['ss','-H','-lun'])]:
        output=checked(arguments).decode(errors='replace')
        for line in output.splitlines():
            fields=line.split();match=re.search(r':(80|443|3000)$',fields[3] if len(fields)>3 else '')
            if match and (protocol=='tcp' or match.group(1)=='443'): occupied.add(int(match.group(1)))
    occupied=sorted(occupied)
    if occupied: return 'Ports '+', '.join(map(str,occupied))+' are in use'
    memory = next((int(line.split()[1])*1024 for line in open('/proc/meminfo') if line.startswith('MemTotal:')), 0)
    if memory < 1800*1024*1024: return 'Dokploy requires at least 2 GB of memory'
    minimum=2 if owned or not check_capacity else 8
    if shutil.disk_usage('/var/lib').free < minimum*1024*1024*1024: return 'Dokploy requires at least '+str(minimum)+' GB of free storage'
    if shutil.which('docker', path='/usr/bin:/usr/local/bin:/bin'):
        try:
            info = docker_json(['info','--format','{{json .}}'])
            if info.get('Swarm',{}).get('LocalNodeState') != 'inactive': return 'Existing Docker Swarm must be preserved; platform installation was blocked'
            if checked(['/usr/bin/docker','ps','-aq']).strip(): return 'Existing containers must be preserved; use a separate server for Dokploy'
            if checked(['/usr/bin/docker','volume','ls','-q']).strip(): return 'Existing Docker volumes must be preserved; platform installation was blocked'
        except (ValueError, OSError, subprocess.TimeoutExpired):
            return 'Docker daemon access is required to check platform ownership'
    if os.path.isfile('/.dockerenv'): return 'Dokploy requires a full Linux VM or VPS'
    return None

def docker_key_fingerprint(key):
    try:
        body=key.decode().split('\n\n',1)[1].split('-----END')[0]
        data=base64.b64decode(''.join(line for line in body.splitlines() if line and not line.startswith('=')),validate=True)
        header=data[0]
        if header&0x40:
            if header&0x3f!=6: raise ValueError('Not a public key packet')
            first=data[1]
            if first<192: length=first;offset=2
            elif first<224: length=((first-192)<<8)+data[2]+192;offset=3
            elif first==255: length=int.from_bytes(data[2:6],'big');offset=6
            else: raise ValueError('Partial signing key packet')
        else:
            if (header>>2)&15!=6: raise ValueError('Not a public key packet')
            sizes={0:1,1:2,2:4};size=sizes[header&3];offset=1+size;length=int.from_bytes(data[1:offset],'big')
        packet=data[offset:offset+length]
        if len(packet)!=length or packet[0]!=4 or length>65535: raise ValueError('Unsupported signing key')
        return hashlib.sha1(b'\x99'+length.to_bytes(2,'big')+packet).hexdigest().upper()
    except (ValueError,IndexError,KeyError,UnicodeError): raise ValueError('Invalid Docker signing key')

def resolve_docker(system):
    distro=system['ID'];codename=system['VERSION_CODENAME']
    arch={'x86_64':'amd64','aarch64':'arm64'}.get(os.uname().machine)
    if not arch: raise ValueError('Unsupported Docker CPU architecture')
    base='https://download.docker.com/linux/'+distro
    key=download(base+'/gpg', 65536)
    if docker_key_fingerprint(key)!=DOCKER_FINGERPRINT: raise ValueError('Docker publisher key fingerprint did not match')
    armor=key.decode();body=armor.split('\n\n',1)[1].split('-----END')[0]
    binary=base64.b64decode(''.join(line for line in body.splitlines() if line and not line.startswith('=')))
    release=download(base+'/dists/'+codename+'/InRelease', 1024*1024)
    with tempfile.TemporaryDirectory(prefix='vps-pilot-docker-source-') as staging:
        keypath=pathlib.Path(staging)/'docker.gpg';keypath.write_bytes(binary)
        releasepath=pathlib.Path(staging)/'InRelease';releasepath.write_bytes(release)
        verified=checked(['/usr/bin/gpgv','--status-fd','1','--keyring',str(keypath),str(releasepath)])
        signatures=[line.split() for line in verified.decode().splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
        if not any(parts[2]==DOCKER_FINGERPRINT or parts[-1]==DOCKER_FINGERPRINT for parts in signatures): raise ValueError('Docker repository signing identity did not match')
    relative='stable/binary-'+arch+'/Packages.gz'
    digest=None
    in_sha=False
    for line in release.decode().splitlines():
        if line=='SHA256:': in_sha=True; continue
        if in_sha:
            parts=line.split()
            if len(parts)==3 and parts[2]==relative: digest=parts[0];break
            if line and not line[0].isspace(): in_sha=False
    if not digest: raise ValueError('Signed Docker package index is unavailable')
    compressed=download(base+'/dists/'+codename+'/'+relative, 8*1024*1024)
    if hashlib.sha256(compressed).hexdigest()!=digest: raise ValueError('Docker package index checksum mismatch')
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream: data=stream.read(32*1024*1024+1)
    if len(data)>32*1024*1024: raise ValueError('Docker package index exceeds its limit')
    selected={}
    for block in data.decode().split('\n\n'):
        fields={line.split(': ',1)[0]:line.split(': ',1)[1] for line in block.splitlines() if ': ' in line and not line.startswith(' ')}
        name=fields.get('Package');version=fields.get('Version','')
        if name not in DOCKER_PACKAGES: continue
        if name not in selected or subprocess.run(['dpkg','--compare-versions',version,'gt',selected[name]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0: selected[name]=version
    if set(selected)!=set(DOCKER_PACKAGES): raise ValueError('Stable Docker packages could not be resolved')
    return {'id':'docker','version':selected['docker-ce'],'source':base+' · Docker signed stable repository','packages':selected,'key':key.decode(),'keyDigest':hashlib.sha256(key).hexdigest(),'codename':codename,'distro':distro,'arch':arch,'message':'Installs and starts Docker. Published container ports can bypass UFW.'}

def install_docker(plan):
    conflict=stack_conflict('docker')
    if conflict: raise ValueError(conflict)
    keydir=pathlib.Path('/etc/apt/keyrings');sourcedir=pathlib.Path('/etc/apt/sources.list.d')
    for directory in (keydir,sourcedir):
        if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid!=0 or directory.stat().st_mode&0o022: raise ValueError('Unsafe APT configuration directory')
    keypath=keydir/'vps-pilot-docker.asc';sourcepath=sourcedir/'vps-pilot-docker.sources'
    text='Types: deb\nURIs: https://download.docker.com/linux/'+plan['distro']+'\nSuites: '+plan['codename']+'\nComponents: stable\nArchitectures: '+plan['arch']+'\nSigned-By: '+str(keypath)+'\n'
    for path,data in ((keypath,plan['key'].encode()),(sourcepath,text.encode())):
        if os.path.lexists(path):
            if path.is_symlink() or not path.is_file() or path.stat().st_uid!=0 or path.stat().st_nlink!=1 or path.read_bytes()!=data: raise ValueError('Existing APT source file was preserved')
        else:
            with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644),'wb') as output: output.write(data); output.flush(); os.fsync(output.fileno())
    checked(['apt-get','-o','APT::Get::AllowUnauthenticated=false','update'],180)
    checked(['apt-get','-o','APT::Get::AllowUnauthenticated=false','--assume-yes','--no-remove','--no-upgrade','--no-install-recommends','install',*[name+'='+version for name,version in plan['packages'].items()]],600)
    checked(['systemctl','start','docker'],60)
    info=docker_json(['info','--format','{{json .}}'])
    if not info.get('ServerVersion'): raise ValueError('Docker daemon verification failed')
    checked(['/usr/bin/docker','compose','version'])

DOKPLOY_LEDGER=pathlib.Path('/var/lib/vps-pilot-dokploy.json')
OWNER_LABEL='org.vps-pilot.setup'

def read_dokploy_ledger():
    data=secure_file(DOKPLOY_LEDGER,True)
    if data is None: return None
    value=json.loads(data)
    if value.get('format')!=1 or not re.fullmatch('[a-f0-9]{32}',value.get('owner','')) or not isinstance(value.get('plan'),dict): raise ValueError('Existing platform state was preserved; its ownership record is invalid')
    return value

def save_dokploy_ledger(value):
    atomic_file(DOKPLOY_LEDGER,json.dumps(value,sort_keys=True).encode(),0o644)

def registry_image(repository,tag):
    scope=urllib.parse.quote('repository:'+repository+':pull',safe='')
    token=json.loads(download('https://auth.docker.io/token?service=registry.docker.io&scope='+scope,1024*1024))['token']
    if not isinstance(token,str) or not re.fullmatch(r'[A-Za-z0-9._~+/=-]{1,8192}',token): raise ValueError('Container registry authorization was unavailable')
    headers={'User-Agent':'VPS-Pilot','Authorization':'Bearer '+token,'Accept':'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'}
    request=urllib.request.Request('https://registry-1.docker.io/v2/'+repository+'/manifests/'+tag,headers=headers)
    with urllib.request.build_opener(OfficialRedirect()).open(request,timeout=45) as response:
        data=response.read(8*1024*1024+1);expected=response.headers.get('Docker-Content-Digest','')
    token=''
    digest='sha256:'+hashlib.sha256(data).hexdigest()
    if len(data)>8*1024*1024 or digest!=expected: raise ValueError('Official container manifest digest did not match')
    manifest=json.loads(data)
    if 'manifests' in manifest:
        architecture={'x86_64':'amd64','aarch64':'arm64'}.get(os.uname().machine)
        if not any(item.get('platform',{}).get('os')=='linux' and item.get('platform',{}).get('architecture')==architecture for item in manifest['manifests']): raise ValueError('Official platform image does not support this CPU')
    return repository+'@'+digest

def resolve_dokploy():
    previous=read_dokploy_ledger()
    if previous:
        plan=dict(previous['plan']);plan['message']='Resume the platform resources owned by VPS Pilot. Existing application data is preserved.'
        return plan
    release=stable_release('Dokploy/dokploy');version=release['tag_name']
    data=download('https://dokploy.com/install.sh',2*1024*1024)
    text=data.decode()
    names=set(re.findall(r'--name\s+([A-Za-z0-9-]+)',text))
    required={'dokploy','dokploy-postgres','dokploy-traefik'}
    if names!=required or 'BETTER_AUTH_SECRET_FILE' not in text or 'POSTGRES_PASSWORD_FILE' not in text or 'published=3000,target=3000,mode=host' not in text: raise ValueError('Official Dokploy installation recipe changed and requires review')
    proxies=set(re.findall(r'(?m)^\s*(traefik:v[0-9.]+)\s*$',text))
    databases=set(re.findall(r'(?m)^\s*(postgres:[0-9.]+)\s*$',text))
    if len(proxies)!=1 or len(databases)!=1: raise ValueError('Official platform dependency images could not be resolved')
    proxy=next(iter(proxies)).split(':',1)[1];database=next(iter(databases)).split(':',1)[1]
    images={'app':registry_image('dokploy/dokploy',version),'postgres':registry_image('library/postgres',database),'traefik':registry_image('library/traefik',proxy)}
    script={'url':'https://dokploy.com/install.sh','sha256':hashlib.sha256(data).hexdigest(),'role':'recipe','kind':'script','publisherChecksum':False}
    return {'id':'dokploy','version':version,'source':script['url'],'artifacts':[script],'images':images,'message':'Native execution of the official recipe, with pinned container manifests. Creates Docker Swarm, owned services/volumes and ports 80, 443 and 3000. Published ports can bypass UFW.'}

def docker_names(kind):
    return set(checked(['/usr/bin/docker',kind,'ls','--format','{{.Name}}']).decode().splitlines())

def own_resource(kind,name,owner):
    if name not in docker_names(kind): return False
    field='{{json .Spec.Labels}}' if kind in ('service','secret') else '{{json .Labels}}'
    labels=json.loads(checked(['/usr/bin/docker',kind,'inspect','--format',field,name])) or {}
    if labels.get(OWNER_LABEL)!=owner: raise ValueError('Existing '+name+' is not owned by this setup and was preserved')
    return True

def canonical_image(image):
    value=image.removeprefix('docker.io/')
    return value.removeprefix('library/')

def dokploy_owned_conflict(ledger):
    try:
        info=docker_json(['info','--format','{{json .}}'])
        if info.get('ID')!=ledger.get('engine') or info.get('Swarm',{}).get('Cluster',{}).get('ID')!=ledger.get('swarm'): return 'Docker engine or Swarm identity changed; platform resources were preserved'
        for name in docker_names('service'):
            if name not in ('dokploy','dokploy-postgres') or not own_resource('service',name,ledger['owner']): return 'Other Swarm services are present; automatic platform changes were blocked'
        for name,image in [('dokploy',ledger['plan']['images']['app']),('dokploy-postgres',ledger['plan']['images']['postgres'])]:
            if name in docker_names('service'):
                spec=docker_json(['service','inspect','--format','{{json .Spec}}',name])
                if canonical_image(spec.get('TaskTemplate',{}).get('ContainerSpec',{}).get('Image',''))!=canonical_image(image) or spec.get('Mode',{}).get('Replicated',{}).get('Replicas')!=1: return 'An owned platform service changed; it was preserved'
        for kind,names in [('network',['dokploy-network']),('volume',['dokploy','dokploy-postgres']),('secret',['dokploy_postgres_password','dokploy_auth_secret'])]:
            for name in names: own_resource(kind,name,ledger['owner'])
        containers=checked(['/usr/bin/docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
        for name in containers:
            labels=json.loads(checked(['/usr/bin/docker','container','inspect','--format','{{json .Config.Labels}}',name])) or {}
            if labels.get(OWNER_LABEL)!=ledger['owner']: return 'A container outside this setup is present; it was preserved'
        return None
    except (OSError,ValueError,subprocess.TimeoutExpired): return 'Platform ownership could not be verified with this account'

def pull_platform_images(plan):
    for name,image in plan['images'].items():
        progress({'id':'dokploy','status':'installing','message':'Pulling '+name+' image…'})
        existing=subprocess.run(['/usr/bin/docker','image','inspect','--format','{{.Id}}',image],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,env={'PATH':'/usr/bin:/bin','LANG':'C'})
        if existing.returncode: checked(['/usr/bin/docker','pull',image],900)

def install_dokploy(plan,request):
    previous=read_dokploy_ledger()
    if previous and previous.get('swarm'):
        reason=dokploy_owned_conflict(previous)
        if reason: raise ValueError(reason)
        if plan['images']!=previous['plan']['images'] or plan['version']!=previous['plan']['version']: raise ValueError('Refresh the original platform installation plan before resuming')
        ledger=previous
    else:
        conflict=stack_conflict('dokploy')
        if conflict: raise ValueError(conflict)
        data=download(plan['artifacts'][0]['url'],2*1024*1024)
        if hashlib.sha256(data).hexdigest()!=plan['artifacts'][0]['sha256']: raise ValueError('Official platform recipe changed since approval')
        info=docker_json(['info','--format','{{json .}}'])
        if previous and (previous.get('engine')!=info.get('ID') or previous['plan'].get('images')!=plan.get('images') or info.get('Swarm',{}).get('LocalNodeState')!='inactive'): raise ValueError('An earlier platform operation has an uncertain outcome; existing resources were preserved')
        ledger=previous or {'format':1,'owner':os.urandom(16).hex(),'engine':info['ID'],'swarm':None,'plan':plan,'state':'pulling'}
        save_dokploy_ledger(ledger)
        pull_platform_images(plan)
        conflict=stack_conflict('dokploy',False)
        if conflict: raise ValueError(conflict)
        current=docker_json(['info','--format','{{json .}}'])
        if current.get('ID')!=ledger['engine'] or current.get('Swarm',{}).get('LocalNodeState')!='inactive': raise ValueError('Docker identity changed during preparation; no existing Swarm was adopted')
        address=request.get('serverAddress','')
        try: ipaddress.ip_address(address)
        except ValueError: raise ValueError('Cannot establish the server advertise address')
        checked(['/usr/bin/docker','swarm','init','--advertise-addr',address],60)
        info=docker_json(['info','--format','{{json .}}']);ledger['swarm']=info.get('Swarm',{}).get('Cluster',{}).get('ID')
        if not ledger['swarm']: raise ValueError('Created Swarm identity was not confirmed')
        ledger['state']='installing';save_dokploy_ledger(ledger)
    owner=ledger['owner'];label=OWNER_LABEL+'='+owner;images=plan['images']
    # Pull exact reviewed manifests. Interrupted pulls can resume from Docker's
    # own layer cache; no running resource or user data is removed on retry.
    if previous and previous.get('swarm'): pull_platform_images(plan)
    progress({'id':'dokploy','status':'installing','message':'Starting owned platform services…'})
    if not own_resource('network','dokploy-network',owner): checked(['/usr/bin/docker','network','create','--driver','overlay','--attachable','--label',label,'dokploy-network'])
    for volume in ('dokploy','dokploy-postgres'):
        if not own_resource('volume',volume,owner): checked(['/usr/bin/docker','volume','create','--label',label,volume])
    for secret in ('dokploy_postgres_password','dokploy_auth_secret'):
        if not own_resource('secret',secret,owner): checked(['/usr/bin/docker','secret','create','--label',label,secret,'-'],data=os.urandom(32).hex().encode())
    config=pathlib.Path('/etc/dokploy')
    if not config.exists(): config.mkdir(mode=0o750)
    if config.is_symlink() or not config.is_dir() or config.stat().st_uid!=0 or config.stat().st_mode&0o022: raise ValueError('Unsafe platform configuration directory')
    common=['--label',label,'--container-label',label,'--constraint','node.role==manager','--network','dokploy-network']
    if not own_resource('service','dokploy-postgres',owner):
        checked(['/usr/bin/docker','service','create','--detach=true','--name','dokploy-postgres',*common,'--env','POSTGRES_USER=dokploy','--env','POSTGRES_DB=dokploy','--secret','source=dokploy_postgres_password,target=/run/secrets/postgres_password','--env','POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password','--mount','type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data',images['postgres']],120)
    if not own_resource('service','dokploy',owner):
        checked(['/usr/bin/docker','service','create','--detach=true','--name','dokploy','--replicas','1',*common,'--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock','--mount','type=bind,source=/etc/dokploy,target=/etc/dokploy','--mount','type=volume,source=dokploy,target=/root/.docker','--secret','source=dokploy_postgres_password,target=/run/secrets/postgres_password','--secret','source=dokploy_auth_secret,target=/run/secrets/dokploy_auth_secret','--publish','published=3000,target=3000,mode=host','--update-parallelism','1','--update-order','stop-first','--env','RELEASE_TAG=latest','--env','POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password','--env','BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_auth_secret',images['app']],120)
    progress({'id':'dokploy','status':'installing','message':'Checking platform readiness…'})
    deadline=time.monotonic()+240
    while time.monotonic()<deadline:
        services=checked(['/usr/bin/docker','service','ls','--format','{{.Name}} {{.Replicas}}']).decode().splitlines()
        ready=all(any(line.split()==[name,'1/1'] for line in services) for name in ('dokploy','dokploy-postgres'))
        if ready and (config/'traefik/traefik.yml').is_file():
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000',timeout=5) as response:
                    if response.status in (200,302): break
            except (OSError,urllib.error.URLError): pass
        time.sleep(2)
    else: raise ValueError('Owned platform services are not ready yet; Retry failed resumes without replacing them')
    existing=checked(['/usr/bin/docker','ps','-a','--filter','name=^dokploy-traefik$','--format','{{.Names}}']).decode().strip()
    if existing:
        labels=json.loads(checked(['/usr/bin/docker','container','inspect','--format','{{json .Config.Labels}}','dokploy-traefik'])) or {}
        if labels.get(OWNER_LABEL)!=owner: raise ValueError('An existing proxy container was preserved')
    else:
        secure_file(config/'traefik/traefik.yml')
        checked(['/usr/bin/docker','run','-d','--name','dokploy-traefik','--label',label,'--restart','always','--network','dokploy-network','-v','/etc/dokploy/traefik/traefik.yml:/etc/traefik/traefik.yml','-v','/etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic','-v','/var/run/docker.sock:/var/run/docker.sock:ro','-p','80:80/tcp','-p','443:443/tcp','-p','443:443/udp',images['traefik']],120)
    if checked(['/usr/bin/docker','container','inspect','--format','{{.State.Running}}','dokploy-traefik']).strip()!=b'true': raise ValueError('The owned proxy is stopped; inspect it in Docker before retrying')
    ledger['state']='installed';save_dokploy_ledger(ledger)
