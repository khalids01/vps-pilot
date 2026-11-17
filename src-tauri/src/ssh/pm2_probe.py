"""Read-only PM2 projection. Never returns process environment or raw jlist."""
import json,os,pathlib,subprocess,sys

def main():
    home=pathlib.Path.home()
    roots=[home/'.local/bin',home/'.npm-global/bin',pathlib.Path('/usr/local/bin'),pathlib.Path('/usr/bin')]
    roots+=sorted((home/'.nvm/versions/node').glob('*/bin'),reverse=True)
    candidates=[p/'pm2' for p in roots if (p/'pm2').is_file()]
    if not candidates: return {'installed':False,'processes':[]}
    pm2=candidates[0];env={**os.environ,'PATH':str(pm2.parent)+':'+':'.join(map(str,[p for p in roots if '.nvm/' in str(p)]+roots))+':/bin','NO_COLOR':'1'}
    # Avoid starting a PM2 daemon merely by inspecting an account.
    daemon=pathlib.Path(env.get('PM2_HOME',str(home/'.pm2')))
    if not (daemon/'rpc.sock').exists(): return {'installed':True,'processes':[]}
    result=subprocess.run([str(pm2),'jlist'],capture_output=True,env=env,timeout=20)
    if result.returncode or len(result.stdout)>4*1024*1024: raise ValueError('Cannot read PM2 processes')
    values=json.loads(result.stdout);rows=[]
    if len(sys.argv)>1:
        selected=next((v for v in values if v.get('pm_id')==int(sys.argv[1])),None)
        if selected is None: raise ValueError('Process disappeared')
        logs=[]
        for key in ('pm_out_log_path','pm_err_log_path'):
            path=pathlib.Path(selected.get('pm2_env',{}).get(key,''))
            try:
                import stat
                fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                try:
                    info=os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid(): continue
                    os.lseek(fd,max(0,info.st_size-32768),os.SEEK_SET)
                    logs.append(os.read(fd,32768).decode(errors='replace'))
                finally: os.close(fd)
            except OSError: continue
        return {'logs':'\n'.join(logs)}
    for item in values[:500]:
        config=item.get('pm2_env',{});monitor=item.get('monit',{})
        def text(v): return ''.join(c for c in str(v)[:256] if c.isprintable())
        rows.append(dict(id=item['pm_id'],name=text(item.get('name','')),status=text(config.get('status','unknown')),uptime=config.get('pm_uptime'),restarts=config.get('restart_time',0),cpu=monitor.get('cpu',0),memory=monitor.get('memory',0),folder=text(config.get('pm_cwd',''))))
    return {'installed':True,'processes':rows}
if __name__=='__main__':
    try: print(json.dumps(main()))
    except Exception: print(json.dumps({'error':'PM2 status unavailable for this account'}));sys.exit(1)
