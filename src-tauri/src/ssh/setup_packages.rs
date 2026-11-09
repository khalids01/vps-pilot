//! Narrow signed-distribution-package adapter, isolated from generic action gates.
use super::*;
use crate::setup_keys::{KeyVault, ResolvedKeyMetadata};
use russh::ChannelMsg;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use tauri::ipc::Channel;

fn script() -> String {
    let user = serde_json::to_string(include_str!("setup_user_tools.py"))
        .expect("fixed source serialization");
    let stack =
        serde_json::to_string(include_str!("setup_stacks.py")).expect("fixed source serialization");
    let security = serde_json::to_string(include_str!("setup_security.py"))
        .expect("fixed source serialization");
    let core = format!(
        "USER_CODE = {user}\nSTACK_CODE = {stack}\nSECURITY_CODE = {security}\n{}",
        include_str!("setup_packages_core.py")
    );
    format!(
        "CORE = {}\nexec(CORE)\n{}",
        serde_json::to_string(&core).expect("fixed source serialization"),
        include_str!("setup_packages.py")
    )
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    profile_id: String,
    profile_revision: String,
    connection_id: String,
    items: Vec<String>,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    rules: Vec<Rule>,
    #[serde(default)]
    security: Option<SecurityIntent>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecurityIntent {
    key_id: String,
    port: u16,
    password_login: bool,
    root_login: bool,
    configure_firewall: bool,
    recovery_acknowledged: bool,
}

struct Observation {
    revision: String,
    connection_id: String,
    snapshot: String,
    deadline: Instant,
}
struct Candidate {
    profile: Profile,
    host_key: HostKey,
    handle: client::Handle<Client>,
    key_id: String,
    key_digest: [u8; 32],
    deadline: Instant,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    port: u16,
    protocol: String,
}
#[derive(Clone)]
struct Review {
    source: Source,
    deadline: Instant,
    plan: Option<Value>,
    key: Option<ResolvedKeyMetadata>,
}
#[derive(Default)]
pub struct PackageState {
    reviews: Mutex<HashMap<String, Review>>,
    busy: Mutex<HashSet<String>>,
    observations: Mutex<HashMap<String, Observation>>,
    candidates: tokio::sync::Mutex<HashMap<String, Candidate>>,
}
struct Lease<'a> {
    state: &'a PackageState,
    profile: String,
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut busy) = self.state.busy.lock() {
            busy.remove(&self.profile);
        }
    }
}
fn lease(state: &PackageState, profile: String) -> Result<Lease<'_>, String> {
    let mut busy = state.busy.lock().map_err(|_| "Setup state unavailable.")?;
    if busy.len() >= 4 || busy.contains(&profile) {
        return Err("Wait for the current setup operation on this server.".into());
    }
    busy.insert(profile.clone());
    Ok(Lease { state, profile })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    review_id: String,
    command: String,
    purpose: String,
    items: Vec<Value>,
    verification_commands: Vec<String>,
}
fn command() -> String {
    format!("/usr/bin/python3 -I -S -u -c {}", docker::quoted(&script()))
}
const IDS: &[&str] = &[
    "git",
    "curl",
    "ripgrep",
    "fd",
    "fzf",
    "jq",
    "btop",
    "unzip",
    "tmux",
    "bat",
    "eza",
    "rsync",
    "direnv",
    "python",
    "podman",
    "docker",
    "neovim",
    "bun",
    "uv",
    "go",
    "herdr",
    "nvm-node",
    "javascript-pm2",
    "dokploy",
    "lazyvim-starter",
    "ufw",
];
fn validate(source: &Source) -> Result<(), String> {
    if !["", "firewall-status", "firewall-apply", "security-apply"].contains(&source.kind.as_str())
        || source.rules.len() > 24
        || source
            .rules
            .iter()
            .any(|rule| rule.port == 0 || !["tcp", "udp"].contains(&rule.protocol.as_str()))
    {
        return Err("Invalid setup action.".into());
    }
    if (!source.kind.is_empty() && source.items != ["ufw"])
        || (source.kind.is_empty() && !source.rules.is_empty())
    {
        return Err("Setup action did not match its selection.".into());
    }
    if (source.kind == "security-apply") != source.security.is_some()
        || source.security.as_ref().is_some_and(|intent| {
            intent.port == 0
                || !intent.recovery_acknowledged
                || intent.key_id.is_empty()
                || intent.key_id.len() > 128
        })
    {
        return Err("Choose a key, valid SSH port and provider recovery access.".into());
    }
    if source.items.is_empty()
        || source.items.len() > 32
        || source
            .items
            .iter()
            .enumerate()
            .any(|(i, id)| !IDS.contains(&id.as_str()) || source.items[..i].contains(id))
    {
        return Err("Choose valid setup items.".into());
    }
    Ok(())
}
async fn identity(service: &SshService, source: &Source) -> Result<Profile, String> {
    validate(source)?;
    let profile = service.profile(&source.profile_id)?;
    let runtime = service.runtime.lock().await;
    if profile.revision != source.profile_revision
        || runtime.connection_ids.get(&source.profile_id) != Some(&source.connection_id)
        || runtime
            .connections
            .get(&source.profile_id)
            .is_none_or(|handle| handle.is_closed())
    {
        return Err("Connection changed. Refresh status before applying.".into());
    }
    Ok(profile)
}
#[allow(clippy::too_many_arguments)]
async fn call(
    service: &SshService,
    source: &Source,
    action: &str,
    password: Zeroizing<String>,
    plan: Option<&Value>,
    progress: Option<&Channel<Value>>,
    security: Option<&SecurityCredentials>,
    candidate: &mut Option<client::Handle<Client>>,
) -> Result<Value, String> {
    let profile = identity(service, source).await?;
    if password.len() > 4096 || password.contains(['\r', '\n', '\0']) {
        return Err("Sudo password must not contain line breaks or NUL characters.".into());
    }
    let mut request = serde_json::json!({"action":action,"items":source.items,"user":profile.username,"sudoPassword":password.as_str(),"rules":source.rules,"currentPort":profile.port,"profilePort":profile.port,"plan":plan,"security":source.security,"snapshot":plan.and_then(|value| value.get("snapshot"))});
    let payload = Zeroizing::new(
        serde_json::to_string(&request).map_err(|_| "Cannot prepare setup request.")? + "\n",
    );
    if let Some(Value::String(value)) = request.get_mut("sudoPassword") {
        use zeroize::Zeroize;
        value.zeroize();
    }
    drop(password);
    let mut channel = {
        let runtime = service.runtime.lock().await;
        if runtime.connection_ids.get(&source.profile_id) != Some(&source.connection_id) {
            return Err("Connection changed before applying.".into());
        }
        let handle = runtime
            .connections
            .get(&source.profile_id)
            .ok_or("Connect first.")?;
        timeout(NETWORK_TIMEOUT, handle.channel_open_session())
            .await
            .map_err(|_| "Setup channel timed out.")?
            .map_err(|_| "Cannot open setup channel.")?
    };
    let result = timeout(Duration::from_secs(if action == "security-apply" { 240 } else if action == "install" { 1800 } else if action == "prepare" { 600 } else { 90 }), async {
        channel.exec(true,command()).await.map_err(|_| "Cannot start setup action.")?;
        channel.data(payload.as_bytes()).await.map_err(|_| "Cannot send private setup request.")?;
        drop(payload);
        if action != "security-apply" { channel.eof().await.map_err(|_| "Cannot finish setup request.")?; }
        let mut pending = Vec::new();
        let mut total = 0;
        let mut code = None;
        let mut final_result = None;
        let mut expected_phase = "staged";
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    total += data.len();
                    if total > 131072 { return Err("Setup output exceeded its limit.".to_string()); }
                    pending.extend_from_slice(&data);
                    while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                        let line: Vec<_> = pending.drain(..=end).collect();
                        let value: Value = serde_json::from_slice(&line).map_err(|_| "Cannot read setup result. Python 3 is required on the server.")?;
                        if let Some(phase) = value.get("verify").and_then(Value::as_str) {
                            let credentials = security.ok_or("Unexpected access verification request.")?;
                            if phase != expected_phase { return Err("Invalid or repeated access verification stage.".into()); }
                            expected_phase = if phase == "staged" { "final" } else { "done" };
                            let intent = source.security.as_ref().ok_or("Missing SSH settings.")?;
                            if let Some(progress) = progress { let _ = progress.send(serde_json::json!({"phase":phase,"command":SUDO_VERIFY_COMMAND,"port":intent.port})); }
                            let handle = verify_access(service, source, intent.port, credentials).await?;
                            if let Some(progress) = progress { let _ = progress.send(serde_json::json!({"phase":format!("{phase}-verified")})); }
                            if phase == "final" { *candidate = Some(handle); }
                            channel.data(format!("{{\"continue\":\"{phase}\"}}\n").as_bytes()).await.map_err(|_| "Cannot confirm verified access. Remote recovery remains armed.")?;
                        } else if let Some(row) = value.get("progress") {
                            if !valid_row(row, &source.items, true) { return Err("Invalid installation progress.".into()); }
                            if let Some(progress) = progress { let _ = progress.send(row.clone()); }
                        } else if final_result.replace(value).is_some() {
                            return Err("Setup returned duplicate results.".into());
                        }
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Failure => return Err("Setup action refused.".into()),
                _ => {}
            }
        }
        if !pending.is_empty() { return Err("Setup response was interrupted. Check installed before retrying.".into()); }
        let value = final_result.ok_or("No setup result. Python 3 is required on the server.")?;
        if code != Some(0) || value.get("error").is_some() {
            return Err(value["error"].as_str().unwrap_or("Setup failed. Check installed before retrying.").to_string());
        }
        if action == "security-apply" && expected_phase != "done" { return Err("SSH settings were not independently verified at both checkpoints.".into()); }
        let items = value["items"].as_array().ok_or("Invalid setup result.")?;
        if action == "prepare" {
            if items.len() > 48 || !value["plan"].is_object() { return Err("Invalid installer plan.".into()); }
        } else if items.len() != source.items.len() || items.iter().enumerate().any(|(index,row)| row["id"].as_str() != Some(source.items[index].as_str()) || !valid_row(row, &source.items, false)) {
            return Err("Setup result did not match the selected items.".into());
        }
        if let Some(dependencies) = value.get("dependencies") {
            let allowed: Vec<String> = IDS.iter().map(|id| (*id).to_string()).chain(["ca-certificates", "xz-utils", "libatomic1", "build-essential"].iter().map(|id| (*id).to_string())).collect();
            let rows = dependencies.as_array().ok_or("Invalid dependency results.")?;
            if rows.len()>32 || rows.iter().any(|row| !valid_row(row, &allowed, false)) { return Err("Invalid dependency results.".into()); }
        }
        identity(service,source).await?;
        Ok(value)
    }).await.map_err(|_| "Setup timed out. Some packages may have changed; check installed before retrying.".to_string()).and_then(|result|result);
    let _ = channel.close().await;
    result
}
const SUDO_VERIFY_COMMAND: &str = "/usr/bin/sudo -S -k -p '' -- /usr/bin/id -u";
struct SecurityCredentials {
    key: ResolvedKeyMetadata,
    password: Zeroizing<String>,
    passphrase: Option<Zeroizing<String>>,
}
#[cfg(unix)]
async fn verify_access(
    service: &SshService,
    source: &Source,
    port: u16,
    credentials: &SecurityCredentials,
) -> Result<client::Handle<Client>, String> {
    let profile = identity(service, source).await?;
    let expected = service
        .store()?
        .database()?
        .trusted_hosts
        .get(&profile.endpoint())
        .cloned()
        .ok_or("Trust this server before migrating access.")?;
    let observed = Arc::new(AsyncMutex::new(None));
    let handler = Client {
        expected: Some(expected),
        observed,
    };
    let mut handle = timeout(
        NETWORK_TIMEOUT,
        client::connect(
            Arc::new(client_config()),
            (profile.host.as_str(), port),
            handler,
        ),
    )
    .await
    .map_err(|_| "New SSH connection timed out; remote recovery remains armed.")?
    .map_err(|_| {
        "Cannot connect to the verified host on the new port; remote recovery remains armed."
    })?;
    let fingerprint = timeout(
        NETWORK_TIMEOUT,
        auth::authenticate_selected_key(
            &mut handle,
            &profile.username,
            credentials.key.path.clone(),
            credentials
                .passphrase
                .as_ref()
                .map(|secret| Zeroizing::new(secret.to_string())),
        ),
    )
    .await
    .map_err(|_| "Key login timed out; remote recovery remains armed.")??;
    if fingerprint != credentials.key.fingerprint {
        return Err("The independent connection accepted a different key.".into());
    }
    let mut channel = timeout(NETWORK_TIMEOUT, handle.channel_open_session())
        .await
        .map_err(|_| "Sudo verification timed out.")?
        .map_err(|_| "Cannot verify sudo on new access.")?;
    let result = timeout(Duration::from_secs(30), async {
        channel
            .exec(true, SUDO_VERIFY_COMMAND)
            .await
            .map_err(|_| "Cannot start approved sudo verification.")?;
        let input = Zeroizing::new(format!("{}\n", credentials.password.as_str()));
        channel
            .data(input.as_bytes())
            .await
            .map_err(|_| "Cannot send private sudo verification input.")?;
        drop(input);
        channel
            .eof()
            .await
            .map_err(|_| "Cannot finish sudo verification input.")?;
        let mut output = Vec::new();
        let mut code = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if output.len() + data.len() > 128 {
                        return Err("Unexpected sudo verification output.");
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                _ => {}
            }
        }
        if code != Some(0) || output.as_slice() != b"0\n" {
            return Err("Sudo to root was not verified on the independent connection.");
        }
        Ok(())
    })
    .await
    .map_err(|_| "Independent sudo verification timed out.")?;
    let _ = channel.close().await;
    result.map_err(str::to_string)?;
    identity(service, source).await?;
    Ok(handle)
}

#[cfg(not(unix))]
async fn verify_access(
    _service: &SshService,
    _source: &Source,
    _port: u16,
    _credentials: &SecurityCredentials,
) -> Result<client::Handle<Client>, String> {
    Err("SSH migration requires protected local-key support on this desktop platform.".into())
}

#[tauri::command]
pub async fn ssh_setup_security_save(
    service: tauri::State<'_, SshService>,
    vault: tauri::State<'_, KeyVault>,
    state: tauri::State<'_, PackageState>,
    candidate_id: String,
) -> Result<Value, String> {
    let mut candidates = state.candidates.lock().await;
    let candidate = candidates
        .get(&candidate_id)
        .filter(|candidate| candidate.deadline > Instant::now() && !candidate.handle.is_closed())
        .ok_or("Verified connection expired. Reconnect using the new SSH settings.")?;
    let profile = candidate.profile.clone();
    let key = vault.resolve_metadata_async(&candidate.key_id).await?;
    if key.digest != candidate.key_digest
        || profile.identity_file.as_deref() != Some(key.path.to_string_lossy().as_ref())
    {
        return Err(
            "Local key changed after verification; the live connection is retained.".into(),
        );
    }
    {
        let mut store = service.store()?;
        let mut next = store.database()?.clone();
        if next.profiles.len() >= 100 {
            return Err("The maximum of 100 saved profiles was reached. Verified connection is kept; retry saving after removing an unused profile.".into());
        }
        if next
            .trusted_hosts
            .get(&profile.endpoint())
            .is_some_and(|key| key != &candidate.host_key)
        {
            return Err(
                "Saved host identity conflicts with the independently verified endpoint.".into(),
            );
        }
        next.trusted_hosts
            .insert(profile.endpoint(), candidate.host_key.clone());
        next.profiles.push(profile.clone());
        store
            .commit(next)
            .map_err(|error| format!("{error} Verified connection was kept; retry saving."))?;
    }
    let candidate = candidates
        .remove(&candidate_id)
        .ok_or("Verified connection unavailable.")?;
    drop(candidates);
    let id = Uuid::new_v4().to_string();
    let mut runtime = service.runtime.lock().await;
    runtime
        .connection_ids
        .insert(profile.id.clone(), id.clone());
    runtime
        .authentication_methods
        .insert(profile.id.clone(), "key");
    runtime.setup_access_verified.insert(
        profile.id.clone(),
        Instant::now() + Duration::from_secs(300),
    );
    runtime
        .connections
        .insert(profile.id.clone(), candidate.handle);
    Ok(serde_json::json!({"profile":profile,"connectionId":id}))
}

fn valid_row(row: &Value, ids: &[String], progress: bool) -> bool {
    row["id"]
        .as_str()
        .is_some_and(|id| ids.iter().any(|selected| selected == id))
        && row["status"].as_str().is_some_and(|status| {
            matches!(
                status,
                "installed" | "missing" | "unknown" | "conflict" | "failed"
            ) || (progress && status == "installing")
        })
        && row["message"]
            .as_str()
            .is_some_and(|message| message.len() <= 1024)
}

#[tauri::command]
pub fn ssh_setup_packages_command() -> String {
    command()
}
#[tauri::command]
pub async fn ssh_setup_packages_scan(
    service: tauri::State<'_, SshService>,
    state: tauri::State<'_, PackageState>,
    source: Source,
) -> Result<Value, String> {
    if !source.kind.is_empty() {
        return Err("Use the reviewed settings action.".into());
    }
    identity(&service, &source).await?;
    let _lease = lease(&state, source.profile_id.clone())?;
    call(
        &service,
        &source,
        "scan",
        Zeroizing::new(String::new()),
        None,
        None,
        None,
        &mut None,
    )
    .await
}
#[tauri::command]
pub async fn ssh_setup_packages_prepare(
    service: tauri::State<'_, SshService>,
    state: tauri::State<'_, PackageState>,
    vault: tauri::State<'_, KeyVault>,
    source: Source,
) -> Result<Approval, String> {
    identity(&service, &source).await?;
    let _lease = lease(&state, source.profile_id.clone())?;
    if source.kind == "firewall-apply" {
        return Err("Use the SSH/firewall transaction with independent access verification.".into());
    }
    let key = if let Some(intent) = &source.security {
        let profile = identity(&service, &source).await?;
        if profile.username == "root" {
            return Err("Switch to the verified non-root administrator first.".into());
        }
        let key = vault.resolve_metadata_async(&intent.key_id).await?;
        if key.location == crate::setup_keys::KeyLocation::Legacy {
            return Err("Copy the selected key to ~/.ssh before migrating access.".into());
        }
        Some(key)
    } else {
        None
    };
    let snapshot = if source.security.is_some() {
        let observations = state
            .observations
            .lock()
            .map_err(|_| "Setup state unavailable.")?;
        let observed = observations
            .get(&source.profile_id)
            .filter(|observed| {
                observed.revision == source.profile_revision
                    && observed.connection_id == source.connection_id
                    && observed.deadline > Instant::now()
            })
            .ok_or("Refresh current SSH/firewall status before applying.")?;
        Some(serde_json::json!({"snapshot":observed.snapshot}))
    } else {
        None
    };
    let resolved = if source.kind.is_empty() {
        Some(
            call(
                &service,
                &source,
                "prepare",
                Zeroizing::new(String::new()),
                None,
                None,
                None,
                &mut None,
            )
            .await?,
        )
    } else {
        None
    };
    let items = resolved
        .as_ref()
        .and_then(|value| value["items"].as_array())
        .cloned()
        .unwrap_or_default();
    let plan = resolved.map(|mut value| value["plan"].take()).or(snapshot);
    let verification_commands = if source.security.is_some() {
        vec![SUDO_VERIFY_COMMAND.into(); 3]
    } else {
        Vec::new()
    };
    let mut reviews = state
        .reviews
        .lock()
        .map_err(|_| "Setup state unavailable.")?;
    reviews.retain(|_, review| review.deadline > Instant::now());
    if reviews.len() >= 32 {
        return Err("Too many pending setup actions.".into());
    }
    let review_id = Uuid::new_v4().to_string();
    reviews.insert(
        review_id.clone(),
        Review {
            source,
            deadline: Instant::now() + Duration::from_secs(300),
            plan,
            key,
        },
    );
    Ok(Approval {
        review_id,
        command: command(),
        purpose: "Apply the reviewed settings and verify each result.".into(),
        items,
        verification_commands,
    })
}
#[tauri::command]
pub async fn ssh_setup_packages_apply(
    service: tauri::State<'_, SshService>,
    state: tauri::State<'_, PackageState>,
    review_id: String,
    sudo_password: String,
    on_progress: Channel<Value>,
    vault: tauri::State<'_, KeyVault>,
    key_passphrase: Option<String>,
) -> Result<Value, String> {
    let password = Zeroizing::new(sudo_password);
    let passphrase = key_passphrase.map(Zeroizing::new);
    if password.len() > 4096
        || password.contains(['\r', '\n', '\0'])
        || passphrase
            .as_ref()
            .is_some_and(|secret| secret.len() > 4096)
    {
        return Err("Credentials exceed their limit or contain invalid line breaks.".into());
    }
    let review = state
        .reviews
        .lock()
        .map_err(|_| "Setup state unavailable.")?
        .remove(&review_id)
        .ok_or("Apply request expired. Click Install selected again.")?;
    if review.deadline <= Instant::now() {
        return Err("Apply request expired. Click Install selected again.".into());
    }
    let _lease = lease(&state, review.source.profile_id.clone())?;
    let action = if review.source.kind.is_empty() {
        "install"
    } else {
        review.source.kind.as_str()
    };
    if review.source.security.is_some() {
        let mut candidates = state.candidates.lock().await;
        candidates.retain(|_, candidate| {
            candidate.deadline > Instant::now() && !candidate.handle.is_closed()
        });
        if candidates.len() >= 4 {
            return Err(
                "Save or close the pending verified connections before changing SSH settings."
                    .into(),
            );
        }
    }
    let credentials = if let Some(intent) = &review.source.security {
        let metadata = vault.resolve_metadata_async(&intent.key_id).await?;
        let reviewed = review.key.as_ref().ok_or("Missing reviewed key.")?;
        if metadata.digest != reviewed.digest
            || metadata.path != reviewed.path
            || metadata.fingerprint != reviewed.fingerprint
        {
            return Err("Selected key changed; prepare SSH settings again.".into());
        }
        Some(SecurityCredentials {
            key: metadata,
            password: Zeroizing::new(password.to_string()),
            passphrase,
        })
    } else {
        None
    };
    if let Some(credentials) = &credentials {
        let source = identity(&service, &review.source).await?;
        let _ = on_progress.send(
            serde_json::json!({"phase":"current","command":SUDO_VERIFY_COMMAND,"port":source.port}),
        );
        let _handle = verify_access(&service, &review.source, source.port, credentials).await?;
        let _ = on_progress.send(serde_json::json!({"phase":"current-verified"}));
    }
    let mut candidate = None;
    let mut result = call(
        &service,
        &review.source,
        action,
        password,
        review.plan.as_ref(),
        Some(&on_progress),
        credentials.as_ref(),
        &mut candidate,
    )
    .await?;
    if action == "firewall-status" {
        if let Some(snapshot) = result["items"][0]["snapshot"].as_str() {
            let mut observations = state
                .observations
                .lock()
                .map_err(|_| "Setup state unavailable.")?;
            observations.retain(|_, observation| observation.deadline > Instant::now());
            if observations.len() >= 100 {
                return Err("Too many setup observations.".into());
            }
            observations.insert(
                review.source.profile_id.clone(),
                Observation {
                    revision: review.source.profile_revision.clone(),
                    connection_id: review.source.connection_id.clone(),
                    snapshot: snapshot.into(),
                    deadline: Instant::now() + Duration::from_secs(300),
                },
            );
        }
    }
    if let (Some(intent), Some(credentials), Some(handle)) =
        (&review.source.security, credentials, candidate)
    {
        let key = vault.resolve_metadata_async(&intent.key_id).await?;
        if key.digest != credentials.key.digest {
            return Err("SSH settings applied, but local key changed before saving. Original connection was retained.".into());
        }
        let original = service.profile(&review.source.profile_id)?;
        let expected = service
            .store()?
            .database()?
            .trusted_hosts
            .get(&original.endpoint())
            .cloned()
            .ok_or("Trusted server identity is unavailable.")?;
        let mut profile = original;
        profile.id = Uuid::new_v4().to_string();
        profile.revision = Uuid::new_v4().to_string();
        profile.name = format!(
            "{} (SSH {})",
            profile.name.chars().take(55).collect::<String>(),
            intent.port
        );
        profile.port = intent.port;
        profile.identity_file = Some(key.path.to_string_lossy().into_owned());
        profile.password_allowed = intent.password_login;
        let candidate_id = Uuid::new_v4().to_string();
        let mut candidates = state.candidates.lock().await;
        candidates.retain(|_, candidate| {
            candidate.deadline > Instant::now() && !candidate.handle.is_closed()
        });
        if candidates.len() >= 4 {
            return Err("SSH settings applied. Too many pending saved connections; original session was kept.".into());
        }
        candidates.insert(
            candidate_id.clone(),
            Candidate {
                profile,
                host_key: expected,
                handle,
                key_id: intent.key_id.clone(),
                key_digest: key.digest,
                deadline: Instant::now() + Duration::from_secs(900),
            },
        );
        result["candidateId"] = Value::String(candidate_id);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Source {
        serde_json::from_value(serde_json::json!({"profileId":"fixture","profileRevision":"revision","connectionId":"connection","items":["git"]})).unwrap()
    }
    #[test]
    fn only_fixed_items_and_action_matched_firewall_rules_are_accepted() {
        let mut source = source();
        validate(&source).unwrap();
        source.items = vec!["git; touch BAD".into()];
        assert!(validate(&source).is_err());
        source.items = vec!["git".into(), "git".into()];
        assert!(validate(&source).is_err());
        source.items = vec!["git".into()];
        source.kind = "firewall-apply".into();
        assert!(validate(&source).is_err());
        source.items = vec!["ufw".into()];
        source.rules = vec![Rule {
            port: 22,
            protocol: "tcp".into(),
        }];
        validate(&source).unwrap();
        source.rules[0].protocol = "tcp;reboot".into();
        assert!(validate(&source).is_err());
    }
    #[test]
    fn security_reviews_require_explicit_recovery_and_reject_freeform_inputs() {
        let mut value = serde_json::json!({"profileId":"fixture","profileRevision":"revision","connectionId":"connection","items":["ufw"],"kind":"security-apply","security":{"keyId":"opaque-key","port":52022,"passwordLogin":false,"rootLogin":false,"configureFirewall":true,"recoveryAcknowledged":true}});
        validate(&serde_json::from_value::<Source>(value.clone()).unwrap()).unwrap();
        value["security"]["recoveryAcknowledged"] = Value::Bool(false);
        assert!(validate(&serde_json::from_value::<Source>(value.clone()).unwrap()).is_err());
        value["security"]["recoveryAcknowledged"] = Value::Bool(true);
        value["security"]["port"] = serde_json::json!(0);
        assert!(validate(&serde_json::from_value::<Source>(value.clone()).unwrap()).is_err());
        value["security"]["port"] = serde_json::json!(52022);
        value["security"]["command"] = Value::String("untrusted".into());
        assert!(serde_json::from_value::<Source>(value).is_err());
    }
    #[test]
    fn progress_cannot_inject_other_items_or_final_installing_claims() {
        let ids = vec!["git".to_string()];
        let mut row = serde_json::json!({"id":"git","status":"installing","message":""});
        assert!(valid_row(&row, &ids, true));
        assert!(!valid_row(&row, &ids, false));
        row["id"] = Value::String("docker".into());
        assert!(!valid_row(&row, &ids, true));
        row["id"] = Value::String("git".into());
        row["message"] = Value::String("x".repeat(1025));
        assert!(!valid_row(&row, &ids, true));
    }
    #[test]
    fn setup_operations_serialize_per_server_and_release_on_failure() {
        let state = PackageState::default();
        let first = lease(&state, "first".into()).unwrap();
        assert!(lease(&state, "first".into()).is_err());
        let _second = lease(&state, "second".into()).unwrap();
        drop(first);
        assert!(lease(&state, "first".into()).is_ok());
    }

    #[test]
    fn bundled_code_is_fixed_and_review_payload_rejects_credentials() {
        let value = serde_json::json!({"profileId":"fixture","profileRevision":"revision","connectionId":"connection","items":["git"],"password":"not-allowed"});
        assert!(serde_json::from_value::<Source>(value).is_err());
        let command = command();
        assert!(command.starts_with("/usr/bin/python3 -I -S -u -c '"));
        assert!(command.contains("AllowUnauthenticated=false"));
        assert!(command.contains("runuser"));
        assert!(command.contains("Persistent=true"));
        assert!(command.contains("AuthenticationMethods"));
        assert!(command.len() < 131072);
        assert!(!command.contains("not-allowed"));
    }
}
