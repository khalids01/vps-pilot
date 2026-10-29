use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostKey {
    pub algorithm: String,
    pub fingerprint: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub revision: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default = "password_allowed_default")]
    pub password_allowed: bool,
}
fn password_allowed_default() -> bool {
    true
}
impl Profile {
    pub fn endpoint(&self) -> String {
        format!("[{}]:{}", self.host, self.port)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default = "password_allowed_default")]
    pub password_allowed: bool,
}
impl ProfileInput {
    pub fn validate(self) -> Result<Profile, String> {
        let name = self.name.trim().to_owned();
        let host = self.host.trim().trim_end_matches('.').to_ascii_lowercase();
        let username = self.username.trim().to_owned();
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err("Use a server name between 1 and 80 characters.".into());
        }
        let valid_host = host.parse::<std::net::IpAddr>().is_ok()
            || (!host.is_empty()
                && host.len() <= 253
                && host.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                }));
        if !valid_host {
            return Err(
                "Enter a hostname or IP address without a URL, username, path, or port.".into(),
            );
        }
        if self.port == 0 {
            return Err("SSH port must be between 1 and 65535.".into());
        }
        if username.is_empty()
            || username.len() > 64
            || !username
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err(
                "Use a Linux username with letters, numbers, dots, underscores, or hyphens.".into(),
            );
        }
        let identity_file = self.identity_file.filter(|path| !path.trim().is_empty());
        if identity_file
            .as_ref()
            .is_some_and(|path| path.len() > 4096 || path.chars().any(char::is_control))
        {
            return Err("Choose a valid private key path.".into());
        }
        if identity_file.as_ref().is_some_and(|path| {
            !std::path::Path::new(path).is_absolute() && !path.starts_with("~/")
        }) {
            return Err("Use an absolute private key path or a path starting with ~/.".into());
        }
        let id = match self.id {
            Some(id) if Uuid::parse_str(&id).is_ok() => id,
            Some(_) => return Err("Invalid server profile ID.".into()),
            None => Uuid::new_v4().to_string(),
        };
        Ok(Profile {
            id,
            revision: Uuid::new_v4().to_string(),
            name,
            host,
            port: self.port,
            username,
            identity_file,
            password_allowed: self.password_allowed,
        })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Database {
    pub version: u8,
    pub profiles: Vec<Profile>,
    pub trusted_hosts: HashMap<String, HostKey>,
}
impl Default for Database {
    fn default() -> Self {
        Self {
            version: 1,
            profiles: vec![],
            trusted_hosts: HashMap::new(),
        }
    }
}
pub struct Store {
    path: PathBuf,
    snapshot: Option<Vec<u8>>,
    pub data: Result<Database, String>,
}
impl Store {
    pub fn open(path: PathBuf) -> Self {
        let mut snapshot = None;
        let data = (|| {
            let Some(bytes) = read_store_bytes(&path)? else {
                return Ok(Database::default());
            };
            snapshot = Some(bytes.clone());
            let database: Database = serde_json::from_slice(&bytes)
                .map_err(|_| "Server profile storage is invalid; it has not been overwritten.")?;
            if database.version != 1 || database.profiles.len() > 100 {
                return Err(
                    "Unsupported server profile storage; it has not been overwritten.".into(),
                );
            }
            let mut ids = std::collections::HashSet::new();
            for profile in &database.profiles {
                if !ids.insert(&profile.id)
                    || Uuid::parse_str(&profile.revision).is_err()
                    || (ProfileInput {
                        id: Some(profile.id.clone()),
                        name: profile.name.clone(),
                        host: profile.host.clone(),
                        port: profile.port,
                        username: profile.username.clone(),
                        identity_file: profile.identity_file.clone(),
                        password_allowed: profile.password_allowed,
                    })
                    .validate()
                    .is_err()
                {
                    return Err(
                        "Invalid saved server profile; storage has not been overwritten.".into(),
                    );
                }
            }
            if database.trusted_hosts.values().any(|key| {
                !key.fingerprint.starts_with("SHA256:")
                    || key.fingerprint.len() > 100
                    || key.algorithm.len() > 100
            }) {
                return Err(
                    "Invalid saved host identity; storage has not been overwritten.".into(),
                );
            }
            Ok(database)
        })();
        Self {
            path,
            snapshot,
            data,
        }
    }
    pub fn database(&self) -> Result<&Database, String> {
        self.check_snapshot()?;
        self.data.as_ref().map_err(Clone::clone)
    }
    fn check_snapshot(&self) -> Result<(), String> {
        let current = read_store_bytes(&self.path)?;
        if current != self.snapshot {
            return Err(
                "Server profiles changed outside this app instance. Restart before making changes."
                    .into(),
            );
        }
        Ok(())
    }
    pub fn commit(&mut self, next: Database) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or("Cannot locate app-owned server storage.")?;
        fs::create_dir_all(parent).map_err(|_| "Cannot create app-owned server storage.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect server storage permissions.")?;
        }
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(parent.join(".ssh-profiles.lock"))
            .map_err(|_| "Cannot lock server profile storage.")?;
        lock.try_lock()
            .map_err(|_| "Cannot lock server profile storage.")?;
        self.check_snapshot()?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Cannot write server profile storage.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| "Cannot protect server profile permissions.")?;
        }
        let bytes = serde_json::to_vec_pretty(&next)
            .map_err(|_| "Cannot encode server profile storage.")?;
        if bytes.len() > 1_000_000 {
            return Err("Server storage capacity exceeded; existing data was preserved.".into());
        }
        file.write_all(&bytes)
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| "Cannot write server profile storage.")?;
        file.persist(&self.path)
            .map_err(|_| "Cannot replace server profile storage.")?;
        self.data = Ok(next);
        self.snapshot = Some(bytes);
        Ok(())
    }
}

fn read_store_bytes(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read server profile storage.".into()),
    };
    let mut bytes = Vec::new();
    file.take(1_000_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read server profile storage.")?;
    if bytes.len() > 1_000_000 {
        return Err(
            "Server profile storage exceeds its size limit; it has not been overwritten.".into(),
        );
    }
    Ok(Some(bytes))
}
