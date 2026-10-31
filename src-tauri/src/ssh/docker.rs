pub mod manager;
use super::*;
use serde::Deserialize;
use serde_json::Value;
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Query {
    List,
    Details,
    Stats,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Start,
    Stop,
    Restart,
}
impl Operation {
    pub(super) fn verb(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
}
pub(super) fn id(value: &str) -> Result<&str, String> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Refresh inventory and choose an exact full container ID.".into());
    }
    Ok(value)
}
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub(super) fn command(query: Query, container: Option<&str>) -> Result<String, String> {
    let format = match query {
        Query::List => {
            r#"{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}},"ports":{{json .Ports}},"project":{{json (.Label "com.docker.compose.project")}},"service":{{json (.Label "com.docker.compose.service")}}}"#
        }
        Query::Details => {
            r#"{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"status":{{json .State.Status}},"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}},"restarts":{{json .RestartCount}},"health":{{if index .State "Health"}}{{json (index .State "Health").Status}}{{else}}"not configured"{{end}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"networkMode":{{json .HostConfig.NetworkMode}},"privileged":{{json .HostConfig.Privileged}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}},"environment":[{{range .Config.Env}}{{json (index (split . "=") 0)}},{{end}}null]}"#
        }
        Query::Stats => {
            r#"{"id":{{json .ID}},"cpu":{{json .CPUPerc}},"memory":{{json .MemUsage}},"memoryPercent":{{json .MemPerc}},"network":{{json .NetIO}},"disk":{{json .BlockIO}},"pids":{{json .PIDs}}}"#
        }
    };
    Ok(match query {
        Query::List => format!("docker ps -a --no-trunc --format {}", quoted(format)),
        Query::Details => format!(
            "docker inspect --type container --format {} -- {}",
            quoted(format),
            id(container.ok_or("Choose a container.")?)?
        ),
        Query::Stats => format!(
            "docker stats --no-stream --no-trunc --format {} -- {}",
            quoted(format),
            id(container.ok_or("Choose a container.")?)?
        ),
    })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    data: Vec<Value>,
    command: String,
    lifecycle_enabled: bool,
}
#[tauri::command]
pub async fn ssh_docker_query(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    query: Query,
    container: Option<String>,
) -> Result<Reply, String> {
    let command = command(query, container.as_deref())?;
    let runtime = service.runtime.lock().await;
    let text=services::collect(&runtime,&profile_id,&command).await.map_err(|_|"Docker query failed. Check Docker installation and your SSH user's socket access; no sudo is attempted.")?;
    let data = parse(&text)?;
    Ok(Reply {
        data,
        command,
        lifecycle_enabled: false,
    })
}
fn parse(text: &str) -> Result<Vec<Value>, String> {
    let rows: Vec<_> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if rows.len() > 1000 {
        return Err("Inventory exceeds 1,000 containers. Use the terminal to narrow it.".into());
    }
    rows.into_iter()
        .map(|line| {
            let row: Value = serde_json::from_str(line)
                .map_err(|_| "Docker returned an unsupported response.")?;
            id(row
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Docker response has no full container ID.")?)?;
            Ok(row)
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projections_never_request_environment_values_or_command_arguments() {
        let text = command(Query::Details, Some(&"a".repeat(64))).unwrap();
        assert!(text.contains("index (split . \"=\") 0"));
        assert!(!text.contains("json .Config.Env"));
        assert!(!text.contains(".Args"));
        assert!(command(Query::Stats, Some("--all")).is_err());
        assert!(id(&format!("{};x", "a".repeat(64))).is_err());
        assert!(parse("not json").is_err());
        assert_eq!(parse("").unwrap().len(), 0);
    }
}

#[cfg(test)]
mod safety_tests {
    use super::*;
    #[tokio::test]
    async fn production_lifecycle_gate_runs_before_any_connection_or_command() {
        let directory = tempfile::tempdir().unwrap();
        let service = SshService::new(directory.path().join("profiles.json"));
        for operation in [Operation::Start, Operation::Stop, Operation::Restart] {
            let error = service
                .review_action(
                    "nonexistent",
                    actions::AppAction::DockerChange {
                        container: "a".repeat(64),
                        operation,
                    },
                )
                .await
                .err()
                .unwrap();
            assert!(error.contains("disabled"));
        }
    }
    #[tokio::test]
    #[ignore = "Run tests/fixtures/run-ssh.sh; loopback disposable SSH PTY exec fixture only"]
    async fn disposable_openssh_container_style_pty_exec() {
        let port = std::env::var("VPS_PILOT_OPENSSH_FIXTURE_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let key = std::env::var("VPS_PILOT_OPENSSH_FIXTURE_IDENTITY").unwrap();
        let fingerprint = std::env::var("VPS_PILOT_OPENSSH_FIXTURE_FINGERPRINT").unwrap();
        let directory = tempfile::tempdir().unwrap();
        let service = SshService::new(directory.path().join("profiles.json"));
        let profile = service
            .save_profile(ProfileInput {
                id: None,
                name: "Disposable PTY exec fixture".into(),
                host: "127.0.0.1".into(),
                port,
                username: "root".into(),
                identity_file: Some(key),
                password_allowed: false,
            })
            .await
            .unwrap();
        let inspection = service.inspect(&profile.id).await.unwrap();
        assert_eq!(inspection.observed.fingerprint, fingerprint);
        service
            .trust(&profile.id, &inspection.challenge_id)
            .await
            .unwrap();
        service
            .connect(&profile.id, &inspection.challenge_id, "".into())
            .await
            .unwrap();
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let id = service
            .start_stream(
                &profile.id,
                Some((80, 24)),
                Some("printf 'container-style PTY exec fixture\\n'"),
                Arc::new(move |event| sender.send(event).is_ok()),
            )
            .await
            .unwrap();
        let mut output = String::new();
        timeout(Duration::from_secs(10), async {
            while let Some(event) = receiver.recv().await {
                match event {
                    streams::StreamEvent::Data { id, sequence, data } => {
                        output.push_str(&String::from_utf8_lossy(&data));
                        service
                            .control(&profile.id, &id, streams::Control::Ack(sequence))
                            .await
                            .unwrap();
                    }
                    streams::StreamEvent::Closed { code, .. } => {
                        assert_eq!(code, Some(0));
                        break;
                    }
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        assert!(output.contains("container-style PTY exec fixture"));
        service.close_stream(&profile.id, &id).await.unwrap();
        service.disconnect(&profile.id).await.unwrap();
    }
}
