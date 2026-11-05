//! App-owned local encrypted SSH key vault.
//!
//! New keys are encrypted OpenSSH Ed25519 private keys stored under the user's
//! standard `~/.ssh` directory as `vps-pilot_<canonical UUID>` with a matching
//! `.pub` sidecar. Keys created by the older app-owned vault remain listable
//! under `app_config_dir/setup-keys` and can be copied into `~/.ssh` only by an
//! explicit user action.
//!
//! There is no in-memory index: every listing re-reads both roots and validates
//! each app-owned entry. Named generated keys and explicitly chosen existing
//! keys have no UUID-derived file name, so a bounded, protected per-reference
//! metadata directory records only opaque IDs and non-secret verification data.
//! The renderer never supplies or receives a filesystem path for generation,
//! copying, reading, or export.
use serde::Serialize;
use std::path::PathBuf;
#[cfg(unix)]
use std::sync::atomic::Ordering;
use std::sync::{atomic::AtomicBool, Arc};

#[cfg(unix)]
mod references;

#[cfg(unix)]
use russh::keys::{ssh_key::LineEnding, Algorithm, HashAlg, PrivateKey, PublicKey};
#[cfg(unix)]
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::{
    collections::{BTreeMap, BTreeSet},
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
pub(crate) const MAX_KEY_BYTES: usize = 16 * 1024;
#[cfg(unix)]
const MAX_PUBLIC_BYTES: usize = 8 * 1024;
#[cfg(unix)]
pub(crate) const MAX_LIST_SCAN: usize = 4096;
#[cfg(unix)]
const SSH_KEY_PREFIX: &str = "vps-pilot_";
#[cfg(unix)]
const MAX_KEY_NAME_BYTES: usize = 64;
#[cfg(unix)]
const RESERVED_KEY_NAMES: [&str; 4] = ["config", "authorized_keys", "known_hosts", "environment"];
#[cfg(not(unix))]
const UNAVAILABLE: &str =
    "The local key vault is unavailable on this platform. Local key files require Unix file permissions.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyLocation {
    Ssh,
    Legacy,
    External,
}

/// How a native key reference was created. `Generated` keys are owned by this
/// app under the standard SSH directory; `Selected` keys are existing user files
/// that are never changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyOrigin {
    Generated,
    Selected,
    Legacy,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupKey {
    pub key_id: String,
    pub fingerprint: String,
    pub algorithm: String,
    pub encrypted: bool,
    pub path: String,
    pub location: KeyLocation,
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
    pub legacy_storage_path: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub status: &'static str,
    pub path: Option<String>,
    pub encrypted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub status: &'static str,
    pub key: SetupKey,
}

/// Read-only answer for the inline key-name availability check. It never
/// creates the standard SSH directory or any file.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyNameCheck {
    pub file_name: String,
    pub available: bool,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectResult {
    pub status: &'static str,
    pub key: Option<SetupKey>,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedKeyMetadata {
    pub path: PathBuf,
    pub fingerprint: String,
    pub digest: [u8; 32],
    pub location: KeyLocation,
    pub algorithm: String,
    pub encrypted: bool,
    pub origin: KeyOrigin,
    pub public_path: Option<PathBuf>,
    pub public_issue: Option<String>,
}

/// Safe, renderer-independent view for the later reviewed SSH config export.
/// A caller must resolve the opaque key ID here instead of accepting a path
/// from the renderer.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedConfigKey {
    pub key_id: String,
    pub path: String,
    pub public_path: Option<String>,
    pub fingerprint: String,
    pub digest: [u8; 32],
    pub algorithm: String,
    pub encrypted: bool,
    pub location: KeyLocation,
    pub origin: KeyOrigin,
}

pub struct KeyVault {
    legacy_root: PathBuf,
    ssh_root: PathBuf,
    generating: Arc<AtomicBool>,
}

impl KeyVault {
    pub fn new(legacy_root: PathBuf, ssh_root: PathBuf) -> Self {
        Self {
            legacy_root,
            ssh_root,
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
                "A local key operation is already running. Wait for it to finish before starting another."
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
fn ssh_private_name(id: &str) -> String {
    format!("{SSH_KEY_PREFIX}{id}")
}

#[cfg(unix)]
fn ssh_public_name(id: &str) -> String {
    format!("{SSH_KEY_PREFIX}{id}.pub")
}

#[cfg(unix)]
fn owned_ssh_id(name: &str) -> Option<String> {
    let rest = name.strip_prefix(SSH_KEY_PREFIX)?;
    if rest.ends_with(".pub") {
        return None;
    }
    canonical_id(rest).ok()
}

#[cfg(unix)]
fn private_digest(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

#[cfg(unix)]
fn trusted_parent_owner(root: &Path) -> Result<u32, String> {
    let parent = root
        .parent()
        .ok_or_else(|| "The local key folder is unavailable.".to_string())?;
    fs::metadata(parent)
        .map(|metadata| metadata.uid())
        .map_err(|_| "The local key folder is unavailable.".to_string())
}

#[cfg(unix)]
fn ensure_legacy_vault(root: &Path) -> Result<u32, String> {
    let owner = trusted_parent_owner(root)?;
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
            Ok(owner)
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
            Ok(owner)
        }
        Err(_) => Err("The local key folder is unavailable.".into()),
    }
}

#[cfg(unix)]
fn validate_ssh_directory(root: &Path) -> Result<u32, String> {
    let owner = trusted_parent_owner(root)?;
    let metadata = fs::symlink_metadata(root)
        .map_err(|_| "The standard SSH folder is unavailable.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err("The standard SSH folder is not a private directory.".into());
    }
    if metadata.uid() != owner {
        return Err(
            "The standard SSH folder belongs to another account. It was not used or changed."
                .into(),
        );
    }
    let mode = metadata.mode() & 0o777;
    if mode & 0o022 != 0 {
        return Err(
            "The standard SSH folder is writable by other users. It was not used or changed."
                .into(),
        );
    }
    if mode & 0o700 != 0o700 {
        return Err(
            "The standard SSH folder does not grant its owner full access. It was not used or changed."
                .into(),
        );
    }
    if metadata.mode() & 0o7000 != 0 {
        return Err(
            "The standard SSH folder has unexpected permissions. It was not used or changed."
                .into(),
        );
    }
    Ok(owner)
}

/// Validate an existing standard SSH directory without changing its mode.
#[cfg(unix)]
fn existing_ssh_owner(root: &Path) -> Result<Option<u32>, String> {
    match fs::symlink_metadata(root) {
        Ok(_) => validate_ssh_directory(root).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("The standard SSH folder is unavailable.".into()),
    }
}

/// Create the standard SSH directory with mode 0700 only for an explicit write
/// action. An existing directory is validated and never silently chmod-ed.
#[cfg(unix)]
fn ensure_ssh_directory(root: &Path) -> Result<u32, String> {
    match fs::symlink_metadata(root) {
        Ok(_) => validate_ssh_directory(root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            match builder.create(root) {
                Ok(()) => {}
                Err(create) if create.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => {
                    return Err("The standard SSH folder could not be created.".into());
                }
            }
            validate_ssh_directory(root)
        }
        Err(_) => Err("The standard SSH folder is unavailable.".into()),
    }
}

#[cfg(unix)]
fn valid_private_mode(mode: u32) -> bool {
    let permissions = mode & 0o777;
    (permissions == 0o400 || permissions == 0o600) && mode & 0o7000 == 0
}

#[cfg(unix)]
fn valid_private_metadata(metadata: &fs::Metadata, owner: u32) -> bool {
    metadata.file_type().is_file()
        && !metadata.file_type().is_symlink()
        && valid_private_mode(metadata.mode())
        && metadata.uid() == owner
        && metadata.nlink() == 1
        && metadata.len() <= MAX_KEY_BYTES as u64
}

#[cfg(unix)]
fn read_private_file(path: &Path, owner: u32) -> Result<(PrivateKey, Zeroizing<Vec<u8>>), String> {
    let before = fs::symlink_metadata(path)
        .map_err(|_| "The stored local key is unreadable.".to_string())?;
    if before.file_type().is_symlink() || !before.file_type().is_file() {
        return Err(
            "The stored local key is not a regular file. It was preserved but is unavailable."
                .into(),
        );
    }
    if !valid_private_mode(before.mode()) {
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
    let file = File::open(path).map_err(|_| "The stored local key is unreadable.".to_string())?;
    let opened = file
        .metadata()
        .map_err(|_| "The stored local key is unreadable.".to_string())?;
    if opened.dev() != before.dev()
        || opened.ino() != before.ino()
        || !valid_private_metadata(&opened, owner)
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
    Ok((key, bytes))
}

#[cfg(unix)]
fn read_public_sidecar(path: &Path, owner: u32) -> Result<PublicKey, String> {
    let before = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "The matching public key file is missing.".to_string()
        } else {
            "The matching public key file is unreadable.".to_string()
        }
    })?;
    if before.file_type().is_symlink() || !before.file_type().is_file() {
        return Err("The matching public key file is not a regular file.".into());
    }
    if before.uid() != owner {
        return Err("The matching public key file belongs to another account.".into());
    }
    if before.mode() & 0o022 != 0 || before.mode() & 0o7000 != 0 {
        return Err("The matching public key file has insecure permissions.".into());
    }
    if before.nlink() != 1 {
        return Err("The matching public key file has unexpected links.".into());
    }
    if before.len() > MAX_PUBLIC_BYTES as u64 {
        return Err("The matching public key file is larger than expected.".into());
    }
    let file =
        File::open(path).map_err(|_| "The matching public key file is unreadable.".to_string())?;
    let opened = file
        .metadata()
        .map_err(|_| "The matching public key file is unreadable.".to_string())?;
    if opened.dev() != before.dev()
        || opened.ino() != before.ino()
        || opened.uid() != owner
        || opened.nlink() != 1
        || opened.len() > MAX_PUBLIC_BYTES as u64
        || opened.mode() & 0o022 != 0
    {
        return Err(
            "The matching public key file changed while it was being read. Try again.".into(),
        );
    }
    let mut bytes = Vec::new();
    file.take(MAX_PUBLIC_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The matching public key file is unreadable.".to_string())?;
    if bytes.len() > MAX_PUBLIC_BYTES {
        return Err("The matching public key file is larger than expected.".into());
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "The matching public key file is not valid text.".to_string())?;
    PublicKey::from_openssh(text)
        .map_err(|_| "The matching public key file could not be decoded.".to_string())
}

#[cfg(unix)]
fn read_legacy_key(
    root: &Path,
    id: &str,
    owner: u32,
) -> Result<(PrivateKey, Zeroizing<Vec<u8>>), String> {
    read_private_file(&root.join(id), owner)
}

#[cfg(unix)]
type SshKeyRead = (PrivateKey, [u8; 32], Option<PathBuf>, Option<String>);

#[cfg(unix)]
fn read_ssh_key(root: &Path, id: &str, owner: u32) -> Result<SshKeyRead, String> {
    let private_path = root.join(ssh_private_name(id));
    let (private, bytes) = read_private_file(&private_path, owner)?;
    let digest = private_digest(bytes.as_slice());
    let expected = private.fingerprint(HashAlg::Sha256).to_string();
    let public_path = root.join(ssh_public_name(id));
    match read_public_sidecar(&public_path, owner) {
        Ok(public) if public.fingerprint(HashAlg::Sha256).to_string() == expected => {
            Ok((private, digest, Some(public_path), None))
        }
        Ok(_) => Ok((
            private,
            digest,
            None,
            Some(
                "The matching public key file does not match the private key. The private key is preserved; the public file was not changed."
                    .into(),
            ),
        )),
        Err(reason) => Ok((
            private,
            digest,
            None,
            Some(format!(
                "{reason} The encrypted private key is preserved."
            )),
        )),
    }
}

#[cfg(unix)]
#[derive(Clone, Debug)]
struct FoundKey {
    key: SetupKey,
    fingerprint: String,
    digest: [u8; 32],
    origin: KeyOrigin,
    from_reference: bool,
}

#[cfg(unix)]
fn found_key(
    key_id: &str,
    private: &PrivateKey,
    digest: [u8; 32],
    path: PathBuf,
    location: KeyLocation,
    origin: KeyOrigin,
) -> FoundKey {
    let fingerprint = private.fingerprint(HashAlg::Sha256).to_string();
    FoundKey {
        key: SetupKey {
            key_id: key_id.to_string(),
            fingerprint: fingerprint.clone(),
            algorithm: private.algorithm().to_string(),
            encrypted: private.is_encrypted(),
            path: path.to_string_lossy().into_owned(),
            location,
        },
        fingerprint,
        digest,
        origin,
        from_reference: false,
    }
}

#[cfg(unix)]
fn scan_legacy(root: &Path) -> (Vec<FoundKey>, Vec<SetupKeyIssue>, bool) {
    let owner = match ensure_legacy_vault(root) {
        Ok(owner) => owner,
        Err(reason) => {
            return (
                Vec::new(),
                vec![SetupKeyIssue {
                    key_id: None,
                    reason: format!("The app vault was not used. {reason}"),
                }],
                false,
            );
        }
    };
    let mut keys = Vec::new();
    let mut issues = Vec::new();
    let mut truncated = false;
    let mut owned = 0usize;
    let Ok(entries) = fs::read_dir(root) else {
        return (
            Vec::new(),
            vec![SetupKeyIssue {
                key_id: None,
                reason: "The app vault folder could not be read. No keys were read from it.".into(),
            }],
            false,
        );
    };
    for (scanned, entry) in entries.enumerate() {
        if scanned >= MAX_LIST_SCAN {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else {
            issues.push(SetupKeyIssue {
                key_id: None,
                reason: "An entry in the app vault could not be read.".into(),
            });
            continue;
        };
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
        owned += 1;
        if owned > MAX_VAULT_ENTRIES {
            truncated = true;
            continue;
        }
        match read_legacy_key(root, &id, owner) {
            Ok((private, bytes)) => {
                keys.push(found_key(
                    &id,
                    &private,
                    private_digest(bytes.as_slice()),
                    root.join(&id),
                    KeyLocation::Legacy,
                    KeyOrigin::Legacy,
                ));
            }
            Err(reason) => issues.push(SetupKeyIssue {
                key_id: Some(id),
                reason,
            }),
        }
    }
    (keys, issues, truncated)
}

#[cfg(unix)]
fn scan_ssh(root: &Path) -> (Vec<FoundKey>, Vec<SetupKeyIssue>, bool) {
    let owner = match existing_ssh_owner(root) {
        Ok(Some(owner)) => owner,
        Ok(None) => return (Vec::new(), Vec::new(), false),
        Err(reason) => {
            return (
                Vec::new(),
                vec![SetupKeyIssue {
                    key_id: None,
                    reason,
                }],
                false,
            );
        }
    };
    let mut keys = Vec::new();
    let mut issues = Vec::new();
    let mut truncated = false;
    let mut owned = 0usize;
    let Ok(entries) = fs::read_dir(root) else {
        return (
            Vec::new(),
            vec![SetupKeyIssue {
                key_id: None,
                reason: "The standard SSH folder could not be read. No keys were read from it."
                    .into(),
            }],
            false,
        );
    };
    for (scanned, entry) in entries.enumerate() {
        if scanned >= MAX_LIST_SCAN {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else {
            issues.push(SetupKeyIssue {
                key_id: None,
                reason: "An entry in the standard SSH folder could not be read.".into(),
            });
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(SSH_KEY_PREFIX) || name.ends_with(".pub") || staging_name(name) {
            continue;
        }
        let Some(id) = owned_ssh_id(name) else {
            continue;
        };
        owned += 1;
        if owned > MAX_VAULT_ENTRIES {
            truncated = true;
            continue;
        }
        match read_ssh_key(root, &id, owner) {
            Ok((private, digest, _, issue)) => {
                keys.push(found_key(
                    &id,
                    &private,
                    digest,
                    root.join(ssh_private_name(&id)),
                    KeyLocation::Ssh,
                    KeyOrigin::Generated,
                ));
                if let Some(reason) = issue {
                    issues.push(SetupKeyIssue {
                        key_id: Some(id),
                        reason,
                    });
                }
            }
            Err(reason) => issues.push(SetupKeyIssue {
                key_id: Some(id),
                reason,
            }),
        }
    }
    (keys, issues, truncated)
}

#[cfg(unix)]
fn scan_references(root: &Path) -> (Vec<FoundKey>, Vec<SetupKeyIssue>, bool) {
    let owner = match existing_ssh_owner(root) {
        Ok(Some(owner)) => owner,
        Ok(None) => return (Vec::new(), Vec::new(), false),
        Err(reason) => {
            return (
                Vec::new(),
                vec![SetupKeyIssue {
                    key_id: None,
                    reason,
                }],
                false,
            )
        }
    };
    let load = match references::load_references(root) {
        Ok(load) => load,
        Err(reason) => {
            return (
                Vec::new(),
                vec![SetupKeyIssue {
                    key_id: None,
                    reason,
                }],
                false,
            )
        }
    };
    let mut keys = Vec::new();
    let mut issues = load.issues;
    for record in load.records {
        let key_id = record.id.clone();
        let kind = record.kind;
        match references::resolve_reference(root, owner, &record) {
            Ok(resolved) => {
                if let Some(reason) = resolved.public_issue {
                    issues.push(SetupKeyIssue {
                        key_id: Some(key_id.clone()),
                        reason,
                    });
                }
                keys.push(FoundKey {
                    key: SetupKey {
                        key_id,
                        fingerprint: resolved.fingerprint.clone(),
                        algorithm: resolved.algorithm,
                        encrypted: resolved.encrypted,
                        path: resolved.path.to_string_lossy().into_owned(),
                        location: resolved.location,
                    },
                    fingerprint: resolved.fingerprint,
                    digest: resolved.digest,
                    origin: match kind {
                        references::ReferenceKind::Generated => KeyOrigin::Generated,
                        references::ReferenceKind::Selected => KeyOrigin::Selected,
                    },
                    from_reference: true,
                });
            }
            Err(reason) => issues.push(SetupKeyIssue {
                key_id: Some(key_id),
                reason,
            }),
        }
    }
    (keys, issues, load.truncated)
}

#[cfg(unix)]
fn merge_keys(
    legacy_keys: Vec<FoundKey>,
    mut issues: Vec<SetupKeyIssue>,
    ssh_keys: Vec<FoundKey>,
    reference_keys: Vec<FoundKey>,
    legacy_root: &Path,
    ssh_root: &Path,
    mut truncated: bool,
) -> SetupKeyList {
    let mut groups: BTreeMap<String, Vec<FoundKey>> = BTreeMap::new();
    for key in legacy_keys
        .into_iter()
        .chain(ssh_keys)
        .chain(reference_keys)
    {
        groups.entry(key.key.key_id.clone()).or_default().push(key);
    }
    let mut keys = Vec::new();
    for (id, mut candidates) in groups {
        if let Some(index) = candidates.iter().position(|key| key.from_reference) {
            let chosen = candidates.remove(index);
            for other in candidates {
                if other.key.path == chosen.key.path
                    || (other.fingerprint == chosen.fingerprint && other.digest == chosen.digest)
                {
                    continue;
                }
                issues.push(SetupKeyIssue {
                    key_id: Some(id.clone()),
                    reason: "The same local key identifier refers to different files or key material. Only the explicit local key reference is shown; other files were not changed."
                        .into(),
                });
            }
            keys.push(chosen);
            continue;
        }
        let mut from_legacy = None;
        let mut from_ssh = None;
        for key in candidates {
            if key.origin == KeyOrigin::Legacy {
                from_legacy = Some(key);
            } else {
                from_ssh = Some(key);
            }
        }
        match (from_legacy, from_ssh) {
            (Some(legacy), Some(standard))
                if legacy.fingerprint == standard.fingerprint
                    && legacy.digest == standard.digest =>
            {
                // A standard copy is preferred only when the identifier,
                // fingerprint, and protected bytes match exactly.
                keys.push(standard);
            }
            (Some(legacy), Some(_)) => {
                keys.push(legacy);
                issues.push(SetupKeyIssue {
                    key_id: Some(id),
                    reason: "The standard SSH folder contains a different key or copy with the same identifier. The preserved app vault key is shown; the conflicting file was not used or changed."
                        .into(),
                });
            }
            (Some(legacy), None) => keys.push(legacy),
            (None, Some(standard)) => keys.push(standard),
            (None, None) => {}
        }
    }
    // Deduplicate aliases that resolve to the exact same native path. Explicit
    // references win over UUID-derived discovery; otherwise the lower key ID is
    // stable across reloads.
    keys.sort_by(|a, b| {
        b.from_reference
            .cmp(&a.from_reference)
            .then_with(|| a.key.key_id.cmp(&b.key.key_id))
    });
    let mut seen_paths = BTreeSet::new();
    let mut deduplicated = Vec::with_capacity(keys.len());
    for key in keys {
        if seen_paths.insert(key.key.path.clone()) {
            deduplicated.push(key.key);
        }
    }
    deduplicated.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    if deduplicated.len() > MAX_VAULT_ENTRIES {
        deduplicated.truncate(MAX_VAULT_ENTRIES);
        truncated = true;
    }
    issues.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    SetupKeyList {
        keys: deduplicated,
        issues,
        storage_path: ssh_root.to_string_lossy().into_owned(),
        legacy_storage_path: legacy_root.to_string_lossy().into_owned(),
        truncated,
    }
}

#[cfg(unix)]
fn list_blocking(legacy_root: &Path, ssh_root: &Path) -> Result<SetupKeyList, String> {
    let (legacy_keys, legacy_issues, legacy_truncated) = scan_legacy(legacy_root);
    let (ssh_keys, ssh_issues, ssh_truncated) = scan_ssh(ssh_root);
    let (reference_keys, reference_issues, reference_truncated) = scan_references(ssh_root);
    let mut issues = legacy_issues;
    issues.extend(ssh_issues);
    issues.extend(reference_issues);
    Ok(merge_keys(
        legacy_keys,
        issues,
        ssh_keys,
        reference_keys,
        legacy_root,
        ssh_root,
        legacy_truncated || ssh_truncated || reference_truncated,
    ))
}

#[cfg(unix)]
fn count_owned_entries(root: &Path, standard_ssh: bool) -> Result<usize, String> {
    let mut count = 0usize;
    for (index, entry) in fs::read_dir(root)
        .map_err(|_| "The local key folder could not be read.".to_string())?
        .enumerate()
    {
        if index >= MAX_LIST_SCAN {
            return Err(
                "The local key folder contains too many entries to count safely. No key was created."
                    .into(),
            );
        }
        let entry = entry.map_err(|_| "The local key folder could not be read.".to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let owned = if standard_ssh {
            owned_ssh_id(name).is_some()
        } else {
            canonical_id(name).is_ok()
        };
        if owned {
            count += 1;
            if count >= MAX_VAULT_ENTRIES {
                break;
            }
        }
    }
    Ok(count)
}

#[cfg(unix)]
#[derive(Debug)]
enum PublishFailure {
    Exists,
    Failed,
}

#[cfg(unix)]
fn publish_bytes_noclobber(
    root: &Path,
    target: &Path,
    bytes: &[u8],
    verify: impl FnOnce(&[u8]) -> Result<(), String>,
) -> Result<(), PublishFailure> {
    let mut temporary = Builder::new()
        .prefix(".vps-pilot-staging-")
        .suffix(".tmp")
        .tempfile_in(root)
        .map_err(|_| PublishFailure::Failed)?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| PublishFailure::Failed)?;
    temporary
        .write_all(bytes)
        .map_err(|_| PublishFailure::Failed)?;
    temporary.flush().map_err(|_| PublishFailure::Failed)?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| PublishFailure::Failed)?;
    let staged = Zeroizing::new(fs::read(temporary.path()).map_err(|_| PublishFailure::Failed)?);
    verify(staged.as_slice()).map_err(|_| PublishFailure::Failed)?;
    temporary.persist_noclobber(target).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            PublishFailure::Exists
        } else {
            PublishFailure::Failed
        }
    })?;
    Ok(())
}

#[cfg(unix)]
fn sync_directory(root: &Path) -> Result<(), String> {
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "The key folder could not be synced.".to_string())
}

#[cfg(unix)]
pub(crate) fn validate_key_name(name: &str) -> Result<(), String> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_KEY_NAME_BYTES {
        return Err("Use a key file name of 1 to 64 ASCII characters.".into());
    }
    if !(bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_') {
        return Err(
            "Start the key file name with a letter, number, or underscore, not a dot or hyphen."
                .into(),
        );
    }
    if !bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
    {
        return Err(
            "Use only ASCII letters, numbers, dots, underscores, or hyphens in the key file name. Paths, spaces, and symbols are not supported."
                .into(),
        );
    }
    if name.to_ascii_lowercase().ends_with(".pub") {
        return Err("Enter the private key file name without the .pub suffix.".into());
    }
    if RESERVED_KEY_NAMES.contains(&name) {
        return Err("That file name is reserved by OpenSSH. Choose a different name.".into());
    }
    if name.starts_with(SSH_KEY_PREFIX) {
        return Err(
            "That file name is reserved for VPS Pilot generated keys. Choose a different name."
                .into(),
        );
    }
    Ok(())
}

#[cfg(unix)]
fn validate_passphrase(passphrase: &[u8]) -> Result<(), String> {
    if passphrase.is_empty() || (12..=4096).contains(&passphrase.len()) {
        Ok(())
    } else {
        Err(
            "Use an empty passphrase for an unencrypted key, or 12 to 4096 bytes for an encrypted key."
                .into(),
        )
    }
}

#[cfg(unix)]
struct GeneratedMaterial {
    pem: Zeroizing<String>,
    public: String,
    fingerprint: String,
    encrypted: bool,
}

#[cfg(unix)]
fn generate_material(passphrase: &[u8]) -> Result<GeneratedMaterial, String> {
    let mut rng = rand::rng();
    let private = PrivateKey::random(&mut rng, Algorithm::Ed25519)
        .map_err(|_| "A local key could not be generated.".to_string())?;
    let encrypted = !passphrase.is_empty();
    let key = if encrypted {
        private
            .encrypt(&mut rng, passphrase)
            .map_err(|_| "The generated key could not be encrypted.".to_string())?
    } else {
        private
    };
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    let public = key
        .public_key()
        .to_openssh()
        .map_err(|_| "The generated public key could not be encoded.".to_string())?;
    let pem = key
        .to_openssh(LineEnding::LF)
        .map_err(|_| "The generated private key could not be encoded.".to_string())?;
    Ok(GeneratedMaterial {
        pem,
        public,
        fingerprint,
        encrypted,
    })
}

#[cfg(unix)]
fn verify_generated_private(
    staged: &[u8],
    fingerprint: &str,
    encrypted: bool,
) -> Result<(), String> {
    let verified = PrivateKey::from_openssh(staged)
        .map_err(|_| "The staged key could not be verified.".to_string())?;
    if verified.is_encrypted() != encrypted
        || verified.algorithm() != Algorithm::Ed25519
        || verified.fingerprint(HashAlg::Sha256).to_string() != fingerprint
    {
        return Err(
            "The staged key did not match the generated key. Nothing was published.".into(),
        );
    }
    Ok(())
}

#[cfg(unix)]
fn publish_generated_public(
    ssh_root: &Path,
    public_target: &Path,
    public: &str,
    fingerprint: &str,
) -> Result<(), String> {
    let expected_fingerprint = fingerprint.to_string();
    let public_bytes = format!("{public}\n");
    publish_bytes_noclobber(
        ssh_root,
        public_target,
        public_bytes.as_bytes(),
        move |staged| {
            let text = std::str::from_utf8(staged)
                .map_err(|_| "The staged public key could not be verified.".to_string())?;
            let parsed = PublicKey::from_openssh(text)
                .map_err(|_| "The staged public key could not be verified.".to_string())?;
            if parsed.fingerprint(HashAlg::Sha256).to_string() != expected_fingerprint {
                return Err(
                    "The staged public key did not match the generated key. Nothing was published."
                        .to_string(),
                );
            }
            Ok(())
        },
    )
    .map_err(|_| "unpublished".to_string())
}

#[cfg(unix)]
fn generate_blocking(
    legacy_root: &Path,
    ssh_root: &Path,
    passphrase: &[u8],
) -> Result<SetupKey, String> {
    validate_passphrase(passphrase)?;
    generate_blocking_with_id(
        legacy_root,
        ssh_root,
        passphrase,
        Uuid::new_v4().to_string(),
    )
}

#[cfg(unix)]
fn generate_blocking_with_id(
    legacy_root: &Path,
    ssh_root: &Path,
    passphrase: &[u8],
    key_id: String,
) -> Result<SetupKey, String> {
    validate_passphrase(passphrase)?;
    let key_id = canonical_id(&key_id)?;
    ensure_ssh_directory(ssh_root)?;
    ensure_legacy_vault(legacy_root)?;
    let owned = count_owned_entries(legacy_root, false)? + count_owned_entries(ssh_root, true)?;
    if owned >= MAX_VAULT_ENTRIES {
        return Err(format!(
            "The local key vault limit of {MAX_VAULT_ENTRIES} entries has been reached."
        ));
    }
    let material = generate_material(passphrase)?;
    let private_target = ssh_root.join(ssh_private_name(&key_id));
    let public_target = ssh_root.join(ssh_public_name(&key_id));
    let expected_fingerprint = material.fingerprint.clone();
    let encrypted = material.encrypted;
    publish_bytes_noclobber(
        ssh_root,
        &private_target,
        material.pem.as_bytes(),
        move |staged| verify_generated_private(staged, &expected_fingerprint, encrypted),
    )
    .map_err(|failure| match failure {
        PublishFailure::Exists => {
            "A local key already uses this identifier. Nothing was overwritten.".to_string()
        }
        PublishFailure::Failed => {
            "The generated key could not be published. Nothing was overwritten.".to_string()
        }
    })?;
    if publish_generated_public(
        ssh_root,
        &public_target,
        &material.public,
        &material.fingerprint,
    )
    .is_err()
    {
        // The private key is already published. Never delete it here; report
        // the preserved/uncertain state and let listing discover it.
        return Err(
            "The key was created, but its matching public key file could not be published. The private key is preserved; reload keys before retrying."
                .into(),
        );
    }
    if sync_directory(ssh_root).is_err() {
        return Err(
            "The key and its public file were created, but the standard SSH folder could not be synced. Reload keys before retrying; the key may already exist."
                .into(),
        );
    }
    Ok(SetupKey {
        key_id,
        fingerprint: material.fingerprint,
        algorithm: "ssh-ed25519".into(),
        encrypted: material.encrypted,
        path: private_target.to_string_lossy().into_owned(),
        location: KeyLocation::Ssh,
    })
}

#[cfg(unix)]
fn ensure_name_available(root: &Path, name: &str) -> Result<(), String> {
    for target in [root.join(name), root.join(format!("{name}.pub"))] {
        match fs::symlink_metadata(&target) {
            Ok(_) => {
                return Err(
                    "A file or folder already uses this key name. Nothing was overwritten.".into(),
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(
                    "The standard SSH folder could not be checked. Nothing was overwritten.".into(),
                )
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn check_name_blocking(ssh_root: &Path, file_name: &str) -> Result<KeyNameCheck, String> {
    if let Err(reason) = validate_key_name(file_name) {
        return Ok(KeyNameCheck {
            file_name: file_name.to_string(),
            available: false,
            message: reason,
        });
    }
    match existing_ssh_owner(ssh_root) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Ok(KeyNameCheck {
                file_name: file_name.to_string(),
                available: true,
                message:
                    "This key name is available. The standard SSH folder will be created when you create the key."
                        .into(),
            })
        }
        Err(reason) => {
            return Ok(KeyNameCheck {
                file_name: file_name.to_string(),
                available: false,
                message: reason,
            })
        }
    }
    for target in [
        ssh_root.join(file_name),
        ssh_root.join(format!("{file_name}.pub")),
    ] {
        match fs::symlink_metadata(&target) {
            Ok(_) => {
                return Ok(KeyNameCheck {
                    file_name: file_name.to_string(),
                    available: false,
                    message:
                        "A file or folder already uses this key name. Choose a different name."
                            .into(),
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Ok(KeyNameCheck {
                    file_name: file_name.to_string(),
                    available: false,
                    message: "The standard SSH folder could not be checked. Try again.".into(),
                })
            }
        }
    }
    Ok(KeyNameCheck {
        file_name: file_name.to_string(),
        available: true,
        message: "This key name is available.".into(),
    })
}

#[cfg(unix)]
fn generate_named_blocking(
    legacy_root: &Path,
    ssh_root: &Path,
    file_name: &str,
    passphrase: &[u8],
) -> Result<SetupKey, String> {
    generate_named_blocking_with(legacy_root, ssh_root, file_name, passphrase, |_| {})
}

#[cfg(unix)]
fn generate_named_blocking_with<F>(
    legacy_root: &Path,
    ssh_root: &Path,
    file_name: &str,
    passphrase: &[u8],
    before_public: F,
) -> Result<SetupKey, String>
where
    F: FnOnce(&Path),
{
    validate_passphrase(passphrase)?;
    validate_key_name(file_name)?;
    ensure_ssh_directory(ssh_root)?;
    ensure_legacy_vault(legacy_root)?;
    references::ensure_reference_dir(ssh_root)?;
    let owned = count_owned_entries(legacy_root, false)?
        + count_owned_entries(ssh_root, true)?
        + references::count_references(ssh_root)?;
    if owned >= MAX_VAULT_ENTRIES {
        return Err(format!(
            "The local key vault limit of {MAX_VAULT_ENTRIES} entries has been reached."
        ));
    }
    ensure_name_available(ssh_root, file_name)?;
    let material = generate_material(passphrase)?;
    let private_target = ssh_root.join(file_name);
    let public_target = ssh_root.join(format!("{file_name}.pub"));
    let digest = references::digest_hex(&private_digest(material.pem.as_bytes()));
    let mut record = None;
    for _ in 0..4 {
        let id = Uuid::new_v4().to_string();
        let candidate = references::KeyReference {
            version: 1,
            id,
            path: private_target.to_string_lossy().into_owned(),
            kind: references::ReferenceKind::Generated,
            fingerprint: material.fingerprint.clone(),
            digest: digest.clone(),
        };
        match references::write_reference(ssh_root, &candidate) {
            Ok(()) => {
                record = Some(candidate);
                break;
            }
            Err(error) if error.contains("already uses this identifier") => continue,
            Err(error) => return Err(error),
        }
    }
    let record = record.ok_or_else(|| {
        "A local key reference could not be published. Nothing was overwritten.".to_string()
    })?;
    if let Err(reason) = ensure_name_available(ssh_root, file_name) {
        references::remove_reference(ssh_root, &record);
        return Err(reason.replace("Nothing was overwritten.", "Nothing else was written."));
    }
    let expected_fingerprint = material.fingerprint.clone();
    let encrypted = material.encrypted;
    if publish_bytes_noclobber(
        ssh_root,
        &private_target,
        material.pem.as_bytes(),
        move |staged| verify_generated_private(staged, &expected_fingerprint, encrypted),
    )
    .is_err()
    {
        references::remove_reference(ssh_root, &record);
        return Err(
            "A file or folder already uses this key name. The private key was not published; nothing was overwritten."
                .into(),
        );
    }
    before_public(&public_target);
    if publish_generated_public(
        ssh_root,
        &public_target,
        &material.public,
        &material.fingerprint,
    )
    .is_err()
    {
        // Keep the private key and its native reference so the partial pair is
        // discoverable. A foreign public file is never overwritten or removed.
        return Err(
            "The private key and its local reference were created, but the matching public key file could not be published because another file may already use its name. The incomplete pair is preserved; verify the standard SSH folder before retrying."
                .into(),
        );
    }
    if sync_directory(ssh_root).is_err() {
        return Err(
            "The key and its public file were created, but the standard SSH folder could not be synced. Reload keys before retrying; the key may already exist."
                .into(),
        );
    }
    Ok(SetupKey {
        key_id: record.id,
        fingerprint: material.fingerprint,
        algorithm: "ssh-ed25519".into(),
        encrypted: material.encrypted,
        path: private_target.to_string_lossy().into_owned(),
        location: KeyLocation::Ssh,
    })
}

#[cfg(unix)]
fn validate_selected_path(path: &Path) -> Result<(), String> {
    let Some(text) = path.to_str() else {
        return Err("The chosen key path is not valid UTF-8 text.".into());
    };
    if text.is_empty() || text.chars().any(char::is_control) || text.contains(['%', '$']) {
        return Err(
            "Choose a private key path without control characters or expansion symbols.".into(),
        );
    }
    Ok(())
}

#[cfg(unix)]
fn read_selected_private_file(path: &Path, owner: u32) -> Result<(PrivateKey, [u8; 32]), String> {
    let before = fs::symlink_metadata(path)
        .map_err(|_| "The chosen private key file is unavailable.".to_string())?;
    if before.file_type().is_symlink() {
        return Err("Choose the private key file itself, not a symbolic link.".into());
    }
    if !before.file_type().is_file() {
        return Err("Choose a regular private key file.".into());
    }
    if before.uid() != owner {
        return Err("The chosen private key belongs to another account.".into());
    }
    if !valid_private_mode(before.mode()) {
        return Err(
            "The chosen private key must be readable only by you (permissions 0400 or 0600). It was not changed."
                .into(),
        );
    }
    if before.nlink() != 1 {
        return Err(
            "The chosen private key has extra hard links. Choose a file with no other links."
                .into(),
        );
    }
    if before.len() > MAX_KEY_BYTES as u64 {
        return Err("The chosen private key is larger than expected.".into());
    }
    let file =
        File::open(path).map_err(|_| "The chosen private key file is unreadable.".to_string())?;
    let opened = file
        .metadata()
        .map_err(|_| "The chosen private key file is unreadable.".to_string())?;
    if opened.dev() != before.dev()
        || opened.ino() != before.ino()
        || !valid_private_metadata(&opened, owner)
    {
        return Err("The chosen private key changed while it was being read. Try again.".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_KEY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The chosen private key file is unreadable.".to_string())?;
    if bytes.len() > MAX_KEY_BYTES {
        return Err("The chosen private key is larger than expected.".into());
    }
    let private = PrivateKey::from_openssh(bytes.as_slice())
        .map_err(|_| "The chosen file is not a supported OpenSSH private key.".to_string())?;
    let digest = private_digest(bytes.as_slice());
    Ok((private, digest))
}

#[cfg(unix)]
fn selected_public_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".pub");
    PathBuf::from(name)
}

#[cfg(unix)]
fn existing_uuid_identity(
    legacy_root: &Path,
    ssh_root: &Path,
    canonical: &Path,
    fingerprint: &str,
    digest: &[u8; 32],
) -> Option<(String, KeyLocation)> {
    let parent = canonical.parent()?;
    let name = canonical.file_name()?.to_str()?;
    // Native fixtures and some macOS homes live below a symlinked ancestor
    // (`/var` vs `/private/var`). The selected file is already canonical, so
    // compare canonical roots before reusing an existing UUID identity. No
    // validation is skipped: the key file is still re-read below.
    let canonical_parent = fs::canonicalize(parent).ok()?;
    let canonical_legacy = fs::canonicalize(legacy_root).ok();
    let canonical_ssh = fs::canonicalize(ssh_root).ok()?;
    let (root, id, location, owner) = if canonical_legacy.as_deref() == Some(&canonical_parent) {
        let owner = fs::metadata(legacy_root).ok()?.uid();
        (
            legacy_root,
            canonical_id(name).ok()?,
            KeyLocation::Legacy,
            owner,
        )
    } else if canonical_parent == canonical_ssh {
        let owner = existing_ssh_owner(ssh_root).ok()??;
        (ssh_root, owned_ssh_id(name)?, KeyLocation::Ssh, owner)
    } else {
        return None;
    };
    let path = if location == KeyLocation::Ssh {
        root.join(ssh_private_name(&id))
    } else {
        root.join(&id)
    };
    let (private, bytes) = read_private_file(&path, owner).ok()?;
    if private.fingerprint(HashAlg::Sha256).to_string() != fingerprint
        || private_digest(bytes.as_slice()) != *digest
    {
        return None;
    }
    Some((id, location))
}

#[cfg(unix)]
fn register_selected_blocking(
    legacy_root: &Path,
    ssh_root: &Path,
    path: &Path,
) -> Result<SetupKey, String> {
    let owner = ensure_ssh_directory(ssh_root)?;
    if !path.is_absolute() {
        return Err("Choose an absolute private key file path.".into());
    }
    let before = fs::symlink_metadata(path)
        .map_err(|_| "The chosen private key file is unavailable.".to_string())?;
    if before.file_type().is_symlink() {
        return Err("Choose the private key file itself, not a symbolic link.".into());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| "The chosen private key file is unavailable.".to_string())?;
    validate_selected_path(&canonical)?;
    let (private, digest) = read_selected_private_file(&canonical, owner)?;
    let fingerprint = private.fingerprint(HashAlg::Sha256).to_string();
    let public_path = selected_public_path(&canonical);
    match fs::symlink_metadata(&public_path) {
        Ok(_) => {
            let public = read_public_sidecar(&public_path, owner)?;
            if public.fingerprint(HashAlg::Sha256).to_string() != fingerprint {
                return Err(
                    "The matching public key file does not match the chosen private key. Nothing was changed."
                        .into(),
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(
                "The matching public key file could not be checked. Nothing was changed.".into(),
            )
        }
    }
    references::ensure_reference_dir(ssh_root)?;
    let load = references::load_references(ssh_root)?;
    let canonical_text = canonical.to_string_lossy().into_owned();
    let digest_text = references::digest_hex(&digest);
    for record in &load.records {
        if record.path == canonical_text
            && record.fingerprint == fingerprint
            && record.digest == digest_text
        {
            return Ok(SetupKey {
                key_id: record.id.clone(),
                fingerprint,
                algorithm: private.algorithm().to_string(),
                encrypted: private.is_encrypted(),
                path: canonical_text,
                location: references::location_for_path(ssh_root, &canonical),
            });
        }
    }
    let algorithm = private.algorithm().to_string();
    let encrypted = private.is_encrypted();
    if let Some(identity) =
        existing_uuid_identity(legacy_root, ssh_root, &canonical, &fingerprint, &digest)
    {
        return Ok(SetupKey {
            key_id: identity.0,
            fingerprint,
            algorithm,
            encrypted,
            path: canonical_text,
            location: identity.1,
        });
    }
    let legacy_count = match fs::symlink_metadata(legacy_root) {
        Ok(_) => count_owned_entries(legacy_root, false)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(_) => return Err("The local key folder is unavailable.".into()),
    };
    let owned = legacy_count
        + count_owned_entries(ssh_root, true)?
        + references::count_references(ssh_root)?;
    if owned >= MAX_VAULT_ENTRIES {
        return Err(format!(
            "The local key vault limit of {MAX_VAULT_ENTRIES} entries has been reached."
        ));
    }
    let mut saved = None;
    for _ in 0..4 {
        let id = Uuid::new_v4().to_string();
        let candidate = references::KeyReference {
            version: 1,
            id,
            path: canonical_text.clone(),
            kind: references::ReferenceKind::Selected,
            fingerprint: fingerprint.clone(),
            digest: digest_text.clone(),
        };
        match references::write_reference(ssh_root, &candidate) {
            Ok(()) => {
                saved = Some(candidate);
                break;
            }
            Err(error) if error.contains("already uses this identifier") => continue,
            Err(error) => return Err(error),
        }
    }
    let record = saved.ok_or_else(|| {
        "A local key reference could not be published. Nothing was changed.".to_string()
    })?;
    Ok(SetupKey {
        key_id: record.id,
        fingerprint,
        algorithm: private.algorithm().to_string(),
        encrypted: private.is_encrypted(),
        path: canonical_text,
        location: references::location_for_path(ssh_root, &canonical),
    })
}

#[cfg(unix)]
fn read_target_private(
    path: &Path,
    owner: u32,
    conflict: &str,
) -> Result<(String, [u8; 32]), String> {
    let (private, bytes) = read_private_file(path, owner).map_err(|_| conflict.to_string())?;
    Ok((
        private.fingerprint(HashAlg::Sha256).to_string(),
        private_digest(bytes.as_slice()),
    ))
}

#[cfg(unix)]
fn copy_legacy_to_ssh_blocking(
    legacy_root: &Path,
    ssh_root: &Path,
    key_id: &str,
) -> Result<CopyResult, String> {
    let id = canonical_id(key_id)?;
    let ssh_owner = ensure_ssh_directory(ssh_root)?;
    let legacy_owner = ensure_legacy_vault(legacy_root)?;
    let legacy_path = legacy_root.join(&id);
    let ssh_private_path = ssh_root.join(ssh_private_name(&id));
    let ssh_public_path = ssh_root.join(ssh_public_name(&id));

    let source = match fs::symlink_metadata(&legacy_path) {
        Ok(_) => {
            let (private, bytes) = read_private_file(&legacy_path, legacy_owner)?;
            let fingerprint = private.fingerprint(HashAlg::Sha256).to_string();
            let digest = private_digest(bytes.as_slice());
            let public = private
                .public_key()
                .to_openssh()
                .map_err(|_| "The app vault public key could not be encoded.".to_string())?;
            Some((
                fingerprint,
                digest,
                bytes,
                public,
                private.algorithm().to_string(),
                private.is_encrypted(),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => {
            return Err(
                "The app vault key is unreadable. It was preserved and was not changed.".into(),
            );
        }
    };

    let target_private_exists = match fs::symlink_metadata(&ssh_private_path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => {
            return Err("The standard SSH folder key could not be checked.".into());
        }
    };
    let (target_fingerprint, target_digest) = if target_private_exists {
        read_target_private(
            &ssh_private_path,
            ssh_owner,
            "A file already uses this key name in the standard SSH folder and is not a valid local key. Nothing was overwritten.",
        )?
    } else if let Some((fingerprint, digest, _, _, _, _)) = &source {
        (fingerprint.clone(), *digest)
    } else {
        return Err("The selected local key is unavailable in the app vault.".into());
    };

    if let Some((fingerprint, digest, _, _, _, _)) = &source {
        if target_fingerprint != *fingerprint {
            return Err(
                "A different key already uses this identifier in the standard SSH folder. Nothing was overwritten."
                    .into(),
            );
        }
        if target_private_exists && target_digest != *digest {
            return Err(
                "A different copy of this key already exists in the standard SSH folder. The saved key reference was not switched; nothing was overwritten."
                    .into(),
            );
        }
    }

    let expected_public = match &source {
        Some((_, _, _, public, _, _)) => public.clone(),
        None => {
            let (private, _) = read_private_file(&ssh_private_path, ssh_owner)?;
            private
                .public_key()
                .to_openssh()
                .map_err(|_| "The standard SSH public key could not be encoded.".to_string())?
        }
    };
    let (target_algorithm, target_encrypted) = match &source {
        Some((_, _, _, _, algorithm, encrypted)) => (algorithm.clone(), *encrypted),
        None => {
            let (private, _) = read_private_file(&ssh_private_path, ssh_owner)?;
            (private.algorithm().to_string(), private.is_encrypted())
        }
    };

    // Validate an existing public sidecar before publishing anything so a
    // conflicting .pub cannot leave a partially migrated pair.
    let public_exists = match fs::symlink_metadata(&ssh_public_path) {
        Ok(_) => {
            let public = read_public_sidecar(&ssh_public_path, ssh_owner)
                .map_err(|reason| format!("{reason} Nothing was overwritten."))?;
            if public.fingerprint(HashAlg::Sha256).to_string() != target_fingerprint {
                return Err(
                    "The existing public key file does not match this key. Nothing was overwritten."
                        .into(),
                );
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => {
            return Err(
                "The standard SSH public key file could not be checked. Nothing was overwritten."
                    .into(),
            );
        }
    };

    let mut wrote = false;
    if !target_private_exists {
        let Some((fingerprint, digest, bytes, _, _, _)) = &source else {
            return Err("The selected local key is unavailable in the app vault.".into());
        };
        match publish_bytes_noclobber(ssh_root, &ssh_private_path, bytes.as_slice(), |staged| {
            let verified = PrivateKey::from_openssh(staged).map_err(|_| {
                "The staged key could not be verified. Nothing was published.".to_string()
            })?;
            if verified.fingerprint(HashAlg::Sha256).to_string() != *fingerprint
                || private_digest(staged) != *digest
            {
                return Err(
                    "The staged key did not match the app vault key. Nothing was published.".into(),
                );
            }
            Ok(())
        }) {
            Ok(()) => wrote = true,
            Err(PublishFailure::Exists) => {
                let (raced_fingerprint, raced_digest) = read_target_private(
                    &ssh_private_path,
                    ssh_owner,
                    "A file already uses this key name in the standard SSH folder and is not a valid local key. Nothing was overwritten.",
                )?;
                if raced_fingerprint != *fingerprint {
                    return Err(
                        "A different key already uses this identifier in the standard SSH folder. Nothing was overwritten."
                            .into(),
                    );
                }
                if raced_digest != *digest {
                    return Err(
                        "A different copy of this key already exists in the standard SSH folder. The saved key reference was not switched; nothing was overwritten."
                            .into(),
                    );
                }
            }
            Err(PublishFailure::Failed) => {
                return Err("The key could not be copied. Nothing was overwritten.".into());
            }
        }
    }

    if !public_exists {
        let expected_fingerprint = target_fingerprint.clone();
        let public_bytes = format!("{expected_public}\n");
        match publish_bytes_noclobber(
            ssh_root,
            &ssh_public_path,
            public_bytes.as_bytes(),
            move |staged| {
                let text = std::str::from_utf8(staged)
                    .map_err(|_| "The staged public key could not be verified.".to_string())?;
                let parsed = PublicKey::from_openssh(text)
                    .map_err(|_| "The staged public key could not be verified.".to_string())?;
                if parsed.fingerprint(HashAlg::Sha256).to_string() != expected_fingerprint {
                    return Err(
                        "The staged public key did not match the key. Nothing was published."
                            .into(),
                    );
                }
                Ok(())
            },
        ) {
            Ok(()) => wrote = true,
            Err(PublishFailure::Exists) => {
                let public = read_public_sidecar(&ssh_public_path, ssh_owner)
                    .map_err(|reason| format!("{reason} Nothing else was overwritten."))?;
                if public.fingerprint(HashAlg::Sha256).to_string() != target_fingerprint {
                    return Err(
                        "The key is preserved, but the existing public key file does not match. Nothing else was overwritten."
                            .into(),
                    );
                }
            }
            Err(PublishFailure::Failed) => {
                return Err(
                    "The key is preserved, but its matching public key file could not be written. Reload keys; nothing else was overwritten."
                        .into(),
                );
            }
        }
    }

    if sync_directory(ssh_root).is_err() {
        return Err(
            "The key was copied, but the standard SSH folder could not be synced. Reload keys; the copy may already exist."
                .into(),
        );
    }
    Ok(CopyResult {
        status: if wrote { "copied" } else { "already" },
        key: SetupKey {
            key_id: id,
            fingerprint: target_fingerprint,
            algorithm: target_algorithm,
            encrypted: target_encrypted,
            path: ssh_private_path.to_string_lossy().into_owned(),
            location: KeyLocation::Ssh,
        },
    })
}

/// Validate the standard SSH directory without changing its mode. Used by the
/// trusted local-config adapter before any read or write.
#[cfg(unix)]
pub(crate) fn validate_standard_root(root: &Path) -> Result<u32, String> {
    validate_ssh_directory(root)
}

#[cfg(unix)]
fn resolve_legacy(root: &Path, id: &str) -> Result<Option<ResolvedKeyMetadata>, String> {
    match fs::symlink_metadata(root) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("The local key folder is unavailable.".into()),
    }
    let owner = ensure_legacy_vault(root)?;
    let path = root.join(id);
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            let (private, bytes) = read_private_file(&path, owner)?;
            Ok(Some(ResolvedKeyMetadata {
                path,
                fingerprint: private.fingerprint(HashAlg::Sha256).to_string(),
                digest: private_digest(bytes.as_slice()),
                location: KeyLocation::Legacy,
                algorithm: private.algorithm().to_string(),
                encrypted: private.is_encrypted(),
                origin: KeyOrigin::Legacy,
                public_path: None,
                public_issue: None,
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("The stored local key is unreadable.".into()),
    }
}

#[cfg(unix)]
fn resolve_ssh(root: &Path, id: &str) -> Result<Option<ResolvedKeyMetadata>, String> {
    let Some(owner) = existing_ssh_owner(root)? else {
        return Ok(None);
    };
    let path = root.join(ssh_private_name(id));
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            let (private, digest, public_path, public_issue) = read_ssh_key(root, id, owner)?;
            Ok(Some(ResolvedKeyMetadata {
                path,
                fingerprint: private.fingerprint(HashAlg::Sha256).to_string(),
                digest,
                location: KeyLocation::Ssh,
                algorithm: private.algorithm().to_string(),
                encrypted: private.is_encrypted(),
                origin: KeyOrigin::Generated,
                public_path,
                public_issue,
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("The stored local key is unreadable.".into()),
    }
}

#[cfg(unix)]
fn resolve_reference_metadata(
    ssh_root: &Path,
    id: &str,
) -> Result<Option<ResolvedKeyMetadata>, String> {
    let Some(owner) = existing_ssh_owner(ssh_root)? else {
        return Ok(None);
    };
    let load = references::load_references(ssh_root)?;
    if let Some(issue) = load
        .issues
        .iter()
        .find(|issue| issue.key_id.as_deref() == Some(id))
    {
        return Err(format!(
            "The saved local key reference is invalid. {} It was not used or changed.",
            issue.reason
        ));
    }
    let Some(record) = load.records.iter().find(|record| record.id == id) else {
        return Ok(None);
    };
    let resolved = references::resolve_reference(ssh_root, owner, record).map_err(|reason| {
        format!("The saved local key reference could not be resolved. {reason}")
    })?;
    Ok(Some(ResolvedKeyMetadata {
        path: resolved.path,
        fingerprint: resolved.fingerprint,
        digest: resolved.digest,
        location: resolved.location,
        algorithm: resolved.algorithm,
        encrypted: resolved.encrypted,
        origin: match record.kind {
            references::ReferenceKind::Generated => KeyOrigin::Generated,
            references::ReferenceKind::Selected => KeyOrigin::Selected,
        },
        public_path: resolved.public_path,
        public_issue: resolved.public_issue,
    }))
}

#[cfg(unix)]
fn resolve_metadata_blocking(
    legacy_root: &Path,
    ssh_root: &Path,
    key_id: &str,
) -> Result<ResolvedKeyMetadata, String> {
    let id = canonical_id(key_id)?;
    if let Some(from_reference) = resolve_reference_metadata(ssh_root, &id)? {
        let legacy = resolve_legacy(legacy_root, &id)?;
        let standard = resolve_ssh(ssh_root, &id)?;
        for other in [legacy, standard].into_iter().flatten() {
            if other.path != from_reference.path
                && (other.fingerprint != from_reference.fingerprint
                    || other.digest != from_reference.digest)
            {
                return Err(
                    "The selected identifier refers to conflicting local key material. It was not resolved; choose another key."
                        .into(),
                );
            }
        }
        return Ok(from_reference);
    }
    let legacy = resolve_legacy(legacy_root, &id)?;
    let standard = resolve_ssh(ssh_root, &id)?;
    match (legacy, standard) {
        (Some(from_legacy), Some(from_ssh)) => {
            if from_legacy.fingerprint != from_ssh.fingerprint
                || from_legacy.digest != from_ssh.digest
            {
                return Err(
                    "The selected identifier exists in both the app vault and the standard SSH folder with different key material or encrypted copies. It was not resolved; choose a non-conflicting key."
                        .into(),
                );
            }
            Ok(from_ssh)
        }
        (Some(from_legacy), None) => Ok(from_legacy),
        (None, Some(from_ssh)) => Ok(from_ssh),
        (None, None) => Err(
            "The selected local key is unavailable in the app vault or the standard SSH folder."
                .into(),
        ),
    }
}

#[cfg(unix)]
fn path_owner(path: &Path) -> Result<u32, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The local key folder is unavailable.".to_string())?;
    fs::metadata(parent)
        .map(|metadata| metadata.uid())
        .map_err(|_| "The local key folder is unavailable.".to_string())
}

#[cfg(unix)]
fn export_to_blocking(
    legacy_root: &Path,
    ssh_root: &Path,
    key_id: &str,
    destination: &Path,
) -> Result<(), String> {
    let resolved = resolve_metadata_blocking(legacy_root, ssh_root, key_id)?;
    let (private, bytes) = read_private_file(&resolved.path, path_owner(&resolved.path)?)?;
    if private.fingerprint(HashAlg::Sha256).to_string() != resolved.fingerprint
        || private_digest(bytes.as_slice()) != resolved.digest
    {
        return Err("The stored local key changed while it was being read. Try again.".into());
    }
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
        .map_err(|_| "The key backup could not be staged.".to_string())?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "The key backup could not be protected.".to_string())?;
    temporary
        .write_all(bytes.as_slice())
        .map_err(|_| "The key backup could not be written.".to_string())?;
    temporary
        .flush()
        .map_err(|_| "The key backup could not be written.".to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "The key backup could not be saved.".to_string())?;
    let staged_len = temporary
        .as_file()
        .metadata()
        .map_err(|_| "The staged key backup could not be verified.".to_string())?
        .len();
    if staged_len != bytes.len() as u64 {
        return Err("The staged key backup did not match. Nothing was published.".into());
    }
    temporary.persist_noclobber(destination).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            "A file already exists at the chosen backup destination. Nothing was overwritten."
                .to_string()
        } else {
            "The key backup could not be published. Nothing was overwritten.".to_string()
        }
    })?;
    // The published copy is kept if this directory sync fails; report
    // uncertainty rather than deleting someone else's destination path.
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| {
            "The key backup was written, but its folder could not be synced. Verify the backup before relying on it."
                .to_string()
        })?;
    Ok(())
}

#[cfg(unix)]
impl KeyVault {
    pub async fn list_async(&self) -> Result<SetupKeyList, String> {
        let legacy = self.legacy_root.clone();
        let ssh = self.ssh_root.clone();
        tauri::async_runtime::spawn_blocking(move || list_blocking(&legacy, &ssh))
            .await
            .map_err(|_| "The local key vault could not be read.".to_string())?
    }

    async fn run_generation<F>(&self, passphrase: String, work: F) -> Result<SetupKey, String>
    where
        F: FnOnce(&Path, &Path, &[u8]) -> Result<SetupKey, String> + Send + 'static,
    {
        // Zeroize rejected input too, then bound it before the gate or worker.
        let passphrase = Zeroizing::new(passphrase);
        validate_passphrase(passphrase.as_bytes())?;
        let guard = self.begin_generation()?;
        let legacy = self.legacy_root.clone();
        let ssh = self.ssh_root.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // The worker owns the gate. If the caller future is dropped or
            // aborted, the gate stays closed until this closure returns.
            let _guard = guard;
            work(&legacy, &ssh, passphrase.as_bytes())
        })
        .await
        .map_err(|_| "The local key generation task could not complete.".to_string())?
    }

    pub async fn generate_async(&self, passphrase: String) -> Result<SetupKey, String> {
        self.run_generation(passphrase, generate_blocking).await
    }

    /// Generate a key with an explicit standard-directory file name. The name
    /// is rechecked inside the worker immediately before publishing so a UI-only
    /// availability result can never overwrite a racing foreign file.
    pub async fn generate_named_async(
        &self,
        file_name: String,
        passphrase: String,
    ) -> Result<SetupKey, String> {
        let passphrase = Zeroizing::new(passphrase);
        validate_passphrase(passphrase.as_bytes())?;
        validate_key_name(&file_name)?;
        let guard = self.begin_generation()?;
        let legacy = self.legacy_root.clone();
        let ssh = self.ssh_root.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            generate_named_blocking(&legacy, &ssh, &file_name, passphrase.as_bytes())
        })
        .await
        .map_err(|_| "The local key generation task could not complete.".to_string())?
    }

    pub async fn check_name_async(&self, file_name: &str) -> Result<KeyNameCheck, String> {
        let ssh = self.ssh_root.clone();
        let file_name = file_name.to_string();
        tauri::async_runtime::spawn_blocking(move || check_name_blocking(&ssh, &file_name))
            .await
            .map_err(|_| "The local key name check could not complete.".to_string())?
    }

    /// Register a user-chosen existing private key without changing it. This is
    /// intentionally not a command: the only public entry point is the native
    /// open dialog, so no renderer-supplied path reaches it.
    pub(crate) async fn register_selected_async(&self, path: PathBuf) -> Result<SetupKey, String> {
        let guard = self.begin_generation()?;
        let legacy = self.legacy_root.clone();
        let ssh = self.ssh_root.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            register_selected_blocking(&legacy, &ssh, &path)
        })
        .await
        .map_err(|_| "The local key selection task could not complete.".to_string())?
    }

    pub async fn copy_async(&self, key_id: &str) -> Result<CopyResult, String> {
        let guard = self.begin_generation()?;
        let legacy = self.legacy_root.clone();
        let ssh = self.ssh_root.clone();
        let key_id = key_id.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            copy_legacy_to_ssh_blocking(&legacy, &ssh, &key_id)
        })
        .await
        .map_err(|_| "The local key copy task could not complete.".to_string())?
    }

    #[allow(dead_code)]
    pub async fn validate_async(&self, key_id: &str) -> Result<(), String> {
        self.resolve_metadata_async(key_id).await.map(|_| ())
    }

    /// Resolve protected key metadata on the blocking pool. The returned
    /// encrypted digest binds later connection/configuration work to the exact
    /// bytes that were validated; private-key contents never leave the vault.
    pub async fn resolve_metadata_async(
        &self,
        key_id: &str,
    ) -> Result<ResolvedKeyMetadata, String> {
        let legacy = self.legacy_root.clone();
        let ssh = self.ssh_root.clone();
        let key_id = key_id.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            resolve_metadata_blocking(&legacy, &ssh, &key_id)
        })
        .await
        .map_err(|_| "The local key reference could not be resolved.".to_string())?
    }

    /// Resolve an opaque key ID to the validated native path and native origin
    /// for the later reviewed config export. Renderer-provided paths are never
    /// accepted by this accessor.
    pub(crate) async fn resolve_config_key_async(
        &self,
        key_id: &str,
    ) -> Result<ResolvedConfigKey, String> {
        let id = canonical_id(key_id)?;
        let metadata = self.resolve_metadata_async(key_id).await?;
        if let Some(reason) = metadata.public_issue {
            return Err(format!(
                "The selected local key cannot be used for a reviewed SSH config entry. {reason}"
            ));
        }
        if metadata.origin == KeyOrigin::Generated && metadata.public_path.is_none() {
            return Err(
                "The matching public key file is missing. Generated key pairs require it for a reviewed SSH config entry."
                    .into(),
            );
        }
        Ok(ResolvedConfigKey {
            key_id: id,
            path: metadata.path.to_string_lossy().into_owned(),
            public_path: metadata
                .public_path
                .map(|path| path.to_string_lossy().into_owned()),
            fingerprint: metadata.fingerprint,
            digest: metadata.digest,
            algorithm: metadata.algorithm,
            encrypted: metadata.encrypted,
            location: metadata.location,
            origin: metadata.origin,
        })
    }

    pub(crate) fn standard_ssh_root(&self) -> &Path {
        &self.ssh_root
    }

    pub async fn export_async(&self, key_id: &str, destination: PathBuf) -> Result<(), String> {
        let legacy = self.legacy_root.clone();
        let ssh = self.ssh_root.clone();
        let key_id = key_id.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            export_to_blocking(&legacy, &ssh, &key_id, &destination)
        })
        .await
        .map_err(|_| "The key backup task could not complete.".to_string())?
    }

    /// Trusted, validated reference for tests. It never returns private-key
    /// bytes and is intentionally not exposed to the renderer as a command.
    #[cfg(test)]
    pub(crate) fn resolve_metadata(&self, key_id: &str) -> Result<ResolvedKeyMetadata, String> {
        resolve_metadata_blocking(&self.legacy_root, &self.ssh_root, key_id)
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

    pub async fn generate_named_async(
        &self,
        _file_name: String,
        passphrase: String,
    ) -> Result<SetupKey, String> {
        let _passphrase = Zeroizing::new(passphrase);
        Err(UNAVAILABLE.into())
    }

    pub async fn check_name_async(&self, _file_name: &str) -> Result<KeyNameCheck, String> {
        Err(UNAVAILABLE.into())
    }

    pub(crate) async fn register_selected_async(&self, _path: PathBuf) -> Result<SetupKey, String> {
        Err(UNAVAILABLE.into())
    }

    pub async fn copy_async(&self, _key_id: &str) -> Result<CopyResult, String> {
        Err(UNAVAILABLE.into())
    }

    pub async fn validate_async(&self, _key_id: &str) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    pub async fn resolve_metadata_async(
        &self,
        _key_id: &str,
    ) -> Result<ResolvedKeyMetadata, String> {
        Err(UNAVAILABLE.into())
    }

    pub(crate) async fn resolve_config_key_async(
        &self,
        _key_id: &str,
    ) -> Result<ResolvedConfigKey, String> {
        Err(UNAVAILABLE.into())
    }

    pub(crate) fn standard_ssh_root(&self) -> &std::path::Path {
        &self.ssh_root
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
    file_name: Option<String>,
) -> Result<SetupKey, String> {
    match file_name {
        Some(file_name) => vault.generate_named_async(file_name, passphrase).await,
        None => vault.generate_async(passphrase).await,
    }
}

#[tauri::command]
pub async fn app_setup_key_check_name(
    vault: tauri::State<'_, KeyVault>,
    file_name: String,
) -> Result<KeyNameCheck, String> {
    vault.check_name_async(&file_name).await
}

#[cfg(unix)]
#[tauri::command]
pub async fn app_setup_key_select(
    app: tauri::AppHandle,
    vault: tauri::State<'_, KeyVault>,
) -> Result<SelectResult, String> {
    let default_directory = vault.standard_ssh_root().to_path_buf();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Choose an existing SSH private key");
        if default_directory.is_dir() {
            dialog = dialog.set_directory(default_directory);
        }
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|_| "The local key file dialog was unavailable.".to_string())?;
    let Some(selected) = selected else {
        return Ok(SelectResult {
            status: "canceled",
            key: None,
        });
    };
    let path = selected
        .into_path()
        .map_err(|_| "Choose a local private key file.".to_string())?;
    let key = vault.register_selected_async(path).await?;
    Ok(SelectResult {
        status: "selected",
        key: Some(key),
    })
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn app_setup_key_select(
    app: tauri::AppHandle,
    vault: tauri::State<'_, KeyVault>,
) -> Result<SelectResult, String> {
    let _ = (app, vault);
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn app_setup_key_use_ssh_directory(
    vault: tauri::State<'_, KeyVault>,
    key_id: String,
) -> Result<CopyResult, String> {
    vault.copy_async(&key_id).await
}

#[cfg(unix)]
#[tauri::command]
pub async fn app_setup_key_export(
    app: tauri::AppHandle,
    vault: tauri::State<'_, KeyVault>,
    key_id: String,
) -> Result<ExportResult, String> {
    let metadata = vault.resolve_metadata_async(&key_id).await?;
    let encrypted = metadata.encrypted;
    let suggested = format!("vps-pilot-{}.key", key_id.get(..8).unwrap_or("local-key"));
    let title = if encrypted {
        "Back up encrypted SSH key"
    } else {
        "Back up unencrypted SSH key"
    };
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(title)
            .set_file_name(suggested)
            .blocking_save_file()
    })
    .await
    .map_err(|_| "The backup destination dialog was unavailable.".to_string())?;
    let Some(selected) = selected else {
        return Ok(ExportResult {
            status: "canceled",
            path: None,
            encrypted,
        });
    };
    let destination = selected
        .into_path()
        .map_err(|_| "Choose a local backup destination.".to_string())?;
    vault.export_async(&key_id, destination.clone()).await?;
    Ok(ExportResult {
        status: "exported",
        path: Some(destination.to_string_lossy().into_owned()),
        encrypted,
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

    struct Fixture {
        vault: KeyVault,
        home: PathBuf,
    }

    impl Fixture {
        fn new(dir: &tempfile::TempDir) -> Self {
            let home = dir.path().join("home");
            fs::create_dir_all(&home).unwrap();
            let vault = KeyVault::new(dir.path().join("setup-keys"), home.join(".ssh"));
            Self { vault, home }
        }

        fn ssh(&self) -> PathBuf {
            self.home.join(".ssh")
        }

        fn legacy(&self) -> PathBuf {
            self.vault.legacy_root.clone()
        }
    }

    fn passphrase() -> &'static [u8] {
        b"correct horse battery staple"
    }

    fn write_legacy_key(root: &Path, passphrase: &[u8]) -> (String, String) {
        ensure_legacy_vault(root).unwrap();
        let private = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let encrypted = private.encrypt(&mut rand::rng(), passphrase).unwrap();
        let pem = encrypted.to_openssh(LineEnding::LF).unwrap();
        let id = Uuid::new_v4().to_string();
        let path = root.join(&id);
        fs::write(&path, pem.as_bytes()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        (id, encrypted.fingerprint(HashAlg::Sha256).to_string())
    }

    #[test]
    fn generates_a_real_encrypted_ed25519_key_with_a_matching_public_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let key = generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).unwrap();
        assert_eq!(key.algorithm, "ssh-ed25519");
        assert!(key.encrypted);
        assert!(key.fingerprint.starts_with("SHA256:"));
        assert_eq!(key.location, KeyLocation::Ssh);
        assert_eq!(
            PathBuf::from(&key.path)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
            ssh_private_name(&key.key_id)
        );
        let metadata = fs::metadata(&key.path).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o600);
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(fs::metadata(fixture.ssh()).unwrap().mode() & 0o777, 0o700);
        let pem = fs::read_to_string(&key.path).unwrap();
        assert!(!pem.contains(std::str::from_utf8(passphrase()).unwrap()));
        let parsed = PrivateKey::from_openssh(pem.as_bytes()).unwrap();
        assert!(parsed.is_encrypted());
        let decrypted = parsed.decrypt(passphrase()).unwrap();
        assert_eq!(
            decrypted
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
            key.fingerprint
        );
        assert!(parsed.decrypt(b"definitely not the passphrase").is_err());

        let public_path = fixture.ssh().join(ssh_public_name(&key.key_id));
        let public_text = fs::read_to_string(&public_path).unwrap();
        let public = PublicKey::from_openssh(&public_text).unwrap();
        assert_eq!(
            public.fingerprint(HashAlg::Sha256).to_string(),
            key.fingerprint
        );
        assert_eq!(fs::metadata(&public_path).unwrap().mode() & 0o777, 0o600);
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert_eq!(listed.keys[0].location, KeyLocation::Ssh);
        assert!(listed.issues.is_empty());
        assert_eq!(listed.storage_path, fixture.ssh().to_string_lossy());
    }

    #[test]
    fn listing_recovers_standard_keys_after_restart_without_an_index() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let first = generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).unwrap();
        let second = generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).unwrap();
        let restart = KeyVault::new(fixture.legacy(), fixture.ssh());
        let listed = list_blocking(&restart.legacy_root, &restart.ssh_root).unwrap();
        assert_eq!(listed.keys.len(), 2);
        assert!(listed.issues.is_empty());
        assert!(listed
            .keys
            .iter()
            .all(|key| key.location == KeyLocation::Ssh));
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
    fn legacy_keys_remain_listable_and_resolvable_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let (id, fingerprint) = write_legacy_key(&fixture.legacy(), passphrase());
        let restart = KeyVault::new(fixture.legacy(), fixture.ssh());
        let listed = list_blocking(&restart.legacy_root, &restart.ssh_root).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert_eq!(listed.keys[0].key_id, id);
        assert_eq!(listed.keys[0].fingerprint, fingerprint);
        assert_eq!(listed.keys[0].location, KeyLocation::Legacy);
        let resolved = restart.resolve_metadata(&id).unwrap();
        assert_eq!(resolved.path, fixture.legacy().join(&id));
        assert_eq!(resolved.fingerprint, fingerprint);
    }

    #[test]
    fn explicit_copy_preserves_the_legacy_key_and_identifier() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let (id, fingerprint) = write_legacy_key(&fixture.legacy(), passphrase());
        let original = fs::read(fixture.legacy().join(&id)).unwrap();
        let copied = copy_legacy_to_ssh_blocking(&fixture.legacy(), &fixture.ssh(), &id).unwrap();
        assert_eq!(copied.status, "copied");
        assert_eq!(copied.key.key_id, id);
        assert_eq!(copied.key.fingerprint, fingerprint);
        assert_eq!(copied.key.location, KeyLocation::Ssh);
        assert_eq!(fs::read(fixture.legacy().join(&id)).unwrap(), original);
        let copied_bytes = fs::read(fixture.ssh().join(ssh_private_name(&id))).unwrap();
        assert_eq!(copied_bytes, original);
        let public_text = fs::read_to_string(fixture.ssh().join(ssh_public_name(&id))).unwrap();
        let public = PublicKey::from_openssh(&public_text).unwrap();
        assert_eq!(public.fingerprint(HashAlg::Sha256).to_string(), fingerprint);
        assert_eq!(
            fs::read(fixture.legacy().join(&id)).unwrap(),
            original,
            "the source must never be deleted or changed"
        );

        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert_eq!(listed.keys[0].location, KeyLocation::Ssh);
        assert!(listed.issues.is_empty());
        let resolved = resolve_metadata_blocking(&fixture.legacy(), &fixture.ssh(), &id).unwrap();
        assert_eq!(resolved.path, fixture.ssh().join(ssh_private_name(&id)));
        assert_eq!(resolved.fingerprint, fingerprint);

        let target = fs::read(fixture.ssh().join(ssh_private_name(&id))).unwrap();
        let public_before = fs::read(fixture.ssh().join(ssh_public_name(&id))).unwrap();
        let again = copy_legacy_to_ssh_blocking(&fixture.legacy(), &fixture.ssh(), &id).unwrap();
        assert_eq!(again.status, "already");
        assert_eq!(
            fs::read(fixture.ssh().join(ssh_private_name(&id))).unwrap(),
            target
        );
        assert_eq!(
            fs::read(fixture.ssh().join(ssh_public_name(&id))).unwrap(),
            public_before
        );
        assert_eq!(fs::read(fixture.legacy().join(&id)).unwrap(), original);
    }

    #[test]
    fn copy_refuses_conflicting_or_corrupted_targets_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let (id, _) = write_legacy_key(&fixture.legacy(), passphrase());
        ensure_ssh_directory(&fixture.ssh()).unwrap();

        let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
            .unwrap()
            .encrypt(&mut rand::rng(), passphrase())
            .unwrap();
        let other_pem = other.to_openssh(LineEnding::LF).unwrap();
        let target = fixture.ssh().join(ssh_private_name(&id));
        fs::write(&target, other_pem.as_bytes()).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let target_before = fs::read(&target).unwrap();
        let legacy_before = fs::read(fixture.legacy().join(&id)).unwrap();
        let error =
            copy_legacy_to_ssh_blocking(&fixture.legacy(), &fixture.ssh(), &id).unwrap_err();
        assert!(error.contains("different key"), "{error}");
        assert_eq!(fs::read(&target).unwrap(), target_before);
        assert_eq!(fs::read(fixture.legacy().join(&id)).unwrap(), legacy_before);
        assert!(!fixture.ssh().join(ssh_public_name(&id)).exists());

        fs::write(&target, b"not a private key").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let error =
            copy_legacy_to_ssh_blocking(&fixture.legacy(), &fixture.ssh(), &id).unwrap_err();
        assert!(error.contains("not a valid local key"), "{error}");
        assert_eq!(fs::read(&target).unwrap(), b"not a private key");
        assert_eq!(fs::read(fixture.legacy().join(&id)).unwrap(), legacy_before);
    }

    #[test]
    fn listing_reports_missing_and_mismatched_public_sidecars_without_losing_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let key = generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).unwrap();
        let public_path = fixture.ssh().join(ssh_public_name(&key.key_id));

        fs::remove_file(&public_path).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert!(listed.issues.iter().any(|issue| {
            issue.key_id.as_deref() == Some(key.key_id.as_str()) && issue.reason.contains("missing")
        }));
        assert!(!public_path.exists(), "listing must not repair the sidecar");

        let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        fs::write(&public_path, other.public_key().to_openssh().unwrap()).unwrap();
        fs::set_permissions(&public_path, fs::Permissions::from_mode(0o600)).unwrap();
        let before = fs::read(&public_path).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert_eq!(listed.keys[0].fingerprint, key.fingerprint);
        assert!(listed.issues.iter().any(|issue| {
            issue.key_id.as_deref() == Some(key.key_id.as_str())
                && issue.reason.contains("does not match")
        }));
        assert_eq!(
            fs::read(&public_path).unwrap(),
            before,
            "listing must not repair a mismatched sidecar"
        );
    }

    #[test]
    fn unrelated_entries_are_ignored_and_untouched_in_the_standard_ssh_folder() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        ensure_ssh_directory(&fixture.ssh()).unwrap();
        for (name, contents) in [
            ("config", b"Host example\n".as_slice()),
            ("authorized_keys", b"ssh-ed25519 AAAA unrelated\n"),
            ("id_ed25519", b"unrelated private file"),
        ] {
            let path = fixture.ssh().join(name);
            fs::write(&path, contents).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        fs::create_dir(fixture.ssh().join("sockets")).unwrap();
        let orphan = fixture.ssh().join(format!("{SSH_KEY_PREFIX}orphan"));
        let orphan_public = fixture.ssh().join(format!(
            "{}.pub",
            ssh_private_name(&Uuid::new_v4().to_string())
        ));
        fs::write(&orphan_public, b"ssh-ed25519 AAAA orphan\n").unwrap();
        fs::write(&orphan, b"not a uuid").unwrap();
        fs::set_permissions(&orphan_public, fs::Permissions::from_mode(0o600)).unwrap();

        let key = generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert_eq!(listed.keys[0].key_id, key.key_id);
        assert!(listed.issues.is_empty());
        assert_eq!(
            fs::read(fixture.ssh().join("config")).unwrap(),
            b"Host example\n"
        );
        assert_eq!(
            fs::read(fixture.ssh().join("authorized_keys")).unwrap(),
            b"ssh-ed25519 AAAA unrelated\n"
        );
        assert_eq!(
            fs::read(fixture.ssh().join("id_ed25519")).unwrap(),
            b"unrelated private file"
        );
        assert!(fixture.ssh().join("sockets").is_dir());
        assert!(orphan.exists());
    }

    #[test]
    fn standard_directory_creation_and_validation_reject_insecure_or_symlinked_roots() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        assert!(!fixture.ssh().exists());
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert!(listed.keys.is_empty());
        assert!(!fixture.ssh().exists(), "listing must not create ~/.ssh");

        ensure_ssh_directory(&fixture.ssh()).unwrap();
        assert_eq!(fs::metadata(fixture.ssh()).unwrap().mode() & 0o777, 0o700);

        fs::set_permissions(fixture.ssh(), fs::Permissions::from_mode(0o755)).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert!(listed
            .issues
            .iter()
            .all(|issue| !issue.reason.contains("writable by other users")));
        assert_eq!(
            fs::metadata(fixture.ssh()).unwrap().mode() & 0o777,
            0o755,
            "an existing directory must never be silently chmod-ed"
        );

        fs::set_permissions(fixture.ssh(), fs::Permissions::from_mode(0o775)).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert!(listed
            .issues
            .iter()
            .any(|issue| issue.reason.contains("writable by other users")));
        assert_eq!(
            fs::metadata(fixture.ssh()).unwrap().mode() & 0o777,
            0o775,
            "an existing directory must never be silently chmod-ed"
        );
        assert!(generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).is_err());
        fs::set_permissions(fixture.ssh(), fs::Permissions::from_mode(0o700)).unwrap();

        let linked = fixture.home.join("linked-ssh");
        symlink(fixture.ssh(), &linked).unwrap();
        assert!(ensure_ssh_directory(&linked).is_err());
        assert!(generate_blocking(&fixture.legacy(), &linked, passphrase()).is_err());
        let linked_list = list_blocking(&fixture.legacy(), &linked).unwrap();
        assert!(linked_list
            .issues
            .iter()
            .any(|issue| issue.reason.contains("not a private directory")));
    }

    #[test]
    fn rejects_malformed_ids_traversal_and_symlinked_or_insecure_entries() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let key = generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).unwrap();
        assert!(canonical_id("../escape").is_err());
        assert!(canonical_id("not-a-uuid").is_err());
        assert!(canonical_id(&key.key_id.to_uppercase()).is_err());
        assert!(resolve_metadata_blocking(&fixture.legacy(), &fixture.ssh(), "../escape").is_err());
        assert!(export_to_blocking(
            &fixture.legacy(),
            &fixture.ssh(),
            "../escape",
            &dir.path().join("escape")
        )
        .is_err());

        let other = generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).unwrap();
        let target = dir.path().join("outside-key");
        fs::write(&target, b"outside").unwrap();
        fs::remove_file(&other.path).unwrap();
        symlink(&target, &other.path).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert!(listed
            .issues
            .iter()
            .any(|issue| issue.key_id.as_deref() == Some(other.key_id.as_str())));

        let insecure = Uuid::new_v4().to_string();
        let insecure_path = fixture.ssh().join(ssh_private_name(&insecure));
        fs::write(&insecure_path, b"not a key").unwrap();
        fs::set_permissions(&insecure_path, fs::Permissions::from_mode(0o644)).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert!(listed.issues.iter().any(|issue| {
            issue.key_id.as_deref() == Some(insecure.as_str()) && issue.reason.contains("insecure")
        }));

        let corrupt = Uuid::new_v4().to_string();
        let corrupt_path = fixture.ssh().join(ssh_private_name(&corrupt));
        fs::write(&corrupt_path, b"not a key").unwrap();
        fs::set_permissions(&corrupt_path, fs::Permissions::from_mode(0o600)).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert!(listed
            .issues
            .iter()
            .any(|issue| issue.key_id.as_deref() == Some(corrupt.as_str())));

        fs::set_permissions(fixture.legacy(), fs::Permissions::from_mode(0o755)).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert!(listed
            .keys
            .iter()
            .any(|item| item.key_id == key.key_id && item.location == KeyLocation::Ssh));
        assert!(listed.issues.iter().any(|issue| {
            issue.reason.contains("app vault was not used")
                && issue.reason.contains("insecure permissions")
        }));
        assert!(resolve_metadata_blocking(&fixture.legacy(), &fixture.ssh(), &key.key_id).is_err());
    }

    #[test]
    fn backup_export_is_a_private_copy_across_both_roots_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let standard = generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).unwrap();
        let (legacy_id, _) = write_legacy_key(&fixture.legacy(), passphrase());

        for key_id in [&standard.key_id, &legacy_id] {
            let destination = dir.path().join(format!("backup-{key_id}.key"));
            export_to_blocking(&fixture.legacy(), &fixture.ssh(), key_id, &destination).unwrap();
            assert_eq!(fs::metadata(&destination).unwrap().mode() & 0o777, 0o600);
            assert!(
                export_to_blocking(&fixture.legacy(), &fixture.ssh(), key_id, &destination)
                    .is_err()
            );
        }
        let missing = dir.path().join("missing").join("backup.key");
        assert!(export_to_blocking(
            &fixture.legacy(),
            &fixture.ssh(),
            &standard.key_id,
            &missing
        )
        .is_err());
    }

    #[test]
    fn a_matching_standard_copy_is_preferred_but_a_conflicting_legacy_key_is_never_hidden() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let (id, fingerprint) = write_legacy_key(&fixture.legacy(), passphrase());
        copy_legacy_to_ssh_blocking(&fixture.legacy(), &fixture.ssh(), &id).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert_eq!(listed.keys[0].location, KeyLocation::Ssh);
        assert!(listed.issues.is_empty());

        // Replace the standard copy with a different key under the same name.
        let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
            .unwrap()
            .encrypt(&mut rand::rng(), passphrase())
            .unwrap();
        let target = fixture.ssh().join(ssh_private_name(&id));
        fs::write(
            &target,
            other.to_openssh(LineEnding::LF).unwrap().as_bytes(),
        )
        .unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        fs::remove_file(fixture.ssh().join(ssh_public_name(&id))).unwrap();
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert_eq!(listed.keys[0].location, KeyLocation::Legacy);
        assert_eq!(listed.keys[0].fingerprint, fingerprint);
        assert!(listed.issues.iter().any(|issue| {
            issue.key_id.as_deref() == Some(id.as_str()) && issue.reason.contains("different key")
        }));
        assert!(resolve_metadata_blocking(&fixture.legacy(), &fixture.ssh(), &id).is_err());
    }

    #[test]
    fn generation_is_limited_across_both_roots_and_ignores_unowned_entries() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        ensure_ssh_directory(&fixture.ssh()).unwrap();
        ensure_legacy_vault(&fixture.legacy()).unwrap();
        for _ in 0..MAX_VAULT_ENTRIES {
            let path = fixture.legacy().join(Uuid::new_v4().to_string());
            fs::write(&path, b"").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).is_err());

        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        ensure_ssh_directory(&fixture.ssh()).unwrap();
        for index in 0..20 {
            fs::write(fixture.ssh().join(format!("unrelated-{index}")), b"").unwrap();
        }
        assert!(generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).is_ok());

        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        ensure_ssh_directory(&fixture.ssh()).unwrap();
        for _ in 0..MAX_VAULT_ENTRIES {
            fs::write(
                fixture
                    .ssh()
                    .join(ssh_private_name(&Uuid::new_v4().to_string())),
                b"",
            )
            .unwrap();
        }
        assert!(generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).is_err());
    }

    #[test]
    fn same_key_reencrypted_with_a_different_passphrase_is_refused_as_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        ensure_legacy_vault(&fixture.legacy()).unwrap();
        ensure_ssh_directory(&fixture.ssh()).unwrap();
        let private = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let id = Uuid::new_v4().to_string();
        let legacy_encrypted = private
            .encrypt(&mut rand::rng(), b"first test passphrase")
            .unwrap();
        let ssh_encrypted = private
            .encrypt(&mut rand::rng(), b"second test passphrase")
            .unwrap();
        assert_eq!(
            legacy_encrypted.fingerprint(HashAlg::Sha256),
            ssh_encrypted.fingerprint(HashAlg::Sha256)
        );
        let legacy_path = fixture.legacy().join(&id);
        let ssh_path = fixture.ssh().join(ssh_private_name(&id));
        let legacy_bytes = legacy_encrypted
            .to_openssh(LineEnding::LF)
            .unwrap()
            .as_bytes()
            .to_vec();
        let ssh_bytes = ssh_encrypted
            .to_openssh(LineEnding::LF)
            .unwrap()
            .as_bytes()
            .to_vec();
        assert_ne!(legacy_bytes, ssh_bytes);
        fs::write(&legacy_path, &legacy_bytes).unwrap();
        fs::write(&ssh_path, &ssh_bytes).unwrap();
        fs::set_permissions(&legacy_path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&ssh_path, fs::Permissions::from_mode(0o600)).unwrap();
        let public_path = fixture.ssh().join(ssh_public_name(&id));
        fs::write(
            &public_path,
            format!("{}\n", private.public_key().to_openssh().unwrap()),
        )
        .unwrap();
        fs::set_permissions(&public_path, fs::Permissions::from_mode(0o600)).unwrap();

        let error = resolve_metadata_blocking(&fixture.legacy(), &fixture.ssh(), &id).unwrap_err();
        assert!(
            error.contains("different key material or encrypted copies"),
            "{error}"
        );
        let destination = dir.path().join("ambiguous.key");
        assert!(export_to_blocking(&fixture.legacy(), &fixture.ssh(), &id, &destination).is_err());
        assert!(!destination.exists());
        let error =
            copy_legacy_to_ssh_blocking(&fixture.legacy(), &fixture.ssh(), &id).unwrap_err();
        assert!(error.contains("different copy"), "{error}");
        assert_eq!(fs::read(&legacy_path).unwrap(), legacy_bytes);
        assert_eq!(fs::read(&ssh_path).unwrap(), ssh_bytes);

        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert_eq!(listed.keys[0].location, KeyLocation::Legacy);
        assert!(listed.issues.iter().any(|issue| {
            issue.key_id.as_deref() == Some(id.as_str())
                && issue.reason.contains("different key or copy")
        }));
    }

    #[test]
    fn list_merge_caps_total_sorted_metadata_and_marks_truncated() {
        let synthetic = |id: u128, location: KeyLocation| FoundKey {
            key: SetupKey {
                key_id: Uuid::from_u128(id).to_string(),
                fingerprint: "SHA256:fixture".into(),
                algorithm: "ssh-ed25519".into(),
                encrypted: true,
                path: format!("/fixture/key-{id}"),
                location,
            },
            fingerprint: "SHA256:fixture".into(),
            digest: [7u8; 32],
            origin: if location == KeyLocation::Legacy {
                KeyOrigin::Legacy
            } else {
                KeyOrigin::Generated
            },
            from_reference: false,
        };
        let legacy: Vec<_> = (1..=60)
            .map(|id| synthetic(id, KeyLocation::Legacy))
            .collect();
        let standard: Vec<_> = (1_000..=1_060)
            .map(|id| synthetic(id, KeyLocation::Ssh))
            .collect();
        let listed = merge_keys(
            legacy,
            Vec::new(),
            standard,
            Vec::new(),
            Path::new("/fixture/legacy"),
            Path::new("/fixture/ssh"),
            false,
        );
        assert_eq!(listed.keys.len(), MAX_VAULT_ENTRIES);
        assert!(listed.truncated);
        let ids: BTreeSet<_> = listed.keys.iter().map(|key| key.key_id.clone()).collect();
        assert_eq!(ids.len(), MAX_VAULT_ENTRIES);
    }

    #[test]
    fn scan_limit_fails_generation_and_marks_listing_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        ensure_ssh_directory(&fixture.ssh()).unwrap();
        for index in 0..=MAX_LIST_SCAN {
            fs::write(fixture.ssh().join(format!("unrelated-{index}")), b"").unwrap();
        }
        let error = generate_blocking(&fixture.legacy(), &fixture.ssh(), passphrase()).unwrap_err();
        assert!(
            error.contains("too many entries to count safely"),
            "{error}"
        );
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert!(listed.truncated);
        assert!(listed.keys.is_empty());
    }

    #[test]
    fn generation_gate_stays_closed_when_the_awaiting_future_is_aborted() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let vault = Arc::new(KeyVault::new(fixture.legacy(), fixture.ssh()));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker_vault = vault.clone();
        let future = async move {
            worker_vault
                .run_generation(
                    "correct horse battery staple".into(),
                    move |legacy, ssh, pass| {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        generate_blocking(legacy, ssh, pass)
                    },
                )
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
    fn empty_passphrase_creates_a_real_plaintext_ed25519_key_and_bounds_still_apply() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let key = generate_blocking(&fixture.legacy(), &fixture.ssh(), b"").unwrap();
        assert!(!key.encrypted);
        let pem = fs::read(&key.path).unwrap();
        let parsed = PrivateKey::from_openssh(pem.as_slice()).unwrap();
        assert!(!parsed.is_encrypted());
        assert_eq!(
            parsed.fingerprint(HashAlg::Sha256).to_string(),
            key.fingerprint
        );
        assert_eq!(fs::metadata(&key.path).unwrap().mode() & 0o777, 0o600);
        for candidate in [b"short".as_slice(), &[b'x'; 11][..], &[b'x'; 4097][..]] {
            assert!(generate_blocking(&fixture.legacy(), &fixture.ssh(), candidate).is_err());
        }
        let encrypted =
            generate_blocking(&fixture.legacy(), &fixture.ssh(), b"twelve bytes!").unwrap();
        assert!(encrypted.encrypted);
        assert!(
            PrivateKey::from_openssh(fs::read(&encrypted.path).unwrap().as_slice())
                .unwrap()
                .is_encrypted()
        );
    }

    #[test]
    fn single_operation_gate_still_bounds_work() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let _guard = fixture.vault.begin_generation().unwrap();
        assert!(fixture.vault.begin_generation().is_err());
        drop(_guard);
        assert!(fixture.vault.begin_generation().is_ok());
    }

    #[test]
    fn named_keys_are_real_plaintext_or_encrypted_files_with_protected_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let plain =
            generate_named_blocking(&fixture.legacy(), &fixture.ssh(), "work-key", b"").unwrap();
        assert!(!plain.encrypted);
        assert_eq!(PathBuf::from(&plain.path), fixture.ssh().join("work-key"));
        assert_eq!(fs::metadata(&plain.path).unwrap().mode() & 0o777, 0o600);
        let public_path = fixture.ssh().join("work-key.pub");
        assert_eq!(fs::metadata(&public_path).unwrap().mode() & 0o777, 0o600);
        let private = PrivateKey::from_openssh(fs::read(&plain.path).unwrap().as_slice()).unwrap();
        assert!(!private.is_encrypted());
        assert_eq!(
            private.fingerprint(HashAlg::Sha256).to_string(),
            plain.fingerprint
        );
        let public_text = fs::read_to_string(&public_path).unwrap();
        let public = PublicKey::from_openssh(public_text.as_str()).unwrap();
        assert_eq!(
            public.fingerprint(HashAlg::Sha256).to_string(),
            plain.fingerprint
        );

        let encrypted = generate_named_blocking(
            &fixture.legacy(),
            &fixture.ssh(),
            "secure-key",
            passphrase(),
        )
        .unwrap();
        assert!(encrypted.encrypted);
        let parsed =
            PrivateKey::from_openssh(fs::read(&encrypted.path).unwrap().as_slice()).unwrap();
        assert!(parsed.is_encrypted());
        assert!(parsed.decrypt(passphrase()).is_ok());
        assert!(parsed.decrypt(b"wrong passphrase").is_err());

        let reference_dir = fixture.ssh().join(references::REFERENCE_DIR);
        assert_eq!(fs::metadata(&reference_dir).unwrap().mode() & 0o777, 0o700);
        let record_path = reference_dir.join(format!("{}.json", plain.key_id));
        assert_eq!(fs::metadata(&record_path).unwrap().mode() & 0o777, 0o600);
        let record_text = fs::read_to_string(&record_path).unwrap();
        assert!(!record_text.contains("BEGIN OPENSSH PRIVATE KEY"));
        assert!(record_text.contains(&plain.fingerprint));
        let record: references::KeyReference = serde_json::from_str(&record_text).unwrap();
        assert_eq!(record.kind, references::ReferenceKind::Generated);
        assert_eq!(record.path, plain.path);

        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 2);
        let listed_plain = listed
            .keys
            .iter()
            .find(|key| key.key_id == plain.key_id)
            .unwrap();
        let listed_encrypted = listed
            .keys
            .iter()
            .find(|key| key.key_id == encrypted.key_id)
            .unwrap();
        assert!(!listed_plain.encrypted);
        assert!(listed_encrypted.encrypted);
        assert_eq!(listed_plain.algorithm, "ssh-ed25519");
    }

    #[test]
    fn named_names_reject_reserved_traversal_and_collisions_without_changes() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        ensure_ssh_directory(&fixture.ssh()).unwrap();
        for name in [
            "",
            "x.pub",
            "config",
            "authorized_keys",
            "known_hosts",
            "environment",
            "../escape",
            "dir/name",
            ".hidden",
            "-dash",
            "with space",
            "with%percent",
            "with$dollar",
            "with\"quote",
            "with\\backslash",
        ] {
            assert!(validate_key_name(name).is_err(), "{name:?}");
            let checked = check_name_blocking(&fixture.ssh(), name).unwrap();
            assert!(!checked.available, "{name:?}");
        }
        let reserved_uuid = format!("vps-pilot_{}", Uuid::new_v4());
        assert!(validate_key_name(&reserved_uuid).is_err());
        assert!(validate_key_name(&"a".repeat(65)).is_err());

        let private_collision = fixture.ssh().join("taken");
        fs::write(&private_collision, b"foreign private").unwrap();
        fs::set_permissions(&private_collision, fs::Permissions::from_mode(0o600)).unwrap();
        let public_collision = fixture.ssh().join("taken-pub.pub");
        fs::write(&public_collision, b"foreign public").unwrap();
        fs::set_permissions(&public_collision, fs::Permissions::from_mode(0o600)).unwrap();
        fs::create_dir(fixture.ssh().join("folder")).unwrap();
        symlink(
            fixture.ssh().join("missing-target"),
            fixture.ssh().join("dangling"),
        )
        .unwrap();

        for name in ["taken", "taken-pub", "folder", "dangling"] {
            let checked = check_name_blocking(&fixture.ssh(), name).unwrap();
            assert!(!checked.available, "{name}");
            let error =
                generate_named_blocking(&fixture.legacy(), &fixture.ssh(), name, b"").unwrap_err();
            assert!(error.contains("already uses this key name"), "{error}");
        }
        assert_eq!(fs::read(&private_collision).unwrap(), b"foreign private");
        assert_eq!(fs::read(&public_collision).unwrap(), b"foreign public");
        assert_eq!(
            references::count_references(&fixture.ssh()).unwrap(),
            0,
            "a failed named generation must not leave an owned reference"
        );
    }

    #[test]
    fn a_foreign_file_created_after_a_successful_name_check_fails_safely() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        ensure_ssh_directory(&fixture.ssh()).unwrap();
        assert!(
            check_name_blocking(&fixture.ssh(), "race")
                .unwrap()
                .available
        );
        let foreign = fixture.ssh().join("race");
        fs::write(&foreign, b"foreign race bytes").unwrap();
        fs::set_permissions(&foreign, fs::Permissions::from_mode(0o600)).unwrap();
        let error =
            generate_named_blocking(&fixture.legacy(), &fixture.ssh(), "race", b"").unwrap_err();
        assert!(error.contains("already uses this key name"), "{error}");
        assert_eq!(fs::read(&foreign).unwrap(), b"foreign race bytes");
        assert_eq!(references::count_references(&fixture.ssh()).unwrap(), 0);

        let dir2 = tempfile::tempdir().unwrap();
        let fixture2 = Fixture::new(&dir2);
        ensure_ssh_directory(&fixture2.ssh()).unwrap();
        assert!(
            check_name_blocking(&fixture2.ssh(), "race-pub")
                .unwrap()
                .available
        );
        let foreign_public = fixture2.ssh().join("race-pub.pub");
        fs::write(&foreign_public, b"foreign public bytes").unwrap();
        fs::set_permissions(&foreign_public, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            generate_named_blocking(&fixture2.legacy(), &fixture2.ssh(), "race-pub", b"").is_err()
        );
        assert_eq!(fs::read(&foreign_public).unwrap(), b"foreign public bytes");
        assert!(!fixture2.ssh().join("race-pub").exists());
    }

    #[test]
    fn a_public_race_after_private_publish_keeps_the_key_and_reference_discoverable() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let error = generate_named_blocking_with(
            &fixture.legacy(),
            &fixture.ssh(),
            "partial",
            b"",
            |public_target| {
                fs::write(public_target, b"foreign public key").unwrap();
                fs::set_permissions(public_target, fs::Permissions::from_mode(0o600)).unwrap();
            },
        )
        .unwrap_err();
        assert!(error.contains("public key file"), "{error}");
        let private = fixture.ssh().join("partial");
        assert!(private.is_file());
        assert_eq!(fs::metadata(&private).unwrap().mode() & 0o777, 0o600);
        assert_eq!(
            fs::read(fixture.ssh().join("partial.pub")).unwrap(),
            b"foreign public key"
        );
        assert_eq!(references::count_references(&fixture.ssh()).unwrap(), 1);
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert!(!listed.keys[0].encrypted);
        assert!(listed
            .issues
            .iter()
            .any(|issue| issue.reason.contains("public key")));
        let resolved =
            resolve_metadata_blocking(&fixture.legacy(), &fixture.ssh(), &listed.keys[0].key_id)
                .unwrap();
        assert_eq!(resolved.path, private);
        assert!(resolved.public_path.is_none());
        assert!(resolved.public_issue.is_some());
    }

    #[test]
    fn named_references_survive_restart_and_fail_closed_when_changed_or_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let key =
            generate_named_blocking(&fixture.legacy(), &fixture.ssh(), "restart-key", b"").unwrap();
        let restart = KeyVault::new(fixture.legacy(), fixture.ssh());
        let listed = list_blocking(&restart.legacy_root, &restart.ssh_root).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert_eq!(listed.keys[0].key_id, key.key_id);
        let resolved = restart.resolve_metadata(&key.key_id).unwrap();
        assert_eq!(resolved.path, PathBuf::from(&key.path));
        assert_eq!(resolved.origin, KeyOrigin::Generated);

        let original = fs::read(&key.path).unwrap();
        fs::write(&key.path, b"tampered key bytes").unwrap();
        fs::set_permissions(&key.path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(restart.resolve_metadata(&key.key_id).is_err());
        let listed = list_blocking(&restart.legacy_root, &restart.ssh_root).unwrap();
        assert!(listed
            .issues
            .iter()
            .any(|issue| issue.key_id.as_deref() == Some(key.key_id.as_str())));
        fs::write(&key.path, &original).unwrap();
        fs::set_permissions(&key.path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(restart.resolve_metadata(&key.key_id).is_ok());

        let record_path = restart
            .ssh_root
            .join(references::REFERENCE_DIR)
            .join(format!("{}.json", key.key_id));
        let record = fs::read(&record_path).unwrap();
        fs::write(&record_path, b"{\"version\":1,\"id\":\"bad\"}").unwrap();
        assert!(restart.resolve_metadata(&key.key_id).is_err());
        let listed = list_blocking(&restart.legacy_root, &restart.ssh_root).unwrap();
        assert!(listed.issues.iter().any(|issue| {
            issue.key_id.as_deref() == Some(key.key_id.as_str()) && issue.reason.contains("corrupt")
        }));
        assert!(record_path.exists(), "corrupt metadata must be preserved");
        fs::write(&record_path, &record).unwrap();

        let reference_dir = restart.ssh_root.join(references::REFERENCE_DIR);
        fs::set_permissions(&reference_dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(restart.resolve_metadata(&key.key_id).is_err());
        let listed = list_blocking(&restart.legacy_root, &restart.ssh_root).unwrap();
        assert!(listed
            .issues
            .iter()
            .any(|issue| issue.reason.contains("not a private directory")));
        assert!(record_path.exists());
        fs::set_permissions(&reference_dir, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn selected_keys_preserve_files_support_0400_and_reuse_or_replace_references() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let external_dir = dir.path().join("outside keys");
        fs::create_dir_all(&external_dir).unwrap();
        let selected_path = external_dir.join("chosen key");
        fs::write(
            &selected_path,
            PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
                .unwrap()
                .to_openssh(LineEnding::LF)
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        fs::set_permissions(&selected_path, fs::Permissions::from_mode(0o400)).unwrap();
        let original = fs::read(&selected_path).unwrap();
        let selected =
            register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &selected_path).unwrap();
        assert_eq!(
            PathBuf::from(&selected.path),
            fs::canonicalize(&selected_path).unwrap()
        );
        assert_eq!(selected.location, KeyLocation::External);
        assert!(!selected.encrypted);
        assert_eq!(fs::read(&selected_path).unwrap(), original);
        assert_eq!(
            fs::metadata(&selected_path).unwrap().mode() & 0o777,
            0o400,
            "selection must never chmod the chosen file"
        );
        assert!(!external_dir.join("chosen key.pub").exists());
        let count = references::count_references(&fixture.ssh()).unwrap();
        let again =
            register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &selected_path).unwrap();
        assert_eq!(again.key_id, selected.key_id);
        assert_eq!(references::count_references(&fixture.ssh()).unwrap(), count);
        assert_eq!(fs::metadata(&selected_path).unwrap().mode() & 0o777, 0o400);

        let restart = KeyVault::new(fixture.legacy(), fixture.ssh());
        let resolved = restart.resolve_metadata(&selected.key_id).unwrap();
        assert_eq!(resolved.origin, KeyOrigin::Selected);
        assert_eq!(resolved.location, KeyLocation::External);
        assert_eq!(resolved.path, fs::canonicalize(&selected_path).unwrap());
        assert!(resolved.public_path.is_none());
        assert!(resolved.public_issue.is_none());
        assert_eq!(fs::read(&selected_path).unwrap(), original);

        let matching_public = external_dir.join("chosen key.pub");
        let private_key = PrivateKey::from_openssh(original.as_slice()).unwrap();
        fs::write(
            &matching_public,
            format!("{}\n", private_key.public_key().to_openssh().unwrap()),
        )
        .unwrap();
        fs::set_permissions(&matching_public, fs::Permissions::from_mode(0o644)).unwrap();
        let resolved = restart.resolve_metadata(&selected.key_id).unwrap();
        let canonical_public = fs::canonicalize(&matching_public).unwrap();
        assert_eq!(
            resolved.public_path.as_deref(),
            Some(canonical_public.as_path())
        );

        fs::remove_file(&matching_public).unwrap();
        fs::set_permissions(&selected_path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(
            &selected_path,
            PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
                .unwrap()
                .to_openssh(LineEnding::LF)
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        fs::set_permissions(&selected_path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(restart.resolve_metadata(&selected.key_id).is_err());
        let changed = fs::read(&selected_path).unwrap();
        let replacement =
            register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &selected_path).unwrap();
        assert_ne!(replacement.key_id, selected.key_id);
        assert_eq!(
            references::count_references(&fixture.ssh()).unwrap(),
            count + 1,
            "explicit reselection creates a fresh reference without deleting the old one"
        );
        assert_eq!(fs::read(&selected_path).unwrap(), changed);
    }

    #[test]
    fn selected_key_validation_rejects_unsafe_files_but_allows_spaces_and_ecdsa() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        ensure_ssh_directory(&fixture.ssh()).unwrap();
        let base = dir.path().join("keys");
        fs::create_dir_all(&base).unwrap();
        let make_key = |name: &str, mode: u32| -> PathBuf {
            let path = base.join(name);
            let private = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
            fs::write(
                &path,
                private.to_openssh(LineEnding::LF).unwrap().as_bytes(),
            )
            .unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            path
        };
        let insecure = make_key("insecure", 0o644);
        assert!(register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &insecure).is_err());
        let secure = make_key("secure", 0o600);
        assert!(register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &secure).is_ok());

        let linked = base.join("linked");
        symlink(&secure, &linked).unwrap();
        assert!(register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &linked).is_err());

        let hardlink = base.join("hardlink");
        fs::hard_link(&secure, &hardlink).unwrap();
        assert!(register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &hardlink).is_err());

        assert!(register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &base).is_err());

        let spaced = make_key("key with space", 0o400);
        let spaced_key =
            register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &spaced).unwrap();
        assert_eq!(spaced_key.location, KeyLocation::External);
        assert_eq!(fs::metadata(&spaced).unwrap().mode() & 0o777, 0o400);

        let expansion = make_key("with%percent", 0o600);
        assert!(register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &expansion).is_err());
        let dollar = make_key("with$dollar", 0o600);
        assert!(register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &dollar).is_err());

        let ecdsa_path = base.join("ecdsa-key");
        let ecdsa = PrivateKey::random(
            &mut rand::rng(),
            Algorithm::Ecdsa {
                curve: russh::keys::EcdsaCurve::NistP256,
            },
        )
        .unwrap();
        fs::write(
            &ecdsa_path,
            ecdsa.to_openssh(LineEnding::LF).unwrap().as_bytes(),
        )
        .unwrap();
        fs::set_permissions(&ecdsa_path, fs::Permissions::from_mode(0o600)).unwrap();
        let ecdsa_key =
            register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &ecdsa_path).unwrap();
        assert_ne!(ecdsa_key.algorithm, "ssh-ed25519");
        assert_eq!(ecdsa_key.algorithm, ecdsa.algorithm().to_string());

        let public_path = base.join("secure.pub");
        let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        fs::write(&public_path, other.public_key().to_openssh().unwrap()).unwrap();
        fs::set_permissions(&public_path, fs::Permissions::from_mode(0o600)).unwrap();
        let before = fs::read(&secure).unwrap();
        assert!(register_selected_blocking(&fixture.legacy(), &fixture.ssh(), &secure).is_err());
        assert_eq!(fs::read(&secure).unwrap(), before);
    }

    #[test]
    fn selecting_an_unchanged_uuid_generated_key_reuses_its_original_identifier() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        // Exercise a canonical-path mismatch through a symlinked home ancestor.
        // macOS `/var` resolves to `/private/var`; this fixture reproduces the
        // same aliasing on Linux without touching a real home directory.
        let link_home = dir.path().join("link-home");
        symlink(&fixture.home, &link_home).unwrap();
        let ssh_root = link_home.join(".ssh");
        let original = generate_blocking(&fixture.legacy(), &ssh_root, b"").unwrap();
        let before_records = references::count_references(&ssh_root).unwrap();
        let selected =
            register_selected_blocking(&fixture.legacy(), &ssh_root, Path::new(&original.path))
                .unwrap();
        assert_eq!(selected.key_id, original.key_id);
        assert_eq!(selected.location, KeyLocation::Ssh);
        assert_eq!(
            references::count_references(&ssh_root).unwrap(),
            before_records
        );
        let listed = list_blocking(&fixture.legacy(), &fixture.ssh()).unwrap();
        assert_eq!(listed.keys.len(), 1);
        assert_eq!(listed.keys[0].key_id, original.key_id);
        assert!(
            resolve_metadata_blocking(&fixture.legacy(), &fixture.ssh(), &original.key_id).is_ok()
        );
    }

    #[test]
    fn plaintext_backup_export_copies_the_exact_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        let key =
            generate_named_blocking(&fixture.legacy(), &fixture.ssh(), "backup-key", b"").unwrap();
        let destination = dir.path().join("plain-backup.key");
        export_to_blocking(&fixture.legacy(), &fixture.ssh(), &key.key_id, &destination).unwrap();
        assert_eq!(
            fs::read(&destination).unwrap(),
            fs::read(&key.path).unwrap()
        );
        assert_eq!(fs::metadata(&destination).unwrap().mode() & 0o777, 0o600);
        assert!(
            export_to_blocking(&fixture.legacy(), &fixture.ssh(), &key.key_id, &destination)
                .is_err()
        );
    }

    #[test]
    fn write_reference_validates_schema_and_bounded_size_before_publishing() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(&dir);
        ensure_ssh_directory(&fixture.ssh()).unwrap();
        let record = references::KeyReference {
            version: 2,
            id: Uuid::new_v4().to_string(),
            path: fixture.ssh().join("key").to_string_lossy().into_owned(),
            kind: references::ReferenceKind::Generated,
            fingerprint: "SHA256:fixture".into(),
            digest: "0".repeat(64),
        };
        assert!(references::write_reference(&fixture.ssh(), &record).is_err());
        assert_eq!(references::count_references(&fixture.ssh()).unwrap(), 0);
    }
}
