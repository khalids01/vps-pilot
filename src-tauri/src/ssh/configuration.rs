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
const MAX_IDENTITY: usize = 128;
const MAX_ENTRIES: usize = 100;
const SNAPSHOT_TTL: Duration = Duration::from_secs(300);
const REVIEW_TTL: Duration = Duration::from_secs(120);
const EXECUTION_BLOCKER: &str = "Execution unavailable: validated backups, approvals and independent recovery are not implemented for this workflow.";
// Native titles and advice are fixed strings. Evidence values and server
// messages are never copied into a review or its blockers.
const QUICK_SETUP: [(&str, &str, &str); 6] = [
    (
        "system",
        "System",
        "Review operating-system and update evidence directly before making changes.",
    ),
    (
        "ssh",
        "Users and SSH",
        "Verify key and runtime-policy behavior independently before treating SSH access as hardened.",
    ),
    (
        "security",
        "Security",
        "Verify firewall recovery and security service behavior independently before making changes.",
    ),
    (
        "essentials",
        "Essential software",
        "Confirm package ownership and fresh update candidates independently.",
    ),
    (
        "docker",
        "Docker",
        "Review existing workloads and their dependencies in the Docker workspace.",
    ),
    (
        "resources",
        "Resources",
        "Treat resource capacity as advisory context only; no capacity guarantee is implied.",
    ),
];
#[derive(Default)]
struct Registry {
    running: HashMap<String, Running>,
    // Covers cancel arriving before the snapshot IPC task starts. Bounded and
    // short-lived; a delayed cancel can never target a different request.
    canceled: HashMap<(String, String, String), Instant>,
    // Memory-only native evidence cache. Renderer-supplied snapshots are never
    // accepted as the source for a review.
    snapshots: HashMap<String, CachedSnapshot>,
    reviews: HashMap<String, StoredReview>,
}
struct CachedSnapshot {
    snapshot: ConfigurationSnapshot,
    revision: String,
    collected: Instant,
}
struct StoredReview {
    review: ConfigurationReview,
    created: Instant,
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
    fn registry(&self) -> Result<std::sync::MutexGuard<'_, Registry>, String> {
        self.0
            .lock()
            .map_err(|_| "Configuration state is unavailable.".into())
    }
    // Only called after a canceled/failed inspection has been discarded, so a
    // successful noncanceled snapshot is the sole source of cached evidence.
    // Publication is serialized with State::cancel through the registry mutex,
    // so a cancel that arrives after the caller's final check cannot replace it.
    fn remember_snapshot(
        &self,
        snapshot: &ConfigurationSnapshot,
        revision: &str,
        operation_id: &str,
    ) -> Result<(), String> {
        let mut registry = self.registry()?;
        registry.prune();
        let still_running = registry
            .running
            .get(&snapshot.profile_id)
            .is_some_and(|running| {
                running.connection == snapshot.connection_id
                    && running.operation == operation_id
                    && !*running.cancel.borrow()
            });
        if !still_running {
            return Err(CANCELED.into());
        }
        if !registry.snapshots.contains_key(&snapshot.profile_id)
            && registry.snapshots.len() >= MAX_ENTRIES
        {
            registry.evict_oldest_snapshot();
        }
        registry.snapshots.insert(
            snapshot.profile_id.clone(),
            CachedSnapshot {
                snapshot: snapshot.clone(),
                revision: revision.into(),
                collected: Instant::now(),
            },
        );
        Ok(())
    }
    // Production callers pass identity already validated against the live
    // runtime connection and current profile revision.
    fn create_review(
        &self,
        profile_id: &str,
        connection_id: &str,
        revision: &str,
        snapshot_id: &str,
        selected: &[String],
    ) -> Result<ConfigurationReview, String> {
        validate_selection(selected)?;
        let mut registry = self.registry()?;
        registry.prune();
        if registry.running.contains_key(profile_id) {
            return Err("Wait for the current inspection to finish.".into());
        }
        let snapshot =
            registry.current_snapshot(profile_id, connection_id, revision, snapshot_id)?;
        let expires_at = epoch_millis(SystemTime::now())?
            .checked_add(REVIEW_TTL.as_millis() as u64)
            .ok_or("Device time is unavailable.")?;
        let review = ConfigurationReview {
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: profile_id.into(),
            connection_id: connection_id.into(),
            profile_revision: revision.into(),
            snapshot_id: snapshot.snapshot_id.clone(),
            observed_at: snapshot.observed_at,
            expires_at,
            can_execute: false,
            items: review_items(&snapshot, selected),
        };
        if registry.reviews.len() >= MAX_ENTRIES {
            registry.evict_oldest_review();
        }
        registry.reviews.insert(
            review.id.clone(),
            StoredReview {
                review: review.clone(),
                created: Instant::now(),
            },
        );
        Ok(review)
    }
    // Rechecking never contacts the server and never extends the stored expiry.
    fn recheck_review(
        &self,
        profile_id: &str,
        connection_id: &str,
        revision: &str,
        review_id: &str,
    ) -> Result<ConfigurationReview, String> {
        let mut registry = self.registry()?;
        registry.prune();
        if registry.running.contains_key(profile_id) {
            return Err("Wait for the current inspection to finish.".into());
        }
        let review = registry
            .reviews
            .get(review_id)
            .map(|stored| stored.review.clone())
            .ok_or("Configuration review expired. Create a new review.")?;
        if review.profile_id != profile_id
            || review.connection_id != connection_id
            || review.profile_revision != revision
        {
            return Err("Configuration review no longer matches this server.".into());
        }
        registry.current_snapshot(profile_id, connection_id, revision, &review.snapshot_id)?;
        Ok(review)
    }
}
impl Registry {
    fn prune(&mut self) {
        self.canceled
            .retain(|_, time| time.elapsed() < Duration::from_secs(60));
        self.snapshots
            .retain(|_, cached| cached.collected.elapsed() <= SNAPSHOT_TTL);
        self.reviews
            .retain(|_, stored| stored.created.elapsed() <= REVIEW_TTL);
    }
    fn evict_oldest_snapshot(&mut self) {
        if let Some(oldest) = self
            .snapshots
            .iter()
            .min_by_key(|(_, cached)| cached.collected)
            .map(|(id, _)| id.clone())
        {
            self.snapshots.remove(&oldest);
        }
    }
    fn evict_oldest_review(&mut self) {
        if let Some(oldest) = self
            .reviews
            .iter()
            .min_by_key(|(_, stored)| stored.created)
            .map(|(id, _)| id.clone())
        {
            self.reviews.remove(&oldest);
        }
    }
    fn current_snapshot(
        &mut self,
        profile_id: &str,
        connection_id: &str,
        revision: &str,
        snapshot_id: &str,
    ) -> Result<ConfigurationSnapshot, String> {
        self.prune();
        let cached = self
            .snapshots
            .get(profile_id)
            .ok_or("No current inspection evidence. Inspect this server again.")?;
        if cached.snapshot.snapshot_id != snapshot_id
            || cached.snapshot.profile_id != profile_id
            || cached.snapshot.connection_id != connection_id
            || cached.revision != revision
        {
            return Err("Inspection evidence changed. Inspect this server again.".into());
        }
        Ok(cached.snapshot.clone())
    }
}
fn validate_selection(selected: &[String]) -> Result<(), String> {
    if selected.is_empty() || selected.len() > QUICK_SETUP.len() {
        return Err("Select between one and six Quick Setup categories.".into());
    }
    let mut seen = HashSet::new();
    for id in selected {
        if id.len() > 64
            || !seen.insert(id.as_str())
            || !QUICK_SETUP.iter().any(|(known, _, _)| known == id)
        {
            return Err("Configuration review selection is invalid.".into());
        }
    }
    Ok(())
}
fn review_items(
    snapshot: &ConfigurationSnapshot,
    selected: &[String],
) -> Vec<ConfigurationReviewItem> {
    QUICK_SETUP
        .iter()
        .filter(|(id, _, _)| selected.iter().any(|value| value == id))
        .map(|(id, title, next_step)| {
            let state = snapshot
                .sections
                .iter()
                .find(|section| section.id == *id)
                .map(|section| section.state)
                .unwrap_or(EvidenceState::Unavailable);
            let mut blockers = vec![EXECUTION_BLOCKER.to_string()];
            match state {
                EvidenceState::Ready => {}
                EvidenceState::Partial => blockers.push(format!(
                    "Evidence for {title} is incomplete; verify the remaining items directly on the server."
                )),
                EvidenceState::Unavailable => blockers.push(format!(
                    "Evidence for {title} is unavailable; verify it directly on the server."
                )),
            }
            ConfigurationReviewItem {
                id: (*id).into(),
                title: (*title).into(),
                evidence_state: state,
                blockers,
                next_step: (*next_step).into(),
            }
        })
        .collect()
}
fn epoch_millis(time: SystemTime) -> Result<u64, String> {
    Ok(time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Device time is unavailable.")?
        .as_millis() as u64)
}
fn valid_review_identity(profile_id: &str, connection_id: &str) -> Result<(), String> {
    if profile_id.is_empty()
        || profile_id.len() > MAX_IDENTITY
        || connection_id.is_empty()
        || connection_id.len() > MAX_IDENTITY
    {
        return Err("Invalid configuration review identity.".into());
    }
    Ok(())
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceState {
    Ready,
    Partial,
    Unavailable,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationEvidence {
    id: String,
    title: String,
    state: EvidenceState,
    values: HashMap<String, String>,
    message: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationSnapshot {
    profile_id: String,
    connection_id: String,
    observed_at: u64,
    snapshot_id: String,
    sections: Vec<ConfigurationEvidence>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationReviewItem {
    id: String,
    title: String,
    evidence_state: EvidenceState,
    blockers: Vec<String>,
    next_step: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationReview {
    id: String,
    profile_id: String,
    connection_id: String,
    profile_revision: String,
    snapshot_id: String,
    observed_at: u64,
    expires_at: u64,
    can_execute: bool,
    items: Vec<ConfigurationReviewItem>,
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
            // Resolve required identity before opening a session channel so a
            // lookup failure cannot leave an unclosed late-confirmed channel.
            let profile = self.profile(profile_id)?;
            let channel = timeout(NETWORK_TIMEOUT, handle.channel_open_session())
                .await
                .map_err(|_| "Configuration channel timed out.")?
                .map_err(|_| "Cannot open configuration inspection.")?;
            Ok::<_, String>((
                channel,
                connection_id.clone(),
                profile.username,
                profile.revision,
            ))
        };
        // Do not drop channel_open_session after its open request was sent:
        // russh would lose the receiver needed to close a late-confirmed channel.
        // Let the existing network timeout bound confirmation, then close below
        // without executing the probe when cancellation arrived during opening.
        let (mut channel, connection_id, authenticated_user, revision_at_open) = opening.await?;
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
        let revision = self.profile(profile_id)?.revision;
        if revision != revision_at_open {
            return Err("Server profile changed during inspection. Results were discarded.".into());
        }
        let snapshot = ConfigurationSnapshot {
            profile_id: profile_id.into(),
            connection_id,
            observed_at: epoch_millis(SystemTime::now())?,
            snapshot_id: uuid::Uuid::new_v4().to_string(),
            sections,
        };
        // Cache only after the successful noncanceled snapshot and final
        // connection/profile checks. Publication rechecks the cancel token
        // under the registry lock. Review creation never trusts renderer data.
        self.configuration
            .remember_snapshot(&snapshot, &revision, operation_id)?;
        Ok(snapshot)
    }
    // Read-only readiness review. Runtime and profile identity are validated
    // here; the native cache is the sole evidence source. No channel is opened
    // and no command is generated or executed.
    pub(super) async fn configuration_review(
        &self,
        profile_id: &str,
        connection_id: &str,
        snapshot_id: &str,
        selected: Vec<String>,
    ) -> Result<ConfigurationReview, String> {
        valid_review_identity(profile_id, connection_id)?;
        if uuid::Uuid::parse_str(snapshot_id).is_err() {
            return Err("Configuration review evidence identity is invalid.".into());
        }
        validate_selection(&selected)?;
        let runtime = self.runtime.lock().await;
        if runtime.connection_ids.get(profile_id).map(String::as_str) != Some(connection_id)
            || !runtime
                .connections
                .get(profile_id)
                .is_some_and(|handle| !handle.is_closed())
        {
            return Err("Connect to this server first.".into());
        }
        let revision = self.profile(profile_id)?.revision;
        self.configuration.create_review(
            profile_id,
            connection_id,
            &revision,
            snapshot_id,
            &selected,
        )
    }
    // Rechecking is local: it never contacts the server and never extends expiry.
    pub(super) async fn configuration_review_validate(
        &self,
        profile_id: &str,
        connection_id: &str,
        review_id: &str,
    ) -> Result<ConfigurationReview, String> {
        valid_review_identity(profile_id, connection_id)?;
        if uuid::Uuid::parse_str(review_id).is_err() {
            return Err("Configuration review identity is invalid.".into());
        }
        let runtime = self.runtime.lock().await;
        if runtime.connection_ids.get(profile_id).map(String::as_str) != Some(connection_id)
            || !runtime
                .connections
                .get(profile_id)
                .is_some_and(|handle| !handle.is_closed())
        {
            return Err("Connect to this server first.".into());
        }
        let revision = self.profile(profile_id)?.revision;
        self.configuration
            .recheck_review(profile_id, connection_id, &revision, review_id)
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
#[tauri::command]
pub async fn ssh_configuration_review(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    connection_id: String,
    snapshot_id: String,
    selected: Vec<String>,
) -> Result<ConfigurationReview, String> {
    service
        .configuration_review(&profile_id, &connection_id, &snapshot_id, selected)
        .await
}
#[tauri::command]
pub async fn ssh_configuration_review_validate(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    connection_id: String,
    review_id: String,
) -> Result<ConfigurationReview, String> {
    service
        .configuration_review_validate(&profile_id, &connection_id, &review_id)
        .await
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
    fn ready_snapshot(profile: &str, connection: &str, snapshot_id: &str) -> ConfigurationSnapshot {
        let ids = [
            "system",
            "essentials",
            "resources",
            "security",
            "docker",
            "ssh",
            "firewall",
            "listeners",
        ];
        ConfigurationSnapshot {
            profile_id: profile.into(),
            connection_id: connection.into(),
            observed_at: 1_700_000_000_000,
            snapshot_id: snapshot_id.into(),
            sections: ids
                .iter()
                .map(|id| ConfigurationEvidence {
                    id: (*id).into(),
                    title: (*id).into(),
                    state: EvidenceState::Ready,
                    values: HashMap::from([("raw".into(), "secret-value".into())]),
                    message: Some("raw server message".into()),
                })
                .collect(),
        }
    }
    fn set_state(snapshot: &mut ConfigurationSnapshot, id: &str, state: EvidenceState) {
        snapshot
            .sections
            .iter_mut()
            .find(|section| section.id == id)
            .unwrap()
            .state = state;
    }
    fn store(
        state: &State,
        profile: &str,
        connection: &str,
        revision: &str,
        snapshot: &ConfigurationSnapshot,
    ) {
        let operation = uuid::Uuid::new_v4().to_string();
        let lease = state.acquire(profile, connection, &operation).unwrap();
        state
            .remember_snapshot(snapshot, revision, &operation)
            .unwrap();
        drop(lease);
    }
    fn selected(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).into()).collect()
    }
    #[test]
    fn review_binds_native_snapshot_and_never_enables_execution() {
        let state = State::default();
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let snapshot = ready_snapshot("alpha", "generation", &snapshot_id);
        store(&state, "alpha", "generation", "rev-1", &snapshot);
        let before = epoch_millis(SystemTime::now()).unwrap();
        let review = state
            .create_review(
                "alpha",
                "generation",
                "rev-1",
                &snapshot_id,
                &selected(&["resources", "system"]),
            )
            .unwrap();
        let after = epoch_millis(SystemTime::now()).unwrap();
        assert!(!review.can_execute);
        assert_eq!(review.profile_id, "alpha");
        assert_eq!(review.connection_id, "generation");
        assert_eq!(review.profile_revision, "rev-1");
        assert_eq!(review.snapshot_id, snapshot_id);
        assert_eq!(review.observed_at, snapshot.observed_at);
        assert!(review.expires_at >= before + 120_000 && review.expires_at <= after + 120_000);
        // Canonical category order, not caller order.
        assert_eq!(
            review
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["system", "resources"]
        );
        assert!(review
            .items
            .iter()
            .all(|item| item.blockers[0] == EXECUTION_BLOCKER));
        let projected = serde_json::to_string(&review).unwrap();
        assert!(!projected.contains("secret-value"));
        assert!(!projected.contains("raw server message"));
    }
    #[test]
    fn review_selection_rejects_empty_duplicate_unknown_and_oversized() {
        let state = State::default();
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let snapshot = ready_snapshot("alpha", "generation", &snapshot_id);
        store(&state, "alpha", "generation", "rev-1", &snapshot);
        let create =
            |ids: &[String]| state.create_review("alpha", "generation", "rev-1", &snapshot_id, ids);
        assert!(create(&[]).is_err());
        assert!(create(&selected(&["system", "system"])).is_err());
        assert!(create(&selected(&["system", "unknown"])).is_err());
        assert!(create(&selected(&[
            "system",
            "ssh",
            "security",
            "essentials",
            "docker",
            "resources",
            "system"
        ]))
        .is_err());
        assert!(create(&["system".to_string(), "x".repeat(65)]).is_err());
        assert!(state.registry().unwrap().reviews.is_empty());
    }
    #[test]
    fn review_rejects_missing_forged_foreign_and_stale_identity() {
        let state = State::default();
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let item = selected(&["system"]);
        assert!(state
            .create_review("alpha", "generation", "rev-1", &snapshot_id, &item)
            .is_err());
        let snapshot = ready_snapshot("alpha", "generation", &snapshot_id);
        store(&state, "alpha", "generation", "rev-1", &snapshot);
        assert!(state
            .create_review(
                "alpha",
                "generation",
                "rev-1",
                &uuid::Uuid::new_v4().to_string(),
                &item,
            )
            .is_err());
        assert!(state
            .create_review("beta", "generation", "rev-1", &snapshot_id, &item)
            .is_err());
        assert!(state
            .create_review("alpha", "other-generation", "rev-1", &snapshot_id, &item)
            .is_err());
        assert!(state
            .create_review("alpha", "generation", "rev-2", &snapshot_id, &item)
            .is_err());
        assert!(state
            .create_review("alpha", "generation", "rev-1", &snapshot_id, &item)
            .is_ok());
    }
    #[test]
    fn incomplete_and_unavailable_evidence_stay_blocked() {
        let state = State::default();
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let mut snapshot = ready_snapshot("alpha", "generation", &snapshot_id);
        set_state(&mut snapshot, "ssh", EvidenceState::Partial);
        set_state(&mut snapshot, "docker", EvidenceState::Unavailable);
        store(&state, "alpha", "generation", "rev-1", &snapshot);
        let review = state
            .create_review(
                "alpha",
                "generation",
                "rev-1",
                &snapshot_id,
                &selected(&["ssh", "docker", "system"]),
            )
            .unwrap();
        assert!(!review.can_execute);
        let item = |id: &str| review.items.iter().find(|item| item.id == id).unwrap();
        assert_eq!(item("system").blockers.len(), 1);
        assert_eq!(item("ssh").blockers.len(), 2);
        assert!(item("ssh").blockers[1].contains("incomplete"));
        assert_eq!(item("docker").blockers.len(), 2);
        assert!(item("docker").blockers[1].contains("unavailable"));
        assert!(review
            .items
            .iter()
            .all(|item| item.blockers[0] == EXECUTION_BLOCKER));
    }
    #[test]
    fn refreshed_evidence_and_identity_changes_invalidate_old_review() {
        let state = State::default();
        let first = uuid::Uuid::new_v4().to_string();
        store(
            &state,
            "alpha",
            "generation",
            "rev-1",
            &ready_snapshot("alpha", "generation", &first),
        );
        let review = state
            .create_review(
                "alpha",
                "generation",
                "rev-1",
                &first,
                &selected(&["system"]),
            )
            .unwrap();
        let same = state
            .recheck_review("alpha", "generation", "rev-1", &review.id)
            .unwrap();
        assert_eq!(same.id, review.id);
        assert_eq!(same.expires_at, review.expires_at);
        assert!(state
            .recheck_review("alpha", "generation", "rev-2", &review.id)
            .is_err());
        assert!(state
            .recheck_review("beta", "generation", "rev-1", &review.id)
            .is_err());
        assert!(state
            .recheck_review("alpha", "other-generation", "rev-1", &review.id)
            .is_err());
        let second = uuid::Uuid::new_v4().to_string();
        store(
            &state,
            "alpha",
            "generation",
            "rev-1",
            &ready_snapshot("alpha", "generation", &second),
        );
        assert!(state
            .recheck_review("alpha", "generation", "rev-1", &review.id)
            .is_err());
    }
    #[test]
    fn source_and_review_expiry_are_enforced_without_sleeping() {
        let state = State::default();
        let first = uuid::Uuid::new_v4().to_string();
        store(
            &state,
            "alpha",
            "generation",
            "rev-1",
            &ready_snapshot("alpha", "generation", &first),
        );
        let review = state
            .create_review(
                "alpha",
                "generation",
                "rev-1",
                &first,
                &selected(&["system"]),
            )
            .unwrap();
        state
            .registry()
            .unwrap()
            .reviews
            .get_mut(&review.id)
            .unwrap()
            .created = Instant::now() - Duration::from_secs(121);
        assert!(state
            .recheck_review("alpha", "generation", "rev-1", &review.id)
            .is_err());
        let second = uuid::Uuid::new_v4().to_string();
        store(
            &state,
            "alpha",
            "generation",
            "rev-1",
            &ready_snapshot("alpha", "generation", &second),
        );
        let current = state
            .create_review(
                "alpha",
                "generation",
                "rev-1",
                &second,
                &selected(&["system"]),
            )
            .unwrap();
        state
            .registry()
            .unwrap()
            .snapshots
            .get_mut("alpha")
            .unwrap()
            .collected = Instant::now() - Duration::from_secs(301);
        assert!(state
            .recheck_review("alpha", "generation", "rev-1", &current.id)
            .is_err());
    }
    #[test]
    fn in_flight_inspection_rejects_review_creation_and_recheck() {
        let state = State::default();
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        store(
            &state,
            "alpha",
            "generation",
            "rev-1",
            &ready_snapshot("alpha", "generation", &snapshot_id),
        );
        let review = state
            .create_review(
                "alpha",
                "generation",
                "rev-1",
                &snapshot_id,
                &selected(&["system"]),
            )
            .unwrap();
        let operation = uuid::Uuid::new_v4().to_string();
        let lease = state.acquire("alpha", "generation", &operation).unwrap();
        assert!(state
            .create_review(
                "alpha",
                "generation",
                "rev-1",
                &snapshot_id,
                &selected(&["system"])
            )
            .is_err());
        assert!(state
            .recheck_review("alpha", "generation", "rev-1", &review.id)
            .is_err());
        drop(lease);
        assert!(state
            .recheck_review("alpha", "generation", "rev-1", &review.id)
            .is_ok());
    }
    #[test]
    fn caches_and_reviews_are_bounded() {
        let state = State::default();
        let mut reviews = Vec::new();
        for index in 0..101u32 {
            let profile = format!("profile-{index}");
            let snapshot_id = uuid::Uuid::new_v4().to_string();
            store(
                &state,
                &profile,
                "generation",
                "rev-1",
                &ready_snapshot(&profile, "generation", &snapshot_id),
            );
            reviews.push(
                state
                    .create_review(
                        &profile,
                        "generation",
                        "rev-1",
                        &snapshot_id,
                        &selected(&["system"]),
                    )
                    .unwrap()
                    .id,
            );
        }
        let registry = state.registry().unwrap();
        assert_eq!(registry.snapshots.len(), MAX_ENTRIES);
        assert_eq!(registry.reviews.len(), MAX_ENTRIES);
        assert!(!registry.reviews.contains_key(&reviews[0]));
        assert!(registry.reviews.contains_key(&reviews[100]));
    }
    #[test]
    fn canceled_publication_keeps_previous_native_evidence() {
        let state = State::default();
        let previous = uuid::Uuid::new_v4().to_string();
        store(
            &state,
            "alpha",
            "generation",
            "rev-1",
            &ready_snapshot("alpha", "generation", &previous),
        );
        let operation = uuid::Uuid::new_v4().to_string();
        let lease = state.acquire("alpha", "generation", &operation).unwrap();
        state.cancel("alpha", "generation", &operation).unwrap();
        let newer = uuid::Uuid::new_v4().to_string();
        assert!(state
            .remember_snapshot(
                &ready_snapshot("alpha", "generation", &newer),
                "rev-1",
                &operation,
            )
            .is_err());
        drop(lease);
        let cached = state
            .registry()
            .unwrap()
            .snapshots
            .get("alpha")
            .unwrap()
            .snapshot
            .snapshot_id
            .clone();
        assert_eq!(cached, previous);
    }
}
