import os
from pathlib import Path
if os.geteuid() != 0 or not Path('/.dockerenv').is_file():
    raise SystemExit('Run inside the disposable VPS Pilot fixture container only')
"""Run only inside the labelled disposable setup fixture; endpoints are loopback-only."""
import subprocess,json,pathlib,shlex,time,selectors,sys
BASE=pathlib.Path('/source')
user=(BASE/'setup_user_tools.py').read_text();stack=(BASE/'setup_stacks.py').read_text();security=(BASE/'setup_security.py').read_text();core=(BASE/'setup_packages_core.py').read_text()
bundle='USER_CODE='+repr(user)+'\nSTACK_CODE='+repr(stack)+'\nSECURITY_CODE='+repr(security)+'\n'+core
SSH=['ssh','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/fixture/known_hosts','-o','HostKeyAlias=[127.0.0.1]:2222','-o','BatchMode=yes','-o','ConnectTimeout=3','-i','/fixture/key']
def ssh(user,port,command,**kw):return subprocess.run([*SSH,'-p',str(port),user+'@127.0.0.1',command],stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kw)
assert ssh('root',2222,'test -f /root/vps-pilot-disposable-vm').returncode==0
print('Verified disposable VM marker',flush=True)
def start(seconds=30):
 r={'action':'security-apply','items':['ufw'],'user':'fixture','currentPort':22,'profilePort':22,'serverAddress':'10.0.2.15','clientAddress':'10.0.2.2','rules':[{'port':80,'protocol':'tcp'}],'security':{'port':52022,'passwordLogin':False,'rootLogin':False,'configureFirewall':True,'recoveryAcknowledged':True},'recoverySeconds':seconds}
 code=bundle+'\nr='+repr(r)+'\nr["snapshot"]=security_snapshot()\ntry:\n print(json.dumps({"items":run(r)}),flush=True)\nexcept Exception as e:\n print(json.dumps({"error":str(e)}),flush=True);sys.exit(1)'
 return subprocess.Popen([*SSH,'-p','2222','root@127.0.0.1','python3 -I -S -u -c '+shlex.quote(code)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def line(p,timeout=90):
 sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ)
 try:
  if not sel.select(timeout):raise RuntimeError('Timed out waiting for transaction result')
  text=p.stdout.readline()
  if not text:raise RuntimeError('Transaction ended without a result: '+p.stderr.read()[-1000:])
  value=json.loads(text);print(json.dumps(value),flush=True);return value
 finally:sel.close()

assert ssh('root',2222,'systemctl is-active ssh.socket').stdout.strip()==b'active'
p=start(45)
assert line(p)=={'verify':'staged'}
assert ssh('fixture',2223,'sudo -n id -u').stdout.strip()==b'0'
p.stdin.close();p.wait(timeout=10)
command="python3 -c 'import pathlib,json; assert all(json.loads(p.read_text())[\"state\"] in (\"committed\",\"rolled-back\") for p in pathlib.Path(\"/var/lib/vps-pilot/security\").glob(\"*/journal.json\"))'"
for i in range(80):
 if ssh('root',2222,command,timeout=8).returncode==0 and ssh('fixture',2223,'true').returncode!=0:break
 time.sleep(2)
else:raise RuntimeError('Socket recovery did not restore access')
assert ssh('root',2222,'systemctl is-active ssh.socket').stdout.strip()==b'active'
print('PASS: socket-activated access restored after transport loss',flush=True)
p=start(180)
assert line(p)=={'verify':'staged'}
assert ssh('fixture',2223,'sudo -n id -u').stdout.strip()==b'0'
p.stdin.write('{"continue":"staged"}\n');p.stdin.flush()
assert line(p)=={'verify':'final'}
assert ssh('fixture',2223,'sudo -n id -u').stdout.strip()==b'0'
p.stdin.write('{"continue":"final"}\n');p.stdin.flush()
assert line(p)['items'][0]['status']=='installed'
p.wait(timeout=10);assert p.returncode==0
assert ssh('fixture',2222,'true').returncode!=0
assert ssh('root',2223,'true').returncode!=0
print('PASS: socket-activated SSH migrated and independently verified',flush=True)
