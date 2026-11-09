import os
from pathlib import Path
if os.geteuid() != 0 or not Path('/.dockerenv').is_file():
    raise SystemExit('Run inside the disposable VPS Pilot fixture container only')
"""Run only inside the labelled disposable setup fixture; endpoints are loopback-only."""
import pathlib,json,contextlib,io
base=pathlib.Path('/source');ns={'USER_CODE':(base/'setup_user_tools.py').read_text(),'STACK_CODE':(base/'setup_stacks.py').read_text(),'SECURITY_CODE':(base/'setup_security.py').read_text()}
exec((base/'setup_packages_core.py').read_text(),ns)
for item in ['bun','uv','nvm-node','javascript-pm2','go','neovim','herdr','lazyvim-starter']:
 try:
  request=dict(action='prepare',items=[item],user='fixture')
  resolved=ns['run'](request)
  print('Resolved '+item+': '+', '.join(p.get('version','installed') for p in resolved['plan']['items'] if p['id']==item),flush=True)
  result=ns['run'](dict(request,action='install',plan=resolved['plan']))
  print(json.dumps(result),flush=True)
  if any(row['status']!='installed' for row in result['items']):raise RuntimeError('Installation verification failed')
  retry=ns['run'](dict(action='prepare',items=[item],user='fixture'))
  assert all(plan['skip'] for plan in retry['plan']['items']), 'Installed dependencies were not skipped'
  print('PASS '+item+' installed, independently checked and skipped on retry',flush=True)
 except Exception as error:
  print('FAIL '+item+': '+str(error),flush=True)
  raise
