//! Independent Quick Setup key-login proof.
//!
//! A proof is produced only by opening a separate SSH connection to the same
//! profile host, authenticating as the requested target account with exactly
//! the selected encrypted local key, and re-checking the source connection,
//! trusted host identity and key metadata before publication. Proof records are
//! memory-only, bounded, and never contain credentials or key bytes.

#[cfg(unix)]
mod local_config;

use super::{auth, client_config, Client, HostKey, Profile, SshService, NETWORK_TIMEOUT};
use crate::setup_keys::{KeyLocation, KeyOrigin, KeyVault, ResolvedConfigKey, ResolvedKeyMetadata};
use russh::Disconnect;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::time::timeout;
use uuid::Uuid;
use zeroize::Zeroizing;

const PROOF_LIFETIME: Duration = Duration::from_secs(120);
const MAX_PROOFS: usize = 100;
const MAX_REVIEWS: usize = 100;
const MAX_ATTEMPTS: usize = 4;
const MAX_FAILURES: usize = 5;
const MAX_FAILURE_ENTRIES: usize = 100;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const MAX_PASSPHRASE_BYTES: usize = 4096;
const MAX_USERNAME_BYTES: usize = 64;

/// Native identity of the SSH config file that a review was prepared from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SourceSnapshot {
    pub exists: bool,
    pub dev: u64,
    pub ino: u64,
    pub sha256: [u8; 32],
}

#[derive(Default)]
struct Inner {
    proofs: HashMap<String, Proof>,
    reviews: HashMap<String, Review>,
    attempts: HashMap<String, Instant>,
    failures: HashMap<String, Vec<Instant>>,
}

impl Inner {
    fn prune(&mut self, now: Instant) {
        self.proofs.retain(|_, proof| proof.deadline > now);
        self.reviews.retain(|_, review| review.deadline > now);
        self.failures.retain(|_, failures| {
            failures.retain(|at| now.saturating_duration_since(*at) < FAILURE_WINDOW);
            !failures.is_empty()
        });
    }
}

/// Bounded, memory-only verification state owned by `SshService`.
#[derive(Default)]
pub struct State {
    inner: Arc<Mutex<Inner>>,
}

struct AttemptGuard {
    inner: Arc<Mutex<Inner>>,
    profile_id: String,
}

impl Drop for AttemptGuard {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.attempts.remove(&self.profile_id);
        }
    }
}

impl State {
    fn begin(&self, profile_id: &str) -> Result<AttemptGuard, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Key login state is unavailable.".to_string())?;
        let now = Instant::now();
        inner.prune(now);
        if inner.attempts.contains_key(profile_id) {
            return Err(
                "A key login verification is already running for this server. Wait for it to finish."
                    .into(),
            );
        }
        if inner.attempts.len() >= MAX_ATTEMPTS {
            return Err(
                "Too many key login verifications are running. Wait for one to finish.".into(),
            );
        }
        if inner
            .failures
            .get(profile_id)
            .is_some_and(|failures| failures.len() >= MAX_FAILURES)
        {
            return Err(
                "Too many failed key login attempts for this server. Wait before trying again."
                    .into(),
            );
        }
        inner.attempts.insert(profile_id.to_string(), now);
        Ok(AttemptGuard {
            inner: self.inner.clone(),
            profile_id: profile_id.to_string(),
        })
    }

    fn record_failure(&self, profile_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            let now = Instant::now();
            {
                let failures = inner.failures.entry(profile_id.to_string()).or_default();
                failures.push(now);
                failures.retain(|at| now.saturating_duration_since(*at) < FAILURE_WINDOW);
            }
            if inner.failures.len() > MAX_FAILURE_ENTRIES {
                if let Some(oldest) = inner
                    .failures
                    .iter()
                    .filter_map(|(id, times)| times.last().map(|last| (id.clone(), *last)))
                    .min_by_key(|(_, last)| *last)
                    .map(|(id, _)| id)
                {
                    inner.failures.remove(&oldest);
                }
            }
        }
    }

    fn insert(&self, proof: Proof) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Key login state is unavailable.".to_string())?;
        let now = Instant::now();
        inner.prune(now);
        if inner.proofs.len() >= MAX_PROOFS {
            if let Some(oldest) = inner
                .proofs
                .values()
                .min_by_key(|proof| proof.deadline)
                .map(|proof| proof.id.clone())
            {
                inner.proofs.remove(&oldest);
            }
        }
        inner.proofs.insert(proof.id.clone(), proof);
        Ok(())
    }

    fn insert_review(&self, review: Review) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "SSH config review state is unavailable.".to_string())?;
        let now = Instant::now();
        inner.prune(now);
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

    fn take_review(&self, review_id: &str) -> Result<Review, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "SSH config review state is unavailable.".to_string())?;
        let now = Instant::now();
        inner.prune(now);
        let review = inner.reviews.remove(review_id).ok_or_else(|| {
            "The SSH config review expired or is unavailable. Create a new review.".to_string()
        })?;
        if review.deadline <= now {
            return Err("The SSH config review expired. Create a new review.".into());
        }
        Ok(review)
    }

    fn remove_review(&self, review_id: &str) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "SSH config review state is unavailable.".to_string())?;
        inner.prune(Instant::now());
        if inner.reviews.remove(review_id).is_some() {
            Ok(())
        } else {
            Err("The SSH config review expired or is unavailable.".into())
        }
    }

    #[cfg(test)]
    pub(super) fn expire_for_test(&self, proof_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(proof) = inner.proofs.get_mut(proof_id) {
                proof.deadline = Instant::now() - Duration::from_secs(1);
            }
        }
    }

    #[cfg(test)]
    pub(super) fn expire_review_for_test(&self, review_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(review) = inner.reviews.get_mut(review_id) {
                review.deadline = Instant::now() - Duration::from_secs(1);
            }
        }
    }

    #[cfg(test)]
    pub(super) fn record_failure_for_test(&self, profile_id: &str) {
        self.record_failure(profile_id);
    }

    #[cfg(test)]
    pub(super) fn failure_entries_for_test(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.failures.len())
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub(super) fn attempt_entries_for_test(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.attempts.len())
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub(super) fn review_entries_for_test(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.reviews.len())
            .unwrap_or(0)
    }
}

#[derive(Clone)]
pub(crate) struct Proof {
    pub(crate) id: String,
    pub(crate) profile_id: String,
    pub(crate) revision: String,
    pub(crate) connection_id: String,
    pub(crate) key_id: String,
    pub(crate) key_fingerprint: String,
    pub(crate) key_digest: [u8; 32],
    pub(crate) key_path: PathBuf,
    pub(crate) key_location: KeyLocation,
    pub(crate) host_key: HostKey,
    pub(crate) host: String,
    pub(crate) username: String,
    pub(crate) port: u16,
    pub(crate) deadline: Instant,
}

struct Review {
    id: String,
    proof_id: String,
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
    alias: String,
    entry: String,
    destination: String,
    mode: &'static str,
    backup: bool,
    source: SourceSnapshot,
    candidate_sha256: [u8; 32],
    deadline: Instant,
}

impl Review {
    fn view(&self) -> SetupConfigReview {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        SetupConfigReview {
            review_id: self.id.clone(),
            proof_id: self.proof_id.clone(),
            profile_id: self.profile_id.clone(),
            alias: self.alias.clone(),
            entry: self.entry.clone(),
            destination: self.destination.clone(),
            mode: self.mode.to_string(),
            backup: self.backup,
            host: self.host.clone(),
            username: self.username.clone(),
            port: self.port,
            key_fingerprint: self.key_fingerprint.clone(),
            expires_at_ms: u64::try_from(now_ms.saturating_add(remaining.as_millis()))
                .unwrap_or(u64::MAX),
        }
    }
}

/// Preview returned to the renderer. It contains only the new app-owned block
/// and safe metadata, never the existing user SSH config text.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupConfigReview {
    pub review_id: String,
    pub proof_id: String,
    pub profile_id: String,
    pub alias: String,
    pub entry: String,
    pub destination: String,
    pub mode: String,
    pub backup: bool,
    pub host: String,
    pub username: String,
    pub port: u16,
    pub key_fingerprint: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupConfigSave {
    pub status: &'static str,
    pub alias: String,
    pub destination: String,
    pub backup_path: Option<String>,
}

impl Proof {
    fn view(&self) -> KeyLoginProof {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        KeyLoginProof {
            proof_id: self.id.clone(),
            profile_id: self.profile_id.clone(),
            profile_revision: self.revision.clone(),
            connection_id: self.connection_id.clone(),
            key_id: self.key_id.clone(),
            key_fingerprint: self.key_fingerprint.clone(),
            key_location: self.key_location,
            host: self.host.clone(),
            username: self.username.clone(),
            port: self.port,
            expires_at_ms: u64::try_from(now_ms.saturating_add(remaining.as_millis()))
                .unwrap_or(u64::MAX),
        }
    }
}

/// Safe proof metadata. No credentials, passphrases, key bytes or raw config.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyLoginProof {
    pub proof_id: String,
    pub profile_id: String,
    pub profile_revision: String,
    pub connection_id: String,
    pub key_id: String,
    pub key_fingerprint: String,
    pub key_location: KeyLocation,
    pub host: String,
    pub username: String,
    pub port: u16,
    pub expires_at_ms: u64,
}

pub struct VerifyRequest {
    pub profile_id: String,
    pub connection_id: String,
    pub profile_revision: String,
    pub key_id: String,
    pub username: String,
    pub port: u16,
    pub passphrase: Option<String>,
}

fn validate_target_username(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= MAX_USERNAME_BYTES
        && value
            .as_bytes()
            .first()
            .is_some_and(|first| first.is_ascii_alphanumeric() || *first == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    if valid {
        Ok(())
    } else {
        Err(
            "Use a valid SSH username: 1-64 letters, numbers, dots, underscores or hyphens, not starting with a hyphen."
                .into(),
        )
    }
}

async fn validate_source(
    service: &SshService,
    vault: &KeyVault,
    profile_id: &str,
    revision: &str,
    connection_id: &str,
    key_id: &str,
) -> Result<(Profile, ResolvedKeyMetadata, HostKey), String> {
    let profile = service.profile(profile_id)?;
    if profile.revision != revision {
        return Err("The server profile changed. Verify key login again.".into());
    }
    let expected = {
        let store = service.store()?;
        store
            .database()?
            .trusted_hosts
            .get(&profile.endpoint())
            .cloned()
    }
    .ok_or_else(|| "Trust this server's host identity before verifying key login.".to_string())?;
    {
        let runtime = service.runtime.lock().await;
        if runtime.connection_ids.get(profile_id).map(String::as_str) != Some(connection_id) {
            return Err("The server connection changed. Verify key login again.".into());
        }
        if !runtime
            .connections
            .get(profile_id)
            .is_some_and(|handle| !handle.is_closed())
        {
            return Err("Connect to this server before verifying key login.".into());
        }
    }
    let metadata = vault.resolve_metadata_async(key_id).await?;
    Ok((profile, metadata, expected))
}

impl SshService {
    /// Verify the selected explicit key against a separate connection to the
    /// source host at the requested target port. The source connection is never
    /// replaced or disconnected.
    pub async fn verify_setup_key_login(
        &self,
        vault: &KeyVault,
        mut request: VerifyRequest,
    ) -> Result<KeyLoginProof, String> {
        // Wrap the transient secret before any early return can drop the request.
        let passphrase = request.passphrase.take().map(Zeroizing::new);
        if passphrase
            .as_ref()
            .is_some_and(|value| value.len() > MAX_PASSPHRASE_BYTES)
        {
            return Err("The key passphrase must be at most 4096 bytes.".into());
        }
        validate_target_username(&request.username)?;
        if request.port == 0 {
            return Err("Choose a target SSH port between 1 and 65535.".into());
        }
        // Only a native saved profile may consume a verification attempt or a
        // failure-cache entry; foreign/malformed IDs fail before accounting.
        self.profile(&request.profile_id)?;
        let _guard = self.setup_access.begin(&request.profile_id)?;
        #[cfg(unix)]
        let result = self
            .verify_setup_key_login_inner(vault, &request, passphrase)
            .await;
        #[cfg(not(unix))]
        let result: Result<KeyLoginProof, String> = {
            let _ = (vault, passphrase);
            Err("Independent key login verification is unavailable on this platform.".to_string())
        };
        if result.is_err() {
            self.setup_access.record_failure(&request.profile_id);
        }
        result
    }

    #[cfg(unix)]
    async fn verify_setup_key_login_inner(
        &self,
        vault: &KeyVault,
        request: &VerifyRequest,
        passphrase: Option<Zeroizing<String>>,
    ) -> Result<KeyLoginProof, String> {
        let passphrase = passphrase.filter(|value| !value.is_empty());
        let (profile, metadata, expected) = validate_source(
            self,
            vault,
            &request.profile_id,
            &request.profile_revision,
            &request.connection_id,
            &request.key_id,
        )
        .await?;
        let target_host = profile.host.clone();
        let observed = Arc::new(tokio::sync::Mutex::new(None));
        let handler = Client {
            expected: Some(expected.clone()),
            observed: observed.clone(),
        };
        let connecting = timeout(
            NETWORK_TIMEOUT,
            russh::client::connect(
                Arc::new(client_config()),
                (target_host.as_str(), request.port),
                handler,
            ),
        )
        .await;
        if observed
            .lock()
            .await
            .as_ref()
            .is_some_and(|key| key != &expected)
        {
            return Err(
                "The target port presented a different host identity. Key login was not attempted."
                    .into(),
            );
        }
        let mut handle = match connecting {
            Err(_) => return Err("The key login connection timed out.".into()),
            Ok(Err(_)) => {
                return Err(
                    "Could not establish a verified SSH connection to the target port. Key login was not attempted."
                        .into(),
                )
            }
            Ok(Ok(handle)) => handle,
        };
        let authentication = timeout(
            NETWORK_TIMEOUT,
            auth::authenticate_selected_key(
                &mut handle,
                &request.username,
                metadata.path.clone(),
                passphrase,
            ),
        )
        .await;
        let _ = timeout(
            Duration::from_secs(3),
            handle.disconnect(Disconnect::ByApplication, "Key login proof complete", ""),
        )
        .await;
        let used_fingerprint = match authentication {
            Err(_) => return Err("Key login authentication timed out.".into()),
            Ok(Err(message)) => return Err(message),
            Ok(Ok(fingerprint)) => fingerprint,
        };
        if used_fingerprint != metadata.fingerprint {
            return Err(
                "The server accepted a different key than the selected local key. Key login was not verified."
                    .into(),
            );
        }
        let (profile_after, metadata_after, expected_after) = validate_source(
            self,
            vault,
            &request.profile_id,
            &request.profile_revision,
            &request.connection_id,
            &request.key_id,
        )
        .await?;
        if profile_after.host != target_host || expected_after != expected {
            return Err(
                "The server connection or trusted host identity changed during verification. Key login was not verified."
                    .into(),
            );
        }
        if metadata_after.path != metadata.path
            || metadata_after.fingerprint != metadata.fingerprint
            || metadata_after.digest != metadata.digest
            || metadata_after.location != metadata.location
        {
            return Err(
                "The selected local key changed during verification. Key login was not verified."
                    .into(),
            );
        }
        let proof = Proof {
            id: Uuid::new_v4().to_string(),
            profile_id: request.profile_id.clone(),
            revision: request.profile_revision.clone(),
            connection_id: request.connection_id.clone(),
            key_id: request.key_id.clone(),
            key_fingerprint: metadata.fingerprint,
            key_digest: metadata.digest,
            key_path: metadata.path,
            key_location: metadata.location,
            host_key: expected,
            host: target_host,
            username: request.username.clone(),
            port: request.port,
            deadline: Instant::now() + PROOF_LIFETIME,
        };
        let view = proof.view();
        self.setup_access.insert(proof)?;
        Ok(view)
    }

    /// Revalidate and return a still-valid proof record. The local-config
    /// adapter must use this instead of trusting renderer fields.
    pub(crate) async fn valid_setup_proof_record(
        &self,
        vault: &KeyVault,
        proof_id: &str,
    ) -> Result<Proof, String> {
        let proof = {
            let inner = self
                .setup_access
                .inner
                .lock()
                .map_err(|_| "Key login state is unavailable.".to_string())?;
            inner.proofs.get(proof_id).cloned()
        }
        .ok_or_else(|| {
            "Key login proof expired or is unavailable. Verify key login again.".to_string()
        })?;
        if proof.deadline <= Instant::now() {
            if let Ok(mut inner) = self.setup_access.inner.lock() {
                inner.proofs.remove(proof_id);
            }
            return Err(
                "Key login proof expired. Verify the selected key again before saving configuration."
                    .into(),
            );
        }
        let (profile, metadata, host_key) = validate_source(
            self,
            vault,
            &proof.profile_id,
            &proof.revision,
            &proof.connection_id,
            &proof.key_id,
        )
        .await?;
        if profile.host != proof.host {
            return Err(
                "The server profile changed since key login was verified. Verify key login again."
                    .into(),
            );
        }
        if host_key != proof.host_key {
            return Err(
                "The trusted host identity changed since key login was verified. Verify key login again."
                    .into(),
            );
        }
        if metadata.path != proof.key_path
            || metadata.fingerprint != proof.key_fingerprint
            || metadata.digest != proof.key_digest
            || metadata.location != proof.key_location
        {
            return Err(
                "The selected local key changed since key login was verified. Verify key login again."
                    .into(),
            );
        }
        Ok(proof)
    }

    #[cfg(unix)]
    fn validate_config_key(proof: &Proof, key: &ResolvedConfigKey) -> Result<(), String> {
        if std::path::Path::new(&key.path) != proof.key_path.as_path()
            || key.fingerprint != proof.key_fingerprint
            || key.digest != proof.key_digest
            || key.location != proof.key_location
        {
            return Err(
                "The selected local key changed since key login was verified. Verify key login again."
                    .into(),
            );
        }
        if key.origin == KeyOrigin::Legacy {
            return Err(
                "This key is in the app vault. Put it in ~/.ssh before saving a reviewed SSH config entry."
                    .into(),
            );
        }
        Ok(())
    }

    pub(crate) async fn review_setup_config(
        &self,
        vault: &KeyVault,
        proof_id: &str,
        alias: &str,
    ) -> Result<SetupConfigReview, String> {
        #[cfg(not(unix))]
        {
            let _ = (vault, proof_id, alias);
            return Err("Reviewed SSH config saving is unavailable on this platform.".into());
        }
        #[cfg(unix)]
        {
            local_config::validate_alias(alias)?;
            let proof = self.valid_setup_proof_record(vault, proof_id).await?;
            let key = vault.resolve_config_key_async(&proof.key_id).await?;
            Self::validate_config_key(&proof, &key)?;
            let request = local_config::PrepareRequest {
                profile_id: proof.profile_id.clone(),
                alias: alias.to_string(),
                host: proof.host.clone(),
                username: proof.username.clone(),
                port: proof.port,
                identity_path: PathBuf::from(&key.path),
            };
            let prepared = local_config::prepare(vault, request).await?;
            let after = self.valid_setup_proof_record(vault, proof_id).await?;
            if after.profile_id != proof.profile_id
                || after.revision != proof.revision
                || after.connection_id != proof.connection_id
                || after.key_id != proof.key_id
                || after.key_fingerprint != proof.key_fingerprint
                || after.key_digest != proof.key_digest
                || after.key_path != proof.key_path
                || after.key_location != proof.key_location
                || after.host_key != proof.host_key
                || after.host != proof.host
                || after.username != proof.username
                || after.port != proof.port
            {
                return Err(
                    "The server or selected key changed while the SSH config review was created. Verify key login again."
                        .into(),
                );
            }
            let review = Review {
                id: Uuid::new_v4().to_string(),
                proof_id: proof.id.clone(),
                profile_id: proof.profile_id.clone(),
                revision: proof.revision.clone(),
                connection_id: proof.connection_id.clone(),
                key_id: proof.key_id.clone(),
                key_fingerprint: proof.key_fingerprint.clone(),
                key_digest: proof.key_digest,
                key_path: proof.key_path.clone(),
                key_location: proof.key_location,
                host_key: proof.host_key.clone(),
                host: proof.host.clone(),
                username: proof.username.clone(),
                port: proof.port,
                alias: alias.to_string(),
                entry: prepared.entry,
                destination: "~/.ssh/config".into(),
                mode: prepared.mode,
                backup: prepared.backup,
                source: prepared.source,
                candidate_sha256: prepared.candidate_sha256,
                deadline: after.deadline,
            };
            let view = review.view();
            self.setup_access.insert_review(review)?;
            Ok(view)
        }
    }

    pub(crate) async fn save_setup_config(
        &self,
        vault: &KeyVault,
        review_id: &str,
    ) -> Result<SetupConfigSave, String> {
        // Consume the single-use review before any validation or file work.
        let review = self.setup_access.take_review(review_id)?;
        #[cfg(not(unix))]
        {
            let _ = (vault, review);
            return Err("Reviewed SSH config saving is unavailable on this platform.".into());
        }
        #[cfg(unix)]
        {
            let proof = self
                .valid_setup_proof_record(vault, &review.proof_id)
                .await?;
            if proof.profile_id != review.profile_id
                || proof.revision != review.revision
                || proof.connection_id != review.connection_id
                || proof.key_id != review.key_id
                || proof.key_fingerprint != review.key_fingerprint
                || proof.key_digest != review.key_digest
                || proof.key_path != review.key_path
                || proof.key_location != review.key_location
                || proof.host_key != review.host_key
                || proof.host != review.host
                || proof.username != review.username
                || proof.port != review.port
            {
                return Err(
                    "The server or selected key changed since this SSH config review. Create a new review."
                        .into(),
                );
            }
            let key = vault.resolve_config_key_async(&proof.key_id).await?;
            Self::validate_config_key(&proof, &key)?;
            let saved = local_config::publish(
                vault,
                review.profile_id.clone(),
                review.entry.clone(),
                review.source,
                review.candidate_sha256,
                review.deadline,
            )
            .await?;
            Ok(SetupConfigSave {
                status: "saved",
                alias: review.alias,
                destination: review.destination,
                backup_path: saved
                    .backup_path
                    .map(|path| path.to_string_lossy().into_owned()),
            })
        }
    }

    pub(crate) fn reject_setup_config(&self, review_id: &str) -> Result<(), String> {
        self.setup_access.remove_review(review_id)
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_setup_key_verify(
    service: tauri::State<'_, SshService>,
    vault: tauri::State<'_, KeyVault>,
    profile_id: String,
    connection_id: String,
    profile_revision: String,
    key_id: String,
    username: String,
    port: u16,
    passphrase: Option<String>,
) -> Result<KeyLoginProof, String> {
    service
        .verify_setup_key_login(
            vault.inner(),
            VerifyRequest {
                profile_id,
                connection_id,
                profile_revision,
                key_id,
                username,
                port,
                passphrase,
            },
        )
        .await
}

#[tauri::command]
pub async fn ssh_setup_config_review(
    service: tauri::State<'_, SshService>,
    vault: tauri::State<'_, KeyVault>,
    proof_id: String,
    alias: String,
) -> Result<SetupConfigReview, String> {
    service
        .review_setup_config(vault.inner(), &proof_id, &alias)
        .await
}

#[tauri::command]
pub async fn ssh_setup_config_save(
    service: tauri::State<'_, SshService>,
    vault: tauri::State<'_, KeyVault>,
    review_id: String,
) -> Result<SetupConfigSave, String> {
    service.save_setup_config(vault.inner(), &review_id).await
}

#[tauri::command]
pub fn ssh_setup_config_reject(
    service: tauri::State<'_, SshService>,
    review_id: String,
) -> Result<(), String> {
    service.reject_setup_config(&review_id)
}
