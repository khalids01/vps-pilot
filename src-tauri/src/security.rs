//! Device-local lock. No credential value is ever returned through IPC.
use serde::{Deserialize, Serialize};
mod app_password;
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
#[cfg(not(target_os = "linux"))]
use tauri_plugin_biometry::BiometryExt;
#[cfg(target_os = "linux")]
mod linux;
use zeroize::Zeroizing;

pub struct Security {
    path: PathBuf,
    state: Mutex<LockState>,
    settings: Mutex<()>,
}
struct LockState {
    enabled: bool,
    password_hash: Option<String>,
    failures: u32,
    next_attempt: Option<Instant>,
    unlocked: bool,
    authenticating: bool,
    generation: u64,
    activity: Instant,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LockConfig {
    version: u8,
    enabled: bool,
    password_hash: Option<String>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredConfig {
    Legacy(bool),
    Current(LockConfig),
}
impl Security {
    pub fn load(path: PathBuf) -> std::io::Result<Self> {
        let config = match std::fs::read(&path) {
            Ok(bytes) => {
                let stored: StoredConfig =
                    serde_json::from_slice(&bytes).map_err(std::io::Error::other)?;
                match stored {
                    StoredConfig::Legacy(enabled) => LockConfig {
                        version: 1,
                        enabled,
                        password_hash: None,
                    },
                    StoredConfig::Current(config) => config,
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => LockConfig {
                version: 1,
                enabled: false,
                password_hash: None,
            },
            Err(e) => return Err(e),
        };
        if config.version != 1 {
            return Err(std::io::Error::other("Unsupported lock settings version."));
        }
        if let Some(hash) = &config.password_hash {
            app_password::validate_hash(hash).map_err(std::io::Error::other)?;
        }
        Ok(Self {
            path,
            settings: Mutex::new(()),
            state: Mutex::new(LockState {
                enabled: config.enabled,
                password_hash: config.password_hash,
                failures: 0,
                next_attempt: None,
                unlocked: false,
                authenticating: false,
                generation: 0,
                activity: Instant::now(),
            }),
        })
    }
    fn persist(&self, config: &LockConfig) -> Result<(), String> {
        use std::io::Write;
        let mut file =
            tempfile::NamedTempFile::new_in(self.path.parent().ok_or("Lock path unavailable")?)
                .map_err(|_| "Cannot save lock settings")?;
        serde_json::to_writer(&mut file, config).map_err(|_| "Cannot save lock settings")?;
        file.flush().map_err(|_| "Cannot save lock settings")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot save lock settings")?;
        file.persist(&self.path)
            .map_err(|_| "Cannot save lock settings")?;
        Ok(())
    }
    fn authenticate_with(
        &self,
        password: Zeroizing<String>,
        legacy: impl FnOnce(Zeroizing<String>) -> Result<(), String>,
    ) -> Result<(), String> {
        let (generation, password_hash) = {
            let mut s = self.state.lock().map_err(|_| "Lock unavailable")?;
            if s.authenticating {
                return Err("Authentication is already in progress.".into());
            }
            if s.next_attempt.is_some_and(|time| Instant::now() < time) {
                return Err("Too many attempts. Try again in a moment.".into());
            }
            s.authenticating = true;
            (s.generation, s.password_hash.clone())
        };
        let result = if let Some(hash) = password_hash {
            app_password::verify(&password, &hash)
        } else {
            legacy(password)
        };
        let mut s = self.state.lock().map_err(|_| "Lock unavailable")?;
        s.authenticating = false;
        if let Err(error) = result {
            s.failures = s.failures.saturating_add(1);
            s.next_attempt = Some(Instant::now() + Duration::from_secs(1u64 << s.failures.min(5)));
            return Err(error);
        }
        s.failures = 0;
        s.next_attempt = None;
        if generation != s.generation {
            return Err(
                "Authentication was canceled because the app was locked. Try again.".into(),
            );
        }
        s.unlocked = true;
        s.activity = Instant::now();
        Ok(())
    }
    fn change_password_with(
        &self,
        old_password: Zeroizing<String>,
        new_password: Zeroizing<String>,
        legacy: impl FnOnce(Zeroizing<String>) -> Result<(), String>,
    ) -> Result<(), String> {
        let _settings = self
            .settings
            .lock()
            .map_err(|_| "Lock settings unavailable")?;
        app_password::validate_new(&new_password)?;
        if self.locked() {
            return Err("Unlock VPS Pilot before changing its password.".into());
        }
        let (generation, needs_auth, enabled) = {
            let s = self.state.lock().map_err(|_| "Lock unavailable")?;
            (
                s.generation,
                s.enabled || s.password_hash.is_some(),
                s.enabled || s.password_hash.is_none(),
            )
        };
        if needs_auth {
            self.authenticate_with(old_password, legacy)?;
        }
        let hash = app_password::hash(&new_password)?;
        if self.locked() {
            return Err("Unlock VPS Pilot before changing its password.".into());
        }
        let mut s = self.state.lock().map_err(|_| "Lock unavailable")?;
        if generation != s.generation {
            return Err("The app was locked. Try again after unlocking.".into());
        }
        self.persist(&LockConfig {
            version: 1,
            enabled,
            password_hash: Some(hash.clone()),
        })?;
        s.password_hash = Some(hash);
        s.enabled = enabled;
        s.unlocked = true;
        s.activity = Instant::now();
        s.generation = s.generation.wrapping_add(1);
        Ok(())
    }
    pub fn locked(&self) -> bool {
        self.state
            .lock()
            .map(|mut s| {
                if s.unlocked && s.activity.elapsed() >= Duration::from_secs(300) {
                    s.unlocked = false;
                    s.generation = s.generation.wrapping_add(1);
                }
                s.enabled && !s.unlocked
            })
            .unwrap_or(true)
    }
    pub fn allows(&self, command: &str) -> bool {
        matches!(
            command,
            "app_security_status"
                | "app_security_unlock"
                | "app_security_enable"
                | "app_security_lock"
                | "app_security_activity"
                | "ssh_stream_ack"
                | "ssh_stream_close"
                | "ssh_disconnect"
        ) || !self.locked()
    }
    pub fn lock(&self) {
        if let Ok(mut s) = self.state.lock() {
            if !s.authenticating || cfg!(target_os = "linux") || s.password_hash.is_some() {
                s.unlocked = false;
                s.generation = s.generation.wrapping_add(1);
            }
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    locked: bool,
    available: bool,
    app_password_set: bool,
    password_required: bool,
    account_name: Option<String>,
    unavailable_reason: Option<String>,
}
#[tauri::command]
pub fn app_security_status(app: tauri::AppHandle, security: tauri::State<'_, Security>) -> Status {
    #[cfg(target_os = "linux")]
    let provider = linux::available();
    #[cfg(not(target_os = "linux"))]
    let provider = app
        .biometry()
        .status()
        .ok()
        .filter(|s| s.is_available)
        .map(|_| String::new())
        .ok_or_else(|| {
            "Configure device authentication in your operating system settings.".to_string()
        });
    #[cfg(target_os = "linux")]
    let _ = app;
    let app_password_set = security
        .state
        .lock()
        .map(|s| s.password_hash.is_some())
        .unwrap_or(false);
    Status {
        app_password_set,
        locked: security.locked(),
        enabled: security.state.lock().map(|s| s.enabled).unwrap_or(true),
        available: app_password_set || provider.is_ok(),
        password_required: app_password_set || cfg!(target_os = "linux"),
        account_name: if app_password_set {
            None
        } else {
            provider
                .as_ref()
                .ok()
                .filter(|name| !name.is_empty())
                .cloned()
        },
        unavailable_reason: if app_password_set {
            None
        } else {
            provider.err()
        },
    }
}
fn device_authenticate(app: &tauri::AppHandle, password: Zeroizing<String>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        linux::authenticate(password)
    }
    #[cfg(not(target_os = "linux"))]
    {
        drop(password);
        app.biometry()
            .authenticate(
                "Unlock VPS Pilot server access".into(),
                tauri_plugin_biometry::AuthOptions {
                    allow_device_credential: Some(true),
                    ..Default::default()
                },
            )
            .map_err(|_| "Device authentication was canceled or failed. Try again.".to_string())
    }
}
fn authenticate(
    app: &tauri::AppHandle,
    security: &Security,
    password: Zeroizing<String>,
) -> Result<(), String> {
    security.authenticate_with(password, |password| device_authenticate(app, password))
}
#[tauri::command]
pub async fn app_security_unlock(
    app: tauri::AppHandle,
    password: Option<String>,
) -> Result<(), String> {
    let password = Zeroizing::new(password.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || {
        authenticate(&app, &app.state::<Security>(), password)
    })
    .await
    .map_err(|_| "Authentication unavailable".to_string())?
}
#[tauri::command]
pub async fn app_security_enable(
    app: tauri::AppHandle,
    enabled: bool,
    password: Option<String>,
) -> Result<(), String> {
    let password = Zeroizing::new(password.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || {
        let security = app.state::<Security>();
        let _settings = security
            .settings
            .lock()
            .map_err(|_| "Lock settings unavailable")?;
        authenticate(&app, &security, password)?;
        let mut s = security.state.lock().map_err(|_| "Lock unavailable")?;
        security.persist(&LockConfig {
            version: 1,
            enabled,
            password_hash: s.password_hash.clone(),
        })?;
        s.enabled = enabled;
        Ok(())
    })
    .await
    .map_err(|_| "Authentication unavailable".to_string())?
}
#[tauri::command]
pub async fn app_security_change_password(
    app: tauri::AppHandle,
    old_password: Option<String>,
    new_password: String,
) -> Result<(), String> {
    let old_password = Zeroizing::new(old_password.unwrap_or_default());
    let new_password = Zeroizing::new(new_password);
    tauri::async_runtime::spawn_blocking(move || {
        let security = app.state::<Security>();
        security.change_password_with(old_password, new_password, |password| {
            device_authenticate(&app, password)
        })
    })
    .await
    .map_err(|_| "Password change unavailable".to_string())?
}
#[tauri::command]
pub fn app_security_lock(security: tauri::State<'_, Security>) {
    security.lock();
}
#[tauri::command]
pub fn app_security_activity(security: tauri::State<'_, Security>) {
    if let Ok(mut s) = security.state.lock() {
        if s.unlocked && s.activity.elapsed() < Duration::from_secs(300) {
            s.activity = Instant::now();
        }
    }
}
fn credential_account(profile: &crate::ssh::store::Profile) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let identity =
        serde_json::to_vec(&(&profile.id, &profile.host, profile.port, &profile.username))
            .map_err(|_| "Invalid credential identity")?;
    Ok(format!("ssh-{:x}", Sha256::digest(identity)))
}
fn entry(profile: &crate::ssh::store::Profile) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.vps-pilot.ssh", &credential_account(profile)?)
        .map_err(|_| "OS credential storage is unavailable. Enter the password manually.".into())
}
pub fn password(profile: &crate::ssh::store::Profile) -> Result<Zeroizing<String>, String> {
    entry(profile)?.get_password().map(Zeroizing::new).map_err(|_| "Saved password is missing or the OS credential store is locked. Enter the password manually.".into())
}
pub fn save(profile: &crate::ssh::store::Profile, password: &str) -> Result<(), String> {
    entry(profile)?.set_password(password).map_err(|_| {
        "Connected, but the password could not be saved in OS credential storage.".into()
    })
}
#[tauri::command]
pub async fn ssh_password_forget(
    service: tauri::State<'_, crate::ssh::SshService>,
    profile_id: String,
) -> Result<(), String> {
    let profile = service.profile(&profile_id)?;
    match entry(&profile)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => {
            Err("Cannot remove saved password. Unlock OS credential storage and retry.".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn secret(value: &str) -> Zeroizing<String> {
        Zeroizing::new(value.to_string())
    }
    #[test]
    fn app_password_changes_require_the_old_password_and_survive_restart() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("lock.json");
        let security = Security::load(path.clone()).unwrap();
        security
            .change_password_with(secret(""), secret("fixture-first-password"), |_| {
                panic!("First setup must not use OS credentials")
            })
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&before).contains("fixture-first-password"));
        assert!(security
            .change_password_with(
                secret("wrong"),
                secret("fixture-next-password"),
                |_| panic!("No native fallback")
            )
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        security.state.lock().unwrap().next_attempt = None;
        security
            .change_password_with(
                secret("fixture-first-password"),
                secret("fixture-next-password"),
                |_| panic!("No native fallback"),
            )
            .unwrap();
        let restored = Security::load(path).unwrap();
        assert!(restored.locked());
        assert!(restored
            .authenticate_with(secret("fixture-first-password"), |_| panic!(
                "No native fallback"
            ))
            .is_err());
        assert!(restored.locked());
        restored.state.lock().unwrap().next_attempt = None;
        restored
            .authenticate_with(secret("fixture-next-password"), |_| {
                panic!("No native fallback")
            })
            .unwrap();
        assert!(!restored.locked());
    }
    #[test]
    fn custom_password_authentication_is_canceled_by_focus_loss_on_every_platform() {
        let folder = tempfile::tempdir().unwrap();
        let security = Security::load(folder.path().join("lock.json")).unwrap();
        security
            .change_password_with(secret(""), secret("fixture-first-password"), |_| Ok(()))
            .unwrap();
        {
            let mut state = security.state.lock().unwrap();
            state.authenticating = true;
        }
        let generation = security.state.lock().unwrap().generation;
        security.lock();
        assert!(security.locked());
        assert_ne!(security.state.lock().unwrap().generation, generation);
    }
    #[test]
    fn password_changes_preserve_an_explicitly_disabled_lock() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("lock.json");
        let hash = app_password::hash("fixture-first-password").unwrap();
        let security = Security::load(path.clone()).unwrap();
        security
            .persist(&LockConfig {
                version: 1,
                enabled: false,
                password_hash: Some(hash),
            })
            .unwrap();
        let security = Security::load(path.clone()).unwrap();
        security
            .change_password_with(
                secret("fixture-first-password"),
                secret("fixture-next-password"),
                |_| panic!("No OS fallback"),
            )
            .unwrap();
        let restored = Security::load(path.clone()).unwrap();
        assert!(!restored.state.lock().unwrap().enabled);
        assert!(app_password::verify(
            "fixture-next-password",
            restored
                .state
                .lock()
                .unwrap()
                .password_hash
                .as_deref()
                .unwrap()
        )
        .is_ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o077,
                0
            );
        }
    }
    #[test]
    fn legacy_enabled_locks_require_device_auth_before_password_migration() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("lock.json");
        std::fs::write(&path, "true").unwrap();
        let security = Security::load(path.clone()).unwrap();
        assert!(security
            .change_password_with(secret("old"), secret("fixture-new-password"), |_| Ok(()))
            .is_err());
        security
            .authenticate_with(secret("old"), |_| Ok(()))
            .unwrap();
        assert!(security
            .change_password_with(secret("wrong"), secret("fixture-new-password"), |_| Err(
                "Incorrect device password".into()
            ))
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"true");
        security.state.lock().unwrap().next_attempt = None;
        security
            .change_password_with(secret("old"), secret("fixture-new-password"), |_| Ok(()))
            .unwrap();
        let restored = Security::load(path).unwrap();
        restored
            .authenticate_with(secret("fixture-new-password"), |_| {
                panic!("Migrated lock must use app password")
            })
            .unwrap();
    }
    #[test]
    fn failed_storage_preserves_the_existing_password_and_lock_configuration() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("missing/lock.json");
        let security = Security::load(path).unwrap();
        assert!(security
            .change_password_with(secret(""), secret("fixture-first-password"), |_| Ok(()))
            .is_err());
        let state = security.state.lock().unwrap();
        assert!(!state.enabled);
        assert!(state.password_hash.is_none());
    }
    #[test]
    fn lock_persists_and_starts_locked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lock.json");
        let security = Security::load(path.clone()).unwrap();
        assert!(!security.locked());
        std::fs::write(&path, "true").unwrap();
        let security = Security::load(path.clone()).unwrap();
        assert!(security.locked());
        assert!(!security.allows("ssh_connect"));
        assert!(!security.allows("ssh_password_forget"));
        assert!(!security.allows("ssh_action_execute"));
        assert!(security.allows("app_security_unlock"));
        assert!(security.allows("ssh_stream_ack"));
        assert!(!security.allows("app_security_fake_execute"));
        {
            let mut s = security.state.lock().unwrap();
            s.unlocked = true;
        }
        assert!(!security.locked());
        security.lock();
        assert!(security.locked());
        assert!(Security::load(path).unwrap().locked());
    }
    #[test]
    fn locking_invalidates_a_pending_linux_authentication() {
        let dir = tempfile::tempdir().unwrap();
        let security = Security::load(dir.path().join("lock.json")).unwrap();
        let generation = security.state.lock().unwrap().generation;
        security.lock();
        assert_ne!(security.state.lock().unwrap().generation, generation);
        #[cfg(target_os = "linux")]
        {
            security.state.lock().unwrap().authenticating = true;
            let generation = security.state.lock().unwrap().generation;
            security.lock();
            assert_ne!(security.state.lock().unwrap().generation, generation);
        }
    }
    #[test]
    fn expired_sessions_cannot_be_revived_by_activity() {
        let dir = tempfile::tempdir().unwrap();
        let security = Security::load(dir.path().join("lock.json")).unwrap();
        {
            let mut s = security.state.lock().unwrap();
            s.enabled = true;
            s.unlocked = true;
            s.activity = Instant::now() - Duration::from_secs(301);
        }
        assert!(security.locked());
        assert!(!security.state.lock().unwrap().unlocked);
    }

    #[test]
    fn saved_credentials_are_bound_to_the_exact_endpoint() {
        let mut profile = crate::ssh::store::Profile {
            id: "profile-one".into(),
            revision: "one".into(),
            name: "Server".into(),
            host: "example.com".into(),
            port: 22,
            username: "admin".into(),
            identity_file: None,
            password_allowed: true,
        };
        let original = credential_account(&profile).unwrap();
        profile.name = "Renamed".into();
        profile.revision = "two".into();
        assert_eq!(credential_account(&profile).unwrap(), original);
        profile.host = "other.example.com".into();
        assert_ne!(credential_account(&profile).unwrap(), original);
        profile.host = "example.com".into();
        profile.port = 2222;
        assert_ne!(credential_account(&profile).unwrap(), original);
        profile.port = 22;
        profile.username = "root".into();
        assert_ne!(credential_account(&profile).unwrap(), original);
    }
    #[test]
    fn corrupt_lock_settings_are_not_silently_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lock.json");
        std::fs::write(&path, "invalid").unwrap();
        assert!(Security::load(path).is_err());
    }
}
