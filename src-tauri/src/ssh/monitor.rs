//! A fixed, unprivileged sampler with one channel per profile and ack backpressure.
use super::*;
use russh::{Channel, ChannelMsg};
use serde::Deserialize;
use streams::{Control, Sink, StreamEvent};
use tokio::sync::{mpsc, oneshot};

pub const SAMPLER: &str = include_str!("sampler.py");
pub fn command() -> String {
    format!(
        "exec python3 -I -S -B -u -c '{}'",
        SAMPLER.replace('\'', "'\\''")
    )
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capacity {
    pub total: u64,
    pub free: u64,
    pub available: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sample {
    pub uptime: f64,
    pub cpu_total: u64,
    pub cpu_idle: u64,
    pub memory_total: u64,
    pub memory_available: u64,
    pub swap_total: u64,
    pub swap_free: u64,
    pub network_interface: Option<String>,
    pub network_received: Option<u64>,
    pub network_sent: Option<u64>,
    pub disk_read: Option<u64>,
    pub disk_written: Option<u64>,
    pub capacity: Option<Capacity>,
    pub capacity_age: u64,
}
impl Sample {
    fn parse(data: &[u8]) -> Result<Self, String> {
        let sample: Self = serde_json::from_slice(data)
            .map_err(|_| "The live sampler returned an unsupported response.")?;
        if !sample.uptime.is_finite()
            || sample.uptime < 0.0
            || sample.cpu_idle > sample.cpu_total
            || sample.memory_total == 0
            || sample.memory_available > sample.memory_total
            || sample.swap_free > sample.swap_total
            || sample.network_interface.as_ref().is_some_and(|name| {
                name.is_empty()
                    || name.len() > 64
                    || !name
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
            })
            || sample
                .capacity
                .as_ref()
                .is_some_and(|fs| fs.total == 0 || fs.free > fs.total || fs.available > fs.free)
        {
            return Err("The live sampler returned invalid counters.".into());
        }
        Ok(sample)
    }
}

impl SshService {
    pub(super) async fn start_monitor(
        &self,
        profile_id: &str,
        interval_seconds: u64,
        sink: Sink,
    ) -> Result<String, String> {
        if ![1, 2, 5].contains(&interval_seconds) {
            return Err("Choose a live sampling interval of 1, 2, or 5 seconds.".into());
        }
        let mut runtime = self.runtime.lock().await;
        if runtime.streams.values().any(|stream| {
            stream.profile_id == profile_id && stream.monitoring && !*stream.finished.borrow()
        }) {
            return Err("Live monitoring is already running on this server.".into());
        }
        self.start_stream_locked(
            &mut runtime,
            profile_id,
            streams::Mode::Monitor(interval_seconds),
            Some(&command()),
            sink,
            None,
        )
        .await
    }
}
pub(super) async fn run(
    id: &str,
    channel: &mut Channel<client::Msg>,
    interval_seconds: u64,
    sink: Sink,
    mut controls: mpsc::Receiver<Control>,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<Option<u32>, String> {
    let mut sequence = 0;
    let mut pending = None;
    let mut receiving = false;
    let mut buffer = Vec::new();
    let mut code = None;
    let next = tokio::time::sleep(Duration::ZERO);
    let deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(next, deadline);
    let mut sent_at = Instant::now();
    loop {
        tokio::select! {
            _ = &mut cancelled => return Ok(None),
            _ = &mut deadline, if receiving || pending.is_some() =>
                return Err("Live monitoring stopped: the sampler or desktop did not respond. Retry when the connection is stable.".into()),
            _ = &mut next, if !receiving && pending.is_none() => {
                sent_at = Instant::now();
                timeout(Duration::from_secs(5), channel.data(&b"sample\n"[..])).await
                    .map_err(|_| "Live sampling request timed out.")?
                    .map_err(|_| "The SSH sampler stopped accepting requests.")?;
                receiving = true;
                deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(5));
            },
            control = controls.recv() => match control {
                Some(Control::Ack(value)) if pending == Some(value) => pending = None,
                None => return Ok(None),
                // A monitor is never an interactive shell; reject input/resize implicitly.
                _ => {},
            },
            message = channel.wait(), if pending.is_none() => match message {
                Some(ChannelMsg::Data { data }) if receiving => {
                    if buffer.len().saturating_add(data.len()) > 16384 {
                        return Err("Live sampler output exceeded its safety limit.".into());
                    }
                    buffer.extend_from_slice(&data);
                    if let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                        if end + 1 != buffer.len() {
                            return Err("The sampler sent more than one response per request.".into());
                        }
                        let sample = Sample::parse(&buffer[..end])?;
                        buffer.clear();
                        receiving = false;
                        sequence += 1;
                        // Slow samples naturally reduce the refresh rate; never catch up in a burst.
                        let delay = Duration::from_secs(interval_seconds).max(sent_at.elapsed());
                        next.as_mut().reset(tokio::time::Instant::now() + delay);
                        if !sink(StreamEvent::Metrics { id: id.into(), sequence, sample }) {
                            return Ok(None);
                        }
                        pending = Some(sequence);
                        deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(10));
                    }
                },
                Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                Some(ChannelMsg::ExtendedData { .. } | ChannelMsg::Failure) =>
                    return Err("Live metrics need Linux /proc and Python 3 for this SSH user. Nothing was installed. Check availability and permissions before retrying.".into()),
                Some(ChannelMsg::Data { .. }) =>
                    return Err("Unexpected live sampler output.".into()),
                Some(ChannelMsg::Close) | None => return Ok(code),
                _ => {},
            }
        }
    }
}
#[tauri::command]
pub fn ssh_monitor_describe() -> String {
    command()
}
#[derive(Serialize)]
pub struct MonitorRun {
    id: String,
    command: String,
}
#[tauri::command]
pub async fn ssh_monitor_start(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    interval_seconds: u64,
    output: tauri::ipc::Channel<StreamEvent>,
) -> Result<MonitorRun, String> {
    let id = service
        .start_monitor(
            &profile_id,
            interval_seconds,
            Arc::new(move |event| output.send(event).is_ok()),
        )
        .await?;
    Ok(MonitorRun {
        id,
        command: command(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_or_unbounded_counters_without_exposing_raw_response() {
        let mut data = serde_json::json!({
            "uptime": 1.0, "cpuTotal": 100, "cpuIdle": 50,
            "memoryTotal": 1024, "memoryAvailable": 512, "swapTotal": 0, "swapFree": 0,
            "networkInterface": "eth0", "networkReceived": 0, "networkSent": 0,
            "diskRead": null, "diskWritten": null, "capacity": null, "capacityAge": 0
        });
        assert!(Sample::parse(&serde_json::to_vec(&data).unwrap()).is_ok());
        for (field, value) in [
            ("memoryAvailable", serde_json::json!(2048)),
            ("cpuIdle", serde_json::json!(101)),
            ("networkInterface", serde_json::json!("bad\nsecret")),
            ("cpuTotal", serde_json::json!(-1)),
            (
                "capacity",
                serde_json::json!({"total": 0, "free": 0, "available": 0}),
            ),
        ] {
            let previous = data[field].clone();
            data[field] = value;
            let error = Sample::parse(&serde_json::to_vec(&data).unwrap()).unwrap_err();
            assert!(!error.contains("secret"));
            data[field] = previous;
        }
    }
}
