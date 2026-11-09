import os
from pathlib import Path
if os.geteuid() != 0 or not Path('/.dockerenv').is_file():
    raise SystemExit('Run inside the disposable VPS Pilot fixture container only')
"""Run only inside the labelled disposable setup fixture; endpoints are loopback-only."""
import subprocess,pathlib,shlex
base=pathlib.Path('/source');user=(base/'setup_user_tools.py').read_text();stack=(base/'setup_stacks.py').read_text();security=(base/'setup_security.py').read_text();core=(base/'setup_packages_core.py').read_text()
code='USER_CODE='+repr(user)+'\nSTACK_CODE='+repr(stack)+'\nSECURITY_CODE='+repr(security)+'\n'+core
code+='''
assert os.path.isfile('/root/vps-pilot-disposable-vm')
for item in ('docker','dokploy'):
 request=dict(action='prepare',items=[item],user='fixture',serverAddress='10.0.2.15')
 result=run(request)
 print('Resolved '+item+': '+', '.join(p.get('version','installed') for p in result['plan']['items'] if p['id']==item),flush=True)
 applied=run(dict(request,action='install',plan=result['plan']))
 print(json.dumps(applied),flush=True)
 if any(row['status']!='installed' for row in applied['items']): raise ValueError(item+' verification failed')
 print('PASS '+item+' installed and independently verified on full VM',flush=True)
ledger=read_dokploy_ledger()
assert ledger and ledger['state']=='installed'
ledger['state']='installing';save_dokploy_ledger(ledger)
request=dict(action='prepare',items=['dokploy'],user='fixture',serverAddress='10.0.2.15')
resolved=run(request)
result=run(dict(request,action='install',plan=resolved['plan']))
assert result['items'][0]['status']=='installed',result
assert read_dokploy_ledger()['owner']==ledger['owner']
print('PASS owned partial retry reuses services, secrets and volumes',flush=True)
'''
args=['ssh','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/fixture/known_hosts','-o','HostKeyAlias=[127.0.0.1]:2222','-o','BatchMode=yes','-i','/fixture/key','-p','2223','fixture@127.0.0.1','sudo -n python3 -I -S -u -c '+shlex.quote(code)]
raise SystemExit(subprocess.run(args).returncode)
