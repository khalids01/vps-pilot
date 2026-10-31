use super::super::*;
use russh::ChannelMsg;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;

// Validated with the isolated real Docker VM protocol and bound-approval fixtures.
pub(super) const MUTATIONS_VALIDATED: bool = true;
// Validated with real batch cancellation and destructive cleanup only in a private KVM VM.
const CLEANUP_EXPANSION_VALIDATED: bool = true;
#[derive(Default)]
pub(crate) struct State {
    pending: Mutex<HashMap<String, Plan>>,
    busy: Mutex<HashSet<String>>,
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
struct Plan {
    profile: String,
    revision: String,
    connection: String,
    issued: Instant,
    request: Zeroizing<String>,
    evidence: Value,
}
impl State {
    pub(crate) fn invalidate(&self, id: &str) {
        if let Ok(active) = self.cancellations.lock() {
            if let Some(flag) = active.get(id) {
                flag.store(true, Ordering::SeqCst);
            }
        }
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, p| p.profile != id);
    }
}
struct Lease<'a> {
    state: &'a State,
    id: String,
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        self.state
            .busy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}
struct CleanupRun<'a> {
    state: &'a State,
    id: String,
}
impl Drop for CleanupRun<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.cancellations.lock() {
            active.remove(&self.id);
        }
    }
}
fn expanded_cleanup(evidence: &Value) -> bool {
    matches!(
        evidence["action"].as_str(),
        Some("cleanupBatch" | "systemPrune")
    )
}
impl SshService {
    fn docker_lease(&self, id: &str) -> Result<Lease<'_>, String> {
        let mut busy = self
            .docker_manager
            .busy
            .lock()
            .map_err(|_| "Docker operation state unavailable.")?;
        if busy.contains(id) || busy.len() >= 4 {
            return Err("Wait for the current Docker operation.".into());
        }
        busy.insert(id.into());
        Ok(Lease {
            state: &self.docker_manager,
            id: id.into(),
        })
    }
    async fn docker_call(&self, id: &str, payload: Zeroizing<String>) -> Result<Value, String> {
        if payload.len() > 1_100_000 {
            return Err("Docker request exceeds its safety limit.".into());
        }
        let profile = self.profile(id)?;
        let (mut channel, connection) = {
            let runtime = self.runtime.lock().await;
            let handle = runtime
                .connections
                .get(id)
                .filter(|h| !h.is_closed())
                .ok_or("Connect to this server first.")?;
            let connection = runtime
                .connection_ids
                .get(id)
                .cloned()
                .ok_or("Connection changed.")?;
            let channel = timeout(NETWORK_TIMEOUT, handle.channel_open_session())
                .await
                .map_err(|_| "Docker channel timed out.")?
                .map_err(|_| "Cannot open Docker channel.")?;
            (channel, connection)
        };
        let command = format!(
            "python3 -I -S -u -c {}",
            super::quoted(include_str!("../docker_manager.py"))
        );
        let result=timeout(Duration::from_secs(180),async{
        channel.exec(true,command).await.map_err(|_|"Cannot start Docker management.")?;
        for part in payload.as_bytes().chunks(32768){channel.data(part).await.map_err(|_|"Cannot send private Docker request.")?;}
        channel.eof().await.map_err(|_|"Cannot finish Docker request.")?;
        let mut output=Vec::new();let mut code=None;
        while let Some(message)=channel.wait().await{
            match message{
                ChannelMsg::Data{data}=>{
                    if output.len()+data.len()>2*1024*1024{return Err("Docker output exceeded its safety limit.".to_string());}
                    output.extend_from_slice(&data);
                },
                ChannelMsg::ExtendedData{..}|ChannelMsg::Failure=>return Err("Docker management failed. Check Python 3, Docker and socket permissions; no sudo is attempted.".into()),
                ChannelMsg::ExitStatus{exit_status}=>code=Some(exit_status),
                ChannelMsg::Close=>break,
                _=>{}
            }
        }
        if code!=Some(0){return Err("Docker management did not confirm completion. Inspect before retrying.".into());}
        let answer:Value=serde_json::from_slice(&output).map_err(|_|"Docker returned unsupported evidence.")?;
        if answer["ok"]!=true{return Err(answer["error"].as_str().unwrap_or("Docker request was refused.").to_string());}
        Ok(answer["value"].clone())
    }).await.map_err(|_|"Docker operation timed out; remote changes may continue. Inspect before retrying.".to_string()).and_then(|r|r);
        let _ = channel.close().await;
        if self.profile(id)?.revision != profile.revision
            || self.runtime.lock().await.connection_ids.get(id) != Some(&connection)
        {
            return Err("The SSH identity changed. Inspect state before reviewing again.".into());
        }
        result
    }
    pub(super) async fn docker_review(&self, id: &str, request: String) -> Result<Value, String> {
        let _lease = self.docker_lease(id)?;
        let request = Zeroizing::new(request);
        if request.len() > 1024 * 1024 {
            return Err("Docker request is too large.".into());
        }
        let profile = self.profile(id)?;
        let connection = self
            .runtime
            .lock()
            .await
            .connection_ids
            .get(id)
            .cloned()
            .ok_or("Connect first.")?;
        let payload = Zeroizing::new(format!(
            "{{\"mode\":\"preview\",\"request\":{}}}\n",
            request.as_str()
        ));
        let evidence = self.docker_call(id, payload).await?;
        let token = Uuid::new_v4().to_string();
        let mut pending = self
            .docker_manager
            .pending
            .lock()
            .map_err(|_| "Docker review state unavailable.")?;
        pending.retain(|_, p| p.issued.elapsed() < Duration::from_secs(120));
        if pending.len() >= 8 {
            return Err("Close another review first.".into());
        }
        pending.insert(
            token.clone(),
            Plan {
                profile: id.into(),
                revision: profile.revision,
                connection,
                issued: Instant::now(),
                request,
                evidence: evidence.clone(),
            },
        );
        Ok(
            json!({"token":token,"profileId":id,"serverName":profile.name,"evidence":evidence,"expiresInSeconds":120,"enabled":MUTATIONS_VALIDATED && (!expanded_cleanup(&evidence)||CLEANUP_EXPANSION_VALIDATED)}),
        )
    }
    pub(super) async fn docker_execute(
        &self,
        id: &str,
        token: &str,
        confirmation: Option<&str>,
        progress: Option<&Channel<Value>>,
    ) -> Result<Value, String> {
        if !MUTATIONS_VALIDATED {
            return Err("Docker changes await disposable-VM validation.".into());
        }
        let _lease = self.docker_lease(id)?;
        let plan = self
            .docker_manager
            .pending
            .lock()
            .map_err(|_| "Docker review unavailable.")?
            .remove(token)
            .ok_or("Review is unavailable or already used.")?;
        if plan.profile != id
            || plan.issued.elapsed() >= Duration::from_secs(120)
            || self.profile(id)?.revision != plan.revision
            || self.runtime.lock().await.connection_ids.get(id) != Some(&plan.connection)
        {
            return Err("Docker review expired or its server changed. Review again.".into());
        }
        if !plan.evidence["blocked"]
            .as_array()
            .is_some_and(Vec::is_empty)
        {
            return Err("This operation has unresolved safety checks.".into());
        }
        if expanded_cleanup(&plan.evidence) {
            if !CLEANUP_EXPANSION_VALIDATED {
                return Err("Expanded cleanup awaits disposable-VM validation.".into());
            }
            if confirmation != plan.evidence["confirmation"].as_str() {
                return Err("Type the exact cleanup confirmation and review again.".into());
            }
        }
        if plan.evidence["action"] == "cleanupBatch" {
            return self
                .docker_cleanup_batch(id, &plan.request, &plan.evidence, progress)
                .await;
        }
        let evidence =
            serde_json::to_string(&plan.evidence).map_err(|_| "Cannot encode evidence.")?;
        let payload = Zeroizing::new(format!(
            "{{\"mode\":\"execute\",\"plan\":{},\"request\":{}}}\n",
            evidence,
            plan.request.as_str()
        ));
        self.docker_call(id, payload).await
    }
    async fn docker_cleanup_batch(
        &self,
        id: &str,
        request: &str,
        evidence: &Value,
        progress: Option<&Channel<Value>>,
    ) -> Result<Value, String> {
        let flag = Arc::new(AtomicBool::new(false));
        self.docker_manager
            .cancellations
            .lock()
            .map_err(|_| "Cleanup state unavailable.")?
            .insert(id.into(), flag.clone());
        if let Some(progress) = progress {
            let _=progress.send(json!({"stage":"cleanupReady","message":"Rechecking selected resources. Cancellation stops remaining items."}));
        }
        let _run = CleanupRun {
            state: &self.docker_manager,
            id: id.into(),
        };
        let request: Value =
            serde_json::from_str(request).map_err(|_| "Cleanup request is invalid.")?;
        let recheck = Zeroizing::new(json!({"mode":"preview","request":request}).to_string());
        if self.docker_call(id, recheck).await? != *evidence {
            return Err("Cleanup candidates changed after review. Review again.".into());
        }
        let items = evidence["items"]
            .as_array()
            .filter(|items| !items.is_empty() && items.len() <= 20)
            .ok_or("Cleanup review is invalid.")?;
        let began = Instant::now();
        let mut outcomes = Vec::new();
        let mut last_snapshot = None;
        let mut interrupted = false;
        for (index, item) in items.iter().enumerate() {
            let stop = flag.load(Ordering::SeqCst)
                || began.elapsed() > Duration::from_secs(150)
                || interrupted;
            if stop {
                outcomes.push(json!({"kind":item["kind"],"id":item["target"],"name":item["name"],"status":"skipped","message":"Not started: cleanup was canceled, blocked or its time limit was reached."}));
                continue;
            }
            if let Some(progress) = progress {
                let _=progress.send(json!({"stage":"cleanup","message":format!("Removing {} of {}: {}",index+1,items.len(),item["name"].as_str().unwrap_or("resource"))}));
            }
            let child = json!({"action":"cleanup","kind":item["kind"],"target":item["target"]});
            let payload =
                Zeroizing::new(json!({"mode":"execute","request":child,"plan":item}).to_string());
            match self.docker_call(id, payload).await {
                Ok(result) if result["status"] == "completed" => {
                    last_snapshot = result.get("snapshot").cloned();
                    outcomes.push(json!({"kind":item["kind"],"id":item["target"],"name":item["name"],"status":"removed","message":"Removed."}));
                }
                Ok(_) => {
                    interrupted = true;
                    outcomes.push(json!({"kind":item["kind"],"id":item["target"],"name":item["name"],"status":"uncertain","message":"Docker did not confirm removal. Remaining items were not started."}));
                }
                Err(error) => {
                    interrupted = true;
                    outcomes.push(json!({"kind":item["kind"],"id":item["target"],"name":item["name"],"status":"uncertain","message":error}));
                }
            }
        }
        let removed = outcomes.iter().filter(|r| r["status"] == "removed").count();
        let cancelled = flag.load(Ordering::SeqCst);
        let status = if removed == items.len() {
            "completed"
        } else if cancelled {
            "cancelled"
        } else {
            "partial"
        };
        Ok(
            json!({"status":status,"message":format!("Removed {removed} of {} selected resources. Completed removals cannot be undone.",items.len()),"items":outcomes,"reclaimedBytes":Value::Null,"snapshot":last_snapshot}),
        )
    }
}
#[tauri::command]
pub async fn ssh_docker_snapshot(
    service: tauri::State<'_, SshService>,
    profile_id: String,
) -> Result<Value, String> {
    let _lease = service.docker_lease(&profile_id)?;
    let value = service
        .docker_call(
            &profile_id,
            Zeroizing::new("{\"mode\":\"snapshot\"}\n".into()),
        )
        .await?;
    Ok(json!({"snapshot":value,"enabled":MUTATIONS_VALIDATED}))
}
#[tauri::command]
pub async fn ssh_docker_review(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    request: String,
) -> Result<Value, String> {
    service.docker_review(&profile_id, request).await
}
#[tauri::command]
pub async fn ssh_docker_execute(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    token: String,
    progress: Channel<Value>,
    confirmation: Option<String>,
) -> Result<Value, String> {
    let _=progress.send(json!({"stage":"revalidating","message":"Checking engine identity and dependencies again."}));
    let result = service
        .docker_execute(
            &profile_id,
            &token,
            confirmation.as_deref(),
            Some(&progress),
        )
        .await;
    let _ = progress.send(
        json!({"stage":"finished","message":"Inspect the operation result before retrying."}),
    );
    result
}
#[tauri::command]
pub fn ssh_docker_cancel(
    service: tauri::State<'_, SshService>,
    profile_id: String,
) -> Result<(), String> {
    let active = service
        .docker_manager
        .cancellations
        .lock()
        .map_err(|_| "Cleanup cancellation unavailable.")?;
    let flag = active
        .get(&profile_id)
        .ok_or("No cancelable cleanup is running for this server.")?;
    flag.store(true, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub fn ssh_docker_reject(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    token: String,
) -> Result<(), String> {
    let mut pending = service
        .docker_manager
        .pending
        .lock()
        .map_err(|_| "Review state unavailable.")?;
    if pending.get(&token).is_some_and(|p| p.profile == profile_id) {
        pending.remove(&token);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Explicit app-created disposable Docker VM only; VPS_PILOT_DOCKER_VM_FILE"]
    async fn disposable_docker_vm_bound_approvals() {
        let path = std::env::var("VPS_PILOT_DOCKER_VM_FILE").unwrap();
        assert!(path.starts_with("/tmp/vps-pilot-docker-vm-") && path.ends_with("/fixture.json"));
        let meta: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(meta["host"], "127.0.0.1");
        let temp = tempfile::tempdir().unwrap();
        let service = SshService::new(temp.path().join("profiles.json"));
        let profile = service
            .save_profile(ProfileInput {
                id: None,
                name: "Disposable Docker VM".into(),
                host: "127.0.0.1".into(),
                port: meta["port"].as_u64().unwrap() as u16,
                username: "root".into(),
                identity_file: Some(meta["key"].as_str().unwrap().into()),
                password_allowed: false,
            })
            .await
            .unwrap();
        let inspection = service.inspect(&profile.id).await.unwrap();
        service
            .trust(&profile.id, &inspection.challenge_id)
            .await
            .unwrap();
        service
            .connect(&profile.id, &inspection.challenge_id, "".into())
            .await
            .unwrap();
        {
            let runtime = service.runtime.lock().await;
            assert_eq!(
                services::collect(
                    &runtime,
                    &profile.id,
                    "test -f /root/vps-pilot-disposable-vm && hostname"
                )
                .await
                .unwrap()
                .trim(),
                "docker-fixture"
            );
        }

        // The VM starts empty. Verify real global prune through native approval.
        let prune = service
            .docker_review(
                &profile.id,
                json!({"action":"systemPrune","target":"system"}).to_string(),
            )
            .await
            .unwrap();
        assert!(prune["evidence"]["blocked"].as_array().unwrap().is_empty());
        assert!(!prune["evidence"]["command"]
            .as_str()
            .unwrap()
            .contains("--volumes"));
        assert!(service
            .docker_execute(
                &profile.id,
                prune["token"].as_str().unwrap(),
                Some("WRONG"),
                None
            )
            .await
            .is_err());
        let prune = service
            .docker_review(
                &profile.id,
                json!({"action":"systemPrune","target":"system"}).to_string(),
            )
            .await
            .unwrap();
        let result = service
            .docker_execute(
                &profile.id,
                prune["token"].as_str().unwrap(),
                Some("PRUNE"),
                None,
            )
            .await
            .unwrap();
        assert_eq!(result["status"], "completed");
        let mut network_ids = Vec::new();
        {
            let runtime = service.runtime.lock().await;
            services::collect(&runtime, &profile.id, "docker pull alpine:3.24 >/dev/null")
                .await
                .unwrap();
            for _ in 0..3 {
                network_ids.push(
                    services::collect(
                        &runtime,
                        &profile.id,
                        &format!("docker network create fixture-batch-{}", Uuid::new_v4()),
                    )
                    .await
                    .unwrap()
                    .trim()
                    .to_string(),
                );
            }
            services::collect(
                &runtime,
                &profile.id,
                "rc-service chronyd stop >/dev/null 2>&1 || true",
            )
            .await
            .unwrap();
            services::collect(
                &runtime,
                &profile.id,
                "date -s @$(($(date +%s)+777600)) >/dev/null",
            )
            .await
            .unwrap();
        }
        let batch=json!({"action":"cleanupBatch","target":"selected","targets":[{"kind":"network","id":network_ids[0]},{"kind":"network","id":network_ids[1]}]}).to_string();
        let review = service
            .docker_review(&profile.id, batch.clone())
            .await
            .unwrap();
        let cancel = async {
            for _ in 0..200 {
                if let Some(flag) = service
                    .docker_manager
                    .cancellations
                    .lock()
                    .unwrap()
                    .get(&profile.id)
                    .cloned()
                {
                    flag.store(true, Ordering::SeqCst);
                    return;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            panic!("Cleanup cancellation was not registered.");
        };
        let (result, ()) = tokio::join!(
            service.docker_execute(
                &profile.id,
                review["token"].as_str().unwrap(),
                Some("DELETE 2"),
                None
            ),
            cancel
        );
        let result = result.unwrap();
        assert_eq!(result["status"], "cancelled");
        assert!(result["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["status"] == "skipped"));
        let review = service.docker_review(&profile.id, batch).await.unwrap();
        let token = review["token"].as_str().unwrap();
        let result = service
            .docker_execute(&profile.id, token, Some("DELETE 2"), None)
            .await
            .unwrap();
        assert_eq!(result["status"], "completed");
        assert!(result["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["status"] == "removed"));
        assert!(service
            .docker_execute(&profile.id, token, Some("DELETE 2"), None)
            .await
            .is_err());
        let stale_batch = service
            .docker_review(
                &profile.id,
                json!({"action":"cleanupBatch","targets":[{"kind":"network","id":network_ids[2]}]})
                    .to_string(),
            )
            .await
            .unwrap();
        {
            let runtime = service.runtime.lock().await;
            services::collect(
                &runtime,
                &profile.id,
                &format!("docker network rm -- {}", network_ids[2]),
            )
            .await
            .unwrap();
        }
        assert!(service
            .docker_execute(
                &profile.id,
                stale_batch["token"].as_str().unwrap(),
                Some("DELETE 1"),
                None
            )
            .await
            .is_err());
        assert!(service
            .docker_review(
                &profile.id,
                json!({"action":"cleanupBatch","targets":[{"kind":"volume","id":"protected"}]})
                    .to_string()
            )
            .await
            .is_err());
        let target = {
            let runtime = service.runtime.lock().await;
            services::collect(
                &runtime,
                &profile.id,
                &format!(
                    "docker create --name fixture-native-approval-{} alpine:3.24 sleep 3600",
                    Uuid::new_v4()
                ),
            )
            .await
            .unwrap()
            .trim()
            .to_string()
        };
        let request = json!({"action":"start","target":target}).to_string();
        let rejected = service
            .docker_review(&profile.id, request.clone())
            .await
            .unwrap();
        let token = rejected["token"].as_str().unwrap();
        assert!(service
            .docker_execute("different-server", token, None, None)
            .await
            .is_err());
        assert!(service
            .docker_execute(&profile.id, token, None, None)
            .await
            .is_err());
        let review = service.docker_review(&profile.id, request).await.unwrap();
        let token = review["token"].as_str().unwrap();
        let result = service
            .docker_execute(&profile.id, token, None, None)
            .await
            .unwrap();
        assert_eq!(result["status"], "completed");
        assert!(service
            .docker_execute(&profile.id, token, None, None)
            .await
            .is_err());
        let stale = service
            .docker_review(
                &profile.id,
                json!({"action":"stop","target":target}).to_string(),
            )
            .await
            .unwrap();
        {
            let runtime = service.runtime.lock().await;
            services::collect(
                &runtime,
                &profile.id,
                &format!("docker stop --time 1 -- {target}"),
            )
            .await
            .unwrap();
        }
        assert!(service
            .docker_execute(&profile.id, stale["token"].as_str().unwrap(), None, None)
            .await
            .is_err());
        let pending = service
            .docker_review(
                &profile.id,
                json!({"action":"start","target":target}).to_string(),
            )
            .await
            .unwrap();
        service.disconnect(&profile.id).await.unwrap();
        assert!(service
            .docker_execute(&profile.id, pending["token"].as_str().unwrap(), None, None)
            .await
            .is_err());
    }
}
