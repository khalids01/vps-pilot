"""Bounded package scans, resolved plans, and independently checked results."""
import json, os, pwd, selectors, shutil, subprocess, sys, time
exec(USER_CODE)
exec(STACK_CODE)
exec(SECURITY_CODE)
PACKAGES = {'git':'git','curl':'curl','ripgrep':'ripgrep','fd':'fd-find','fzf':'fzf','jq':'jq','btop':'btop','unzip':'unzip','tmux':'tmux','bat':'bat','eza':'eza','rsync':'rsync','direnv':'direnv','python':'python3','podman':'podman','ufw':'ufw','ca-certificates':'ca-certificates','xz-utils':'xz-utils','libatomic1':'libatomic1','build-essential':'build-essential'}
COMMANDS = {**{k:k for k in PACKAGES},'fd':'fdfind','ripgrep':'rg','python':'python3','bat':'batcat','docker':'docker','neovim':'nvim','bun':'bun','uv':'uv','go':'go','herdr':'herdr','nvm-node':'node','javascript-pm2':'pm2','xz-utils':'xz'}
IDS = set(COMMANDS) | {'dokploy','lazyvim-starter'}
DEPENDENCIES = {'dokploy':['docker'],'javascript-pm2':['nvm-node'],'lazyvim-starter':['neovim','git','ripgrep','fd','build-essential']}


def setup_error(error):
    if isinstance(error,ValueError): return str(error)[:256]
    if isinstance(error,urllib.error.HTTPError): return 'Official source returned HTTP '+str(error.code)+'; check availability before retrying'
    if isinstance(error,urllib.error.URLError): return 'Official source connection or TLS verification failed; check server connectivity'
    if isinstance(error,subprocess.TimeoutExpired): return 'Operation timed out; check installed before retrying'
    if isinstance(error,OSError) and error.errno==28: return 'Server disk space is exhausted'
    return 'Setup failed; check installed before retrying'

def validate(r):
    if r.get('action') not in ('scan','prepare','install','firewall-status','firewall-apply','security-apply') or not isinstance(r.get('items'),list) or not r['items'] or len(r['items'])>32 or any(not isinstance(i,str) or i not in IDS for i in r['items']) or len(set(r['items']))!=len(r['items']): raise ValueError('Invalid package selection')
    user=r.get('user')
    if not isinstance(user,str) or not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}',user): raise ValueError('Invalid installation account')
    return pwd.getpwnam(user)

def system_info():
    values={}
    with open('/etc/os-release',encoding='utf8') as content:
        for line in content:
            if '=' in line:
                key,value=line.rstrip().split('=',1);values[key]=value.strip('"')
    if (values.get('ID'),values.get('VERSION_ID')) not in {('debian','12'),('debian','13'),('ubuntu','22.04'),('ubuntu','24.04'),('ubuntu','26.04'),('ubuntu','26.10')} or not re.fullmatch('[a-z]+',values.get('VERSION_CODENAME','')):
        raise ValueError('Installers support Debian 12/13 and Ubuntu 22.04/24.04/26.04/26.10')
    if os.uname().machine not in ('x86_64','aarch64'): raise ValueError('Installers support x86_64 and arm64')
    return values

def package_installed(name):
    result=subprocess.run(['dpkg-query','-W','-f=${Status}',name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
    return result.returncode==0 and result.stdout==b'install ok installed'

def executable(item,account):
    name=COMMANDS.get(item)
    if not name: return None
    names={'fd':['fd','fdfind'],'bat':['bat','batcat']}.get(item,[name])
    paths=[os.path.join(account.pw_dir,'.local/bin'),os.path.join(account.pw_dir,'.bun/bin'),'/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin']
    if item=='nvm-node':
        if not os.path.isfile(os.path.join(account.pw_dir,'.nvm/nvm.sh')): return None
        paths = [str(p.parent) for p in sorted(pathlib.Path(account.pw_dir,'.nvm/versions/node').glob('*/bin/node'))]
    return next((os.path.join(path,command) for path in paths for command in names if os.path.isfile(os.path.join(path,command)) and os.access(os.path.join(path,command),os.X_OK)),None)

def user_command(args,account,seconds=15):
    if os.geteuid()==0 and account.pw_uid!=0: args=['/usr/sbin/runuser','-u',account.pw_name,'--',*args]
    return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=seconds,
        env={'HOME':account.pw_dir,'PATH':account.pw_dir+'/.local/bin:/usr/local/bin:/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C','GOTOOLCHAIN':'local','GOWORK':'off','GOENV':'off'})

def present(item,account):
    if item=='ca-certificates': return os.path.isfile('/etc/ssl/certs/ca-certificates.crt')
    if item in ('libatomic1','build-essential'): return package_installed(PACKAGES[item])
    if item=='lazyvim-starter':
        config=os.path.join(account.pw_dir,'.config/nvim/lua/config/lazy.lua')
        if os.path.islink(config) or not os.path.isfile(config) or os.path.getsize(config)>65536: return False
        with open(config,'rb') as content: return b'LazyVim/LazyVim' in content.read(65536)
    if item=='dokploy':
        if not shutil.which('docker',path='/usr/bin:/usr/local/bin:/bin'): return False
        ledger=read_dokploy_ledger()
        if ledger and ledger.get('state')!='installed': return False
        environment={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}
        result=subprocess.run(['/usr/bin/docker','service','ls','--format','{{.Name}} {{.Replicas}}'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,env=environment)
        services=result.stdout.decode(errors='replace').splitlines()
        if result.returncode or not all(any(line.split()==[name,'1/1'] for line in services) for name in ('dokploy','dokploy-postgres')): return False
        proxy=subprocess.run(['/usr/bin/docker','container','inspect','--format','{{.State.Running}}','dokploy-traefik'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,env=environment)
        if proxy.returncode or proxy.stdout.strip()!=b'true': return False
        image=json.loads(checked(['/usr/bin/docker','service','inspect','--format','{{json .Spec.TaskTemplate.ContainerSpec.Image}}','dokploy']))
        if not re.match(r'^dokploy/dokploy(?::[^@]+)?@sha256:[a-f0-9]{64}$',image.removeprefix('docker.io/')): return False
        try:
            with urllib.request.urlopen('http://127.0.0.1:3000',timeout=5) as response: return response.status in (200,302)
        except (OSError,urllib.error.URLError): return False
    candidate=executable(item,account)
    if not candidate: return False
    if item in USER_TOOLS and item!='javascript-pm2':
        result=user_command([candidate,'version' if item=='go' else '--version'],account)
        return result.returncode==0
    if item=='javascript-pm2':
        module=pathlib.Path(candidate).resolve().parent.parent
        metadata=module/'package.json'
        if not metadata.is_file() or metadata.stat().st_size>65536: return False
        value=json.loads(metadata.read_text())
        if value.get('name')!='pm2': return False
        node=executable('nvm-node',account) or shutil.which('node',path='/usr/local/bin:/usr/bin:/bin')
        if not node: return False
        # Resolve installed dependencies without executing PM2 or starting its daemon.
        check="const fs=require('node:fs'),path=require('node:path'),dir=process.argv[1];const p=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));for(const n of Object.keys(p.dependencies||{}))require.resolve(n,{paths:[dir]});"
        return user_command([node,'-e',check,str(module)],account).returncode==0
    return True

def observed_version(item,account):
    if item in PACKAGES:
        result=subprocess.run(['dpkg-query','-W','-f=${Version}',PACKAGES[item]],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
        text=result.stdout.decode(errors='replace') if result.returncode==0 else ''
    elif item=='javascript-pm2':
        try: text=json.loads((pathlib.Path(executable(item,account)).resolve().parent.parent/'package.json').read_text())['version']
        except (OSError,ValueError,KeyError): text=''
    elif (item in USER_TOOLS and item!='lazyvim-starter') or item=='docker':
        candidate=executable(item,account)
        if not candidate: return ''
        result=user_command([candidate,'version' if item=='go' else '--version'],account)
        text=result.stdout[:256].decode(errors='replace').split('\n')[0] if result.returncode==0 else ''
    else: return ''
    if item in PACKAGES:
        return text[:96] if re.fullmatch(r'[A-Za-z0-9.+:~_-]{1,96}',text) else ''
    if item=='go': text=text.removeprefix('go version go')
    match=re.search(r'(?<![A-Za-z0-9])v?(\d+\.\d+\.\d+)(?![A-Za-z0-9])',text)
    return match.group(1) if match else ''

def conflict(item,account):
    if item in USER_TOOLS and account.pw_uid==0: return 'Switch to a non-root administrator to install user tools'
    if item=='lazyvim-starter' and os.path.lexists(os.path.join(account.pw_dir,'.config/nvim')): return 'Existing Neovim configuration will be preserved; choose Neovim only'
    if item=='podman' and shutil.which('docker',path='/usr/bin:/usr/local/bin:/bin'): return 'Docker is already present; existing container networking was preserved'
    if item in ('docker','dokploy'): return stack_conflict(item)
    names={'bun':['bun','bunx'],'uv':['uv','uvx'],'go':['go','gofmt'],'neovim':['nvim'],'nvm-node':['node','npm','npx'],'herdr':['herdr'],'javascript-pm2':['pm2']}.get(item,[])
    if any(os.path.lexists(os.path.join(account.pw_dir,'.local/bin',name)) for name in names): return 'Existing executable did not pass verification; inspect it before retrying'
    return None

def observe(items,account):
    result=[]
    for item in items:
        row={'id':item,'status':'unknown','message':''}
        try:
            if present(item,account): row.update(status='installed',version=observed_version(item,account))
            else:
                reason=conflict(item,account)
                row.update(status='unknown' if reason and ('daemon access' in reason or 'with this account' in reason) else 'conflict' if reason else 'missing',message=reason or '')
        except (OSError,ValueError,subprocess.TimeoutExpired): row.update(status='unknown',message='Status could not be checked with this account')
        result.append(row)
    return result

def official_sources():
    paths=[pathlib.Path('/etc/apt/sources.list')]
    paths += sorted(pathlib.Path('/etc/apt/sources.list.d').glob('*.list')) + sorted(pathlib.Path('/etc/apt/sources.list.d').glob('*.sources'))
    allowed={'deb.debian.org','security.debian.org','archive.ubuntu.com','security.ubuntu.com','ports.ubuntu.com','download.docker.com'}
    found=False
    for path in paths:
        if not path.exists(): continue
        text=path.read_text()
        for line in text.splitlines():
            if line.lstrip().startswith('#'): continue
            for uri in re.findall(r'mirror\+file://[^\s]+',line):
                path=pathlib.Path(urllib.parse.urlsplit(uri).path)
                if path.parent!=pathlib.Path('/etc/apt/mirrors') or not re.fullmatch(r'[A-Za-z0-9._-]+\.list',path.name): return False
                metadata=path.lstat()
                if path.is_symlink() or not path.is_file() or metadata.st_uid!=0 or metadata.st_mode&0o022 or metadata.st_size>65536: return False
                mirrors=' '.join(part.split('#',1)[0] for part in path.read_text().splitlines())
                line=line.replace(uri,mirrors)
            if re.search(r'(?i)(trusted\s*=\s*yes|Trusted:\s*yes|allow-insecure\s*=\s*yes|Allow-Insecure:\s*yes|file:|ftp:|cdrom:|mirror:)',line): return False
            for uri in re.findall(r'https?://[^\s]+',line):
                host=urllib.parse.urlsplit(uri).hostname or ''
                if host not in allowed and not host.endswith('.archive.ubuntu.com'): return False
                found=True
    return found

def sources_snapshot():
    paths=[pathlib.Path('/etc/apt/sources.list')]
    paths += sorted(pathlib.Path('/etc/apt/sources.list.d').glob('*')) + sorted(pathlib.Path('/etc/apt/mirrors').glob('*.list'))
    digest=hashlib.sha256()
    for path in paths:
        if path.is_file(): digest.update(str(path).encode());digest.update(path.read_bytes())
    return digest.hexdigest()

def dependencies(items):
    ordered=[]
    def add(item):
        for dependency in DEPENDENCIES.get(item,[]): add(dependency)
        if item in USER_TOOLS:
            for dependency in ('ca-certificates','xz-utils','libatomic1'): add(dependency)
        if item=='docker': add('ca-certificates')
        if item not in ordered: ordered.append(item)
    for item in items: add(item)
    return ordered

def apt_candidate(package):
    result=subprocess.run(['apt-cache','policy',package],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
    candidate=next((line.split(':',1)[1].strip() for line in result.stdout.decode(errors='replace').splitlines() if line.strip().startswith('Candidate:')),None)
    if not candidate or candidate=='(none)' or not re.fullmatch(r'[A-Za-z0-9.+:~_-]{1,160}',candidate): raise ValueError('No signed distribution package candidate for '+package+'; refresh the server package lists')
    return candidate

def prepare(r,account):
    system=system_info()
    if not official_sources(): raise ValueError('Installation requires official signed Debian/Ubuntu repositories; custom sources were preserved')
    plans=[]
    for row in observe(dependencies(r['items']),account):
        item=row['id']
        if row['status']=='installed': plans.append({**row,'skip':True});continue
        if row['status']=='conflict': raise ValueError(item+': '+row['message'])
        if item in PACKAGES: plan={'id':item,'version':apt_candidate(PACKAGES[item]),'source':'Signed '+system['ID']+' distribution repository','message':'','package':PACKAGES[item]}
        elif item=='docker': plan=resolve_docker(system)
        elif item=='dokploy': plan=resolve_dokploy()
        else: plan=resolve_user(item)
        plans.append({**plan,'skip':False})
    return {'items':[{k:v for k,v in plan.items() if k in ('id','version','source','message','status','artifacts','images')} for plan in plans], 'plan':{'items':plans,'sourcesSnapshot':sources_snapshot()}}

def validate_resolved_plan(plan,requested):
    if not isinstance(plan,dict) or not isinstance(plan.get('items'),list) or [entry.get('id') for entry in plan['items']]!=dependencies(requested): raise ValueError('Installer plan does not match its dependency order')
    prefixes={'bun':'https://github.com/oven-sh/bun/releases/download/','uv':'https://github.com/astral-sh/uv/releases/download/','herdr':'https://github.com/herdrdev/herdr/releases/download/','neovim':'https://github.com/neovim/neovim/releases/download/','go':'https://dl.google.com/go/go','lazyvim-starter':'https://codeload.github.com/LazyVim/starter/tar.gz/','javascript-pm2':'https://registry.npmjs.org/pm2/-/'}
    for entry in plan['items']:
        item=entry['id']
        if entry.get('skip'): continue
        version=entry.get('version','')
        if not isinstance(version,str) or not re.fullmatch(r'[A-Za-z0-9.+:~_-]{1,160}',version): raise ValueError('Invalid reviewed version')
        if item in PACKAGES and entry.get('package')!=PACKAGES[item]: raise ValueError('Reviewed package did not match the fixed catalog')
        if item=='dokploy':
            expected={'app':'dokploy/dokploy','postgres':'library/postgres','traefik':'library/traefik'}
            if set(entry.get('images',{}))!=set(expected) or any(not re.fullmatch(re.escape(repo)+r'@sha256:[a-f0-9]{64}',entry['images'][name]) for name,repo in expected.items()): raise ValueError('Platform images changed from their reviewed official repositories')
        if item=='docker':
            system=system_info()
            if entry.get('distro')!=system['ID'] or entry.get('codename')!=system['VERSION_CODENAME'] or set(entry.get('packages',{}))!=set(DOCKER_PACKAGES): raise ValueError('Docker source does not match this system')
            if entry.get('arch')!={'x86_64':'amd64','aarch64':'arm64'}.get(os.uname().machine): raise ValueError('Docker architecture changed')
            if any(not re.fullmatch(r'[A-Za-z0-9.+:~_-]{1,160}',value) for value in entry['packages'].values()): raise ValueError('Invalid Docker package version')
            if docker_key_fingerprint(entry.get('key','').encode())!=DOCKER_FINGERPRINT: raise ValueError('Docker signing identity changed')
        if item in USER_TOOLS or item=='dokploy':
            assets=entry.get('artifacts')
            if not isinstance(assets,list) or len(assets)!=(2 if item=='nvm-node' else 1): raise ValueError('Invalid reviewed artifacts')
            for index,asset in enumerate(assets):
                url=safe_url(asset.get('url',''))
                prefix=('https://codeload.github.com/nvm-sh/nvm/tar.gz/' if index==0 else 'https://nodejs.org/dist/') if item=='nvm-node' else prefixes.get(item,'https://dokploy.com/install.sh')
                if not url.startswith(prefix) or (item=='dokploy' and url!='https://dokploy.com/install.sh') or not re.fullmatch('[a-f0-9]{64}',asset.get('sha256','')): raise ValueError('Artifact source changed from the fixed catalog')

def install_as_user(item,account,plan):
    if account.pw_uid==0: raise ValueError('Switch to a non-root administrator for user tools')
    code=USER_CODE+"\nr=json.loads(sys.stdin.readline(131073))\ntry:\n user_install(r['item'],r['plan']);print('{}')\nexcept Exception as error:\n print(json.dumps({'error':str(error)[:256] if isinstance(error,ValueError) else 'Official download or extraction failed'}));sys.exit(1)"
    result=subprocess.run(['/usr/sbin/runuser','-u',account.pw_name,'--','/usr/bin/python3','-I','-S','-u','-c',code],input=(json.dumps({'item':item,'plan':plan})+'\n').encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=700,
        env={'HOME':account.pw_dir,'USER':account.pw_name,'LOGNAME':account.pw_name,'PATH':'/usr/local/bin:/usr/bin:/bin','LANG':'C.UTF-8','SHELL':'/bin/bash'})
    if result.returncode:
        try: reason=json.loads(result.stdout[:4096]).get('error','User-tool installation failed')
        except (ValueError,AttributeError): reason='User-tool installation failed'
        raise ValueError(reason)

def progress(row):
    print(json.dumps({'progress':row}),flush=True)

def run(r):
    account=validate(r)
    if r['action']=='scan': return observe(r['items'],account)
    if r['action']=='prepare': return prepare(r,account)
    if r['action']=='firewall-status': return security_status(r)
    if r['action']=='security-apply': return apply_security(r)
    if r['action']=='firewall-apply': raise ValueError('Use the verified SSH/firewall transaction')
    if os.geteuid()!=0: raise ValueError('Administrator privileges are required')
    system_info()
    plan=r.get('plan')
    if not isinstance(plan,dict) or not isinstance(plan.get('items'),list) or plan.get('sourcesSnapshot')!=sources_snapshot(): raise ValueError('Package sources changed; check installed and prepare installation again')
    validate_resolved_plan(plan,r['items'])
    if not official_sources(): raise ValueError('Unsigned or custom package sources are not supported')
    results={};failed=set()
    for entry in plan['items']:
        item=entry['id'];row={'id':item,'status':'installing','message':''}
        if item in r['items']: progress(row)
        try:
            if present(item,account):
                row.update(status='installed',version=observed_version(item,account))
            else:
                if entry.get('skip'): raise ValueError('Previously installed dependency disappeared; check installed and prepare again')
                failures=[dependency for dependency in dependencies([item]) if dependency!=item and dependency in failed]
                if failures:
                    dependency=failures[0];label={'nvm-node':'Node/NVM','neovim':'Neovim','build-essential':'Build tools','ca-certificates':'CA certificates','xz-utils':'XZ utilities','libatomic1':'Atomic runtime library'}.get(dependency,dependency)
                    raise ValueError(label+': '+results[dependency]['message'])
                reason=conflict(item,account)
                if reason: raise ValueError(reason)
                if item in PACKAGES:
                    command=['apt-get','-o','APT::Get::AllowUnauthenticated=false','-o','Acquire::AllowInsecureRepositories=false','-o','Acquire::AllowDowngradeToInsecureRepositories=false','--assume-yes','--no-remove','--no-upgrade','--no-install-recommends','install',entry['package']+'='+entry['version']]
                    result=subprocess.run(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=300,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','DEBIAN_FRONTEND':'noninteractive','LC_ALL':'C'})
                    if result.returncode or not package_installed(entry['package']): raise ValueError('Package installation failed; check package locks and repository availability')
                elif item=='docker': install_docker(entry)
                elif item=='dokploy': install_dokploy(entry,r)
                else: install_as_user(item,account,entry)
                if not present(item,account): raise ValueError('Installation could not be independently verified')
                row.update(status='installed',version=observed_version(item,account) or entry.get('version',''),source=entry.get('source',''))
        except (ValueError,OSError,subprocess.TimeoutExpired,urllib.error.URLError):
            # Do not reflect arbitrary subprocess/network error text: it can
            # contain local paths, upstream payloads or credential-like values.
            error=sys.exc_info()[1]
            row.update(status='failed',message=setup_error(error))
            failed.add(item)
        results[item]=row
        if item in r['items']: progress(row)
    return {'items':[results[item] for item in r['items']], 'dependencies':[row for item,row in results.items() if item not in r['items']]}
