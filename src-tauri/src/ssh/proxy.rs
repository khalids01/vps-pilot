//! Fixed proxy-manager adapters; generic infrastructure-service gates stay closed.
use super::*;
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Manager {
    Caddy,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Reload,
    Restart,
}
pub fn command(operation: Option<Operation>, snapshot: &str) -> String {
    let verb = match operation {
        None => "detect",
        Some(Operation::Reload) => "reload",
        Some(Operation::Restart) => "restart",
    };
    let request =
        serde_json::json!({"manager":"caddy","operation":verb,"snapshot":snapshot}).to_string();
    let code = include_str!("proxy.py").replace(
        "json.loads(sys.stdin.readline(8193))",
        "json.loads(sys.argv[1])",
    );
    format!(
        "/usr/bin/python3 -I -S -c {} {}",
        super::docker::quoted(&code),
        super::docker::quoted(&request)
    )
}
pub fn snapshot(text: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "Invalid Caddy inspection.")?;
    if value["supported"] != true {
        return Err(value["message"]
            .as_str()
            .unwrap_or("No supported active Caddy service was detected.")
            .to_string());
    }
    let snapshot = value["snapshot"]
        .as_str()
        .ok_or("Missing Caddy snapshot.")?;
    if snapshot.len() != 64 || !snapshot.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid Caddy snapshot.".into());
    }
    Ok(snapshot.into())
}
#[tauri::command]
pub async fn ssh_proxy_detect(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    profile_revision: String,
    connection_id: String,
    manager: Manager,
) -> Result<serde_json::Value, String> {
    let _ = manager;
    if service.profile(&profile_id)?.revision != profile_revision {
        return Err("Server changed. Refresh Proxy.".into());
    }
    let runtime = service.runtime.lock().await;
    if runtime.connection_ids.get(&profile_id) != Some(&connection_id) {
        return Err("Connection changed. Refresh Proxy.".into());
    }
    let text = super::services::collect(&runtime, &profile_id, &command(None, "")).await?;
    serde_json::from_str(&text).map_err(|_| "Invalid proxy response.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_managers_and_actions_fail_closed() {
        assert!(serde_json::from_str::<Manager>("\"nginx\"").is_err());
        assert!(serde_json::from_str::<Operation>("\"stop\"").is_err());
    }
    #[test]
    fn only_supported_snapshots_are_accepted() {
        assert!(
            snapshot("{\"supported\":false,\"message\":\"Custom unit\"}")
                .unwrap_err()
                .contains("Custom unit")
        );
        assert!(snapshot("{\"supported\":true,\"snapshot\":\"arbitrary\"}").is_err());
        assert_eq!(
            snapshot(&serde_json::json!({"supported":true,"snapshot":"a".repeat(64)}).to_string())
                .unwrap(),
            "a".repeat(64)
        );
    }
    #[test]
    fn command_is_fixed_and_generic_proxy_gates_remain_closed() {
        let value = command(Some(Operation::Reload), &"a".repeat(64));
        assert!(value.starts_with("/usr/bin/python3 -I -S -c "));
        assert!(super::super::services::protected("caddy.service"));
        assert!(super::super::services::protected("nginx.service"));
    }
}
