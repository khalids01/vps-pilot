"""SSH/UFW transaction with persistent systemd recovery and two key-login checkpoints."""
import datetime, fcntl, glob, stat, signal, sys, time, selectors, shlex

SECURITY_ROOT=pathlib.Path('/var/lib/vps-pilot/security')
SSH_MAIN=pathlib.Path('/etc/ssh/sshd_config')
SOCKET_OVERRIDE=pathlib.Path('/etc/systemd/system/ssh.socket.d/90-vps-pilot.conf')
UFW_FILES=[pathlib.Path(path) for path in ('/etc/ufw/user.rules','/etc/ufw/user6.rules','/etc/ufw/ufw.conf','/etc/default/ufw')]

def root_directory(path):
    if not path.exists(): root_directory(path.parent);path.mkdir(mode=0o700)
    meta=path.lstat()
    if path.is_symlink() or not path.is_dir() or meta.st_uid!=0 or meta.st_mode&0o022: raise ValueError('Unsafe recovery directory')

def secure_file(path,missing=False):
    if not os.path.lexists(path):
        if missing: return None
        raise ValueError('Required configuration file is missing')
    for parent in path.parents:
        meta=parent.lstat()
        if parent.is_symlink() or not parent.is_dir() or meta.st_uid!=0 or meta.st_mode&0o022: raise ValueError('Unsafe configuration parent')
    meta=path.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid!=0 or meta.st_nlink!=1 or meta.st_mode&0o022 or meta.st_size>1024*1024:
        raise ValueError('Unsafe configuration file; existing file was preserved')
    return path.read_bytes()

def atomic_file(path,data,mode=0o600):
    secure_file(path,True)
    fd,temporary=tempfile.mkstemp(prefix='.vps-pilot-',dir=path.parent)
    try:
        os.fchmod(fd,mode)
        with os.fdopen(fd,'wb') as output: output.write(data);output.flush();os.fsync(output.fileno())
        os.replace(temporary,path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def configuration_files():
    return [SSH_MAIN,*map(pathlib.Path,sorted(glob.glob('/etc/ssh/sshd_config.d/*.conf'))),*UFW_FILES,SOCKET_OVERRIDE]

def security_snapshot():
    digest=hashlib.sha256()
    for path in configuration_files():
        data=secure_file(path,True)
        digest.update(str(path).encode());digest.update(b'absent' if data is None else data)
    return digest.hexdigest()

def effective_ssh(r,user=None,port=None):
    command=['/usr/sbin/sshd','-T']
    if r.get('clientAddress') and r.get('serverAddress'):
        command+=['-C','user='+(user or r['user'])+',addr='+r['clientAddress']+',host='+r['clientAddress']+',laddr='+r['serverAddress']+',lport='+str(port or r['currentPort'])]
    text=checked(command).decode()
    values={};ports=[]
    for line in text.splitlines():
        key,_,value=line.partition(' ')
        if key=='port': ports.append(int(value))
        if key in ('passwordauthentication','kbdinteractiveauthentication','permitrootlogin','authenticationmethods'):values[key]=value
    values['ports']=ports
    return values

def validate_ssh_service():
    if checked(['systemctl','show','ssh.service','--property=KillMode','--value']).strip()!=b'process': raise ValueError('SSH service does not preserve existing sessions during restart')
    if checked(['systemctl','show','ssh.service','--property=DropInPaths','--value']).strip(): raise ValueError('Custom SSH service overrides were preserved')
    if checked(['systemctl','show','ssh.service','--property=Environment','--value']).strip(): raise ValueError('Custom SSH service environment was preserved')
    environments=checked(['systemctl','show','ssh.service','--property=EnvironmentFiles','--value']).decode().strip()
    if environments not in ('','/etc/default/ssh (ignore_errors=yes)'): raise ValueError('Custom SSH environment files were preserved')
    command=checked(['systemctl','show','ssh.service','--property=ExecStart','--value']).decode()
    match=re.search(r'argv\[\]=([^;]+)',command)
    if not match or shlex.split(match.group(1).strip()) not in (['/usr/sbin/sshd','-D','$SSHD_OPTS'],['/usr/sbin/sshd','-D']): raise ValueError('Custom SSH daemon arguments were preserved')
    dropins=checked(['systemctl','show','ssh.socket','--property=DropInPaths','--value']).decode().split()
    allowed={str(SOCKET_OVERRIDE),'/run/systemd/generator/ssh.socket.d/addresses.conf'}
    if any(path not in allowed for path in dropins): raise ValueError('Custom SSH socket overrides were preserved')

def security_status(r):
    if os.geteuid()!=0: raise ValueError('Administrator privileges are required')
    ssh=effective_ssh(r)
    ufw=shutil.which('ufw',path='/usr/sbin:/sbin:/usr/bin:/bin')
    rules=checked([ufw,'status','numbered']).decode() if ufw else 'Not installed'
    issue=''
    try: validate_ssh_service()
    except ValueError as error: issue=str(error)
    return [{'id':'ufw','status':'installed' if ufw else 'missing','message':issue,'rules':rules,'ssh':ssh,'snapshot':security_snapshot()}]

def preflight_security(r):
    system_info()
    intent=r['security']
    if r['user']=='root': raise ValueError('Switch to the verified non-root administrator first')
    if not intent.get('recoveryAcknowledged'): raise ValueError('Confirm provider console access and the target provider-firewall port')
    if not r.get('clientAddress') or not r.get('serverAddress'): raise ValueError('Cannot establish the connected SSH endpoint')
    if r['currentPort']!=r.get('profilePort'): raise ValueError('SSH port forwarding/NAT requires a separately verified migration plan')
    if r.get('snapshot')!=security_snapshot(): raise ValueError('SSH or firewall configuration changed; refresh status before applying')
    root_directory(SECURITY_ROOT)
    transactions=list(SECURITY_ROOT.glob('*/journal.json'))
    if len(transactions)>=32: raise ValueError('Recovery backup limit reached; preserved backups need review')
    prior_journals=[]
    for transaction in transactions:
        journal=json.loads(secure_file(transaction))
        prior_journals.append(journal)
        if journal.get('state') not in ('committed','rolled-back'): raise ValueError('A previous access transaction needs recovery before applying again')
    validate_ssh_service()
    for unit in ('ssh.service','ssh.socket'):
        checked(['systemctl','show',unit,'--property=LoadState','--value'])
    if intent.get('configureFirewall'):
        if not shutil.which('ufw',path='/usr/sbin:/sbin:/usr/bin:/bin'): raise ValueError('Install UFW before applying the firewall preset')
        if shutil.which('docker',path='/usr/local/bin:/usr/bin:/bin') or shutil.which('podman',path='/usr/local/bin:/usr/bin:/bin') or os.path.exists('/var/run/docker.sock'):
            raise ValueError('Container networking is present; SSH/firewall migration requires its own network policy')
        defaults=secure_file(pathlib.Path('/etc/default/ufw')).decode()
        if not re.search(r'(?m)^IPV6=\"?yes\"?\s*$',defaults): raise ValueError('This preset requires IPv6 filtering enabled in UFW')
        rules=checked(['ufw','status','numbered']).decode()
        if any(word in rules for word in ('DENY','REJECT','LIMIT')): raise ValueError('Existing restrictive UFW rules were preserved')
        for name in ('before.rules','before6.rules','after.rules','after6.rules'):
            path=pathlib.Path('/etc/ufw')/name;template=pathlib.Path('/usr/share/ufw')/name
            if secure_file(path)!=secure_file(template.resolve()): raise ValueError('Custom UFW hook rules were preserved')
        for name in ('before.init','after.init'):
            path=pathlib.Path('/etc/ufw')/name
            if os.path.lexists(path) and secure_file(path)!=secure_file((pathlib.Path('/usr/share/ufw')/name).resolve()): raise ValueError('Custom UFW hooks were preserved')
    defaults=pathlib.Path('/etc/default/ssh')
    if defaults.exists():
        for line in secure_file(defaults).decode().splitlines():
            if re.match(r'^\s*SSHD_OPTS=',line) and line.split('=',1)[1].strip().strip('"\''):
                raise ValueError('Custom SSH daemon arguments were preserved')
    for path in configuration_files():
        if str(path).startswith('/etc/ssh/'):
            data=secure_file(path).decode()
            for line in data.splitlines():
                if re.match(r'^\s*Include\s+',line,re.I) and line.strip().lower()!='include /etc/ssh/sshd_config.d/*.conf': raise ValueError('Custom SSH include paths were preserved')
                if re.match(r'^\s*ListenAddress\s+',line,re.I): raise ValueError('Custom SSH listen addresses were preserved')
                if re.match(r'^\s*Match\s+',line,re.I): raise ValueError('Custom conditional SSH policies were preserved')
    port=intent.get('port')
    if not isinstance(port,int) or isinstance(port,bool) or not 1<=port<=65535: raise ValueError('Invalid target SSH port')
    listeners=checked(['ss','-H','-ltn']).decode()
    if port!=r['currentPort'] and any(re.search(r':'+str(port)+r'$',line.split()[3] if len(line.split())>3 else '') for line in listeners.splitlines()): raise ValueError('The target SSH port is already in use')
    if SOCKET_OVERRIDE.exists() and not any(journal.get('state')=='committed' and journal.get('expected',{}).get(str(SOCKET_OVERRIDE))==file_digest(SOCKET_OVERRIDE) for journal in prior_journals): raise ValueError('An unrecognized SSH socket override was preserved')
    checked(['/usr/sbin/sshd','-t'])

def save_journal(folder,journal):
    atomic_file(folder/'journal.json',json.dumps(journal,sort_keys=True).encode())

def file_digest(path):
    data=secure_file(path,True)
    return None if data is None else hashlib.sha256(data).hexdigest()

def record_expected(folder,journal):
    journal['expected']={path:file_digest(pathlib.Path(path)) for path in journal['backups']}
    save_journal(folder,journal)

def owned_unchanged(journal):
    for path,digest in journal['expected'].items():
        if file_digest(pathlib.Path(path))!=digest: raise ValueError('Configuration changed outside this transaction; automatic overwrite was refused')

def reload_ssh(socket_active):
    checked(['/usr/sbin/sshd','-t'])
    if socket_active:
        checked(['systemctl','daemon-reload'])
        checked(['systemctl','stop','ssh.service'])
        checked(['systemctl','restart','ssh.socket'])
        checked(['systemctl','start','ssh.service'])
    else: checked(['systemctl','reload','ssh.service'])

def recover_security(folder):
    lock=os.open(SECURITY_ROOT/'operation.lock',os.O_RDWR|os.O_NOFOLLOW)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX)
        return recover_security_locked(folder)
    finally: os.close(lock)

def recover_security_locked(folder):
    journal=json.loads(secure_file(folder/'journal.json'))
    if journal['state'] in ('committed','rolled-back'): return
    owned_unchanged(journal)
    for path,entry in journal['backups'].items():
        target=pathlib.Path(path)
        if entry is None:
            if os.path.lexists(target): target.unlink()
        else: atomic_file(target,base64.b64decode(entry['data']),entry['mode'])
    reload_ssh(journal['socketActive'])
    if journal['firewallChanged']:
        if journal['ufwActive']: checked(['ufw','reload'])
        else: checked(['ufw','--force','disable'])
    journal['state']='rolled-back';save_journal(folder,journal)
    checked(['systemctl','disable','--now',journal['unit']+'.timer'])

def wait_verification(phase):
    print(json.dumps({'verify':phase}),flush=True)
    selector=selectors.DefaultSelector();selector.register(sys.stdin,selectors.EVENT_READ)
    try:
        if not selector.select(75): raise ValueError('Independent access verification timed out; recovery remains armed')
        message=json.loads(sys.stdin.readline(1025))
        if message!={'continue':phase}: raise ValueError('Independent access verification failed; recovery remains armed')
    finally: selector.close()

def apply_security(r):
    preflight_security(r)
    lock=os.open(SECURITY_ROOT/'operation.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('Another access transaction is already running')
        # Recheck after obtaining the exclusive application transaction lock.
        if r['snapshot']!=security_snapshot(): raise ValueError('Configuration changed before applying')
        intent=r['security'];ident=os.urandom(16).hex();folder=SECURITY_ROOT/ident;folder.mkdir(mode=0o700)
        unit='vps-pilot-recover-'+ident
        socket_active=subprocess.run(['systemctl','is-active','--quiet','ssh.socket'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
        files=configuration_files();backups={}
        for path in files:
            data=secure_file(path,True);backups[str(path)]=None if data is None else {'data':base64.b64encode(data).decode(),'mode':stat.S_IMODE(path.stat().st_mode)}
        ufw_active=b'Status: active' in checked(['ufw','status']) if intent.get('configureFirewall') else False
        journal={'state':'armed','backups':backups,'expected':{},'socketActive':socket_active,'firewallChanged':intent.get('configureFirewall',False),'ufwActive':ufw_active,'unit':unit}
        record_expected(folder,journal)
        # Recovery includes the fixed adapter, never source supplied by the UI.
        recovery_code=USER_CODE+'\n'+STACK_CODE+'\n'+SECURITY_CODE+'\ntry:\n recover_security(pathlib.Path('+repr(str(folder))+'))\nexcept Exception:\n sys.exit(1)\n'
        atomic_file(folder/'recover.py',recovery_code.encode())
        service=pathlib.Path('/etc/systemd/system')/(unit+'.service');timer=pathlib.Path('/etc/systemd/system')/(unit+'.timer')
        if service.exists() or timer.exists(): raise ValueError('Recovery unit already exists')
        deadline=datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=r.get('recoverySeconds',300))
        atomic_file(service,('[Unit]\nDescription=VPS Pilot access recovery\nAfter=network.target\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 -I -S '+str(folder/'recover.py')+'\n').encode(),0o644)
        atomic_file(timer,('[Unit]\nDescription=VPS Pilot access recovery deadline\n[Timer]\nOnCalendar='+deadline.strftime('%Y-%m-%d %H:%M:%S UTC')+'\nPersistent=true\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n').encode(),0o644)
        checked(['systemctl','daemon-reload']);checked(['systemctl','enable','--now',unit+'.timer'])
        if checked(['systemctl','is-active',unit+'.timer']).strip()!=b'active': raise ValueError('Remote recovery timer could not be armed')
        if not os.path.islink('/etc/systemd/system/timers.target.wants/'+unit+'.timer'): raise ValueError('Recovery is not enabled across reboot')
        originals={path:None if value is None else base64.b64decode(value['data']).decode() for path,value in backups.items() if path.startswith('/etc/ssh/')}
        def write_ssh(final):
            owned_unchanged(journal)
            ports=[intent['port']] if final else sorted(set([r['currentPort'],intent['port']]))
            prefix=''.join('Port '+str(port)+'\n' for port in ports)
            if final:
                prefix+='PasswordAuthentication '+('yes' if intent['passwordLogin'] else 'no')+'\n'
                prefix+='KbdInteractiveAuthentication no\nAuthenticationMethods '+('any' if intent['passwordLogin'] else 'publickey')+'\n'
                prefix+='PermitRootLogin '+('prohibit-password' if intent['rootLogin'] else 'no')+'\n'
            for path,original in originals.items():
                clean='\n'.join('# VPS Pilot retained: '+line if re.match(r'^\s*Port\s+',line,re.I) else line for line in original.splitlines())+'\n'
                data=(prefix+clean if path==str(SSH_MAIN) else clean).encode()
                atomic_file(pathlib.Path(path),data,backups[path]['mode'])
            if socket_active:
                directory=SOCKET_OVERRIDE.parent
                if not directory.exists(): directory.mkdir(mode=0o755)
                atomic_file(SOCKET_OVERRIDE,('[Socket]\nListenStream=\n'+''.join('ListenStream='+str(port)+'\n' for port in ports)).encode(),0o644)
            record_expected(folder,journal)
            reload_ssh(socket_active)
            if socket_active:
                listeners=checked(['systemctl','show','ssh.socket','--property=Listen','--value']).decode()
                active_ports={int(value) for value in re.findall(r':(\d+)\s+\(Stream\)',listeners)}
                if active_ports!=set(ports): raise ValueError('Active SSH socket listeners did not match the approved ports')
            policy=effective_ssh(r,port=intent['port'])
            if set(policy['ports'])!=set(ports): raise ValueError('Effective SSH ports did not match the approved settings')
            if final and (policy.get('passwordauthentication')!=('yes' if intent['passwordLogin'] else 'no') or policy.get('authenticationmethods')!=('any' if intent['passwordLogin'] else 'publickey')): raise ValueError('Login policy could not be verified')
            if final and not intent['rootLogin'] and effective_ssh(r,user='root',port=intent['port']).get('permitrootlogin')!='no': raise ValueError('Root login policy could not be verified')
        if intent.get('configureFirewall'):
            owned_unchanged(journal)
            for port,protocol in [(r['currentPort'],'tcp'),(intent['port'],'tcp'),*[(rule['port'],rule['protocol']) for rule in r['rules']]]:
                checked(['ufw','allow',str(port)+'/'+protocol]);record_expected(folder,journal)
            checked(['ufw','default','deny','incoming']);record_expected(folder,journal)
            checked(['ufw','default','allow','outgoing']);record_expected(folder,journal)
            checked(['ufw','--force','enable']);record_expected(folder,journal)
        write_ssh(False);journal['state']='staged';save_journal(folder,journal)
        wait_verification('staged')
        write_ssh(True);journal['state']='final';save_journal(folder,journal)
        wait_verification('final')
        owned_unchanged(journal)
        # The old firewall allowance is retained: it may predate this operation.
        # The old SSH listener has been retired and proved inaccessible by policy.
        journal['state']='committed';save_journal(folder,journal)
        checked(['systemctl','disable','--now',unit+'.timer'])
        return [{'id':'ufw','status':'installed','message':'SSH access and settings verified','port':intent['port'],'recovery':str(folder),'ssh':effective_ssh(r,port=intent['port']),'rules':checked(['ufw','status','numbered']).decode() if shutil.which('ufw',path='/usr/sbin:/sbin:/usr/bin:/bin') else 'Not installed'}]
    finally: os.close(lock)
