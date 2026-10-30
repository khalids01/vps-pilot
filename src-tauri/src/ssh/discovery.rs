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
                ("Failed services", "systemctl --no-pager --plain --no-legend --type=service --failed"),
            ],
            Self::Software => &[
                ("Package inventory", r#"if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f='${binary:Package}\t${Version}\t${db:Status-Status}\n'; elif command -v rpm >/dev/null 2>&1; then rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\tinstalled\n'; else printf 'Package manager unsupported\n'; exit 1; fi"#),
                ("Runtime paths (current SSH user)", r#"for tool in docker nginx caddy traefik git node npm python3 go herdr; do path=$(command -v "$tool") && printf '%s\t%s\n' "$tool" "$path"; done; :"#),
                ("User runtime managers", r#"for file in "$HOME/.nvm/nvm.sh" "$HOME/.local/share/mise/bin/mise"; do if test -f "$file"; then printf '%s\n' "$file"; fi; done"#),
            ],
            Self::Docker => &[
                ("Containers, including stopped", r#"docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'"#),
                ("Compose projects", "docker compose ls --all --format json"),
                ("Images", r#"docker image ls --no-trunc --digests --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Digest}}\t{{.Size}}'"#),
                ("Volumes", r#"docker volume ls --format '{{.Name}}\t{{.Driver}}\t{{.Scope}}'"#),
                ("Docker disk usage", r#"docker system df --format '{{.Type}}\t{{.TotalCount}}\t{{.Active}}\t{{.Size}}\t{{.Reclaimable}}'"#),
            ],
            Self::Proxy => &[
                ("Active TCP/UDP listeners", "ss -H -lntup"),
                ("Proxy service ownership", "systemctl --no-pager show nginx.service caddy.service traefik.service -p Id -p LoadState -p ActiveState -p FragmentPath -p UnitFileState"),
                ("Container and platform port ownership (including stopped)", r#"docker ps -a --no-trunc --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}'"#),
                ("Available proxy configuration paths", r#"for dir in /etc/nginx /etc/caddy /etc/traefik; do if test -d "$dir"; then printf '%s\n' "$dir"; fi; done"#),
            ],
            Self::Services => &[
                ("Service state", "systemctl list-units --type=service --all --no-pager --plain --no-legend"),
                ("Boot enablement", "systemctl list-unit-files --type=service --no-pager --plain --no-legend"),
            ],
            Self::Storage => &[
                ("Filesystems", "df -Pk"),
                ("Mount boundaries", "findmnt --json --output TARGET,SOURCE,FSTYPE,OPTIONS"),
                ("Block devices", "lsblk --json --bytes -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS"),
                ("Journal usage", "journalctl --disk-usage"),
            ],
            Self::Firewall => &[
                ("UFW state", "ufw status numbered"),
                ("Listening ports", "ss -H -lntu"),
                ("Existing SSH connection", "printf '%s\\n' \"$SSH_CONNECTION\""),
            ],
            Self::Network => &[
                ("Interfaces", "ip -j address"),
                ("Routes", "ip -j route"),
                ("Network counters", "cat /proc/net/dev"),
                ("Listening sockets", "ss -H -lntup"),
            ],
            // Omit arguments and environment, which frequently contain credentials.
            Self::Processes => &[("Processes", "ps -eo pid=,ppid=,user=,pcpu=,pmem=,rss=,etime=,comm= --sort=-pcpu | head -n 60")],
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
            structured::wrap(
                Arc::new(move |event| output.send(event).is_ok()),
                structured::Format::Inspection(kind),
            ),
        )
        .await?;
    Ok(InspectionRun { id, command })
}

#[tauri::command]
pub fn ssh_inspection_describe(kind: InspectionKind) -> String {
    kind.command()
}
