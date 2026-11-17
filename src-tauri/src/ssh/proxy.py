"""Fixed proxy adapters. Caddy is the first supported manager; no config writes."""
import hashlib,json,os,pathlib,re,shlex,stat,subprocess,sys,fcntl

def command(args,seconds=15):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=seconds,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'})
    if p.returncode or len(p.stdout)>131072:raise ValueError('Proxy inspection or service command failed')
    return p.stdout.decode()

def trusted(path):
    p=pathlib.Path(path)
    for parent in [p,*p.parents]:
        meta=parent.lstat()
        if parent.is_symlink() or meta.st_uid!=0 or meta.st_mode&0o022:raise ValueError('Unsafe Caddy configuration or service path')
    return p

def argv(value):
    match=re.search(r'argv\[\]=(.*?) ;',value)
    if not match:raise ValueError('Unsupported Caddy service command')
    return shlex.split(match.group(1))

def detect():
    fields='Id,LoadState,ActiveState,SubState,FragmentPath,DropInPaths,User,ExecStart,ExecReload,Environment,EnvironmentFiles,NeedDaemonReload,InvocationID,Job,ExecStartPre,ExecStartPost,ExecStop,ExecStopPost,RequiredBy,BoundBy,ConsistsOf,PropagatesStopTo,OnFailure,OnSuccess,TriggeredBy'
    text=command(['/usr/bin/systemctl','show','--no-pager','--property='+fields,'caddy.service'])
    props=dict(line.split('=',1) for line in text.splitlines() if '=' in line)
    if props.get('LoadState')=='not-found':return {'manager':'caddy','installed':os.path.isfile('/usr/bin/caddy'),'status':'No systemd service','supported':False,'message':'No caddy.service was detected'}
    result={'manager':'caddy','installed':True,'status':props.get('ActiveState','unknown'),'supported':False,'config':''}
    try:
        if props.get('Id')!='caddy.service' or props.get('LoadState')!='loaded' or props.get('User')!='caddy':raise ValueError('Only the standard account-scoped caddy.service is supported')
        if props.get('DropInPaths') or props.get('Environment') or props.get('EnvironmentFiles') or props.get('NeedDaemonReload')!='no' or props.get('Job') or any(props.get(key) for key in ('ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','RequiredBy','BoundBy','ConsistsOf','PropagatesStopTo','OnFailure','OnSuccess','TriggeredBy')):raise ValueError('Custom service overrides or a pending service job require manual review')
        start=argv(props.get('ExecStart',''));reload=argv(props.get('ExecReload',''))
        if len(start)<4 or start[:2]!=['/usr/bin/caddy','run']:raise ValueError('Unsupported Caddy service executable')
        config=None;adapter=None;i=2
        while i<len(start):
            if start[i]=='--environ':i+=1;continue
            if start[i] in ('--config','--adapter') and i+1<len(start):
                if start[i]=='--config':
                    if config is not None:raise ValueError('Duplicate Caddy configuration')
                    config=start[i+1]
                else:adapter=start[i+1]
                i+=2;continue
            raise ValueError('Unsupported Caddy service arguments')
        if not config or not config.startswith('/etc/caddy/') or adapter not in (None,'caddyfile'):raise ValueError('Caddy must use a configuration under /etc/caddy')
        result['config']=config
        expected=['/usr/bin/caddy','reload','--config',config]
        if reload not in [expected,expected+['--force'],expected+['--adapter','caddyfile'],expected+['--force','--adapter','caddyfile']]:raise ValueError('Unsupported Caddy reload command')
        binary=trusted('/usr/bin/caddy');fragment=trusted(os.path.realpath(props['FragmentPath']));root=trusted('/etc/caddy');target=trusted(config)
        digest=hashlib.sha256(text.encode())
        # Bind all local Caddy config files, including imported files, without exposing contents.
        has_imports=False
        for line in target.read_text().splitlines():
            if re.match(r'^\s*import\s+',line):has_imports=True
        count=0;total=0;directories=0
        for directory,dirs,files in os.walk(root,followlinks=False):
            directories+=1
            if directories>128:raise ValueError('Caddy configuration exceeds inspection limits')
            for name in dirs:trusted(pathlib.Path(directory)/name)
            for name in sorted(files):
                if not has_imports and name.endswith('.save') and str(pathlib.Path(directory)/name)!=config:continue
                p=trusted(pathlib.Path(directory)/name);m=p.stat();count+=1;total+=m.st_size
                if not stat.S_ISREG(m.st_mode) or count>128 or total>2*1024*1024:raise ValueError('Caddy configuration exceeds inspection limits')
                data=p.read_bytes()
                for line in data.decode(errors='replace').splitlines():
                    if re.match(r'^\s*import\s+',line):
                        parts=shlex.split(line,comments=True)
                        if len(parts)>1 and ('..' in pathlib.PurePosixPath(parts[1]).parts or (parts[1].startswith('/') and not parts[1].startswith('/etc/caddy/'))):raise ValueError('Caddy imports outside /etc/caddy require manual review')
                if b'{$' in data:raise ValueError('Environment-dependent Caddy configuration requires manual review')
                digest.update(str(p).encode());digest.update(data)
        digest.update(binary.read_bytes() if binary.stat().st_size<32*1024*1024 else str(binary.stat()).encode());digest.update(fragment.read_bytes())
        result.update(supported=props.get('ActiveState')=='active',snapshot=digest.hexdigest(),adapter=adapter or ('caddyfile' if target.name=='Caddyfile' else ''),invocation=props.get('InvocationID',''))
        if not result['supported']:result['message']='Caddy is not active'
    except (ValueError,OSError) as e:result['message']=str(e) if isinstance(e,ValueError) else 'Permission to inspect Caddy configuration is required'
    return result

def main():
    request=json.loads(sys.stdin.readline(8193));operation=request.get('operation')
    if request.get('manager')!='caddy' or operation not in ('detect','reload','restart'):raise ValueError('Unsupported proxy action')
    if operation=='detect':return detect()
    if os.geteuid()!=0:raise ValueError('Administrator privileges are required')
    fd=os.open('/var/lib/vps-pilot-proxy.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    m=os.fstat(fd)
    if not stat.S_ISREG(m.st_mode) or m.st_uid!=0 or m.st_nlink!=1 or m.st_mode&0o077:raise ValueError('Unsafe proxy operation lock')
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    current=detect()
    if not current.get('supported') or current.get('snapshot')!=request.get('snapshot'):raise ValueError('Caddy settings changed or are unsupported; refresh before applying')
    args=['/usr/sbin/runuser','-u','caddy','--','/usr/bin/caddy','validate','--config',current['config']]
    if current['adapter']:args+=['--adapter',current['adapter']]
    try:command(args,30)
    except ValueError:raise ValueError('Caddy configuration validation failed; no service change was applied')
    command(['/usr/bin/systemctl',operation,'caddy.service'],60)
    state=command(['/usr/bin/systemctl','show','--value','-p','ActiveState','caddy.service']).strip()
    invocation=command(['/usr/bin/systemctl','show','--value','-p','InvocationID','caddy.service']).strip()
    if state!='active' or not invocation or (operation=='restart' and invocation==current['invocation']) or (operation=='reload' and invocation!=current['invocation']):raise ValueError('Caddy service result could not be verified; inspect before retrying')
    return {'manager':'caddy','status':'active','message':'Caddy '+('reloaded' if operation=='reload' else 'restarted')}
if __name__=='__main__':
    try:print(json.dumps(main()))
    except Exception as e:
        print(json.dumps({'error':str(e) if isinstance(e,ValueError) else 'Proxy operation failed; inspect before retrying'}));sys.exit(1)
