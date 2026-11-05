//! Reviewed local SSH config export.
//!
//! Only the standard SSH directory's `config` file is touched. The app owns a
//! single marked block per profile UUID; unrelated bytes are preserved exactly.
//! Every write is staged, revalidated and published atomically after a protected
//! no-overwrite backup. OpenSSH and user commands are never executed.

use super::SourceSnapshot;
use crate::setup_keys::{validate_standard_root, KeyVault};
use sha2::{Digest, Sha256};
use ssh2_config::{ParseRule, SshConfig};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Instant,
};
use tempfile::Builder;
use uuid::Uuid;

pub(super) const MAX_CONFIG_BYTES: usize = 128 * 1024;
const LOCK_NAME: &str = ".vps-pilot-config.lock";
const MARKER_PREFIX: &str = "# vps-pilot:";

pub(super) struct PrepareRequest {
    pub profile_id: String,
    pub alias: String,
    pub host: String,
    pub username: String,
    pub port: u16,
    pub file_name: String,
}

pub(super) struct Prepared {
    pub entry: String,
    pub mode: &'static str,
    pub backup: bool,
    pub source: SourceSnapshot,
    pub candidate_sha256: [u8; 32],
}

pub(super) struct Saved {
    pub backup_path: Option<PathBuf>,
}

#[derive(Clone, Copy)]
struct TextLine<'a> {
    start: usize,
    end: usize,
    text: &'a str,
}

struct Block {
    id: String,
    start: usize,
    end: usize,
    body_start: usize,
    end_start: usize,
}

enum Marker {
    Begin(String),
    End(String),
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    let result = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

fn canonical_uuid(value: &str) -> Result<String, String> {
    let parsed = Uuid::parse_str(value).map_err(|_| {
        "The SSH config contains a malformed VPS Pilot ownership marker.".to_string()
    })?;
    if parsed.to_string() != value {
        return Err("The SSH config contains a malformed VPS Pilot ownership marker.".into());
    }
    Ok(parsed.to_string())
}

pub(super) fn validate_alias(alias: &str) -> Result<(), String> {
    let bytes = alias.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 64
        && bytes.iter().all(u8::is_ascii)
        && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte));
    if valid {
        Ok(())
    } else {
        Err(
            "Use an SSH alias of 1 to 64 ASCII letters, numbers, dots, underscores or hyphens, not starting with a hyphen."
                .into(),
        )
    }
}

fn validate_host(host: &str) -> Result<(), String> {
    let valid = !host.is_empty()
        && host.len() <= 253
        && !host
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        && !host.contains(['#', '\\', '"', '\'']);
    if valid {
        Ok(())
    } else {
        Err("The reviewed server host cannot be written safely to the SSH config.".into())
    }
}

fn validate_username(username: &str) -> Result<(), String> {
    let bytes = username.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte));
    if valid {
        Ok(())
    } else {
        Err("The reviewed target username cannot be written safely to the SSH config.".into())
    }
}

fn validate_file_name(file_name: &str) -> Result<(), String> {
    let rest = file_name.strip_prefix("vps-pilot_").ok_or_else(|| {
        "The selected key does not use the standard VPS Pilot file name.".to_string()
    })?;
    canonical_uuid(rest)?;
    Ok(())
}

fn text_lines(text: &str) -> Vec<TextLine<'_>> {
    let mut result = Vec::new();
    let mut start = 0;
    for chunk in text.split_inclusive('\n') {
        let end = start + chunk.len();
        let content = chunk.strip_suffix('\n').unwrap_or(chunk);
        let content = content.strip_suffix('\r').unwrap_or(content);
        result.push(TextLine {
            start,
            end,
            text: content,
        });
        start = end;
    }
    result
}

fn parse_marker(text: &str) -> Result<Option<Marker>, String> {
    let line = text.trim_end_matches('\r');
    if line.trim_start().starts_with(MARKER_PREFIX) && !line.starts_with(MARKER_PREFIX) {
        return Err(
            "The SSH config contains an indented VPS Pilot ownership marker. It was not changed."
                .into(),
        );
    }
    if !line.starts_with(MARKER_PREFIX) {
        return Ok(None);
    }
    if let Some(rest) = line.strip_prefix("# vps-pilot:begin ") {
        return Ok(Some(Marker::Begin(canonical_uuid(rest)?)));
    }
    if let Some(rest) = line.strip_prefix("# vps-pilot:end ") {
        return Ok(Some(Marker::End(canonical_uuid(rest)?)));
    }
    Err(
        "The SSH config contains a malformed VPS Pilot ownership marker. It was not changed."
            .into(),
    )
}

fn scan_blocks(text: &str) -> Result<Vec<Block>, String> {
    let mut blocks = Vec::new();
    let mut open: Option<(String, usize, usize)> = None;
    for line in text_lines(text) {
        match parse_marker(line.text)? {
            Some(Marker::Begin(id)) => {
                if open.is_some() {
                    return Err(
                        "The SSH config contains nested VPS Pilot ownership markers. It was not changed."
                            .into(),
                    );
                }
                open = Some((id, line.start, line.end));
            }
            Some(Marker::End(id)) => {
                let Some((begin_id, start, body_start)) = open.take() else {
                    return Err(
                        "The SSH config contains an end marker without a begin marker. It was not changed."
                            .into(),
                    );
                };
                if begin_id != id {
                    return Err(
                        "The SSH config contains mismatched VPS Pilot ownership markers. It was not changed."
                            .into(),
                    );
                }
                if blocks.iter().any(|block: &Block| block.id == id) {
                    return Err(
                        "The SSH config contains duplicate VPS Pilot markers for this profile. It was not changed."
                            .into(),
                    );
                }
                blocks.push(Block {
                    id,
                    start,
                    end: line.end,
                    body_start,
                    end_start: line.start,
                });
            }
            None => {}
        }
    }
    if open.is_some() {
        return Err(
            "The SSH config contains an unterminated VPS Pilot ownership marker. It was not changed."
                .into(),
        );
    }
    Ok(blocks)
}

fn validate_owned_block(text: &str, block: &Block) -> Result<(), String> {
    let body = &text[block.body_start..block.end_start];
    let lines: Vec<&str> = body
        .lines()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    if lines.len() != 8 {
        return Err(
            "The existing VPS Pilot SSH config block contains directives the app did not add. It was not changed."
                .into(),
        );
    }
    let alias = lines[0].strip_prefix("Host ").ok_or_else(|| {
        "The existing VPS Pilot SSH config block does not match the supported schema. It was not changed."
            .to_string()
    })?;
    validate_alias(alias)?;
    let host = lines[1].strip_prefix("    HostName ").ok_or_else(|| {
        "The existing VPS Pilot SSH config block does not match the supported schema. It was not changed."
            .to_string()
    })?;
    validate_host(host)?;
    let username = lines[2].strip_prefix("    User ").ok_or_else(|| {
        "The existing VPS Pilot SSH config block does not match the supported schema. It was not changed."
            .to_string()
    })?;
    validate_username(username)?;
    let port = lines[3].strip_prefix("    Port ").ok_or_else(|| {
        "The existing VPS Pilot SSH config block does not match the supported schema. It was not changed."
            .to_string()
    })?;
    if !port.parse::<u16>().is_ok_and(|value| value > 0) {
        return Err(
            "The existing VPS Pilot SSH config block does not match the supported schema. It was not changed."
                .into(),
        );
    }
    let file_name = lines[4]
        .strip_prefix("    IdentityFile ~/.ssh/")
        .ok_or_else(|| {
            "The existing VPS Pilot SSH config block does not match the supported schema. It was not changed."
                .to_string()
        })?;
    validate_file_name(file_name)?;
    if lines[5] != "    IdentitiesOnly yes"
        || lines[6] != "    PreferredAuthentications publickey"
        || lines[7] != "Host *"
    {
        return Err(
            "The existing VPS Pilot SSH config block does not match the supported schema. It was not changed."
                .into(),
        );
    }
    Ok(())
}

fn scan_unsupported(text: &str) -> Result<(), String> {
    if text.contains('\0') {
        return Err(
            "The SSH config contains unsupported control bytes. It was not changed.".into(),
        );
    }
    for line in text_lines(text) {
        let trimmed = line.text.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.text.trim_end().ends_with('\\') {
            return Err(
                "The SSH config uses line continuations, which this reviewed export does not support. No change was made."
                    .into(),
            );
        }
        let first = trimmed.split_whitespace().next().unwrap_or_default();
        let directive = first.split('=').next().unwrap_or_default();
        for blocked in ["Include", "Match", "IgnoreUnknown"] {
            if directive.eq_ignore_ascii_case(blocked) {
                return Err(format!(
                    "The SSH config uses {blocked}, which this reviewed export does not support. No change was made."
                ));
            }
        }
        if directive.eq_ignore_ascii_case("Host") {
            // Refuse forms whose alias set cannot be classified reliably for
            // collision checks. Never let an ambiguous Host line bypass them.
            if first.contains('=') || first.len() != 4 {
                return Err(
                    "The SSH config contains an ambiguous Host form. No change was made.".into(),
                );
            }
            let rest = trimmed.get(4..).unwrap_or_default().trim_start();
            if rest.is_empty()
                || rest.starts_with('=')
                || rest.contains(['"', '\''])
                || rest.split_whitespace().any(|token| {
                    token
                        .bytes()
                        .any(|byte| !(byte.is_ascii_alphanumeric() || b"._-*?!".contains(&byte)))
                })
            {
                return Err(
                    "The SSH config contains an ambiguous Host form. No change was made.".into(),
                );
            }
        }
    }
    Ok(())
}

fn literal_aliases(text: &str, blocks: &[Block], excluded: Option<usize>) -> HashSet<String> {
    let mut aliases = HashSet::new();
    // Skip only the block being replaced. Every other managed or unmanaged
    // Host line must participate in collision detection.
    let ranges: Vec<(usize, usize)> = blocks
        .iter()
        .filter(|block| Some(block.start) == excluded)
        .map(|block| (block.start, block.end))
        .collect();
    for line in text_lines(text) {
        if ranges
            .iter()
            .any(|(start, end)| line.start >= *start && line.start < *end)
        {
            continue;
        }
        let trimmed = line.text.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        if !parts
            .next()
            .is_some_and(|token| token.eq_ignore_ascii_case("Host"))
        {
            continue;
        }
        for token in parts {
            let token = token.trim_matches('"');
            if token.is_empty()
                || token.starts_with('!')
                || token.contains(['*', '?'])
                || !token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            {
                continue;
            }
            aliases.insert(token.to_ascii_lowercase());
        }
    }
    aliases
}

fn build_entry(request: &PrepareRequest, profile_id: &str) -> String {
    format!(
        "# vps-pilot:begin {profile_id}\nHost {}\n    HostName {}\n    User {}\n    Port {}\n    IdentityFile ~/.ssh/{}\n    IdentitiesOnly yes\n    PreferredAuthentications publickey\nHost *\n# vps-pilot:end {profile_id}\n",
        request.alias, request.host, request.username, request.port, request.file_name
    )
}

fn field_value(params: &ssh2_config::HostParams, name: &str) -> Option<String> {
    params
        .unsupported_fields
        .iter()
        .chain(params.ignored_fields.iter())
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, values)| values.first())
        .cloned()
}

fn validate_effective(
    candidate: &str,
    home: &Path,
    root: &Path,
    request: &PrepareRequest,
) -> Result<(), String> {
    let config = SshConfig::default()
        .home_dir(home)
        .parse(
            &mut Cursor::new(candidate.as_bytes()),
            ParseRule::ALLOW_UNSUPPORTED_FIELDS,
        )
        .map_err(|_| {
            "The generated SSH config could not be parsed safely. No change was made.".to_string()
        })?;
    let params = config.query(&request.alias);
    if params.host_name.as_deref() != Some(request.host.as_str()) {
        return Err(
            "The reviewed alias would not resolve to the saved server host. No change was made."
                .into(),
        );
    }
    if params.user.as_deref() != Some(request.username.as_str()) {
        return Err(
            "The reviewed alias would not resolve to the target account. No change was made."
                .into(),
        );
    }
    if params.port != Some(request.port) {
        return Err(
            "The reviewed alias would not resolve to the target SSH port. No change was made."
                .into(),
        );
    }
    let expected_identity = root.join(&request.file_name);
    match params.identity_file.as_deref() {
        Some([only]) if only == &expected_identity => {}
        _ => {
            return Err(
                "The reviewed alias would not use the selected key as its sole explicit identity. No change was made."
                    .into(),
            )
        }
    }
    if field_value(&params, "identitiesonly").as_deref() != Some("yes") {
        return Err(
            "The reviewed alias would not set IdentitiesOnly yes. No change was made.".into(),
        );
    }
    let preferred = field_value(&params, "preferredauthentications").unwrap_or_default();
    let methods: Vec<&str> = preferred
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    if methods.len() != 1 || !methods[0].eq_ignore_ascii_case("publickey") {
        return Err(
            "The reviewed alias would not prefer public-key authentication only. No change was made."
                .into(),
        );
    }
    if !params.ignored_fields.is_empty() {
        return Err(
            "The SSH config contains unknown directives that cannot be validated. No change was made."
                .into(),
        );
    }
    if params.pubkey_authentication == Some(false) {
        return Err(
            "The SSH config disables public-key authentication for this alias. No change was made."
                .into(),
        );
    }
    if params.certificate_file.is_some() {
        return Err(
            "The SSH config requires a host certificate for this alias. No change was made.".into(),
        );
    }
    if params.bind_address.is_some() || params.bind_interface.is_some() {
        return Err(
            "The SSH config binds this alias to a local interface. No change was made.".into(),
        );
    }
    if params
        .proxy_jump
        .as_ref()
        .is_some_and(|jumps| jumps.iter().any(|jump| !jump.eq_ignore_ascii_case("none")))
    {
        return Err(
            "The SSH config routes this alias through a jump host. No change was made.".into(),
        );
    }
    for name in [
        "proxycommand",
        "localcommand",
        "remotecommand",
        "knownhostscommand",
        "userknownhostsfile",
        "globalknownhostsfile",
        "verifyhostkeydns",
        "hostcertificate",
        "hostkeyalias",
        "canonicaldomains",
        "canonicalizepermittedcnames",
        "pkcs11provider",
        "securitykeyprovider",
    ] {
        if field_value(&params, name).is_some() {
            return Err(format!(
                "The SSH config inherits an unsupported {name} setting. No change was made."
            ));
        }
    }
    for name in [
        "permitlocalcommand",
        "canonicalizehostname",
        "hostbasedauthentication",
        "stricthostkeychecking",
    ] {
        if let Some(value) = field_value(&params, name) {
            let normalized = value.to_ascii_lowercase();
            let disabled = matches!(normalized.as_str(), "no" | "off" | "false");
            if name == "stricthostkeychecking" {
                if disabled {
                    return Err(
                        "The SSH config disables strict host-key checking. No change was made."
                            .into(),
                    );
                }
            } else if !disabled {
                return Err(format!(
                    "The SSH config inherits an unsupported {name} setting. No change was made."
                ));
            }
        }
    }
    Ok(())
}

fn validate_dirs(root: &Path) -> Result<u32, String> {
    let owner = validate_standard_root(root)?;
    let home = root
        .parent()
        .ok_or_else(|| "The home folder is unavailable.".to_string())?;
    let metadata =
        fs::symlink_metadata(home).map_err(|_| "The home folder is unavailable.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err("The home folder is not a private directory.".into());
    }
    if metadata.uid() != owner {
        return Err(
            "The home folder belongs to another account. It was not used or changed.".into(),
        );
    }
    if metadata.mode() & 0o022 != 0 || metadata.mode() & 0o7000 != 0 {
        return Err(
            "The home folder is writable by other users. It was not used or changed.".into(),
        );
    }
    Ok(owner)
}

fn read_source(root: &Path, owner: u32) -> Result<(SourceSnapshot, Vec<u8>), String> {
    let path = root.join("config");
    let before = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((
                SourceSnapshot {
                    exists: false,
                    dev: 0,
                    ino: 0,
                    sha256: [0u8; 32],
                },
                Vec::new(),
            ))
        }
        Err(_) => return Err("The SSH config is unavailable. It was not changed.".into()),
    };
    if before.file_type().is_symlink() || !before.file_type().is_file() {
        return Err("The SSH config is not a regular file. It was not changed.".into());
    }
    if before.uid() != owner {
        return Err("The SSH config belongs to another account. It was not changed.".into());
    }
    if before.nlink() != 1 {
        return Err("The SSH config has unexpected links. It was not changed.".into());
    }
    if before.mode() & 0o022 != 0 || before.mode() & 0o7000 != 0 {
        return Err("The SSH config has insecure permissions. It was not changed.".into());
    }
    if before.len() > MAX_CONFIG_BYTES as u64 {
        return Err(
            "The SSH config is larger than the supported 128 KiB limit. It was not changed.".into(),
        );
    }
    let file = File::open(&path)
        .map_err(|_| "The SSH config is unreadable. It was not changed.".to_string())?;
    let opened = file
        .metadata()
        .map_err(|_| "The SSH config is unreadable. It was not changed.".to_string())?;
    if opened.dev() != before.dev()
        || opened.ino() != before.ino()
        || opened.nlink() != 1
        || opened.uid() != owner
        || opened.mode() & 0o022 != 0
        || opened.mode() & 0o7000 != 0
    {
        return Err("The SSH config changed while it was being read. It was not changed.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The SSH config is unreadable. It was not changed.".to_string())?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(
            "The SSH config is larger than the supported 128 KiB limit. It was not changed.".into(),
        );
    }
    Ok((
        SourceSnapshot {
            exists: true,
            dev: before.dev(),
            ino: before.ino(),
            sha256: digest(&bytes),
        },
        bytes,
    ))
}

fn open_lock(root: &Path, owner: u32) -> Result<File, String> {
    let path = root.join(LOCK_NAME);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => validate_lock(&metadata, owner)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true).mode(0o600);
            match options.open(&path) {
                Ok(file) => {
                    file.set_permissions(fs::Permissions::from_mode(0o600))
                        .map_err(|_| "The SSH config lock could not be protected.".to_string())?;
                    return Ok(file);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => {
                    return Err(
                        "The SSH config writer lock could not be created. Nothing was written."
                            .into(),
                    )
                }
            }
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| "The SSH config writer lock is unavailable.".to_string())?;
            validate_lock(&metadata, owner)?;
        }
        Err(_) => {
            return Err("The SSH config writer lock is unavailable. Nothing was written.".into())
        }
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|_| "The SSH config writer lock is unavailable. Nothing was written.".to_string())
}

fn validate_lock(metadata: &fs::Metadata, owner: u32) -> Result<(), String> {
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.uid() != owner
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
        || metadata.mode() & 0o7000 != 0
    {
        return Err("The SSH config writer lock is not a private regular file.".into());
    }
    Ok(())
}

fn apply_entry(text: &str, profile_id: &str, entry: &str) -> Result<String, String> {
    let blocks = scan_blocks(text)?;
    if let Some(block) = blocks.iter().find(|block| block.id == profile_id) {
        validate_owned_block(text, block)?;
        Ok(format!(
            "{}{}{}",
            &text[..block.start],
            entry,
            &text[block.end..]
        ))
    } else {
        Ok(format!("{entry}{text}"))
    }
}

fn prepare_blocking(root: &Path, request: PrepareRequest) -> Result<Prepared, String> {
    let profile_id = canonical_uuid(&request.profile_id)?;
    validate_alias(&request.alias)?;
    validate_host(&request.host)?;
    validate_username(&request.username)?;
    if request.port == 0 {
        return Err("The reviewed SSH port is invalid.".into());
    }
    validate_file_name(&request.file_name)?;
    let owner = validate_dirs(root)?;
    let (source, bytes) = read_source(root, owner)?;
    let text = if source.exists {
        std::str::from_utf8(&bytes).map_err(|_| {
            "The SSH config is not valid UTF-8 text. It was not changed.".to_string()
        })?
    } else {
        ""
    };
    scan_unsupported(text)?;
    let blocks = scan_blocks(text)?;
    let entry = build_entry(&request, &profile_id);
    let own = blocks.iter().find(|block| block.id == profile_id);
    let aliases = literal_aliases(text, &blocks, own.map(|block| block.start));
    if aliases.contains(&request.alias.to_ascii_lowercase()) {
        return Err(
            "Another SSH config entry already uses this alias. Choose a different alias; nothing was changed."
                .into(),
        );
    }
    let (candidate, mode, backup) = match own {
        Some(block) => {
            validate_owned_block(text, block)?;
            if &text[block.start..block.end] == entry.as_str() {
                (text.to_string(), "noChange", false)
            } else {
                (
                    format!("{}{}{}", &text[..block.start], entry, &text[block.end..]),
                    "update",
                    true,
                )
            }
        }
        None => (format!("{entry}{text}"), "create", source.exists),
    };
    scan_unsupported(&candidate)?;
    let home = root
        .parent()
        .ok_or_else(|| "The home folder is unavailable.".to_string())?;
    validate_effective(&candidate, home, root, &request)?;
    Ok(Prepared {
        entry,
        mode,
        backup,
        source,
        candidate_sha256: digest(candidate.as_bytes()),
    })
}

fn write_backup(root: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let mut temporary = Builder::new()
        .prefix(".vps-pilot-config-backup-")
        .suffix(".tmp")
        .tempfile_in(root)
        .map_err(|_| {
            "The protected SSH config backup could not be staged. Nothing was written.".to_string()
        })?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| {
            "The protected SSH config backup could not be protected. Nothing was written."
                .to_string()
        })?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| {
            "The protected SSH config backup could not be written. Nothing was written.".to_string()
        })?;
    let path = root.join(format!(".vps-pilot-config-backup-{}", Uuid::new_v4()));
    temporary.persist_noclobber(&path).map_err(|_| {
        "The protected SSH config backup could not be published. Nothing was written.".to_string()
    })?;
    Ok(path)
}

fn publish_blocking(
    root: &Path,
    profile_id: &str,
    entry: &str,
    expected_source: SourceSnapshot,
    expected_candidate: [u8; 32],
    deadline: Instant,
) -> Result<Saved, String> {
    if Instant::now() >= deadline {
        return Err("The SSH config review expired. Nothing was written.".into());
    }
    let owner = validate_dirs(root)?;
    let _lock = open_lock(root, owner)?;
    if let Err(error) = _lock.try_lock() {
        let _ = error;
        return Err("Another VPS Pilot SSH config update is running. Nothing was written.".into());
    }
    let (current_source, current_bytes) = read_source(root, owner)?;
    if current_source != expected_source {
        return Err(
            "The SSH config changed since it was reviewed. Nothing was overwritten; create a new review."
                .into(),
        );
    }
    let current_text = std::str::from_utf8(&current_bytes)
        .map_err(|_| "The SSH config is not valid UTF-8 text. It was not changed.".to_string())?;
    let candidate = apply_entry(current_text, profile_id, entry)?;
    if digest(candidate.as_bytes()) != expected_candidate {
        return Err(
            "The reviewed SSH config entry no longer matches the prepared file. Nothing was written."
                .into(),
        );
    }
    if candidate.as_bytes() == current_bytes.as_slice() {
        return Ok(Saved { backup_path: None });
    }
    let backup_path = if current_source.exists {
        Some(write_backup(root, &current_bytes)?)
    } else {
        None
    };
    let mut temporary = Builder::new()
        .prefix(".vps-pilot-config-")
        .suffix(".tmp")
        .tempfile_in(root)
        .map_err(|_| "The SSH config could not be staged. Nothing was written.".to_string())?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "The SSH config could not be protected. Nothing was written.".to_string())?;
    temporary
        .write_all(candidate.as_bytes())
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "The SSH config could not be staged. Nothing was written.".to_string())?;
    let (recheck, _) = read_source(root, owner)?;
    if recheck != expected_source {
        return Err(
            "The SSH config changed while it was being saved. Nothing was overwritten; create a new review."
                .into(),
        );
    }
    if validate_dirs(root)? != owner {
        return Err("The SSH folder identity changed while saving. Nothing was written.".into());
    }
    if Instant::now() >= deadline {
        return Err("The SSH config review expired while saving. Nothing was written.".into());
    }
    let target = root.join("config");
    if expected_source.exists {
        temporary.persist(&target).map_err(|_| {
            "The SSH config could not be replaced. The staged file was not published.".to_string()
        })?;
    } else {
        temporary.persist_noclobber(&target).map_err(|error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                "An SSH config appeared while saving. Nothing was overwritten.".to_string()
            } else {
                "The SSH config could not be created. Nothing was overwritten.".to_string()
            }
        })?;
    }
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| {
            "The SSH config was updated, but the SSH folder could not be synced. Verify it before relying on it."
                .to_string()
        })?;
    Ok(Saved { backup_path })
}

pub(super) async fn prepare(vault: &KeyVault, request: PrepareRequest) -> Result<Prepared, String> {
    let root = vault.standard_ssh_root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || prepare_blocking(&root, request))
        .await
        .map_err(|_| "The SSH config review could not complete.".to_string())?
}

pub(super) async fn publish(
    vault: &KeyVault,
    profile_id: String,
    entry: String,
    source: SourceSnapshot,
    candidate_sha256: [u8; 32],
    deadline: Instant,
) -> Result<Saved, String> {
    let root = vault.standard_ssh_root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        publish_blocking(
            &root,
            &profile_id,
            &entry,
            source,
            candidate_sha256,
            deadline,
        )
    })
    .await
    .map_err(|_| "The SSH config save could not complete.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::set_permissions(&home, fs::Permissions::from_mode(0o755)).unwrap();
        let root = home.join(".ssh");
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        (dir, root)
    }

    fn request() -> PrepareRequest {
        PrepareRequest {
            profile_id: Uuid::new_v4().to_string(),
            alias: "safe-alias".into(),
            host: "example.com".into(),
            username: "deploy".into(),
            port: 22,
            file_name: format!("vps-pilot_{}", Uuid::new_v4()),
        }
    }

    fn request_with_alias(alias: &str) -> PrepareRequest {
        let mut request = request();
        request.alias = alias.into();
        request
    }

    #[test]
    fn expired_publish_never_writes_the_config() {
        let (_dir, root) = fixture();
        let config = root.join("config");
        std::fs::write(&config, b"Host *\n    ServerAliveInterval 30\n").unwrap();
        std::fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
        let request = request();
        let profile_id = request.profile_id.clone();
        let prepared = prepare_blocking(&root, request).unwrap();
        let before = std::fs::read(&config).unwrap();
        let error = match publish_blocking(
            &root,
            &profile_id,
            &prepared.entry,
            prepared.source,
            prepared.candidate_sha256,
            Instant::now() - Duration::from_secs(1),
        ) {
            Ok(_) => panic!("an expired review must not publish"),
            Err(error) => error,
        };
        assert!(error.contains("expired"), "{error}");
        assert_eq!(std::fs::read(&config).unwrap(), before);
    }

    #[test]
    fn other_managed_blocks_participate_in_alias_collisions() {
        let (_dir, root) = fixture();
        let other = Uuid::new_v4().to_string();
        let other_key = Uuid::new_v4().to_string();
        let text = format!(
            "# vps-pilot:begin {other}\nHost taken\n    HostName taken.example.com\n    User ops\n    Port 22\n    IdentityFile ~/.ssh/vps-pilot_{other_key}\n    IdentitiesOnly yes\n    PreferredAuthentications publickey\nHost *\n# vps-pilot:end {other}\n"
        );
        std::fs::write(root.join("config"), &text).unwrap();
        std::fs::set_permissions(root.join("config"), fs::Permissions::from_mode(0o600)).unwrap();
        let error = match prepare_blocking(&root, request_with_alias("taken")) {
            Ok(_) => panic!("an alias in another managed block must collide"),
            Err(error) => error,
        };
        assert!(error.contains("alias"), "{error}");
        assert_eq!(std::fs::read_to_string(root.join("config")).unwrap(), text);
    }

    #[test]
    fn inherited_identity_and_host_trust_overrides_refuse_export() {
        for directive in [
            "IdentityFile ~/.ssh/another-key",
            "UserKnownHostsFile /dev/null",
            "GlobalKnownHostsFile /dev/null",
            "VerifyHostKeyDNS yes",
            "StrictHostKeyChecking no",
            "ProxyCommand false",
            "RemoteCommand false",
        ] {
            let (_dir, root) = fixture();
            let config = root.join("config");
            let text = format!("Host *\n    {directive}\n");
            std::fs::write(&config, &text).unwrap();
            std::fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(prepare_blocking(&root, request()).is_err(), "{directive}");
            assert_eq!(std::fs::read_to_string(&config).unwrap(), text);
        }
    }
}
