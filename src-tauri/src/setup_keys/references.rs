//! Bounded, protected per-reference metadata for named and selected keys.
//!
//! A named generated key or an explicitly selected existing key has no
//! UUID-derived file name, so the vault cannot rediscover it from `~/.ssh`
//! alone. Each reference is its own small JSON file under
//! `~/.ssh/.vps-pilot-keys/<UUID>.json`. Records store only an opaque ID, the
//! trusted native private-key path, the reference kind, the public-key
//! fingerprint and the SHA-256 digest of the exact file bytes. Private-key
//! bytes and passphrases are never stored.
//!
//! Per-record files avoid manifest lost-update races. Every read is bounded,
//! validates the directory and record permissions, rejects unknown fields and
//! fails closed on changed or corrupt data without deleting it.

use super::{
    canonical_id, private_digest, publish_bytes_noclobber, read_private_file, read_public_sidecar,
    sync_directory, validate_key_name, KeyLocation, PublishFailure, SetupKeyIssue, MAX_LIST_SCAN,
    MAX_VAULT_ENTRIES,
};
use russh::keys::{Algorithm, HashAlg};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
};

pub(super) const REFERENCE_DIR: &str = ".vps-pilot-keys";
const REFERENCE_VERSION: u8 = 1;
const MAX_RECORD_BYTES: u64 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum ReferenceKind {
    Generated,
    Selected,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct KeyReference {
    pub version: u8,
    pub id: String,
    pub path: String,
    pub kind: ReferenceKind,
    pub fingerprint: String,
    pub digest: String,
}

pub(super) struct ReferenceLoad {
    pub records: Vec<KeyReference>,
    pub issues: Vec<SetupKeyIssue>,
    pub truncated: bool,
}

pub(super) struct ResolvedReference {
    pub path: PathBuf,
    pub public_path: Option<PathBuf>,
    pub fingerprint: String,
    pub digest: [u8; 32],
    pub algorithm: String,
    pub encrypted: bool,
    pub location: KeyLocation,
    pub public_issue: Option<String>,
}

pub(super) fn reference_dir(root: &Path) -> PathBuf {
    root.join(REFERENCE_DIR)
}

fn home_owner(root: &Path) -> Result<u32, String> {
    let parent = root
        .parent()
        .ok_or_else(|| "The standard SSH folder is unavailable.".to_string())?;
    fs::metadata(parent)
        .map(|metadata| metadata.uid())
        .map_err(|_| "The standard SSH folder is unavailable.".to_string())
}

fn valid_reference_directory(metadata: &fs::Metadata, owner: u32) -> bool {
    metadata.file_type().is_dir()
        && !metadata.file_type().is_symlink()
        && metadata.uid() == owner
        && metadata.mode() & 0o777 == 0o700
        && metadata.mode() & 0o7000 == 0
}

pub(super) fn ensure_reference_dir(root: &Path) -> Result<PathBuf, String> {
    let owner = home_owner(root)?;
    let directory = reference_dir(root);
    match fs::symlink_metadata(&directory) {
        Ok(metadata) => {
            if !valid_reference_directory(&metadata, owner) {
                return Err(
                    "The local key reference folder is not a private directory. It was not used or changed."
                        .into(),
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            match builder.create(&directory) {
                Ok(()) => {}
                Err(create) if create.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => {
                    return Err(
                        "The local key reference folder could not be created. Nothing was changed."
                            .into(),
                    )
                }
            }
            let metadata = fs::symlink_metadata(&directory)
                .map_err(|_| "The local key reference folder could not be verified.".to_string())?;
            if !valid_reference_directory(&metadata, owner) {
                return Err(
                    "The local key reference folder is not a private directory. It was not used or changed."
                        .into(),
                );
            }
        }
        Err(_) => {
            return Err(
                "The local key reference folder is unavailable. Nothing was changed.".into(),
            )
        }
    }
    Ok(directory)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_fingerprint(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("SHA256:") else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 96
        && rest
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
}

fn valid_record(record: &KeyReference, stem: &str) -> Result<(), String> {
    if record.version != REFERENCE_VERSION {
        return Err("The saved local key reference uses an unsupported version.".into());
    }
    match canonical_id(&record.id) {
        Ok(id) if id == stem => {}
        _ => {
            return Err("The saved local key reference has a malformed identifier.".into());
        }
    }
    if !valid_fingerprint(&record.fingerprint) {
        return Err("The saved local key reference has a malformed fingerprint.".into());
    }
    if !valid_digest(&record.digest) {
        return Err("The saved local key reference has a malformed digest.".into());
    }
    let path = Path::new(&record.path);
    if !path.is_absolute() || record.path.chars().any(|character| character.is_control()) {
        return Err("The saved local key reference has an unsafe path.".into());
    }
    Ok(())
}

fn read_record(path: &Path, owner: u32) -> Result<KeyReference, String> {
    let before = fs::symlink_metadata(path)
        .map_err(|_| "A saved local key reference is unreadable.".to_string())?;
    if before.file_type().is_symlink()
        || !before.file_type().is_file()
        || before.uid() != owner
        || before.nlink() != 1
        || before.mode() & 0o777 != 0o600
        || before.mode() & 0o7000 != 0
        || before.len() > MAX_RECORD_BYTES
    {
        return Err(
            "A saved local key reference is not a protected regular file. It was preserved and is not used."
                .into(),
        );
    }
    let file =
        File::open(path).map_err(|_| "A saved local key reference is unreadable.".to_string())?;
    let opened = file
        .metadata()
        .map_err(|_| "A saved local key reference is unreadable.".to_string())?;
    if opened.dev() != before.dev()
        || opened.ino() != before.ino()
        || !opened.file_type().is_file()
        || opened.uid() != owner
        || opened.nlink() != 1
        || opened.mode() & 0o777 != 0o600
        || opened.mode() & 0o7000 != 0
        || opened.len() > MAX_RECORD_BYTES
    {
        return Err("A saved local key reference changed while it was being read.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "A saved local key reference is unreadable.".to_string())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("A saved local key reference is larger than expected.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        "A saved local key reference is corrupt. It was preserved and is not used.".into()
    })
}

pub(super) fn load_references(root: &Path) -> Result<ReferenceLoad, String> {
    let directory = reference_dir(root);
    let owner = home_owner(root)?;
    match fs::symlink_metadata(&directory) {
        Ok(metadata) => {
            if !valid_reference_directory(&metadata, owner) {
                return Err(
                    "The local key reference folder is not a private directory. It was not used or changed."
                        .into(),
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ReferenceLoad {
                records: Vec::new(),
                issues: Vec::new(),
                truncated: false,
            })
        }
        Err(_) => {
            return Err(
                "The local key reference folder is unavailable. Nothing was changed.".into(),
            )
        }
    }
    let entries = fs::read_dir(&directory)
        .map_err(|_| "The local key reference folder could not be read.".to_string())?;
    let mut records = Vec::new();
    let mut issues = Vec::new();
    let mut truncated = false;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_LIST_SCAN {
            truncated = true;
            break;
        }
        let entry = entry.map_err(|_| {
            "An entry in the local key reference folder could not be read.".to_string()
        })?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            issues.push(SetupKeyIssue {
                key_id: None,
                reason: "An unrecognized key reference entry was preserved but is unavailable."
                    .into(),
            });
            continue;
        };
        if name.starts_with(".vps-pilot-staging-") && name.ends_with(".tmp") {
            continue;
        }
        let Some(stem) = name.strip_suffix(".json") else {
            issues.push(SetupKeyIssue {
                key_id: None,
                reason: "An unrecognized key reference entry was preserved but is unavailable."
                    .into(),
            });
            continue;
        };
        let Ok(id) = canonical_id(stem) else {
            issues.push(SetupKeyIssue {
                key_id: None,
                reason: "An unrecognized key reference entry was preserved but is unavailable."
                    .into(),
            });
            continue;
        };
        if records.len() >= MAX_VAULT_ENTRIES {
            truncated = true;
            continue;
        }
        match read_record(&entry.path(), owner).and_then(|record| {
            valid_record(&record, &id)?;
            Ok(record)
        }) {
            Ok(record) => records.push(record),
            Err(reason) => issues.push(SetupKeyIssue {
                key_id: Some(id),
                reason,
            }),
        }
    }
    Ok(ReferenceLoad {
        records,
        issues,
        truncated,
    })
}

fn generated_path_is_trusted(root: &Path, path: &Path) -> Result<(), String> {
    if path.parent() != Some(root) {
        return Err("A saved generated-key reference leaves the standard SSH folder.".into());
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err("A saved generated-key reference has an unsafe file name.".into());
    };
    validate_key_name(name)?;
    let canonical_root = fs::canonicalize(root)
        .map_err(|_| "The standard SSH folder is unavailable.".to_string())?;
    let canonical_parent = fs::canonicalize(
        path.parent()
            .ok_or_else(|| "A saved generated-key reference has no parent folder.".to_string())?,
    )
    .map_err(|_| "A saved generated-key reference path is unavailable.".to_string())?;
    if canonical_parent != canonical_root {
        return Err("A saved generated-key reference leaves the standard SSH folder.".into());
    }
    Ok(())
}

pub(super) fn resolve_reference(
    root: &Path,
    owner: u32,
    record: &KeyReference,
) -> Result<ResolvedReference, String> {
    let path = PathBuf::from(&record.path);
    if record.kind == ReferenceKind::Generated {
        generated_path_is_trusted(root, &path)?;
    }
    let (private, bytes) = read_private_file(&path, owner)?;
    let digest = private_digest(bytes.as_slice());
    if digest_hex(&digest) != record.digest {
        return Err(
            "The saved local key changed after it was referenced. Select it again to create a fresh verified reference."
                .into(),
        );
    }
    let fingerprint = private.fingerprint(HashAlg::Sha256).to_string();
    if fingerprint != record.fingerprint {
        return Err(
            "The saved local key fingerprint changed after it was referenced. Select it again to create a fresh verified reference."
                .into(),
        );
    }
    let public_path = public_path_for(&path);
    let (valid_public, public_issue) = match fs::symlink_metadata(&public_path) {
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && record.kind == ReferenceKind::Selected =>
        {
            (None, None)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (
            None,
            Some(
                "The matching public key file is missing. The private key is preserved."
                    .into(),
            ),
        ),
        Err(_) => (
            None,
            Some(
                "The matching public key file could not be checked. The private key is preserved."
                    .into(),
            ),
        ),
        Ok(_) => match read_public_sidecar(&public_path, owner) {
            Ok(public) if public.fingerprint(HashAlg::Sha256).to_string() == fingerprint => {
                (Some(public_path), None)
            }
            Ok(_) => (
                None,
                Some(
                    "The matching public key file does not match the private key. The private key is preserved; the public file was not changed."
                        .into(),
                ),
            ),
            Err(reason) => (
                None,
                Some(format!("{reason} The private key is preserved.")),
            ),
        },
    };
    let location = location_for_path(root, &path);
    if record.kind == ReferenceKind::Generated && location != KeyLocation::Ssh {
        return Err("A saved generated-key reference leaves the standard SSH folder.".into());
    }
    Ok(ResolvedReference {
        path,
        public_path: valid_public,
        fingerprint,
        digest,
        algorithm: algorithm_name(private.algorithm()),
        encrypted: private.is_encrypted(),
        location,
        public_issue,
    })
}

fn public_path_for(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".pub");
    PathBuf::from(name)
}

fn algorithm_name(algorithm: Algorithm) -> String {
    algorithm.to_string()
}

pub(super) fn location_for_path(root: &Path, path: &Path) -> KeyLocation {
    let Ok(canonical_root) = fs::canonicalize(root) else {
        return KeyLocation::External;
    };
    let Ok(canonical_path) = fs::canonicalize(path) else {
        return KeyLocation::External;
    };
    if canonical_path.starts_with(&canonical_root) {
        KeyLocation::Ssh
    } else {
        KeyLocation::External
    }
}

pub(super) fn digest_hex(digest: &[u8; 32]) -> String {
    let mut text = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(text, "{byte:02x}");
    }
    text
}

pub(super) fn write_reference(root: &Path, record: &KeyReference) -> Result<(), String> {
    valid_record(record, &record.id)?;
    let directory = ensure_reference_dir(root)?;
    let target = directory.join(format!("{}.json", record.id));
    let bytes = serde_json::to_vec(record)
        .map_err(|_| "The local key reference could not be encoded.".to_string())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err(
            "The local key reference is too large to store safely. Nothing was published.".into(),
        );
    }
    let expected = record.clone();
    publish_bytes_noclobber(&directory, &target, &bytes, move |staged| {
        let parsed: KeyReference = serde_json::from_slice(staged)
            .map_err(|_| "The staged local key reference could not be verified.".to_string())?;
        if parsed != expected {
            return Err(
                "The staged local key reference did not match. Nothing was published.".into(),
            );
        }
        Ok(())
    })
    .map_err(|failure| match failure {
        PublishFailure::Exists => {
            "A local key reference already uses this identifier. Nothing was overwritten."
                .to_string()
        }
        PublishFailure::Failed => {
            "The local key reference could not be published. Nothing was overwritten.".to_string()
        }
    })?;
    sync_directory(&directory)?;
    Ok(())
}

/// Remove only the exact record this operation just created. Any replacement or
/// foreign file is preserved.
pub(super) fn remove_reference(root: &Path, record: &KeyReference) {
    let directory = reference_dir(root);
    let Ok(owner) = home_owner(root) else {
        return;
    };
    if fs::symlink_metadata(&directory)
        .map(|metadata| !valid_reference_directory(&metadata, owner))
        .unwrap_or(true)
    {
        return;
    }
    let target = directory.join(format!("{}.json", record.id));
    let Ok(current) = read_record(&target, owner) else {
        return;
    };
    if current != *record {
        return;
    }
    if fs::remove_file(&target).is_ok() {
        let _ = sync_directory(&directory);
    }
}

pub(super) fn count_references(root: &Path) -> Result<usize, String> {
    let directory = reference_dir(root);
    let owner = home_owner(root)?;
    match fs::symlink_metadata(&directory) {
        Ok(metadata) => {
            if !valid_reference_directory(&metadata, owner) {
                return Err(
                    "The local key reference folder is not a private directory. It was not used or changed."
                        .into(),
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => {
            return Err(
                "The local key reference folder is unavailable. Nothing was changed.".into(),
            )
        }
    }
    let mut count = 0usize;
    for (index, entry) in fs::read_dir(&directory)
        .map_err(|_| "The local key reference folder could not be read.".to_string())?
        .enumerate()
    {
        if index >= MAX_LIST_SCAN {
            return Err(
                "The local key reference folder contains too many entries to count safely. Nothing was created."
                    .into(),
            );
        }
        let entry =
            entry.map_err(|_| "The local key reference folder could not be read.".to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with(".vps-pilot-staging-") && name.ends_with(".tmp") {
            continue;
        }
        if name.ends_with(".json") {
            count += 1;
            if count >= MAX_VAULT_ENTRIES {
                break;
            }
        }
    }
    Ok(count)
}
