"""Fixed-adapter policy/CAS tests. No host proxy or daemon is contacted."""
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

BASE = pathlib.Path(__file__).resolve().parents[2] / 'src-tauri/src/ssh/proxy_workspace.py'
spec = importlib.util.spec_from_file_location('proxy_workspace', BASE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class WorkspaceTests(unittest.TestCase):
    def instance(self, root, manager='nginx'):
        return dict(id='system:' + manager, identity='a' * 64, manager=manager, kind='system', name=manager+'.service', roots=[dict(host=str(root), container=str(root), directory=True)], editable=True, actions=True, config=str(root/'nginx.conf'), binary='/usr/sbin/nginx', args=[])

    def test_config_allowlist_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            (root/'nginx.conf').write_text('events {}')
            (root/'private.key').write_text('do-not-expose')
            (root/'acme.json').write_text('do-not-expose')
            (root/'linked.conf').symlink_to(root/'nginx.conf')
            files = m.files(self.instance(root))
            self.assertEqual({f['path'].split('/')[-1] for f in files}, {'nginx.conf', 'linked.conf'})
            self.assertFalse(next(f for f in files if f['revision']=='symlink')['editable'])
            with self.assertRaises(ValueError): m.target(self.instance(root), str(root/'linked.conf'))
            with self.assertRaises(ValueError): m.target(self.instance(root), '/etc/ssh/sshd_config')
            with self.assertRaises(ValueError): m.target(self.instance(root), str(root/'../outside.conf'))

    def test_stale_revision_stops_before_validation_or_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory).resolve(); path=root/'nginx.conf';path.write_text('old')
            instance=self.instance(root)
            with patch.object(m,'stage_validate',side_effect=AssertionError('validation ran')):
                with self.assertRaisesRegex(ValueError,'changed outside'):
                    m.save(instance,dict(path=str(path),treeRevision='stale',revision='missing',content='new'))
            self.assertEqual(path.read_text(),'old')

    def test_invalid_candidate_never_replaces_live_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory).resolve();path=root/'nginx.conf';path.write_text('old')
            instance=self.instance(root); files=m.files(instance)
            request=dict(path=str(path),treeRevision=m.tree_revision(files),revision=files[0]['revision'],content='invalid')
            with patch.object(m,'stage_validate',side_effect=ValueError('line 1 invalid')):
                with self.assertRaisesRegex(ValueError,'line 1'):m.save(instance,request)
            self.assertEqual(path.read_text(),'old')

    def test_change_during_validation_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory).resolve();path=root/'nginx.conf';path.write_text('old');instance=self.instance(root);files=m.files(instance)
            request=dict(path=str(path),treeRevision=m.tree_revision(files),revision=files[0]['revision'],content='candidate')
            with patch.object(m,'stage_validate',side_effect=lambda *a:path.write_text('external')),patch.object(m,'select_instance',return_value=instance):
                with self.assertRaisesRegex(ValueError,'during validation'):m.save(instance,request)
            self.assertEqual(path.read_text(),'external')

    def test_reload_failure_restores_only_our_replacement(self):
        for external in (False,True):
            with tempfile.TemporaryDirectory() as directory:
                root=pathlib.Path(directory).resolve();path=root/'nginx.conf';path.write_text('old');instance=self.instance(root);files=m.files(instance)
                request=dict(path=str(path),treeRevision=m.tree_revision(files),revision=files[0]['revision'],content='candidate')
                def fail(*unused):
                    if external:path.write_text('external')
                    raise ValueError('reload failed')
                with patch.object(m,'stage_validate'),patch.object(m,'select_instance',return_value=instance),patch.object(m,'backup_root',return_value=root),patch.object(m,'lifecycle',side_effect=fail):
                    with self.assertRaisesRegex(ValueError,'Apply failed'):m.save(instance,request)
                self.assertEqual(path.read_text(),'external' if external else 'old')
                backup=next(root.glob('*.json'));self.assertEqual(backup.stat().st_mode&0o777,0o600)

    def test_single_file_mount_does_not_allow_atomic_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory).resolve();path=root/'nginx.conf';path.write_text('old');instance=self.instance(root)
            instance['roots']=[dict(host=str(path),container='/etc/nginx/nginx.conf',directory=False)]
            self.assertFalse(m.files(instance)[0]['editable'])
            with self.assertRaisesRegex(ValueError,'directory mount'):m.target(instance,str(path))

    def test_traefik_requires_explicit_no_offline_test_acknowledgement(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory).resolve();path=root/'traefik.yml';path.write_text('entryPoints: {}');instance=self.instance(root,'traefik');files=m.files(instance)
            with self.assertRaisesRegex(ValueError,'Acknowledge'):
                m.save(instance,dict(path=str(path),treeRevision=m.tree_revision(files),revision=files[0]['revision'],content='bad'))
            with self.assertRaisesRegex(ValueError,'watches dynamic'):
                m.lifecycle(instance,'reload')

    def test_stale_instance_and_unknown_operation(self):
        with patch.object(m,'inventory',return_value={'instances':[]}):
            with self.assertRaisesRegex(ValueError,'identity changed'):m.select_instance({'instanceId':'system:caddy','identity':'old'})
        instance={'id':'system:caddy','identity':'x'}
        with patch.object(m,'select_instance',return_value=instance):
            with self.assertRaisesRegex(ValueError,'Unsupported'):m.main({'operation':'delete'})

    def test_docker_inventory_projects_only_config_sources(self):
        import json
        item={'Id':'a'*64,'Path':'traefik','Args':['--providers.file.directory=/etc/traefik/dynamic'], 'Image':'sha256:fixed',
              'Config':{'Image':'traefik:v3','Env':['PASSWORD=never-return'],'Labels':{'com.docker.compose.project':'demo','traefik.http.routers.app.rule':'Host(`example.test`)'}},
              'Mounts':[{'Type':'bind','Source':'/var/apps/proxy','Destination':'/etc/traefik','RW':False}],
              'State':{'Status':'running','Running':True,'StartedAt':'stamp'},'HostConfig':{}}
        with patch.object(m,'run',side_effect=[json.dumps({'id':'engine','name':m.os.uname().nodename}),'a'*64,json.dumps([item])]),patch.object(m.os.path,'isdir',return_value=True):
            result=m.docker_instances()[0]
        self.assertEqual(result['manager'],'traefik');self.assertTrue(result['editable']);self.assertTrue(result['labelRoutes'])
        result.pop('_identity');self.assertNotIn('never-return',json.dumps(result))


if __name__=='__main__':unittest.main()
