//! Per-server SSH channels. Output is acknowledged before reading another packet.
//! Neither input nor output is persisted or written to application logs.
use super::*;
use russh::{Channel, ChannelMsg};
use tauri::ipc::Channel as IpcChannel;
use tokio::sync::{mpsc, oneshot};

pub(super) struct StreamHandle {
    pub profile_id: String,
    pub mutation_probe: Option<String>,
    pub verified: Arc<Mutex<bool>>,
    pub controls: mpsc::Sender<Control>,
    pub _cancel: oneshot::Sender<()>,
}
pub(super) enum Control {
    Input(Vec<u8>),
    Resize(u32, u32),
    Ack(u64),
}
#[derive(Clone, Serialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Inspection {
        id: String,
        report: structured::Report,
    },
    Data {
        id: String,
        sequence: u64,
        data: Vec<u8>,
    },
    Closed {
        id: String,
        code: Option<u32>,
        message: String,
    },
}
pub(super) type Sink = Arc<dyn Fn(StreamEvent) -> bool + Send + Sync>;

pub(super) fn dimensions(cols: u32, rows: u32) -> Result<(), String> {
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("Terminal dimensions are outside supported limits.".into());
    }
    Ok(())
}
async fn accepted(channel: &mut Channel<client::Msg>) -> Result<(), String> {
    timeout(NETWORK_TIMEOUT, async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure | ChannelMsg::Close) | None => {
                    return Err("The SSH server rejected the channel request.".into())
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| "The SSH channel request timed out.".to_string())?
}
impl SshService {
    pub(super) async fn start_stream(
        &self,
        profile_id: &str,
        terminal: Option<(u32, u32)>,
        command: Option<&str>,
        sink: Sink,
    ) -> Result<String, String> {
        // Serialize channel creation with disconnect/reconnect and limit sessions
        // while the runtime lock is held. No stale channel can attach to a new login.
        let mut runtime = self.runtime.lock().await;
        self.start_stream_locked(&mut runtime, profile_id, terminal, command, sink, None)
            .await
    }
    pub(super) async fn start_stream_locked(
        &self,
        runtime: &mut Runtime,
        profile_id: &str,
        terminal: Option<(u32, u32)>,
        command: Option<&str>,
        sink: Sink,
        sudo: Option<Zeroizing<String>>,
    ) -> Result<String, String> {
        for stream in runtime.streams.values().filter(|stream| {
            stream.controls.is_closed()
                && !*stream.verified.lock().unwrap_or_else(|e| e.into_inner())
        }) {
            if let Some(probe) = &stream.mutation_probe {
                runtime
                    .unresolved_changes
                    .insert(stream.profile_id.clone(), probe.clone());
            }
        }
        runtime
            .streams
            .retain(|_, stream| !stream.controls.is_closed());
        if runtime
            .streams
            .values()
            .filter(|s| s.profile_id == profile_id)
            .count()
            >= 12
        {
            return Err("Close a session before opening another (maximum 12 per server).".into());
        }
        let handle = runtime
            .connections
            .get(profile_id)
            .filter(|handle| !handle.is_closed())
            .ok_or("Connect to this server first.")?;
        let mut channel = timeout(NETWORK_TIMEOUT, async {
            let mut channel = handle
                .channel_open_session()
                .await
                .map_err(|_| "Could not open an SSH session.")?;
            if let Some((cols, rows)) = terminal {
                dimensions(cols, rows)?;
                channel
                    .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
                    .await
                    .map_err(|_| "Could not request a remote terminal.")?;
                accepted(&mut channel).await?;
                channel
                    .request_shell(true)
                    .await
                    .map_err(|_| "Could not request a shell.")?;
            } else {
                channel
                    .exec(true, command.ok_or("Missing app command.")?)
                    .await
                    .map_err(|_| "Could not start the app command.")?;
            }
            accepted(&mut channel).await?;
            Ok::<_, String>(channel)
        })
        .await
        .map_err(|_| "Opening the SSH session timed out.")??;
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel(32);
        let (cancel, cancelled) = oneshot::channel();
        let verified = Arc::new(Mutex::new(false));
        runtime.streams.insert(
            id.clone(),
            StreamHandle {
                profile_id: profile_id.into(),
                mutation_probe: None,
                verified: verified.clone(),
                controls: sender,
                _cancel: cancel,
            },
        );
        let stream_id = id.clone();
        tokio::spawn(async move {
            let result = run(
                &stream_id,
                &mut channel,
                terminal.is_some(),
                sink.clone(),
                receiver,
                cancelled,
                sudo,
            )
            .await;
            if matches!(result, Ok(Some(0))) {
                *verified.lock().unwrap_or_else(|e| e.into_inner()) = true;
            }
            // Closing a channel does not prove a remote child process has exited.
            let _ = timeout(Duration::from_secs(2), channel.close()).await;
            let (code, message) = match result {
                Ok(code) => (code, if code == Some(0) { "Completed." } else if terminal.is_some() { "Session ended. Remote processes may continue running." } else { "Command ended; inspect the exit status. Remote processes may continue running." }.into()),
                Err(message) => (None, message),
            };
            sink(StreamEvent::Closed {
                id: stream_id,
                code,
                message,
            });
        });
        Ok(id)
    }
    pub(super) async fn control(
        &self,
        profile_id: &str,
        id: &str,
        control: Control,
    ) -> Result<(), String> {
        let runtime = self.runtime.lock().await;
        let stream = runtime
            .streams
            .get(id)
            .filter(|s| s.profile_id == profile_id)
            .ok_or("This session is no longer available on this server.")?;
        stream.controls.try_send(control).map_err(|_| {
            "Session input is busy or the session has ended. Reopen the session if needed.".into()
        })
    }
    pub(super) async fn close_stream(&self, profile_id: &str, id: &str) -> Result<(), String> {
        let mut runtime = self.runtime.lock().await;
        if runtime
            .streams
            .get(id)
            .is_some_and(|s| s.profile_id != profile_id)
        {
            return Err("This session belongs to another server.".into());
        }
        if let Some(stream) = runtime.streams.remove(id) {
            if !*stream.verified.lock().unwrap_or_else(|e| e.into_inner()) {
                if let Some(probe) = stream.mutation_probe {
                    runtime.unresolved_changes.insert(profile_id.into(), probe);
                }
            }
        }
        Ok(())
    }
}
async fn run(
    id: &str,
    channel: &mut Channel<client::Msg>,
    terminal: bool,
    sink: Sink,
    mut controls: mpsc::Receiver<Control>,
    mut cancelled: oneshot::Receiver<()>,
    mut sudo: Option<Zeroizing<String>>,
) -> Result<Option<u32>, String> {
    let mut sequence = 0;
    let mut pending = None;
    let mut code = None;
    let mut bytes = 0usize;
    let mut prompt_buffer = Vec::new();
    let ack_deadline = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(ack_deadline);
    let command_deadline = tokio::time::sleep(Duration::from_secs(60));
    tokio::pin!(command_deadline);
    loop {
        tokio::select! {
            _ = &mut cancelled => return Err("Session closed. Remote processes may continue running; inspect before retrying.".into()),
            _ = &mut command_deadline, if !terminal => return Err("Command timed out. Its remote process may still be running.".into()),
            _ = &mut ack_deadline, if pending.is_some() => return Err("Output consumer stopped responding. Session closed; remote processes may continue running.".into()),
            control = controls.recv() => {
                let operation = async {
                    match control {
                        Some(Control::Input(data)) if terminal => channel.data(&data[..]).await,
                        Some(Control::Resize(cols, rows)) if terminal => channel.window_change(cols, rows, 0, 0).await,
                        Some(Control::Ack(value)) if pending == Some(value) => { pending = None; Ok(()) },
                        None => return Err("Session controls were disposed.".to_string()),
                        _ => Ok(()),
                    }.map_err(|_| "The SSH session stopped accepting input.".to_string())
                };
                timeout(Duration::from_secs(5), operation).await
                    .map_err(|_| "SSH input timed out; remote processes may continue running.".to_string())??;
            },
            message = channel.wait(), if pending.is_none() => {
                match message {
                    Some(message @ (ChannelMsg::Data { .. } | ChannelMsg::ExtendedData { .. })) => {
                        let (data, stderr) = match message {
                            ChannelMsg::Data { data } => (data, false),
                            ChannelMsg::ExtendedData { data, .. } => (data, true),
                            _ => unreachable!(),
                        };
                        bytes = bytes.saturating_add(data.len());
                        if data.len() > 65536 || (!terminal && bytes > 1024 * 1024) {
                            return Err("Output limit reached. Remote processes may continue running.".into());
                        }
                        let mut data = data.to_vec();
                        if let (true, Some(password)) = (stderr, sudo.as_mut()) {
                            let (filtered, requested) = filter_prompt(&mut prompt_buffer, &data);
                            data = filtered;
                            if requested {
                                if password.is_empty() { return Err("Sudo needs a password, or rejected the supplied password. Review again and enter your sudo password.".into()); }
                                password.push('\n');
                                timeout(Duration::from_secs(5), channel.data(password.as_bytes())).await
                                    .map_err(|_| "Sudo password input timed out.")?
                                    .map_err(|_| "Sudo password input failed.")?;
                                use zeroize::Zeroize;
                                password.zeroize();
                                channel.eof().await.map_err(|_| "Could not close sudo input.")?;
                            }
                        }
                        if data.is_empty() { continue; }
                        sequence += 1;
                        if !sink(StreamEvent::Data { id: id.into(), sequence, data }) {
                            return Err("Output receiver closed. Remote processes may continue running.".into());
                        }
                        pending = Some(sequence);
                        ack_deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(30));
                    },
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                    Some(ChannelMsg::Failure) => return Err("The SSH server rejected the session request.".into()),
                    Some(ChannelMsg::Close) | None => return Ok(code),
                    _ => {},
                }
            }
        }
    }
}
fn filter_prompt(pending: &mut Vec<u8>, chunk: &[u8]) -> (Vec<u8>, bool) {
    pending.extend_from_slice(chunk);
    let marker = actions::SUDO_PROMPT.as_bytes();
    let mut found = false;
    while let Some(index) = pending
        .windows(marker.len())
        .position(|part| part == marker)
    {
        pending.drain(index..index + marker.len());
        found = true;
    }
    let keep = (1..marker.len())
        .rev()
        .find(|length| pending.ends_with(&marker[..*length]))
        .unwrap_or(0);
    let emit = pending.len() - keep;
    (pending.drain(..emit).collect(), found)
}
#[cfg(test)]
mod prompt_tests {
    use super::*;
    #[test]
    fn sudo_prompt_fragments_are_suppressed_without_dropping_stderr() {
        let mut pending = Vec::new();
        assert_eq!(
            filter_prompt(&mut pending, b"warning\n[VPS Pilot su"),
            (b"warning\n".to_vec(), false)
        );
        assert_eq!(
            filter_prompt(&mut pending, b"do password] "),
            (vec![], true)
        );
        assert_eq!(
            filter_prompt(&mut pending, b"denied\n"),
            (b"denied\n".to_vec(), false)
        );
    }
}
#[tauri::command]
pub async fn ssh_terminal_open(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    cols: u32,
    rows: u32,
    output: IpcChannel<StreamEvent>,
) -> Result<String, String> {
    dimensions(cols, rows)?;
    service
        .start_stream(
            &profile_id,
            Some((cols, rows)),
            None,
            Arc::new(move |event| output.send(event).is_ok()),
        )
        .await
}
#[tauri::command]
pub async fn ssh_terminal_input(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() > 16384 {
        return Err("Paste at most 16 KiB at a time.".into());
    }
    service
        .control(&profile_id, &id, Control::Input(data))
        .await
}
#[tauri::command]
pub async fn ssh_terminal_resize(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    dimensions(cols, rows)?;
    service
        .control(&profile_id, &id, Control::Resize(cols, rows))
        .await
}
#[tauri::command]
pub async fn ssh_stream_ack(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    id: String,
    sequence: u64,
) -> Result<(), String> {
    service
        .control(&profile_id, &id, Control::Ack(sequence))
        .await
}
#[tauri::command]
pub async fn ssh_stream_close(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    id: String,
) -> Result<(), String> {
    service.close_stream(&profile_id, &id).await
}
