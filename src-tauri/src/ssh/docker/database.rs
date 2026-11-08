//! Read-only, container-bound logical backups streamed into private local files.
use super::*;
use russh::ChannelMsg;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tauri_plugin_dialog::DialogExt;
use tokio::{io::AsyncWriteExt, sync::watch};
use zeroize::Zeroize;

const LIMIT: u64 = 100 * 1024 * 1024 * 1024;
#[derive(Default)]
pub struct DatabaseState(Mutex<HashMap<String, (String, watch::Sender<bool>)>>);
struct Lease<'a> {
    state: &'a DatabaseState,
    operation: String,
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.state.0.lock() {
            jobs.remove(&self.operation);
        }
    }
}
impl DatabaseState {
    fn begin(
        &self,
        operation: &str,
        profile: &str,
    ) -> Result<(Lease<'_>, watch::Receiver<bool>), String> {
        uuid::Uuid::parse_str(operation).map_err(|_| "Invalid database operation identity.")?;
        let mut jobs = self
            .0
            .lock()
            .map_err(|_| "Database state is unavailable.")?;
        if jobs.len() >= 4
            || jobs.contains_key(operation)
            || jobs.values().any(|(id, _)| id == profile)
        {
            return Err("Wait for the current database operation on this server.".into());
        }
        let (sender, receiver) = watch::channel(false);
        jobs.insert(operation.into(), (profile.into(), sender));
        Ok((
            Lease {
                state: self,
                operation: operation.into(),
            },
            receiver,
        ))
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    profile_id: String,
    profile_revision: String,
    connection_id: String,
    container: String,
    engine: String,
    username: String,
    password: String,
    auth_database: String,
    database: String,
    #[serde(default)]
    engine_id: String,
    #[serde(default)]
    image_id: String,
    #[serde(default)]
    started_at: String,
}
impl Drop for Request {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}
impl Request {
    fn validate(&self) -> Result<(), String> {
        super::id(&self.container)?;
        if !["postgres", "mysql", "mariadb", "mongodb"].contains(&self.engine.as_str()) {
            return Err("Choose PostgreSQL, MySQL, MariaDB or MongoDB.".into());
        }
        for value in [&self.username, &self.auth_database, &self.database] {
            if value.len() > 256 || value.chars().any(char::is_control) {
                return Err(
                    "Database parameters must be at most 256 bytes without control characters."
                        .into(),
                );
            }
        }
        if self.password.len() > 4096 || self.password.chars().any(char::is_control) {
            return Err(
                "Passwords with control characters are not supported; nothing was sent.".into(),
            );
        }
        if self.engine_id.len() > 256 || self.image_id.len() > 256 || self.started_at.len() > 128 {
            return Err("Invalid Docker identity. List databases again.".into());
        }
        Ok(())
    }
    fn payload(&self, operation: &str) -> Result<Zeroizing<String>, String> {
        self.validate()?;
        let mut value =
            serde_json::to_value(self).map_err(|_| "Cannot prepare private database request.")?;
        value["operation"] = operation.into();
        // Serialize credentials only into the private stdin buffer, never argv.
        let result = Zeroizing::new(
            serde_json::to_string(&value).map_err(|_| "Cannot prepare private request.")? + "\n",
        );
        if let Some(Value::String(password)) = value.get_mut("password") {
            password.zeroize();
        }
        Ok(result)
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    bytes: u64,
    sha256: String,
    destination: String,
}

fn valid_backup_header(engine: &str, prefix: &[u8]) -> bool {
    match engine {
        "postgres" => prefix.starts_with(b"PGDMP"),
        "mongodb" => prefix.starts_with(&[0x1f, 0x8b]),
        "mysql" | "mariadb" => prefix.starts_with(b"--") || prefix.starts_with(b"/*"),
        _ => false,
    }
}

async fn current(service: &SshService, request: &Request) -> Result<(), String> {
    if service.profile(&request.profile_id)?.revision != request.profile_revision {
        return Err("Server profile changed. List databases again.".into());
    }
    let runtime = service.runtime.lock().await;
    if runtime.connection_ids.get(&request.profile_id) != Some(&request.connection_id)
        || !runtime
            .connections
            .get(&request.profile_id)
            .is_some_and(|handle| !handle.is_closed())
    {
        return Err("SSH connection changed. List databases again.".into());
    }
    Ok(())
}
async fn run(
    service: &SshService,
    request: &Request,
    operation: &str,
    cancel: &mut watch::Receiver<bool>,
    mut file: Option<&mut tokio::fs::File>,
    progress: Option<&tauri::ipc::Channel<Progress>>,
) -> Result<(Vec<u8>, u64, String), String> {
    if *cancel.borrow() {
        return Err("Database operation canceled.".into());
    }
    current(service, request).await?;
    let payload = request.payload(operation)?;
    let mut channel = {
        let runtime = service.runtime.lock().await;
        if runtime.connection_ids.get(&request.profile_id) != Some(&request.connection_id) {
            return Err("SSH connection changed before opening the database channel.".into());
        }
        let handle = runtime
            .connections
            .get(&request.profile_id)
            .ok_or("Connect to the server first.")?;
        timeout(NETWORK_TIMEOUT, handle.channel_open_session())
            .await
            .map_err(|_| "Database channel timed out.")?
            .map_err(|_| "Cannot open database channel.")?
    };
    let command = format!(
        "python3 -I -S -u -c {}",
        super::quoted(include_str!("../docker_database.py"))
    );
    let result = timeout(Duration::from_secs(if operation == "backup" { 3600 } else { 90 }), async {
        channel.exec(true, command).await.map_err(|_| "Cannot start database operation.")?;
        channel.data(payload.as_bytes()).await.map_err(|_| "Cannot send private database request.")?;
        channel.eof().await.map_err(|_| "Cannot finish database request.")?;
        let mut bytes = 0_u64; let mut prefix = Vec::new(); let mut output = Vec::new(); let mut code = None; let mut hash = Sha256::new(); let mut last = Instant::now();
        loop {
            if *cancel.borrow() { return Err("Database operation canceled. No complete backup was saved; the read-only client may take a moment to exit.".to_string()); }
            let message = tokio::select! { _ = cancel.changed() => { continue; }, message = channel.wait() => message };
            let Some(message) = message else { break; };
            match message {
                ChannelMsg::Data { data } => {
                    if prefix.len() < 8 { prefix.extend_from_slice(&data[..data.len().min(8 - prefix.len())]); }
                    bytes = bytes.checked_add(data.len() as u64).ok_or("Backup size exceeded its limit.")?;
                    if bytes > if file.is_some() { LIMIT } else { 1024 * 1024 } { return Err("Database output exceeded its limit. No complete backup was saved.".into()); }
                    if let Some(writer) = file.as_mut() { writer.write_all(&data).await.map_err(|_| "Cannot write backup. Check free space and destination permissions.")?; hash.update(&data); } else { output.extend_from_slice(&data); }
                    if last.elapsed() >= Duration::from_secs(1) { if let Some(progress) = progress { let _ = progress.send(Progress { bytes }); } last = Instant::now(); }
                }
                // Database error output can contain sensitive data. Return fixed advice.
                ChannelMsg::ExtendedData { .. } => {},
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Failure => return Err("Database command was refused.".into()),
                _ => {},
            }
        }
        if code != Some(0) { return Err("Database operation failed. Check credentials, database privileges, selected engine and client/dump tools inside the running container. Python 3 and Docker socket access are required on the VPS. List databases again before retrying; no complete backup was saved.".into()); }
        if operation == "backup" && bytes == 0 { return Err("Database tool returned an empty backup. No backup was saved.".into()); }
        if operation == "backup" && !valid_backup_header(&request.engine, &prefix) { return Err("Database output did not match the expected backup format. No backup was saved.".into()); }
        current(service, request).await?;
        if let Some(progress) = progress { let _ = progress.send(Progress { bytes }); }
        Ok((output, bytes, format!("{:x}", hash.finalize())))
    }).await.map_err(|_| "Database operation timed out. No complete backup was saved; the read-only client may still be exiting.".to_string()).and_then(|r| r);
    let _ = channel.close().await;
    result
}
#[tauri::command]
pub async fn ssh_database_list(
    service: tauri::State<'_, SshService>,
    state: tauri::State<'_, DatabaseState>,
    request: Request,
    operation_id: String,
) -> Result<Value, String> {
    let (_lease, mut cancel) = state.begin(&operation_id, &request.profile_id)?;
    let (output, _, _) = run(&service, &request, "list", &mut cancel, None, None).await?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|_| "Database client returned an unsupported list.")?;
    for key in ["engineId", "imageId", "startedAt"] {
        if !value[key].as_str().is_some_and(|value| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        }) {
            return Err("Invalid Docker identity in database inventory.".into());
        }
    }
    let databases = value["databases"]
        .as_array()
        .filter(|list| list.len() <= 1000)
        .ok_or("Invalid database list.")?;
    if databases.iter().any(|name| {
        !name
            .as_str()
            .is_some_and(|name| name.len() <= 256 && !name.chars().any(char::is_control))
    }) {
        return Err("Unsupported database name in response.".into());
    }
    Ok(value)
}
#[tauri::command]
pub async fn ssh_database_backup(
    app: tauri::AppHandle,
    service: tauri::State<'_, SshService>,
    state: tauri::State<'_, DatabaseState>,
    request: Request,
    operation_id: String,
    progress: tauri::ipc::Channel<Progress>,
) -> Result<Option<BackupResult>, String> {
    request.validate()?;
    if request.database.is_empty()
        || request.database.starts_with('-')
        || request.engine_id.is_empty()
        || request.image_id.is_empty()
        || request.started_at.is_empty()
    {
        return Err("List databases and select one before downloading a backup.".into());
    }
    let (_lease, mut cancel) = state.begin(&operation_id, &request.profile_id)?;
    current(&service, &request).await?;
    let extension = match request.engine.as_str() {
        "postgres" => "dump",
        "mongodb" => "archive.gz",
        _ => "sql",
    };
    let safe: String = request
        .database
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    let name = format!("{safe}-{}.{}", uuid::Uuid::new_v4(), extension);
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Save database backup (new file only)")
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|_| "Save dialog is unavailable.")?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let destination = selected
        .into_path()
        .map_err(|_| "Choose a local file destination.")?;
    if *cancel.borrow() {
        return Err("Backup canceled before download.".into());
    }
    if destination.exists() {
        return Err("Backup destination already exists. Choose a new filename; existing files are never overwritten.".into());
    }
    let temporary =
        tempfile::NamedTempFile::new_in(destination.parent().ok_or("Choose a local destination.")?)
            .map_err(|_| "Cannot create a private local backup file.")?;
    let mut writer = tokio::fs::File::from_std(
        temporary
            .reopen()
            .map_err(|_| "Cannot open private backup file.")?,
    );
    let (_, bytes, sha256) = run(
        &service,
        &request,
        "backup",
        &mut cancel,
        Some(&mut writer),
        Some(&progress),
    )
    .await?;
    writer
        .flush()
        .await
        .map_err(|_| "Cannot flush backup file.")?;
    writer
        .sync_all()
        .await
        .map_err(|_| "Cannot finish saving backup file.")?;
    drop(writer);
    current(&service, &request).await?;
    if *cancel.borrow() {
        return Err("Backup canceled. No complete backup was saved.".into());
    }
    temporary.persist_noclobber(&destination).map_err(|_| {
        "Cannot publish backup without overwriting an existing file. Choose another destination."
    })?;
    Ok(Some(BackupResult {
        bytes,
        sha256,
        destination: destination.to_string_lossy().into_owned(),
    }))
}
#[tauri::command]
pub fn ssh_database_cancel(
    state: tauri::State<'_, DatabaseState>,
    profile_id: String,
    operation_id: String,
) -> Result<(), String> {
    let jobs = state.0.lock().map_err(|_| "Database state unavailable.")?;
    if let Some((profile, cancel)) = jobs.get(&operation_id) {
        if profile != &profile_id {
            return Err("Database operation belongs to another server.".into());
        }
        let _ = cancel.send(true);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        Request {
            profile_id: "fixture".into(),
            profile_revision: "revision".into(),
            connection_id: "connection".into(),
            container: "a".repeat(64),
            engine: "postgres".into(),
            username: "postgres".into(),
            password: "private-test-secret".into(),
            auth_database: "admin".into(),
            database: "fixture".into(),
            engine_id: "engine".into(),
            image_id: "image".into(),
            started_at: "start".into(),
        }
    }
    #[test]
    fn successful_exit_alone_is_not_a_backup_format_check() {
        assert!(valid_backup_header("postgres", b"PGDMP\0"));
        assert!(valid_backup_header("mongodb", &[0x1f, 0x8b, 8]));
        assert!(valid_backup_header("mysql", b"-- MySQL"));
        assert!(valid_backup_header("mariadb", b"/*M!9999"));
        for engine in ["postgres", "mysql", "mariadb", "mongodb"] {
            assert!(!valid_backup_header(engine, b"Login banner"));
            assert!(!valid_backup_header(engine, b""));
        }
    }
    #[test]
    fn credentials_stay_in_private_payload_and_validation_refuses_control_data() {
        let mut request = request();
        let payload = request.payload("backup").unwrap();
        assert!(payload.contains("private-test-secret"));
        let command = format!(
            "python3 -I -S -u -c {}",
            super::super::quoted(include_str!("../docker_database.py"))
        );
        assert!(!command.contains(&request.password));
        request.password = "bad\npassword".into();
        assert!(request.validate().is_err());
        request.password.clear();
        request.container = "$(danger)".into();
        assert!(request.validate().is_err());
        request.container = "b".repeat(64);
        request.engine = "arbitrary-command".into();
        assert!(request.validate().is_err());
    }
    #[test]
    fn one_job_per_server_and_cancellation_are_scoped_and_leases_release() {
        let state = DatabaseState::default();
        let id = uuid::Uuid::new_v4().to_string();
        let (lease, receiver) = state.begin(&id, "one").unwrap();
        assert!(state
            .begin(&uuid::Uuid::new_v4().to_string(), "one")
            .is_err());
        assert!(state.begin("not-a-uuid", "two").is_err());
        state
            .0
            .lock()
            .unwrap()
            .get(&id)
            .unwrap()
            .1
            .send(true)
            .unwrap();
        assert!(*receiver.borrow());
        drop(lease);
        assert!(state.0.lock().unwrap().is_empty());
        assert!(state.begin(&id, "one").is_ok());
    }
    #[test]
    fn private_download_staging_cleans_partial_files_and_never_overwrites() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("backup.dump");
        std::fs::write(&target, "original").unwrap();
        let staged;
        {
            let mut partial = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
            staged = partial.path().to_owned();
            partial.write_all(b"incomplete backup").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    partial.as_file().metadata().unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            assert!(partial.persist_noclobber(&target).is_err());
        }
        assert!(!staged.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
    }
}
