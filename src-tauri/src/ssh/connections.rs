//! Explicit read-only incoming SSH socket snapshot; never requests sudo.
use super::*;
#[tauri::command]
pub async fn ssh_incoming_connections(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    connection_id: String,
) -> Result<serde_json::Value, String> {
    let runtime = service.runtime.lock().await;
    if runtime.connection_ids.get(&profile_id) != Some(&connection_id) {
        return Err("Connection changed. Refresh SSH connections.".into());
    }
    let command = format!(
        "python3 -I -S -c {}",
        super::docker::quoted(include_str!("connections.py"))
    );
    let text = super::services::collect(&runtime, &profile_id, &command).await?;
    serde_json::from_str(&text).map_err(|_| "Incoming SSH connections unavailable.".into())
}
