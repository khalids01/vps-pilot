"""Private stdin/sudo transport, only in the disposable Linux fixture."""
import json,pathlib,runpy,secrets,subprocess
assert pathlib.Path('/.dockerenv').exists()
assert pathlib.Path('/tmp/vps-pilot-proxy-disposable').read_text()=='proxy-workspace-fixture'
root=pathlib.Path('/tmp')
worker=(root/'proxy_workspace.py').read_text()
protocol=(root/'proxy_privileged.py').read_text()
transport=(root/'proxy_transport.py').read_text()
script='WORKER = '+repr(worker)+'\nROOT_PROTOCOL = '+repr(protocol)+'\n'+transport
subprocess.run(['useradd','-m','proxyfixture'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
password=secrets.token_urlsafe(24)
subprocess.run(['chpasswd'],input='proxyfixture:'+password+'\n',text=True,check=True,stdout=subprocess.DEVNULL)
rule=pathlib.Path('/etc/sudoers.d/proxy-fixture')

def execute(secret):
    result=subprocess.run(['runuser','-u','proxyfixture','--','/usr/bin/python3','-I','-S','-u','-c',script],input=json.dumps({'operation':'inventory','password':secret})+'\n',text=True,capture_output=True,timeout=30)
    assert secret not in result.stdout if secret else True
    assert not result.stderr,result.stderr[:100]
    return json.loads(result.stdout)
try:
    rule.write_text('proxyfixture ALL=(root) NOPASSWD: /usr/bin/python3\n');rule.chmod(0o440)
    assert 'instances' in execute('')
    print('PASS real sudo NOPASSWD handshake sends only private JSON after worker readiness',flush=True)
    rule.write_text('proxyfixture ALL=(root) /usr/bin/python3\n')
    subprocess.run(['runuser','-u','proxyfixture','--','sudo','-k'],check=True)
    assert 'instances' in execute(password)
    print('PASS real prompted sudo handshake transmits password only on stdin',flush=True)
    subprocess.run(['runuser','-u','proxyfixture','--','sudo','-k'],check=True)
    assert 'valid password' in execute('fixture-wrong-password').get('error','')
    print('PASS rejected sudo password is bounded and never returned in output',flush=True)
finally:
    rule.unlink()
