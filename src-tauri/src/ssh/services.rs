//! Narrow systemd controls with connection-bound, revalidated preconditions.
use super::*;
use russh::ChannelMsg;
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ServiceOperation {
    Start,
    Stop,
    Restart,
    Enable,
    Disable,
}
impl ServiceOperation {
    pub fn verb(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Enable => "enable",
            Self::Disable => "disable",
        }
    }
    pub fn verify(self, unit: &str) -> String {
        let (property, expected) = match self {
            Self::Start | Self::Restart => ("ActiveState", "active"),
            Self::Stop => ("ActiveState", "inactive"),
            Self::Enable => ("UnitFileState", "enabled"),
            Self::Disable => ("UnitFileState", "disabled"),
        };
        format!("state=$(/usr/bin/systemctl show --value -p {property} -- '{unit}') && printf '{property}=%s\\n' \"$state\" && test \"$state\" = '{expected}'")
    }
}
pub(super) fn protected(unit: &str) -> bool {
    let name = unit.to_ascii_lowercase();
    [
        "reboot",
        "halt",
        "poweroff",
        "shutdown",
        "rescue",
        "emergency",
        "rc-local",
        "udev",
        "connman",
        "wpa",
        "dhc",
        "openvpn",
        "wireguard",
        "wg-quick",
        "firewall",
        "fail2ban",
        "zfs",
        "mdadm",
        "ssh",
        "sshd",
        "network",
        "systemd-",
        "dbus",
        "ufw",
        "firewalld",
        "iptables",
        "nftables",
        "docker",
        "containerd",
        "podman",
        "nginx",
        "caddy",
        "traefik",
        "dokploy",
        "getty",
        "serial-getty",
        "user@",
        "polkit",
        "cron",
        "rsyslog",
        "snapd",
        "cloud-",
        "apparmor",
        "auditd",
        "lvm",
        "multipath",
        "iscsid",
        "mdmonitor",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}
pub(super) fn probe(unit: &str) -> String {
    format!(
        r#"export LC_ALL=C; printf '=== OS ===\n'; cat /etc/os-release || exit; printf '\n=== Architecture ===\n'; uname -m || exit; printf '\n=== Unit ===\n'; /usr/bin/systemctl show --no-pager -p Id -p LoadState -p ActiveState -p UnitFileState -p FragmentPath -p RefuseManualStart -p RefuseManualStop -p Type -p DropInPaths -p NeedDaemonReload -p RequiredBy -p BoundBy -p ConsistsOf -p Job -- '{unit}' || exit; printf '\n=== Dependents ===\n'; /usr/bin/systemctl list-dependencies --reverse --all --plain --no-pager -- '{unit}' || exit; printf '\n=== Unit file revision ===\n'; path=$(/usr/bin/systemctl show --value -p FragmentPath -- '{unit}') && test -n "$path" && stat -Lc '%d:%i:%Y:%Z:%s' -- "$path""#
    )
}
pub(super) async fn collect(
    runtime: &Runtime,
    profile_id: &str,
    command: &str,
) -> Result<String, String> {
    let handle = runtime
        .connections
        .get(profile_id)
        .filter(|h| !h.is_closed())
        .ok_or("Connect to this server first.")?;
    timeout(NETWORK_TIMEOUT, async {
        let mut channel = handle.channel_open_session().await.map_err(|_| "Could not open preflight inspection.")?;
        channel.exec(true, command).await.map_err(|_| "Could not start preflight inspection.")?;
        let result = async {
            let mut output = Vec::new();
            let mut code = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => { if output.len() + data.len() > 65536 { return Err("Preflight output exceeded its limit.".into()); } output.extend_from_slice(&data); },
                    // stderr is not evidence. Any diagnostic makes this fail closed.
                    ChannelMsg::ExtendedData { .. } | ChannelMsg::Failure => return Err("Preflight could not verify the service. Inspect its state and permissions first.".into()),
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {},
                }
            }
            if code != Some(0) { return Err("Preflight failed or did not return an exit status.".into()); }
            String::from_utf8(output).map_err(|_| "Preflight returned invalid text.".into())
        }.await;
        let _ = channel.close().await;
        result
    }).await.map_err(|_| "Service preflight timed out.".to_string())?
}
fn value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        line.strip_prefix(key)
            .and_then(|tail| tail.strip_prefix('='))
    })
}
pub(super) fn settled(text: &str) -> bool {
    matches!(value(text, "Job"), Some("") | Some("0"))
        && matches!(
            value(text, "ActiveState"),
            Some("active" | "inactive" | "failed")
        )
}
pub(super) fn validate(text: &str, unit: &str, operation: ServiceOperation) -> Result<(), String> {
    if protected(unit) {
        return Err("This service is protected because it can affect SSH, networking, storage, security, containers, or a deployment platform. Use its supported integration or the terminal.".into());
    }
    if !settled(text) {
        return Err(
            "The service has a pending job or transitional state. Inspect again after it settles."
                .into(),
        );
    }
    if value(text, "ID") != Some("debian")
        || value(text, "VERSION_ID").map(|s| s.trim_matches('"')) != Some("12")
        || !text.contains("=== Architecture ===\nx86_64\n")
    {
        return Err("Service changes currently support Debian 12 x86_64 only. Other systems retain read-only inspection and SSH terminals.".into());
    }
    if value(text, "Id") != Some(unit)
        || value(text, "LoadState") != Some("loaded")
        || value(text, "NeedDaemonReload") != Some("no")
    {
        return Err("The canonical unit must be loaded and its on-disk configuration must match systemd. Resolve aliases or pending configuration changes first.".into());
    }
    if !matches!(
        value(text, "Type"),
        Some("simple" | "exec" | "notify" | "forking" | "dbus" | "idle")
    ) || value(text, "DropInPaths") != Some("")
    {
        return Err(
            "This unit type or its drop-in configuration needs integration-specific validation."
                .into(),
        );
    }
    if !value(text, "FragmentPath").is_some_and(|path| {
        [
            "/etc/systemd/system/",
            "/usr/lib/systemd/system/",
            "/lib/systemd/system/",
        ]
        .iter()
        .any(|prefix| path.starts_with(prefix))
    }) {
        return Err("Service configuration ownership is unknown or transient.".into());
    }
    if matches!(
        operation,
        ServiceOperation::Start | ServiceOperation::Restart
    ) && value(text, "RefuseManualStart") != Some("no")
        || matches!(
            operation,
            ServiceOperation::Stop | ServiceOperation::Restart
        ) && value(text, "RefuseManualStop") != Some("no")
    {
        return Err("The service refuses manual lifecycle changes.".into());
    }
    if ["RequiredBy", "BoundBy", "ConsistsOf"]
        .iter()
        .any(|key| value(text, key) != Some(""))
    {
        return Err("Other units have hard lifecycle dependencies on this service. A coordinated integration is required before changing it.".into());
    }
    let dependents = text
        .split("=== Dependents ===\n")
        .nth(1)
        .and_then(|s| s.split("=== Unit file revision ===").next())
        .ok_or("Service dependency inspection is incomplete.")?;
    if dependents
        .split_whitespace()
        .filter(|word| word.ends_with(".service"))
        .any(|name| name != unit && protected(name))
    {
        return Err("A protected service depends on this unit. Changing it could interrupt the connection or existing deployments.".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protects_critical_services_and_dependency_aliases() {
        for unit in [
            "ssh.service",
            "sshd@a.service",
            "NetworkManager.service",
            "systemd-resolved.service",
            "docker.service",
            "dokploy.service",
            "nginx.service",
        ] {
            assert!(protected(unit));
        }
        let snapshot = "ID=debian\nVERSION_ID=\"12\"\n=== Architecture ===\nx86_64\nId=app.service\nLoadState=loaded\nNeedDaemonReload=no\nType=simple\nDropInPaths=\nJob=\nActiveState=active\nRequiredBy=\nBoundBy=\nConsistsOf=\nFragmentPath=/etc/systemd/system/app.service\nRefuseManualStart=no\nRefuseManualStop=no\n=== Dependents ===\napp.service\nssh.service\n=== Unit file revision ===\n1:2:3:4:5\n";
        assert!(validate(snapshot, "app.service", ServiceOperation::Stop).is_err());
        assert!(validate(
            &snapshot.replace("ssh.service\n", ""),
            "app.service",
            ServiceOperation::Stop
        )
        .is_ok());
        assert!(validate(
            &snapshot.replace("ID=debian", "ID=ubuntu"),
            "app.service",
            ServiceOperation::Stop
        )
        .is_err());
    }
}
