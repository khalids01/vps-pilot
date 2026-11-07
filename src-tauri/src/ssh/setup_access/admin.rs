//! Reviewed staged-administrator creation or adoption.
//!
//! The target account is derived natively from the saved profile and the live
//! authenticated channel. Only an existing root connection may reach this
//! adapter, and only a narrow supported Debian/Ubuntu path is accepted. A new
//! account receives the requested sudo password on stdin; an existing account is
//! adopted without touching its password, groups or sudoers. No SSH daemon,
//! port, firewall or package change is made. The helper validates system
//! sudoers before reporting success.

use super::{
    validate_source, AdminProof, HostKey, Profile, SetupAdminProof, SshService, NETWORK_TIMEOUT,
    PROOF_LIFETIME,
};
use crate::setup_keys::{KeyLocation, KeyVault, ResolvedInstallKey};
use crate::ssh::ProfileInput;
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::time::timeout;
use uuid::Uuid;
use zeroize::Zeroizing;

pub(crate) const SCRIPT: &str = include_str!("admin_access.py");
const MAX_OUTPUT: usize = 16 * 1024;
const REVIEW_LIFETIME: Duration = Duration::from_secs(180);
const MAX_REVIEWS: usize = 50;
const RUN_TIMEOUT: Duration = Duration::from_secs(40);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PASSWORD_BYTES: usize = 4096;
const PURPOSE: &str = "Create or adopt the planned non-root administrator on this supported Debian/Ubuntu server. A new account receives the requested sudo password; an existing account is adopted unchanged. The system sudoers file is validated. SSH keys, the SSH port, sshd settings and the firewall are not changed.";

pub(crate) fn command() -> String {
    format!(
        "exec python3 -I -S -B -u -c '{}'",
        SCRIPT.replace('\'', "'\\''")
    )
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdminSnapshot {
    pub username: String,
    pub exists: bool,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
    pub shell: String,
    pub home_exists: bool,
    pub home_mode: u32,
    pub home_uid: u32,
    pub password_locked: bool,
}

pub struct AdminRequest {
    pub profile_id: String,
    pub profile_revision: String,
    pub connection_id: String,
    pub key_id: String,
    pub username: String,
    pub mode: String,
}

pub struct AdminApplyRequest {
    pub review_id: String,
    pub password: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminReview {
    pub review_id: String,
    pub profile_id: String,
    pub profile_revision: String,
    pub connection_id: String,
    pub key_id: String,
    pub key_fingerprint: String,
    pub source_username: String,
    pub username: String,
    pub host: String,
    pub port: u16,
    pub os_id: String,
    pub os_version: String,
    pub planned_home: String,
    pub action: &'static str,
    pub home: Option<String>,
    pub command: String,
    pub purpose: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminApplyResult {
    pub status: &'static str,
    pub username: String,
    pub source_username: String,
    pub os_id: String,
    pub os_version: String,
}

struct Review {
    id: String,
    profile_id: String,
    revision: String,
    connection_id: String,
    key_id: String,
    key_fingerprint: String,
    key_digest: [u8; 32],
    key_path: std::path::PathBuf,
    key_location: KeyLocation,
    host_key: HostKey,
    host: String,
    port: u16,
    source_username: String,
    username: String,
    mode: String,
    os_id: String,
    os_version: String,
    planned_home: String,
    snapshot: AdminSnapshot,
    deadline: Instant,
}

impl Review {
    fn view(&self) -> AdminReview {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        AdminReview {
            review_id: self.id.clone(),
            profile_id: self.profile_id.clone(),
            profile_revision: self.revision.clone(),
            connection_id: self.connection_id.clone(),
            key_id: self.key_id.clone(),
            key_fingerprint: self.key_fingerprint.clone(),
            source_username: self.source_username.clone(),
            username: self.username.clone(),
            host: self.host.clone(),
            port: self.port,
            os_id: self.os_id.clone(),
            os_version: self.os_version.clone(),
            planned_home: self.planned_home.clone(),
            action: if self.snapshot.exists {
                "adopt"
            } else {
                "create"
            },
            home: if self.snapshot.exists {
                Some(self.snapshot.home.clone())
            } else {
                None
            },
            command: command(),
            purpose: PURPOSE.into(),
            expires_at_ms: u64::try_from(now_ms.saturating_add(remaining.as_millis()))
                .unwrap_or(u64::MAX),
        }
    }
}

#[derive(Default)]
struct Inner {
    reviews: HashMap<String, Review>,
}

#[derive(Default)]
pub(crate) struct State {
    inner: Arc<Mutex<Inner>>,
}

impl State {
    fn insert(&self, review: Review) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Administrator review state is unavailable.".to_string())?;
        let now = Instant::now();
        inner.reviews.retain(|_, review| review.deadline > now);
        if inner.reviews.len() >= MAX_REVIEWS {
            if let Some(oldest) = inner
                .reviews
                .values()
                .min_by_key(|review| review.deadline)
                .map(|review| review.id.clone())
            {
                inner.reviews.remove(&oldest);
            }
        }
        inner.reviews.insert(review.id.clone(), review);
        Ok(())
    }

    fn take(&self, review_id: &str) -> Result<Review, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Administrator review state is unavailable.".to_string())?;
        let now = Instant::now();
        inner.reviews.retain(|_, review| review.deadline > now);
        inner.reviews.remove(review_id).ok_or_else(|| {
            "This administrator review expired or was already used. Create a new review."
                .to_string()
        })
    }

    fn remove(&self, review_id: &str) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Administrator review state is unavailable.".to_string())?;
        inner
            .reviews
            .retain(|_, review| review.deadline > Instant::now());
        if inner.reviews.remove(review_id).is_some() {
            Ok(())
        } else {
            Err("This administrator review expired or was already used.".into())
        }
    }

    fn remove_profile(&self, profile_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner
                .reviews
                .retain(|_, review| review.profile_id != profile_id);
        }
    }

    #[cfg(test)]
    pub(crate) fn expire_for_test(&self, review_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(review) = inner.reviews.get_mut(review_id) {
                review.deadline = Instant::now() - Duration::from_secs(1);
            }
        }
    }
}

fn validate_username(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 32
        && value != "root"
        && value
            .as_bytes()
            .first()
            .is_some_and(|first| first.is_ascii_lowercase() || *first == b'_')
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte)
        });
    if valid {
        Ok(())
    } else {
        Err("Use a valid non-root administrator name: 1-32 lowercase letters, digits, underscores or hyphens, starting with a letter or underscore.".into())
    }
}

fn validate_snapshot(snapshot: &AdminSnapshot) -> Result<(), String> {
    const INVALID: &str =
        "The administrator helper returned unsupported account state. Nothing was changed.";
    validate_username(&snapshot.username).map_err(|_| INVALID.to_string())?;
    if snapshot.exists {
        if snapshot.uid == 0
            || snapshot.uid > 60000
            || snapshot.gid > 60000
            || snapshot.home_mode > 0o7777
            || snapshot.home_mode & 0o022 != 0
            || snapshot.home_uid != snapshot.uid
            || !snapshot.home.starts_with('/')
            || snapshot.home == "/"
            || snapshot.home.len() > 4096
            || snapshot.home.chars().any(char::is_control)
            || snapshot.shell.len() > 512
            || snapshot.shell.chars().any(char::is_control)
        {
            return Err(INVALID.into());
        }
    } else if snapshot.uid != 0
        || snapshot.gid != 0
        || !snapshot.home.is_empty()
        || !snapshot.shell.is_empty()
        || snapshot.home_exists
        || snapshot.password_locked
    {
        return Err(INVALID.into());
    }
    Ok(())
}

fn reason_message(reason: &str, mutation: bool) -> String {
    let base = match reason {
        "unsupported_platform" => {
            "Administrator setup requires a supported Linux server with anchored file operations."
        }
        "unsupported_os" => {
            "Administrator setup is supported only on Debian 12+ or Ubuntu 22.04+ servers. Nothing was changed."
        }
        "account_exists" => {
            "An account with this name already exists. Choose the existing-account option, or pick another name. Nothing was changed."
        }
        "account_missing" => {
            "This account does not exist on the server. Choose the new-account option or verify the name. Nothing was changed."
        }
        "privilege_required" => {
            "Administrator setup must run over the existing root connection. Connect as root first."
        }
        "missing_tools" => {
            "This server is missing the standard account tools (useradd, chpasswd, usermod or visudo). Nothing was changed."
        }
        "missing_sudo_group" => {
            "This server has no standard sudo group. Administrator setup was not applied."
        }
        "invalid_username" => "Use a valid non-root administrator name.",
        "home_collision" => {
            "The planned home directory already exists and was not created by this flow. It will not be reused or replaced. Nothing was changed."
        }
        "home_parent_invalid" => {
            "The standard /home parent is missing or unsafe. Nothing was changed."
        }
        "root_target" => "Root cannot be the planned administrator.",
        "home_invalid" => {
            "The administrator home directory is not a safe owned directory. Nothing was changed."
        }
        "invalid_request" => "The administrator request was rejected.",
        "password_required" => "Enter the sudo password for the new administrator account.",
        "password_too_large" => "The sudo password must be at most 4096 bytes.",
        "password_invalid" => "The sudo password must not contain line breaks or NUL characters.",
        "state_changed" => {
            "The server account changed since this review. Nothing was changed; create a new review."
        }
        "account_create_failed" => "The new administrator account could not be created.",
        "password_failed" => {
            "The administrator account was created, but its sudo password could not be set. The result is uncertain; inspect the account and do not retry automatically."
        }
        "sudo_group_failed" => {
            "The administrator account exists, but sudo group membership could not be added. Sudo is not verified."
        }
        "sudoers_invalid" => {
            "The system sudoers file did not validate. Review the account manually; sudo was not verified."
        }
        "account_unavailable" => "The planned administrator account could not be resolved.",
        "tool_failed" => {
            "A standard account tool failed. The result may be uncertain; inspect the account and do not retry automatically."
        }
        "io_error" => {
            "The administrator helper did not finish cleanly. The result may be uncertain; inspect the server."
        }
        _ => "The administrator helper rejected the request. Nothing was changed.",
    };
    if mutation && matches!(reason, "password_failed" | "tool_failed" | "io_error") {
        format!("{base} Do not retry automatically.")
    } else {
        base.to_string()
    }
}

fn parse_reply(
    bytes: &[u8],
    exit: Option<u32>,
    mutation: bool,
) -> Result<serde_json::Value, String> {
    let parsed = serde_json::from_slice::<serde_json::Value>(bytes).ok();
    if let Some(object) = parsed.as_ref().and_then(serde_json::Value::as_object) {
        if object.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
            let reason = object
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let code = reason;
            return Err(reason_message(code, mutation));
        }
    }
    if exit != Some(0) {
        return Err(if mutation {
            "The administrator helper did not finish successfully. Verify the account and do not retry automatically."
        } else {
            "The administrator helper did not finish successfully. No change was made."
        }
        .into());
    }
    let value = parsed.ok_or_else(|| {
        "The administrator helper returned an unsupported response. Nothing was changed."
            .to_string()
    })?;
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(if mutation {
            "The administrator helper did not confirm a result. Verify the account and do not retry automatically."
        } else {
            "The administrator helper did not confirm preparation. No change was made."
        }
        .into());
    }
    Ok(value)
}

async fn run(
    service: &SshService,
    profile_id: &str,
    connection_id: &str,
    payload: &serde_json::Value,
    mutation: bool,
) -> Result<serde_json::Value, String> {
    let body = Zeroizing::new(
        serde_json::to_vec(payload)
            .map_err(|_| "The administrator request could not be prepared.".to_string())?,
    );
    run_request(service, profile_id, connection_id, &body, mutation).await
}

async fn run_request(
    service: &SshService,
    profile_id: &str,
    connection_id: &str,
    body: &[u8],
    mutation: bool,
) -> Result<serde_json::Value, String> {
    let (mut channel, revision, username) = {
        let runtime = service.runtime.lock().await;
        if runtime.connection_ids.get(profile_id).map(String::as_str) != Some(connection_id) {
            return Err(
                "The server connection changed. Connect again and create a new review.".into(),
            );
        }
        let handle = runtime
            .connections
            .get(profile_id)
            .filter(|handle| !handle.is_closed())
            .ok_or_else(|| {
                "Connect to this server before setting up an administrator.".to_string()
            })?;
        let profile = service.profile(profile_id)?;
        let channel = timeout(NETWORK_TIMEOUT, handle.channel_open_session())
            .await
            .map_err(|_| "The administrator channel timed out. No change was made.".to_string())?
            .map_err(|_| {
                "Could not open an SSH session for administrator setup. No change was made."
                    .to_string()
            })?;
        (channel, profile.revision, profile.username)
    };
    let outcome = timeout(RUN_TIMEOUT, async {
        channel.exec(true, command()).await.map_err(|_| {
            "Could not start the bounded administrator helper. No change was made.".to_string()
        })?;
        channel.data(body).await.map_err(|_| {
            "Could not send the administrator request. No change was made.".to_string()
        })?;
        channel.eof().await.map_err(|_| {
            "Could not finish the administrator request. No change was made.".to_string()
        })?;
        let mut bytes = Vec::new();
        let mut exit = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if bytes.len() + data.len() > MAX_OUTPUT {
                        return Err(if mutation {
                            "The administrator helper returned more data than expected. Verify the server and do not retry automatically."
                        } else {
                            "The administrator helper returned more data than expected. No change was made."
                        }
                        .to_string());
                    }
                    bytes.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { .. } | ChannelMsg::Failure => {
                    return Err(if mutation {
                        "The server could not run the bounded administrator helper. Python 3 is required. Verify the server and do not retry automatically."
                    } else {
                        "The server could not run the bounded administrator helper. Python 3 is required. No change was made."
                    }
                    .to_string());
                }
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        parse_reply(&bytes, exit, mutation)
    })
    .await;
    let _ = timeout(CLOSE_TIMEOUT, channel.close()).await;
    let value = match outcome {
        Err(_) => return Err(if mutation {
            "The administrator request timed out. Verify the server and do not retry automatically."
        } else {
            "The administrator preparation timed out. No change was made."
        }
        .into()),
        Ok(result) => result?,
    };
    {
        let runtime = service.runtime.lock().await;
        if runtime.connection_ids.get(profile_id).map(String::as_str) != Some(connection_id)
            || !runtime
                .connections
                .get(profile_id)
                .is_some_and(|handle| !handle.is_closed())
        {
            return Err(if mutation {
                "The connection changed while the administrator helper ran. Verify the server and do not retry automatically."
            } else {
                "The connection changed during administrator preparation. No change was made."
            }
            .into());
        }
    }
    let profile = service.profile(profile_id)?;
    if profile.revision != revision || profile.username != username {
        return Err(if mutation {
            "The server profile changed while the administrator helper ran. Verify the server and do not retry automatically."
        } else {
            "The server profile changed during administrator preparation. No change was made."
        }
        .into());
    }
    Ok(value)
}

async fn prepare(
    service: &SshService,
    vault: &KeyVault,
    request: &AdminRequest,
) -> Result<(Profile, ResolvedInstallKey, HostKey), String> {
    prepare_source(
        service,
        vault,
        &request.profile_id,
        &request.profile_revision,
        &request.connection_id,
        &request.key_id,
        &request.username,
    )
    .await
}

async fn prepare_source(
    service: &SshService,
    vault: &KeyVault,
    profile_id: &str,
    revision: &str,
    connection_id: &str,
    key_id: &str,
    username: &str,
) -> Result<(Profile, ResolvedInstallKey, HostKey), String> {
    let (profile, metadata, host_key) =
        validate_source(service, vault, profile_id, revision, connection_id, key_id).await?;
    let key = vault.resolve_install_key_async(key_id).await?;
    if key.path != metadata.path
        || key.fingerprint != metadata.fingerprint
        || key.digest != metadata.digest
        || key.location != metadata.location
    {
        return Err(
            "The selected local key changed while it was being prepared. Try again.".into(),
        );
    }
    if profile.username != "root" {
        return Err(
            "Administrator setup uses the existing root connection. Connect this profile as root first."
                .into(),
        );
    }
    validate_username(username)?;
    if username == profile.username {
        return Err("Choose an administrator other than root.".into());
    }
    Ok((profile, key, host_key))
}

fn snapshot_from(value: &serde_json::Value) -> Result<AdminSnapshot, String> {
    serde_json::from_value::<AdminSnapshot>(value.clone()).map_err(|_| {
        "The administrator helper returned an unsupported response. Nothing was changed."
            .to_string()
    })
}

impl SshService {
    #[allow(clippy::too_many_arguments)]
    async fn recheck_admin_source(&self, vault: &KeyVault, review: &Review) -> Result<(), String> {
        let (profile, key, host_key) = validate_source(
            self,
            vault,
            &review.profile_id,
            &review.revision,
            &review.connection_id,
            &review.key_id,
        )
        .await
        .map_err(|_| {
            "The server connection, trusted identity or selected key changed. Create a new administrator review."
                .to_string()
        })?;
        let resolved = vault
            .resolve_install_key_async(&review.key_id)
            .await
            .map_err(|_| {
                "The selected local key changed. Create a new administrator review.".to_string()
            })?;
        if profile.username != review.source_username
            || profile.username != "root"
            || profile.host != review.host
            || profile.port != review.port
            || host_key != review.host_key
            || resolved.path != review.key_path
            || resolved.fingerprint != review.key_fingerprint
            || resolved.digest != review.key_digest
            || resolved.location != review.key_location
            || key.fingerprint != review.key_fingerprint
            || key.digest != review.key_digest
            || key.path != review.key_path
            || key.location != review.key_location
        {
            return Err(
                "The server connection, trusted identity or selected key changed during administrator setup. Create a new review."
                    .into(),
            );
        }
        Ok(())
    }

    pub(crate) async fn review_setup_admin(
        &self,
        vault: &KeyVault,
        request: AdminRequest,
    ) -> Result<AdminReview, String> {
        let (profile, key, host_key) = prepare(self, vault, &request).await?;
        if request.username == profile.username {
            return Err("Choose an administrator other than root.".into());
        }
        if !matches!(request.mode.as_str(), "new" | "existing") {
            return Err(
                "Choose whether to create a new administrator or use an existing account.".into(),
            );
        }
        let _guard = self.setup_access.begin(&request.profile_id)?;
        let payload = serde_json::json!({
            "mode": "review",
            "username": request.username,
            "requested": request.mode,
        });
        let reply = run(
            self,
            &request.profile_id,
            &request.connection_id,
            &payload,
            false,
        )
        .await?;
        let os_id = reply
            .get("osId")
            .and_then(serde_json::Value::as_str)
            .filter(|value| *value == "debian" || *value == "ubuntu")
            .ok_or_else(|| {
                "The server did not report a supported Debian or Ubuntu release. No change was made."
                    .to_string()
            })?
            .to_string();
        let os_version = reply
            .get("osVersion")
            .and_then(serde_json::Value::as_str)
            .filter(|value| value.len() <= 32 && !value.chars().any(char::is_control))
            .ok_or_else(|| {
                "The server returned an unsupported OS version. No change was made.".to_string()
            })?
            .to_string();
        let planned_home = reply
            .get("plannedHome")
            .and_then(serde_json::Value::as_str)
            .filter(|value| {
                // The privileged helper is the authority for the default home
                // (production HOME_ROOT is /home); bind its exact reviewed path.
                let path = std::path::Path::new(value);
                path.is_absolute()
                    && path.file_name().and_then(|name| name.to_str())
                        == Some(request.username.as_str())
                    && path.parent().is_some_and(|parent| parent != std::path::Path::new("/"))
                    && value.len() <= 4096
                    && !value.chars().any(char::is_control)
            })
            .ok_or_else(|| {
                "The administrator helper did not confirm the reviewed home path. No change was made."
                    .to_string()
            })?
            .to_string();
        let snapshot = snapshot_from(reply.get("snapshot").ok_or_else(|| {
            "The administrator helper returned an incomplete response. No change was made."
                .to_string()
        })?)?;
        validate_snapshot(&snapshot)?;
        if snapshot.username != request.username {
            return Err(
                "The reviewed account does not match the planned administrator. No change was made."
                    .into(),
            );
        }
        let review = Review {
            id: Uuid::new_v4().to_string(),
            profile_id: profile.id.clone(),
            revision: profile.revision.clone(),
            connection_id: request.connection_id,
            key_id: key.key_id,
            key_fingerprint: key.fingerprint,
            key_digest: key.digest,
            key_path: key.path.clone(),
            key_location: key.location,
            host_key,
            host: profile.host.clone(),
            port: profile.port,
            source_username: profile.username.clone(),
            username: request.username,
            mode: request.mode,
            os_id,
            os_version,
            planned_home,
            snapshot,
            deadline: Instant::now() + REVIEW_LIFETIME,
        };
        self.recheck_admin_source(vault, &review).await?;
        let view = review.view();
        self.setup_access.admin.insert(review)?;
        Ok(view)
    }

    pub(crate) async fn apply_setup_admin(
        &self,
        vault: &KeyVault,
        request: AdminApplyRequest,
    ) -> Result<AdminApplyResult, String> {
        let password = Zeroizing::new(request.password);
        if password.len() > MAX_PASSWORD_BYTES {
            return Err("The sudo password must be at most 4096 bytes.".into());
        }
        let review = self.setup_access.admin.take(&request.review_id)?;
        if Instant::now() >= review.deadline {
            return Err(
                "This administrator review expired. Nothing was changed; create a new review."
                    .into(),
            );
        }
        let _guard = self.setup_access.begin(&review.profile_id)?;
        let (profile, key, host_key) = prepare(
            self,
            vault,
            &AdminRequest {
                profile_id: review.profile_id.clone(),
                profile_revision: review.revision.clone(),
                connection_id: review.connection_id.clone(),
                key_id: review.key_id.clone(),
                username: review.username.clone(),
                mode: review.mode.clone(),
            },
        )
        .await?;
        if profile.revision != review.revision
            || profile.username != review.source_username
            || profile.host != review.host
            || profile.port != review.port
            || host_key != review.host_key
            || key.fingerprint != review.key_fingerprint
            || key.digest != review.key_digest
            || key.path != review.key_path
            || key.location != review.key_location
        {
            return Err(
                "The server or selected local key changed since this review. Nothing was changed; create a new review."
                    .into(),
            );
        }
        let expected = serde_json::to_value(&review.snapshot)
            .map_err(|_| "The reviewed account state could not be prepared.".to_string())?;
        let payload = Zeroizing::new(
            serde_json::json!({
                "mode": "apply",
                "username": review.username,
                "requested": review.mode,
                "password": password.as_str(),
                "expected": expected,
                "expectedHome": review.planned_home,
            })
            .to_string(),
        );
        // Any prior proof or sibling review describes the pre-change server.
        self.setup_access.clear_setup_evidence(&review.profile_id);
        self.setup_access.admin.remove_profile(&review.profile_id);
        let reply = run_request(
            self,
            &review.profile_id,
            &review.connection_id,
            payload.as_bytes(),
            true,
        )
        .await?;
        let status = match reply.get("account").and_then(serde_json::Value::as_str) {
            Some("created") if review.mode == "new" => "created",
            Some("adopted") if review.mode == "existing" => "adopted",
            Some(_) => {
                return Err(
                    "The administrator helper did not apply the reviewed new/existing choice. Verify the account."
                        .into(),
                )
            }
            _ => {
                return Err(
                    "The administrator helper returned an unsupported result. Verify the account."
                        .into(),
                )
            }
        };
        let final_snapshot = snapshot_from(reply.get("snapshot").ok_or_else(|| {
            "The administrator helper did not confirm the account state. Verify the account."
                .to_string()
        })?)?;
        if !final_snapshot.exists || final_snapshot.username != review.username {
            return Err(
                "The administrator helper did not confirm the planned account. Verify the account."
                    .into(),
            );
        }
        self.recheck_admin_source(vault, &review).await?;
        let os_id = reply
            .get("osId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&review.os_id)
            .to_string();
        Ok(AdminApplyResult {
            status,
            username: review.username,
            source_username: review.source_username,
            os_id,
            os_version: review.os_version,
        })
    }

    pub(crate) fn reject_setup_admin(&self, review_id: &str) -> Result<(), String> {
        self.setup_access.admin.remove(review_id)
    }
}

pub struct AdminVerifyRequest {
    pub profile_id: String,
    pub profile_revision: String,
    pub connection_id: String,
    pub key_id: String,
    pub username: String,
    pub passphrase: Option<String>,
    pub sudo_password: String,
}

pub(crate) const SUDO_TEST: &str = "exec /usr/bin/sudo -S -k -p '' -u root -- /usr/bin/id -u";

fn proof_binding(proof: &AdminProof, profile: &Profile, key: &ResolvedInstallKey) -> bool {
    proof.profile_id == profile.id
        && proof.revision == profile.revision
        && proof.source_username == profile.username
        && proof.host == profile.host
        && proof.port == profile.port
        && proof.key_id == key.key_id
        && proof.key_fingerprint == key.fingerprint
        && proof.key_digest == key.digest
        && proof.key_path == key.path
        && proof.key_location == key.location
}

impl SshService {
    /// Open a separate pinned-host connection as the planned administrator,
    /// authenticate with exactly the selected key (no password, agent or
    /// default-key fallback), then run a real sudo check over that channel. The
    /// source root session is untouched. This is the only evidence that
    /// certifies administrator access.
    pub(crate) async fn verify_setup_admin_access(
        &self,
        vault: &KeyVault,
        mut request: AdminVerifyRequest,
    ) -> Result<SetupAdminProof, String> {
        let passphrase = request.passphrase.take().map(Zeroizing::new);
        if passphrase
            .as_ref()
            .is_some_and(|value| value.len() > MAX_PASSWORD_BYTES)
        {
            return Err("The key passphrase must be at most 4096 bytes.".into());
        }
        let sudo_password = Zeroizing::new(std::mem::take(&mut request.sudo_password));
        if sudo_password.is_empty() {
            return Err(
                "Enter the administrator's sudo password to verify actual sudo access.".into(),
            );
        }
        if sudo_password.len() > MAX_PASSWORD_BYTES {
            return Err("The sudo password must be at most 4096 bytes.".into());
        }
        if sudo_password.contains(['\r', '\n', '\0']) {
            return Err("The sudo password must not contain line breaks or NUL characters.".into());
        }
        self.profile(&request.profile_id)?;
        let _guard = self.setup_access.begin(&request.profile_id)?;
        let result = self
            .verify_setup_admin_inner(vault, &request, passphrase, sudo_password)
            .await;
        if result.is_err() {
            self.setup_access.record_failure(&request.profile_id);
        }
        result
    }

    async fn verify_setup_admin_inner(
        &self,
        vault: &KeyVault,
        request: &AdminVerifyRequest,
        passphrase: Option<Zeroizing<String>>,
        sudo_password: Zeroizing<String>,
    ) -> Result<SetupAdminProof, String> {
        let (profile, key, expected) = prepare_source(
            self,
            vault,
            &request.profile_id,
            &request.profile_revision,
            &request.connection_id,
            &request.key_id,
            &request.username,
        )
        .await?;
        let passphrase = passphrase.filter(|value| !value.is_empty());
        let target_host = profile.host.clone();
        let port = profile.port;
        let observed = Arc::new(tokio::sync::Mutex::new(None));
        let handler = super::Client {
            expected: Some(expected.clone()),
            observed: observed.clone(),
        };
        let connecting = timeout(
            NETWORK_TIMEOUT,
            russh::client::connect(
                Arc::new(super::client_config()),
                (target_host.as_str(), port),
                handler,
            ),
        )
        .await;
        if observed
            .lock()
            .await
            .as_ref()
            .is_some_and(|identity| identity != &expected)
        {
            return Err(
                "The server presented a different host identity. Administrator access was not tested."
                    .into(),
            );
        }
        let mut handle = match connecting {
            Err(_) => return Err("The administrator test connection timed out.".into()),
            Ok(Err(_)) => {
                return Err(
                    "Could not open an independent administrator connection. Administrator access was not verified."
                        .into(),
                )
            }
            Ok(Ok(handle)) => handle,
        };
        let authentication = timeout(
            NETWORK_TIMEOUT,
            super::auth::authenticate_selected_key(
                &mut handle,
                &request.username,
                key.path.clone(),
                passphrase,
            ),
        )
        .await;
        let used_fingerprint = match authentication {
            Err(_) => {
                let _ = timeout(
                    Duration::from_secs(3),
                    handle.disconnect(Disconnect::ByApplication, "Administrator test", ""),
                )
                .await;
                return Err("Administrator key authentication timed out.".into());
            }
            Ok(Err(message)) => {
                let _ = timeout(
                    Duration::from_secs(3),
                    handle.disconnect(Disconnect::ByApplication, "Administrator test", ""),
                )
                .await;
                return Err(format!(
                    "{message} The public key may not be installed for {}; administrator access was not verified.",
                    request.username
                ));
            }
            Ok(Ok(fingerprint)) => fingerprint,
        };
        if used_fingerprint != key.fingerprint {
            let _ = timeout(
                Duration::from_secs(3),
                handle.disconnect(Disconnect::ByApplication, "Administrator test", ""),
            )
            .await;
            return Err(
                "The server accepted a different key than the selected local key. Administrator access was not verified."
                    .into(),
            );
        }
        let sudo_result = timeout(RUN_TIMEOUT, async {
            let mut channel = handle
                .channel_open_session()
                .await
                .map_err(|_| "Could not open a sudo test channel.".to_string())?;
            channel
                .exec(true, SUDO_TEST)
                .await
                .map_err(|_| "Could not start the sudo test.".to_string())?;
            channel
                .data(format!("{}\n", sudo_password.as_str()).as_bytes())
                .await
                .map_err(|_| "Could not send the sudo password.".to_string())?;
            channel
                .eof()
                .await
                .map_err(|_| "Could not finish the sudo test.".to_string())?;
            let mut exit = None;
            let mut output = Vec::new();
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        if output.len() + data.len() > 64 {
                            return Err(
                                "The sudo test returned unexpected output; sudo was not verified."
                                    .to_string(),
                            );
                        }
                        output.extend_from_slice(&data);
                    }
                    ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let _ = channel.close().await;
            Ok::<_, String>((exit, output))
        })
        .await;
        let (exit, output) = match sudo_result {
            Err(_) => return Err("The sudo test timed out. Sudo was not verified.".into()),
            Ok(result) => result?,
        };
        if exit != Some(0) || output != b"0\n" {
            let _ = timeout(
                Duration::from_secs(3),
                handle.disconnect(Disconnect::ByApplication, "Administrator test failed", ""),
            )
            .await;
            return Err(
                "The selected key logged in, but sudo to root did not succeed for this account. Group membership alone is not proof; administrator access was not verified."
                    .into(),
            );
        }
        let (profile_after, key_after, expected_after) = prepare_source(
            self,
            vault,
            &request.profile_id,
            &request.profile_revision,
            &request.connection_id,
            &request.key_id,
            &request.username,
        )
        .await?;
        if profile_after.host != target_host
            || profile_after.port != port
            || expected_after != expected
            || key_after.digest != key.digest
            || key_after.path != key.path
            || key_after.fingerprint != key.fingerprint
        {
            return Err(
                "The server, host identity or selected key changed during the administrator test. Access was not verified."
                    .into(),
            );
        }
        let proof = AdminProof {
            id: Uuid::new_v4().to_string(),
            profile_id: profile.id,
            revision: profile.revision,
            connection_id: request.connection_id.clone(),
            key_id: key.key_id,
            key_fingerprint: key.fingerprint,
            key_digest: key.digest,
            key_path: key.path,
            key_location: key.location,
            host_key: expected,
            host: target_host,
            source_username: profile.username,
            username: request.username.clone(),
            port,
            sudo_verified: true,
            deadline: Instant::now() + PROOF_LIFETIME,
        };
        if handle.is_closed() {
            return Err(
                "The verified administrator connection closed before it could be retained. Apply and verify access again."
                    .into(),
            );
        }
        let view = proof.view();
        self.setup_access.insert_admin_proof(proof)?;
        self.setup_access
            .insert_admin_handle(&view.proof_id, handle)?;
        Ok(view)
    }

    /// Promote the independently verified administrator into a separate saved
    /// profile and hand off the still-live verified connection. The original
    /// root profile, its trusted host identity and its live session remain. The
    /// proof (and its retained handle) is single-use, revalidated first, and kept
    /// on failure so persistence can be retried explicitly.
    pub(crate) async fn promote_setup_admin(
        &self,
        vault: &KeyVault,
        proof_id: &str,
    ) -> Result<super::SetupAdminPromotionResult, String> {
        let proof = self.setup_access.admin_proof(proof_id)?;
        // Serialize promotion with other setup operations for this server.
        let _guard = self.setup_access.begin(&proof.profile_id)?;
        let (profile, key, host_key) = prepare_source(
            self,
            vault,
            &proof.profile_id,
            &proof.revision,
            &proof.connection_id,
            &proof.key_id,
            &proof.username,
        )
        .await?;
        if !proof.sudo_verified
            || !proof_binding(&proof, &profile, &key)
            || host_key != proof.host_key
        {
            return Err(
                "The administrator proof no longer matches this server or selected key. Apply and verify access again."
                    .into(),
            );
        }
        let candidate = self.setup_access.take_admin_candidate(proof_id)?;
        if candidate.handle.is_closed() {
            let _ = self
                .setup_access
                .restore_admin_candidate(proof_id, candidate);
            return Err(
                "The verified administrator connection closed before access was promoted. Apply and verify access again."
                    .into(),
            );
        }
        let endpoint = format!("[{}]:{}", profile.host, profile.port);
        let pinned = (|| -> Result<(), String> {
            let mut store = self.store()?;
            let mut next = store.database()?.clone();
            match next.trusted_hosts.get(&endpoint) {
                Some(pin) if pin != &proof.host_key => {
                    return Err(
                        "The verified host identity no longer matches the saved pin. Apply and verify access again."
                            .into(),
                    )
                }
                Some(_) => {}
                None => {
                    // Pin only the identity the independent proof just verified;
                    // never trust an unverified endpoint.
                    next.trusted_hosts.insert(endpoint, proof.host_key.clone());
                    store.commit(next)?;
                }
            }
            Ok(())
        })();
        if let Err(error) = pinned {
            let _ = self
                .setup_access
                .restore_admin_candidate(proof_id, candidate);
            return Err(error);
        }
        let identity_path = key.path.to_string_lossy().into_owned();
        let base: String = profile.name.trim().chars().take(60).collect();
        let name = if base.is_empty() {
            format!("{} (administrator)", proof.username)
        } else {
            format!("{base} (administrator)")
        };
        let saved = match self
            .save_profile(ProfileInput {
                id: None,
                name,
                host: profile.host.clone(),
                port: profile.port,
                username: proof.username.clone(),
                identity_file: Some(identity_path),
                password_allowed: false,
            })
            .await
        {
            Ok(saved) => saved,
            Err(error) => {
                // Keep the verified connection and proof for an explicit retry;
                // nothing was promoted and the root profile is unchanged.
                let _ = self
                    .setup_access
                    .restore_admin_candidate(proof_id, candidate);
                return Err(format!(
                    "{error} The administrator is verified and its live connection was kept. Retry promoting access; the root profile is unchanged."
                ));
            }
        };
        if candidate.handle.is_closed() {
            // The profile is saved, so report honestly rather than claiming a
            // live handoff. The saved endpoint stays for a normal reconnect.
            let _ = self
                .setup_access
                .restore_admin_candidate(proof_id, candidate);
            let connection_id = String::new();
            return Ok(super::SetupAdminPromotionResult {
                profile: saved,
                previous_username: proof.source_username,
                source_profile_id: profile.id,
                connection_id,
                connected: false,
            });
        }
        let connection_id = Uuid::new_v4().to_string();
        {
            let mut runtime = self.runtime.lock().await;
            runtime
                .connection_ids
                .insert(saved.id.clone(), connection_id.clone());
            runtime
                .connections
                .insert(saved.id.clone(), candidate.handle);
            runtime.errors.remove(&saved.id);
        }
        Ok(super::SetupAdminPromotionResult {
            profile: saved,
            previous_username: proof.source_username,
            source_profile_id: profile.id,
            connection_id,
            connected: true,
        })
    }
}

#[cfg(all(unix, test))]
pub(crate) fn test_wrapper_source(home: &std::path::Path, user: &str) -> String {
    let home_literal = serde_json::to_string(home.to_str().unwrap()).unwrap();
    let user_literal = serde_json::to_string(user).unwrap();
    let script_literal = serde_json::to_string(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/ssh/setup_access/admin_access.py")
            .to_string_lossy()
            .into_owned(),
    )
    .unwrap();
    format!(
        r#"import builtins, grp, io, os, pwd, shutil
HOME = {home_literal}
HOME_ROOT = os.path.dirname(HOME)
NAME = {user_literal}
SCRIPT = {script_literal}
ACCOUNT_MARKER = os.path.join(HOME_ROOT, ".fixture-account-" + NAME)
STATE = {{"exists": os.path.exists(ACCOUNT_MARKER), "calls": []}}
os.geteuid = lambda: 0
class _Entry:
    pw_name = NAME
    pw_uid = os.getuid()
    pw_gid = os.getgid()
    pw_dir = HOME
    pw_shell = "/bin/bash"
def _getpwnam(name):
    if name != NAME or not STATE["exists"]:
        raise KeyError(name)
    return _Entry()
def _getpwuid(uid):
    if uid != os.getuid():
        raise KeyError(uid)
    return _Entry()
pwd.getpwnam = _getpwnam
pwd.getpwuid = _getpwuid
class _Group:
    gr_name = "sudo"
grp.getgrnam = lambda name: _Group()
shutil.which = lambda name: "/usr/bin/" + name
def _run(argv, stdin=None):
    STATE["calls"].append({{"argv": argv, "stdin": (stdin or b"").decode("utf-8", "replace")}})
    if argv[0] == "useradd":
        os.makedirs(HOME, mode=0o700, exist_ok=True)
        os.chmod(HOME, 0o700)
        STATE["exists"] = True
        with _real_open(ACCOUNT_MARKER, "w"):
            pass
    return (0, b"", b"")
_real_open = builtins.open
def _open(path, *args, **kwargs):
    if path == "/etc/os-release":
        return io.StringIO('ID=debian\nVERSION_ID="12"\n')
    return _real_open(path, *args, **kwargs)
builtins.open = _open
scope = {{"__name__": "fixture"}}
exec(compile(open(SCRIPT, "r", encoding="utf-8").read(), SCRIPT, "exec"), scope)
scope["run"] = _run
scope["shadow_locked"] = lambda name: False
scope["HOME_ROOT"] = HOME_ROOT
scope["HOME_OWNER_UID"] = os.getuid()
scope["main"]()
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        os::unix::fs::PermissionsExt,
        process::{Command, Stdio},
    };

    struct Fixture {
        home: std::path::PathBuf,
        wrapper: std::path::PathBuf,
    }

    impl Fixture {
        fn new(username: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
            let home = std::fs::canonicalize(dir.path()).unwrap().join(username);
            let wrapper = dir.path().join("admin-wrapper.py");
            std::fs::write(&wrapper, test_wrapper_source(&home, username)).unwrap();
            std::mem::forget(dir);
            Self { home, wrapper }
        }

        fn run(&self, request: &serde_json::Value) -> (serde_json::Value, i32, String) {
            let mut child = Command::new("python3")
                .arg(&self.wrapper)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let body = serde_json::to_string(request).unwrap();
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(body.as_bytes())
                .unwrap();
            drop(child.stdin.take());
            let output = child.wait_with_output().unwrap();
            (
                serde_json::from_slice(&output.stdout).unwrap_or(serde_json::Value::Null),
                output.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&output.stderr).into_owned(),
            )
        }
    }

    fn skip_without_python() -> bool {
        Command::new("python3")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| !status.success())
            .unwrap_or(true)
    }

    #[test]
    fn review_is_read_only_and_apply_creates_without_leaking_the_password() {
        if skip_without_python() {
            return;
        }
        let fixture = Fixture::new("deploy");
        let (review, code, stderr) = fixture.run(&serde_json::json!({
            "mode": "review",
            "username": "deploy",
            "requested": "new",
        }));
        assert_eq!(code, 0, "{review} {stderr}");
        assert_eq!(review["ok"], true);
        assert_eq!(review["account"], "create");
        assert_eq!(review["osId"], "debian");
        assert_eq!(review["snapshot"]["exists"], false);
        assert!(
            !fixture.home.exists(),
            "review must not create the account home"
        );

        let secret = "correct horse battery staple";
        let (applied, code, stderr) = fixture.run(&serde_json::json!({
            "mode": "apply",
            "username": "deploy",
            "requested": "new",
            "password": secret,
            "expected": review["snapshot"],
            "expectedHome": review["plannedHome"],
        }));
        assert_eq!(code, 0, "{applied} {stderr}");
        assert_eq!(applied["account"], "created");
        assert_eq!(applied["snapshot"]["exists"], true);
        assert!(fixture.home.is_dir());
        assert!(!applied.to_string().contains(secret));
        assert!(!stderr.contains(secret));
    }

    #[test]
    fn changed_expected_state_fails_closed_before_tooling() {
        if skip_without_python() {
            return;
        }
        let fixture = Fixture::new("deploy");
        let (review, code, _) = fixture.run(&serde_json::json!({
            "mode": "review",
            "username": "deploy",
            "requested": "new",
        }));
        assert_eq!(code, 0);
        let mut expected = review["snapshot"].clone();
        expected["exists"] = serde_json::Value::Bool(true);
        let (value, code, _) = fixture.run(&serde_json::json!({
            "mode": "apply",
            "username": "deploy",
            "requested": "existing",
            "password": "",
            "expected": expected,
            "expectedHome": review["plannedHome"],
        }));
        assert_ne!(code, 0);
        assert_eq!(value["reason"], "state_changed");
        assert!(
            !fixture.home.exists(),
            "a refused apply must not create the home"
        );
    }

    #[test]
    fn fresh_account_refuses_an_existing_home_collision_before_useradd() {
        if skip_without_python() {
            return;
        }
        let fixture = Fixture::new("deploy");
        // An orphan home already occupies the reviewed path.
        std::fs::create_dir(&fixture.home).unwrap();
        std::fs::set_permissions(&fixture.home, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (value, code, _) = fixture.run(&serde_json::json!({
            "mode": "review",
            "username": "deploy",
            "requested": "new",
        }));
        assert_ne!(code, 0);
        assert_eq!(value["reason"], "home_collision");
        assert!(
            std::fs::metadata(&fixture.home)
                .unwrap()
                .permissions()
                .mode()
                & 0o777
                == 0o755,
            "the existing directory must be untouched"
        );
    }

    #[test]
    fn unsupported_targets_are_rejected_before_any_tool_runs() {
        if skip_without_python() {
            return;
        }
        let fixture = Fixture::new("deploy");
        for username in ["root", "Deploy", "deploy;id"] {
            let (value, code, _) = fixture.run(&serde_json::json!({
                "mode": "review",
                "username": username,
                "requested": "new",
            }));
            assert_ne!(code, 0);
            assert_eq!(value["reason"], "invalid_username", "{username}");
        }
    }
}
