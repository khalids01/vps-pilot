"""No service changes: fixed proxy policy tests with controlled evidence."""
import runpy,pathlib,tempfile,unittest,json,io,types
from unittest.mock import patch
BASE=pathlib.Path(__file__).resolve().parents[2]/'src-tauri/src/ssh/proxy.py'
class ProxyTests(unittest.TestCase):
 def ns(self):
  value=runpy.run_path(str(BASE));return value['detect'].__globals__
 def props(self,**changes):
  p=dict(Id='caddy.service',LoadState='loaded',ActiveState='active',User='caddy',FragmentPath='/usr/lib/systemd/system/caddy.service',DropInPaths='',Environment='',EnvironmentFiles='',NeedDaemonReload='no',InvocationID='nonce',Job='',ExecStart='{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile ; }',ExecReload='{ argv[]=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force ; }');p.update(changes);return '\n'.join(k+'='+v for k,v in p.items())
 def test_missing_service_is_not_manageable(self):
  ns=self.ns();ns['command']=lambda args:self.props(LoadState='not-found');self.assertFalse(ns['detect']()['installed'])
 def test_custom_hooks_and_environment_block_changes(self):
  for changes in [dict(ExecStartPre='custom'),dict(DropInPaths='/etc/override'),dict(Environment='CUSTOM=value'),dict(Job='4'),dict(User='root'),dict(BoundBy='important.service'),dict(OnFailure='recovery.service')]:
   ns=self.ns();ns['command']=lambda args:self.props(**changes);self.assertFalse(ns['detect']()['supported'])
 def test_resume_and_other_executables_are_refused(self):
  for start in ['/usr/bin/caddy run --resume','/tmp/caddy run --config /etc/caddy/Caddyfile','/usr/bin/caddy run --config /tmp/Caddyfile']:
   ns=self.ns();ns['command']=lambda args:self.props(ExecStart='{ argv[]='+start+' ; }');self.assertFalse(ns['detect']()['supported'])
 def test_reload_command_must_match_actual_configuration(self):
  ns=self.ns();ns['command']=lambda args:self.props(ExecReload='{ argv[]=/usr/bin/caddy reload --config /etc/caddy/other ; }');self.assertFalse(ns['detect']()['supported'])
 def test_unsupported_operation_never_runs_commands(self):
  ns=self.ns();ns['command']=lambda *args:(_ for _ in ()).throw(AssertionError('executed'))
  with patch.object(ns['sys'],'stdin',io.StringIO(json.dumps(dict(manager='nginx',operation='restart')))):
   with self.assertRaises(ValueError):ns['main']()
 def mutate(self,ns,request):
  with tempfile.TemporaryDirectory() as root:
   fd=ns['os'].open(root+'/lock',ns['os'].O_CREAT|ns['os'].O_RDWR,0o600)
   try:
    with patch.object(ns['sys'],'stdin',io.StringIO(json.dumps(request))),patch.object(ns['os'],'geteuid',return_value=0),patch.object(ns['os'],'open',return_value=fd),patch.object(ns['os'],'fstat',return_value=types.SimpleNamespace(st_mode=0o100600,st_uid=0,st_nlink=1)):return ns['main']()
   finally:ns['os'].close(fd)
 def test_stale_review_never_validates_or_reloads(self):
  ns=self.ns();ns['detect']=lambda:dict(supported=True,snapshot='new');ns['command']=lambda *a:(_ for _ in ()).throw(AssertionError('executed'))
  with self.assertRaisesRegex(ValueError,'changed'):self.mutate(ns,dict(manager='caddy',operation='reload',snapshot='old'))
 def test_invalid_config_stops_before_reload(self):
  ns=self.ns();ns['detect']=lambda:dict(supported=True,snapshot='same',config='/etc/caddy/Caddyfile',adapter='caddyfile',invocation='original');calls=[]
  def execute(args,*unused):calls.append(args);raise ValueError('invalid')
  ns['command']=execute
  with self.assertRaisesRegex(ValueError,'validation failed'):self.mutate(ns,dict(manager='caddy',operation='reload',snapshot='same'))
  self.assertEqual(len(calls),1);self.assertEqual(calls[0][:4],['/usr/sbin/runuser','-u','caddy','--'])
if __name__=='__main__':unittest.main()
