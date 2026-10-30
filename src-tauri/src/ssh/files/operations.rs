use super::*;
use serde::Deserialize;
use tauri::ipc::Channel;
const TREE_LIMIT: usize = 10_000;
const BATCH_LIMIT: u64 = 256 * 1024 * 1024;
const SCAN_TIMEOUT: Duration = Duration::from_secs(20);
#[derive(Default)]
pub(super) struct State {
    reviews: Mutex<HashMap<String, Plan>>,
    trash: Mutex<HashMap<String, Trash>>,
}
impl State {
    pub(super) fn invalidate(&self, id: &str) {
        self.reviews
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, plan| plan.profile != id);
        // Trash contents remain on the server; session restore tokens are invalidated.
        self.trash
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, item| item.profile != id);
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Copy,
    Move,
    Trash,
    Restore,
    Mkdir,
    Download,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationInput {
    pub kind: Operation,
    pub paths: Vec<String>,
    pub destination: Option<String>,
    pub name: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationItem {
    pub source: String,
    pub destination: Option<String>,
    pub kind: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationReview {
    pub token: String,
    pub profile_id: String,
    pub server_name: String,
    pub operation: Operation,
    pub items: Vec<OperationItem>,
    pub entries: usize,
    pub bytes: u64,
    pub expires_in_seconds: u64,
    pub excluded_entries: usize,
    pub local_destination: Option<String>,
}
#[derive(Clone)]
struct Node {
    path: String,
    relative: String,
    attrs: FileAttributes,
}
struct Root {
    source: String,
    destination: Option<String>,
    nodes: Vec<Node>,
    fingerprint: String,
    restore: Option<String>,
}
struct Plan {
    reply: OperationReview,
    profile: String,
    revision: String,
    connection: String,
    issued: Instant,
    roots: Vec<Root>,
    local: Option<PathBuf>,
}
struct Trash {
    profile: String,
    connection: String,
    revision: String,
    original: String,
    path: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedItem {
    pub source: String,
    pub destination: Option<String>,
    pub restore_id: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    pub completed: usize,
    pub total: usize,
    pub bytes: u64,
    pub current: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub status: String,
    pub completed: Vec<CompletedItem>,
    pub retained: Vec<String>,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSize {
    pub path: String,
    pub bytes: u64,
    pub entries: usize,
    pub complete: bool,
    pub observed_at: u64,
}
type ProgressSink = Arc<dyn Fn(OperationProgress) -> bool + Send + Sync>;
fn kind(attrs: &FileAttributes) -> &'static str {
    match attrs.permissions.map(|mode| mode & 0o170000) {
        Some(0o040000) => "directory",
        Some(0o100000) => "file",
        Some(0o120000) => "symlink",
        _ => "other",
    }
}
fn internal(path: &str) -> bool {
    path.split('/').any(|part| {
        [
            ".vps-pilot-backup-",
            ".vps-pilot-transfer-",
            ".vps-pilot-trash-",
        ]
        .iter()
        .any(|prefix| part.starts_with(prefix))
    })
}
fn mutation_path(path: &str) -> Result<(), String> {
    writable(path)?;
    if path.split('/').any(|part| {
        [
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
        ]
        .contains(&part.to_ascii_lowercase().as_str())
    }) {
        return Err("Database, container storage and credential paths are protected.".into());
    }
    Ok(())
}
pub(super) fn mutation_root(path: &str) -> Result<(), String> {
    mutation_path(path)?;
    if ["/home", "/root", "/srv", "/opt", "/tmp", "/mnt", "/media"].contains(&path)
        || parent(path) == "/home"
    {
        return Err("System and home-directory roots cannot be moved or deleted.".into());
    }
    Ok(())
}
fn virtual_path(path: &str) -> bool {
    path == "/"
        || ["/proc", "/sys", "/dev", "/run"]
            .iter()
            .any(|root| path == *root || path.starts_with(&format!("{root}/")))
}
fn tree_hash(nodes: &[Node]) -> String {
    let mut hash = Sha256::new();
    for node in nodes {
        let bytes = serde_json::to_vec(&(
            &node.relative,
            node.attrs.size,
            node.attrs.uid,
            node.attrs.gid,
            node.attrs.permissions,
            node.attrs.mtime,
        ))
        .unwrap_or_default();
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    format!("{:x}", hash.finalize())
}
async fn children(
    session: &Session,
    directory: &str,
) -> Result<Vec<(String, FileAttributes)>, String> {
    session.check_cancel()?;
    let handle = session.raw.opendir(directory).await.map_err(error)?.handle;
    let result = async {
        let mut entries = Vec::new();
        let mut names = HashSet::new();
        for _ in 0..1001 {
            session.check_cancel()?;
            match session.raw.readdir(&handle).await {
                Ok(batch) => {
                    for entry in batch.files {
                        if entry.filename == "." || entry.filename == ".." {
                            continue;
                        }
                        filename(&entry.filename)?;
                        if !names.insert(entry.filename.clone()) {
                            return Err(
                                "Folder changed while scanning. Refresh and try again.".into()
                            );
                        }
                        entries.push((entry.filename, entry.attrs));
                        if entries.len() > TREE_LIMIT {
                            return Err("Folder exceeds the 10,000-entry operation limit.".into());
                        }
                    }
                }
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                    entries.sort_by(|a, b| a.0.cmp(&b.0));
                    return Ok(entries);
                }
                Err(cause) => return Err(error(cause)),
            }
        }
        Err("Folder exceeded the bounded scan limit.".into())
    }
    .await;
    let _ = session.raw.close(handle).await;
    result
}
async fn scan(
    session: &Session,
    root: &str,
    mutating: bool,
    sizing: bool,
) -> Result<(Vec<Node>, bool), String> {
    if virtual_path(root) {
        return Err(
            "Recursive operations on root and virtual system filesystems are protected.".into(),
        );
    }
    let started = Instant::now();
    let mut nodes = Vec::new();
    let mut pending = vec![(
        root.to_string(),
        String::new(),
        session.raw.lstat(root).await.map_err(error)?.attrs,
    )];
    let mut complete = true;
    while let Some((path, relative, attrs)) = pending.pop() {
        session.check_cancel()?;
        if started.elapsed() > SCAN_TIMEOUT || nodes.len() >= TREE_LIMIT {
            if sizing {
                complete = false;
                break;
            }
            return Err("Folder exceeds the 20-second or 10,000-entry review limit. Choose a smaller selection.".into());
        }
        if virtual_path(&path) {
            return Err("Virtual system filesystems cannot be traversed.".into());
        }
        if mutating && !internal(&path) {
            mutation_path(&path)?;
        }
        let node_kind = kind(&attrs);
        if node_kind == "other" && !sizing {
            return Err("Special devices, sockets and FIFOs cannot be included.".into());
        }
        if sizing && attrs.permissions.is_none() {
            complete = false;
        }
        nodes.push(Node {
            path: path.clone(),
            relative: relative.clone(),
            attrs,
        });
        if node_kind == "directory" {
            let remaining = SCAN_TIMEOUT.saturating_sub(started.elapsed());
            match timeout(remaining, children(session, &path)).await {
                Err(_) if sizing => {
                    complete = false;
                    break;
                }
                Err(_) => return Err("Folder inspection timed out.".into()),
                Ok(Ok(entries)) => {
                    if pending.len() + nodes.len() + entries.len() > TREE_LIMIT {
                        if sizing {
                            complete = false;
                            break;
                        }
                        return Err("Folder inspection exceeds 10,000 entries.".into());
                    }
                    for (name, attrs) in entries.into_iter().rev() {
                        let child = join(&path, &name);
                        if child.len() > 4096 {
                            return Err("A nested path exceeds the path limit.".into());
                        }
                        pending.push((
                            child,
                            if relative.is_empty() {
                                name
                            } else {
                                format!("{relative}/{name}")
                            },
                            attrs,
                        ));
                    }
                }
                Ok(Err(cause)) if sizing => {
                    if session.check_cancel().is_err() {
                        return Err(cause);
                    }
                    complete = false;
                    break;
                }
                Ok(Err(cause)) => return Err(cause),
            }
        }
    }
    Ok((nodes, complete))
}
async fn exists(session: &Session, path: &str) -> Result<bool, String> {
    session.check_cancel()?;
    match session.raw.lstat(path).await {
        Ok(_) => Ok(true),
        Err(cause) if missing(&cause) => Ok(false),
        Err(cause) => Err(error(cause)),
    }
}
async fn fresh_name(
    session: &Session,
    directory: &str,
    name: &str,
    is_file: bool,
) -> Result<String, String> {
    let mut candidate = join(directory, name);
    if !exists(session, &candidate).await? {
        return Ok(candidate);
    }
    let (stem, extension) = if is_file {
        name.rsplit_once('.')
            .filter(|(stem, _)| !stem.is_empty())
            .map(|(stem, ext)| (stem, format!(".{ext}")))
            .unwrap_or((name, String::new()))
    } else {
        (name, String::new())
    };
    for number in 1..=100 {
        let next = format!(
            "{stem} copy{}{extension}",
            if number == 1 {
                String::new()
            } else {
                format!(" {number}")
            }
        );
        filename(&next)?;
        candidate = join(directory, &next);
        if !exists(session, &candidate).await? {
            return Ok(candidate);
        }
    }
    Err("Choose a destination with fewer name conflicts.".into())
}
async fn private_directory(session: &Session, path: &str) -> Result<(), String> {
    session.check_cancel()?;
    session
        .raw
        .mkdir(
            path,
            FileAttributes {
                permissions: Some(0o700),
                ..Default::default()
            },
        )
        .await
        .map_err(error)?;
    session
        .create(
            &join(path, ".gitignore"),
            b"*\n",
            FileAttributes {
                permissions: Some(0o600),
                ..Default::default()
            },
        )
        .await
}
impl SshService {
    pub(super) async fn review_operation(
        &self,
        id: &str,
        input: OperationInput,
        local: Option<PathBuf>,
    ) -> Result<OperationReview, String> {
        let _lease = self.file_lease(id)?;
        let work = async {
            if input.paths.len() > 100
                || input
                    .name
                    .as_ref()
                    .is_some_and(|name| filename(name).is_err())
            {
                return Err("Select up to 100 valid items.".into());
            }
            if input.name.is_some() && input.paths.len() > 1 {
                return Err("Rename supports one item at a time.".into());
            }
            let session = self.file_session(id).await?;
            if input.kind == Operation::Trash
                && self
                    .files
                    .operations
                    .trash
                    .lock()
                    .map_err(|_| "Trash state unavailable.")?
                    .len()
                    + input.paths.len()
                    > 200
            {
                return Err("Restore existing trash or reconnect before deleting more items. Existing server copies remain retained.".into());
            }
            let boundaries = if matches!(
                input.kind,
                Operation::Move | Operation::Trash | Operation::Restore
            ) {
                mounts(&session).await?
            } else {
                Vec::new()
            };
            let directory = if let Some(path) = &input.destination {
                Some(session.canonical(path).await?)
            } else {
                None
            };
            let mut roots = Vec::new();
            let mut seen = HashSet::new();
            let mut targets = HashSet::new();
            let mut total_bytes = 0u64;
            let mut total_entries = 0usize;
            let mut excluded_entries = 0usize;
            if input.kind == Operation::Mkdir {
                let destination = join(
                    directory.as_deref().ok_or("Choose a destination folder.")?,
                    input.name.as_deref().ok_or("Enter a folder name.")?,
                );
                mutation_path(&destination)?;
                if exists(&session, &destination).await? {
                    return Err("An item already exists with that name.".into());
                }
                roots.push(Root {
                    source: String::new(),
                    destination: Some(destination),
                    nodes: Vec::new(),
                    fingerprint: String::new(),
                    restore: None,
                });
            } else {
                if input.paths.is_empty() {
                    return Err("Select at least one item.".into());
                }
                for requested in &input.paths {
                    let (source, restore) = if input.kind == Operation::Restore {
                        let trash = self
                            .files
                            .operations
                            .trash
                            .lock()
                            .map_err(|_| "Trash state unavailable.")?;
                        let item=trash.get(requested).filter(|item|item.profile==id&&item.connection==session.connection&&item.revision==session.revision).ok_or("This trash restore belongs to a previous session. The server copy is retained.")?;
                        (item.path.clone(), Some(requested.clone()))
                    } else {
                        (session.target(requested).await?, None)
                    };
                    if !seen.insert(source.clone()) {
                        continue;
                    }
                    if input.kind == Operation::Copy && internal(&source) {
                        return Err(
                            "Use restore or download for protected backup/trash items.".into()
                        );
                    }
                    if input.kind == Operation::Move || input.kind == Operation::Trash {
                        mutation_root(&source)?;
                    }
                    if !boundaries.is_empty() {
                        guard_mounts(&source, &boundaries)?;
                    }
                    let (nodes, complete) = scan(
                        &session,
                        &source,
                        input.kind == Operation::Move || input.kind == Operation::Trash,
                        false,
                    )
                    .await?;
                    if !complete {
                        return Err("Folder inspection was incomplete.".into());
                    }
                    let destination = match input.kind {
                        Operation::Copy | Operation::Move => {
                            let folder =
                                directory.as_deref().ok_or("Choose a destination folder.")?;
                            let name = input
                                .name
                                .as_deref()
                                .unwrap_or_else(|| source.rsplit('/').next().unwrap_or("item"));
                            if folder == source || folder.starts_with(&format!("{source}/")) {
                                return Err("A folder cannot be placed inside itself.".into());
                            }
                            let target = if input.kind == Operation::Copy {
                                fresh_name(&session, folder, name, kind(&nodes[0].attrs) == "file")
                                    .await?
                            } else {
                                join(folder, name)
                            };
                            mutation_path(&target)?;
                            if input.kind == Operation::Move && exists(&session, &target).await? {
                                return Err(
                                    "Destination already exists. Moves never overwrite items."
                                        .into(),
                                );
                            }
                            for node in &nodes {
                                if input.kind == Operation::Copy && internal(&node.path) {
                                    continue;
                                }
                                mutation_path(&if node.relative.is_empty() {
                                    target.clone()
                                } else {
                                    join(&target, &node.relative)
                                })?;
                            }
                            Some(target)
                        }
                        Operation::Trash => Some(join(
                            &join(
                                parent(&source),
                                &format!(".vps-pilot-trash-{}", Uuid::new_v4()),
                            ),
                            "original",
                        )),
                        Operation::Restore => {
                            let trash = self
                                .files
                                .operations
                                .trash
                                .lock()
                                .map_err(|_| "Trash state unavailable.")?;
                            let original = &trash
                                .get(requested)
                                .ok_or("Restore is unavailable.")?
                                .original;
                            mutation_path(original)?;
                            Some(original.clone())
                        }
                        Operation::Download => None,
                        Operation::Mkdir => unreachable!(),
                    };
                    if let Some(target) = &destination {
                        if !targets.insert(target.clone()) {
                            return Err("The selection has conflicting destination names.".into());
                        }
                        if input.kind == Operation::Restore && exists(&session, target).await? {
                            return Err(
                                "The original path already exists. Restore will not overwrite it."
                                    .into(),
                            );
                        }
                    }
                    for node in &nodes {
                        if (input.kind == Operation::Copy && internal(&node.path))
                            || (input.kind == Operation::Download && kind(&node.attrs) == "symlink")
                        {
                            excluded_entries += 1;
                            continue;
                        }
                        if kind(&node.attrs) == "file" {
                            let size = node.attrs.size.ok_or("File size is unavailable.")?;
                            if (input.kind == Operation::Copy || input.kind == Operation::Download)
                                && size > TRANSFER_LIMIT as u64
                            {
                                return Err("Copy and download support files up to 32 MiB.".into());
                            }
                            total_bytes = total_bytes.saturating_add(size);
                        }
                    }
                    total_entries += nodes.len();
                    if total_entries > TREE_LIMIT
                        || ((input.kind == Operation::Copy || input.kind == Operation::Download)
                            && total_bytes > BATCH_LIMIT)
                    {
                        return Err(
                            "Selection exceeds 10,000 entries or 256 MiB. Choose a smaller batch."
                                .into(),
                        );
                    }
                    let fingerprint = tree_hash(&nodes);
                    roots.push(Root {
                        source,
                        destination,
                        nodes,
                        fingerprint,
                        restore,
                    });
                }
                let paths: Vec<_> = roots.iter().map(|root| root.source.as_str()).collect();
                if paths.iter().enumerate().any(|(a, first)| {
                    paths
                        .iter()
                        .enumerate()
                        .any(|(b, second)| a != b && second.starts_with(&format!("{first}/")))
                }) {
                    return Err("Select a folder or its children, not both.".into());
                }
            }
            if input.kind == Operation::Download {
                let mut names = HashSet::new();
                for root in &roots {
                    let base = root.source.rsplit('/').next().ok_or("Invalid source.")?;
                    if !names.insert(base) {
                        return Err("Download items with duplicate names separately.".into());
                    }
                    if root.nodes.iter().any(|node| {
                        node.path.contains('\\')
                            || node
                                .relative
                                .split('/')
                                .any(|part| part == ".." || part.contains(':'))
                            || base.contains(':')
                    }) {
                        return Err("A file name is not portable in an archive.".into());
                    }
                }
            }
            if input.kind == Operation::Download && local.is_none() {
                return Err("Choose a local archive destination.".into());
            }
            self.file_current(id, &session).await?;
            let reply = OperationReview {
                token: Uuid::new_v4().to_string(),
                profile_id: id.into(),
                server_name: self.profile(id)?.name,
                operation: input.kind,
                items: roots
                    .iter()
                    .map(|root| OperationItem {
                        source: root.source.clone(),
                        destination: root.destination.clone(),
                        kind: root
                            .nodes
                            .first()
                            .map(|node| kind(&node.attrs))
                            .unwrap_or("directory")
                            .into(),
                    })
                    .collect(),
                entries: total_entries,
                bytes: total_bytes,
                expires_in_seconds: REVIEW_TTL.as_secs(),
                excluded_entries,
                local_destination: local
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
            };
            let mut reviews = self
                .files
                .operations
                .reviews
                .lock()
                .map_err(|_| "Operation review state unavailable.")?;
            reviews.retain(|_, plan| plan.issued.elapsed() < REVIEW_TTL);
            if reviews.len() >= 4 {
                return Err("Close another operation review first.".into());
            }
            reviews.insert(
                reply.token.clone(),
                Plan {
                    reply: reply.clone(),
                    profile: id.into(),
                    revision: session.revision.clone(),
                    connection: session.connection.clone(),
                    issued: Instant::now(),
                    roots,
                    local,
                },
            );
            Ok(reply)
        };
        timeout(OP_TIMEOUT, work)
            .await
            .map_err(|_| "Operation review timed out.")?
    }
    pub(super) async fn execute_operation(
        &self,
        id: &str,
        token: &str,
        sink: ProgressSink,
    ) -> Result<OperationResult, String> {
        let _lease = self.file_lease(id)?;
        let plan = {
            let mut plans = self
                .files
                .operations
                .reviews
                .lock()
                .map_err(|_| "Operation state unavailable.")?;
            if plans.get(token).is_none_or(|plan| plan.profile != id) {
                return Err("Review this operation for the selected server.".into());
            }
            plans.remove(token).ok_or("Review this operation again.")?
        };
        if plan.issued.elapsed() >= REVIEW_TTL {
            return Err("The operation review expired. Review again.".into());
        }
        let session = self.file_session(id).await?;
        if session.connection != plan.connection || session.revision != plan.revision {
            return Err("The SSH connection changed. Review the operation again.".into());
        }
        let total = plan.roots.len();
        let mut completed = Vec::new();
        let mut retained = Vec::new();
        let mut bytes = 0;
        let mut last_progress = Instant::now() - Duration::from_millis(100);
        let work = async {
            // Revalidate the whole batch before the first filesystem mutation.
            for root in &plan.roots {
                session.check_cancel()?;
                if !root.source.is_empty() {
                    if session.target(&root.source).await? != root.source {
                        return Err("A source directory changed. Review again.".into());
                    }
                    let (latest, _) = scan(&session, &root.source, false, false).await?;
                    if tree_hash(&latest) != root.fingerprint {
                        return Err(
                            "Selected items changed after review. Nothing has been started.".into(),
                        );
                    }
                }
                if let Some(target) = &root.destination {
                    if plan.reply.operation != Operation::Trash
                        && session.target(target).await? != *target
                    {
                        return Err("The destination directory changed.".into());
                    }
                    if plan.reply.operation != Operation::Trash && exists(&session, target).await? {
                        return Err("A destination now exists. Nothing will be overwritten.".into());
                    }
                }
            }
            let mut archive = if plan.reply.operation == Operation::Download {
                let destination = plan.local.as_ref().ok_or("Missing archive destination.")?;
                Some((
                    zip::ZipWriter::new(
                        tempfile::NamedTempFile::new_in(
                            destination.parent().ok_or("Choose a destination.")?,
                        )
                        .map_err(|_| "Cannot create the archive.")?,
                    ),
                    destination,
                ))
            } else {
                None
            };
            for root in &plan.roots {
                session.check_cancel()?;
                if !(sink)(OperationProgress {
                    completed: completed.len(),
                    total,
                    bytes,
                    current: root.source.clone(),
                }) {
                    session.cancel.store(true, Ordering::SeqCst);
                    session.check_cancel()?;
                }
                self.file_current(id, &session).await?;
                if matches!(
                    plan.reply.operation,
                    Operation::Move | Operation::Trash | Operation::Restore
                ) {
                    guard_mounts(&root.source, &mounts(&session).await?)?;
                    if session.target(&root.source).await? != root.source {
                        return Err("A source directory changed. Review again.".into());
                    }
                    let (latest, _) = scan(&session, &root.source, false, false).await?;
                    if tree_hash(&latest) != root.fingerprint {
                        return Err("A selected item changed while the batch was running. Remaining items were stopped.".into());
                    }
                }
                let target = root.destination.as_deref();
                if let Some(target) = target {
                    if plan.reply.operation != Operation::Trash
                        && session.target(target).await? != target
                    {
                        return Err("The destination directory changed.".into());
                    }
                }
                let mut restore_id = None;
                match plan.reply.operation {
                    Operation::Mkdir => {
                        let target = target.ok_or("Missing destination.")?;
                        mutation_path(target)?;
                        session.check_cancel()?;
                        session
                            .raw
                            .mkdir(
                                target,
                                FileAttributes {
                                    permissions: Some(0o755),
                                    ..Default::default()
                                },
                            )
                            .await
                            .map_err(error)?;
                    }
                    Operation::Move | Operation::Trash | Operation::Restore => {
                        let target = target.ok_or("Missing destination.")?;
                        if plan.reply.operation == Operation::Trash {
                            let trashdir = parent(target);
                            private_directory(&session, trashdir).await?;
                            retained.push(trashdir.into());
                        } else {
                            mutation_path(target)?;
                        }
                        if plan.reply.operation == Operation::Move
                            || plan.reply.operation == Operation::Trash
                        {
                            mutation_root(&root.source)?;
                        }
                        session.check_cancel()?;
                        session.raw.rename(&root.source,target).await.map_err(|_|"Move failed. The paths may be on different filesystems, or permissions changed.")?;
                        if plan.reply.operation == Operation::Trash {
                            let key = Uuid::new_v4().to_string();
                            let mut trash = self
                                .files
                                .operations
                                .trash
                                .lock()
                                .map_err(|_| "Trash state unavailable.")?;

                            trash.insert(
                                key.clone(),
                                Trash {
                                    profile: id.into(),
                                    connection: session.connection.clone(),
                                    revision: session.revision.clone(),
                                    original: root.source.clone(),
                                    path: target.into(),
                                },
                            );
                            restore_id = Some(key);
                            retained.retain(|path| path != parent(target));
                        }
                        if let Some(key) = &root.restore {
                            self.files
                                .operations
                                .trash
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .remove(key);
                        }
                    }
                    Operation::Copy => {
                        let target = target.ok_or("Missing destination.")?;
                        mutation_path(target)?;
                        let work = join(
                            parent(target),
                            &format!(".vps-pilot-transfer-{}", Uuid::new_v4()),
                        );
                        private_directory(&session, &work).await?;
                        retained.push(work.clone());
                        let stage = join(&work, "item");
                        for node in &root.nodes {
                            if internal(&node.path) {
                                continue;
                            }
                            session.check_cancel()?;
                            let destination = if node.relative.is_empty() {
                                stage.clone()
                            } else {
                                join(&stage, &node.relative)
                            };
                            match kind(&node.attrs) {
                                "directory" => {
                                    session
                                        .raw
                                        .mkdir(
                                            &destination,
                                            FileAttributes {
                                                permissions: Some(0o700),
                                                ..Default::default()
                                            },
                                        )
                                        .await
                                        .map_err(error)?;
                                }
                                "file" => {
                                    let (contents, attrs) =
                                        session.read(&node.path, TRANSFER_LIMIT).await?;
                                    if !same_metadata(&attrs, &node.attrs) {
                                        return Err("A source file changed during copy. Partial data remains private.".into());
                                    }
                                    session
                                        .create(
                                            &destination,
                                            &contents,
                                            FileAttributes {
                                                permissions: node
                                                    .attrs
                                                    .permissions
                                                    .map(|mode| mode & 0o777),
                                                ..Default::default()
                                            },
                                        )
                                        .await?;
                                    bytes += contents.len() as u64;
                                }
                                "symlink" => {
                                    let link = session
                                        .raw
                                        .readlink(&node.path)
                                        .await
                                        .map_err(error)?
                                        .files
                                        .first()
                                        .ok_or("Link target unavailable.")?
                                        .filename
                                        .clone();
                                    session.check_cancel()?;
                                    session
                                        .raw
                                        .symlink(link, &destination)
                                        .await
                                        .map_err(error)?;
                                }
                                _ => return Err("Special files cannot be copied.".into()),
                            }
                            if last_progress.elapsed() >= Duration::from_millis(100) {
                                last_progress = Instant::now();
                                if !(sink)(OperationProgress {
                                    completed: completed.len(),
                                    total,
                                    bytes,
                                    current: node.path.clone(),
                                }) {
                                    session.cancel.store(true, Ordering::SeqCst);
                                }
                            }
                        }
                        for node in root.nodes.iter().rev().filter(|node| {
                            kind(&node.attrs) == "directory" && !internal(&node.path)
                        }) {
                            session.check_cancel()?;
                            let destination = if node.relative.is_empty() {
                                stage.clone()
                            } else {
                                join(&stage, &node.relative)
                            };
                            session
                                .raw
                                .setstat(
                                    destination,
                                    FileAttributes {
                                        permissions: node
                                            .attrs
                                            .permissions
                                            .map(|mode| mode & 0o777),
                                        ..Default::default()
                                    },
                                )
                                .await
                                .map_err(error)?;
                        }
                        session.check_cancel()?;
                        self.file_current(id, &session).await?;
                        if session.target(target).await? != target {
                            return Err("The destination directory changed during copying.".into());
                        }
                        if exists(&session, target).await? {
                            return Err("A destination appeared during copying. The private stage was retained.".into());
                        }
                        session.check_cancel()?;
                        session.raw.rename(&stage, target).await.map_err(error)?;
                        let _ = session.raw.remove(join(&work, ".gitignore")).await;
                        let _ = session.raw.rmdir(&work).await;
                        retained.retain(|path| path != &work);
                    }
                    Operation::Download => {
                        let (archive, _) = archive.as_mut().ok_or("Archive unavailable.")?;
                        let base = root.source.rsplit('/').next().ok_or("Invalid source.")?;
                        for node in &root.nodes {
                            if kind(&node.attrs) == "symlink" {
                                continue;
                            }
                            session.check_cancel()?;
                            let name = if node.relative.is_empty() {
                                base.to_string()
                            } else {
                                format!("{base}/{}", node.relative)
                            };
                            if name.contains('\\')
                                || name
                                    .split('/')
                                    .any(|part| part == ".." || part.contains(':'))
                            {
                                return Err("A file name is not portable in an archive.".into());
                            }
                            let options = zip::write::SimpleFileOptions::default()
                                .compression_method(zip::CompressionMethod::Stored)
                                .unix_permissions(0o600);
                            match kind(&node.attrs) {
                                "directory"=>archive.add_directory(format!("{name}/"),options.unix_permissions(0o700)).map_err(|_|"Cannot add a folder to the archive.")?,
                                "file"=>{
                                    let (contents,attrs)=session.read(&node.path,TRANSFER_LIMIT).await?;
                                    if !same_metadata(&attrs,&node.attrs){
return Err("A file changed during download.".into());
}
                                    archive.start_file(name,options).map_err(|_|"Cannot add a file to the archive.")?;
                                    archive.write_all(&contents).map_err(|_|"Cannot write the download.")?;
                                    bytes+=contents.len() as u64;
                                }
,
                                _=>return Err("Download archives do not include symbolic links or special files.".into()),
                            }
                            if last_progress.elapsed() >= Duration::from_millis(100) {
                                last_progress = Instant::now();
                                if !(sink)(OperationProgress {
                                    completed: completed.len(),
                                    total,
                                    bytes,
                                    current: node.path.clone(),
                                }) {
                                    session.cancel.store(true, Ordering::SeqCst);
                                }
                            }
                        }
                    }
                }
                completed.push(CompletedItem {
                    source: root.source.clone(),
                    destination: root.destination.clone(),
                    restore_id,
                });
            }
            session.check_cancel()?;
            if let Some((archive, destination)) = archive {
                let temporary = archive.finish().map_err(|_| "Cannot finish the archive.")?;
                temporary
                    .as_file()
                    .sync_all()
                    .map_err(|_| "Cannot finish saving the archive.")?;
                session.check_cancel()?;
                temporary
                    .persist(destination)
                    .map_err(|_| "Cannot save the archive at the chosen location.")?;
            }
            Ok::<_, String>(())
        };
        let result = timeout(Duration::from_secs(900), work)
            .await
            .map_err(|_| "Operation timed out; completed items remain applied.".to_string())
            .and_then(|value| value);
        let _ = (sink)(OperationProgress {
            completed: completed.len(),
            total,
            bytes,
            current: String::new(),
        });
        Ok(OperationResult {
            status: if result.is_ok() {
                "completed"
            } else if session.cancel.load(Ordering::SeqCst) {
                "cancelled"
            } else {
                "failed"
            }
            .into(),
            completed,
            retained,
            error: result.err(),
        })
    }
    pub(super) async fn folder_size(
        &self,
        id: &str,
        requested: &str,
    ) -> Result<FolderSize, String> {
        let _lease = self.file_lease(id)?;
        let session = self.file_session(id).await?;
        let target = session.canonical(requested).await?;
        let (nodes, complete) = timeout(
            Duration::from_secs(30),
            scan(&session, &target, false, true),
        )
        .await
        .map_err(|_| "Folder-size scan timed out.")??;
        self.file_current(id, &session).await?;
        Ok(FolderSize {
            path: target,
            bytes: nodes
                .iter()
                .filter(|node| kind(&node.attrs) == "file")
                .map(|node| node.attrs.size.unwrap_or(0))
                .fold(0, u64::saturating_add),
            entries: nodes.len(),
            complete,
            observed_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        })
    }
}
#[tauri::command]
pub async fn ssh_files_review_operation(
    app: tauri::AppHandle,
    service: tauri::State<'_, SshService>,
    profile_id: String,
    input: OperationInput,
) -> Result<Option<OperationReview>, String> {
    let local = if input.kind == Operation::Download {
        let selected = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("Download selection as ZIP")
                .set_file_name("vps-pilot-download.zip")
                .blocking_save_file()
        })
        .await
        .map_err(|_| "Save dialog unavailable.")?;
        let Some(selected) = selected else {
            return Ok(None);
        };
        Some(
            selected
                .into_path()
                .map_err(|_| "Choose a local destination.")?,
        )
    } else {
        None
    };
    service
        .review_operation(&profile_id, input, local)
        .await
        .map(Some)
}
#[tauri::command]
pub async fn ssh_files_execute_operation(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    token: String,
    output: Channel<OperationProgress>,
) -> Result<OperationResult, String> {
    service
        .execute_operation(
            &profile_id,
            &token,
            Arc::new(move |progress| output.send(progress).is_ok()),
        )
        .await
}
#[tauri::command]
pub fn ssh_files_reject_operation(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    token: String,
) -> Result<(), String> {
    let mut plans = service
        .files
        .operations
        .reviews
        .lock()
        .map_err(|_| "Operation state unavailable.")?;
    if plans
        .get(&token)
        .is_some_and(|plan| plan.profile == profile_id)
    {
        plans.remove(&token);
    }
    Ok(())
}
#[tauri::command]
pub fn ssh_files_cancel(
    service: tauri::State<'_, SshService>,
    profile_id: String,
) -> Result<bool, String> {
    let cancels = service
        .files
        .cancels
        .lock()
        .map_err(|_| "Cancellation state unavailable.")?;
    if let Some(flag) = cancels.get(&profile_id) {
        flag.store(true, Ordering::SeqCst);
        Ok(true)
    } else {
        Ok(false)
    }
}
#[tauri::command]
pub async fn ssh_files_size(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    path: String,
) -> Result<FolderSize, String> {
    service.folder_size(&profile_id, &path).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_policy_protects_system_ancestors_credentials_and_datastores() {
        for path in [
            "/",
            "/etc/passwd",
            "/var",
            "/var/lib",
            "/boot",
            "/usr",
            "/home/user/.ssh/a",
            "/srv/app/pgdata/a",
            "/srv/app/.aws/a",
            "/root",
        ] {
            assert!(mutation_root(path).is_err(), "{path}");
        }
        for path in [
            "/srv/my-app/config.yaml",
            "/home/user/work/new",
            "/root/my-app",
        ] {
            assert!(mutation_root(path).is_ok(), "{path}");
        }
        assert!(writable("/srv/app/.vps-pilot-trash-id/original").is_err());
        assert!(internal("/srv/app/.vps-pilot-backup-id/original"));
    }
}
#[cfg(test)]
pub(super) async fn test_manager(service: &SshService, id: &str, fixture: &str) {
    use std::sync::atomic::AtomicUsize;
    let session = service.file_session(id).await.unwrap();
    let base = join(fixture, "manager");
    let source = join(&base, "source");
    for path in [&base, &source] {
        session
            .raw
            .mkdir(
                path,
                FileAttributes {
                    permissions: Some(0o700),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }
    let file = join(&source, "example.txt");
    session
        .create(
            &file,
            b"fixture content",
            FileAttributes {
                permissions: Some(0o640),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    session
        .raw
        .symlink("/etc/passwd", join(&source, "link"))
        .await
        .unwrap();
    let input = |kind, paths: Vec<String>, destination: Option<String>, name: Option<String>| {
        OperationInput {
            kind,
            paths,
            destination,
            name,
        }
    };
    let sink: ProgressSink = Arc::new(|_| true);
    assert!(service
        .review_operation(
            id,
            input(
                Operation::Move,
                vec![source.clone()],
                Some("/etc".into()),
                None
            ),
            None
        )
        .await
        .is_err());
    let copy = service
        .review_operation(
            id,
            input(
                Operation::Copy,
                vec![source.clone()],
                Some(base.clone()),
                None,
            ),
            None,
        )
        .await
        .unwrap();
    let copied = copy.items[0].destination.clone().unwrap();
    assert!(copied.ends_with("source copy"));
    let copied_result = service
        .execute_operation(id, &copy.token, sink.clone())
        .await
        .unwrap();
    assert_eq!(copied_result.status, "completed");
    assert!(service
        .execute_operation(id, &copy.token, sink.clone())
        .await
        .is_err());
    assert_eq!(
        &*session
            .read(&join(&copied, "example.txt"), TRANSFER_LIMIT)
            .await
            .unwrap()
            .0,
        b"fixture content"
    );
    assert_eq!(
        session
            .raw
            .lstat(join(&copied, "example.txt"))
            .await
            .unwrap()
            .attrs
            .permissions
            .unwrap()
            & 0o777,
        0o640
    );
    assert_eq!(
        kind(
            &session
                .raw
                .lstat(join(&copied, "link"))
                .await
                .unwrap()
                .attrs
        ),
        "symlink"
    );
    let archive_dir = tempfile::tempdir().unwrap();
    let archive_path = archive_dir.path().join("download.zip");
    let download = service
        .review_operation(
            id,
            input(Operation::Download, vec![source.clone()], None, None),
            Some(archive_path.clone()),
        )
        .await
        .unwrap();
    assert_eq!(download.excluded_entries, 1);
    assert_eq!(
        service
            .execute_operation(id, &download.token, sink.clone())
            .await
            .unwrap()
            .status,
        "completed"
    );
    let mut archive = zip::ZipArchive::new(std::fs::File::open(archive_path).unwrap()).unwrap();
    assert!(archive.by_name("source/example.txt").is_ok());
    assert_eq!(
        archive.by_name("source/").unwrap().unix_mode().unwrap() & 0o777,
        0o700
    );
    let size = service.folder_size(id, &source).await.unwrap();
    assert!(size.complete);
    assert_eq!(size.bytes, 15);
    assert!(archive.by_name("source/link").is_err());
    let occupied = service
        .review_operation(
            id,
            input(
                Operation::Mkdir,
                vec![],
                Some(base.clone()),
                Some("occupied".into()),
            ),
            None,
        )
        .await
        .unwrap();
    session
        .raw
        .mkdir(join(&base, "occupied"), FileAttributes::default())
        .await
        .unwrap();
    let failed = service
        .execute_operation(id, &occupied.token, sink.clone())
        .await
        .unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.completed.is_empty());
    let cancel = service
        .review_operation(
            id,
            input(
                Operation::Copy,
                vec![source.clone()],
                Some(base.clone()),
                Some("cancelled".into()),
            ),
            None,
        )
        .await
        .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let cancelled = service
        .execute_operation(
            id,
            &cancel.token,
            Arc::new(move |_| count.fetch_add(1, Ordering::SeqCst) == 0),
        )
        .await
        .unwrap();
    assert_eq!(cancelled.status, "cancelled");
    assert!(!cancelled.retained.is_empty());
    assert!(cancelled.completed.is_empty());
    assert!(!exists(&session, &join(&base, "cancelled")).await.unwrap());
    let deleted = service
        .review_operation(
            id,
            input(Operation::Trash, vec![copied.clone()], None, None),
            None,
        )
        .await
        .unwrap();
    let result = service
        .execute_operation(id, &deleted.token, sink.clone())
        .await
        .unwrap();
    assert_eq!(result.status, "completed");
    assert!(!exists(&session, &copied).await.unwrap());
    let restore = result.completed[0].restore_id.clone().unwrap();
    let review = service
        .review_operation(
            id,
            input(Operation::Restore, vec![restore], None, None),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .execute_operation(id, &review.token, sink.clone())
            .await
            .unwrap()
            .status,
        "completed"
    );
    assert!(exists(&session, &copied).await.unwrap());
    let moved = service
        .review_operation(
            id,
            input(
                Operation::Move,
                vec![copied.clone()],
                Some(base.clone()),
                Some("renamed".into()),
            ),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .execute_operation(id, &moved.token, sink)
            .await
            .unwrap()
            .status,
        "completed"
    );
    assert!(!exists(&session, &copied).await.unwrap());
    // Test cleanup is restricted to our unique disposable fixture directory.
    assert!(base.starts_with("/root/vps-pilot-sftp-fixture-"));
    let (nodes, _) = scan(&session, &base, false, false).await.unwrap();
    for node in nodes.into_iter().rev() {
        if kind(&node.attrs) == "directory" {
            session.raw.rmdir(node.path).await.unwrap();
        } else {
            session.raw.remove(node.path).await.unwrap();
        }
    }
}
// Linux mount information is a small read-only kernel file. Reading it through
// SFTP needs no helper, command, privileges, or additional SSH connection.
async fn mounts(session: &Session) -> Result<Vec<String>, String> {
    session.check_cancel()?;
    let handle=session.raw.open("/proc/self/mountinfo",OpenFlags::READ,FileAttributes::default()).await.map_err(|_|"Cannot verify mount boundaries. Folder moves/deletes require readable Linux mount information.")?.handle;
    let result = async {
        let mut bytes = Vec::new();
        loop {
            session.check_cancel()?;
            match session.raw.read(&handle, bytes.len() as u64, 32_768).await {
                Ok(data) => {
                    if data.data.is_empty() {
                        break;
                    }
                    bytes.extend_from_slice(&data.data);
                    if bytes.len() > TEXT_LIMIT {
                        return Err("Mount information exceeds its safety limit.".into());
                    }
                }
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
                Err(cause) => return Err(error(cause)),
            }
        }
        let text = String::from_utf8(bytes).map_err(|_| "Mount information is not valid UTF-8.")?;
        parse_mounts(&text)
    }
    .await;
    let _ = session.raw.close(handle).await;
    result
}
fn parse_mounts(text: &str) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    for line in text.lines() {
        let encoded = line
            .split_whitespace()
            .nth(4)
            .ok_or("Mount information is incomplete.")?;
        let decoded = encoded
            .replace("\\040", " ")
            .replace("\\011", "\t")
            .replace("\\012", "\n")
            .replace("\\134", "\\");
        path(&decoded)?;
        paths.push(decoded);
    }
    if !paths.iter().any(|path| path == "/") {
        return Err("Mount boundaries could not be verified.".into());
    }
    Ok(paths)
}
fn guard_mounts(source: &str, boundaries: &[String]) -> Result<(), String> {
    if boundaries
        .iter()
        .any(|mount| source == mount || mount.starts_with(&format!("{source}/")))
    {
        return Err(
            "Mounted storage and folders containing a mount point cannot be moved or deleted."
                .into(),
        );
    }
    Ok(())
}
#[cfg(test)]
mod mount_tests {
    use super::*;
    #[test]
    fn mount_boundaries_decode_spaces_and_reject_parent_moves() {
        let mounts = parse_mounts(
            "1 0 1:1 / / rw - ext4 root rw\n2 1 1:2 / /srv/app/data\\040disk rw - ext4 disk rw",
        )
        .unwrap();
        assert_eq!(mounts[1], "/srv/app/data disk");
        assert!(guard_mounts("/srv/app", &mounts).is_err());
        assert!(guard_mounts("/srv/app/data disk", &mounts).is_err());
        assert!(guard_mounts("/srv/application", &mounts).is_ok());
        assert!(parse_mounts("garbage").is_err());
        assert!(parse_mounts("").is_err());
    }
}
