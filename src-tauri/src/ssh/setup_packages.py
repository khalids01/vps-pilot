"""Private stdin sudo protocol; only structured, bounded results leave the adapter."""
ROOT = """print('VPS_PACKAGES_READY',flush=True)
r=json.loads(sys.stdin.readline(131073))
try:
 import signal,fcntl,stat
 def expired(*unused): os.killpg(os.getpgrp(),signal.SIGTERM)
 signal.signal(signal.SIGALRM,expired);signal.alarm(1700)
 operation_lock=None
 if r['action'] in ('install','security-apply'):
  root_directory(pathlib.Path('/var/lib/vps-pilot'))
  operation_lock=os.open('/var/lib/vps-pilot/provisioning.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
  metadata=os.fstat(operation_lock)
  if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid!=0 or metadata.st_nlink!=1 or metadata.st_mode&0o077: raise ValueError('Unsafe provisioning lock')
  try: fcntl.flock(operation_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError: raise ValueError('Another setup operation is still running on this server')
 result=run(r)
 print(json.dumps(result if isinstance(result,dict) else {'items':result}),flush=True)
except Exception as error:
 print(json.dumps({'error':setup_error(error)}),flush=True)
 sys.exit(1)
"""


def main():
    line=sys.stdin.readline(131073)
    if len(line)>131072: raise ValueError('Setup request exceeds its limit')
    r=json.loads(line);validate(r)
    connection=os.environ.get('SSH_CONNECTION','').split()
    if len(connection)==4:
        import ipaddress
        try:
            ipaddress.ip_address(connection[0]);ipaddress.ip_address(connection[2]);port=int(connection[3])
            if not 1<=port<=65535: raise ValueError('Invalid connected SSH port')
            r['currentPort']=port;r['clientAddress']=connection[0];r['serverAddress']=connection[2]
        except (ValueError,TypeError): raise ValueError('Cannot establish the connected SSH endpoint')
    password=r.pop('sudoPassword','')
    if not isinstance(password,str) or len(password)>4096 or any(c in password for c in '\r\n\0'): raise ValueError('Invalid sudo password')
    if r['action'] in ('scan','prepare'):
        result=run(r)
        print(json.dumps(result if isinstance(result,dict) else {'items':result}),flush=True)
        return
    code=CORE+ROOT
    command=['/usr/bin/python3','-I','-S','-u','-c',code]
    if os.geteuid()!=0: command=['/usr/bin/sudo','-S','-k','-p','VPS_PACKAGE_PASSWORD:', '--',*command]
    child=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ,'out');selector.register(child.stderr,selectors.EVENT_READ,'err')
    out=b'';err=b'';sent=False;ready=False;total=0;tail=b'';has_result=False;deadline=time.monotonic()+45
    try:
        while time.monotonic()<deadline:
            for key,_ in selector.select(1):
                chunk=os.read(key.fileobj.fileno(),4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    if key.data=='input': child.stdin.close()
                    continue
                if key.data=='input':
                    if not chunk: selector.unregister(sys.stdin);child.stdin.close()
                    else: child.stdin.write(chunk);child.stdin.flush()
                    continue
                if key.data=='err':
                    err=(err+chunk)[-8192:]
                    if not ready and b'VPS_PACKAGE_PASSWORD:' in err:
                        if sent: raise ValueError('Sudo authentication failed')
                        child.stdin.write((password+'\n').encode());child.stdin.flush();password='';sent=True;err=b''
                else:
                    if not ready:
                        out+=chunk
                        if len(out)>4096: raise ValueError('Invalid sudo handshake')
                        if b'VPS_PACKAGES_READY\n' not in out: continue
                        password='';ready=True;deadline=time.monotonic()+1800
                        child.stdin.write((json.dumps(r)+'\n').encode());child.stdin.flush()
                        if r['action']=='security-apply': selector.register(sys.stdin,selectors.EVENT_READ,'input')
                        else: child.stdin.close()
                        chunk=out.split(b'VPS_PACKAGES_READY\n',1)[1];out=b''
                    tail=(tail+chunk)[-4096:]
                    has_result=has_result or b'\"items\":' in tail or b'\"error\":' in tail
                    total+=len(chunk)
                    if total>131072: raise ValueError('Setup output exceeds its limit')
                    sys.stdout.buffer.write(chunk);sys.stdout.flush()
            if child.poll() is not None and not any(key.data in ('out','err') for key in selector.get_map().values()):
                if not ready: raise ValueError('Sudo authentication failed')
                if child.returncode:
                    if not has_result: print(json.dumps({'error':'Setup worker stopped; check installed before retrying'}),flush=True)
                    sys.exit(1)
                return
        raise ValueError('Setup timed out; check installed before retrying')
    finally:
        password='';selector.close()
        if child.poll() is None:
            import signal
            try:
                os.killpg(child.pid,signal.SIGTERM)
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL);child.wait()
            except (PermissionError,ProcessLookupError): pass

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'error':setup_error(error)}),flush=True)
        sys.exit(1)
