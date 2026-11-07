//! Reviewed current-account public-key installation.
//!
//! A review is prepared from the existing authenticated SSH connection only. The
//! selected local key is resolved natively to its canonical OpenSSH public line;
//! no private bytes, passphrase, renderer path or key text is used. The fixed,
//! bounded helper runs over the current channel and reports only structured
//! metadata. Applying consumes a single-use review, revalidates the source
//! profile, connection, trusted host, key identity and the reviewed remote
//! snapshot, then appends only the selected public key for the current effective
//! account. The original session, password, port and firewall are untouched.

use super::{validate_source, HostKey, Profile, SshService, NETWORK_TIMEOUT};
use crate::setup_keys::{KeyLocation, KeyVault, ResolvedInstallKey};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::time::timeout;
use uuid::Uuid;

use super::{InstallRequest, SetupKeyInstallResult, SetupKeyInstallReview};

pub(crate) const SCRIPT: &str = include_str!("install_key.py");
const MAX_OUTPUT: usize = 16 * 1024;
const MAX_REMOTE_BYTES: u64 = 1024 * 1024;
const REVIEW_LIFETIME: Duration = Duration::from_secs(120);
const MAX_REVIEWS: usize = 100;
const INSTALL_TIMEOUT: Duration = Duration::from_secs(25);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const PURPOSE: &str = "Append the selected public key to the current account's ~/.ssh/authorized_keys. Existing keys, options and file bytes are preserved; an existing file is backed up first. No sudo, password, port, SSH daemon or firewall change is made. Installation alone does not prove key login, and a custom sshd AuthorizedKeysFile is not detected.";
const ADMIN_PURPOSE: &str = "Append the selected public key to the planned administrator's ~/.ssh/authorized_keys through the existing root connection. Existing keys, options and file bytes are preserved; an existing file is backed up first. No password, port, SSH daemon or firewall change is made. Installation alone does not prove key login; a separate key-only connection must verify sudo.";

/// The exact fixed command executed on the existing authenticated channel. The
/// selected public line and expected snapshot are sent on stdin only.
pub(crate) fn command() -> String {
    format!(
        "exec python3 -I -S -B -u -c '{}'",
        SCRIPT.replace('\'', "'\\''")
    )
}

/// The same bounded helper, but run as the staged administrator. Only a root
/// source connection may use this form; `runuser` takes the already-created
/// account without a password and the helper still resolves that user's home and
/// ownership from the kernel account record.
pub(crate) fn command_for(target: Option<&str>) -> String {
    match target {
        None => command(),
        Some(user) => {
            debug_assert!(user.bytes().all(|byte| byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || b"_-".contains(&byte)));
            format!(
                "exec runuser -u {} -- python3 -I -S -B -u -c '{}'",
                user,
                SCRIPT.replace('\'', "'\\''")
            )
        }
    }
}

/// Remote state captured by the read-only review and rechecked before apply.
/// Only bounded metadata is returned; existing authorized-key contents never
/// appear here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteSnapshot {
    username: String,
    home: String,
    home_uid: u32,
    home_mode: u32,
    home_dev: u64,
    home_ino: u64,
    ssh_exists: bool,
    ssh_uid: u32,
    ssh_mode: u32,
    ssh_dev: u64,
    ssh_ino: u64,
    file_exists: bool,
    file_uid: u32,
    file_mode: u32,
    file_size: u64,
    file_dev: u64,
    file_ino: u64,
    file_digest: String,
    already_present: bool,
    restricted_present: bool,
    append_newline: bool,
}

struct Review {
    id: String,
    profile_id: String,
    revision: String,
    connection_id: String,
    key_id: String,
    key_fingerprint: String,
    key_digest: [u8; 32],
    key_path: PathBuf,
    key_location: KeyLocation,
    host_key: HostKey,
    host: String,
    username: String,
    port: u16,
    destination: String,
    public_line: String,
    snapshot: RemoteSnapshot,
    target: Option<String>,
    deadline: Instant,
}

impl Review {
    fn view(&self) -> SetupKeyInstallReview {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        SetupKeyInstallReview {
            review_id: self.id.clone(),
            profile_id: self.profile_id.clone(),
            profile_revision: self.revision.clone(),
            connection_id: self.connection_id.clone(),
            key_id: self.key_id.clone(),
            key_fingerprint: self.key_fingerprint.clone(),
            username: self.target.clone().unwrap_or_else(|| self.username.clone()),
            host: self.host.clone(),
            port: self.port,
            destination: self.destination.clone(),
            command: command_for(self.target.as_deref()),
            purpose: if self.target.is_some() {
                ADMIN_PURPOSE.into()
            } else {
                PURPOSE.into()
            },
            already_present: self.snapshot.already_present,
            backup_planned: self.snapshot.file_exists && !self.snapshot.already_present,
            expires_at_ms: u64::try_from(now_ms.saturating_add(remaining.as_millis()))
                .unwrap_or(u64::MAX),
        }
    }
}

#[derive(Default)]
struct Inner {
    reviews: HashMap<String, Review>,
}

/// Bounded, memory-only install-review state owned by the shared setup state.
#[derive(Default)]
pub(crate) struct State {
    inner: Arc<Mutex<Inner>>,
}

impl State {
    fn insert(&self, review: Review) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Key installation state is unavailable.".to_string())?;
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
            .map_err(|_| "Key installation state is unavailable.".to_string())?;
        let now = Instant::now();
        inner.reviews.retain(|_, review| review.deadline > now);
        inner.reviews.remove(review_id).ok_or_else(|| {
            "This key installation review expired or was already used. Create a new review."
                .to_string()
        })
    }

    fn remove(&self, review_id: &str) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Key installation state is unavailable.".to_string())?;
        inner
            .reviews
            .retain(|_, review| review.deadline > Instant::now());
        if inner.reviews.remove(review_id).is_some() {
            Ok(())
        } else {
            Err("This key installation review expired or was already used.".into())
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

async fn validate_install_source(
    service: &SshService,
    vault: &KeyVault,
    profile_id: &str,
    revision: &str,
    connection_id: &str,
    key_id: &str,
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
    // OpenSSH authorized_keys lines are bounded to 8192 bytes including the
    // newline. Reject an oversized public line before any remote side effect.
    if key.public_line.is_empty()
        || key.public_line.len() > 8191
        || key.public_line.chars().any(char::is_control)
    {
        return Err(
            "The selected public key line is larger than the supported 8191-byte limit.".into(),
        );
    }
    Ok((profile, key, host_key))
}

fn hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_snapshot(snapshot: &RemoteSnapshot) -> Result<(), String> {
    let invalid = "The key installer returned unsupported remote state. Nothing was changed.";
    if snapshot.username.is_empty()
        || snapshot.username.len() > 64
        || snapshot.username.chars().any(char::is_control)
    {
        return Err(invalid.into());
    }
    if !snapshot.home.starts_with('/')
        || snapshot.home.len() > 4096
        || snapshot.home.chars().any(char::is_control)
    {
        return Err(invalid.into());
    }
    if snapshot.home_mode > 0o7777 || snapshot.home_mode & 0o022 != 0 {
        return Err(invalid.into());
    }
    if snapshot.ssh_mode > 0o7777 || snapshot.file_mode > 0o7777 {
        return Err(invalid.into());
    }
    if snapshot.ssh_exists && snapshot.ssh_mode & 0o022 != 0 {
        return Err(invalid.into());
    }
    if snapshot.file_size > MAX_REMOTE_BYTES {
        return Err(invalid.into());
    }
    if snapshot.file_exists {
        if !hex_digest(&snapshot.file_digest) {
            return Err(invalid.into());
        }
        if snapshot.file_mode & 0o022 != 0 {
            return Err(invalid.into());
        }
    } else if !snapshot.file_digest.is_empty() || snapshot.already_present {
        return Err(invalid.into());
    }
    if snapshot.restricted_present && !snapshot.already_present {
        return Err(invalid.into());
    }
    let _ = snapshot.append_newline;
    Ok(())
}

fn reason_message(reason: &str, mutation: bool) -> String {
    let base = match reason {
        "unsupported_platform" => {
            "Key installation requires a supported Linux account with anchored filesystem operations."
        }
        "input_too_large" => "The key installation request was too large.",
        "invalid_request" => "The key installation request was rejected.",
        "invalid_public_key" => "The selected public key is not a supported OpenSSH public key.",
        "account_unavailable" => {
            "The current server account could not be resolved. Only a standard Linux account is supported."
        }
        "home_invalid" => {
            "The current account's home directory is not a safe, owned directory. Nothing was changed."
        }
        "ssh_unsafe" => {
            "The current account's ~/.ssh directory is not a safe, private directory. Nothing was changed."
        }
        "file_unsafe" => {
            "The current account's authorized_keys file is not a safe regular file. Nothing was changed."
        }
        "file_too_large" => {
            "The current account's authorized_keys file is larger than the supported 1 MiB limit. Nothing was changed."
        }
        "malformed_keys" => {
            "The current account's authorized_keys file contains lines this installer cannot validate. Nothing was changed."
        }
        "state_changed" => {
            "The remote authorized_keys state changed since this review. Nothing was changed; create a new review."
        }
        "backup_failed" => {
            "A protected backup of the existing authorized_keys file could not be created. Nothing was changed."
        }
        "busy" => {
            "Another process is currently writing the authorized_keys file. Nothing was changed; wait and create a new review."
        }
        "append_failed" => "The selected public key could not be appended.",
        "newfile_exists" => {
            "A file or directory appeared while installing the public key. Nothing was overwritten."
        }
        _ => "The key installer rejected the request. Nothing was changed.",
    };
    if mutation && matches!(reason, "append_failed" | "io_error") {
        format!(
            "{base} The result may be uncertain; verify the remote file and do not retry automatically."
        )
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
            return Err(reason_message(reason, mutation));
        }
    }
    if exit != Some(0) {
        return Err(if mutation {
            "The key installer did not finish successfully. Verify the remote file and do not retry automatically."
        } else {
            "The key installer did not finish successfully. No change was made."
        }
        .into());
    }
    let value = parsed.ok_or_else(|| {
        "The key installer returned an unsupported response. Nothing was changed.".to_string()
    })?;
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(if mutation {
            "The key installer did not confirm a result. Verify the remote file and do not retry automatically."
        } else {
            "The key installer did not confirm preparation. No change was made."
        }
        .into());
    }
    Ok(value)
}

async fn run_script(
    service: &SshService,
    profile_id: &str,
    connection_id: &str,
    payload: &serde_json::Value,
    mutation: bool,
    target: Option<&str>,
) -> Result<serde_json::Value, String> {
    let body = serde_json::to_vec(payload)
        .map_err(|_| "The key installation request could not be prepared.".to_string())?;
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
            .ok_or_else(|| "Connect to this server before installing a public key.".to_string())?;
        let profile = service.profile(profile_id)?;
        let channel = timeout(NETWORK_TIMEOUT, handle.channel_open_session())
            .await
            .map_err(|_| "The key installation channel timed out. No change was made.".to_string())?
            .map_err(|_| {
                "Could not open an SSH session for key installation. No change was made."
                    .to_string()
            })?;
        (channel, profile.revision, profile.username)
    };
    let command = command_for(target);
    let outcome = timeout(INSTALL_TIMEOUT, async {
        channel.exec(true, command).await.map_err(|_| {
            "Could not start the bounded key installer. No change was made.".to_string()
        })?;
        channel.data(body.as_slice()).await.map_err(|_| {
            "Could not send the key installation request. No change was made.".to_string()
        })?;
        channel.eof().await.map_err(|_| {
            "Could not finish the key installation request. No change was made.".to_string()
        })?;
        let mut bytes = Vec::new();
        let mut exit = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if bytes.len() + data.len() > MAX_OUTPUT {
                        return Err(if mutation {
                            "The key installer returned more data than expected. Verify the remote file and do not retry automatically."
                        } else {
                            "The key installer returned more data than expected. No change was made."
                        }
                        .to_string());
                    }
                    bytes.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { .. } | ChannelMsg::Failure => {
                    return Err(if mutation {
                        "The server could not run the bounded key installer. Python 3 is required. Verify the remote file and do not retry automatically."
                    } else {
                        "The server could not run the bounded key installer. Python 3 is required. No change was made."
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
        Err(_) => {
            return Err(if mutation {
                "The key installation request timed out. Verify the remote file and do not retry automatically."
            } else {
                "The key installation preparation timed out. No change was made."
            }
            .into())
        }
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
                "The connection changed while the key installer ran. Verify the remote file and do not retry automatically."
            } else {
                "The connection changed during key installation preparation. No change was made."
            }
            .into());
        }
    }
    let profile = service.profile(profile_id)?;
    if profile.revision != revision || profile.username != username {
        return Err(if mutation {
            "The server profile changed while the key installer ran. Verify the remote file and do not retry automatically."
        } else {
            "The server profile changed during key installation preparation. No change was made."
        }
        .into());
    }
    Ok(value)
}

fn parse_apply(
    reply: &serde_json::Value,
    review: &Review,
) -> Result<SetupKeyInstallResult, String> {
    let status = reply
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let backup_path = match reply.get("backupPath") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(path)) => {
            if path.len() > 4096 || !path.starts_with('/') || path.chars().any(char::is_control) {
                return Err(
                    "The key installer returned an invalid backup path. Verify the remote file."
                        .into(),
                );
            }
            Some(path.clone())
        }
        _ => {
            return Err(
                "The key installer returned an unsupported response. Verify the remote file."
                    .into(),
            )
        }
    };
    let status = match status {
        "alreadyPresent" => {
            if backup_path.is_some() {
                return Err(
                    "The key installer reported an unexpected backup. Verify the remote file."
                        .into(),
                );
            }
            "alreadyPresent"
        }
        "installed" => {
            if review.snapshot.file_exists && backup_path.is_none() {
                return Err(
                    "The key installer did not report the protected backup it was required to create. Verify the remote file."
                        .into(),
                );
            }
            if !review.snapshot.file_exists && backup_path.is_some() {
                return Err(
                    "The key installer reported a backup for a new file. Verify the remote file."
                        .into(),
                );
            }
            "installed"
        }
        _ => {
            return Err(
                "The key installer returned an unsupported result. Verify the remote file.".into(),
            )
        }
    };
    Ok(SetupKeyInstallResult {
        status,
        backup_path,
        username: review
            .target
            .clone()
            .unwrap_or_else(|| review.username.clone()),
        port: review.port,
    })
}

impl SshService {
    pub(crate) async fn review_setup_key_install(
        &self,
        vault: &KeyVault,
        request: InstallRequest,
    ) -> Result<SetupKeyInstallReview, String> {
        let (profile, key, host_key) = validate_install_source(
            self,
            vault,
            &request.profile_id,
            &request.profile_revision,
            &request.connection_id,
            &request.key_id,
        )
        .await?;
        if profile.username.is_empty()
            || profile.username.len() > 64
            || profile.username.chars().any(char::is_control)
        {
            return Err(
                "The current server account name is not supported for key installation.".into(),
            );
        }
        let target = request.target_username.as_deref();
        if let Some(name) = target {
            if profile.username != "root" {
                return Err(
                    "Installing a key for another administrator requires the existing root connection."
                        .into(),
                );
            }
            let valid = !name.is_empty()
                && name.len() <= 32
                && name != "root"
                && name
                    .as_bytes()
                    .first()
                    .is_some_and(|first| first.is_ascii_lowercase() || *first == b'_')
                && name.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte)
                });
            if !valid {
                return Err("Use a valid planned administrator name.".into());
            }
        }
        let _guard = self.setup_access.begin(&request.profile_id)?;
        let payload = serde_json::json!({
            "mode": "review",
            "publicKey": key.public_line.clone(),
        });
        let reply = run_script(
            self,
            &request.profile_id,
            &request.connection_id,
            &payload,
            false,
            target,
        )
        .await?;
        let snapshot = reply
            .get("snapshot")
            .cloned()
            .ok_or_else(|| {
                "The key installer returned an incomplete response. No change was made.".to_string()
            })
            .and_then(|value| {
                serde_json::from_value::<RemoteSnapshot>(value).map_err(|_| {
                    "The key installer returned an unsupported response. No change was made."
                        .to_string()
                })
            })?;
        validate_snapshot(&snapshot)?;
        let expected_username = target.unwrap_or(profile.username.as_str());
        if snapshot.username != expected_username {
            return Err(if target.is_some() {
                "The reviewed remote account does not match the planned administrator. Key installation is supported only for the planned account."
                    .into()
            } else {
                "The connected server account does not match this profile. Key installation is supported only for the current effective account."
                    .into()
            });
        }
        let destination = format!(
            "{}/.ssh/authorized_keys",
            snapshot.home.trim_end_matches('/')
        );
        let review = Review {
            id: Uuid::new_v4().to_string(),
            profile_id: profile.id.clone(),
            revision: profile.revision.clone(),
            connection_id: request.connection_id,
            key_id: key.key_id,
            key_fingerprint: key.fingerprint,
            key_digest: key.digest,
            key_path: key.path,
            key_location: key.location,
            host_key,
            host: profile.host.clone(),
            username: profile.username.clone(),
            port: profile.port,
            destination,
            public_line: key.public_line,
            snapshot,
            target: target.map(str::to_string),
            deadline: Instant::now() + REVIEW_LIFETIME,
        };
        let view = review.view();
        self.setup_access.install.insert(review)?;
        Ok(view)
    }

    pub(crate) async fn apply_setup_key_install(
        &self,
        vault: &KeyVault,
        review_id: &str,
    ) -> Result<SetupKeyInstallResult, String> {
        // Single-use: the review is consumed before any side effect, including
        // validation failures and an unavailable connection.
        let review = self.setup_access.install.take(review_id)?;
        let _guard = self.setup_access.begin(&review.profile_id)?;
        if Instant::now() >= review.deadline {
            return Err(
                "This key installation review expired. Nothing was changed; create a new review."
                    .into(),
            );
        }
        let (profile, key, host_key) = validate_install_source(
            self,
            vault,
            &review.profile_id,
            &review.revision,
            &review.connection_id,
            &review.key_id,
        )
        .await?;
        if profile.revision != review.revision
            || profile.username != review.username
            || profile.host != review.host
            || profile.port != review.port
            || host_key != review.host_key
            || key.path != review.key_path
            || key.fingerprint != review.key_fingerprint
            || key.digest != review.key_digest
            || key.location != review.key_location
            || key.public_line != review.public_line
        {
            return Err(
                "The server or selected local key changed since this review. Nothing was changed; create a new review."
                    .into(),
            );
        }
        let expected = serde_json::to_value(&review.snapshot)
            .map_err(|_| "The reviewed remote state could not be prepared.".to_string())?;
        let payload = serde_json::json!({
            "mode": "apply",
            "publicKey": review.public_line.clone(),
            "expected": expected,
        });
        // Invalidate prior proofs, config reviews and sibling install reviews
        // before the mutation, so an uncertain result cannot leave evidence that
        // describes the previous server state.
        self.setup_access.clear_setup_evidence(&review.profile_id);
        self.setup_access.install.remove_profile(&review.profile_id);
        let reply = run_script(
            self,
            &review.profile_id,
            &review.connection_id,
            &payload,
            true,
            review.target.as_deref(),
        )
        .await?;
        // Recheck the full source binding after the mutation could have happened.
        // A changed server, trusted identity or local key means a "success" reply
        // cannot be reported as current.
        let unchanged = match validate_install_source(
            self,
            vault,
            &review.profile_id,
            &review.revision,
            &review.connection_id,
            &review.key_id,
        )
        .await
        {
            Ok((profile, key, host_key)) => {
                profile.revision == review.revision
                    && profile.username == review.username
                    && profile.host == review.host
                    && profile.port == review.port
                    && host_key == review.host_key
                    && key.path == review.key_path
                    && key.fingerprint == review.key_fingerprint
                    && key.digest == review.key_digest
                    && key.location == review.key_location
                    && key.public_line == review.public_line
            }
            Err(_) => false,
        };
        if !unchanged {
            return Err(
                "The server, trusted identity or selected key changed while the installer ran. The result may be uncertain; verify the remote file and do not retry automatically."
                    .into(),
            );
        }
        let result = parse_apply(&reply, &review)?;
        Ok(result)
    }

    pub(crate) fn reject_setup_key_install(&self, review_id: &str) -> Result<(), String> {
        self.setup_access.install.remove(review_id)
    }
}

#[cfg(all(unix, test))]
pub(crate) fn test_wrapper_source(
    home: &std::path::Path,
    user: &str,
    script: &std::path::Path,
) -> String {
    let home = serde_json::to_string(home.to_str().unwrap()).unwrap();
    let user = serde_json::to_string(user).unwrap();
    let script = serde_json::to_string(script.to_str().unwrap()).unwrap();
    format!(
        "import pwd\nHOME = {home}\nNAME = {user}\nSCRIPT = {script}\nclass _Entry:\n    def __init__(self, uid):\n        self.pw_uid = uid\n        self.pw_name = NAME\n        self.pw_dir = HOME\n_real = pwd.getpwuid\ndef _fake(uid):\n    _real(uid)\n    return _Entry(uid)\npwd.getpwuid = _fake\nsource = open(SCRIPT, 'r', encoding='utf-8').read()\nexec(compile(source, SCRIPT, 'exec'), {{'__name__': '__main__'}})\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::Write,
        os::unix::fs::{symlink, PermissionsExt},
        process::{Command, Stdio},
    };

    struct PythonFixture {
        dir: tempfile::TempDir,
        home: PathBuf,
        wrapper: PathBuf,
    }

    impl PythonFixture {
        fn new(username: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let home = dir.path().join("home");
            fs::create_dir(&home).unwrap();
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
            // macOS reports /var while the real path is /private/var; bind the
            // wrapper to the canonical temporary home only.
            let home = fs::canonicalize(&home).unwrap();
            let script = dir.path().join("install_key.py");
            fs::write(&script, SCRIPT).unwrap();
            let wrapper = dir.path().join("wrapper.py");
            let home_literal = serde_json::to_string(home.to_str().unwrap()).unwrap();
            let script_literal = serde_json::to_string(script.to_str().unwrap()).unwrap();
            let name_literal = serde_json::to_string(username).unwrap();
            fs::write(
                &wrapper,
                format!(
                    "import pwd\nHOME = {home_literal}\nNAME = {name_literal}\nSCRIPT = {script_literal}\nclass _Entry:\n    def __init__(self, uid):\n        self.pw_uid = uid\n        self.pw_name = NAME\n        self.pw_dir = HOME\n_real = pwd.getpwuid\ndef _fake(uid):\n    _real(uid)\n    return _Entry(uid)\npwd.getpwuid = _fake\nsource = open(SCRIPT, 'r', encoding='utf-8').read()\nexec(compile(source, SCRIPT, 'exec'), {{'__name__': '__main__'}})\n"
                ),
            )
            .unwrap();
            Self { dir, home, wrapper }
        }

        fn ssh(&self) -> PathBuf {
            self.home.join(".ssh")
        }

        fn write_key(&self, contents: &[u8], mode: u32) {
            fs::create_dir_all(self.ssh()).unwrap();
            fs::set_permissions(self.ssh(), fs::Permissions::from_mode(0o700)).unwrap();
            let path = self.ssh().join("authorized_keys");
            fs::write(&path, contents).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        }

        fn run(&self, request: &serde_json::Value) -> (serde_json::Value, i32) {
            let mut child = Command::new("python3")
                .arg(&self.wrapper)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(serde_json::to_string(request).unwrap().as_bytes())
                .unwrap();
            drop(child.stdin.take());
            let output = child.wait_with_output().unwrap();
            let value = serde_json::from_slice(&output.stdout).unwrap_or(serde_json::Value::Null);
            (value, output.status.code().unwrap_or(-1))
        }

        fn review(&self, public: &str) -> serde_json::Value {
            let (value, code) = self.run(&serde_json::json!({
                "mode": "review",
                "publicKey": public,
            }));
            assert_eq!(code, 0, "{value}; temporary home={}", self.home.display());
            value
        }

        fn review_raw(&self, public: &str) -> (serde_json::Value, i32) {
            self.run(&serde_json::json!({
                "mode": "review",
                "publicKey": public,
            }))
        }

        fn apply(&self, public: &str, snapshot: &serde_json::Value) -> (serde_json::Value, i32) {
            self.run(&serde_json::json!({
                "mode": "apply",
                "publicKey": public,
                "expected": snapshot,
            }))
        }

        fn read(&self) -> Vec<u8> {
            fs::read(self.ssh().join("authorized_keys")).unwrap()
        }
    }

    fn new_public() -> String {
        format!("ssh-ed25519 {} new-key", "A".repeat(43) + "=")
    }

    fn old_public() -> String {
        format!("ssh-ed25519 {} old-key", "B".repeat(43) + "=")
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
    fn review_is_read_only_and_preserves_comments_options_and_missing_trailing_newline() {
        if skip_without_python() {
            return;
        }
        let fixture = PythonFixture::new("deploy");
        assert!(!fixture.ssh().exists());
        let first = fixture.review(&new_public());
        assert_eq!(first["snapshot"]["sshExists"], false);
        assert_eq!(first["snapshot"]["fileExists"], false);
        assert_eq!(first["snapshot"]["alreadyPresent"], false);
        assert!(!fixture.ssh().exists(), "review must not create ~/.ssh");

        let original = format!(
            "# keep this comment\ncommand=\"echo hi\" {}\n{}",
            old_public().trim_end(),
            "ssh-rsa AAAAB3NzaC1yc2E= trailing"
        );
        fixture.write_key(original.as_bytes(), 0o640);
        let review = fixture.review(&new_public());
        let snapshot = &review["snapshot"];
        assert_eq!(snapshot["fileExists"], true);
        assert_eq!(snapshot["alreadyPresent"], false);
        assert_eq!(snapshot["appendNewline"], true);
        assert_eq!(snapshot["username"], "deploy");
        assert_eq!(fixture.read(), original.as_bytes());

        let (apply, code) = fixture.apply(&new_public(), snapshot);
        assert_eq!(code, 0, "{apply}");
        assert_eq!(apply["status"], "installed");
        let backup = apply["backupPath"].as_str().unwrap();
        let backup_path = PathBuf::from(backup);
        assert!(backup_path.starts_with(fixture.ssh()));
        assert_eq!(fs::read(&backup_path).unwrap(), original.as_bytes());
        assert_eq!(
            fs::metadata(&backup_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let updated = fixture.read();
        assert!(updated.starts_with(original.as_bytes()));
        let public = new_public()
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        assert!(updated.ends_with(format!("\n{public}\n").as_bytes()));
        assert_eq!(
            fs::metadata(fixture.ssh().join("authorized_keys"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640,
            "an existing file's mode must be preserved"
        );
        let paths: Vec<_> = fs::read_dir(fixture.ssh())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(paths.len(), 2, "only the file and one backup may exist");
    }

    #[test]
    fn duplicate_detection_respects_restrictive_options_and_never_escalates() {
        if skip_without_python() {
            return;
        }
        let fixture = PythonFixture::new("deploy");
        let restricted = format!(
            "from=\"10.0.0.0/8\",command=\"echo hi\" {}\n",
            old_public().trim_end()
        );
        fixture.write_key(restricted.as_bytes(), 0o600);
        let review = fixture.review(&old_public());
        assert_eq!(review["snapshot"]["alreadyPresent"], true);
        assert_eq!(review["snapshot"]["restrictedPresent"], true);
        assert_eq!(fixture.read(), restricted.as_bytes());
        let (apply, code) = fixture.apply(&old_public(), &review["snapshot"]);
        assert_eq!(code, 0, "{apply}");
        assert_eq!(apply["status"], "alreadyPresent");
        assert_eq!(apply["backupPath"], serde_json::Value::Null);
        assert_eq!(
            fixture.read(),
            restricted.as_bytes(),
            "no unrestricted duplicate line may be added"
        );
    }

    #[test]
    fn unsafe_files_symlinks_hardlinks_directories_oversize_and_malformed_lines_fail_closed() {
        if skip_without_python() {
            return;
        }
        let fixture = PythonFixture::new("deploy");
        fixture.write_key(b"ssh-ed25519 ", 0o600);
        let (value, code) = fixture.review_raw(&new_public());
        assert_ne!(code, 0);
        assert_eq!(value["reason"], "malformed_keys");

        fixture.write_key(b"# comment\n", 0o666);
        let (value, _) = fixture.review_raw(&new_public());
        assert_eq!(value["reason"], "file_unsafe");

        fs::set_permissions(
            fixture.ssh().join("authorized_keys"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let outside = fixture.dir.path().join("outside");
        fs::write(&outside, b"# elsewhere\n").unwrap();
        fs::remove_file(fixture.ssh().join("authorized_keys")).unwrap();
        symlink(&outside, fixture.ssh().join("authorized_keys")).unwrap();
        let (value, _) = fixture.review_raw(&new_public());
        assert_eq!(value["reason"], "file_unsafe");

        fs::remove_file(fixture.ssh().join("authorized_keys")).unwrap();
        fs::write(fixture.ssh().join("authorized_keys"), b"# comment\n").unwrap();
        fs::hard_link(
            fixture.ssh().join("authorized_keys"),
            fixture.ssh().join("hardlink"),
        )
        .unwrap();
        let (value, _) = fixture.review_raw(&new_public());
        assert_eq!(value["reason"], "file_unsafe");

        fs::remove_file(fixture.ssh().join("authorized_keys")).unwrap();
        fs::create_dir(fixture.ssh().join("authorized_keys")).unwrap();
        let (value, _) = fixture.review_raw(&new_public());
        assert_eq!(value["reason"], "file_unsafe");

        fs::remove_dir(fixture.ssh().join("authorized_keys")).unwrap();
        let huge = vec![b'#'; MAX_REMOTE_BYTES as usize + 1];
        fs::write(fixture.ssh().join("authorized_keys"), &huge).unwrap();
        fs::set_permissions(
            fixture.ssh().join("authorized_keys"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let (value, _) = fixture.review_raw(&new_public());
        assert_eq!(value["reason"], "file_too_large");

        // Replace ~/.ssh itself with a symlink; the anchored open must reject it.
        fs::remove_dir_all(fixture.ssh()).unwrap();
        let real = fixture.home.join("real-ssh");
        fs::create_dir(&real).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&real, fixture.ssh()).unwrap();
        let (value, _) = fixture.review_raw(&new_public());
        assert_eq!(value["reason"], "ssh_unsafe");

        let oversized = format!("ssh-ed25519 {}", "A".repeat(8192));
        let (value, _) = fixture.review_raw(&oversized);
        assert_eq!(value["reason"], "invalid_public_key");
    }

    #[test]
    fn stale_snapshot_and_new_file_collisions_are_refused_without_overwriting() {
        if skip_without_python() {
            return;
        }
        let fixture = PythonFixture::new("deploy");
        assert!(!fixture.ssh().exists());
        let review = fixture.review(&new_public());
        assert_eq!(review["snapshot"]["sshExists"], false);
        // A foreign file appears after review.
        fs::create_dir(fixture.ssh()).unwrap();
        fs::set_permissions(fixture.ssh(), fs::Permissions::from_mode(0o700)).unwrap();
        let foreign = format!("{}\n", old_public().trim_end());
        fs::write(fixture.ssh().join("authorized_keys"), foreign.as_bytes()).unwrap();
        fs::set_permissions(
            fixture.ssh().join("authorized_keys"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let (value, code) = fixture.apply(&new_public(), &review["snapshot"]);
        assert_ne!(code, 0);
        assert_eq!(value["reason"], "state_changed");
        assert_eq!(fixture.read(), foreign.as_bytes());

        // Missing ~/.ssh on apply creates 0700 and a new 0600 file.
        let fresh = PythonFixture::new("deploy");
        let review = fresh.review(&new_public());
        let (value, code) = fresh.apply(&new_public(), &review["snapshot"]);
        assert_eq!(code, 0, "{value}");
        assert_eq!(value["status"], "installed");
        assert_eq!(value["backupPath"], serde_json::Value::Null);
        assert_eq!(
            fs::metadata(fresh.ssh()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let path = fresh.ssh().join("authorized_keys");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            format!(
                "{}\n",
                new_public()
                    .split_whitespace()
                    .take(2)
                    .collect::<Vec<_>>()
                    .join(" ")
            )
            .as_bytes()
        );

        // Stale digest: change the file after review.
        let stale = PythonFixture::new("deploy");
        stale.write_key(b"# original\n", 0o600);
        let review = stale.review(&new_public());
        fs::write(stale.ssh().join("authorized_keys"), b"# changed\n").unwrap();
        let (value, code) = stale.apply(&new_public(), &review["snapshot"]);
        assert_ne!(code, 0);
        assert_eq!(value["reason"], "state_changed");
        assert_eq!(stale.read(), b"# changed\n");
    }

    #[test]
    fn stale_home_ssh_or_file_identity_is_refused() {
        if skip_without_python() {
            return;
        }
        // Home directory swap: same path, different inode.
        let home_swap = PythonFixture::new("deploy");
        home_swap.write_key(b"# base\n", 0o600);
        let review = home_swap.review(&new_public());
        let moved = home_swap.dir.path().join("home-old");
        fs::rename(&home_swap.home, &moved).unwrap();
        fs::create_dir(&home_swap.home).unwrap();
        fs::set_permissions(&home_swap.home, fs::Permissions::from_mode(0o700)).unwrap();
        let (value, code) = home_swap.apply(&new_public(), &review["snapshot"]);
        assert_ne!(code, 0);
        assert_eq!(value["reason"], "state_changed");

        // ~/.ssh swap with identical file bytes but a different directory inode.
        let ssh_swap = PythonFixture::new("deploy");
        let contents = format!("{}\n", old_public().trim_end());
        ssh_swap.write_key(contents.as_bytes(), 0o600);
        let review = ssh_swap.review(&new_public());
        let moved_ssh = ssh_swap.home.join(".ssh-old");
        fs::rename(ssh_swap.ssh(), &moved_ssh).unwrap();
        fs::create_dir(ssh_swap.ssh()).unwrap();
        fs::set_permissions(ssh_swap.ssh(), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(ssh_swap.ssh().join("authorized_keys"), contents.as_bytes()).unwrap();
        fs::set_permissions(
            ssh_swap.ssh().join("authorized_keys"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let (value, code) = ssh_swap.apply(&new_public(), &review["snapshot"]);
        assert_ne!(code, 0);
        assert_eq!(value["reason"], "state_changed");

        // authorized_keys swap with identical bytes but a different inode.
        let file_swap = PythonFixture::new("deploy");
        file_swap.write_key(contents.as_bytes(), 0o600);
        let review = file_swap.review(&new_public());
        let path = file_swap.ssh().join("authorized_keys");
        fs::rename(&path, file_swap.ssh().join("authorized_keys-old")).unwrap();
        fs::write(&path, contents.as_bytes()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let (value, code) = file_swap.apply(&new_public(), &review["snapshot"]);
        assert_ne!(code, 0);
        assert_eq!(value["reason"], "state_changed");
    }

    #[test]
    fn fifo_authorized_keys_is_rejected_without_blocking() {
        if skip_without_python() {
            return;
        }
        if Command::new("mkfifo")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let fixture = PythonFixture::new("deploy");
        fs::create_dir(fixture.ssh()).unwrap();
        fs::set_permissions(fixture.ssh(), fs::Permissions::from_mode(0o700)).unwrap();
        let fifo = fixture.ssh().join("authorized_keys");
        assert!(Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let (value, code) = fixture.run(&serde_json::json!({
            "mode": "review",
            "publicKey": new_public(),
        }));
        assert_ne!(code, 0);
        assert_eq!(value["reason"], "file_unsafe");
    }

    #[test]
    fn a_held_exclusive_lock_reports_busy_without_waiting() {
        if skip_without_python() {
            return;
        }
        let fixture = PythonFixture::new("deploy");
        let original = format!("{}\n", old_public().trim_end());
        fixture.write_key(original.as_bytes(), 0o600);
        let review = fixture.review(&new_public());
        let sentinel = fixture.dir.path().join("locked");
        let target = fixture.ssh().join("authorized_keys");
        let mut holder = Command::new("python3")
            .arg("-c")
            .arg(
                "import fcntl, sys, time\nfd = open(sys.argv[1], 'r+')\nfcntl.flock(fd, fcntl.LOCK_EX)\nopen(sys.argv[2], 'w').close()\ntime.sleep(5)\n",
            )
            .arg(&target)
            .arg(&sentinel)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !sentinel.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(sentinel.exists(), "lock holder did not start");
        let started = std::time::Instant::now();
        let (value, code) = fixture.apply(&new_public(), &review["snapshot"]);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "lock wait must be bounded"
        );
        assert_ne!(code, 0);
        assert_eq!(value["reason"], "busy");
        assert_eq!(fixture.read(), original.as_bytes());
        let _ = holder.kill();
        let _ = holder.wait();
    }
}
