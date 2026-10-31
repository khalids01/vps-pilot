use super::super::*;
use russh::ChannelMsg;
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::ipc::Channel;

// Validated with the isolated real Docker VM protocol and bound-approval fixtures.
pub(super) const MUTATIONS_VALIDATED: bool = true;
#[derive(Default)]
pub(crate) struct State {
    pending: Mutex<HashMap<String, Plan>>,
    busy: Mutex<HashSet<String>>,
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
            json!({"token":token,"profileId":id,"serverName":profile.name,"evidence":evidence,"expiresInSeconds":120,"enabled":MUTATIONS_VALIDATED}),
        )
    }
    pub(super) async fn docker_execute(&self, id: &str, token: &str) -> Result<Value, String> {
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
        let evidence =
            serde_json::to_string(&plan.evidence).map_err(|_| "Cannot encode evidence.")?;
        let payload = Zeroizing::new(format!(
            "{{\"mode\":\"execute\",\"plan\":{},\"request\":{}}}\n",
            evidence,
            plan.request.as_str()
        ));
        self.docker_call(id, payload).await
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
) -> Result<Value, String> {
    let _=progress.send(json!({"stage":"revalidating","message":"Checking engine identity and dependencies again."}));
    let result = service.docker_execute(&profile_id, &token).await;
    let _ = progress.send(
        json!({"stage":"finished","message":"Inspect the operation result before retrying."}),
    );
    result
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
            .docker_execute("different-server", token)
            .await
            .is_err());
        assert!(service.docker_execute(&profile.id, token).await.is_err());
        let review = service.docker_review(&profile.id, request).await.unwrap();
        let token = review["token"].as_str().unwrap();
        let result = service.docker_execute(&profile.id, token).await.unwrap();
        assert_eq!(result["status"], "completed");
        assert!(service.docker_execute(&profile.id, token).await.is_err());
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
            .docker_execute(&profile.id, stale["token"].as_str().unwrap())
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
            .docker_execute(&profile.id, pending["token"].as_str().unwrap())
            .await
            .is_err());
    }
}
