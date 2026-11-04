//! App-owned local encrypted SSH key vault.
//!
//! Only encrypted OpenSSH private keys are stored, each under a canonical UUID
//! file name inside a private app-config directory. There is no in-memory index:
//! every listing re-reads the directory and validates each entry. The renderer
//! never supplies or receives a filesystem path for generation or reading.
use serde::Serialize;
use std::path::PathBuf;
#[cfg(unix)]
use std::sync::atomic::Ordering;
use std::sync::{atomic::AtomicBool, Arc};

#[cfg(unix)]
use russh::keys::{ssh_key::LineEnding, Algorithm, HashAlg, PrivateKey};
#[cfg(unix)]
use std::{
    fs::{self, File},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::Path,
};
#[cfg(unix)]
use tauri_plugin_dialog::DialogExt;
#[cfg(unix)]
use tempfile::Builder;
#[cfg(unix)]
use uuid::Uuid;
use zeroize::Zeroizing;

pub const MAX_VAULT_ENTRIES: usize = 100;
#[cfg(unix)]
const MAX_KEY_BYTES: usize = 16 * 1024;
#[cfg(unix)]
const MAX_LIST_SCAN: usize = 512;
#[cfg(not(unix))]
const UNAVAILABLE: &str =
    "The local encrypted key vault is unavailable on this platform. Encrypted app-owned key generation requires Unix file permissions.";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupKey {
    pub key_id: String,
    pub fingerprint: String,
    pub algorithm: String,
    pub encrypted: bool,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupKeyIssue {
    pub key_id: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupKeyList {
    pub keys: Vec<SetupKey>,
    pub issues: Vec<SetupKeyIssue>,
    pub storage_path: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub status: &'static str,
    pub path: Option<String>,
}

pub struct KeyVault {
    root: PathBuf,
    generating: Arc<AtomicBool>,
}

impl KeyVault {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            generating: Arc::new(AtomicBool::new(false)),
        }
    }

    #[cfg(unix)]
    fn begin_generation(&self) -> Result<GenerationGuard, String> {
        self.generating
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| GenerationGuard {
                flag: self.generating.clone(),
            })
            .map_err(|_| {
                "A local key is already being generated. Wait for it to finish before starting another."
                    .to_string()
            })
    }
}

/// Owned by the blocking worker, not by the awaitable caller future. Aborting
/// or dropping the caller must not reopen the gate while a worker still runs.
#[cfg(unix)]
struct GenerationGuard {
    flag: Arc<AtomicBool>,
}

#[cfg(unix)]
impl Drop for GenerationGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

#[cfg(unix)]
fn staging_name(name: &str) -> bool {
    name.starts_with(".vps-pilot-staging-") && name.ends_with(".tmp")
}

#[cfg(unix)]
fn canonical_id(value: &str) -> Result<String, String> {
    let parsed =
        Uuid::parse_str(value).map_err(|_| "Choose a valid local key reference.".to_string())?;
    let text = parsed.to_string();
    if text != value {
        return Err("Choose a valid local key reference.".to_string());
    }
    Ok(text)
}

#[cfg(unix)]
fn app_config_owner(root: &Path) -> Result<u32, String> {
    let parent = root
        .parent()
        .ok_or_else(|| "The local key folder is unavailable.".to_string())?;
    fs::metadata(parent)
        .map(|metadata| metadata.uid())
        .map_err(|_| "The local key folder is unavailable.".to_string())
}

#[cfg(unix)]
fn ensure_vault(root: &Path) -> Result<(), String> {
    let owner = app_config_owner(root)?;
    match fs::symlink_metadata(root) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                return Err("The local key folder is not a private directory.".into());
            }
            if metadata.mode() & 0o777 != 0o700 || metadata.mode() & 0o7000 != 0 {
                return Err(
                    "The local key folder has insecure permissions. It must be private to this account."
                        .into(),
                );
            }
            if metadata.uid() != owner {
                return Err(
                    "The local key folder belongs to another account. It was not used or changed."
                        .into(),
                );
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // The app-config parent already exists. Create only this child with
            // an explicit private mode; never silently chmod an existing path.
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder
                .create(root)
                .map_err(|_| "The local key folder could not be created.".to_string())?;
            let metadata = fs::symlink_metadata(root)
                .map_err(|_| "The local key folder could not be verified.".to_string())?;
            if metadata.file_type().is_symlink()
                || !metadata.file_type().is_dir()
                || metadata.mode() & 0o777 != 0o700
                || metadata.mode() & 0o7000 != 0
                || metadata.uid() != owner
            {
                return Err("The local key folder is not a private directory.".into());
            }
            Ok(())
        }
        Err(_) => Err("The local key folder is unavailable.".into()),
    }
}

#[cfg(unix)]
fn valid_key_metadata(metadata: &fs::Metadata, owner: u32) -> bool {
    metadata.file_type().is_file()
        && !metadata.file_type().is_symlink()
        && metadata.mode() & 0o777 == 0o600
        && metadata.mode() & 0o7000 == 0
        && metadata.uid() == owner
        && metadata.nlink() == 1
        && metadata.len() <= MAX_KEY_BYTES as u64
}

#[cfg(unix)]
fn read_valid_key(root: &Path, key_id: &str) -> Result<(SetupKey, Zeroizing<Vec<u8>>), String> {
    let owner = app_config_owner(root)?;
    let path = root.join(key_id);
    let before = fs::symlink_metadata(&path)
        .map_err(|_| "The stored local key is unreadable.".to_string())?;
    if before.file_type().is_symlink() || !before.file_type().is_file() {
        return Err(
            "The stored local key is not a regular file. It was preserved but is unavailable."
                .into(),
        );
    }
    if before.mode() & 0o777 != 0o600 || before.mode() & 0o7000 != 0 {
        return Err(
            "The stored local key has insecure permissions. It was preserved but is unavailable."
                .into(),
        );
    }
    if before.uid() != owner {
        return Err(
            "The stored local key belongs to another account. It was preserved but is unavailable."
                .into(),
        );
    }
    if before.nlink() != 1 {
        return Err(
            "The stored local key has unexpected links. It was preserved but is unavailable."
                .into(),
        );
    }
    if before.len() > MAX_KEY_BYTES as u64 {
        return Err(
            "The stored local key is larger than expected. It was preserved but is unavailable."
                .into(),
        );
    }
    let file = File::open(&path).map_err(|_| "The stored local key is unreadable.".to_string())?;
    let opened = file
        .metadata()
        .map_err(|_| "The stored local key is unreadable.".to_string())?;
    if opened.dev() != before.dev()
        || opened.ino() != before.ino()
        || !valid_key_metadata(&opened, owner)
    {
        return Err("The stored local key changed while it was being read. Try again.".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_KEY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The stored local key is unreadable.".to_string())?;
    if bytes.len() > MAX_KEY_BYTES {
        return Err(
            "The stored local key is larger than expected. It was preserved but is unavailable."
                .into(),
        );
    }
    let key = PrivateKey::from_openssh(bytes.as_slice()).map_err(|_| {
        "The stored local key could not be decoded. It was preserved but is unavailable."
            .to_string()
    })?;
    if !key.is_encrypted() {
        return Err(
            "The stored local key is not encrypted. It was preserved but is unavailable.".into(),
        );
    }
    if key.algorithm() != Algorithm::Ed25519 {
        return Err(
            "The stored local key uses an unsupported algorithm. It was preserved but is unavailable."
                .into(),
        );
    }
    Ok((
        SetupKey {
            key_id: key_id.to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            algorithm: key.algorithm().to_string(),
            encrypted: true,
            path: path.to_string_lossy().into_owned(),
        },
        bytes,
    ))
}

#[cfg(unix)]
fn list_blocking(root: &Path) -> Result<SetupKeyList, String> {
    ensure_vault(root)?;
    let mut keys = Vec::new();
    let mut issues = Vec::new();
    let mut truncated = false;
    let entries =
        fs::read_dir(root).map_err(|_| "The local key folder could not be read.".to_string())?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_LIST_SCAN {
            truncated = true;
            break;
        }
        let entry = entry.map_err(|_| "The local key folder could not be read.".to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            issues.push(SetupKeyIssue {
                key_id: None,
                reason: "An unrecognized entry was preserved but is unavailable.".into(),
            });
            continue;
        };
        if staging_name(name) {
            continue;
        }
        let id = match canonical_id(name) {
            Ok(id) => id,
            Err(_) => {
                issues.push(SetupKeyIssue {
                    key_id: None,
                    reason: "An unrecognized entry was preserved but is unavailable.".into(),
                });
                continue;
            }
        };
        match read_valid_key(root, &id) {
            Ok((key, _)) => keys.push(key),
            Err(reason) => issues.push(SetupKeyIssue {
                key_id: Some(id),
                reason,
            }),
        }
    }
    keys.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    issues.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    Ok(SetupKeyList {
        keys,
        issues,
        storage_path: root.to_string_lossy().into_owned(),
        truncated,
    })
}

#[cfg(unix)]
fn generate_blocking(root: &Path, passphrase: &[u8]) -> Result<SetupKey, String> {
    if !(12..=4096).contains(&passphrase.len()) {
        return Err("Use a passphrase between 12 and 4096 bytes.".into());
    }
    ensure_vault(root)?;
    let mut count = 0usize;
    for entry in
        fs::read_dir(root).map_err(|_| "The local key folder could not be read.".to_string())?
    {
        entry.map_err(|_| "The local key folder could not be read.".to_string())?;
        count += 1;
        if count >= MAX_VAULT_ENTRIES {
            return Err(format!(
                "The local key vault limit of {MAX_VAULT_ENTRIES} entries has been reached."
            ));
        }
    }
    let mut rng = rand::rng();
    let private = PrivateKey::random(&mut rng, Algorithm::Ed25519)
        .map_err(|_| "A local key could not be generated.".to_string())?;
    let encrypted = private
        .encrypt(&mut rng, passphrase)
        .map_err(|_| "The generated key could not be encrypted.".to_string())?;
    let fingerprint = encrypted.fingerprint(HashAlg::Sha256).to_string();
    let pem = encrypted
        .to_openssh(LineEnding::LF)
        .map_err(|_| "The encrypted key could not be encoded.".to_string())?;
    let key_id = Uuid::new_v4().to_string();
    let target = root.join(&key_id);
    let mut temporary = Builder::new()
        .prefix(".vps-pilot-staging-")
        .suffix(".tmp")
        .tempfile_in(root)
        .map_err(|_| "A temporary local key file could not be created.".to_string())?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "The temporary local key file could not be protected.".to_string())?;
    temporary
        .write_all(pem.as_bytes())
        .map_err(|_| "The encrypted key could not be written.".to_string())?;
    temporary
        .flush()
        .map_err(|_| "The encrypted key could not be written.".to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "The encrypted key could not be saved.".to_string())?;
    let staged = fs::read(temporary.path())
        .map_err(|_| "The staged key could not be verified.".to_string())?;
    let verified = PrivateKey::from_openssh(staged.as_slice())
        .map_err(|_| "The staged key could not be verified.".to_string())?;
    if !verified.is_encrypted()
        || verified.algorithm() != Algorithm::Ed25519
        || verified.fingerprint(HashAlg::Sha256).to_string() != fingerprint
    {
        return Err(
            "The staged key did not match the generated key. Nothing was published.".into(),
        );
    }
    temporary.persist_noclobber(&target).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            "A local key already uses this identifier. Nothing was overwritten.".to_string()
        } else {
            "The generated key could not be published. Nothing was overwritten.".to_string()
        }
    })?;
    // Persist already published atomically. A failed directory sync leaves that
    // key on disk; report uncertainty and never delete it here.
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| {
            "The key was published, but its folder could not be synced. Reload keys before retrying; the key may already exist."
                .to_string()
        })?;
    Ok(SetupKey {
        key_id,
        fingerprint,
        algorithm: "ssh-ed25519".into(),
        encrypted: true,
        path: target.to_string_lossy().into_owned(),
    })
}

#[cfg(unix)]
fn validate_key_blocking(root: &Path, key_id: &str) -> Result<(), String> {
    ensure_vault(root)?;
    let id = canonical_id(key_id)?;
    read_valid_key(root, &id).map(|_| ())
}

#[cfg(unix)]
fn export_to_blocking(root: &Path, key_id: &str, destination: &Path) -> Result<(), String> {
    ensure_vault(root)?;
    let id = canonical_id(key_id)?;
    let (_, bytes) = read_valid_key(root, &id)?;
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err("The chosen backup folder is unavailable.".into());
    }
    // Stage inside the destination directory; the final name is only created by
    // a no-clobber atomic persist. A failed copy cannot publish a partial file.
    let mut temporary = Builder::new()
        .prefix(".vps-pilot-backup-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|_| "The encrypted key backup could not be staged.".to_string())?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "The encrypted key backup could not be protected.".to_string())?;
    temporary
        .write_all(bytes.as_slice())
        .map_err(|_| "The encrypted key backup could not be written.".to_string())?;
    temporary
        .flush()
        .map_err(|_| "The encrypted key backup could not be written.".to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "The encrypted key backup could not be saved.".to_string())?;
    let staged_len = temporary
        .as_file()
        .metadata()
        .map_err(|_| "The staged encrypted key backup could not be verified.".to_string())?
        .len();
    if staged_len != bytes.len() as u64 {
        return Err("The staged encrypted key backup did not match. Nothing was published.".into());
    }
    temporary.persist_noclobber(destination).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            "A file already exists at the chosen backup destination. Nothing was overwritten."
                .to_string()
        } else {
            "The encrypted key backup could not be published. Nothing was overwritten.".to_string()
        }
    })?;
    // The published copy is kept if this directory sync fails; report
    // uncertainty rather than deleting someone else's destination path.
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| {
            "The encrypted key backup was written, but its folder could not be synced. Verify the backup before relying on it."
                .to_string()
        })?;
    Ok(())
}

#[cfg(unix)]
impl KeyVault {
    pub async fn list_async(&self) -> Result<SetupKeyList, String> {
        let root = self.root.clone();
        tauri::async_runtime::spawn_blocking(move || list_blocking(&root))
            .await
            .map_err(|_| "The local key vault could not be read.".to_string())?
    }

    async fn run_generation<F>(&self, passphrase: String, work: F) -> Result<SetupKey, String>
    where
        F: FnOnce(&Path, &[u8]) -> Result<SetupKey, String> + Send + 'static,
    {
        // Zeroize rejected input too, then bound it before the gate or worker.
        let passphrase = Zeroizing::new(passphrase);
        if !(12..=4096).contains(&passphrase.len()) {
            return Err("Use a passphrase between 12 and 4096 bytes.".into());
        }
        let guard = self.begin_generation()?;
        let root = self.root.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // The worker owns the gate. If the caller future is dropped or
            // aborted, the gate stays closed until this closure returns.
            let _guard = guard;
            work(&root, passphrase.as_bytes())
        })
        .await
        .map_err(|_| "The local key generation task could not complete.".to_string())?
    }

    pub async fn generate_async(&self, passphrase: String) -> Result<SetupKey, String> {
        self.run_generation(passphrase, generate_blocking).await
    }

    pub async fn validate_async(&self, key_id: &str) -> Result<(), String> {
        let root = self.root.clone();
        let key_id = key_id.to_string();
        tauri::async_runtime::spawn_blocking(move || validate_key_blocking(&root, &key_id))
            .await
            .map_err(|_| "The local key could not be checked.".to_string())?
    }

    pub async fn export_async(&self, key_id: &str, destination: PathBuf) -> Result<(), String> {
        let root = self.root.clone();
        let key_id = key_id.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            export_to_blocking(&root, &key_id, &destination)
        })
        .await
        .map_err(|_| "The encrypted key backup task could not complete.".to_string())?
    }
}

#[cfg(not(unix))]
impl KeyVault {
    pub async fn list_async(&self) -> Result<SetupKeyList, String> {
        Err(UNAVAILABLE.into())
    }

    pub async fn generate_async(&self, passphrase: String) -> Result<SetupKey, String> {
        let _passphrase = Zeroizing::new(passphrase);
        Err(UNAVAILABLE.into())
    }

    pub async fn validate_async(&self, _key_id: &str) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    pub async fn export_async(&self, _key_id: &str, _destination: PathBuf) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
}

#[tauri::command]
pub async fn app_setup_keys_list(
    vault: tauri::State<'_, KeyVault>,
) -> Result<SetupKeyList, String> {
    vault.list_async().await
}

#[tauri::command]
pub async fn app_setup_key_generate(
    vault: tauri::State<'_, KeyVault>,
    passphrase: String,
) -> Result<SetupKey, String> {
    vault.generate_async(passphrase).await
}

#[cfg(unix)]
#[tauri::command]
pub async fn app_setup_key_export(
    app: tauri::AppHandle,
    vault: tauri::State<'_, KeyVault>,
    key_id: String,
) -> Result<ExportResult, String> {
    vault.validate_async(&key_id).await?;
    let suggested = format!("vps-pilot-{}.key", key_id.get(..8).unwrap_or("local-key"));
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Back up encrypted SSH key")
            .set_file_name(suggested)
            .blocking_save_file()
    })
    .await
    .map_err(|_| "The backup destination dialog was unavailable.".to_string())?;
    let Some(selected) = selected else {
        return Ok(ExportResult {
            status: "canceled",
            path: None,
        });
    };
    let destination = selected
        .into_path()
        .map_err(|_| "Choose a local backup destination.".to_string())?;
    vault.export_async(&key_id, destination.clone()).await?;
    Ok(ExportResult {
        status: "exported",
        path: Some(destination.to_string_lossy().into_owned()),
    })
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn app_setup_key_export(
    app: tauri::AppHandle,
    vault: tauri::State<'_, KeyVault>,
    key_id: String,
) -> Result<ExportResult, String> {
    // Keep the same camelCase `keyId` argument contract as the Unix command.
    let _ = (app, vault, key_id);
    Err(UNAVAILABLE.into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    fn new_vault(dir: &tempfile::TempDir) -> KeyVault {
        KeyVault::new(dir.path().join("setup-keys"))
    }

    fn passphrase() -> &'static [u8] {
        b"correct horse battery staple"
    }

    #[test]
    fn generates_a_real_encrypted_ed25519_key_and_rejects_a_wrong_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let vault = new_vault(&dir);
        let key = generate_blocking(&vault.root, passphrase()).unwrap();
        assert_eq!(key.algorithm, "ssh-ed25519");
        assert!(key.encrypted);
        assert!(key.fingerprint.starts_with("SHA256:"));
        let metadata = fs::metadata(&key.path).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o600);
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(fs::metadata(&vault.root).unwrap().mode() & 0o777, 0o700);
        let pem = fs::read_to_string(&key.path).unwrap();
        assert!(!pem.contains(std::str::from_utf8(passphrase()).unwrap()));
        let parsed = PrivateKey::from_openssh(pem.as_bytes()).unwrap();
        assert!(parsed.is_encrypted());
        assert_eq!(
            parsed.public_key().fingerprint(HashAlg::Sha256).to_string(),
            key.fingerprint
        );
        let decrypted = parsed.decrypt(passphrase()).unwrap();
        assert_eq!(
            decrypted
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
            key.fingerprint
        );
        assert!(parsed.decrypt(b"definitely not the passphrase").is_err());
    }

    #[test]
    fn listing_recovers_published_keys_after_restart_without_an_index() {
        let dir = tempfile::tempdir().unwrap();
        let first = generate_blocking(&dir.path().join("setup-keys"), passphrase()).unwrap();
        let second = generate_blocking(&dir.path().join("setup-keys"), passphrase()).unwrap();
        let restart = new_vault(&dir);
        let listed = list_blocking(&restart.root).unwrap();
        assert_eq!(listed.keys.len(), 2);
        assert!(listed.issues.is_empty());
        assert_eq!(listed.storage_path, restart.root.to_string_lossy());
        let mut fingerprints: Vec<_> = listed
            .keys
            .iter()
            .map(|key| key.fingerprint.clone())
            .collect();
        fingerprints.sort();
        let mut expected = vec![first.fingerprint, second.fingerprint];
        expected.sort();
        assert_eq!(fingerprints, expected);
    }

    #[test]
    fn rejects_malformed_ids_traversal_and_symlinked_or_insecure_entries() {
        let dir = tempfile::tempdir().unwrap();
        let vault = new_vault(&dir);
        let key = generate_blocking(&vault.root, passphrase()).unwrap();
        assert!(canonical_id("../escape").is_err());
        assert!(canonical_id("not-a-uuid").is_err());
        assert!(canonical_id(&key.key_id.to_uppercase()).is_err());
        assert!(validate_key_blocking(&vault.root, "../escape").is_err());
        assert!(export_to_blocking(&vault.root, "../escape", &dir.path().join("escape")).is_err());

        let other = generate_blocking(&vault.root, passphrase()).unwrap();
        let target = dir.path().join("outside-key");
        fs::write(&target, b"outside").unwrap();
        fs::remove_file(&other.path).unwrap();
        symlink(&target, &other.path).unwrap();
        let listed = list_blocking(&vault.root).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert!(listed
            .issues
            .iter()
            .any(|issue| issue.key_id.as_deref() == Some(other.key_id.as_str())));
        assert!(validate_key_blocking(&vault.root, &other.key_id).is_err());

        let insecure = Uuid::new_v4().to_string();
        let insecure_path = vault.root.join(&insecure);
        fs::write(&insecure_path, b"not a key").unwrap();
        fs::set_permissions(&insecure_path, fs::Permissions::from_mode(0o644)).unwrap();
        let listed = list_blocking(&vault.root).unwrap();
        assert!(listed.issues.iter().any(|issue| {
            issue.key_id.as_deref() == Some(insecure.as_str()) && issue.reason.contains("insecure")
        }));
        assert!(validate_key_blocking(&vault.root, &insecure).is_err());

        let corrupt = Uuid::new_v4().to_string();
        let corrupt_path = vault.root.join(&corrupt);
        fs::write(&corrupt_path, b"not a key").unwrap();
        fs::set_permissions(&corrupt_path, fs::Permissions::from_mode(0o600)).unwrap();
        let listed = list_blocking(&vault.root).unwrap();
        assert!(listed
            .issues
            .iter()
            .any(|issue| issue.key_id.as_deref() == Some(corrupt.as_str())));

        fs::set_permissions(&vault.root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(list_blocking(&vault.root).is_err());
        assert!(validate_key_blocking(&vault.root, &key.key_id).is_err());
    }

    #[test]
    fn backup_export_is_a_private_copy_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let vault = new_vault(&dir);
        let key = generate_blocking(&vault.root, passphrase()).unwrap();
        let destination = dir.path().join("backup.key");
        export_to_blocking(&vault.root, &key.key_id, &destination).unwrap();
        let original = fs::read(&key.path).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), original);
        assert_eq!(fs::metadata(&destination).unwrap().mode() & 0o777, 0o600);
        assert!(export_to_blocking(&vault.root, &key.key_id, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), original);
        let missing = dir.path().join("missing").join("backup.key");
        assert!(export_to_blocking(&vault.root, &key.key_id, &missing).is_err());
    }

    #[test]
    fn preserves_other_algorithms_as_unsupported_and_rejects_a_symlink_vault_root() {
        let dir = tempfile::tempdir().unwrap();
        let vault = new_vault(&dir);
        ensure_vault(&vault.root).unwrap();
        let other = PrivateKey::random(
            &mut rand::rng(),
            Algorithm::Ecdsa {
                curve: russh::keys::EcdsaCurve::NistP256,
            },
        )
        .unwrap()
        .encrypt(&mut rand::rng(), passphrase())
        .unwrap()
        .to_openssh(LineEnding::LF)
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let path = vault.root.join(&id);
        fs::write(&path, other.as_bytes()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let listed = list_blocking(&vault.root).unwrap();
        assert!(listed.keys.is_empty());
        assert!(listed.issues.iter().any(|issue| {
            issue.key_id.as_deref() == Some(id.as_str())
                && issue.reason.contains("unsupported algorithm")
        }));
        assert!(validate_key_blocking(&vault.root, &id).is_err());

        let link = dir.path().join("linked-vault");
        symlink(&vault.root, &link).unwrap();
        assert!(ensure_vault(&link).is_err());
        assert!(list_blocking(&link).is_err());
    }

    #[test]
    fn generation_gate_stays_closed_when_the_awaiting_future_is_aborted() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(KeyVault::new(dir.path().join("setup-keys")));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker_vault = vault.clone();
        let future = async move {
            worker_vault
                .run_generation("correct horse battery staple".into(), move |root, pass| {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    generate_blocking(root, pass)
                })
                .await
        };
        let handle = tauri::async_runtime::spawn(future);
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("worker did not start");
        handle.abort();
        assert!(vault.begin_generation().is_err());
        // Aborting the caller future does not stop the blocking worker or
        // release its gate.
        assert!(vault.begin_generation().is_err());
        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match vault.begin_generation() {
                Ok(guard) => {
                    drop(guard);
                    break;
                }
                Err(_) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("worker never released the generation gate: {error}"),
            }
        }
    }

    #[test]
    fn enforces_passphrase_bounds_vault_limit_regular_entries_and_single_generation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("setup-keys");
        for candidate in [b"".as_slice(), b"short".as_slice(), &[b'x'; 4097][..]] {
            assert!(generate_blocking(&root, candidate).is_err());
        }
        assert!(generate_blocking(&root, b"twelve bytes!").is_ok());

        let dir = tempfile::tempdir().unwrap();
        let vault = new_vault(&dir);
        ensure_vault(&vault.root).unwrap();
        for _ in 0..MAX_VAULT_ENTRIES {
            fs::write(vault.root.join(Uuid::new_v4().to_string()), b"").unwrap();
        }
        assert!(generate_blocking(&vault.root, passphrase()).is_err());

        let dir = tempfile::tempdir().unwrap();
        let vault = new_vault(&dir);
        ensure_vault(&vault.root).unwrap();
        let _guard = vault.begin_generation().unwrap();
        assert!(vault.begin_generation().is_err());
        drop(_guard);
        assert!(vault.begin_generation().is_ok());
    }
}
