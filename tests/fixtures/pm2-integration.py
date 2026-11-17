import json,subprocess,os,pathlib,time,signal
assert pathlib.Path('/.dockerenv').exists() and os.geteuid()!=0
root=pathlib.Path('/home/node/app');root.mkdir(exist_ok=True)
(root/'server.js').write_text('setInterval(()=>console.log("fixture alive"),1000)')
env={**os.environ,'HOME':'/home/node'}
def pm2(*args):return subprocess.run(['pm2',*args],env=env,capture_output=True,check=True)
def state():return json.loads(pm2('jlist').stdout)[0]
pm2('start',str(root/'server.js'),'--name','fixture','--cwd',str(root))
time.sleep(2)
probe=subprocess.run(['python3','-I','-S','/source/pm2_probe.py'],capture_output=True,env=env,check=True)
rows=json.loads(probe.stdout)['processes'];assert rows[0]['name']=='fixture' and 'env' not in rows[0]
r=dict(folder=str(root),process=rows[0]['id'],name='fixture',cwd=str(root),steps=['printf one > first','printf two > second'])
def run(request):return subprocess.run(['python3','-I','-S','-u','/source/pm2_run.py'],input=json.dumps(request)+'\n',text=True,capture_output=True,env=env,timeout=60)
before=state()['pm2_env']['restart_time'];result=run(r);assert result.returncode==0,result.stderr;assert (root/'second').read_text()=='two';assert state()['pm2_env']['restart_time']==before+1
print('PASS real PM2 inventory, ordered deployment, restart and online verification')
before=state()['pm2_env']['restart_time'];failed=run(dict(r,steps=['exit 17','touch must-not-run']));assert failed.returncode!=0;assert not(root/'must-not-run').exists();assert state()['pm2_env']['restart_time']==before
print('PASS failed command stops later steps and restart')
helper=run(dict(r,steps=['touch helper-only'],restart=False));assert helper.returncode==0 and (root/'helper-only').exists();assert state()['pm2_env']['restart_time']==before
print('PASS helper commands do not restart PM2')
changed=run(dict(r,name='changed',steps=['touch wrong-target']));assert changed.returncode!=0 and not(root/'wrong-target').exists()
print('PASS changed process identity rejected before commands')
logs=subprocess.run(['python3','-I','-S','/source/pm2_probe.py',str(r['process'])],env=env,capture_output=True,check=True);assert 'fixture alive' in json.loads(logs.stdout)['logs']
print('PASS bounded recent logs')
p=subprocess.Popen(['python3','-I','-S','-u','/source/pm2_run.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
p.stdin.write(json.dumps(dict(r,steps=['sleep 30; touch after-cancel']))+'\n');p.stdin.flush();assert json.loads(p.stdout.readline())['status']=='running';p.send_signal(signal.SIGTERM);p.wait(timeout=8);assert not(root/'after-cancel').exists()
print('PASS interrupted command group stops')
pm2('delete','fixture');pm2('kill')
