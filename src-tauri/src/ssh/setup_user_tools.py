"""Official, resolved user-tool artifacts. No downloaded bootstrap scripts."""
import base64, hashlib, io, json, os, pathlib, pwd, re, shutil, subprocess, sys, time, tarfile, tempfile, urllib.error, urllib.parse, urllib.request, zipfile

USER_TOOLS = {'bun', 'uv', 'nvm-node', 'go', 'neovim', 'herdr', 'lazyvim-starter', 'javascript-pm2'}
OFFICIAL_HOSTS = {'api.github.com', 'github.com', 'codeload.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com', 'nodejs.org', 'go.dev', 'dl.google.com', 'herdr.dev', 'registry.npmjs.org', 'download.docker.com', 'dokploy.com', 'auth.docker.io', 'registry-1.docker.io'}

def safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in OFFICIAL_HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Installer source is not an official HTTPS location')
    if '..' in urllib.parse.unquote(parsed.path).split('/') or '\\' in parsed.path or '\0' in parsed.path: raise ValueError('Invalid official artifact path')
    return url

class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl)
        redirected=super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected and urllib.parse.urlsplit(req.full_url).hostname!=urllib.parse.urlsplit(newurl).hostname:
            redirected.remove_header('Authorization')
        return redirected

def download(url, limit=256*1024*1024):
    request = urllib.request.Request(safe_url(url), headers={'User-Agent': 'VPS-Pilot', 'Accept': 'application/json' if 'api.github.com' in url else '*/*'})
    with urllib.request.build_opener(OfficialRedirect()).open(request, timeout=45) as response:
        safe_url(response.geturl())
        data = response.read(limit+1)
    if len(data) > limit: raise ValueError('Official artifact exceeds its download limit')
    return data

def stable_release(repo):
    try:
        value = json.loads(download('https://api.github.com/repos/'+repo+'/releases/latest', 4*1024*1024))
        tag = value.get('tag_name', '')
        if value.get('prerelease') or value.get('draft'): raise ValueError('No stable release available')
    except urllib.error.HTTPError as error:
        if error.code not in (403, 429): raise
        url = 'https://github.com/'+repo+'/releases/latest'
        request = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'VPS-Pilot'})
        with urllib.request.build_opener(OfficialRedirect()).open(request, timeout=45) as response: final = response.geturl()
        prefix = 'https://github.com/'+repo+'/releases/tag/'
        if not final.startswith(prefix): raise ValueError('Official stable release could not be resolved')
        tag = final[len(prefix):]
        value = {'tag_name': tag, 'assets': []}
    if not re.fullmatch(r'(?:bun-)?v?\d+\.\d+\.\d+', tag): raise ValueError('Stable release tag is invalid')
    return value

def artifact(url, expected=None, role='binary', kind='tar'):
    data = download(url)
    digest = hashlib.sha256(data).hexdigest()
    if expected and (not re.fullmatch('[a-fA-F0-9]{64}', expected) or digest != expected.lower()):
        raise ValueError('Official artifact checksum did not match')
    return {'url': url, 'sha256': digest, 'role': role, 'kind': kind, 'publisherChecksum': bool(expected)}

def release_asset(repo, release, filename, role='binary', kind='tar'):
    url = 'https://github.com/'+repo+'/releases/download/'+release['tag_name']+'/'+filename
    asset = next((a for a in release.get('assets', []) if a.get('name') == filename), {})
    expected = asset.get('digest', '').removeprefix('sha256:') or None
    return artifact(url, expected, role, kind)

def resolve_user(item):
    machine = {'x86_64': 'x86_64', 'aarch64': 'aarch64'}.get(os.uname().machine)
    if not machine: raise ValueError('Only Linux x86_64 and arm64 are supported')
    assets = []; version = ''; note = ''
    if item == 'bun':
        release = stable_release('oven-sh/bun'); version = release['tag_name'].removeprefix('bun-v')
        # Baseline avoids requiring AVX2 on older x86 VPS CPUs.
        name = 'bun-linux-'+('x64-baseline' if machine == 'x86_64' else 'aarch64')+'.zip'
        assets = [release_asset('oven-sh/bun', release, name, kind='zip')]
    elif item == 'uv':
        release = stable_release('astral-sh/uv'); version = release['tag_name'].lstrip('v')
        name = 'uv-'+machine+'-unknown-linux-gnu.tar.gz'
        assets = [release_asset('astral-sh/uv', release, name)]
    elif item == 'herdr':
        manifest = json.loads(download('https://herdr.dev/latest.json', 4*1024*1024)); version = manifest['version']
        target = 'linux-'+machine
        assets = [artifact(manifest['assets'][target], manifest['sha256'][target], kind='raw')]
    elif item == 'go':
        releases = json.loads(download('https://go.dev/dl/?mode=json', 4*1024*1024))
        release = next(value for value in releases if value.get('stable'))
        version = release['version'].removeprefix('go')
        entry = next(f for f in release['files'] if f['os'] == 'linux' and f['arch'] == ('amd64' if machine == 'x86_64' else 'arm64') and f['kind'] == 'archive')
        assets = [artifact('https://dl.google.com/go/'+entry['filename'], entry['sha256'])]
    elif item == 'neovim':
        release = stable_release('neovim/neovim'); version = release['tag_name'].lstrip('v')
        name = 'nvim-linux-'+('x86_64' if machine == 'x86_64' else 'arm64')+'.tar.gz'
        assets = [release_asset('neovim/neovim', release, name)]
    elif item == 'nvm-node':
        release = stable_release('nvm-sh/nvm')
        node = next(v for v in json.loads(download('https://nodejs.org/dist/index.json', 4*1024*1024)) if v.get('lts'))
        version = node['version']; name = 'node-'+version+'-linux-'+('x64' if machine == 'x86_64' else 'arm64')+'.tar.xz'
        sums = download('https://nodejs.org/dist/'+version+'/SHASUMS256.txt', 1024*1024).decode()
        digest = next(line.split()[0] for line in sums.splitlines() if len(line.split()) == 2 and line.split()[1] == name)
        assets = [artifact('https://codeload.github.com/nvm-sh/nvm/tar.gz/'+release['tag_name'], role='nvm'), artifact('https://nodejs.org/dist/'+version+'/'+name, digest, role='node')]
        note = 'Node '+version+' LTS · NVM '+release['tag_name']
    elif item == 'lazyvim-starter':
        try:
            value = json.loads(download('https://api.github.com/repos/LazyVim/starter/commits/HEAD', 4*1024*1024)); version = value['sha']
        except urllib.error.HTTPError as error:
            if error.code not in (403,429): raise
            result=subprocess.run(['/usr/bin/git','-c','credential.helper=','ls-remote','https://github.com/LazyVim/starter.git','HEAD'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=45,env={'PATH':'/usr/bin:/bin','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0'})
            version=result.stdout.decode().split()[0] if result.returncode==0 and result.stdout.split() else ''
        if not re.fullmatch('[a-f0-9]{40}', version): raise ValueError('Official starter revision is invalid')
        assets = [artifact('https://codeload.github.com/LazyVim/starter/tar.gz/'+version)]
        note = 'Starter at this commit; plugins download on first Neovim launch.'
    elif item == 'javascript-pm2':
        value = json.loads(download('https://registry.npmjs.org/pm2/latest', 4*1024*1024)); version = value['version']
        if not re.fullmatch(r'\d+\.\d+\.\d+', version): raise ValueError('No stable PM2 version available')
        data = download(value['dist']['tarball']); integrity = value['dist']['integrity']
        if integrity != 'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode(): raise ValueError('PM2 publisher integrity check failed')
        assets = [{'url': value['dist']['tarball'], 'sha256': hashlib.sha256(data).hexdigest(), 'role': 'binary', 'kind': 'npm', 'publisherChecksum': True}]
        note = 'PM2 npm package; dependencies use the official npm registry. Boot startup is not enabled.'
    else: raise ValueError('Unknown user tool')
    if any(not a['publisherChecksum'] for a in assets): note += (' ' if note else '')+'HTTPS source digest pinned for this approval; no publisher signature.'
    return {'id': item, 'version': version, 'source': ' · '.join(a['url'] for a in assets), 'artifacts': assets, 'message': note}

def extract_compatible_tar(package, entries, destination):
    # Debian 12's Python can lack extraction filters. This deliberately supports
    # only directories, regular files and links contained in the fresh staging
    # tree, with no overwrite, devices, inherited owners or link parents.
    links=[];seen=set()
    root=destination.resolve()
    def target(name):
        pure=pathlib.PurePosixPath(name)
        if pure.is_absolute() or '..' in pure.parts or '\0' in name: raise ValueError('Unsafe archive path')
        path=destination.joinpath(*pure.parts)
        if path==destination: return path
        for parent in reversed(path.parents):
            if parent==destination.parent: continue
            if parent==destination or destination in parent.parents:
                if parent.is_symlink(): raise ValueError('Archive path crosses a link')
                if not parent.exists(): parent.mkdir(mode=0o700)
                if not parent.is_dir(): raise ValueError('Archive parent is not a directory')
        return path
    for member in entries:
        path=target(member.name)
        if path==destination:
            if not member.isdir(): raise ValueError('Invalid archive root')
            continue
        if member.name in seen: raise ValueError('Duplicate archive member')
        seen.add(member.name)
        if member.isdir():
            if os.path.lexists(path) and not path.is_dir(): raise ValueError('Archive path collision')
            path.mkdir(mode=0o700,exist_ok=True)
        elif member.isfile():
            source=package.extractfile(member)
            if source is None: raise ValueError('Missing archive member data')
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,(member.mode&0o755)|0o600)
            with os.fdopen(fd,'wb') as output:
                remaining=member.size
                while remaining:
                    chunk=source.read(min(remaining,65536))
                    if not chunk: raise ValueError('Truncated official archive')
                    output.write(chunk);remaining-=len(chunk)
        elif member.issym() or member.islnk(): links.append(member)
        else: raise ValueError('Unsupported special archive member')
    for member in links:
        path=target(member.name)
        if os.path.lexists(path): raise ValueError('Archive link would replace an existing file')
        link=pathlib.PurePosixPath(member.linkname)
        if link.is_absolute() or '\0' in member.linkname: raise ValueError('Unsafe archive link')
        referent=pathlib.Path(os.path.normpath(str((path.parent if member.issym() else destination)/member.linkname)))
        if not referent.is_relative_to(destination): raise ValueError('Archive link escapes staging')
        if member.issym(): path.symlink_to(member.linkname)
        else:
            if referent.is_symlink() or not referent.is_file() or not referent.resolve().is_relative_to(root): raise ValueError('Unsafe archive hard link')
            os.link(referent,path,follow_symlinks=False)
    for member in links:
        try:
            if not target(member.name).resolve().is_relative_to(root): raise ValueError('Archive link escapes staging')
        except (RuntimeError,OSError): raise ValueError('Invalid archive link chain')

def user_install(item, plan):
    published=[]
    try: return install_user_tool(item,plan,published)
    except Exception:
        for path,expected in reversed(published):
            try:
                if path.is_symlink() and os.readlink(path)==expected: path.unlink()
            except OSError: pass
        raise

def install_user_tool(item, plan, published):
    if os.getuid() == 0: raise ValueError('Switch to a non-root administrator before installing user tools')
    home = pathlib.Path(os.environ['HOME']); uid = os.getuid()
    def directory(path):
        if path == path.parent: return
        if not path.exists(): directory(path.parent); path.mkdir(mode=0o700)
        metadata = path.lstat()
        if path.is_symlink() or not path.is_dir() or metadata.st_uid not in (uid, 0) or metadata.st_mode & 0o022:
            raise ValueError('Unsafe user installation directory')
    directory(home); directory(home/'.local'); directory(home/'.local/bin'); directory(home/'.local/share')
    store = home/'.local/share/vps-pilot-tools'; directory(store)
    bindir = home/'.local/bin'
    for name in ('npm-user.npmrc','npm-global.npmrc'):
        path=store/name
        if not os.path.lexists(path):
            with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb'): pass
        meta=path.lstat()
        if path.is_symlink() or not path.is_file() or meta.st_uid!=uid or meta.st_nlink!=1 or meta.st_size!=0 or meta.st_mode&0o077: raise ValueError('Unsafe managed npm configuration')
    def execute(args):
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300,
            env={'HOME':str(home), 'USER':pwd.getpwuid(uid).pw_name, 'PATH':str(bindir)+':/usr/local/bin:/usr/bin:/bin', 'LANG':'C.UTF-8', 'NPM_CONFIG_USERCONFIG':str(store/'npm-user.npmrc'), 'NPM_CONFIG_GLOBALCONFIG':str(store/'npm-global.npmrc'), 'NPM_CONFIG_REGISTRY':'https://registry.npmjs.org', 'NPM_CONFIG_CACHE':str(store/'npm-cache')})
        if result.returncode: raise ValueError(os.path.basename(args[0])+' exited '+str(result.returncode)+'; check network access and existing managed files')
    def shell_init(label, lines):
        path = home/'.bashrc'; marker = '# VPS Pilot '+label
        original = b''
        if os.path.lexists(path):
            meta = path.lstat()
            if path.is_symlink() or not path.is_file() or meta.st_uid != uid or meta.st_nlink != 1 or meta.st_mode & 0o022 or meta.st_size > 1024*1024:
                raise ValueError('Unsafe shell configuration; existing file preserved')
            original = path.read_bytes()
        if marker.encode() in original: return
        if original:
            backup = store/('bashrc-'+os.urandom(8).hex()+'.backup')
            with os.fdopen(os.open(backup, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600), 'wb') as output: output.write(original)
        fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'ab') as output: output.write(('\n'+marker+'\n'+lines+'\n').encode()); output.flush(); os.fsync(output.fileno())
    def publish(name, target):
        if os.path.lexists(bindir/name):
            if (bindir/name).is_symlink() and (bindir/name).resolve() == target.resolve(): return
            raise ValueError('Existing user executable preserved: '+name)
        (bindir/name).symlink_to(target)
        published.append((bindir/name,str(target)))
    def unpack(entry):
        data = download(entry['url'])
        if hashlib.sha256(data).hexdigest() != entry['sha256']: raise ValueError('Artifact changed since approval; prepare installation again')
        destination = pathlib.Path(tempfile.mkdtemp(prefix=item+'-', dir=store))
        if shutil.disk_usage(destination).free < len(data)*4+64*1024*1024: raise ValueError('Insufficient free space')
        if entry['kind'] == 'raw':
            target = destination/item; target.write_bytes(data); target.chmod(0o700)
        elif entry['kind'] == 'zip':
            with zipfile.ZipFile(io.BytesIO(data)) as package:
                entries = package.infolist()
                if len(entries)>10000 or sum(e.file_size for e in entries)>1024*1024*1024: raise ValueError('Archive exceeds extraction limit')
                for member in entries:
                    path = pathlib.PurePosixPath(member.filename)
                    if path.is_absolute() or '..' in path.parts or (member.external_attr>>16)&0o170000 == 0o120000: raise ValueError('Unsafe archive member')
                package.extractall(destination)
            for path in destination.rglob('*'):
                if path.is_file(): path.chmod(0o700)
        else:
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as package:
                entries = package.getmembers()
                if len(entries)>100000 or sum(max(0,e.size) for e in entries)>1024*1024*1024: raise ValueError('Archive exceeds extraction limit')
                if shutil.disk_usage(destination).free < sum(max(0,e.size) for e in entries)*2+64*1024*1024: raise ValueError('Insufficient space for the extracted artifact')
                if hasattr(tarfile,'data_filter'): package.extractall(destination, members=entries, filter='data')
                else: extract_compatible_tar(package,entries,destination)
        return destination
    if item == 'javascript-pm2':
        entry = plan['artifacts'][0]; data = download(entry['url'])
        if hashlib.sha256(data).hexdigest() != entry['sha256']: raise ValueError('PM2 artifact changed since approval')
        if not (bindir/'npm').exists(): raise ValueError('Install Node through NVM first')
        with tempfile.NamedTemporaryFile(suffix='.tgz', dir=store) as archive:
            archive.write(data); archive.flush()
            prefix=pathlib.Path(tempfile.mkdtemp(prefix='pm2-',dir=store))
            execute([str(bindir/'npm'), 'install', '--global', '--prefix', str(prefix), '--ignore-scripts', '--registry=https://registry.npmjs.org', archive.name])
        publish('pm2',prefix/'lib/node_modules/pm2/bin/pm2')
        shell_init('PATH', 'export PATH="$HOME/.local/bin:$PATH"'); return
    if item == 'nvm-node':
        nvm = home/'.nvm'
        if os.path.lexists(nvm):
            directory(nvm)
            manager = nvm/'nvm.sh'
            if manager.is_symlink() or not manager.is_file() or manager.stat().st_uid != uid or manager.stat().st_mode & 0o022: raise ValueError('Unsafe existing NVM configuration')
        else:
            unpacked = unpack(plan['artifacts'][0]); roots = list(unpacked.iterdir())
            if len(roots)!=1: raise ValueError('Unexpected NVM archive layout')
            roots[0].rename(nvm)
        directory(nvm/'versions'); directory(nvm/'versions/node')
        target = nvm/'versions/node'/plan['version']
        if not os.path.lexists(target):
            unpacked = unpack(plan['artifacts'][1]); roots = list(unpacked.iterdir())
            if len(roots)!=1: raise ValueError('Unexpected Node archive layout')
            roots[0].rename(target)
        else: directory(target)
        for name in ('node','npm','npx'): publish(name, target/'bin'/name)
        execute([str(bindir/'node'),'--version'])
        directory(nvm/'alias')
        default=nvm/'alias/default'
        if not os.path.lexists(default):
            with os.fdopen(os.open(default,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'w') as output: output.write(plan['version']+'\n')
        shell_init('NVM', 'export NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"')
    elif item == 'lazyvim-starter':
        directory(home/'.config'); target=home/'.config/nvim'
        if os.path.lexists(target): raise ValueError('Existing Neovim configuration preserved')
        unpacked=unpack(plan['artifacts'][0]); roots=list(unpacked.iterdir())
        if len(roots)!=1: raise ValueError('Unexpected LazyVim archive layout')
        roots[0].rename(target)
    else:
        unpacked=unpack(plan['artifacts'][0])
        names={'bun':['bun','bunx'], 'uv':['uv','uvx'], 'go':['go','gofmt'], 'neovim':['nvim'], 'herdr':['herdr']}[item]
        primary={'neovim':'nvim'}.get(item,item)
        for name in names:
            if item=='bun' and name=='bunx':
                publish(name,(bindir/'bun').resolve()); continue
            candidates=[p for p in unpacked.rglob(name) if p.is_file() and not p.is_symlink() and (p.parent.name=='bin' or item in ('bun','uv','herdr'))]
            if len(candidates)!=1: raise ValueError('Official archive does not contain the expected executable')
            candidates[0].chmod(candidates[0].stat().st_mode|0o100); publish(name,candidates[0])
        execute([str(bindir/primary), 'version' if item=='go' else '--version'])
    shell_init('PATH', 'export PATH="$HOME/.local/bin:$PATH"')
