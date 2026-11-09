import os,pathlib,subprocess,json,shlex,selectors
assert os.geteuid()==0 and pathlib.Path('/.dockerenv').exists()
b=pathlib.Path('/source')
core=''.join(name+'='+repr((b/file).read_text())+'\n' for name,file in [('USER_CODE','setup_user_tools.py'),('STACK_CODE','setup_stacks.py'),('SECURITY_CODE','setup_security.py')])+(b/'setup_packages_core.py').read_text()
code='CORE='+repr(core)+'\nexec(CORE)\n'+(b/'setup_packages.py').read_text()
ssh=['ssh','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/fixture/known_hosts','-o','HostKeyAlias=[127.0.0.1]:2222','-o','BatchMode=yes','-i','/fixture/key','-p','2223','fixture@127.0.0.1']
assert subprocess.run(ssh+['sudo -n test -f /root/vps-pilot-disposable-vm']).returncode==0
command='/usr/bin/python3 -I -S -u -c '+shlex.quote(code)
r=dict(action='firewall-status',items=['ufw'],user='fixture',profilePort=52022,rules=[],sudoPassword='')
result=subprocess.run(ssh+[command],input=json.dumps(r)+'\n',text=True,capture_output=True,timeout=90)
print(result.stdout,flush=True);assert result.returncode==0,result.stderr
status=json.loads(result.stdout)
r.update(action='security-apply',snapshot=status['items'][0]['snapshot'],security=dict(port=52022,passwordLogin=False,rootLogin=False,configureFirewall=False,recoveryAcknowledged=True))
p=subprocess.Popen(ssh+[command],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
p.stdin.write(json.dumps(r)+'\n');p.stdin.flush()
for phase in ['staged','final']:
 sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);assert sel.select(100),'Checkpoint timeout';sel.close()
 line=p.stdout.readline();print(line,flush=True);assert json.loads(line)=={'verify':phase}
 check=subprocess.run(ssh+['sudo -n id -u'],capture_output=True,timeout=15);assert check.returncode==0 and check.stdout.strip()==b'0'
 p.stdin.write(json.dumps({'continue':phase})+'\n');p.stdin.flush()
line=p.stdout.readline();print(line,flush=True);assert json.loads(line)['items'][0]['status']=='installed'
p.stdin.close();assert p.wait(timeout=15)==0
print('PASS privileged wrapper, repeated socket policy and both checkpoints',flush=True)
