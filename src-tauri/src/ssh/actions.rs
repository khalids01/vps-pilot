//! Native, single-use approval capabilities. The frontend never supplies a shell command.
use super::*;
use serde::Deserialize;
use streams::{Sink, StreamEvent};
use tauri::ipc::Channel;
pub(super) const SUDO_PROMPT: &str = "[VPS Pilot sudo password] ";

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum AppAction {
    UfwStatus {},
    ServiceChange {
        unit: String,
        operation: services::ServiceOperation,
    },
    ServiceLogs {
        unit: String,
    },
    DockerLogs {
        container: String,
    },
    DiskScan {
        path: String,
    },
    SoftwarePreflight {
        software: catalog::Software,
    },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionPlan {
    pub id: String,
    pub profile_id: String,
    pub server_name: String,
    pub address: String,
    pub command: String,
    pub purpose: String,
    pub privileged: bool,
    pub expires_in_seconds: u32,
    pub evidence: Option<String>,
}
pub(super) struct PendingApproval {
    pub profile_id: String,
    connection_id: String,
    revision: String,
    plan: ActionPlan,
    pub(super) issued: Instant,
    pub(super) precondition: Option<(String, String)>,
}
fn unit(value: &str) -> Result<&str, String> {
    if value.len() > 200
        || !value.ends_with(".service")
        || value.starts_with('-')
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b))
    {
        return Err(
            "Enter an exact systemd .service unit name using letters, numbers, _, ., @, :, or -."
                .into(),
        );
    }
    Ok(value)
}
fn container(value: &str) -> Result<&str, String> {
    if !(12..=64).contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(
            "Use the exact hexadecimal container ID (12–64 characters) from inspection.".into(),
        );
    }
    Ok(value)
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
impl AppAction {
    fn describe(&self) -> Result<(String, String, bool), String> {
        Ok(match self {
            Self::ServiceChange { unit: name, operation } => {
                unit(name)?;
                if services::protected(name) { return Err("This connection-critical, platform, proxy, or infrastructure service is protected. Use its integration or the terminal.".into()); }
                (format!("/usr/bin/systemctl {} -- {}", operation.verb(), quote(name)), format!("{} {name}. This can interrupt the selected application and its dependents. Boot changes do not immediately start or stop the service. No automatic retry or rollback is performed.", operation.verb()), true)
            },
            Self::SoftwarePreflight { software } => (software.preflight(), format!("Inspect {} installation ownership, system support, listeners, inactive container port reservations, and deployment platform ownership. No software is installed or changed.", software.binary()), false),
            Self::UfwStatus {} => ("/usr/sbin/ufw status numbered".into(), "Read UFW status and numbered rules. No firewall rules will change.".into(), true),
            Self::ServiceLogs { unit: name } => (format!("/usr/bin/journalctl --no-pager -n 200 -u {}", quote(unit(name)?)), format!("Read the last 200 journal entries for {name}. Output may contain application secrets; it stays in memory."), true),
            Self::DockerLogs { container: id } => (format!("docker logs --tail 200 -- {}", quote(container(id)?)), "Read the selected container's last 200 log lines. Output stays in memory.".into(), false),
            Self::DiskScan { path } => {
                if !path.starts_with('/') || path.len() > 1024 || path.chars().any(char::is_control) {
                    return Err("Use an absolute remote path of at most 1024 characters without control characters.".into());
                }
                (format!("du -x -k -d 1 -- {}", quote(path)), "Scan one directory level without crossing filesystem boundaries. Permission errors remain visible; no files are removed.".into(), false)
            },
        })
    }
}
impl SshService {
    pub(super) async fn review_action(
        &self,
        profile_id: &str,
        action: AppAction,
    ) -> Result<ActionPlan, String> {
        if matches!(action, AppAction::ServiceChange { .. }) && !self.changes_enabled {
            return Err("This build is read-only for app actions. Service changes require disposable-server validation before they can be enabled. SSH terminals and read-only inspections remain available.".into());
        }
        let (command, purpose, privileged) = action.describe()?;
        let mut runtime = self.runtime.lock().await;
        let profile = self.profile(profile_id)?;
        let connection_id = runtime
            .connection_ids
            .get(profile_id)
            .cloned()
            .ok_or("Connect to this server first.")?;
        if !runtime
            .connections
            .get(profile_id)
            .is_some_and(|h| !h.is_closed())
        {
            return Err("Connect to this server first.".into());
        }
        if matches!(action, AppAction::ServiceChange { .. }) {
            let failed = runtime
                .streams
                .values()
                .find(|stream| {
                    stream.profile_id == profile_id
                        && stream.controls.is_closed()
                        && !*stream.verified.lock().unwrap_or_else(|e| e.into_inner())
                })
                .and_then(|stream| stream.mutation_probe.clone());
            if let Some(probe) = failed {
                runtime.unresolved_changes.insert(profile_id.into(), probe);
            }

            if let Some(probe) = runtime.unresolved_changes.get(profile_id).cloned() {
                let state = services::collect(&runtime, profile_id, &probe).await?;
                if !services::settled(&state) {
                    return Err("A previous change may still be running. Inspect the service and wait for a stable state before reviewing another change.".into());
                }
                runtime.unresolved_changes.remove(profile_id);
            }
        }
        let precondition = if let AppAction::ServiceChange { unit, operation } = &action {
            let command = services::probe(unit);
            let snapshot = services::collect(&runtime, profile_id, &command).await?;
            services::validate(&snapshot, unit, *operation)?;
            Some((command, snapshot))
        } else {
            None
        };
        runtime
            .approvals
            .retain(|_, p| p.issued.elapsed() < Duration::from_secs(120));
        if runtime.approvals.len() >= 100 {
            return Err("Too many pending reviews. Close old reviews and try again.".into());
        }
        let plan = ActionPlan {
            id: Uuid::new_v4().to_string(),
            profile_id: profile_id.into(),
            server_name: profile.name,
            address: format!("{}@{}:{}", profile.username, profile.host, profile.port),
            command: if privileged {
                format!("sudo -S -p {} -- {command}", quote(SUDO_PROMPT))
            } else {
                command
            },
            purpose,
            privileged,
            expires_in_seconds: 120,
            evidence: precondition.as_ref().map(|(_, snapshot)| snapshot.clone()),
        };
        let mut plan = plan;
        if let AppAction::ServiceChange { unit, operation } = &action {
            plan.command
                .push_str(&format!(" && {}", operation.verify(unit)));
        }
        runtime.approvals.insert(
            plan.id.clone(),
            PendingApproval {
                profile_id: profile_id.into(),
                connection_id,
                revision: profile.revision,
                plan: plan.clone(),
                precondition,
                issued: Instant::now(),
            },
        );
        Ok(plan)
    }
    pub(super) async fn execute_action(
        &self,
        profile_id: &str,
        plan_id: &str,
        password: String,
        sink: Sink,
    ) -> Result<String, String> {
        let password = Zeroizing::new(password);
        if password.len() > 4096 || password.contains(['\n', '\r', '\0']) {
            return Err("Invalid sudo password.".into());
        }
        // Claiming a token consumes it, including on wrong-target or expired requests.
        // All channel setup runs under the same runtime lock as disconnect.
        let mut runtime = self.runtime.lock().await;
        let pending = runtime
            .approvals
            .remove(plan_id)
            .ok_or("This approval is no longer available. Review the command again.")?;
        if pending.profile_id != profile_id
            || pending.issued.elapsed() >= Duration::from_secs(120)
            || runtime.connection_ids.get(profile_id) != Some(&pending.connection_id)
            || self.profile(profile_id)?.revision != pending.revision
        {
            return Err(
                "This approval expired or its server identity changed. Review the command again."
                    .into(),
            );
        }
        let mutation = pending.precondition.is_some();
        if mutation && !self.changes_enabled {
            return Err("App-triggered changes are disabled in this read-only build.".into());
        }
        if mutation {
            if runtime.streams.values().any(|stream| {
                stream.profile_id == profile_id
                    && stream.mutation_probe.is_some()
                    && !stream.controls.is_closed()
            }) {
                return Err("A server change is already running. Wait for its result and inspect before retrying.".into());
            }
            let (command, expected) = pending.precondition.as_ref().unwrap();
            if services::collect(&runtime, profile_id, command).await? != *expected {
                return Err("Server state changed since review. Nothing was changed; inspect and review a fresh plan.".into());
            }
        }
        let id = self
            .start_stream_locked(
                &mut runtime,
                profile_id,
                None,
                Some(&pending.plan.command),
                sink,
                if pending.plan.privileged {
                    Some(password)
                } else {
                    None
                },
            )
            .await?;
        if mutation {
            if let Some(stream) = runtime.streams.get_mut(&id) {
                stream.mutation_probe = pending
                    .precondition
                    .as_ref()
                    .map(|(command, _)| command.clone());
            }
        }
        Ok(id)
    }
}
#[tauri::command]
pub async fn ssh_action_review(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    action: AppAction,
) -> Result<ActionPlan, String> {
    service.review_action(&profile_id, action).await
}
#[tauri::command]
pub async fn ssh_action_execute(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    plan_id: String,
    password: String,
    output: Channel<StreamEvent>,
) -> Result<String, String> {
    service
        .execute_action(
            &profile_id,
            &plan_id,
            password,
            Arc::new(move |event| output.send(event).is_ok()),
        )
        .await
}
#[tauri::command]
pub async fn ssh_action_reject(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    plan_id: String,
) -> Result<(), String> {
    let mut runtime = service.runtime.lock().await;
    if runtime
        .approvals
        .get(&plan_id)
        .is_some_and(|p| p.profile_id == profile_id)
    {
        runtime.approvals.remove(&plan_id);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_actions_reject_options_injection_and_unbounded_targets() {
        for value in [
            "-u.service",
            "x;reboot.service",
            "a\n.service",
            "a.service /etc",
            "ssh",
        ] {
            assert!(unit(value).is_err());
        }
        for value in ["--all", "abc;reboot", "1234"] {
            assert!(container(value).is_err());
        }
        assert!(AppAction::DiskScan {
            path: "relative".into()
        }
        .describe()
        .is_err());
        assert_eq!(
            AppAction::DiskScan {
                path: "/srv/user's files".into()
            }
            .describe()
            .unwrap()
            .0,
            "du -x -k -d 1 -- '/srv/user'\\''s files'"
        );
        assert!(serde_json::from_value::<AppAction>(
            serde_json::json!({"type":"ufwStatus", "command":"reboot"})
        )
        .is_err());
    }
}
