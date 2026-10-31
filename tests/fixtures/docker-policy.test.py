"""Pure policy tests; no daemon, SSH or subprocess may run."""
import sys
sys.dont_write_bytecode=True
import datetime as dt
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("manager",pathlib.Path("src-tauri/src/ssh/docker_manager.py"))
manager=importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)
class Policy(unittest.TestCase):
    def test_system_paths_and_ancestors(self):
        for path in ("/","/etc/passwd","/var","/var/lib/docker","/root/.ssh/key"):
            with self.assertRaises(manager.Refused):
                manager.safe_path(path)
        self.assertEqual(manager.safe_path("/srv/my-app"),"/srv/my-app")
    def test_protected_containers(self):
        base={"name":"app","project":"project","imageName":"alpine:3.24","privileged":False,"networkMode":"bridge","pidMode":"","mounts":[]}
        self.assertEqual(manager.protect(base),"")
        for extra in ({"name":"postgres"},{"privileged":True},{"networkMode":"host"},{"pod":"pod"},{"orchestrator":"service"},{"mounts":[{"Type":"bind","Source":"/","Destination":"/host"}]}):
            self.assertTrue(manager.protect(dict(base,**extra)))
    def test_namespace_and_docker_socket_shortcuts_are_blocked(self):
        self.assertFalse(manager.unsafe_service({"network_mode":"bridge"}))
        for value in ({"volumes_from":["database"]},{"use_api_socket":True},{"network_mode":"container:other"},{"pid":"service:other"},{"post_start":[{"privileged":True}]},{"security_opt":["apparmor:unconfined"]}):
            self.assertTrue(manager.unsafe_service(value))
    def test_age_is_fail_closed(self):
        self.assertFalse(manager.old_enough("unknown"))
        self.assertFalse(manager.old_enough(dt.datetime.now(dt.timezone.utc).isoformat()))
        self.assertTrue(manager.old_enough((dt.datetime.now(dt.timezone.utc)-dt.timedelta(days=8)).isoformat()))
    def test_stale_review_executes_no_cli(self):
        with patch.object(manager,"preview",return_value={"different":True}),patch.object(manager,"cli") as cli:
            with self.assertRaises(manager.Refused):
                manager.execute({"plan":{"old":True},"request":{}})
            cli.assert_not_called()
    def test_port_collisions_and_duplicate_mappings(self):
        plan={"services":[{"name":"web","ports":["8080","8080"]}],"blocked":[]}
        snap={"containers":[]}
        # Header + one TCP listener at port 8080.
        text="header\n0: 00000000:1F90 00000000:0000 0A\n"
        with patch.object(pathlib.Path,"read_text",return_value=text):
            manager.check_ports(plan,snap,"project")
        self.assertTrue(any("already listening" in v for v in plan["blocked"]))
        self.assertTrue(any("duplicate" in v for v in plan["blocked"]))
    def test_existing_application_requires_explicit_update_and_matching_folder(self):
        plan={"directory":"/srv/my-app","services":[{"name":"web"}],"blocked":[]}
        snap={"containers":[{"project":"my-app","workingDir":"/srv/other-app","mounts":[]}]}
        manager.check_application(plan,snap,"my-app",False)
        self.assertTrue(any("explicitly" in v for v in plan["blocked"]))
        self.assertTrue(any("another folder" in v for v in plan["blocked"]))
        snap["containers"][0]["workingDir"]="/srv/my-app"
        plan["blocked"]=[]
        manager.check_application(plan,snap,"my-app",True)
        self.assertEqual(plan["blocked"],[])
    def test_container_name_and_shared_data_conflicts(self):
        plan={"directory":"/srv/new","services":[{"name":"web","containerName":"taken","mounts":[{"type":"bind","source":"/srv/data/sub"}]}],"volumes":{"data":{"external":True}},"blocked":[]}
        snap={"containers":[{"name":"/taken","project":"other","service":"web","mounts":[{"Type":"bind","Source":"/srv/data"}]}],"volumes":[]}
        manager.check_application(plan,snap,"new",False)
        self.assertTrue(any("container name" in v for v in plan["blocked"]))
        self.assertTrue(any("mounted data" in v for v in plan["blocked"]))
        self.assertTrue(any("External" in v for v in plan["blocked"]))
    def test_other_service_in_same_project_cannot_exempt_port(self):
        plan={"services":[{"name":"web","ports":["8080"]}],"blocked":[]}
        snap={"containers":[{"project":"project","service":"other","state":"running","ports":{"80/tcp":[{"HostPort":"8080"}]}}]}
        with patch.object(pathlib.Path,"read_text",return_value="header"):
            manager.check_ports(plan,snap,"project")
        self.assertTrue(any("reserved" in v for v in plan["blocked"]))
    def test_port_check_failure_blocks_and_stopped_container_cannot_hide_listener(self):
        plan={"services":[{"name":"web","ports":["8080"]}],"blocked":[]}
        with patch.object(pathlib.Path,"read_text",side_effect=PermissionError):
            manager.check_ports(plan,{"containers":[]},"project")
        self.assertTrue(plan["blocked"])
        plan["blocked"]=[]
        snap={"containers":[{"project":"project","service":"web","state":"exited","ports":{"80/tcp":[{"HostPort":"8080"}]}}]}
        with patch.object(pathlib.Path,"read_text",return_value="header\n0: 00000000:1F90 00000000:0000 0A\n"):
            manager.check_ports(plan,snap,"project")
        self.assertTrue(any("already listening" in v for v in plan["blocked"]))

class CleanupPolicy(unittest.TestCase):
    def base(self):
        return {"containers":[],"images":[],"networks":[],"cleanup":[]}
    def cache(self):
        return patch.object(manager,"lines",return_value=[{"Type":"Build Cache","TotalCount":"0","Active":"0","Size":"0B","Reclaimable":"0B"}])
    def test_system_prune_protects_stopped_workloads_and_never_uses_volume_or_force_flags(self):
        snap=self.base()
        snap["containers"]=[{"id":"a","name":"database","state":"exited","created":"2020-01-01T00:00:00Z"}]
        snap["cleanup"]=[{"id":"a","kind":"container","eligible":False,"reason":"Mounted data"}]
        with self.cache():plan=manager.prune_plan({},snap)
        self.assertTrue(plan["blocked"])
        self.assertNotIn("--volumes",plan["command"])
        self.assertNotIn("--force",plan["command"])
        self.assertNotIn("--all",plan["command"])
        self.assertIn("until=",plan["command"])
        snap["containers"][0]["state"]="running"
        with self.cache():self.assertEqual(manager.prune_plan({},snap)["blocked"],[])
    def test_rollback_holds_and_unused_compose_networks_block_global_prune(self):
        snap=self.base()
        snap["images"]=[{"id":"i","kind":"image","name":"held","created":"2020-01-01T00:00:00Z","tags":[],"references":[],"eligible":False,"reason":"Retained for application rollback"}]
        snap["networks"]=[{"name":"project_default","created":"2020-01-01T00:00:00Z","references":[],"eligible":False,"reason":"Compose-managed network"}]
        with self.cache():plan=manager.prune_plan({},snap)
        self.assertTrue(any("rollback" in r for r in plan["blocked"]))
        self.assertTrue(any("Compose" in r for r in plan["blocked"]))
    def test_prune_closure_cannot_erase_a_rollback_hold(self):
        snap=self.base()
        snap["containers"]=[{"id":"c","name":"old","state":"exited","created":"2020-01-01T00:00:00Z"}]
        snap["cleanup"]=[{"kind":"container","id":"c","name":"old","eligible":True}]
        snap["images"]=[{"kind":"image","id":"i","name":"image","created":"2020-01-01T00:00:00Z","tags":[],"references":["old"],"reason":"Referenced by containers/images","retained":True,"eligible":False}]
        with self.cache():self.assertTrue(manager.prune_plan({},snap)["blocked"])
        snap["images"][0]["retained"]=False
        with self.cache():self.assertEqual(manager.prune_plan({},snap)["blocked"],[])
    def test_system_prune_reuses_review_cutoff_and_rejects_younger_filter(self):
        with self.cache():
            plan=manager.prune_plan({},self.base())
            self.assertEqual(manager.prune_plan({},self.base(),plan["cutoff"])["cutoff"],plan["cutoff"])
            with self.assertRaises(manager.Refused):manager.prune_plan({},self.base(),int(dt.datetime.now(dt.timezone.utc).timestamp()))
    def test_active_or_unknown_build_cache_is_blocked(self):
        with patch.object(manager,"lines",return_value=[]):self.assertTrue(manager.prune_plan({},self.base())["blocked"])
        with patch.object(manager,"lines",return_value=[{"Type":"Build Cache","TotalCount":"2","Active":"1","Size":"1MB","Reclaimable":"0B"}]):
            self.assertTrue(manager.prune_plan({},self.base())["blocked"])
    def test_batch_rejects_volumes_duplicate_ids_and_more_than_twenty(self):
        snap={"engine":{"localSocket":True},"cleanup":[{"id":"image","kind":"image","name":"image","eligible":True,"fingerprint":"f"}]}
        for targets in ([{"kind":"volume","id":"v"}],[{"kind":"image","id":"image"}]*2,[{"kind":"image","id":"image"}]*21):
            with self.assertRaises(manager.Refused):manager.preview({"action":"cleanupBatch","targets":targets},snap)
        plan=manager.preview({"action":"cleanupBatch","targets":[{"kind":"image","id":"image"}]},snap)
        self.assertEqual(plan["confirmation"],"DELETE 1")
        self.assertEqual(plan["items"][0]["target"],"image")
if __name__=="__main__":
    unittest.main()
