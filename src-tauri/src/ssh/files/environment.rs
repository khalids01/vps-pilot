//! Explicit application dotenv editing over SFTP. No process environment inspection.
use super::*;
fn env_path(value: &str) -> Result<(), String> {
    path(value)?;
    writable(value)?;
    let name = value.rsplit('/').next().unwrap_or("");
    if name != ".env"
        && (!name.starts_with(".env.")
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))
    {
        return Err("Choose .env or a named .env file in the project directory.".into());
    }
    Ok(())
}
async fn current(
    service: &SshService,
    id: &str,
    revision: &str,
    connection: &str,
) -> Result<(), String> {
    if service.profile(id)?.revision != revision
        || service
            .runtime
            .lock()
            .await
            .connection_ids
            .get(id)
            .map(String::as_str)
            != Some(connection)
    {
        return Err("Connection changed. Reopen Manage env.".into());
    }
    Ok(())
}
pub(super) async fn read_environment(
    service: &SshService,
    profile_id: String,
    profile_revision: String,
    connection_id: String,
    path: String,
) -> Result<TextFile, String> {
    env_path(&path)?;
    current(service, &profile_id, &profile_revision, &connection_id).await?;
    let _lease = service.file_lease(&profile_id)?;
    timeout(OP_TIMEOUT, async {
        let session = service.file_session(&profile_id).await?;
        let target = session.target(&path).await?;
        env_path(&target)?;
        let original = session.optional_read(&target, TEXT_LIMIT).await?;
        let result = if let Some((bytes, attrs)) = original {
            if bytes.contains(&0) {
                return Err("Environment file must be UTF-8 text.".into());
            }
            TextFile {
                path: target.clone(),
                revision: digest(&bytes, &attrs, &target, &session.connection),
                content: String::from_utf8(bytes.to_vec())
                    .map_err(|_| "Environment file must be UTF-8 text.")?,
                size: bytes.len(),
                permissions: attrs.permissions,
            }
        } else {
            TextFile {
                path: target,
                revision: "missing".into(),
                content: String::new(),
                size: 0,
                permissions: None,
            }
        };
        service.file_current(&profile_id, &session).await?;
        current(service, &profile_id, &profile_revision, &connection_id).await?;
        Ok(result)
    })
    .await
    .map_err(|_| "Reading environment file timed out.".to_string())?
}
pub(super) async fn review_environment(
    service: &SshService,
    profile_id: String,
    profile_revision: String,
    connection_id: String,
    path: String,
    revision: String,
    content: String,
) -> Result<ReviewReply, String> {
    let data = Zeroizing::new(content.into_bytes());
    env_path(&path)?;
    current(service, &profile_id, &profile_revision, &connection_id).await?;
    if data.len() > TEXT_LIMIT || data.contains(&0) {
        return Err("Environment file exceeds its text limit.".into());
    }
    let review = service
        .file_review(&profile_id, &path, data, Some(&revision), "environment")
        .await?;
    if let Err(error) = current(service, &profile_id, &profile_revision, &connection_id).await {
        service
            .files
            .reviews
            .lock()
            .map_err(|_| "Review state unavailable.")?
            .remove(&review.token);
        return Err(error);
    }
    Ok(review)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_application_env_paths_are_allowed() {
        for path in ["/srv/web/.env", "/var/apps/api/.env.production"] {
            assert!(env_path(path).is_ok());
        }
        for path in [
            "/etc/caddy/.env",
            "/home/dev/.ssh/.env",
            "/srv/app/config.json",
            "/srv/app/.env/../key",
            "relative/.env",
        ] {
            assert!(env_path(path).is_err());
        }
    }
}

#[tauri::command]
pub async fn ssh_project_env_read(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    profile_revision: String,
    connection_id: String,
    path: String,
) -> Result<TextFile, String> {
    read_environment(&service, profile_id, profile_revision, connection_id, path).await
}
#[tauri::command]
pub async fn ssh_project_env_review(
    service: tauri::State<'_, SshService>,
    profile_id: String,
    profile_revision: String,
    connection_id: String,
    path: String,
    revision: String,
    content: String,
) -> Result<ReviewReply, String> {
    review_environment(
        &service,
        profile_id,
        profile_revision,
        connection_id,
        path,
        revision,
        content,
    )
    .await
}
