use super::{Client, Profile};
use russh::{
    client,
    keys::{self, key::PrivateKeyWithHashAlg, HashAlg},
};
use std::{io::Read, path::PathBuf, sync::Arc};
use zeroize::Zeroizing;

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}
fn key_path(path: &str) -> Result<PathBuf, String> {
    if let Some(relative) = path.strip_prefix("~/") {
        return Ok(home_dir()
            .ok_or("Cannot locate your home directory.")?
            .join(relative));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Use an absolute private key path or a path starting with ~/.".into());
    }
    Ok(path)
}
fn read_secret(path: &std::path::Path) -> Result<Zeroizing<String>, &'static str> {
    if !std::fs::metadata(path)
        .map_err(|_| "Cannot inspect this private key file.")?
        .is_file()
    {
        return Err("Choose a regular private key file.");
    }
    let file = std::fs::File::open(path).map_err(|_| "Cannot read this private key file.")?;
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect this private key file.")?
        .is_file()
    {
        return Err("Choose a regular private key file.");
    }
    let mut secret = Zeroizing::new(String::new());
    file.take(1_000_001)
        .read_to_string(&mut secret)
        .map_err(|_| "Cannot read this private key file.")?;
    if secret.len() > 1_000_000 {
        return Err("Private key file exceeds the supported size limit.");
    }
    Ok(secret)
}
async fn key_auth(
    handle: &mut client::Handle<Client>,
    user: &str,
    path: PathBuf,
    passphrase: Option<&str>,
) -> Result<bool, String> {
    let passphrase = passphrase.map(|value| Zeroizing::new(value.to_owned()));
    let key = tokio::task::spawn_blocking(move || {
        let secret = read_secret(&path)?;
        keys::decode_secret_key(&secret, passphrase.as_ref().map(|value| value.as_str()))
            .map_err(|_| "Cannot unlock this private key. Check the file and key passphrase.")
    })
    .await
    .map_err(|_| "Could not load this private key.")?
    .map_err(str::to_owned)?;
    let hash = if key.algorithm().is_rsa() {
        handle
            .best_supported_rsa_hash()
            .await
            .map_err(|_| "Cannot negotiate the key signature.")?
            .flatten()
            .or(Some(HashAlg::Sha256))
    } else {
        None
    };
    handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map(|result| result.success())
        .map_err(|_| "Private key authentication failed.".into())
}
#[cfg(unix)]
pub(super) async fn agent_auth(
    handle: &mut client::Handle<Client>,
    user: &str,
    socket: &std::path::Path,
    expected: Option<&keys::PublicKey>,
) -> bool {
    use keys::agent::{client::AgentClient, AgentIdentity};
    let Ok(mut agent) = AgentClient::connect_uds(socket).await else {
        return false;
    };
    let Ok(identities) = agent.request_identities().await else {
        return false;
    };
    for identity in identities
        .into_iter()
        .filter_map(|identity| match identity {
            AgentIdentity::PublicKey { key, .. }
                if expected.is_none_or(|expected| expected == &key) =>
            {
                Some(key)
            }
            _ => None,
        })
        .take(3)
    {
        let hash = if identity.algorithm().is_rsa() {
            handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten()
                .or(Some(HashAlg::Sha256))
        } else {
            None
        };
        if handle
            .authenticate_publickey_with(user, identity, hash, &mut agent)
            .await
            .is_ok_and(|result| result.success())
        {
            return true;
        }
    }
    false
}

pub async fn authenticate(
    handle: &mut client::Handle<Client>,
    profile: &Profile,
    password: &str,
    passphrase: Option<&str>,
) -> Result<(), String> {
    if !password.is_empty() {
        if !profile.password_allowed {
            return Err(
                "This connection is configured for key authentication. Leave the password blank."
                    .into(),
            );
        }
        return handle
            .authenticate_password(&profile.username, password)
            .await
            .map_err(|_| "SSH password authentication failed.")?
            .success()
            .then_some(())
            .ok_or_else(|| "SSH password was not accepted.".into());
    }
    if handle
        .authenticate_none(&profile.username)
        .await
        .is_ok_and(|result| result.success())
    {
        return Ok(());
    }
    if let Some(path) = &profile.identity_file {
        let path = key_path(path)?;
        #[cfg(unix)]
        if let Some(socket) = std::env::var_os("SSH_AUTH_SOCK") {
            let public_path = path.clone();
            let public = tokio::task::spawn_blocking(move || {
                let secret = read_secret(&public_path).ok()?;
                keys::PrivateKey::from_openssh(&*secret)
                    .ok()
                    .map(|key| key.public_key().clone())
            })
            .await
            .ok()
            .flatten();
            if let Some(public) = public {
                if agent_auth(
                    handle,
                    &profile.username,
                    std::path::Path::new(&socket),
                    Some(&public),
                )
                .await
                {
                    return Ok(());
                }
            }
        }
        return key_auth(handle, &profile.username, path, passphrase)
            .await?
            .then_some(())
            .ok_or_else(|| "The server did not accept this private key.".into());
    }
    #[cfg(unix)]
    if let Some(socket) = std::env::var_os("SSH_AUTH_SOCK") {
        if agent_auth(
            handle,
            &profile.username,
            std::path::Path::new(&socket),
            None,
        )
        .await
        {
            return Ok(());
        }
    }
    if let Some(home) = home_dir() {
        for name in ["id_ed25519", "id_rsa"] {
            let path = home.join(".ssh").join(name);
            if path.is_file()
                && key_auth(handle, &profile.username, path, passphrase)
                    .await
                    .unwrap_or(false)
            {
                return Ok(());
            }
        }
    }
    Err("No SSH key was accepted. Select a private key, unlock it in your SSH agent, or enter a server password.".into())
}
