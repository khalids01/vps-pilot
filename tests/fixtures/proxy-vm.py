import os,pathlib,subprocess,shlex,json,time
assert os.geteuid()==0 and pathlib.Path('/.dockerenv').exists()
SSH=['ssh','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/fixture/known_hosts','-o','BatchMode=yes','-o','ConnectTimeout=5','-i','/fixture/key','-p','2222','root@127.0.0.1']
def ssh(command,**kw):return subprocess.run([*SSH,command],text=True,capture_output=True,**kw)
assert ssh('test -f /root/vps-pilot-disposable-vm').returncode==0
install=ssh('DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy',timeout=300)
assert install.returncode==0,install.stderr[-1000:]
code=pathlib.Path('/fixture/proxy.py').read_text()
def action(operation,snapshot='',user='root'):
 script=code.replace('json.loads(sys.stdin.readline(8193))','json.loads(sys.argv[1])')
 command='python3 -I -S -c '+shlex.quote(script)+' '+shlex.quote(json.dumps(dict(manager='caddy',operation=operation,snapshot=snapshot)))
 if user!='root':command='runuser -u '+user+' -- '+command
 result=ssh(command,timeout=100)
 try:value=json.loads(result.stdout)
 except Exception:raise RuntimeError(result.stderr[-1000:])
 print(operation,json.dumps(value),flush=True);return result,value
# Configure only the explicitly disposable fixture. Backup file must remain unchanged.
setup="mkdir -p /srv/caddy-fixture && printf before > /srv/caddy-fixture/index.html && printf 'http://127.0.0.1:8097 {\\n root * /srv/caddy-fixture\\n file_server\\n}\\n' > /etc/caddy/Caddyfile && printf untouched > /etc/caddy/Caddyfile.save && chmod 600 /etc/caddy/Caddyfile.save && systemctl restart caddy"
r=ssh(setup,timeout=90);assert r.returncode==0,r.stderr
r,status=action('detect');assert status.get('supported'),status
r,unpriv=action('detect',user='fixture');assert unpriv.get('snapshot')==status['snapshot'],unpriv
before=ssh('systemctl show --value -p InvocationID caddy').stdout.strip()
r,reloaded=action('reload',status['snapshot']);assert r.returncode==0,reloaded
assert ssh('systemctl show --value -p InvocationID caddy').stdout.strip()==before
assert ssh('curl -fsS http://127.0.0.1:8097/').stdout=='before'
print('PASS real Caddy reload preserves invocation and serves static content',flush=True)
ssh('printf after > /srv/caddy-fixture/index.html');assert ssh('curl -fsS http://127.0.0.1:8097/').stdout=='after'
print('PASS static build update visible without service reload',flush=True)
r,status=action('detect');r,value=action('restart',status['snapshot']);assert r.returncode==0,value
assert ssh('systemctl show --value -p InvocationID caddy').stdout.strip()!=before
print('PASS real Caddy restart changes invocation and returns active',flush=True)
# Invalid config remains on disk for validation; running config must continue serving.
ssh("printf 'not_a_valid_directive {\\n' > /etc/caddy/Caddyfile")
r,status=action('detect');before=ssh('systemctl show --value -p InvocationID caddy').stdout.strip()
r,value=action('reload',status['snapshot']);assert r.returncode!=0 and 'validation failed' in value.get('error',''),value
assert ssh('systemctl show --value -p InvocationID caddy').stdout.strip()==before
assert ssh('curl -fsS http://127.0.0.1:8097/').stdout=='after'
assert ssh('cat /etc/caddy/Caddyfile.save').stdout=='untouched'
print('PASS invalid config rejected; live service, static site and backup preserved',flush=True)
