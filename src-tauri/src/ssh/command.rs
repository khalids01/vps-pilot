use super::{config, ProfileInput};
use std::path::Path;

/// Import connection arguments only. Never evaluates a shell or runs the command.
pub fn parse(command: &str, home: &Path, default_user: &str) -> Result<ProfileInput, String> {
    let command = command.trim();
    if command.len() > 8192
        || command
            .chars()
            .any(|c| c.is_control() || "$`;|&<>".contains(c))
    {
        return Err(
            "Paste a single ssh connection command without shell operators or variables.".into(),
        );
    }
    let words = shlex::split(command).ok_or("Check the quotes in your SSH command.")?;
    if words.first().map(String::as_str) != Some("ssh") {
        return Err("Start with ssh, for example: ssh deploy@example.com -p 2222".into());
    }
    let mut user = None;
    let mut port = None;
    let mut identity = None;
    let mut target = None;
    let mut identities_only = false;
    let mut options = true;
    let mut index = 1;
    while index < words.len() {
        let word = &words[index];
        if options && word == "--" {
            options = false;
            index += 1;
            continue;
        }
        if options && word.starts_with('-') {
            let flag = word.get(..2).ok_or("Unsupported SSH option.")?;
            if !matches!(flag, "-p" | "-l" | "-i" | "-o") {
                return Err("Supported options: -p (port), -l (user), -i (private key), and -o IdentitiesOnly=yes. Remote commands, proxies, and tunnels are not supported here.".into());
            }
            let value = if word.len() > 2 {
                word[2..].to_owned()
            } else {
                index += 1;
                words
                    .get(index)
                    .cloned()
                    .ok_or("An SSH option is missing its value.")?
            };
            match flag {
                "-o" => {
                    let option = value.trim();
                    let (name, setting) = option
                        .split_once('=')
                        .or_else(|| option.split_once(char::is_whitespace))
                        .ok_or("Use -o IdentitiesOnly=yes. Other SSH options are not supported.")?;
                    if !name.trim().eq_ignore_ascii_case("IdentitiesOnly")
                        || !setting.trim().eq_ignore_ascii_case("yes")
                    {
                        return Err("Only -o IdentitiesOnly=yes is supported. Other SSH options were not imported.".into());
                    }
                    if identities_only {
                        return Err("Specify IdentitiesOnly once.".into());
                    }
                    identities_only = true;
                }

                "-p" => {
                    if port.is_some() {
                        return Err("Specify the port once.".into());
                    }
                    port = Some(
                        value
                            .parse::<u16>()
                            .map_err(|_| "Use an SSH port between 1 and 65535.")?,
                    );
                }
                "-l" => {
                    if user.is_some() {
                        return Err("Specify the user once.".into());
                    }
                    user = Some(value);
                }
                "-i" => {
                    if identity.is_some() {
                        return Err("Use one private key file per connection.".into());
                    }
                    identity = Some(value);
                }
                _ => unreachable!(),
            }
        } else if target.replace(word.clone()).is_some() {
            return Err(
                "Paste a connection command only; remove the remote command or extra destination."
                    .into(),
            );
        }
        index += 1;
    }
    let target = target.ok_or("Add a hostname, IP address, or SSH config alias.")?;
    let (host, target_user, uri_port) = if target.starts_with("ssh://") {
        let uri = url::Url::parse(&target).map_err(|_| "Invalid SSH address.")?;
        if uri.password().is_some()
            || uri.query().is_some()
            || uri.fragment().is_some()
            || !matches!(uri.path(), "" | "/")
        {
            return Err(
                "SSH addresses must not contain passwords, paths, or query parameters.".into(),
            );
        }
        let host = uri
            .host_str()
            .ok_or("Missing SSH hostname.")?
            .trim_matches(['[', ']'])
            .to_owned();
        (
            host,
            (!uri.username().is_empty()).then(|| uri.username().to_owned()),
            uri.port(),
        )
    } else {
        match target.rsplit_once('@') {
            Some((user, host)) => (
                host.trim_matches(['[', ']']).to_owned(),
                Some(user.to_owned()),
                None,
            ),
            None => (target.trim_matches(['[', ']']).to_owned(), None, None),
        }
    };
    let resolved = config::resolve_host(home, &host, default_user)?;
    if let Some(reason) = resolved.blocked_reason {
        return Err(reason);
    }
    let identity = identity.or(resolved.identity_file);
    if identities_only && identity.as_ref().is_none_or(|path| path.trim().is_empty()) {
        return Err("IdentitiesOnly=yes requires a private key: add -i ~/.ssh/your-key.".into());
    }
    let input = ProfileInput {
        id: None,
        name: host,
        host: resolved.host,
        port: port.or(uri_port).unwrap_or(resolved.port),
        username: user.or(target_user).unwrap_or(resolved.username),
        identity_file: identity,
        password_allowed: resolved.password_allowed,
    };
    let validated = input.validate()?;
    Ok(ProfileInput {
        id: None,
        name: validated.name,
        host: validated.host,
        port: validated.port,
        username: validated.username,
        identity_file: validated.identity_file,
        password_allowed: validated.password_allowed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_connection_arguments_and_quoted_identity_paths() {
        let home = tempfile::tempdir().unwrap();
        let key_path = home.path().join("keys/my key");
        let key_path = key_path.to_string_lossy().replace('\\', "/");
        let result = parse(
            &format!("ssh -i '{key_path}' deploy@example.com -p2222"),
            home.path(),
            "local",
        )
        .unwrap();
        assert_eq!(result.host, "example.com");
        assert_eq!(result.username, "deploy");
        assert_eq!(result.port, 2222);
        assert_eq!(result.identity_file.as_deref(), Some(key_path.as_str()));
        let ipv6 = parse("ssh ssh://root@[::1]:2200", home.path(), "local").unwrap();
        assert_eq!(ipv6.host, "::1");
        assert_eq!(ipv6.port, 2200);
        assert_eq!(
            parse("ssh root@example.com", home.path(), "")
                .unwrap()
                .username,
            "root"
        );
    }
    #[test]
    fn imports_identities_only_with_the_selected_key() {
        let home = tempfile::tempdir().unwrap();
        for option in [
            "-o IdentitiesOnly=yes",
            "-oIdentitiesOnly=yes",
            "-o 'IdentitiesOnly yes'",
            "-o identitiesonly=YES",
        ] {
            let parsed = parse(
                &format!("ssh -i ~/.ssh/dev-vps {option} dev@209.38.29.117"),
                home.path(),
                "local",
            )
            .unwrap();
            assert_eq!(parsed.host, "209.38.29.117");
            assert_eq!(parsed.username, "dev");
            assert_eq!(parsed.port, 22);
            assert_eq!(parsed.identity_file.as_deref(), Some("~/.ssh/dev-vps"));
        }
        for command in [
            "ssh -o IdentitiesOnly=yes dev@example.com",
            "ssh -i ~/.ssh/key -o IdentitiesOnly=no dev@example.com",
            "ssh -i ~/.ssh/key -o IdentitiesOnly=yes -o IdentitiesOnly=yes dev@example.com",
            "ssh -i ~/.ssh/key -o StrictHostKeyChecking=no dev@example.com",
        ] {
            assert!(parse(command, home.path(), "local").is_err());
        }
    }
    #[test]
    fn resolves_aliases_without_mutating_config_or_running_commands() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".ssh")).unwrap();
        let path = home.path().join(".ssh/config");
        let text = "Host prod\n HostName example.com\n User deploy\n Port 2222\n IdentityFile ~/.ssh/prod\n PasswordAuthentication no\n";
        std::fs::write(&path, text).unwrap();
        let result = parse("ssh prod", home.path(), "local").unwrap();
        assert_eq!(result.name, "prod");
        assert_eq!(result.host, "example.com");
        assert_eq!(result.username, "deploy");
        assert_eq!(result.port, 2222);
        assert!(!result.password_allowed);
        assert!(result.identity_file.unwrap().ends_with(".ssh/prod"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
    }
    #[test]
    fn rejects_execution_forwarding_secrets_and_malformed_options() {
        let home = tempfile::tempdir().unwrap();
        for command in [
            "ssh host reboot",
            "ssh host; reboot",
            "ssh $(whoami)@host",
            "ssh host | tee log",
            "ssh host\nreboot",
            "ssh -J gateway host",
            "ssh -L 80:host:80 host",
            "ssh -oProxyCommand=anything host",
            "ssh -p",
            "ssh -p 0 host",
            "ssh -p 99999 host",
            "ssh -i 'unclosed host",
            "ssh -i relative.pem root@host",
            "ssh ssh://root:secret@host",
            "sshpass -p secret ssh host",
        ] {
            assert!(
                parse(command, home.path(), "local").is_err(),
                "unsafe or malformed command was accepted"
            );
        }
    }
}
