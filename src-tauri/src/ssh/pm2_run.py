"""Explicitly reviewed user commands. Private request on stdin; output stays transient."""
import json,os,pathlib,signal,subprocess,sys,time

def main():
    def interrupted(*unused): raise RuntimeError('Deployment interrupted')
    for sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT): signal.signal(sig,interrupted)
    r=json.loads(sys.stdin.readline(65537))
    folder=pathlib.Path(r['folder']).resolve(strict=True)
    if not folder.is_dir() or str(folder)=='/': raise ValueError('Choose a project directory')
    home=pathlib.Path.home();roots=[home/'.local/bin',home/'.bun/bin',home/'.npm-global/bin',pathlib.Path('/usr/local/bin'),pathlib.Path('/usr/bin')]+sorted((home/'.nvm/versions/node').glob('*/bin'),reverse=True)
    env={**os.environ,'PATH':':'.join(map(str,[p for p in roots if '.nvm/' in str(p)]+roots))+':/bin','NO_COLOR':'1','GIT_TERMINAL_PROMPT':'0'}
    pm2=next((str(p/'pm2') for p in roots if (p/'pm2').is_file()),None)
    if not pm2: raise ValueError('PM2 unavailable')
    if not pathlib.Path(env.get('PM2_HOME',str(home/'.pm2')),'rpc.sock').exists(): raise ValueError('PM2 daemon is not running')
    def emit(v): print(json.dumps(v),flush=True)
    def processes():
     p=subprocess.run([pm2,'jlist'],capture_output=True,env=env,timeout=20)
     if p.returncode or len(p.stdout)>4*1024*1024: raise ValueError('Cannot inspect PM2')
     return json.loads(p.stdout)
    import fcntl,stat
    lockpath=pathlib.Path(env.get('PM2_HOME',str(home/'.pm2')))/'vps-pilot-deploy.lock'
    lock=os.open(lockpath,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    info=os.fstat(lock)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_nlink!=1 or info.st_mode&0o077:raise ValueError('Unsafe deployment lock')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    original=next((p for p in processes() if p.get('pm_id')==r['process']),None)
    if not original or original.get('name')!=r['name'] or original.get('pm2_env',{}).get('pm_cwd')!=r['cwd']: raise ValueError('PM2 process changed; refresh')
    for index,command in enumerate(r['steps']):
     emit({'step':index,'status':'running'})
     p=subprocess.Popen(['/bin/bash','-c',command],cwd=folder,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
     try:
      import selectors
      sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);deadline=time.monotonic()+900;size=0
      while sel.get_map():
       if time.monotonic()>deadline:raise TimeoutError()
       for key,_ in sel.select(1):
        data=os.read(key.fileobj.fileno(),4096)
        if not data:sel.unregister(key.fileobj);continue
        size+=len(data)
        if size>1024*1024:raise ValueError('Command output exceeded its limit')
        emit({'step':index,'status':'output','text':data.decode(errors='replace')})
      code=p.wait(timeout=5)
      emit({'step':index,'status':'succeeded' if code==0 else 'failed','code':code})
      if code:sys.exit(1)
     finally:
      sel.close()
      if p.poll() is None:
       os.killpg(p.pid,signal.SIGTERM)
       try:p.wait(timeout=3)
       except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
    if not r.get('restart',True):
        emit({'status':'succeeded'});return
    # Restart the exact selected process only after every command succeeds.
    current=next((p for p in processes() if p.get('pm_id')==r['process']),None)
    if not current or current.get('name')!=r['name'] or current.get('pm2_env',{}).get('pm_cwd')!=r['cwd']:raise ValueError('Process changed; restart skipped')
    p=subprocess.run([pm2,'restart',str(r['process'])],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=env,timeout=45)
    if p.returncode:raise ValueError('PM2 restart failed')
    for _ in range(10):
     time.sleep(1);current=next((p for p in processes() if p.get('pm_id')==r['process']),None)
     if current and current.get('pm2_env',{}).get('status')=='online':emit({'status':'succeeded'});break
    else:raise ValueError('PM2 process is not online')

if __name__=='__main__':
    try: main()
    except Exception as error:
        allowed={'Choose a project directory','PM2 unavailable','PM2 daemon is not running','Cannot inspect PM2','PM2 process changed; refresh','Unsafe deployment lock','Command output exceeded its limit','Process changed; restart skipped','PM2 restart failed','PM2 process is not online','Deployment interrupted'}
        message=str(error) if isinstance(error,(ValueError,RuntimeError)) and str(error) in allowed else 'Deployment interrupted or unavailable; inspect the server before retrying'
        print(json.dumps({'status':'failed','message':message}),flush=True)
        sys.exit(1)
