//! Bounded presentation models derived from fixed read-only command outputs.
use super::*;
use serde_json::Value;
use streams::{Sink, StreamEvent};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub sections: Vec<Section>,
    pub overview: Option<Overview>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub title: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub state: String,
    pub message: Option<String>,
    pub truncated: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub os: Option<String>,
    pub architecture: Option<String>,
    pub memory_total: Option<u64>,
    pub memory_available: Option<u64>,
    pub cpu_total: Option<u64>,
    pub cpu_idle: Option<u64>,
}
#[derive(Clone, Copy)]
pub(super) enum Format {
    Inspection(discovery::InspectionKind),
    Firewall,
    Directory,
    Logs,
}

pub(super) fn wrap(sink: Sink, format: Format) -> Sink {
    let buffer = Mutex::new(Vec::new());
    Arc::new(move |event| {
        match &event {
            StreamEvent::Data { data, .. } => {
                let mut bytes = buffer.lock().unwrap_or_else(|e| e.into_inner());
                let remaining = (1024 * 1024usize).saturating_sub(bytes.len());
                bytes.extend_from_slice(&data[..data.len().min(remaining)]);
            }
            StreamEvent::Closed { id, code, .. } => {
                let bytes = buffer.lock().unwrap_or_else(|e| e.into_inner());
                let text = String::from_utf8_lossy(&bytes);
                if !sink(StreamEvent::Inspection {
                    id: id.clone(),
                    report: parse(&text, format, *code),
                }) {
                    return false;
                }
            }
            _ => {}
        }
        sink(event)
    })
}
fn table(title: &str, columns: &[&str], rows: Vec<Vec<String>>) -> Section {
    let truncated = rows.len() > 2000;
    let rows: Vec<_> = rows.into_iter().take(2000).collect();
    Section {
        title: title.into(),
        columns: columns.iter().map(|v| (*v).into()).collect(),
        state: if rows.is_empty() { "empty" } else { "ready" }.into(),
        rows,
        message: None,
        truncated,
    }
}
fn words(text: &str, count: usize) -> Vec<Vec<String>> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().map(String::from).collect();
            if fields.len() < count {
                return None;
            }
            let mut result = fields[..count - 1].to_vec();
            result.push(fields[count - 1..].join(" "));
            Some(result)
        })
        .collect()
}
fn tsv(text: &str, count: usize) -> Vec<Vec<String>> {
    text.lines()
        .filter_map(|line| {
            let mut fields: Vec<_> = line.splitn(count, '\t').map(String::from).collect();
            if fields.len() < count {
                return None;
            }
            fields.truncate(count);
            Some(fields)
        })
        .collect()
}
fn string(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        Value::Null => "—".into(),
        v => v.to_string(),
    }
}
fn json_rows(text: &str, keys: &[&str], root: Option<&str>) -> Vec<Vec<String>> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return vec![];
    };
    let value = root.and_then(|key| value.get(key)).unwrap_or(&value);
    fn visit(value: &Value, keys: &[&str], result: &mut Vec<Vec<String>>) {
        if let Some(items) = value.as_array() {
            for item in items.iter().take(2001) {
                result.push(keys.iter().map(|key| string(&item[*key])).collect());
                if result.len() > 2000 {
                    return;
                }
                if let Some(children) = item.get("children") {
                    visit(children, keys, result);
                }
            }
        }
    }
    let mut result = vec![];
    visit(value, keys, &mut result);
    result
}
fn listeners(title: &str, text: &str) -> Section {
    let rows = words(text, 6)
        .into_iter()
        .filter_map(|fields| {
            if !matches!(fields[0].as_str(), "tcp" | "udp") {
                return None;
            }
            let (address, port) = fields[4].rsplit_once(':').unwrap_or((&fields[4], "—"));
            let process = fields[5]
                .split("users:")
                .nth(1)
                .unwrap_or("Unavailable")
                .to_string();
            Some(vec![
                fields[0].clone(),
                address.to_string(),
                port.to_string(),
                process,
            ])
        })
        .collect();
    table(title, &["Protocol", "Address", "Port", "Process"], rows)
}
fn firewall(title: &str, text: &str) -> Section {
    let rows = text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if !line.starts_with('[') {
                return None;
            }
            let (number, tail) = line.split_once(']')?;
            let action_start = ["ALLOW", "DENY", "REJECT", "LIMIT"]
                .iter()
                .filter_map(|action| tail.find(action))
                .min()?;
            let target = tail[..action_start].trim();
            let rest: Vec<_> = tail[action_start..].split_whitespace().collect();
            if rest.len() < 3 {
                return None;
            }
            Some(vec![
                number.trim_start_matches('[').trim().into(),
                target.into(),
                rest[..2].join(" "),
                rest[2..].join(" "),
            ])
        })
        .collect();
    let mut result = table(title, &["Rule", "Destination", "Action", "Source"], rows);
    if text.lines().any(|line| line.trim() == "Status: inactive") {
        result.message = Some("UFW is inactive.".into());
    } else if text.lines().any(|line| line.trim() == "Status: active") {
        result.message = Some("UFW is active.".into());
    }
    result
}
fn section(title: &str, text: &str) -> Section {
    let clean: String = text
        .lines()
        .filter(|line| !line.starts_with("[section failed:"))
        .collect::<Vec<_>>()
        .join("\n");
    let text = clean.trim_matches(['\r', '\n']);
    let mut result = match title {
        "Filesystems" => table(
            title,
            &[
                "Filesystem",
                "Total KiB",
                "Used KiB",
                "Available KiB",
                "Used",
                "Mount",
            ],
            words(text, 6)
                .into_iter()
                .filter(|row| row[1].parse::<u64>().is_ok())
                .collect(),
        ),
        "Containers, including stopped" => table(
            "Containers",
            &["ID", "Name", "Image", "Status", "Ports"],
            tsv(text, 5),
        ),
        "Compose projects" => table(
            title,
            &["Project", "Status", "Configuration"],
            json_rows(text, &["Name", "Status", "ConfigFiles"], None),
        ),
        "Images" => table(
            title,
            &["Repository", "Tag", "ID", "Digest", "Size"],
            tsv(text, 5),
        ),
        "Volumes" => table(title, &["Name", "Driver", "Scope"], tsv(text, 3)),
        "Docker disk usage" => table(
            title,
            &["Type", "Total", "Active", "Size", "Reclaimable"],
            tsv(text, 5),
        ),
        "Service state" | "Failed services" => table(
            title,
            &["Service", "Loaded", "State", "Detail", "Description"],
            words(text, 5)
                .into_iter()
                .filter(|row| row[0].ends_with(".service"))
                .collect(),
        ),
        "Boot enablement" => table(
            title,
            &["Service", "Boot state", "Preset"],
            words(text, 3)
                .into_iter()
                .filter(|row| row[0].ends_with(".service"))
                .collect(),
        ),
        "Package inventory" => table("Packages", &["Package", "Version", "State"], tsv(text, 3)),
        "Runtime paths (current SSH user)" => table(
            "Detected software",
            &["Software", "Executable"],
            tsv(text, 2),
        ),
        "User runtime managers" => table(
            title,
            &["Path"],
            text.lines()
                .filter(|line| line.starts_with('/'))
                .map(|line| vec![line.into()])
                .collect(),
        ),
        "Processes" => table(
            title,
            &[
                "PID",
                "Parent PID",
                "User",
                "CPU %",
                "Memory %",
                "RSS KiB",
                "Elapsed",
                "Process",
            ],
            words(text, 8)
                .into_iter()
                .filter(|row| row[0].parse::<u64>().is_ok())
                .collect(),
        ),
        "Mount boundaries" => table(
            title,
            &["Mount", "Source", "Filesystem", "Options"],
            json_rows(
                text,
                &["target", "source", "fstype", "options"],
                Some("filesystems"),
            ),
        ),
        "Block devices" => table(
            title,
            &["Device", "Type", "Size bytes", "Filesystem", "Mounts"],
            json_rows(
                text,
                &["name", "type", "size", "fstype", "mountpoints"],
                Some("blockdevices"),
            ),
        ),
        "Interfaces" => {
            let rows = serde_json::from_str::<Value>(text)
                .ok()
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .map(|item| {
                    let addresses = item["addr_info"]
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .map(|ip| {
                                    format!("{}/{}", string(&ip["local"]), string(&ip["prefixlen"]))
                                })
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    vec![
                        string(&item["ifname"]),
                        string(&item["operstate"]),
                        addresses,
                    ]
                })
                .collect();
            table(title, &["Interface", "State", "Addresses"], rows)
        }
        "Routes" => table(
            title,
            &["Destination", "Gateway", "Interface", "Protocol"],
            json_rows(text, &["dst", "gateway", "dev", "protocol"], None),
        ),
        "Network counters" => table(
            title,
            &["Interface", "Received bytes", "Sent bytes"],
            text.lines()
                .filter_map(|line| {
                    let (name, counts) = line.split_once(':')?;
                    let values: Vec<_> = counts.split_whitespace().collect();
                    if values.len() < 16 {
                        return None;
                    }
                    Some(vec![name.trim().into(), values[0].into(), values[8].into()])
                })
                .collect(),
        ),
        "Active TCP/UDP listeners" | "Listening ports" | "Listening sockets" => {
            listeners(title, text)
        }
        "Proxy service ownership" => table(
            title,
            &["Service", "State", "Boot state", "Configuration"],
            text.split("\n\n")
                .filter_map(|block| {
                    let map = |key: &str| {
                        block
                            .lines()
                            .find_map(|line| line.strip_prefix(key))
                            .unwrap_or("Unavailable")
                            .to_string()
                    };
                    let id = map("Id=");
                    if id == "Unavailable" {
                        return None;
                    }
                    Some(vec![
                        id,
                        map("ActiveState="),
                        map("UnitFileState="),
                        map("FragmentPath="),
                    ])
                })
                .collect(),
        ),
        "Container and platform port ownership (including stopped)" => table(
            title,
            &["Container", "Image", "Ports", "Platform / project"],
            tsv(text, 4),
        ),
        "Available proxy configuration paths" => table(
            title,
            &["Path"],
            text.lines()
                .filter(|line| line.starts_with('/'))
                .map(|line| vec![line.into()])
                .collect(),
        ),
        "Existing SSH connection" => table(
            "Active SSH connection",
            &["Client", "Client port", "Server", "SSH port"],
            words(text, 4),
        ),
        "UFW state" => firewall("Firewall rules", text),
        "Directory sizes" => table(
            title,
            &["Size KiB", "Directory"],
            tsv(text, 2)
                .into_iter()
                .filter(|row| row[0].parse::<u64>().is_ok())
                .collect(),
        ),
        "Log entries" => table(
            title,
            &["Entry"],
            text.lines().map(|line| vec![line.into()]).collect(),
        ),
        "Journal usage" => {
            let mut value = table(title, &["Usage"], vec![]);
            if text.starts_with("Archived and active journals") {
                value.rows.push(vec![text.into()]);
                value.state = "ready".into();
            }
            value
        }
        _ => table(title, &[], vec![]),
    };
    if clean.contains('\0') || text.contains("[section failed:") {
        result.state = "unavailable".into();
    }
    result
}
fn parts(text: &str) -> Vec<(String, String)> {
    let mut result: Vec<(String, String)> = vec![];
    for line in text.lines() {
        if let Some(title) = line
            .strip_prefix("=== ")
            .and_then(|line| line.strip_suffix(" ==="))
        {
            if result.len() < 32 {
                result.push((title.into(), String::new()));
            }
        } else if let Some((_, content)) = result.last_mut() {
            content.push_str(line);
            content.push('\n');
        }
    }
    result
}
fn field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines().find_map(|line| line.strip_prefix(key))
}
pub(super) fn parse(text: &str, format: Format, code: Option<u32>) -> Report {
    let source = match format {
        Format::Directory => vec![("Directory sizes".into(), text.into())],
        Format::Logs => vec![("Log entries".into(), text.into())],
        Format::Firewall => vec![("UFW state".into(), text.into())],
        Format::Inspection(_) => parts(text),
    };
    let overview = if matches!(
        format,
        Format::Inspection(discovery::InspectionKind::Overview)
    ) {
        let get = |name: &str| {
            source
                .iter()
                .find(|(title, _)| title == name)
                .filter(|(_, content)| !content.contains("[section failed:"))
                .map(|(_, content)| content.as_str())
                .unwrap_or("")
        };
        let memory = get("Memory (KiB)");
        let cpu: Vec<u64> = get("CPU counters")
            .split_whitespace()
            .skip(1)
            .take(8)
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .unwrap_or_default();
        Some(Overview {
            os: field(get("Operating system"), "PRETTY_NAME=")
                .map(|s| s.trim_matches(['\'', '"']).into()),
            architecture: get("Architecture").lines().next().map(String::from),
            memory_total: field(memory, "MemTotal:")
                .and_then(|v| v.split_whitespace().next()?.parse::<u64>().ok())
                .and_then(|v| v.checked_mul(1024)),
            memory_available: field(memory, "MemAvailable:")
                .and_then(|v| v.split_whitespace().next()?.parse::<u64>().ok())
                .and_then(|v| v.checked_mul(1024)),
            cpu_total: if cpu.len() >= 4 {
                cpu.iter()
                    .try_fold(0u64, |sum, value| sum.checked_add(*value))
            } else {
                None
            },
            cpu_idle: if cpu.len() >= 4 {
                cpu[3].checked_add(*cpu.get(4).unwrap_or(&0))
            } else {
                None
            },
        })
    } else {
        None
    };
    let mut sections: Vec<_> = source.iter().filter(|(title, _)| !["Operating system", "Architecture", "Uptime and load", "CPU counters", "Memory (KiB)", "Identity"].contains(&title.as_str())).map(|(title, content)| {
        let mut value = section(title, content);
        if content.contains("[section failed:") || (!matches!(format, Format::Inspection(_)) && code != Some(0)) {
            value.state = if value.rows.is_empty() { "unavailable" } else { "partial" }.into();
            value.message = Some(if content.to_ascii_lowercase().contains("permission") || content.contains("must be root") || content.contains("denied") { "Permission required. Review a privileged inspection where available, or check this SSH user's access." } else { "This section could not be fully inspected. Open the command console for details." }.into());
        } else if value.rows.is_empty() && !content.trim().is_empty() && value.message.is_none() {
            let valid_empty = matches!(title.as_str(), "Compose projects" | "Mount boundaries" | "Block devices" | "Interfaces" | "Routes") && serde_json::from_str::<Value>(content).ok().is_some_and(|value| value.as_array().is_some_and(Vec::is_empty) || value.get("filesystems").and_then(Value::as_array).is_some_and(Vec::is_empty) || value.get("blockdevices").and_then(Value::as_array).is_some_and(Vec::is_empty));
            if !valid_empty { value.state = "unavailable".into(); value.message = Some("The result could not be interpreted. Open the command console for details.".into()); }
        }
        value
    }).collect();
    if sections.is_empty() && overview.is_none() {
        let mut value = table("Inspection", &[], vec![]);
        value.state = "unavailable".into();
        value.message =
            Some("No structured result was returned. Open the command console for details.".into());
        sections.push(value);
    }
    Report { sections, overview }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn inspect(text: &str) -> Report {
        parse(
            text,
            Format::Inspection(discovery::InspectionKind::Overview),
            Some(0),
        )
    }
    #[test]
    fn overview_uses_measured_values_and_ignores_malformed_or_overflowed_cpu() {
        let report = inspect("=== Operating system ===\nPRETTY_NAME=\"Debian 12\"\n=== Architecture ===\nx86_64\n=== Memory (KiB) ===\nMemTotal: 8192 kB\nMemAvailable: 4096 kB\n=== CPU counters ===\ncpu 10 0 20 60 10 0 0 0 9 9\n=== Filesystems ===\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000 400 600 40% /\n");
        let overview = report.overview.unwrap();
        assert_eq!(overview.os.as_deref(), Some("Debian 12"));
        assert_eq!(overview.memory_total, Some(8192 * 1024));
        assert_eq!(overview.cpu_total, Some(100));
        assert_eq!(overview.cpu_idle, Some(70));
        assert_eq!(report.sections[0].rows[0][5], "/");
        assert_eq!(
            inspect("=== CPU counters ===\ncpu 10 broken 20 40\n")
                .overview
                .unwrap()
                .cpu_total,
            None
        );
        assert_eq!(
            inspect("=== CPU counters ===\ncpu 18446744073709551615 1 2 3\n")
                .overview
                .unwrap()
                .cpu_total,
            None
        );
    }
    #[test]
    fn docker_preserves_stopped_containers_and_empty_port_fields() {
        let report = inspect("=== Containers, including stopped ===\nabc\tweb\tnginx:stable\tUp 2 hours\t0.0.0.0:8080->80/tcp\ndef\tworker\tapp:latest\tExited (0)\t\n=== Compose projects ===\n[]\n=== Volumes ===\ndata\tlocal\tlocal\n");
        assert_eq!(report.sections[0].rows.len(), 2);
        assert_eq!(report.sections[0].rows[1][4], "");
        assert_eq!(report.sections[1].state, "empty");
        assert_eq!(report.sections[2].rows[0][0], "data");
    }
    #[test]
    fn permission_failures_and_malformed_json_are_not_empty_successes() {
        let report = inspect("=== Containers, including stopped ===\npermission denied\n[section failed: exit 1]\n=== Compose projects ===\nnot json\n=== Routes ===\n[]\n=== Mount boundaries ===\n{\"filesystems\":[]}\n");
        assert_eq!(report.sections[0].state, "unavailable");
        assert!(report.sections[0]
            .message
            .as_ref()
            .unwrap()
            .contains("Permission"));
        assert_eq!(report.sections[1].state, "unavailable");
        assert_eq!(report.sections[2].state, "empty");
        assert_eq!(report.sections[3].state, "empty");
    }
    #[test]
    fn services_and_processes_have_explicit_columns_without_command_arguments() {
        let report = inspect("=== Service state ===\napp.service loaded active running Application worker\n=== Boot enablement ===\napp.service enabled enabled\n=== Processes ===\n123 1 app 2.5 1.0 2048 01:02 worker name\n");
        assert_eq!(report.sections[0].rows[0][4], "Application worker");
        assert_eq!(report.sections[1].rows[0][1], "enabled");
        assert_eq!(report.sections[2].rows[0][7], "worker name");
    }
    #[test]
    fn storage_flattens_nested_devices_and_keeps_json_strings_as_text() {
        let report = inspect("=== Block devices ===\n{\"blockdevices\":[{\"name\":\"vda\",\"type\":\"disk\",\"size\":2048,\"fstype\":null,\"mountpoints\":[null],\"children\":[{\"name\":\"vda1\",\"type\":\"part\",\"size\":1024,\"fstype\":\"ext4\",\"mountpoints\":[\"/\"]}]}]}\n=== Mount boundaries ===\n{\"filesystems\":[{\"target\":\"/srv/my files\",\"source\":\"/dev/vda1\",\"fstype\":\"ext4\",\"options\":\"rw\"}]}\n");
        assert_eq!(report.sections[0].rows.len(), 2);
        assert_eq!(report.sections[0].rows[1][2], "1024");
        assert_eq!(report.sections[1].rows[0][0], "/srv/my files");
    }
    #[test]
    fn firewall_directory_and_logs_preserve_readable_records_and_failure_state() {
        let report = parse(
            "Status: active\n[ 1] 22/tcp ALLOW IN Anywhere\n",
            Format::Firewall,
            Some(0),
        );
        assert_eq!(
            report.sections[0].rows[0],
            ["1", "22/tcp", "ALLOW IN", "Anywhere"]
        );
        assert_eq!(
            parse("Status: inactive\n", Format::Firewall, Some(0)).sections[0]
                .message
                .as_deref(),
            Some("UFW is inactive.")
        );
        assert_eq!(
            parse("128\t/srv/my directory\n", Format::Directory, Some(0)).sections[0].rows[0][1],
            "/srv/my directory"
        );
        let report = parse("message one\nmessage one\n", Format::Logs, Some(1));
        assert_eq!(report.sections[0].rows.len(), 2);
        assert_eq!(report.sections[0].state, "partial");
    }
    #[test]
    fn row_limits_and_network_json_contract_are_bounded() {
        let text = format!("=== Volumes ===\n{}", "data\tlocal\tlocal\n".repeat(2200));
        let report = inspect(&text);
        assert_eq!(report.sections[0].rows.len(), 2000);
        assert!(report.sections[0].truncated);
        let report = inspect("=== Interfaces ===\n[{\"ifname\":\"eth0\",\"operstate\":\"UP\",\"addr_info\":[{\"local\":\"192.0.2.1\",\"prefixlen\":24}]}]\n=== Network counters ===\neth0: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\n");
        assert_eq!(report.sections[0].rows[0][2], "192.0.2.1/24");
        assert_eq!(report.sections[1].rows[0], ["eth0", "10", "20"]);
    }
    #[test]
    fn streamed_report_precedes_completion_and_excludes_transport_controls() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let output = events.clone();
        let sink = wrap(
            Arc::new(move |event| {
                output.lock().unwrap().push(event);
                true
            }),
            Format::Directory,
        );
        sink(StreamEvent::Data {
            id: "stream".into(),
            sequence: 1,
            data: b"12\t/srv\n".to_vec(),
        });
        sink(StreamEvent::Closed {
            id: "stream".into(),
            code: Some(0),
            message: "Completed.".into(),
        });
        let events = events.lock().unwrap();
        assert!(
            matches!(&events[1], StreamEvent::Inspection { report, .. } if report.sections[0].rows[0][1] == "/srv")
        );
        assert!(matches!(
            &events[2],
            StreamEvent::Closed { code: Some(0), .. }
        ));
        let json = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(json["type"], "inspection");
        assert!(json.get("password").is_none());
    }
}
