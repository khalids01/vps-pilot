"""Run only in an app-created Docker-in-Docker fixture; never on a VPS daemon."""
import pathlib,runpy,os,json,urllib.request,subprocess,urllib.error
assert os.geteuid()==0 and pathlib.Path('/.dockerenv').exists()
assert pathlib.Path('/tmp/vps-pilot-proxy-disposable').read_text()=='proxy-workspace-fixture'
m=runpy.run_path('/tmp/proxy_workspace.py')
image='vps-pilot-proxy-fixture:local'
def docker(*args):return m['run'](['docker',*args])
def request(i,operation,**kw):return dict(instanceId=i['id'],identity=i['identity'],operation=operation,**kw)
def http(ident,port):
    ip=docker('inspect','--format','{{ (index .NetworkSettings.Networks "bridge").IPAddress }}',ident).strip()
    try:return urllib.request.urlopen('http://'+ip+':'+str(port),timeout=3).read().decode()
    except urllib.error.HTTPError as e:return str(e.code)

for manager,port in [('caddy',8091),('nginx',8092),('traefik',8093)]:
    root=pathlib.Path('/var/apps/proxy-fixture')/manager;root.mkdir(parents=True,exist_ok=True)
    file=root/('Caddyfile' if manager=='caddy' else 'nginx.conf' if manager=='nginx' else 'traefik.yml')
    content='http://:8091 {\n respond "caddy before"\n}\n' if manager=='caddy' else 'events {}\nhttp { server { listen 8092; location / { return 200 "nginx before"; } } }\n' if manager=='nginx' else 'entryPoints:\n  web:\n    address: ":8093"\n'
    file.write_text(content);file.chmod(0o644)
    args=['caddy','run','--config','/etc/caddy/Caddyfile'] if manager=='caddy' else ['/usr/sbin/nginx','-g','daemon off;'] if manager=='nginx' else ['traefik','--configFile=/etc/traefik/traefik.yml']
    name='fixture-proxy-'+manager
    ident=docker('run','-d','--name',name,'--label','vps-pilot.fixture=proxy-workspace','--mount','type=bind,src='+str(root)+',dst=/etc/'+manager+',readonly',image,*args).strip()
    import time;time.sleep(.7)
    try:
        instance=next(i for i in m['inventory']()['instances'] if i['id']=='docker:'+ident)
        assert instance['editable'] and instance['actions'],instance
        opened=m['main'](request(instance,'open'));original=next(f for f in opened['files'] if f['path']==str(file))
        if manager!='traefik':
            try:m['main'](request(instance,'save',path=str(file),content='invalid_directive here;\n',revision=original['revision'],treeRevision=opened['treeRevision']));raise AssertionError('invalid candidate accepted')
            except ValueError:pass
            assert file.read_text()==content and 'before' in http(ident,port)
        candidate=content.replace('before','after') if manager!='traefik' else content.replace(':8093',':8094')
        saved=m['main'](request(instance,'save',path=str(file),content=candidate,revision=original['revision'],treeRevision=opened['treeRevision'],acknowledgeTraefik=manager=='traefik'))
        assert file.read_text()==candidate
        assert ('after' in http(ident,port)) if manager!='traefik' else http(ident,8094)=='404'
        instance=saved['instance'];m['main'](request(instance,'restore',backupId=saved['backupId'],path=str(file)))
        m['main'](request(instance,'restart' if manager=='traefik' else 'reload'))
        assert file.read_text()==content
        assert ('before' in http(ident,port)) if manager!='traefik' else http(ident,port)=='404'
        print('PASS real Docker '+manager+': exact bind source, isolated candidate validation/apply, backup, restore, lifecycle and HTTP result',flush=True)
    finally:
        assert docker('inspect','--format','{{ index .Config.Labels "vps-pilot.fixture" }}',ident).strip()=='proxy-workspace'
        docker('rm','-f',ident)
