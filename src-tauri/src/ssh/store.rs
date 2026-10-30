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
    sql: Option<std::sync::Arc<crate::database::LocalDatabase>>,
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
            decode(&bytes)
        })();
        Self {
            sql: None,
            path,
            snapshot,
            data,
        }
    }
    pub fn open_sql(db: std::sync::Arc<crate::database::LocalDatabase>, legacy: PathBuf) -> Self {
        let data = (|| {
            let bytes = match db.read("ssh_profiles")? {
                Some(value) => value,
                None => {
                    let previous = Self::open(legacy.clone());
                    let value = serde_json::to_string(previous.database()?)
                        .map_err(|_| "Cannot migrate saved profiles.")?;
                    db.import("ssh_profiles", &value)?
                }
            };
            let data = decode(bytes.as_bytes())?;
            Ok::<_, String>((data, bytes.into_bytes()))
        })();
        let (data, snapshot) = match data {
            Ok((data, bytes)) => (Ok(data), Some(bytes)),
            Err(error) => (Err(error), None),
        };
        Self {
            sql: Some(db),
            path: legacy,
            data,
            snapshot,
        }
    }
    pub fn database(&self) -> Result<&Database, String> {
        self.check_snapshot()?;
        self.data.as_ref().map_err(Clone::clone)
    }
    fn check_snapshot(&self) -> Result<(), String> {
        let current = if let Some(db) = &self.sql {
            db.read("ssh_profiles")?.map(String::into_bytes)
        } else {
            read_store_bytes(&self.path)?
        };
        if current != self.snapshot {
            return Err(
                "Server profiles changed outside this app instance. Restart before making changes."
                    .into(),
            );
        }
        Ok(())
    }
    pub fn commit(&mut self, next: Database) -> Result<(), String> {
        if let Some(db) = &self.sql {
            self.check_snapshot()?;
            let bytes =
                serde_json::to_string(&next).map_err(|_| "Cannot encode server profiles.")?;
            if bytes.len() > 1_000_000 {
                return Err("Server storage capacity exceeded.".into());
            }
            let expected = std::str::from_utf8(
                self.snapshot
                    .as_deref()
                    .ok_or("Server storage unavailable.")?,
            )
            .map_err(|_| "Server storage unavailable.")?;
            db.compare_and_swap("ssh_profiles", expected, &bytes)?;
            self.snapshot = Some(bytes.into_bytes());
            self.data = Ok(next);
            return Ok(());
        }
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

fn decode(bytes: &[u8]) -> Result<Database, String> {
    let database: Database = serde_json::from_slice(bytes)
        .map_err(|_| "Server profile storage is invalid; it has not been overwritten.")?;
    if database.version != 1 || database.profiles.len() > 100 {
        return Err("Unsupported server profile storage; it has not been overwritten.".into());
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
            return Err("Invalid saved server profile; storage has not been overwritten.".into());
        }
    }
    if database.trusted_hosts.values().any(|key| {
        !key.fingerprint.starts_with("SHA256:")
            || key.fingerprint.len() > 100
            || key.algorithm.len() > 100
    }) {
        return Err("Invalid saved host identity; storage has not been overwritten.".into());
    }
    Ok(database)
}

#[cfg(test)]
mod sql_tests {
    use super::*;
    #[test]
    fn migrates_profiles_and_host_pins_once_without_changing_legacy_file() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("ssh-profiles.json");
        let mut old = Store::open(legacy.clone());
        let profile = ProfileInput {
            id: None,
            name: "Existing VPS".into(),
            host: "example.com".into(),
            port: 22,
            username: "deploy".into(),
            identity_file: None,
            password_allowed: true,
        }
        .validate()
        .unwrap();
        let mut data = Database::default();
        data.profiles.push(profile.clone());
        data.trusted_hosts.insert(
            profile.endpoint(),
            HostKey {
                algorithm: "ssh-ed25519".into(),
                fingerprint: "SHA256:fixture".into(),
            },
        );
        old.commit(data).unwrap();
        let original = fs::read(&legacy).unwrap();
        let db = crate::database::LocalDatabase::open(&dir.path().join("app.sqlite3")).unwrap();
        let mut migrated = Store::open_sql(db.clone(), legacy.clone());
        assert_eq!(migrated.database().unwrap().profiles[0].id, profile.id);
        assert_eq!(migrated.database().unwrap().trusted_hosts.len(), 1);
        let stale = Store::open_sql(db.clone(), legacy.clone());
        let mut next = migrated.database().unwrap().clone();
        next.profiles[0].name = "Renamed in SQLite".into();
        migrated.commit(next).unwrap();
        assert!(stale.database().is_err());
        assert_eq!(fs::read(&legacy).unwrap(), original);
        let restored = Store::open_sql(db, legacy);
        assert_eq!(
            restored.database().unwrap().profiles[0].name,
            "Renamed in SQLite"
        );
        assert_eq!(restored.database().unwrap().trusted_hosts.len(), 1);
    }
    #[test]
    fn corrupt_legacy_profiles_never_become_an_empty_migrated_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ssh-profiles.json");
        fs::write(&path, "{broken").unwrap();
        let db = crate::database::LocalDatabase::open(&dir.path().join("app.sqlite3")).unwrap();
        let store = Store::open_sql(db.clone(), path.clone());
        assert!(store.database().is_err());
        assert!(db.read("ssh_profiles").unwrap().is_none());
        assert_eq!(fs::read_to_string(path).unwrap(), "{broken");
    }
}
