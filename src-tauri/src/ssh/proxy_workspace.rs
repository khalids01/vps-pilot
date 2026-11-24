//! Narrow, one-use proxy workspace approvals. Secret config/passwords use stdin only.
use super::*;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use zeroize::Zeroize;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    profile_id: String,
    profile_revision: String,
    connection_id: String,
    operation: Operation,
    #[serde(default)]
    instance_id: String,
    #[serde(default)]
    identity: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    revision: String,
    #[serde(default)]
    tree_revision: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    backup_id: String,
    #[serde(default)]
    acknowledge_traefik: bool,
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Inventory,
    Inspect,
    Open,
    Logs,
    Validate,
    Save,
    Reload,
    Restart,
    Restore,
}
impl Request {
    fn validate(&self) -> Result<(), String> {
        if self.profile_id.len() > 64
            || self.profile_revision.len() > 128
            || self.connection_id.len() > 128
            || self.instance_id.len() > 128
            || self.identity.len() > 64
            || self.revision.len() > 64
            || self.tree_revision.len() > 64
            || self.path.len() > 1024
            || self.content.len() > 262144
            || self.content.contains('\0')
            || self.backup_id.len() > 25
        {
            return Err("Proxy request exceeds its limits.".into());
        }
        if !matches!(self.operation, Operation::Inventory | Operation::Inspect) {
            let valid_id = ["system:caddy", "system:nginx", "system:traefik"]
                .contains(&self.instance_id.as_str())
                || self
                    .instance_id
                    .strip_prefix("docker:")
                    .is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()));
            if !valid_id
                || self.identity.len() != 64
                || !self.identity.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("Detect and select an exact proxy instance first.".into());
            }
        }
        if self.operation == Operation::Save
            && (self.tree_revision.len() != 64 || self.revision.is_empty())
        {
            return Err("Open configuration before saving.".into());
        }
        Ok(())
    }
}
struct Review {
    source: Request,
    payload: Zeroizing<String>,
    issued: Instant,
}
#[derive(Default)]
pub struct ProxyWorkspaceState {
    reviews: Mutex<HashMap<String, Review>>,
    busy: Mutex<HashSet<String>>,
}
struct Lease<'a>(&'a ProxyWorkspaceState, String);
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut busy) = self.0.busy.lock() {
            busy.remove(&self.1);
        }
    }
}
async fn identity(service: &SshService, r: &Request) -> Result<(), String> {
    if service.profile(&r.profile_id)?.revision != r.profile_revision
        || service
            .runtime
            .lock()
            .await
            .connection_ids
            .get(&r.profile_id)
            != Some(&r.connection_id)
    {
        return Err("Server connection changed. Detect proxies again.".into());
    }
    Ok(())
}
fn script() -> String {
    format!(
        "WORKER = {}\nROOT_PROTOCOL = {}\n{}",
        serde_json::to_string(include_str!("proxy_workspace.py")).unwrap(),
        serde_json::to_string(include_str!("proxy_privileged.py")).unwrap(),
        include_str!("proxy_transport.py")
    )
}
async fn execute(
    service: &SshService,
    r: &Request,
    payload: &str,
) -> Result<serde_json::Value, String> {
    identity(service, r).await?;
    let mut channel = {
        let runtime = service.runtime.lock().await;
        if runtime.connection_ids.get(&r.profile_id) != Some(&r.connection_id) {
            return Err("Connection changed.".into());
        }
        let handle = runtime
            .connections
            .get(&r.profile_id)
            .ok_or("Connect first.")?;
        timeout(NETWORK_TIMEOUT, handle.channel_open_session())
            .await
            .map_err(|_| "Proxy channel timed out.")?
            .map_err(|_| "Cannot open proxy channel.")?
    };
    let result = timeout(Duration::from_secs(190), async {
        channel
            .exec(
                true,
                format!(
                    "/usr/bin/python3 -I -S -u -c {}",
                    super::docker::quoted(&script())
                ),
            )
            .await
            .map_err(|_| "Cannot start proxy worker.")?;
        channel
            .data(payload.as_bytes())
            .await
            .map_err(|_| "Cannot send private proxy request.")?;
        channel
            .eof()
            .await
            .map_err(|_| "Cannot close proxy input.")?;
        let mut bytes = Zeroizing::new(Vec::new());
        let mut code = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if bytes.len() + data.len() > 3 * 1024 * 1024 {
                        return Err(
                            "Proxy output limit exceeded. Inspect before retrying.".to_string()
                        );
                    }
                    bytes.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                _ => {}
            }
        }
        if code != Some(0) {
            return Err("Proxy worker failed. Inspect before retrying.".into());
        }
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid proxy response.")?;
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            return Err(error.chars().take(16000).collect());
        }
        Ok(value)
    })
    .await
    .unwrap_or_else(|_| Err("Proxy operation timed out. Inspect before retrying.".to_string()));
    let _ = timeout(NETWORK_TIMEOUT, channel.close()).await;
    identity(service, r).await?;
    result
}
#[tauri::command]
pub async fn ssh_proxy_workspace_review(
    service: tauri::State<'_, SshService>,
    state: tauri::State<'_, ProxyWorkspaceState>,
    request: Request,
) -> Result<serde_json::Value, String> {
    request.validate()?;
    identity(&service, &request).await?;
    let payload =
        Zeroizing::new(serde_json::to_string(&request).map_err(|_| "Invalid proxy request.")?);
    let mut reviews = state
        .reviews
        .lock()
        .map_err(|_| "Proxy reviews unavailable.")?;
    reviews.retain(|_, v| v.issued.elapsed() < Duration::from_secs(120));
    if reviews.len() >= 30 {
        return Err("Close old proxy reviews before continuing.".into());
    }
    let id = Uuid::new_v4().to_string();
    let operation = serde_json::to_value(request.operation).unwrap();
    let plan = serde_json::json!({"id":id,"operation":operation,"instanceId":request.instance_id,"path":request.path,"privileged":request.operation != Operation::Inspect,
        "command":if request.operation == Operation::Inspect { "Read systemd and Docker proxy inventory".into() } else { format!("sudo -S -p '[VPS Pilot proxy sudo] ' -- /usr/bin/python3 -I -S -u -c {}",super::docker::quoted(&(include_str!("proxy_workspace.py").to_string()+"\n"+include_str!("proxy_privileged.py")))) },"expiresInSeconds":120});
    // Keep the secret-bearing serialized payload zeroized; don't duplicate it in source metadata.
    let mut source = request;
    source.content.zeroize();
    reviews.insert(
        id,
        Review {
            source,
            payload,
            issued: Instant::now(),
        },
    );
    Ok(plan)
}
#[tauri::command]
pub async fn ssh_proxy_workspace_reject(
    state: tauri::State<'_, ProxyWorkspaceState>,
    review_id: String,
) -> Result<(), String> {
    state
        .reviews
        .lock()
        .map_err(|_| "Proxy reviews unavailable.")?
        .remove(&review_id);
    Ok(())
}
#[tauri::command]
pub async fn ssh_proxy_workspace_execute(
    service: tauri::State<'_, SshService>,
    state: tauri::State<'_, ProxyWorkspaceState>,
    review_id: String,
    password: String,
    acknowledge_traefik: bool,
) -> Result<serde_json::Value, String> {
    let password = Zeroizing::new(password);
    if password.len() > 4096 || password.contains(['\r', '\n', '\0']) {
        return Err("Invalid sudo password.".into());
    }
    let review = state
        .reviews
        .lock()
        .map_err(|_| "Proxy reviews unavailable.")?
        .remove(&review_id)
        .ok_or("Proxy approval expired. Review again.")?;
    if review.issued.elapsed() >= Duration::from_secs(120) {
        return Err("Proxy approval expired. Review again.".into());
    }
    identity(&service, &review.source).await?;
    {
        let mut busy = state.busy.lock().map_err(|_| "Proxy state unavailable.")?;
        if busy.len() >= 4 || !busy.insert(review.source.profile_id.clone()) {
            return Err("A proxy operation is already running. Wait for its result.".into());
        }
    }
    let _lease = Lease(&state, review.source.profile_id.clone());
    let mut value: serde_json::Value =
        serde_json::from_str(&review.payload).map_err(|_| "Invalid private proxy request.")?;
    value["acknowledgeTraefik"] = serde_json::Value::Bool(acknowledge_traefik);
    value["password"] = serde_json::Value::String(password.to_string());
    let payload = Zeroizing::new(
        serde_json::to_string(&value).map_err(|_| "Invalid private proxy request.")? + "\n",
    );
    drop(value);
    execute(&service, &review.source, &payload).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_untyped_targets_and_unbounded_configs() {
        let mut r:Request=serde_json::from_value(serde_json::json!({"profileId":"p","profileRevision":"r","connectionId":"c","operation":"open","instanceId":"system:sshd","identity":"a".repeat(64)})).unwrap();
        assert!(r.validate().is_err());
        r.instance_id = "system:nginx".into();
        assert!(r.validate().is_ok());
        r.content = "a".repeat(262145);
        assert!(r.validate().is_err());
        assert!(serde_json::from_str::<Operation>("\"stop\"").is_err());
    }
    #[test]
    fn worker_command_never_contains_request_content() {
        let code = script();
        assert!(code.contains("sys.stdin"));
        assert!(!code.contains("fixture-secret-token"));
    }
}
