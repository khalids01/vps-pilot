//! Bounded, explicit read-only configuration discovery over the verified connection.
use super::*;
use russh::ChannelMsg;
use serde::Deserialize;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

const PROBE: &str = include_str!("configuration_probe.py");
const MAX_OUTPUT: usize = 131_072;
#[derive(Default)]
pub(super) struct State(Arc<Mutex<HashSet<String>>>);
struct Lease(Arc<Mutex<HashSet<String>>>, String);
impl State {
    fn acquire(&self, id: &str) -> Result<Lease, String> {
        let mut running = self
            .0
            .lock()
            .map_err(|_| "Configuration inspection is unavailable.")?;
        if running.contains(id) || running.len() >= 100 {
            return Err(
                "Configuration inspection is already running. Wait before refreshing.".into(),
            );
        }
        running.insert(id.into());
        Ok(Lease(self.0.clone(), id.into()))
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut running) = self.0.lock() {
            running.remove(&self.1);
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
    pub(super) async fn configuration_snapshot(
        &self,
        profile_id: &str,
        expected_connection: &str,
    ) -> Result<ConfigurationSnapshot, String> {
        let _lease = self.configuration.acquire(profile_id)?;
        let (mut channel, connection_id) = {
            let runtime = self.runtime.lock().await;
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
            (channel, connection_id.clone())
        };
        // Release the runtime lock while probes run: terminals and monitoring keep working.
        let result = timeout(Duration::from_secs(30), async {
            channel.exec(true, command()).await.map_err(|_| "Cannot start configuration inspection.")?;
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
        }).await;
        let _ = timeout(Duration::from_secs(2), channel.close()).await;
        let sections = result
            .map_err(|_| "Configuration inspection timed out. No changes were requested.")??;
        let runtime = self.runtime.lock().await;
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
) -> Result<ConfigurationSnapshot, String> {
    service
        .configuration_snapshot(&profile_id, &connection_id)
        .await
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
        let lease = state.acquire("alpha").unwrap();
        assert!(state.acquire("alpha").is_err());
        assert!(state.acquire("beta").is_ok());
        drop(lease);
        assert!(state.acquire("alpha").is_ok());
    }
}
