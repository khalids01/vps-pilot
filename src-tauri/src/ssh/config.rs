//! Read-only discovery. Never invokes OpenSSH, Match exec, or config commands.
use super::ProfileInput;
use serde::Serialize;
use ssh2_config::{ParseRule, SshConfig};
use std::{collections::HashSet, fs::File, io::Read, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub blocked_reason: Option<String>,
    pub identity_file: Option<String>,
    pub password_allowed: bool,
}

fn read_config(home: &Path) -> Result<SshConfig, String> {
    let file = match File::open(home.join(".ssh/config")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SshConfig::default())
        }
        Err(_) => {
            return Err(
                "Cannot read ~/.ssh/config. App-saved connections are still available.".into(),
            )
        }
    };
    let mut bytes = Vec::new();
    file.take(1_000_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read ~/.ssh/config.")?;
    if bytes.len() > 1_000_000 {
        return Err("SSH config exceeds the supported size limit.".into());
    }
    let config = SshConfig::default().home_dir(home)
        .parse(&mut std::io::Cursor::new(bytes), ParseRule::ALLOW_UNSUPPORTED_FIELDS)
        .map_err(|_| "Cannot safely parse SSH config. Check its syntax; Match conditions and unknown directives are not supported yet. No config commands were run.")?;
    // IgnoreUnknown must not turn an unsupported conditional into unconditional rules.
    if config.get_hosts().iter().any(|host| {
        host.params
            .ignored_fields
            .keys()
            .any(|key| key.eq_ignore_ascii_case("match"))
    }) {
        return Err(
            "SSH config Match conditions are not supported yet. No config commands were run."
                .into(),
        );
    }
    Ok(config)
}
pub fn read_hosts(home: &Path, default_user: &str) -> Result<Vec<ConfigHost>, String> {
    let config = read_config(home)?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for clause in config.get_hosts().iter().flat_map(|host| &host.pattern) {
        let alias = &clause.pattern;
        if clause.negated || alias.contains(['*', '?']) || !seen.insert(alias.to_ascii_lowercase())
        {
            continue;
        }
        // A literal alias inside an excluded Include scope is not a connection.
        if !config.intersecting_hosts(alias).any(|host| {
            host.pattern
                .iter()
                .any(|pattern| !pattern.negated && pattern.pattern == *alias)
        }) {
            continue;
        }
        if result.len() >= 100 {
            return Err("SSH config has more than 100 named connections.".into());
        }
        let mut entry = resolve(&config, alias, default_user);
        if entry.blocked_reason.is_none() {
            entry.blocked_reason = ProfileInput {
                id: None,
                name: entry.alias.clone(),
                host: entry.host.clone(),
                username: entry.username.clone(),
                port: entry.port,
                identity_file: entry.identity_file.clone(),
                password_allowed: entry.password_allowed,
            }
            .validate()
            .err();
        }
        result.push(entry);
    }
    Ok(result)
}
pub fn resolve_host(home: &Path, alias: &str, default_user: &str) -> Result<ConfigHost, String> {
    Ok(resolve(&read_config(home)?, alias, default_user))
}
fn resolve(config: &SshConfig, alias: &str, default_user: &str) -> ConfigHost {
    let params = config.query(alias);
    let host = params.host_name.clone().unwrap_or_else(|| alias.to_owned());
    let username = params
        .user
        .clone()
        .unwrap_or_else(|| default_user.to_owned());
    let port = params.port.unwrap_or(22);
    let has_option = |name: &str| {
        params
            .unsupported_fields
            .iter()
            .chain(params.ignored_fields.iter())
            .any(|(key, values)| {
                key.eq_ignore_ascii_case(name)
                    && values
                        .first()
                        .is_some_and(|value| !value.eq_ignore_ascii_case("none"))
            })
    };
    let password_disabled = params.unsupported_fields.iter().any(|(key, values)| {
        key.eq_ignore_ascii_case("passwordauthentication")
            && values
                .first()
                .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "no" | "false"))
    });
    let password_disabled = password_disabled
        || params.unsupported_fields.iter().any(|(key, values)| {
            key.eq_ignore_ascii_case("preferredauthentications")
                && !values
                    .iter()
                    .flat_map(|value| value.split(','))
                    .any(|method| method.eq_ignore_ascii_case("password"))
        });
    let blocked_reason = if params
        .proxy_jump
        .as_ref()
        .is_some_and(|jumps| jumps.iter().any(|jump| !jump.eq_ignore_ascii_case("none")))
        || has_option("proxycommand")
    {
        Some("Requires a proxy or jump host, which is not supported yet.".into())
    } else if params.bind_address.is_some() || params.bind_interface.is_some() {
        Some("Requires a specific local interface; support is coming later.".into())
    } else {
        None
    };
    ConfigHost {
        alias: alias.to_owned(),
        host,
        port,
        username,
        blocked_reason,
        identity_file: params
            .identity_file
            .as_ref()
            .and_then(|files| files.first())
            .map(|path| path.to_string_lossy().into_owned()),
        password_allowed: !password_disabled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(text: &str) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".ssh")).unwrap();
        std::fs::write(home.path().join(".ssh/config"), text).unwrap();
        home
    }
    #[test]
    fn named_aliases_inherit_defaults_and_never_read_identity_files() {
        let home = fixture("Host prod duplicate\n HostName example.com\n User deploy\n Port 2222\n IdentityFile ~/.ssh/nonexistent-identity\nHost prod\n User ignored\nHost * !excluded\n User fallback\nHost dev\n HostName dev.example.com\n");
        let entries = read_hosts(home.path(), "local-user").unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].alias, "prod");
        assert_eq!(entries[0].host, "example.com");
        assert_eq!(entries[0].port, 2222);
        assert_eq!(entries[0].username, "deploy");
        assert!(entries[0].blocked_reason.is_none());
        assert!(!home.path().join(".ssh/nonexistent-identity").exists());
        assert!(entries[0]
            .identity_file
            .as_deref()
            .is_some_and(|path| path.ends_with("nonexistent-identity")));
        assert_eq!(entries[2].username, "fallback");
    }
    #[test]
    fn includes_are_resolved_and_config_is_unchanged() {
        let home = fixture("Include config.d/*\nHost *\n User deploy\n");
        std::fs::create_dir(home.path().join(".ssh/config.d")).unwrap();
        let path = home.path().join(".ssh/config.d/servers");
        let content = "Host included\n HostName included.example.com\n";
        std::fs::write(&path, content).unwrap();
        let entries = read_hosts(home.path(), "local-user").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "included.example.com");
        assert_eq!(entries[0].username, "deploy");
        assert_eq!(std::fs::read_to_string(path).unwrap(), content);
    }
    #[test]
    fn excluded_include_aliases_are_not_offered_as_direct_connections() {
        let home = fixture("Host parent\n Include child\n");
        std::fs::write(
            home.path().join(".ssh/child"),
            "Host hidden\n HostName hidden.example.com\n",
        )
        .unwrap();
        let entries = read_hosts(home.path(), "local-user").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].alias, "parent");
    }
    #[test]
    fn proxies_are_blocked_and_key_only_hosts_remain_available() {
        let home = fixture("Host jump\n ProxyJump gateway\nHost proxy\n ProxyCommand touch /must-not-run\nHost keyonly\n PasswordAuthentication no\nHost preferred-key\n PreferredAuthentications publickey\n");
        let entries = read_hosts(home.path(), "local-user").unwrap();
        assert_eq!(entries.len(), 4);
        assert!(entries[..2]
            .iter()
            .all(|entry| entry.blocked_reason.is_some()));
        assert!(entries[2..]
            .iter()
            .all(|entry| entry.blocked_reason.is_none() && !entry.password_allowed));
    }
    #[test]
    fn missing_config_is_empty_and_match_cycles_or_invalid_files_fail_closed() {
        let home = tempfile::tempdir().unwrap();
        assert!(read_hosts(home.path(), "user").unwrap().is_empty());
        for text in [
            "Host good\nMatch exec touch /must-not-run\n User wrong\n",
            "IgnoreUnknown Match\nHost good\nMatch exec touch /must-not-run\n User wrong\n",
            "Include config\n",
            "Host broken\n Port not-a-port\n",
        ] {
            let home = fixture(text);
            assert!(read_hosts(home.path(), "user").is_err());
        }
    }
}
