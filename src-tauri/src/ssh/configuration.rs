//! Bounded, explicit read-only configuration discovery over the verified connection.
use super::*;
use russh::ChannelMsg;
use serde::Deserialize;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

const PROBE: &str = include_str!("configuration_probe.py");
const MAX_OUTPUT: usize = 131_072;
const CANCELED: &str = "Configuration inspection canceled. Previous evidence was retained.";
#[derive(Default)]
struct Registry {
    running: HashMap<String, Running>,
    // Covers cancel arriving before the snapshot IPC task starts. Bounded and
    // short-lived; a delayed cancel can never target a different request.
    canceled: HashMap<(String, String, String), Instant>,
}
struct Running {
    connection: String,
    operation: String,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
pub(super) struct State(Arc<Mutex<Registry>>);
struct Lease(Arc<Mutex<Registry>>, String, watch::Receiver<bool>);
impl State {
    fn acquire(&self, id: &str, connection: &str, operation: &str) -> Result<Lease, String> {
        valid_identity(id, connection, operation)?;
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Configuration inspection is unavailable.")?;
        registry
            .canceled
            .retain(|_, time| time.elapsed() < Duration::from_secs(60));
        if registry
            .canceled
            .remove(&(id.into(), connection.into(), operation.into()))
            .is_some()
        {
            return Err(CANCELED.into());
        }
        if registry.running.contains_key(id) || registry.running.len() >= 100 {
            return Err(
                "Configuration inspection is already running. Wait before refreshing.".into(),
            );
        }
        let (cancel, receiver) = watch::channel(false);
        registry.running.insert(
            id.into(),
            Running {
                connection: connection.into(),
                operation: operation.into(),
                cancel,
            },
        );
        Ok(Lease(self.0.clone(), id.into(), receiver))
    }
    pub(super) fn cancel(&self, id: &str, connection: &str, operation: &str) -> Result<(), String> {
        valid_identity(id, connection, operation)?;
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Configuration cancellation is unavailable.")?;
        if let Some(running) = registry.running.get(id) {
            if running.connection != connection || running.operation != operation {
                return Err("This inspection request is no longer active.".into());
            }
            running.cancel.send_replace(true);
        } else {
            registry
                .canceled
                .retain(|_, time| time.elapsed() < Duration::from_secs(60));
            if registry.canceled.len() >= 100 {
                return Err("Too many pending cancellation requests. Wait before retrying.".into());
            }
            registry.canceled.insert(
                (id.into(), connection.into(), operation.into()),
                Instant::now(),
            );
        }
        Ok(())
    }
}
fn valid_identity(id: &str, connection: &str, operation: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || connection.is_empty()
        || connection.len() > 128
        || uuid::Uuid::parse_str(operation).is_err()
    {
        return Err("Invalid configuration inspection identity.".into());
    }
    Ok(())
}
impl Lease {
    async fn canceled(&mut self) {
        if !*self.2.borrow() {
            let _ = self.2.changed().await;
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.0.lock() {
            registry.running.remove(&self.1);
        }
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceState {
    Ready,
    Partial,
    Unavailable,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationEvidence {
    id: String,
    title: String,
    state: EvidenceState,
    values: HashMap<String, String>,
    message: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationSnapshot {
    profile_id: String,
    connection_id: String,
    observed_at: u64,
    sections: Vec<ConfigurationEvidence>,
}
pub fn command() -> String {
    format!(
        "exec python3 -I -S -B -u -c '{}'",
        PROBE.replace('\'', "'\\''")
    )
}
fn parse(bytes: &[u8]) -> Result<Vec<ConfigurationEvidence>, String> {
    const IDS: [&str; 8] = [
        "system",
        "essentials",
        "resources",
        "security",
        "docker",
        "ssh",
        "firewall",
        "listeners",
    ];
    let invalid = "Configuration inspection returned unsupported or incomplete evidence.";
    if bytes.len() > MAX_OUTPUT {
        return Err(invalid.into());
    }
    let sections: Vec<ConfigurationEvidence> =
        serde_json::from_slice(bytes).map_err(|_| invalid)?;
    let mut ids = HashSet::new();
    let safe =
        |text: &str, limit: usize| text.len() <= limit && !text.chars().any(char::is_control);
    if sections.len() != IDS.len()
        || sections.iter().any(|section| {
            !IDS.contains(&section.id.as_str())
                || !ids.insert(&section.id)
                || !safe(&section.title, 80)
                || section.values.len() > 110
                || section
                    .values
                    .iter()
                    .any(|(k, v)| !safe(k, 80) || !safe(v, 2048))
                || section.message.as_ref().is_some_and(|m| !safe(m, 1024))
        })
    {
        return Err(invalid.into());
    }
    Ok(sections)
}
impl SshService {
    #[cfg(test)]
    pub(super) async fn configuration_snapshot(
        &self,
        profile_id: &str,
        expected_connection: &str,
    ) -> Result<ConfigurationSnapshot, String> {
        self.configuration_snapshot_request(
            profile_id,
            expected_connection,
            &uuid::Uuid::new_v4().to_string(),
        )
        .await
    }
    pub(super) async fn configuration_snapshot_request(
        &self,
        profile_id: &str,
        expected_connection: &str,
        operation_id: &str,
    ) -> Result<ConfigurationSnapshot, String> {
        let mut lease =
            self.configuration
                .acquire(profile_id, expected_connection, operation_id)?;
        let opening = async {
            let runtime = self.runtime.lock().await;
            if *lease.2.borrow() {
                return Err(CANCELED.into());
            }
            let connection_id = runtime
                .connection_ids
                .get(profile_id)
                .ok_or("Connect to this server first.")?;
            if connection_id != expected_connection {
                return Err("Connection changed. Refresh connection status first.".into());
            }
            let handle = runtime
                .connections
                .get(profile_id)
                .filter(|h| !h.is_closed())
                .ok_or("Connect to this server first.")?;
            let channel = timeout(NETWORK_TIMEOUT, handle.channel_open_session())
                .await
                .map_err(|_| "Configuration channel timed out.")?
                .map_err(|_| "Cannot open configuration inspection.")?;
            Ok::<_, String>((
                channel,
                connection_id.clone(),
                self.profile(profile_id)
                    .ok()
                    .map(|profile| profile.username),
            ))
        };
        // Do not drop channel_open_session after its open request was sent:
        // russh would lose the receiver needed to close a late-confirmed channel.
        // Let the existing network timeout bound confirmation, then close below
        // without executing the probe when cancellation arrived during opening.
        let (mut channel, connection_id, authenticated_user) = opening.await?;
        // Release the runtime lock while probes run: terminals and monitoring keep working.
        let result = tokio::select! {
            biased;
            _ = lease.canceled() => Err(CANCELED.into()),
            result = timeout(Duration::from_secs(30), async {
            channel.exec(true, command()).await.map_err(|_| "Cannot start configuration inspection.")?;
            // Identity comes from the verified connection's profile, never a caller-selected account.
            let context = serde_json::to_vec(&serde_json::json!({"authenticatedUser": authenticated_user}))
                .map_err(|_| "Cannot prepare configuration context.")?;
            channel.data(context.as_slice()).await.map_err(|_| "Cannot send configuration context.")?;
            channel.eof().await.map_err(|_| "Cannot finish configuration context.")?;
            let mut bytes = Vec::new();
            let mut exit = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        if bytes.len() + data.len() > MAX_OUTPUT { return Err("Configuration output exceeded its limit.".into()); }
                        bytes.extend_from_slice(&data);
                    }
                    ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                    ChannelMsg::ExtendedData { .. } | ChannelMsg::Failure => return Err("Configuration probe could not run. Python 3 and readable system metadata are required. No software was installed.".into()),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            if exit != Some(0) { return Err("Configuration probe did not finish successfully. No changes were made.".into()); }
            parse(&bytes)
            }) => result.map_err(|_| "Configuration inspection timed out. No changes were requested.".to_string()).and_then(|result| result),
        };
        let _ = timeout(Duration::from_secs(2), channel.close()).await;
        let sections = result?;
        let runtime = self.runtime.lock().await;
        if *lease.2.borrow() {
            return Err(CANCELED.into());
        }
        if runtime.connection_ids.get(profile_id) != Some(&connection_id)
            || !runtime
                .connections
                .get(profile_id)
                .is_some_and(|h| !h.is_closed())
        {
            return Err("Connection changed during inspection. Results were discarded.".into());
        }
        Ok(ConfigurationSnapshot {
            profile_id: profile_id.into(),
            connection_id,
            observed_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "Device time is unavailable.")?
                .as_millis() as u64,
            sections,
        })
    }
}
#[tauri::command]
pub async fn ssh_configuration_snapshot(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    connection_id: String,
    operation_id: String,
) -> Result<ConfigurationSnapshot, String> {
    service
        .configuration_snapshot_request(&profile_id, &connection_id, &operation_id)
        .await
}
#[tauri::command]
pub fn ssh_configuration_cancel(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    connection_id: String,
    operation_id: String,
) -> Result<(), String> {
    service
        .configuration
        .cancel(&profile_id, &connection_id, &operation_id)
}
#[tauri::command]
pub fn ssh_configuration_describe() -> String {
    command()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_malformed_incomplete_duplicate_and_unbounded_evidence() {
        assert!(parse(b"[]").is_err());
        assert!(parse(b"not json").is_err());
        assert!(parse(&vec![b' '; MAX_OUTPUT + 1]).is_err());
        let mut data: Vec<serde_json::Value> = ["system","essentials","resources","security","docker","ssh","firewall","listeners"].iter().map(|id| serde_json::json!({"id":id,"title":id,"state":"partial","values":{},"message":null})).collect();
        assert!(parse(&serde_json::to_vec(&data).unwrap()).is_ok());
        data[7] = data[0].clone();
        assert!(parse(&serde_json::to_vec(&data).unwrap()).is_err());
        data[7]["id"] = "listeners".into();
        data[0]["values"] = serde_json::json!({"value":"unexpected\ncontrol"});
        assert!(parse(&serde_json::to_vec(&data).unwrap()).is_err());
    }
    #[test]
    fn per_server_leases_are_released_even_on_failure() {
        let state = State::default();
        let op = uuid::Uuid::new_v4().to_string();
        let lease = state.acquire("alpha", "generation", &op).unwrap();
        assert!(state.acquire("alpha", "generation", &op).is_err());
        assert!(state.acquire("beta", "generation", &op).is_ok());
        drop(lease);
        assert!(state.acquire("alpha", "generation", &op).is_ok());
    }
    #[tokio::test]
    async fn cancellation_is_request_bound_and_wakes_only_its_lease() {
        let state = State::default();
        let op = uuid::Uuid::new_v4().to_string();
        let wrong = uuid::Uuid::new_v4().to_string();
        let mut lease = state.acquire("alpha", "generation", &op).unwrap();
        let other = state.acquire("beta", "generation", &op).unwrap();
        assert!(state.cancel("alpha", "old-generation", &op).is_err());
        assert!(state.cancel("alpha", "generation", &wrong).is_err());
        assert!(!*lease.2.borrow());
        state.cancel("alpha", "generation", &op).unwrap();
        timeout(Duration::from_millis(50), lease.canceled())
            .await
            .unwrap();
        assert!(*lease.2.borrow());
        assert!(!*other.2.borrow());
        drop(lease);
        let newer = state.acquire("alpha", "generation", &wrong).unwrap();
        assert!(state.cancel("alpha", "generation", &op).is_err());
        assert!(!*newer.2.borrow());
    }
    #[test]
    fn early_cancels_are_bounded_expire_and_do_not_poison_other_generations() {
        let state = State::default();
        let op = uuid::Uuid::new_v4().to_string();
        state.cancel("alpha", "generation", &op).unwrap();
        assert!(state.acquire("alpha", "generation", &op).is_err());
        state.cancel("alpha", "generation", &op).unwrap();
        assert!(state.acquire("alpha", "new-generation", &op).is_ok());
        state
            .0
            .lock()
            .unwrap()
            .canceled
            .values_mut()
            .for_each(|time| {
                *time = Instant::now() - Duration::from_secs(61);
            });
        assert!(state.acquire("alpha", "generation", &op).is_ok());
        for _ in 0..100 {
            state
                .cancel("alpha", "generation", &uuid::Uuid::new_v4().to_string())
                .unwrap();
        }
        assert!(state.cancel("alpha", "generation", &op).is_err());
        assert!(state.cancel("alpha", "generation", "invalid").is_err());
    }
}
