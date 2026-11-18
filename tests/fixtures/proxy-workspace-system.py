"""Run ONLY inside an app-created disposable systemd container, never on a VPS."""
import pathlib,runpy,urllib.request,urllib.error,os,json
assert os.geteuid()==0 and pathlib.Path('/.dockerenv').exists()
assert pathlib.Path('/tmp/vps-pilot-proxy-disposable').read_text()=='proxy-workspace-fixture'
m=runpy.run_path('/tmp/proxy_workspace.py')
def instance(manager):
    value=next(i for i in m['inventory']()['instances'] if i['id']=='system:'+manager)
    assert value['editable'] and value['actions'],value
    return value

def http(port):
    try:return urllib.request.urlopen('http://127.0.0.1:'+str(port),timeout=3).read().decode()
    except urllib.error.HTTPError as e:return str(e.code)

def request(i,operation,**kw):return dict(instanceId=i['id'],identity=i['identity'],operation=operation,**kw)

for manager,port in [('caddy',8091),('nginx',8092),('traefik',8093)]:
    i=instance(manager);opened=m['main'](request(i,'open'));path=i['config'];file=next(f for f in opened['files'] if f['path']==path)
    original=file['content'];candidate=original.replace('before','after') if manager!='traefik' else original.replace(':8093',':8094')
    args=dict(path=path,content=candidate,revision=file['revision'],treeRevision=opened['treeRevision'],acknowledgeTraefik=manager=='traefik')
    if manager!='traefik':
        try:m['main'](request(i,'save',**{**args,'content':'invalid_directive here;\n'}));raise AssertionError('invalid candidate accepted')
        except ValueError:pass
        assert pathlib.Path(path).read_text()==original
        assert 'before' in http(port)
    saved=m['main'](request(i,'save',**args));i=saved['instance'];assert pathlib.Path(path).read_text()==candidate
    if manager!='traefik':assert 'after' in http(port)
    else:assert http(8094)=='404'
    try:m['main'](request(i,'save',**args));raise AssertionError('stale revision accepted')
    except ValueError as e:assert 'changed' in str(e)
    m['main'](request(i,'restore',backupId=saved['backupId'],path=path));assert pathlib.Path(path).read_text()==original
    m['main'](request(i,'restart' if manager=='traefik' else 'reload'))
    assert ('before' in http(port)) if manager!='traefik' else http(port)=='404'
    i=instance(manager);m['main'](request(i,'logs'))
    print('PASS real system '+manager+': read, private candidate validation/apply, stale rejection, protected backup, restore and lifecycle',flush=True)

# Failed Traefik startup restores its file, then the same page can detect and recover the stopped service.
i=instance('traefik');opened=m['main'](request(i,'open'));file=next(f for f in opened['files'] if f['path']==i['config'])
try:
    m['main'](request(i,'save',path=file['path'],content=': invalid: yaml: [',revision=file['revision'],treeRevision=opened['treeRevision'],acknowledgeTraefik=True))
    raise AssertionError('invalid startup accepted')
except ValueError as e:assert 'Previous file restored' in str(e),str(e)
assert pathlib.Path(file['path']).read_text()==file['content']
i=instance('traefik');m['main'](request(i,'restart'))
print('PASS failed Traefik startup restores source and supports reviewed stopped-service recovery',flush=True)
