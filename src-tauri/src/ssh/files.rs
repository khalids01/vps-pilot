//! Bounded, explicit SFTP operations over an already authenticated connection.
use super::*;
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::HashSet,
    io::{Read, Write},
};
use tauri_plugin_dialog::DialogExt;
mod operations;
pub use operations::*;

const TEXT_LIMIT: usize = 1024 * 1024;
const TRANSFER_LIMIT: usize = 32 * 1024 * 1024;
const ENTRY_LIMIT: usize = 1000;
const OP_TIMEOUT: Duration = Duration::from_secs(180);
const REVIEW_TTL: Duration = Duration::from_secs(120);

#[derive(Default)]
pub(super) struct State {
    busy: Mutex<HashSet<String>>,
    reviews: Mutex<HashMap<String, Review>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    operations: operations::State,
}
impl State {
    pub(super) fn invalidate(&self, profile: &str) {
        if let Some(flag) = self
            .cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(profile)
        {
            flag.store(true, Ordering::SeqCst);
        }
        self.operations.invalidate(profile);
        self.reviews
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, review| review.reply.profile_id != profile);
    }
}
struct Lease<'a> {
    state: &'a State,
    id: String,
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        self.state
            .busy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
        self.state
            .cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}
struct Session {
    raw: RawSftpSession,
    connection: String,
    revision: String,
    extensions: HashMap<String, String>,
    cancel: Arc<AtomicBool>,
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.raw.close_session();
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    protected: bool,
    name: String,
    path: String,
    kind: &'static str,
    size: Option<u64>,
    permissions: Option<u32>,
    modified: Option<u32>,
    uid: Option<u32>,
    gid: Option<u32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    path: String,
    parent: String,
    entries: Vec<Entry>,
    truncated: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    path: String,
    content: String,
    revision: String,
    size: usize,
    permissions: Option<u32>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReply {
    pub token: String,
    pub profile_id: String,
    pub server_name: String,
    pub path: String,
    pub backup_path: Option<String>,
    pub operation: String,
    pub bytes: usize,
    pub expires_in_seconds: u64,
}
struct Review {
    reply: ReviewReply,
    issued: Instant,
    connection: String,
    profile_revision: String,
    original: Option<String>,
    data: Zeroizing<Vec<u8>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub path: String,
    pub backup_path: Option<String>,
    pub revision: String,
}

fn error(error: SftpError) -> String {
    match error {
        SftpError::Status(status) if status.status_code == StatusCode::PermissionDenied => {
            "SFTP permission denied. Use a path accessible to your SSH user.".into()
        }
        SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile => {
            "The remote path no longer exists. Refresh the folder.".into()
        }
        SftpError::Timeout => {
            "SFTP request timed out. Reopen the file before retrying a write.".into()
        }
        _ => "SFTP operation failed. Check the connection, path and permissions.".into(),
    }
}
fn missing(error: &SftpError) -> bool {
    matches!(error,SftpError::Status(status) if status.status_code==StatusCode::NoSuchFile)
}
fn path(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
        || (!value.starts_with('/') && value != ".")
    {
        return Err("Use an absolute remote path (or . for the SSH home directory).".into());
    }
    Ok(())
}
fn filename(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.len() > 255
        || value.contains('/')
        || value.chars().any(char::is_control)
    {
        return Err("Choose a valid file name up to 255 bytes.".into());
    }
    Ok(())
}
fn join(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}
fn parent(value: &str) -> &str {
    value
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or("/")
}
fn writable(value: &str) -> Result<(), String> {
    let protected = [
        "/proc",
        "/sys",
        "/dev",
        "/run",
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/boot",
        "/init",
        "/vmlinuz",
        "/initrd.img",
        "/var/lib",
        "/var/log",
        "/var/cache",
        "/var/spool",
        "/swapfile",
        "/swap.img",
        "/lost+found",
        "/lib32",
        "/snap",
        "/efi",
    ];
    if value == "/"
        || protected.iter().any(|root| {
            value == *root
                || value.starts_with(&format!("{root}/"))
                || root.starts_with(&format!("{value}/"))
        })
        || value.split('/').any(|part| {
            [
                ".ssh",
                ".gnupg",
                ".aws",
                ".kube",
                ".docker",
                "pgdata",
                "postgresql",
                "mysql",
                "mariadb",
                "mongodb",
                "redis",
                "docker",
                "containers",
                "volumes",
                ".bashrc",
                ".bash_profile",
                ".profile",
                ".zshrc",
                ".zprofile",
                ".pam_environment",
            ]
            .contains(&part.to_ascii_lowercase().as_str())
                || part.starts_with(".vps-pilot-backup-")
                || part.starts_with(".vps-pilot-transfer-")
                || part.starts_with(".vps-pilot-trash-")
        })
    {
        return Err("This path is protected from app writes. Files supports application and user files; system configuration and SSH credentials remain protected.".into());
    }
    Ok(())
}
fn digest(data: &[u8], attrs: &FileAttributes, target: &str, connection: &str) -> String {
    let mut hash = Sha256::new();
    for part in [
        target.as_bytes(),
        connection.as_bytes(),
        &serde_json::to_vec(&(
            attrs.size,
            attrs.permissions,
            attrs.uid,
            attrs.gid,
            attrs.mtime,
        ))
        .unwrap_or_default(),
        data,
    ] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    format!("{:x}", hash.finalize())
}
impl Session {
    fn check_cancel(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            Err("File operation cancelled.".into())
        } else {
            Ok(())
        }
    }
    async fn canonical(&self, value: &str) -> Result<String, String> {
        self.check_cancel()?;
        path(value)?;
        let names = self.raw.realpath(value).await.map_err(error)?;
        let result = names
            .files
            .first()
            .ok_or("SFTP returned no canonical path.")?
            .filename
            .clone();
        path(&result)?;
        if !result.starts_with('/') {
            return Err("SFTP did not return an absolute path.".into());
        }
        Ok(result)
    }
    async fn target(&self, value: &str) -> Result<String, String> {
        path(value)?;
        let name = value.rsplit('/').next().ok_or("Choose a file.")?;
        filename(name)?;
        let directory = self.canonical(parent(value)).await?;
        Ok(join(&directory, name))
    }
    async fn read(
        &self,
        target: &str,
        limit: usize,
    ) -> Result<(Zeroizing<Vec<u8>>, FileAttributes), String> {
        self.check_cancel()?;
        let before = self.raw.lstat(target).await.map_err(error)?.attrs;
        if !regular(&before) {
            return Err("Select a regular file. Symbolic links and special files are not opened for editing or transfer.".into());
        }
        if before.size.is_none_or(|size| size > limit as u64) {
            return Err(format!(
                "File exceeds the {} MiB limit.",
                limit / 1024 / 1024
            ));
        }
        self.check_cancel()?;
        let handle = self
            .raw
            .open(target, OpenFlags::READ, FileAttributes::default())
            .await
            .map_err(error)?
            .handle;
        let result = async {
            self.check_cancel()?;
            let opened = self.raw.fstat(&handle).await.map_err(error)?.attrs;
            if !same_metadata(&before, &opened) {
                return Err("File changed while opening. Open it again.".into());
            }
            let mut bytes = Zeroizing::new(Vec::new());
            loop {
                self.check_cancel()?;
                match self.raw.read(&handle, bytes.len() as u64, 32768).await {
                    Ok(data) => {
                        if data.data.is_empty() {
                            break;
                        }
                        if data.data.len() > 32768 || bytes.len() + data.data.len() > limit {
                            return Err("File grew beyond the transfer limit.".into());
                        }
                        bytes.extend_from_slice(&data.data);
                    }
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        break
                    }
                    Err(cause) => return Err(error(cause)),
                }
            }
            self.check_cancel()?;
            let after = self.raw.fstat(&handle).await.map_err(error)?.attrs;
            // Reading may update atime; compare only stable identity metadata.
            if !same_metadata(&before, &after) || after.size != Some(bytes.len() as u64) {
                return Err("File changed while reading. Open it again.".into());
            }
            Ok((bytes, after))
        }
        .await;
        let _ = self.raw.close(handle).await;
        result
    }
    async fn optional_read(
        &self,
        target: &str,
        limit: usize,
    ) -> Result<Option<(Zeroizing<Vec<u8>>, FileAttributes)>, String> {
        match self.raw.lstat(target).await {
            Err(cause) if missing(&cause) => Ok(None),
            Err(cause) => Err(error(cause)),
            Ok(_) => self.read(target, limit).await.map(Some),
        }
    }
    async fn create(&self, target: &str, data: &[u8], attrs: FileAttributes) -> Result<(), String> {
        self.check_cancel()?;
        let handle = self
            .raw
            .open(
                target,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                FileAttributes {
                    permissions: Some(0o600),
                    ..Default::default()
                },
            )
            .await
            .map_err(error)?
            .handle;
        let result = async {
            for (index, chunk) in data.chunks(32768).enumerate() {
                self.check_cancel()?;
                self.raw
                    .write(&handle, (index * 32768) as u64, chunk.to_vec())
                    .await
                    .map_err(error)?;
            }
            self.check_cancel()?;
            self.raw.fsetstat(&handle, attrs).await.map_err(error)?;
            if self
                .extensions
                .get("fsync@openssh.com")
                .is_some_and(|v| v == "1")
            {
                self.raw.fsync(&handle).await.map_err(error)?;
            }
            Ok(())
        }
        .await;
        let closed = self.raw.close(handle).await.map_err(error);
        let result = result.and(closed.map(|_| ()));
        if result.is_err() {
            let _ = self.raw.remove(target).await;
        }
        result
    }
    async fn replace(&self, source: &str, target: &str, existing: bool) -> Result<(), String> {
        self.check_cancel()?;
        if existing {
            let encoded = russh_sftp::ser::to_bytes(&(source, target))
                .map_err(|_| "Cannot encode SFTP replacement.")?;
            match self
                .raw
                .extended("posix-rename@openssh.com", encoded.to_vec())
                .await
                .map_err(error)?
            {
                Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
                _ => Err("Atomic replacement failed. Reopen the file to verify its state.".into()),
            }
        } else {
            self.raw
                .rename(source, target)
                .await
                .map(|_| ())
                .map_err(error)
        }
    }
}
fn regular(attrs: &FileAttributes) -> bool {
    attrs.permissions.map(|mode| mode & 0o170000) == Some(0o100000)
}
fn same_metadata(a: &FileAttributes, b: &FileAttributes) -> bool {
    a.size == b.size
        && a.permissions == b.permissions
        && a.uid == b.uid
        && a.gid == b.gid
        && a.mtime == b.mtime
}
impl SshService {
    fn file_lease(&self, id: &str) -> Result<Lease<'_>, String> {
        self.profile(id)?;
        let mut busy = self
            .files
            .busy
            .lock()
            .map_err(|_| "File operation state is unavailable.")?;
        if busy.len() >= 4 || !busy.insert(id.into()) {
            return Err("A file operation is already running. Wait for it to finish.".into());
        }
        self.files
            .cancels
            .lock()
            .map_err(|_| "Cancellation state unavailable.")?
            .insert(id.into(), Arc::new(AtomicBool::new(false)));
        Ok(Lease {
            state: &self.files,
            id: id.into(),
        })
    }
    async fn file_session(&self, id: &str) -> Result<Session, String> {
        let profile = self.profile(id)?;
        let (channel, connection) = {
            let runtime = self.runtime.lock().await;
            let handle = runtime
                .connections
                .get(id)
                .filter(|handle| !handle.is_closed())
                .ok_or("Connect this VPS before opening files.")?;
            let connection = runtime
                .connection_ids
                .get(id)
                .ok_or("The SSH connection is unavailable.")?
                .clone();
            let channel = timeout(NETWORK_TIMEOUT, handle.channel_open_session())
                .await
                .map_err(|_| "SFTP channel timed out.")?
                .map_err(|_| "Could not open an SFTP channel.")?;
            (channel, connection)
        };
        timeout(NETWORK_TIMEOUT, channel.request_subsystem(true, "sftp"))
            .await
            .map_err(|_| "SFTP startup timed out.")?
            .map_err(|_| "The server does not provide SFTP.")?;
        let raw = RawSftpSession::new(channel.into_stream());
        let extensions = raw.init().await.map_err(error)?.extensions;
        Ok(Session {
            raw,
            connection,
            revision: profile.revision,
            extensions,
            cancel: self
                .files
                .cancels
                .lock()
                .map_err(|_| "Cancellation state unavailable.")?
                .get(id)
                .cloned()
                .unwrap_or_default(),
        })
    }
    async fn file_current(&self, id: &str, session: &Session) -> Result<(), String> {
        session.check_cancel()?;
        if self.profile(id)?.revision != session.revision
            || self.runtime.lock().await.connection_ids.get(id) != Some(&session.connection)
        {
            return Err("The server connection changed. Reopen the file and review again.".into());
        }
        Ok(())
    }
    pub(super) async fn list_files(&self, id: &str, requested: &str) -> Result<Directory, String> {
        let _lease = self.file_lease(id)?;
        timeout(OP_TIMEOUT, async {
            let session = self.file_session(id).await?;
            let target = session.canonical(requested).await?;
            let handle = session.raw.opendir(&target).await.map_err(error)?.handle;
            let result = async {
                let mut entries = Vec::new();
                let mut truncated = false;
                'packets: for packet_index in 0..1001 {
                    session.check_cancel()?;
                    match session.raw.readdir(&handle).await {
                        Ok(batch) => {
                            for file in batch.files {
                                if file.filename == "." || file.filename == ".." {
                                    continue;
                                }
                                if filename(&file.filename).is_err() {
                                    continue;
                                }
                                if entries.len() >= ENTRY_LIMIT {
                                    truncated = true;
                                    break 'packets;
                                }
                                let attrs = file.attrs;
                                let kind = match attrs.permissions.map(|mode| mode & 0o170000) {
                                    Some(0o040000) => "directory",
                                    Some(0o100000) => "file",
                                    Some(0o120000) => "symlink",
                                    _ => "other",
                                };
                                entries.push(Entry {
                                    protected: operations::mutation_root(&join(
                                        &target,
                                        &file.filename,
                                    ))
                                    .is_err(),
                                    name: file.filename.clone(),
                                    path: join(&target, &file.filename),
                                    kind,
                                    size: attrs.size,
                                    permissions: attrs.permissions,
                                    modified: attrs.mtime,
                                    uid: attrs.uid,
                                    gid: attrs.gid,
                                });
                            }
                            if entries.len() >= ENTRY_LIMIT || packet_index == 1000 {
                                truncated = true;
                                break;
                            }
                        }
                        Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                            break
                        }
                        Err(cause) => return Err(error(cause)),
                    }
                }
                entries.sort_by(|a, b| {
                    (b.kind == "directory")
                        .cmp(&(a.kind == "directory"))
                        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                });
                self.file_current(id, &session).await?;
                Ok(Directory {
                    parent: parent(&target).into(),
                    path: target.clone(),
                    entries,
                    truncated,
                })
            }
            .await;
            let _ = session.raw.close(handle).await;
            result
        })
        .await
        .map_err(|_| "Directory listing timed out.")?
    }
    pub(super) async fn read_text(&self, id: &str, requested: &str) -> Result<TextFile, String> {
        let _lease = self.file_lease(id)?;
        timeout(OP_TIMEOUT, async {
            let session = self.file_session(id).await?;
            let target = session.target(requested).await?;
            let (bytes, attrs) = session.read(&target, TEXT_LIMIT).await?;
            if bytes.contains(&0) {
                return Err("Binary files can be downloaded, but cannot be edited as text.".into());
            }
            let content = String::from_utf8(bytes.to_vec())
                .map_err(|_| "Only UTF-8 text files up to 1 MiB can be edited.")?;
            self.file_current(id, &session).await?;
            Ok(TextFile {
                revision: digest(&bytes, &attrs, &target, &session.connection),
                path: target,
                content,
                size: bytes.len(),
                permissions: attrs.permissions,
            })
        })
        .await
        .map_err(|_| "Reading the file timed out.")?
    }
    pub(super) async fn file_review(
        &self,
        id: &str,
        requested: &str,
        data: Zeroizing<Vec<u8>>,
        expected: Option<&str>,
        operation: &str,
    ) -> Result<ReviewReply, String> {
        let _lease = self.file_lease(id)?;
        timeout(OP_TIMEOUT,async {
            let session=self.file_session(id).await?;
            let target=session.target(requested).await?;
            writable(&target)?;
            let original=session.optional_read(&target,TRANSFER_LIMIT).await?;
            if original.as_ref().is_some_and(|(_, attrs)| attrs.uid.is_none() || attrs.gid.is_none() || attrs.permissions.is_none_or(|mode| mode & 0o7000 != 0)) {
                return Err("Existing files need owner/mode metadata and no special permission bits for safe replacement.".into());
            }
            let fingerprint=original.as_ref().map(|(bytes,attrs)|digest(bytes,attrs,&target,&session.connection));
            if operation=="edit" && (expected.is_none() || fingerprint.as_deref()!=expected) {return Err("The file changed since it was opened. Reload it and review your changes again.".into());}
            if original.is_some() && !session.extensions.get("posix-rename@openssh.com").is_some_and(|version|version=="1") {return Err("This server does not support atomic replacement. Existing files will not be overwritten.".into());}
            let short_name:String=target.rsplit('/').next().unwrap_or("file").chars().scan(0,|bytes,c|{*bytes+=c.len_utf8();Some((*bytes,c))}).take_while(|(bytes,_)|*bytes<=64).map(|(_,c)|c).collect();
            let backup_path=original.as_ref().map(|_|join(&join(parent(&target),&format!(".vps-pilot-backup-{short_name}-{}",Uuid::new_v4())),"original"));
            let reply=ReviewReply{token:Uuid::new_v4().to_string(),profile_id:id.into(),server_name:self.profile(id)?.name,path:target,backup_path,operation:operation.into(),bytes:data.len(),expires_in_seconds:REVIEW_TTL.as_secs()};
            self.file_current(id,&session).await?;
            let mut reviews=self.files.reviews.lock().map_err(|_|"File review state is unavailable.")?;
            reviews.retain(|_,review|review.issued.elapsed()<REVIEW_TTL);
            if reviews.len()>=4 || reviews.values().map(|review|review.data.len()).sum::<usize>()+data.len()>64*1024*1024 {return Err("Close another file review before starting a new one.".into());}
            reviews.insert(reply.token.clone(),Review{reply:reply.clone(),issued:Instant::now(),connection:session.connection.clone(),profile_revision:session.revision.clone(),original:fingerprint,data});
            Ok(reply)
        }).await.map_err(|_|"Preparing the file review timed out.")?
    }
    pub(super) async fn review_text(
        &self,
        id: &str,
        path: &str,
        revision: &str,
        content: String,
    ) -> Result<ReviewReply, String> {
        if content.len() > TEXT_LIMIT || content.contains('\0') {
            return Err("Only UTF-8 text up to 1 MiB can be saved.".into());
        }
        self.file_review(
            id,
            path,
            Zeroizing::new(content.into_bytes()),
            Some(revision),
            "edit",
        )
        .await
    }
    pub(super) async fn commit_file(&self, id: &str, token: &str) -> Result<Receipt, String> {
        let _lease = self.file_lease(id)?;
        let review = {
            let mut reviews = self
                .files
                .reviews
                .lock()
                .map_err(|_| "File review state is unavailable.")?;
            if reviews
                .get(token)
                .is_none_or(|review| review.reply.profile_id != id)
            {
                return Err("This file review is unavailable for this server.".into());
            }
            reviews.remove(token).ok_or("Review the file again.")?
        };
        if review.issued.elapsed() >= REVIEW_TTL {
            return Err("The file review expired. Review it again.".into());
        }
        timeout(OP_TIMEOUT,async {
            let session=self.file_session(id).await?;
            if session.connection!=review.connection || session.revision!=review.profile_revision {return Err("The SSH connection changed. Reopen and review the file.".into());}
            let target=&review.reply.path;
            if session.target(target).await?!=*target {return Err("The destination directory changed. Review it again.".into());}
            writable(target)?;
            let original=session.optional_read(target,TRANSFER_LIMIT).await?;
            let fingerprint=original.as_ref().map(|(bytes,attrs)|digest(bytes,attrs,target,&session.connection));
            if fingerprint!=review.original {return Err("The destination changed after review. No replacement was made.".into());}
            let workdir=review.reply.backup_path.as_ref().map(|backup|parent(backup).to_string()).unwrap_or_else(||join(parent(target),&format!(".vps-pilot-transfer-{}",Uuid::new_v4())));
            session.check_cancel()?;
            session.raw.mkdir(&workdir,FileAttributes{permissions:Some(0o700),..Default::default()}).await.map_err(error)?;
            session.create(&join(&workdir,".gitignore"),b"*\n",FileAttributes{permissions:Some(0o600),..Default::default()}).await?;
            if let (Some(backup),Some((bytes,_)))=(&review.reply.backup_path,&original) {
                session.create(backup,bytes,FileAttributes{permissions:Some(0o600),..Default::default()}).await?;
            }
            let stage=join(&workdir,"staged");
            let attrs=original.as_ref().map(|(_,attrs)|FileAttributes{permissions:attrs.permissions.map(|mode|mode & 0o777),uid:attrs.uid,gid:attrs.gid,..Default::default()}).unwrap_or(FileAttributes{permissions:Some(0o600),..Default::default()});
            session.create(&stage,&review.data,attrs).await?;
            let result=async {
                let latest=session.optional_read(target,TRANSFER_LIMIT).await?;
                if latest.as_ref().map(|(bytes,attrs)|digest(bytes,attrs,target,&session.connection))!=review.original {return Err("The destination changed during staging. No replacement was made; the backup was retained.".into());}
                self.file_current(id,&session).await?;
                if session.target(target).await?!=*target {return Err("The destination directory changed during staging. Backup retained.".into());}
                session.replace(&stage,target,original.is_some()).await?;
                let (saved,attrs)=session.read(target,TRANSFER_LIMIT).await?;
                if *saved!=*review.data {return Err("Remote contents changed during verification. Reopen the file; the backup was retained.".into());}
                Ok(Receipt{revision:digest(&saved,&attrs,target,&session.connection),path:target.clone(),backup_path:review.reply.backup_path.clone()})
            }.await;
            if result.is_err() {let _=session.raw.remove(&stage).await;}
            if review.reply.backup_path.is_none() {
                let _=session.raw.remove(join(&workdir,".gitignore")).await;
                let _=session.raw.rmdir(&workdir).await;
            }
            result
        }).await.map_err(|_|"File save timed out. Reopen the destination to verify its state before retrying; a backup may have been created.")?
    }
}

#[tauri::command]
pub async fn ssh_files_list(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    path: String,
) -> Result<Directory, String> {
    service.list_files(&profile_id, &path).await
}
#[tauri::command]
pub async fn ssh_file_read(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    path: String,
) -> Result<TextFile, String> {
    service.read_text(&profile_id, &path).await
}
#[tauri::command]
pub async fn ssh_file_review(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    path: String,
    revision: String,
    content: String,
) -> Result<ReviewReply, String> {
    service
        .review_text(&profile_id, &path, &revision, content)
        .await
}
#[tauri::command]
pub async fn ssh_file_commit(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    token: String,
) -> Result<Receipt, String> {
    service.commit_file(&profile_id, &token).await
}
#[tauri::command]
pub fn ssh_file_reject(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    token: String,
) -> Result<(), String> {
    let mut reviews = service
        .files
        .reviews
        .lock()
        .map_err(|_| "File review state is unavailable.")?;
    if reviews
        .get(&token)
        .is_some_and(|review| review.reply.profile_id == profile_id)
    {
        reviews.remove(&token);
    }
    Ok(())
}
#[tauri::command]
pub async fn ssh_file_upload(
    app: tauri::AppHandle,
    service: tauri::State<'_, SshService>,
    profile_id: String,
    directory: String,
    name: Option<String>,
) -> Result<Option<ReviewReply>, String> {
    path(&directory)?;
    if let Some(name) = &name {
        filename(name)?;
    }
    service.profile(&profile_id)?;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a file to upload")
            .blocking_pick_file()
    })
    .await
    .map_err(|_| "File picker was unavailable.")?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected = selected.into_path().map_err(|_| "Choose a local file.")?;
    let (name, bytes) = tauri::async_runtime::spawn_blocking(move || {
        let name = name
            .or_else(|| selected.file_name()?.to_str().map(String::from))
            .ok_or("Choose a UTF-8 file name.")?;
        filename(&name)?;
        let file =
            std::fs::File::open(&selected).map_err(|_| "Cannot read the selected local file.")?;
        if !file
            .metadata()
            .map_err(|_| "Cannot read local file metadata.")?
            .is_file()
        {
            return Err("Choose a regular local file.".to_string());
        }
        let mut bytes = Zeroizing::new(Vec::new());
        file.take((TRANSFER_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read the selected local file.")?;
        if bytes.len() > TRANSFER_LIMIT {
            return Err("Transfers are limited to 32 MiB per file.".into());
        }
        Ok((name, bytes))
    })
    .await
    .map_err(|_| "Local file read failed.")??;
    service
        .file_review(&profile_id, &join(&directory, &name), bytes, None, "upload")
        .await
        .map(Some)
}
#[tauri::command]
pub async fn ssh_file_download(
    app: tauri::AppHandle,
    service: tauri::State<'_, SshService>,
    profile_id: String,
    path: String,
) -> Result<bool, String> {
    super::files::path(&path)?;
    service.profile(&profile_id)?;
    let name = path
        .rsplit('/')
        .next()
        .unwrap_or("download")
        .replace(['\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Download remote file")
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|_| "Save dialog was unavailable.")?;
    let Some(selected) = selected else {
        return Ok(false);
    };
    let destination = selected
        .into_path()
        .map_err(|_| "Choose a local destination.")?;
    let _lease = service.file_lease(&profile_id)?;
    let bytes = timeout(OP_TIMEOUT, async {
        let session = service.file_session(&profile_id).await?;
        let target = session.target(&path).await?;
        let (bytes, _) = session.read(&target, TRANSFER_LIMIT).await?;
        service.file_current(&profile_id, &session).await?;
        Ok::<_, String>(bytes)
    })
    .await
    .map_err(|_| "Download timed out.")??;
    tauri::async_runtime::spawn_blocking(move || {
        let mut temporary = tempfile::NamedTempFile::new_in(
            destination.parent().ok_or("Choose a local destination.")?,
        )
        .map_err(|_| "Cannot create a local download file.")?;
        temporary
            .write_all(&bytes)
            .map_err(|_| "Cannot save the download.")?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "Cannot finish saving the download.")?;
        temporary
            .persist(destination)
            .map_err(|_| "Cannot replace the chosen local file.")?;
        Ok::<_, String>(true)
    })
    .await
    .map_err(|_| "Local download save failed.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_modes_and_revision_boundaries_are_strict() {
        for value in ["", "relative/file", "/tmp/a\nfile"] {
            assert!(path(value).is_err());
        }
        for value in [".", "..", "a/b", "a\0b"] {
            assert!(filename(value).is_err());
        }
        for value in [
            "/etc/nginx/nginx.conf",
            "/root/.ssh/authorized_keys",
            "/var/lib/app/db",
            "/proc/self/status",
        ] {
            assert!(writable(value).is_err());
        }
        assert!(writable("/srv/app/settings.yaml").is_ok());
        let mut attrs = FileAttributes {
            permissions: Some(0o100640),
            size: Some(3),
            uid: Some(1000),
            gid: Some(1000),
            mtime: Some(4),
            atime: Some(1),
            ..Default::default()
        };
        let original = digest(b"one", &attrs, "/srv/app/a", "connection-a");
        attrs.atime = Some(99);
        assert_eq!(
            original,
            digest(b"one", &attrs, "/srv/app/a", "connection-a")
        );
        assert_ne!(
            original,
            digest(b"two", &attrs, "/srv/app/a", "connection-a")
        );
        assert_ne!(
            original,
            digest(b"one", &attrs, "/srv/app/a", "connection-b")
        );
        assert!(regular(&attrs));
        attrs.permissions = Some(0o120777);
        assert!(!regular(&attrs));
        attrs.permissions = Some(0o140600);
        assert!(!regular(&attrs));
    }
    #[tokio::test]
    #[ignore = "Run tests/fixtures/run-ssh.sh; disposable loopback-only OpenSSH SFTP fixture"]
    async fn disposable_openssh_sftp_files_are_backed_up_stale_checked_and_connection_bound() {
        let port: u16 = std::env::var("VPS_PILOT_OPENSSH_FIXTURE_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let key = std::env::var("VPS_PILOT_OPENSSH_FIXTURE_IDENTITY").unwrap();
        let fingerprint = std::env::var("VPS_PILOT_OPENSSH_FIXTURE_FINGERPRINT").unwrap();
        let local = tempfile::tempdir().unwrap();
        let service = SshService::new(local.path().join("profiles.json"));
        let profile = service
            .save_profile(ProfileInput {
                id: None,
                name: "Disposable SFTP fixture".into(),
                host: "127.0.0.1".into(),
                port,
                username: "root".into(),
                identity_file: Some(key),
                password_allowed: false,
            })
            .await
            .unwrap();
        let inspection = service.inspect(&profile.id).await.unwrap();
        assert_eq!(inspection.observed.fingerprint, fingerprint);
        service
            .trust(&profile.id, &inspection.challenge_id)
            .await
            .unwrap();
        service
            .connect(&profile.id, &inspection.challenge_id, "".into())
            .await
            .unwrap();
        let session = service.file_session(&profile.id).await.unwrap();
        let directory = format!("/root/vps-pilot-sftp-fixture-{}", Uuid::new_v4());
        session
            .raw
            .mkdir(
                &directory,
                FileAttributes {
                    permissions: Some(0o700),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let target = join(&directory, "app.yaml");
        session
            .create(
                &target,
                b"port: 3000\r\n",
                FileAttributes {
                    permissions: Some(0o640),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let listing = service.list_files(&profile.id, &directory).await.unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].kind, "file");
        let opened = service.read_text(&profile.id, &target).await.unwrap();
        assert_eq!(opened.content, "port: 3000\r\n");
        let plan = service
            .review_text(
                &profile.id,
                &target,
                &opened.revision,
                "port: 4000\r\n".into(),
            )
            .await
            .unwrap();
        assert!(service
            .commit_file("wrong-server", &plan.token)
            .await
            .is_err());
        let receipt = service.commit_file(&profile.id, &plan.token).await.unwrap();
        assert!(service.commit_file(&profile.id, &plan.token).await.is_err());
        assert_eq!(
            service
                .read_text(&profile.id, &target)
                .await
                .unwrap()
                .content,
            "port: 4000\r\n"
        );
        let backup = receipt.backup_path.unwrap();
        assert_eq!(
            *session.read(&backup, TEXT_LIMIT).await.unwrap().0,
            b"port: 3000\r\n"
        );
        assert_eq!(
            session
                .raw
                .lstat(&backup)
                .await
                .unwrap()
                .attrs
                .permissions
                .unwrap()
                & 0o777,
            0o600
        );
        assert_eq!(
            session
                .raw
                .lstat(parent(&backup))
                .await
                .unwrap()
                .attrs
                .permissions
                .unwrap()
                & 0o777,
            0o700
        );
        assert_eq!(
            *session
                .read(&join(parent(&backup), ".gitignore"), TEXT_LIMIT)
                .await
                .unwrap()
                .0,
            b"*\n"
        );
        assert_eq!(
            session
                .raw
                .lstat(&target)
                .await
                .unwrap()
                .attrs
                .permissions
                .unwrap()
                & 0o777,
            0o640
        );
        assert!(service
            .review_text(&profile.id, &target, &opened.revision, "stale".into())
            .await
            .is_err());
        let current = service.read_text(&profile.id, &target).await.unwrap();
        let stale = service
            .review_text(
                &profile.id,
                &target,
                &current.revision,
                "must not overwrite".into(),
            )
            .await
            .unwrap();
        let external = join(&directory, "external");
        session
            .create(
                &external,
                b"external change",
                FileAttributes {
                    permissions: Some(0o640),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        session.replace(&external, &target, true).await.unwrap();
        assert!(service
            .commit_file(&profile.id, &stale.token)
            .await
            .is_err());
        assert_eq!(
            service
                .read_text(&profile.id, &target)
                .await
                .unwrap()
                .content,
            "external change"
        );
        let link = join(&directory, "link.yaml");
        session.raw.symlink(&target, &link).await.unwrap();
        assert!(service.read_text(&profile.id, &link).await.is_err());
        assert!(service
            .file_review(
                &profile.id,
                &link,
                Zeroizing::new(b"bad".to_vec()),
                None,
                "upload"
            )
            .await
            .is_err());
        let binary = join(&directory, "binary.dat");
        let upload = service
            .file_review(
                &profile.id,
                &binary,
                Zeroizing::new(vec![0xA5; 131_075]),
                None,
                "upload",
            )
            .await
            .unwrap();
        service
            .commit_file(&profile.id, &upload.token)
            .await
            .unwrap();
        assert_eq!(
            *session.read(&binary, TRANSFER_LIMIT).await.unwrap().0,
            vec![0xA5; 131_075]
        );
        assert!(service.read_text(&profile.id, &binary).await.is_err());
        operations::test_manager(&service, &profile.id, &directory).await;
        let mut huge = session.raw.lstat(&target).await.unwrap().attrs;
        huge.size = Some((TEXT_LIMIT + 1) as u64);
        session.raw.setstat(&target, huge).await.unwrap();
        assert!(service.read_text(&profile.id, &target).await.is_err());
        let reconnect = service
            .file_review(
                &profile.id,
                &join(&directory, "pending"),
                Zeroizing::new(b"new".to_vec()),
                None,
                "upload",
            )
            .await
            .unwrap();
        service.disconnect(&profile.id).await.unwrap();
        assert!(service
            .commit_file(&profile.id, &reconnect.token)
            .await
            .is_err());
        // Reconnect solely to clean up this test's unique disposable directory.
        let inspection = service.inspect(&profile.id).await.unwrap();
        service
            .connect(&profile.id, &inspection.challenge_id, "".into())
            .await
            .unwrap();
        let session = service.file_session(&profile.id).await.unwrap();
        let listing = service.list_files(&profile.id, &directory).await.unwrap();
        for entry in listing.entries {
            if entry.kind == "directory" {
                assert!(
                    entry.name.starts_with(".vps-pilot-backup-")
                        || entry.name.starts_with(".vps-pilot-transfer-")
                );
                for item in service
                    .list_files(&profile.id, &entry.path)
                    .await
                    .unwrap()
                    .entries
                {
                    session.raw.remove(item.path).await.unwrap();
                }
                session.raw.rmdir(entry.path).await.unwrap();
            } else {
                session.raw.remove(entry.path).await.unwrap();
            }
        }
        session.raw.rmdir(&directory).await.unwrap();
        service.disconnect(&profile.id).await.unwrap();
    }
}
