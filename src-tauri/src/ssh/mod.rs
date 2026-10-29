pub mod actions;
mod auth;
mod catalog;
mod command;
mod config;
pub mod discovery;
mod services;
mod store;
pub mod streams;
#[cfg(test)]
mod tests;

use russh::{
    client,
    keys::{HashAlg, PublicKeyOrCertificate},
    Disconnect,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use store::Store;
pub use store::{HostKey, Profile, ProfileInput};
use tokio::{sync::Mutex as AsyncMutex, time::timeout};
use uuid::Uuid;
use zeroize::Zeroizing;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(15);
#[derive(Clone)]
struct Client {
    expected: Option<HostKey>,
    observed: Arc<AsyncMutex<Option<HostKey>>>,
}
impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Host certificates need a CA-validation flow; do not silently treat
        // them as a trusted bare public key in this first connection increment.
        if key.certificate().is_some() {
            return Ok(false);
        }
        let key = key.public_key();
        let identity = HostKey {
            algorithm: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        };
        *self.observed.lock().await = Some(identity.clone());
        Ok(self.expected.as_ref() == Some(&identity))
    }
}
struct Challenge {
    token: String,
    revision: String,
    key: HostKey,
    issued: Instant,
}
struct Job {
    token: String,
    _cancel: tokio::sync::oneshot::Sender<()>,
}
struct Runtime {
    jobs: HashMap<String, Job>,
    challenges: HashMap<String, Challenge>,
    connections: HashMap<String, client::Handle<Client>>,
    errors: HashMap<String, String>,
    streams: HashMap<String, streams::StreamHandle>,
    connection_ids: HashMap<String, String>,
    approvals: HashMap<String, actions::PendingApproval>,
    unresolved_changes: HashMap<String, String>,
}
pub struct SshService {
    // Production builds remain read-only until destructive integration gates pass.
    changes_enabled: bool,
    store: Mutex<Store>,
    runtime: AsyncMutex<Runtime>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub profile_id: String,
    pub challenge_id: String,
    pub status: &'static str,
    pub observed: HostKey,
    pub previous: Option<HostKey>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub profile_id: String,
    pub status: &'static str,
    pub error: Option<String>,
}
impl SshService {
    pub fn new(path: PathBuf) -> Self {
        Self {
            changes_enabled: false,
            store: Mutex::new(Store::open(path)),
            runtime: AsyncMutex::new(Runtime {
                jobs: HashMap::new(),
                challenges: HashMap::new(),
                connections: HashMap::new(),
                errors: HashMap::new(),
                streams: HashMap::new(),
                connection_ids: HashMap::new(),
                approvals: HashMap::new(),
                unresolved_changes: HashMap::new(),
            }),
        }
    }
    fn store(&self) -> Result<std::sync::MutexGuard<'_, Store>, String> {
        self.store
            .lock()
            .map_err(|_| "Server storage is unavailable.".into())
    }
    pub fn profiles(&self) -> Result<Vec<Profile>, String> {
        Ok(self.store()?.database()?.profiles.clone())
    }
    fn profile(&self, id: &str) -> Result<Profile, String> {
        self.store()?
            .database()?
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .cloned()
            .ok_or_else(|| "Server profile no longer exists.".into())
    }
    pub async fn save_profile(&self, input: ProfileInput) -> Result<Profile, String> {
        let existing = input.id.is_some();
        let profile = input.validate()?;
        let mut runtime = self.runtime.lock().await;
        if runtime.jobs.contains_key(&profile.id)
            || runtime
                .connections
                .get(&profile.id)
                .is_some_and(|handle| !handle.is_closed())
        {
            return Err("Disconnect this server before editing its profile.".into());
        }
        let mut store = self.store()?;
        let mut next = store.database()?.clone();
        if existing {
            let item = next
                .profiles
                .iter_mut()
                .find(|item| item.id == profile.id)
                .ok_or("Server profile no longer exists.")?;
            *item = profile.clone();
        } else {
            if next.profiles.len() >= 100 {
                return Err("The maximum of 100 saved server profiles has been reached.".into());
            }
            next.profiles.push(profile.clone());
        }
        store.commit(next)?;
        runtime.challenges.remove(&profile.id);
        runtime.errors.remove(&profile.id);
        Ok(profile)
    }
    pub async fn delete_profile(&self, id: &str) -> Result<(), String> {
        let mut runtime = self.runtime.lock().await;
        if runtime.jobs.contains_key(id)
            || runtime
                .connections
                .get(id)
                .is_some_and(|handle| !handle.is_closed())
        {
            return Err("Disconnect this server before deleting its profile.".into());
        }
        let mut store = self.store()?;
        let mut next = store.database()?.clone();
        next.profiles.retain(|profile| profile.id != id);
        store.commit(next)?;
        runtime.connections.remove(id);
        runtime.challenges.remove(id);
        runtime.errors.remove(id);
        Ok(())
    }
    async fn begin(
        &self,
        id: &str,
    ) -> Result<(Profile, String, tokio::sync::oneshot::Receiver<()>), String> {
        let mut runtime = self.runtime.lock().await;
        if runtime.jobs.contains_key(id)
            || runtime
                .connections
                .get(id)
                .is_some_and(|handle| !handle.is_closed())
        {
            return Err(
                "This server already has an active connection or connection attempt.".into(),
            );
        }
        let profile = self.profile(id)?;
        let token = Uuid::new_v4().to_string();
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        runtime.jobs.insert(
            id.into(),
            Job {
                token: token.clone(),
                _cancel: cancel,
            },
        );
        runtime.errors.remove(id);
        runtime.challenges.remove(id);
        Ok((profile, token, cancelled))
    }
    pub async fn inspect(&self, id: &str) -> Result<Inspection, String> {
        let (profile, token, cancelled) = self.begin(id).await?;
        let observed = Arc::new(AsyncMutex::new(None));
        let handler = Client {
            expected: None,
            observed: observed.clone(),
        };
        // Reject the key during this probe. No authentication is attempted.
        tokio::select! {
            _ = cancelled => return Err("Connection attempt was cancelled.".into()),
            _ = timeout(NETWORK_TIMEOUT, client::connect(Arc::new(client_config()), (profile.host.as_str(), profile.port), handler)) => {}
        }
        let mut runtime = self.runtime.lock().await;
        if runtime.jobs.get(id).map(|job| &job.token) != Some(&token) {
            return Err("Connection attempt was cancelled.".into());
        }
        runtime.jobs.remove(id);
        let Some(observed) = observed.lock().await.clone() else {
            let error = "Could not read an SSH host identity. Check the address, port, network, and supported host-key algorithms.".to_string();
            runtime.errors.insert(id.into(), error.clone());
            return Err(error);
        };
        let previous = self
            .store()?
            .database()?
            .trusted_hosts
            .get(&profile.endpoint())
            .cloned();
        let status = match &previous {
            None => "unknown",
            Some(key) if key == &observed => "known",
            Some(_) => "changed",
        };
        let challenge_id = Uuid::new_v4().to_string();
        runtime.challenges.insert(
            id.into(),
            Challenge {
                token: challenge_id.clone(),
                revision: profile.revision,
                key: observed.clone(),
                issued: Instant::now(),
            },
        );
        Ok(Inspection {
            profile_id: id.into(),
            challenge_id,
            status,
            observed,
            previous,
        })
    }
    pub async fn trust(&self, id: &str, challenge_id: &str) -> Result<(), String> {
        let runtime = self.runtime.lock().await;
        let challenge = runtime
            .challenges
            .get(id)
            .ok_or("Host identity review has expired. Verify the server again.")?;
        let profile = self.profile(id)?;
        if challenge.token != challenge_id
            || challenge.revision != profile.revision
            || challenge.issued.elapsed() > Duration::from_secs(300)
        {
            return Err("Host identity review has expired. Verify the server again.".into());
        }
        let mut store = self.store()?;
        let mut next = store.database()?.clone();
        if next
            .trusted_hosts
            .get(&profile.endpoint())
            .is_some_and(|key| key != &challenge.key)
        {
            return Err("The saved host key changed. Authentication is blocked; verify the change independently.".into());
        }
        next.trusted_hosts
            .insert(profile.endpoint(), challenge.key.clone());
        store.commit(next)?;
        Ok(())
    }
    pub async fn connect(
        &self,
        id: &str,
        challenge_id: &str,
        password: String,
    ) -> Result<(), String> {
        self.connect_with_credentials(id, challenge_id, password, None)
            .await
    }
    pub async fn connect_with_credentials(
        &self,
        id: &str,
        challenge_id: &str,
        password: String,
        passphrase: Option<String>,
    ) -> Result<(), String> {
        let password = Zeroizing::new(password);
        let passphrase = passphrase.map(Zeroizing::new);
        if password.len() > 4096 || passphrase.as_ref().is_some_and(|value| value.len() > 4096) {
            return Err("Credentials must be at most 4096 bytes.".into());
        }
        let (profile, token, expected, cancelled) = {
            let mut runtime = self.runtime.lock().await;
            if runtime.jobs.contains_key(id)
                || runtime
                    .connections
                    .get(id)
                    .is_some_and(|handle| !handle.is_closed())
            {
                return Err(
                    "This server already has an active connection or connection attempt.".into(),
                );
            }
            let profile = self.profile(id)?;
            let challenge = runtime
                .challenges
                .get(id)
                .ok_or("Verify the server identity again before authenticating.")?;
            if challenge.token != challenge_id
                || challenge.revision != profile.revision
                || challenge.issued.elapsed() > Duration::from_secs(300)
            {
                return Err("Host identity review has expired. Verify the server again.".into());
            }
            let expected = self
                .store()?
                .database()?
                .trusted_hosts
                .get(&profile.endpoint())
                .cloned();
            if expected.as_ref() != Some(&challenge.key) {
                return Err("Trust the reviewed server identity before authenticating.".into());
            }
            let token = Uuid::new_v4().to_string();
            let (cancel, cancelled) = tokio::sync::oneshot::channel();
            runtime.jobs.insert(
                id.into(),
                Job {
                    token: token.clone(),
                    _cancel: cancel,
                },
            );
            runtime.challenges.remove(id);
            runtime.errors.remove(id);
            (profile, token, expected, cancelled)
        };
        let result = tokio::select! {
            _ = cancelled => Err("Connection attempt was cancelled.".into()),
            result = self.authenticate(&profile, expected, &password, passphrase.as_ref().map(|value| value.as_str()), &token) => result,
        };
        let mut runtime = self.runtime.lock().await;
        if runtime.jobs.get(id).map(|job| &job.token) != Some(&token) {
            if let Ok(handle) = result {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "Connection cancelled", "")
                    .await;
            }
            return Err("Connection attempt was cancelled.".into());
        }
        runtime.jobs.remove(id);
        match result {
            Ok(handle) => {
                runtime
                    .connection_ids
                    .insert(id.into(), Uuid::new_v4().to_string());
                runtime.connections.insert(id.into(), handle);
                Ok(())
            }
            Err(error) => {
                runtime.errors.insert(id.into(), error.clone());
                Err(error)
            }
        }
    }
    async fn authenticate(
        &self,
        profile: &Profile,
        expected: Option<HostKey>,
        password: &str,
        passphrase: Option<&str>,
        token: &str,
    ) -> Result<client::Handle<Client>, String> {
        let expected =
            expected.ok_or("Verify and trust the server's host identity before authenticating.")?;
        let observed = Arc::new(AsyncMutex::new(None));
        let handler = Client {
            expected: Some(expected.clone()),
            observed: observed.clone(),
        };
        let result = timeout(
            NETWORK_TIMEOUT,
            client::connect(
                Arc::new(client_config()),
                (profile.host.as_str(), profile.port),
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
                "Host identity changed since verification. Authentication was not attempted."
                    .into(),
            );
        }
        let mut handle = result
            .map_err(|_| "SSH connection timed out.")?
            .map_err(|_| {
                "Could not establish a verified SSH connection. Authentication was not attempted."
            })?;
        if self
            .runtime
            .lock()
            .await
            .jobs
            .get(&profile.id)
            .map(|job| job.token.as_str())
            != Some(token)
        {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "Connection cancelled", "")
                .await;
            return Err("Connection attempt was cancelled.".into());
        }
        let authenticated = timeout(
            NETWORK_TIMEOUT,
            auth::authenticate(&mut handle, profile, password, passphrase),
        )
        .await;
        match authenticated {
            Ok(Ok(())) => Ok(handle),
            failure => {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "Authentication failed", "")
                    .await;
                Err(match failure {
                    Ok(Err(message)) => message,
                    _ => "SSH authentication timed out. Try again.".into(),
                })
            }
        }
    }
    pub async fn disconnect(&self, id: &str) -> Result<(), String> {
        let handle = {
            let mut runtime = self.runtime.lock().await;
            runtime.jobs.remove(id);
            runtime.challenges.remove(id);
            runtime.errors.remove(id);
            runtime.connection_ids.remove(id);
            runtime
                .approvals
                .retain(|_, approval| approval.profile_id != id);
            let uncertain = runtime
                .streams
                .values()
                .find(|stream| {
                    stream.profile_id == id
                        && stream.mutation_probe.is_some()
                        && !*stream.verified.lock().unwrap_or_else(|e| e.into_inner())
                })
                .and_then(|stream| stream.mutation_probe.clone());
            if let Some(probe) = uncertain {
                runtime.unresolved_changes.insert(id.into(), probe);
            }
            runtime.streams.retain(|_, stream| stream.profile_id != id);
            runtime.connections.remove(id)
        };
        if let Some(handle) = handle {
            let _ = timeout(
                Duration::from_secs(3),
                handle.disconnect(Disconnect::ByApplication, "Disconnected by user", ""),
            )
            .await;
        }
        Ok(())
    }
    pub async fn statuses(&self) -> Vec<ConnectionStatus> {
        let runtime = self.runtime.lock().await;
        let mut ids: Vec<String> = self
            .profiles()
            .unwrap_or_default()
            .into_iter()
            .map(|profile| profile.id)
            .collect();
        // A storage error must not hide a live connection from Disconnect.
        for id in runtime
            .connections
            .keys()
            .chain(runtime.jobs.keys())
            .chain(runtime.errors.keys())
        {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        ids.into_iter()
            .map(|id| {
                let status = if runtime.jobs.contains_key(&id) {
                    "connecting"
                } else if runtime
                    .connections
                    .get(&id)
                    .is_some_and(|handle| !handle.is_closed())
                {
                    "connected"
                } else if runtime.errors.contains_key(&id) {
                    "failed"
                } else {
                    "disconnected"
                };
                ConnectionStatus {
                    error: runtime.errors.get(&id).cloned(),
                    profile_id: id,
                    status,
                }
            })
            .collect()
    }
}
fn client_config() -> client::Config {
    client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        ..Default::default()
    }
}

#[tauri::command]
pub async fn ssh_profiles(service: tauri::State<'_, SshService>) -> Result<Vec<Profile>, String> {
    service.profiles()
}
#[tauri::command]
pub async fn ssh_save_profile(
    service: tauri::State<'_, SshService>,
    input: ProfileInput,
) -> Result<Profile, String> {
    service.save_profile(input).await
}
#[tauri::command]
pub async fn ssh_delete_profile(
    service: tauri::State<'_, SshService>,
    profile_id: String,
) -> Result<(), String> {
    service.delete_profile(&profile_id).await
}
#[tauri::command]
pub async fn ssh_inspect(
    service: tauri::State<'_, SshService>,
    profile_id: String,
) -> Result<Inspection, String> {
    service.inspect(&profile_id).await
}
#[tauri::command]
pub async fn ssh_trust(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    challenge_id: String,
) -> Result<(), String> {
    service.trust(&profile_id, &challenge_id).await
}
#[tauri::command]
pub async fn ssh_connect(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    challenge_id: String,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<(), String> {
    if passphrase.is_some() {
        service
            .connect_with_credentials(
                &profile_id,
                &challenge_id,
                password.unwrap_or_default(),
                passphrase,
            )
            .await
    } else {
        service
            .connect(&profile_id, &challenge_id, password.unwrap_or_default())
            .await
    }
}
#[tauri::command]
pub async fn ssh_disconnect(
    service: tauri::State<'_, SshService>,
    profile_id: String,
) -> Result<(), String> {
    service.disconnect(&profile_id).await
}
#[tauri::command]
pub async fn ssh_statuses(
    service: tauri::State<'_, SshService>,
) -> Result<Vec<ConnectionStatus>, String> {
    Ok(service.statuses().await)
}

#[tauri::command]
pub async fn ssh_config_hosts(app: tauri::AppHandle) -> Result<Vec<config::ConfigHost>, String> {
    use tauri::Manager;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Cannot locate the SSH config directory.")?;
    let username = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || config::read_hosts(&home, &username))
        .await
        .map_err(|_| "SSH config discovery could not complete.")?
}

#[tauri::command]
pub async fn ssh_parse_command(
    app: tauri::AppHandle,
    command: String,
) -> Result<ProfileInput, String> {
    use tauri::Manager;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Cannot locate your SSH configuration.")?;
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || command::parse(&command, &home, &user))
        .await
        .map_err(|_| "Could not read the SSH command.")?
}
