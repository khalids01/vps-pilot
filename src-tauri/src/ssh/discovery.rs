//! Fixed, unprivileged inspections. No caller-provided shell fragments.
use super::*;
use serde::Deserialize;
use streams::StreamEvent;
use tauri::ipc::Channel;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InspectionKind {
    Overview,
    Software,
    Docker,
    Proxy,
    Services,
    Storage,
    Firewall,
    Network,
    Processes,
}
impl InspectionKind {
    pub fn command(self) -> String {
        let sections: &[(&str, &str)] = match self {
            Self::Overview => &[
                ("Operating system", "cat /etc/os-release"),
                ("Architecture", "uname -m"),
                ("Uptime and load", "cat /proc/uptime /proc/loadavg"),
                ("CPU counters", "head -n 1 /proc/stat"),
                ("Memory (KiB)", "head -n 5 /proc/meminfo"),
                ("Filesystems", "df -Pk"),
                ("Identity", "id"),
                ("Failed services", "systemctl --no-pager --plain --failed"),
            ],
            Self::Software => &[
                ("Package inventory", r#"if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f='${binary:Package}\t${Version}\t${db:Status-Status}\n'; elif command -v rpm >/dev/null 2>&1; then rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\n'; else printf 'Package manager unsupported\n'; exit 1; fi"#),
                ("Runtime paths (current SSH user)", r#"id; for tool in docker nginx caddy traefik git node npm python3 go; do command -v "$tool" || :; done"#),
                ("User runtime managers", r#"for file in "$HOME/.nvm/nvm.sh" "$HOME/.local/share/mise/bin/mise"; do if test -f "$file"; then printf '%s\n' "$file"; fi; done"#),
            ],
            Self::Docker => &[
                ("Containers, including stopped", r#"docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'"#),
                ("Compose projects", "docker compose ls --all"),
                ("Images", "docker image ls --digests"),
                ("Volumes", "docker volume ls"),
                ("Docker disk usage", "docker system df"),
            ],
            Self::Proxy => &[
                ("Active TCP/UDP listeners", "ss -lntup"),
                ("Proxy service ownership", "systemctl --no-pager show nginx.service caddy.service traefik.service -p Id -p LoadState -p ActiveState -p FragmentPath -p UnitFileState"),
                ("Container and platform port ownership (including stopped)", r#"docker ps -a --no-trunc --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}'"#),
                ("Available proxy configuration paths", r#"for dir in /etc/nginx /etc/caddy /etc/traefik; do if test -d "$dir"; then ls -ld "$dir"; fi; done"#),
            ],
            Self::Services => &[
                ("Service state", "systemctl list-units --type=service --all --no-pager --plain"),
                ("Boot enablement", "systemctl list-unit-files --type=service --no-pager --plain"),
            ],
            Self::Storage => &[
                ("Filesystems", "df -Pk"),
                ("Mount boundaries", "findmnt --list --output TARGET,SOURCE,FSTYPE,OPTIONS"),
                ("Block devices", "lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS"),
                ("Journal usage", "journalctl --disk-usage"),
            ],
            Self::Firewall => &[
                ("UFW state", "ufw status numbered"),
                ("Listening ports", "ss -lntu"),
                ("Existing SSH connection", "printf '%s\\n' \"$SSH_CONNECTION\""),
            ],
            Self::Network => &[
                ("Interfaces", "ip -brief address"),
                ("Routes", "ip route"),
                ("Network counters", "cat /proc/net/dev"),
                ("Listening sockets", "ss -lntup"),
            ],
            // Omit arguments and environment, which frequently contain credentials.
            Self::Processes => &[("Processes", "ps -eo pid,ppid,user,comm,pcpu,pmem,rss,etime --sort=-pcpu | head -n 61")],
        };
        inspection_command(sections)
    }
}
pub(super) fn inspection_command(sections: &[(&str, &str)]) -> String {
    let mut command = "export LC_ALL=C; failed=0; ".to_string();
    for (name, operation) in sections {
        // Both strings are compile-time constants, never user input.
        command.push_str(&format!("printf '\\n=== {name} ===\\n'; ( {operation} ); result=$?; if [ \"$result\" -ne 0 ]; then printf '[section failed: exit %s]\\n' \"$result\"; failed=1; fi; "));
    }
    command.push_str("exit \"$failed\"");
    command
}
#[derive(Serialize)]
pub struct InspectionRun {
    id: String,
    command: String,
}
#[tauri::command]
pub async fn ssh_inspection_run(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    kind: InspectionKind,
    output: Channel<StreamEvent>,
) -> Result<InspectionRun, String> {
    let command = kind.command();
    let id = service
        .start_stream(
            &profile_id,
            None,
            Some(&command),
            Arc::new(move |event| output.send(event).is_ok()),
        )
        .await?;
    Ok(InspectionRun { id, command })
}
