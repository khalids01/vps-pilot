//! Account-scoped PM2 inspection and reviewed, bounded deployment workflows.
use super::*;
use russh::ChannelMsg;
#[tauri::command]
pub async fn ssh_pm2_status(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    profile_revision: String,
    connection_id: String,
    process: Option<u32>,
) -> Result<serde_json::Value, String> {
    if service.profile(&profile_id)?.revision != profile_revision {
        return Err("Server changed. Refresh PM2.".into());
    }
    let mut channel = {
        let runtime = service.runtime.lock().await;
        if runtime.connection_ids.get(&profile_id) != Some(&connection_id) {
            return Err("Connection changed. Refresh PM2.".into());
        }
        let handle = runtime
            .connections
            .get(&profile_id)
            .ok_or("Connect first.")?;
        timeout(NETWORK_TIMEOUT, handle.channel_open_session())
            .await
            .map_err(|_| "PM2 channel timed out.")?
            .map_err(|_| "Cannot open PM2 channel.")?
    };
    let command = format!(
        "/usr/bin/python3 -I -S -c {} {}",
        super::docker::quoted(include_str!("pm2_probe.py")),
        process.map(|id| id.to_string()).unwrap_or_default()
    );
    let result = timeout(Duration::from_secs(30), async {
        channel
            .exec(true, command)
            .await
            .map_err(|_| "Cannot read PM2.")?;
        channel.eof().await.map_err(|_| "Cannot read PM2.")?;
        let mut output = Vec::new();
        let mut code = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if output.len() + data.len() > 262144 {
                        return Err("PM2 response exceeds its limit.");
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                _ => {}
            }
        }
        if code != Some(0) {
            return Err("PM2 status unavailable for this account.");
        }
        serde_json::from_slice(&output).map_err(|_| "Invalid PM2 response.")
    })
    .await;
    let _ = channel.close().await;
    result
        .map_err(|_| "PM2 status timed out.".to_string())?
        .map_err(str::to_string)
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Deployment {
    profile_id: String,
    profile_revision: String,
    connection_id: String,
    folder: String,
    process: u32,
    name: String,
    cwd: String,
    steps: Vec<String>,
    #[serde(default = "default_restart")]
    restart: bool,
}
#[derive(Default)]
pub struct Pm2State {
    reviews: Mutex<HashMap<String, (Deployment, Instant)>>,
    running: Mutex<std::collections::HashSet<String>>,
}
fn default_restart() -> bool {
    true
}
fn validate(d: &Deployment) -> Result<(), String> {
    if !d.folder.starts_with('/')
        || d.folder == "/"
        || d.folder.len() > 4096
        || d.folder.chars().any(char::is_control)
        || d.steps.iter().any(|s| {
            s.split(|c: char| !c.is_alphanumeric() && c != '_')
                .any(|word| word == "sudo")
        })
        || d.steps.len() > 20
        || d.steps.iter().map(String::len).sum::<usize>() > 60000
        || d.steps
            .iter()
            .any(|s| s.trim().is_empty() || s.len() > 4096 || s.contains('\0'))
        || d.name.len() > 256
        || d.cwd.len() > 4096
    {
        return Err("Invalid deployment settings.".into());
    }
    Ok(())
}
async fn identity(service: &SshService, d: &Deployment) -> Result<(), String> {
    if service.profile(&d.profile_id)?.revision != d.profile_revision {
        return Err("Server changed. Review again.".into());
    }
    let runtime = service.runtime.lock().await;
    if runtime.connection_ids.get(&d.profile_id) != Some(&d.connection_id) {
        return Err("Connection changed. Review again.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn ssh_pm2_review(
    service: tauri::State<'_, SshService>,
    state: tauri::State<'_, Pm2State>,
    deployment: Deployment,
) -> Result<String, String> {
    validate(&deployment)?;
    identity(&service, &deployment).await?;
    let mut reviews = state.reviews.lock().map_err(|_| "PM2 state unavailable.")?;
    reviews.retain(|_, (_, t)| t.elapsed() < Duration::from_secs(300));
    if reviews.len() >= 32 {
        return Err("Too many pending deployments.".into());
    }
    let id = Uuid::new_v4().to_string();
    reviews.insert(id.clone(), (deployment, Instant::now()));
    Ok(id)
}
struct RunLease<'a>(&'a Pm2State, String);
impl Drop for RunLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut running) = self.0.running.lock() {
            running.remove(&self.1);
        }
    }
}
#[tauri::command]
pub async fn ssh_pm2_apply(
    service: tauri::State<'_, SshService>,
    state: tauri::State<'_, Pm2State>,
    review_id: String,
    output: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    let (d, issued) = state
        .reviews
        .lock()
        .map_err(|_| "PM2 state unavailable.")?
        .remove(&review_id)
        .ok_or("Review expired.")?;
    if issued.elapsed() > Duration::from_secs(300) {
        return Err("Review expired.".into());
    }
    identity(&service, &d).await?;
    {
        let mut running = state.running.lock().map_err(|_| "PM2 state unavailable.")?;
        if running.len() >= 4 || !running.insert(d.profile_id.clone()) {
            return Err("Deployment already running on this server.".into());
        }
    }
    let _lease = RunLease(&state, d.profile_id.clone());
    let mut channel = {
        let runtime = service.runtime.lock().await;
        if runtime.connection_ids.get(&d.profile_id) != Some(&d.connection_id) {
            return Err("Connection changed.".into());
        }
        let handle = runtime
            .connections
            .get(&d.profile_id)
            .ok_or("Connect first.")?;
        timeout(NETWORK_TIMEOUT, handle.channel_open_session())
            .await
            .map_err(|_| "Channel timed out.")?
            .map_err(|_| "Cannot open deployment channel.")?
    };
    let payload=serde_json::to_string(&serde_json::json!({"folder":d.folder,"process":d.process,"name":d.name,"cwd":d.cwd,"steps":d.steps,"restart":d.restart})).map_err(|_|"Invalid deployment.")?+"\n";
    let result = timeout(Duration::from_secs(1800), async {
        channel
            .exec(
                true,
                format!(
                    "/usr/bin/python3 -I -S -u -c {}",
                    super::docker::quoted(include_str!("pm2_run.py"))
                ),
            )
            .await
            .map_err(|_| "Cannot start deployment.")?;
        channel
            .data(payload.as_bytes())
            .await
            .map_err(|_| "Cannot send deployment.")?;
        channel.eof().await.map_err(|_| "Cannot send deployment.")?;
        let mut pending = Vec::new();
        let mut bytes = 0;
        let mut code = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    bytes += data.len();
                    if bytes > 4 * 1024 * 1024 {
                        return Err(
                            "Deployment output limit reached; inspect the server before retrying.",
                        );
                    }
                    pending.extend_from_slice(&data);
                    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<_> = pending.drain(..=end).collect();
                        let value: serde_json::Value = serde_json::from_slice(&line)
                            .map_err(|_| "Invalid deployment response.")?;
                        output.send(value).map_err(|_| {
                            "Deployment view closed; inspect the server before retrying."
                        })?;
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                _ => {}
            }
        }
        if code == Some(0) {
            Ok(())
        } else {
            Err("Deployment stopped. Inspect the failed step before retrying.")
        }
    })
    .await;
    if !matches!(&result, Ok(Ok(()))) {
        let _ = channel.signal(russh::Sig::TERM).await;
    }
    let _ = channel.close().await;
    result
        .map_err(|_| "Deployment timed out; remote work may continue.".to_string())?
        .map_err(str::to_string)
}

const WORKFLOWS_KEY: &str = "pm2-workflows-v1";
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflows {
    version: u8,
    apps: Vec<SavedApp>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedApp {
    id: String,
    name: String,
    steps: Vec<SavedStep>,
    targets: Vec<SavedTarget>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedStep {
    id: String,
    text: String,
    enabled: bool,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedTarget {
    profile_id: String,
    folder: String,
    process: u32,
    name: String,
    cwd: String,
}
fn validate_workflows(value: &str) -> Result<(), String> {
    if value.len() > 128000 {
        return Err("Workflow limit exceeded.".into());
    }
    let doc: Workflows = serde_json::from_str(value).map_err(|_| "Invalid workflows.")?;
    if doc.version != 1 || doc.apps.len() > 50 {
        return Err("Invalid workflow version or app count.".into());
    }
    let mut ids = std::collections::HashSet::new();
    for app in doc.apps {
        if Uuid::parse_str(&app.id).is_err()
            || !ids.insert(app.id)
            || app.name.trim().is_empty()
            || app.name.len() > 100
            || app.steps.len() > 20
            || app.targets.len() > 100
        {
            return Err("Invalid app workflow.".into());
        }
        let mut servers = std::collections::HashSet::new();
        for target in app.targets {
            if Uuid::parse_str(&target.profile_id).is_err()
                || !servers.insert(target.profile_id.clone())
            {
                return Err("Duplicate or invalid server binding.".into());
            }
            validate(&Deployment {
                profile_id: target.profile_id,
                profile_revision: String::new(),
                connection_id: String::new(),
                folder: target.folder,
                process: target.process,
                name: target.name,
                cwd: target.cwd,
                steps: app.steps.iter().map(|s| s.text.clone()).collect(),
                restart: true,
            })?;
        }
        let mut step_ids = std::collections::HashSet::new();
        for step in app.steps {
            if Uuid::parse_str(&step.id).is_err()
                || !step_ids.insert(step.id)
                || step.text.trim().is_empty()
                || step.text.len() > 4096
                || step.text.contains('\0')
            {
                return Err("Invalid workflow command.".into());
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub fn ssh_pm2_workflows_load(
    db: tauri::State<'_, Arc<crate::database::LocalDatabase>>,
) -> Result<String, String> {
    let value = db.import(WORKFLOWS_KEY, "{\"version\":1,\"apps\":[]}")?;
    validate_workflows(&value)?;
    Ok(value)
}
#[tauri::command]
pub fn ssh_pm2_workflows_save(
    db: tauri::State<'_, Arc<crate::database::LocalDatabase>>,
    expected: String,
    value: String,
) -> Result<(), String> {
    validate_workflows(&value)?;
    db.compare_and_swap(WORKFLOWS_KEY, &expected, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn deployment() -> Deployment {
        Deployment {
            profile_id: Uuid::new_v4().to_string(),
            profile_revision: "revision".into(),
            connection_id: "connection".into(),
            folder: "/srv/app".into(),
            process: 0,
            name: "app".into(),
            cwd: "/srv/app".into(),
            steps: vec!["git pull --ff-only".into()],
            restart: true,
        }
    }
    #[test]
    fn helper_mode_is_explicit_and_legacy_deployments_keep_restart() {
        let d = deployment();
        let mut value = serde_json::to_value(&d).unwrap();
        value.as_object_mut().unwrap().remove("restart");
        assert!(
            serde_json::from_value::<Deployment>(value.clone())
                .unwrap()
                .restart
        );
        value["restart"] = serde_json::json!(false);
        assert!(
            !serde_json::from_value::<Deployment>(value.clone())
                .unwrap()
                .restart
        );
        value["restart"] = serde_json::json!("false");
        assert!(serde_json::from_value::<Deployment>(value).is_err());
    }
    #[test]
    fn validates_bounded_commands_and_absolute_folders() {
        let mut d = deployment();
        assert!(validate(&d).is_ok());
        d.folder = "/".into();
        assert!(validate(&d).is_err());
        d.folder = "/srv/app".into();
        d.steps = vec!["x".repeat(4097)];
        assert!(validate(&d).is_err());
        d.steps = vec!["echo ok\0".into()];
        assert!(validate(&d).is_err());
    }
    #[test]
    fn workflows_round_trip_and_reject_secrets_unknown_fields() {
        let id = Uuid::new_v4().to_string();
        let server = Uuid::new_v4().to_string();
        let value = serde_json::json!({"version":1,"apps":[{"id":id,"name":"Web","steps":[{"id":Uuid::new_v4().to_string(),"text":"bun run build","enabled":true}],"targets":[{"profileId":server,"folder":"/srv/web","process":1,"name":"web","cwd":"/srv/web"}]}]});
        assert!(validate_workflows(&value.to_string()).is_ok());
        let mut bad = value.clone();
        bad["apps"][0]["password"] = serde_json::json!("secret");
        assert!(validate_workflows(&bad.to_string()).is_err());
        let mut duplicate = value.clone();
        let t = duplicate["apps"][0]["targets"][0].clone();
        duplicate["apps"][0]["targets"]
            .as_array_mut()
            .unwrap()
            .push(t);
        assert!(validate_workflows(&duplicate.to_string()).is_err());
    }
    #[test]
    fn workflow_sqlite_compare_and_swap_preserves_newer_data() {
        let folder = std::env::temp_dir().join(format!("pm2-db-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let db = crate::database::LocalDatabase::open(&folder.join("db.sqlite")).unwrap();
        let initial = db
            .import(WORKFLOWS_KEY, "{\"version\":1,\"apps\":[]}")
            .unwrap();
        db.compare_and_swap(WORKFLOWS_KEY, &initial, "newer")
            .unwrap();
        assert!(db
            .compare_and_swap(WORKFLOWS_KEY, &initial, "stale")
            .is_err());
        assert_eq!(db.read(WORKFLOWS_KEY).unwrap().unwrap(), "newer");
        drop(db);
        let _ = std::fs::remove_dir_all(folder);
    }
}
