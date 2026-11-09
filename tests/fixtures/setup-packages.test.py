"""Package protocol tests. No host installs, service changes, or user-home writes."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import tarfile
import types
import unittest
from unittest.mock import patch

BASE=Path(__file__).resolve().parents[2]/'src-tauri/src/ssh'
CORE=(BASE/'setup_packages_core.py').read_text()
USER=(BASE/'setup_user_tools.py').read_text()
STACK=(BASE/'setup_stacks.py').read_text()
SECURITY=(BASE/'setup_security.py').read_text()
WRAPPER=(BASE/'setup_packages.py').read_text()

def namespace():
    value={'USER_CODE':USER,'STACK_CODE':STACK,'SECURITY_CODE':SECURITY}
    exec(compile(CORE,str(BASE/'setup_packages_core.py'),'exec'),value)
    return value

def account(): return types.SimpleNamespace(pw_uid=1001,pw_gid=1001,pw_name='fixture',pw_dir='/fixture/home')

class SetupPackageTests(unittest.TestCase):
    def test_unknown_duplicate_and_nonstring_items_never_reach_executor(self):
        ns=namespace()
        with patch.object(ns['pwd'],'getpwnam',return_value=account()),patch.object(ns['subprocess'],'run',side_effect=AssertionError('must not execute')):
            for items in [['git;reboot'],['git','git'],['unknown'],[],[{}]]:
                with self.assertRaises(ValueError): ns['validate'](dict(action='install',items=items,user='fixture'))

    def test_scan_never_escalates_or_installs(self):
        ns=namespace();ns['present']=lambda item,user:True;commands=[]
        def inspect(args,**kwargs):
            commands.append(args)
            self.assertEqual(args[0],'dpkg-query')
            return subprocess.CompletedProcess(args,0,b'1.2.3')
        with patch.object(ns['pwd'],'getpwnam',return_value=account()),patch.object(ns['os'],'geteuid',side_effect=AssertionError('no escalation')),patch.object(ns['subprocess'],'run',side_effect=inspect):
            result=ns['run'](dict(action='scan',items=['git','jq'],user='fixture'))
        self.assertTrue(all(row['status']=='installed' and row['version']=='1.2.3' for row in result))
        self.assertEqual(len(commands),2)

    def test_user_tool_probes_drop_root_before_executing_user_files(self):
        ns=namespace()
        with patch.object(ns['os'],'geteuid',return_value=0),patch.object(ns['os'].path,'isfile',return_value=True),patch.object(ns['os'],'access',return_value=True),patch.object(ns['subprocess'],'run',return_value=subprocess.CompletedProcess([],0)) as execute:
            self.assertTrue(ns['present']('go',account()))
            args=execute.call_args.args[0]
            self.assertEqual(args[:4],['/usr/sbin/runuser','-u','fixture','--'])
            self.assertTrue(args[4].startswith('/fixture/home/'))

    def test_sources_refuse_custom_hosts_unsigned_and_local_sources(self):
        ns=namespace()
        for text,expected in [('deb https://archive.ubuntu.com/ubuntu noble main',True),('deb https://ppa.example.test/ubuntu noble main',False),('deb [trusted=yes] https://archive.ubuntu.com/ubuntu noble main',False),('deb https://archive.ubuntu.com/ubuntu noble main\ndeb file:///unrelated stable main',False)]:
            with patch.object(Path,'read_text',return_value=text),patch.object(Path,'exists',return_value=True),patch.object(Path,'glob',return_value=[]):
                self.assertEqual(ns['official_sources'](),expected)

    def install_namespace(self):
        ns=namespace();ns['present']=lambda item,user:False;ns['official_sources']=lambda:True
        ns['system_info']=lambda:{'ID':'debian','VERSION_ID':'12','VERSION_CODENAME':'bookworm'}
        ns['sources_snapshot']=lambda:'source-snapshot';ns['progress']=lambda row:None
        return ns

    def request(self,items,plans):
        return dict(action='install',items=items,user='fixture',plan={'items':plans,'sourcesSnapshot':'source-snapshot'})

    def test_failed_install_is_not_reported_installed_and_uses_reviewed_version(self):
        ns=self.install_namespace();commands=[]
        def execute(args,**kwargs):
            commands.append(args)
            return subprocess.CompletedProcess(args,1,b'')
        request=self.request(['git'],[{'id':'git','package':'git','version':'1.2.3','skip':False}])
        with patch.object(ns['pwd'],'getpwnam',return_value=account()),patch.object(ns['os'],'geteuid',return_value=0),patch.object(ns['subprocess'],'run',side_effect=execute): result=ns['run'](request)['items']
        self.assertEqual(result[0]['status'],'failed')
        install=next(args for args in commands if 'install' in args)
        self.assertIn('git=1.2.3',install);self.assertIn('--no-remove',install);self.assertIn('--no-upgrade',install)
        self.assertFalse(any(args[0]=='apt-cache' for args in commands))

    def test_changed_sources_block_all_installation(self):
        ns=self.install_namespace();request=self.request(['git'],[{'id':'git','package':'git','version':'1.2.3','skip':False}]);request['plan']['sourcesSnapshot']='stale'
        with patch.object(ns['pwd'],'getpwnam',return_value=account()),patch.object(ns['os'],'geteuid',return_value=0),patch.object(ns['subprocess'],'run',side_effect=AssertionError('must not install')):
            with self.assertRaisesRegex(ValueError,'sources changed'): ns['run'](request)

    def test_installed_items_are_skipped_even_after_partial_failure(self):
        ns=self.install_namespace();ns['present']=lambda item,user:item=='git';ns['observed_version']=lambda item,user:'1.2.3'
        request=self.request(['git','jq'],[{'id':'git','skip':True},{'id':'jq','package':'jq','version':'9','skip':False}]);events=[];ns['progress']=lambda row:events.append(dict(row))
        with patch.object(ns['pwd'],'getpwnam',return_value=account()),patch.object(ns['os'],'geteuid',return_value=0),patch.object(ns['subprocess'],'run',return_value=subprocess.CompletedProcess([],1)) as executor:
            result=ns['run'](request)['items']
        self.assertEqual([row['status'] for row in result],['installed','failed'])
        self.assertEqual(executor.call_count,1)
        self.assertEqual([row['status'] for row in events],['installing','installed','installing','failed'])

    def test_dependencies_are_ordered_and_deduplicated(self):
        ns=namespace();items=ns['dependencies'](['dokploy','docker','javascript-pm2','nvm-node','lazyvim-starter','git'])
        self.assertEqual(len(items),len(set(items)))
        self.assertLess(items.index('docker'),items.index('dokploy'))
        self.assertLess(items.index('nvm-node'),items.index('javascript-pm2'))
        self.assertLess(items.index('neovim'),items.index('lazyvim-starter'))

    def test_official_url_policy_rejects_redirects_credentials_and_ports(self):
        ns=namespace()
        for url in ['http://github.com/x','https://github.com.evil.test/x','https://user:secret@github.com/x','https://github.com:444/x','https://example.test/x']:
            with self.assertRaises(ValueError): ns['safe_url'](url)
        self.assertEqual(ns['safe_url']('https://github.com/oven-sh/bun'),'https://github.com/oven-sh/bun')

    def test_publisher_checksum_mismatch_is_rejected_before_execution(self):
        ns=namespace();ns['download']=lambda *args:b'changed'
        with self.assertRaisesRegex(ValueError,'checksum'): ns['artifact']('https://github.com/x','0'*64)
        self.assertEqual(ns['artifact']('https://github.com/x')['sha256'],hashlib.sha256(b'changed').hexdigest())

    def test_user_installers_refuse_root_before_creating_directories(self):
        ns=namespace()
        with patch.object(ns['os'],'getuid',return_value=0):
            with self.assertRaisesRegex(ValueError,'non-root'): ns['user_install']('bun',{})

    def test_old_firewall_executor_cannot_bypass_verified_transaction(self):
        ns=namespace()
        with patch.object(ns['pwd'],'getpwnam',return_value=account()),patch.object(ns['os'],'geteuid',side_effect=AssertionError('must not escalate')),patch.object(ns['subprocess'],'run',side_effect=AssertionError('must not mutate')):
            with self.assertRaisesRegex(ValueError,'verified SSH/firewall'): ns['run'](dict(action='firewall-apply',items=['ufw'],user='fixture'))

    def test_connected_port_is_server_endpoint_and_password_is_not_forwarded(self):
        ns=namespace();ns['CORE']=CORE;exec(compile(WRAPPER,str(BASE/'setup_packages.py'),'exec'),ns);captured={}
        def inspect(request):captured.update(request);return []
        ns['run']=inspect
        request=dict(action='scan',items=['git'],user='fixture',currentPort=60022,sudoPassword='fixture-private')
        with patch.object(ns['pwd'],'getpwnam',return_value=account()),patch.object(ns['os'],'geteuid',return_value=0),patch.dict(ns['os'].environ,{'SSH_CONNECTION':'203.0.113.1 12345 10.0.0.1 22'}),patch.object(ns['sys'],'stdin',io.StringIO(json.dumps(request)+'\n')),contextlib.redirect_stdout(io.StringIO()) as output: ns['main']()
        self.assertEqual(captured['currentPort'],22);self.assertNotIn('sudoPassword',captured);self.assertNotIn('fixture-private',output.getvalue())

    def test_dokploy_checks_tcp_and_udp_required_ports(self):
        ns=namespace()
        ns['checked']=lambda args: b'LISTEN 0 128 0.0.0.0:3000 0.0.0.0:*\n' if '-ltn' in args else b'UNCONN 0 0 [::]:443 [::]:*\n'
        with patch.object(ns['os'].path,'lexists',return_value=False),patch.object(ns['shutil'],'which',side_effect=lambda name,**kw:None if name=='podman' else '/usr/bin/'+name):
            reason=ns['stack_conflict']('dokploy')
        self.assertIn('3000',reason);self.assertIn('443',reason)

    def test_dokploy_refuses_existing_swarm_before_upstream_script(self):
        ns=namespace();ns['docker_json']=lambda args:{'Swarm':{'LocalNodeState':'active'}}
        with patch.object(ns['os'].path,'lexists',return_value=False),patch.object(ns['shutil'],'which',side_effect=lambda name,**kw:None if name=='podman' else '/usr/bin/'+name),patch.object(ns['shutil'],'disk_usage',return_value=types.SimpleNamespace(free=16*1024**3)),patch('builtins.open',return_value=io.StringIO('MemTotal: 4096000 kB\n')),patch.object(ns['subprocess'],'run',return_value=subprocess.CompletedProcess([],0,b'')):
            self.assertIn('Swarm',ns['stack_conflict']('dokploy'))

    def test_owned_retry_refuses_changed_engine_and_foreign_services(self):
        ns=namespace();ledger={'engine':'original','swarm':'swarm','owner':'a'*32}
        ns['docker_json']=lambda args:{'ID':'replacement','Swarm':{'Cluster':{'ID':'swarm'}}}
        self.assertIn('identity changed',ns['dokploy_owned_conflict'](ledger))
        ns['docker_json']=lambda args:{'ID':'original','Swarm':{'Cluster':{'ID':'swarm'}}}
        ns['docker_names']=lambda kind:['unrelated-service']
        self.assertIn('Other Swarm services',ns['dokploy_owned_conflict'](ledger))

    def test_registry_aliases_preserve_exact_image_digest_identity(self):
        ns=namespace()
        self.assertEqual(ns["canonical_image"]("docker.io/library/postgres@sha256:abc"),ns["canonical_image"]("postgres@sha256:abc"))
        self.assertNotEqual(ns["canonical_image"]("library/postgres@sha256:abc"),ns["canonical_image"]("postgres@sha256:def"))

    def test_owned_retry_preserves_a_modified_service(self):
        ns=namespace();ledger={'engine':'engine','swarm':'swarm','owner':'a'*32,'plan':{'images':{'app':'dokploy/dokploy@sha256:'+'a'*64,'postgres':'library/postgres@sha256:'+'b'*64}}}
        def inspect(args):
            if args[0]=='info': return {'ID':'engine','Swarm':{'Cluster':{'ID':'swarm'}}}
            return {'TaskTemplate':{'ContainerSpec':{'Image':'unrelated/image:latest'}},'Mode':{'Replicated':{'Replicas':1}}}
        ns['docker_json']=inspect;ns['docker_names']=lambda kind:['dokploy'] if kind=='service' else []
        ns['own_resource']=lambda *args:True
        self.assertIn('service changed',ns['dokploy_owned_conflict'](ledger))

    def test_partial_dokploy_is_never_skipped_before_proxy_verification(self):
        ns=namespace();ns['read_dokploy_ledger']=lambda:{'state':'installing'}
        with patch.object(ns['shutil'],'which',return_value='/usr/bin/docker'),patch.object(ns['subprocess'],'run',side_effect=AssertionError('partial ledger must not be certified')):
            self.assertFalse(ns['present']('dokploy',account()))

class ArchiveTests(unittest.TestCase):
    def extract(self,members,destination):
        ns=namespace();data=io.BytesIO()
        with tarfile.open(fileobj=data,mode='w') as archive:
            for name,kind,content in members:
                member=tarfile.TarInfo(name)
                if kind=='file': member.size=len(content);archive.addfile(member,io.BytesIO(content))
                else: member.type=tarfile.SYMTYPE;member.linkname=content;archive.addfile(member)
        data.seek(0)
        with tarfile.open(fileobj=data,mode='r:') as archive: ns['extract_compatible_tar'](archive,archive.getmembers(),destination)

    def test_traversal_and_escaping_symlinks_are_refused(self):
        for members in [[('../outside','file',b'bad')],[('link','link','../outside')],[('root/link','link','../../outside')]]:
            with tempfile.TemporaryDirectory() as root:
                destination=Path(root)/'staging';destination.mkdir()
                with self.assertRaises(ValueError): self.extract(members,destination)
                self.assertFalse((Path(root)/'outside').exists())

    def test_in_tree_executable_link_is_supported_without_overwrites(self):
        with tempfile.TemporaryDirectory() as root:
            destination=Path(root)
            self.extract([('root/lib/tool','file',b'binary'),('root/bin/tool','link','../lib/tool')],destination)
            self.assertEqual((destination/'root/bin/tool').read_bytes(),b'binary')
            with self.assertRaises(FileExistsError): self.extract([('root/lib/tool','file',b'replacement')],destination)
            self.assertEqual((destination/'root/lib/tool').read_bytes(),b'binary')

if __name__=='__main__': unittest.main()
