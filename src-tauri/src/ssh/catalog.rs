use super::*;
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Software {
    Docker,
    Nginx,
    Caddy,
    Traefik,
    Dokploy,
    Git,
    Node,
    Nvm,
    Python,
    Go,
    Herdr,
}
impl Software {
    pub fn binary(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Nginx => "nginx",
            Self::Caddy => "caddy",
            Self::Traefik => "traefik",
            Self::Dokploy => "dokploy",
            Self::Git => "git",
            Self::Node => "node",
            Self::Nvm => "nvm",
            Self::Python => "python3",
            Self::Go => "go",
            Self::Herdr => "herdr",
        }
    }
    pub fn preflight(self) -> String {
        let binary = self.binary();
        let mut command = discovery::inspection_command(&[
            ("Operating system", "cat /etc/os-release"),
            ("Architecture", "uname -m"),
            ("Identity", "id"),
            ("Listeners", "ss -lntup"),
            ("Service reservations", "systemctl --no-pager show nginx.service caddy.service traefik.service docker.service -p Id -p LoadState -p ActiveState -p FragmentPath -p UnitFileState"),
            ("Container reservations and platform ownership", r#"ids=$(docker ps -aq) || exit; if test -z "$ids"; then printf 'No containers\n'; fi; for id in $ids; do docker inspect --format '{{.Name}}\t{{.Config.Image}}\t{{json .HostConfig.PortBindings}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.swarm.service.name"}}' "$id" || exit; done"#),
            ("Proxy configuration reservations", r#"for dir in /etc/nginx /etc/caddy /etc/traefik; do if test -d "$dir"; then find "$dir" -maxdepth 2 -type f -print || exit; fi; done"#),
        ]);
        // inspection_command ends with a final exit. Add selected-software sections
        // before it so missing programs remain an explicit failed section.
        command.truncate(command.len() - "exit \"$failed\"".len());
        command.push_str(&format!(r#"printf '\n=== Selected executable ===\n'; path=$(command -v {binary}); if test -n "$path"; then printf '%s\n' "$path"; else printf 'Not found on SSH user PATH\n'; fi; printf '\n=== Package ownership ===\n'; if test -n "$path"; then if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -S -- "$path" || failed=1; elif command -v rpm >/dev/null 2>&1; then rpm -qf -- "$path" || failed=1; else printf 'Package ownership unavailable\n'; failed=1; fi; else printf 'No executable ownership established\n'; fi; "#));
        if matches!(self, Self::Nvm) {
            command.push_str(r#"printf '\n=== User nvm installation ===\n'; if test -f "$HOME/.nvm/nvm.sh"; then ls -l "$HOME/.nvm/nvm.sh"; else printf 'Not found at default user path\n'; fi; "#);
        }
        command.push_str("exit \"$failed\"");
        command
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_inspection_and_catalog_scripts_parse_without_executing() {
        let inspections = [
            discovery::InspectionKind::Overview,
            discovery::InspectionKind::Software,
            discovery::InspectionKind::Docker,
            discovery::InspectionKind::Proxy,
            discovery::InspectionKind::Services,
            discovery::InspectionKind::Storage,
            discovery::InspectionKind::Firewall,
            discovery::InspectionKind::Network,
            discovery::InspectionKind::Processes,
        ];
        let catalog = [
            Software::Docker,
            Software::Nginx,
            Software::Caddy,
            Software::Traefik,
            Software::Dokploy,
            Software::Git,
            Software::Node,
            Software::Nvm,
            Software::Python,
            Software::Go,
            Software::Herdr,
        ];
        for command in inspections
            .iter()
            .map(|kind| kind.command())
            .chain(catalog.iter().map(|software| software.preflight()))
        {
            assert!(std::process::Command::new("sh")
                .args(["-n", "-c", &command])
                .status()
                .unwrap()
                .success());
        }
    }
}
