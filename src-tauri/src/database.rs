use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

const ERROR: &str = "Local database could not be read or saved. Existing data was preserved.";
const QUICK_SETUP_DRAFT_PREFIX: &str = "vps-pilot:quick-setup-draft:v1:";
const QUICK_SETUP_DRAFT_LIMIT: usize = 4_096;
const QUICK_SETUP_INVALID_SENTINEL: &str = "vps-pilot:quick-setup-draft-invalid";
pub struct LocalDatabase(Mutex<Connection>);
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub live_stats: bool,
    pub interval_seconds: u64,
    pub visible_stats: Vec<Stat>,
    pub zoom_percent: u16,
    #[serde(default)]
    pub theme: Theme,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Theme {
    #[default]
    ForestMint,
    TokyoNight,
    OneDarkPro,
    GithubDark,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Stat {
    Cpu,
    Ram,
    Storage,
    DiskIo,
    Network,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            live_stats: true,
            interval_seconds: 1,
            visible_stats: vec![
                Stat::Cpu,
                Stat::Ram,
                Stat::Storage,
                Stat::DiskIo,
                Stat::Network,
            ],
            zoom_percent: 100,
            theme: Theme::default(),
        }
    }
}
impl Settings {
    fn validate(&self) -> Result<(), String> {
        if ![1, 2, 5].contains(&self.interval_seconds)
            || !(50..=200).contains(&self.zoom_percent)
            || self.visible_stats.len() > 5
            || self
                .visible_stats
                .iter()
                .enumerate()
                .any(|(i, stat)| self.visible_stats[..i].contains(stat))
        {
            return Err("Choose valid monitoring and zoom settings.".into());
        }
        Ok(())
    }
}
impl LocalDatabase {
    pub fn open(path: &Path) -> Result<Arc<Self>, String> {
        let parent = path.parent().ok_or(ERROR)?;
        std::fs::create_dir_all(parent).map_err(|_| ERROR)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| ERROR)?;
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(path)
                .map_err(|_| ERROR)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| ERROR)?;
        }
        let mut connection = Connection::open(path).map_err(|_| ERROR)?;
        connection
            .busy_timeout(Duration::from_secs(2))
            .map_err(|_| ERROR)?;
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|_| ERROR)?;
        if version > 1 {
            return Err("This local database needs a newer VPS Pilot version.".into());
        }
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|_| ERROR)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ERROR)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); PRAGMA user_version=1;").map_err(|_| ERROR)?;
        tx.execute(
            "INSERT OR IGNORE INTO documents(key,value) VALUES('settings',?1)",
            [serde_json::to_string(&Settings::default()).map_err(|_| ERROR)?],
        )
        .map_err(|_| ERROR)?;
        tx.commit().map_err(|_| ERROR)?;
        Ok(Arc::new(Self(Mutex::new(connection))))
    }
    pub fn read(&self, key: &str) -> Result<Option<String>, String> {
        self.0
            .lock()
            .map_err(|_| ERROR)?
            .query_row("SELECT value FROM documents WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|_| ERROR.into())
    }
    pub fn import(&self, key: &str, value: &str) -> Result<String, String> {
        let mut connection = self.0.lock().map_err(|_| ERROR)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ERROR)?;
        tx.execute(
            "INSERT OR IGNORE INTO documents(key,value) VALUES(?1,?2)",
            params![key, value],
        )
        .map_err(|_| ERROR)?;
        let actual = tx
            .query_row("SELECT value FROM documents WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .map_err(|_| ERROR)?;
        tx.commit().map_err(|_| ERROR)?;
        Ok(actual)
    }
    pub fn compare_and_swap(&self, key: &str, expected: &str, value: &str) -> Result<(), String> {
        let connection = self.0.lock().map_err(|_| ERROR)?;
        let changed = connection
            .execute(
                "UPDATE documents SET value=?1 WHERE key=?2 AND value=?3",
                params![value, key, expected],
            )
            .map_err(|_| ERROR)?;
        if changed != 1 {
            return Err(
                "Saved data changed in another app instance. Restart before editing it.".into(),
            );
        }
        Ok(())
    }
    fn write(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().map_err(|_| ERROR)?.execute(
            "INSERT INTO documents(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key,value]).map_err(|_| ERROR)?;
        Ok(())
    }
    pub fn settings(&self) -> Result<Settings, String> {
        let settings: Settings =
            serde_json::from_str(&self.read("settings")?.ok_or(ERROR)?).map_err(|_| ERROR)?;
        settings.validate()?;
        Ok(settings)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuickSetupAdministrator {
    mode: String,
    username: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuickSetupSshKey {
    strategy: String,
    #[serde(default, deserialize_with = "optional_generated_key_id")]
    generated_key_id: Option<String>,
}
fn optional_generated_key_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Absent is valid for older drafts; a present reference must be a string.
    String::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuickSetupAccess {
    port: u16,
    ufw: String,
    #[serde(rename = "recoveryAcknowledged")]
    _recovery_acknowledged: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuickSetupStack {
    choice: String,
    engine: serde_json::Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuickSetupTools {
    editor: String,
    utilities: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuickSetupDraft {
    version: u8,
    step: u8,
    administrator: QuickSetupAdministrator,
    ssh_key: QuickSetupSshKey,
    access: QuickSetupAccess,
    stack: QuickSetupStack,
    tools: QuickSetupTools,
    runtimes: Vec<String>,
}
fn quick_setup_key(key: &str) -> Option<&str> {
    key.strip_prefix(QUICK_SETUP_DRAFT_PREFIX)
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
}
fn quick_setup_username_valid(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && value != "root"
        && matches!(bytes[0], b'a'..=b'z' | b'_')
        && bytes
            .iter()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
}
fn unique_allowed(values: &[String], allowed: &[&str], limit: usize) -> bool {
    values.len() <= limit
        && values.iter().enumerate().all(|(index, value)| {
            allowed.contains(&value.as_str()) && !values[..index].contains(value)
        })
}
fn validate_quick_setup_draft(value: &str) -> Result<(), String> {
    if value.len() > QUICK_SETUP_DRAFT_LIMIT {
        return Err("Invalid Quick Setup draft.".into());
    }
    let draft: QuickSetupDraft =
        serde_json::from_str(value).map_err(|_| "Invalid Quick Setup draft.".to_string())?;
    let engine = match &draft.stack.engine {
        serde_json::Value::Null => None,
        serde_json::Value::String(engine) => Some(engine.as_str()),
        _ => return Err("Invalid Quick Setup draft.".into()),
    };
    let stack_valid = match draft.stack.choice.as_str() {
        "dokploy" => engine == Some("docker"),
        "skip" => engine.is_none(),
        "javascript" | "containers" => {
            engine.is_none() || matches!(engine, Some("docker" | "podman"))
        }
        _ => false,
    };
    let generated_key_id_valid = match &draft.ssh_key.generated_key_id {
        None => true,
        Some(id) => {
            draft.ssh_key.strategy == "generate"
                && uuid::Uuid::parse_str(id)
                    .map(|parsed| parsed.to_string() == *id)
                    .unwrap_or(false)
        }
    };
    if draft.version != 1
        || !(1..=8).contains(&draft.step)
        || !["new", "existing"].contains(&draft.administrator.mode.as_str())
        || !quick_setup_username_valid(&draft.administrator.username)
        || !["existing", "generate", "agent"].contains(&draft.ssh_key.strategy.as_str())
        || !generated_key_id_valid
        || draft.access.port == 0
        || !["configure", "keep-current"].contains(&draft.access.ufw.as_str())
        || !stack_valid
        || !["none", "neovim", "lazyvim"].contains(&draft.tools.editor.as_str())
        || !unique_allowed(
            &draft.tools.utilities,
            &[
                "git", "curl", "ripgrep", "fd", "fzf", "jq", "btop", "unzip", "herdr",
            ],
            9,
        )
        || !unique_allowed(&draft.runtimes, &["bun", "nvm-node", "uv"], 3)
        || (draft.stack.choice == "javascript"
            && !draft.runtimes.iter().any(|runtime| runtime == "nvm-node"))
    {
        return Err("Invalid Quick Setup draft.".into());
    }
    Ok(())
}
fn ui_key(key: &str) -> bool {
    (key == "vps-pilot:sample-workspace:v1"
        || key == "vps-pilot-updates"
        || key == "vps-pilot:fleet:v1")
        || key
            .strip_prefix("vps-pilot:sample-terminal:v1:")
            .is_some_and(|id| {
                matches!(
                    id,
                    "sample-production" | "sample-staging" | "sample-development"
                )
            })
        || key
            .strip_prefix("vps-pilot:remote-terminal:v1:")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        || key
            .strip_prefix("vps-pilot:command-console:v1:")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        || quick_setup_key(key).is_some()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FleetDocument {
    version: u8,
    servers: HashMap<String, Organization>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Organization {
    project: String,
    tags: Vec<String>,
    environment: String,
    #[serde(rename = "favorite")]
    _favorite: bool,
    order: u32,
}
fn validate_fleet(value: &serde_json::Value) -> Result<(), String> {
    let document: FleetDocument =
        serde_json::from_value(value.clone()).map_err(|_| "Invalid server organization.")?;
    let text = |value: &str, limit: usize| {
        value.chars().count() <= limit && !value.chars().any(char::is_control)
    };
    if document.version != 1 || document.servers.len() > 100 {
        return Err("Invalid server organization.".into());
    }
    for (id, metadata) in document.servers {
        if uuid::Uuid::parse_str(&id).is_err()
            || !text(&metadata.project, 80)
            || metadata.tags.len() > 12
            || metadata
                .tags
                .iter()
                .any(|tag| tag.trim().is_empty() || !text(tag, 32))
            || !["none", "production", "staging", "development"]
                .contains(&metadata.environment.as_str())
            || metadata.order > 1_000_000
        {
            return Err("Invalid server organization.".into());
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsolePreference {
    version: u8,
    #[serde(rename = "expanded")]
    _expanded: bool,
    height: u16,
}
fn validate_document(key: &str, value: &str) -> Result<(), String> {
    if !ui_key(key) || value.len() > 128_000 {
        return Err("Unsupported saved preference.".into());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|_| "Invalid saved preference.")?;
    if key == "vps-pilot:fleet:v1" {
        validate_fleet(&parsed)?;
    }
    if quick_setup_key(key).is_some() {
        return validate_quick_setup_draft(value);
    }
    if let Some(id) = key.strip_prefix("vps-pilot:command-console:v1:") {
        if uuid::Uuid::parse_str(id).is_err() || value.len() > 256 {
            return Err("Invalid command console preference.".into());
        }
        let preference: ConsolePreference = serde_json::from_value(parsed.clone())
            .map_err(|_| "Invalid command console preference.")?;
        if preference.version != 1 || !(144..=600).contains(&preference.height) {
            return Err("Invalid command console preference.".into());
        }
    }
    fn safe(value: &serde_json::Value, depth: usize) -> bool {
        if depth > 48 {
            return false;
        }
        match value {
            serde_json::Value::Object(map) => map.iter().all(|(key, value)| {
                ![
                    "password",
                    "passphrase",
                    "secret",
                    "token",
                    "command",
                    "output",
                    "buffer",
                    "start",
                ]
                .contains(&key.as_str())
                    && safe(value, depth + 1)
            }),
            serde_json::Value::Array(values) => values.iter().all(|value| safe(value, depth + 1)),
            _ => true,
        }
    }
    if !parsed.is_object() || !safe(&parsed, 0) {
        return Err("Only non-secret workspace preferences can be saved.".into());
    }
    Ok(())
}
fn collect_bootstrap_document(
    key: String,
    value: String,
    documents: &mut HashMap<String, String>,
) -> Result<(), String> {
    if quick_setup_key(&key).is_some() {
        let value = if validate_quick_setup_draft(&value).is_ok() {
            value
        } else {
            QUICK_SETUP_INVALID_SENTINEL.to_string()
        };
        documents.insert(key, value);
        return Ok(());
    }
    if ui_key(&key) {
        validate_document(&key, &value)?;
        documents.insert(key, value);
    }
    Ok(())
}
fn bootstrap_documents(connection: &Connection) -> Result<HashMap<String, String>, String> {
    let mut statement = connection
        .prepare("SELECT key,value FROM documents WHERE key LIKE 'vps-pilot:%' OR key='vps-pilot-updates'")
        .map_err(|_| ERROR)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| ERROR)?;
    let mut documents = HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|_| ERROR)?;
        collect_bootstrap_document(key, value, &mut documents)?;
    }
    Ok(documents)
}
#[derive(Serialize)]
pub struct Bootstrap {
    settings: Settings,
    documents: HashMap<String, String>,
}
#[tauri::command(async)]
pub fn app_bootstrap(db: tauri::State<'_, Arc<LocalDatabase>>) -> Result<Bootstrap, String> {
    let settings = db.settings()?;
    let connection = db.0.lock().map_err(|_| ERROR)?;
    let documents = bootstrap_documents(&connection)?;
    Ok(Bootstrap {
        settings,
        documents,
    })
}
#[tauri::command(async)]
pub fn app_save_settings(
    db: tauri::State<'_, Arc<LocalDatabase>>,
    settings: Settings,
) -> Result<Settings, String> {
    settings.validate()?;
    db.write(
        "settings",
        &serde_json::to_string(&settings).map_err(|_| ERROR)?,
    )?;
    Ok(settings)
}
#[tauri::command(async)]
pub fn app_save_document(
    db: tauri::State<'_, Arc<LocalDatabase>>,
    key: String,
    value: String,
    import: bool,
) -> Result<String, String> {
    validate_document(&key, &value)?;
    if import {
        db.import(&key, &value)
    } else {
        db.write(&key, &value)?;
        Ok(value)
    }
}

#[tauri::command]
pub fn app_apply_zoom(window: tauri::WebviewWindow, zoom_percent: u16) -> Result<(), String> {
    if !(50..=200).contains(&zoom_percent) {
        return Err("Use an app zoom between 50% and 200%.".into());
    }
    window
        .set_zoom(f64::from(zoom_percent) / 100.0)
        .map_err(|_| "Could not apply app zoom.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_real_sqlite_with_defaults_and_persists_validated_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite3");
        let db = LocalDatabase::open(&path).unwrap();
        assert!(db.settings().unwrap().live_stats);
        let mut settings = db.settings().unwrap();
        settings.interval_seconds = 5;
        settings.zoom_percent = 125;
        settings.visible_stats = vec![Stat::Cpu, Stat::Network];
        settings.validate().unwrap();
        db.write("settings", &serde_json::to_string(&settings).unwrap())
            .unwrap();
        drop(db);
        assert_eq!(&std::fs::read(&path).unwrap()[..16], b"SQLite format 3\0");
        assert_eq!(
            LocalDatabase::open(&path).unwrap().settings().unwrap(),
            settings
        );
        settings.visible_stats = vec![Stat::Cpu, Stat::Cpu];
        assert!(settings.validate().is_err());
        settings.visible_stats.clear();
        settings.zoom_percent = 500;
        assert!(settings.validate().is_err());
    }
    #[test]
    fn themes_default_for_old_settings_and_persist_across_database_reopens() {
        let legacy =
            r#"{"liveStats":false,"intervalSeconds":5,"visibleStats":["cpu"],"zoomPercent":125}"#;
        let legacy_settings: Settings = serde_json::from_str(legacy).unwrap();
        assert_eq!(legacy_settings.theme, Theme::ForestMint);
        assert!(!legacy_settings.live_stats);
        assert_eq!(legacy_settings.zoom_percent, 125);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite3");
        let db = LocalDatabase::open(&path).unwrap();
        db.write("settings", legacy).unwrap();
        drop(db);
        assert_eq!(
            LocalDatabase::open(&path).unwrap().settings().unwrap(),
            legacy_settings
        );
        for theme in [
            Theme::TokyoNight,
            Theme::OneDarkPro,
            Theme::GithubDark,
            Theme::ForestMint,
        ] {
            let db = LocalDatabase::open(&path).unwrap();
            let mut settings = db.settings().unwrap();
            settings.theme = theme.clone();
            db.write("settings", &serde_json::to_string(&settings).unwrap())
                .unwrap();
            drop(db);
            let actual = LocalDatabase::open(&path).unwrap().settings().unwrap();
            assert_eq!(actual.theme, theme);
            assert_eq!(actual.interval_seconds, 5);
            assert_eq!(actual.visible_stats, vec![Stat::Cpu]);
        }
        assert!(serde_json::from_str::<Settings>(
            &legacy.replace("125}", "125,\"theme\":\"arbitrary\"}")
        )
        .is_err());
    }

    #[test]
    fn keeps_corrupt_and_newer_databases_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("corrupt.sqlite3");
        std::fs::write(&path, b"not a database").unwrap();
        assert!(LocalDatabase::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"not a database");
        let path = dir.path().join("newer.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("PRAGMA user_version=99; CREATE TABLE future(value TEXT); INSERT INTO future VALUES('preserved');").unwrap();
        drop(connection);
        assert!(LocalDatabase::open(&path).is_err());
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT value FROM future", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "preserved"
        );
    }
    #[test]
    fn command_console_preferences_are_strict_bounded_and_persist() {
        let id = "11111111-1111-4111-8111-111111111111";
        let key = format!("vps-pilot:command-console:v1:{id}");
        let value = r#"{"version":1,"expanded":true,"height":280}"#;
        validate_document(&key, value).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite3");
        let db = LocalDatabase::open(&path).unwrap();
        db.write("ssh_profiles", "preserved profile").unwrap();
        db.write(&key, value).unwrap();
        drop(db);
        let db = LocalDatabase::open(&path).unwrap();
        assert_eq!(db.read(&key).unwrap().as_deref(), Some(value));
        assert_eq!(
            db.read("ssh_profiles").unwrap().as_deref(),
            Some("preserved profile")
        );
        for rejected in [
            r#"{"version":2,"expanded":true,"height":280}"#,
            r#"{"version":1,"expanded":"yes","height":280}"#,
            r#"{"version":1,"expanded":true,"height":143}"#,
            r#"{"version":1,"expanded":true,"height":601}"#,
            r#"{"version":1,"expanded":true,"height":280,"command":"not stored"}"#,
            r#"{"version":1,"expanded":true,"height":280,"output":"not stored"}"#,
        ] {
            assert!(validate_document(&key, rejected).is_err(), "{rejected}");
        }
        let oversized = format!(
            r#"{{ "version": 1, "expanded": true, "height": 280 }}{}"#,
            " ".repeat(300)
        );
        assert!(validate_document(&key, &oversized).is_err());
        assert!(validate_document("vps-pilot:command-console:v1:not-a-uuid", value).is_err());
    }
    #[test]
    fn fleet_metadata_is_bounded_strict_and_persists_without_touching_profiles() {
        let key = "vps-pilot:fleet:v1";
        let id = "11111111-1111-4111-8111-111111111111";
        let mut value = serde_json::json!({"version":1,"servers":{id:{"project":"Portal","tags":["api"],"environment":"production","favorite":true,"order":2}}});
        validate_document(key, &value.to_string()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite3");
        let db = LocalDatabase::open(&path).unwrap();
        db.write("ssh_profiles", "preserved profile and host pin")
            .unwrap();
        db.write(key, &value.to_string()).unwrap();
        drop(db);
        let db = LocalDatabase::open(&path).unwrap();
        assert_eq!(db.read(key).unwrap(), Some(value.to_string()));
        assert_eq!(
            db.read("ssh_profiles").unwrap().as_deref(),
            Some("preserved profile and host pin")
        );
        value["servers"][id]["password"] = serde_json::json!("never save");
        assert!(validate_document(key, &value.to_string()).is_err());
        value["servers"][id]
            .as_object_mut()
            .unwrap()
            .remove("password");
        value["servers"][id]["order"] = serde_json::json!(-1);
        assert!(validate_document(key, &value.to_string()).is_err());
        value["servers"][id]["order"] = serde_json::json!(0);
        value["servers"][id]["tags"] = serde_json::json!(vec!["tag"; 13]);
        assert!(validate_document(key, &value.to_string()).is_err());
        assert!(validate_document(key, r#"{"version":1,"servers":{"invalid-id":{"project":"","tags":[],"environment":"none","favorite":false,"order":0}}}"#).is_err());
    }
    fn valid_quick_setup_draft() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "step": 4,
            "administrator": { "mode": "new", "username": "deploy" },
            "sshKey": { "strategy": "generate" },
            "access": { "port": 2222, "ufw": "configure", "recoveryAcknowledged": true },
            "stack": { "choice": "dokploy", "engine": "docker" },
            "tools": {
                "editor": "lazyvim",
                "utilities": ["git", "curl", "ripgrep", "fd", "fzf", "herdr"]
            },
            "runtimes": ["bun", "nvm-node", "uv"]
        })
    }
    #[test]
    fn quick_setup_draft_is_strict_bounded_and_persists_per_server() {
        let id = "11111111-1111-4111-8111-111111111111";
        let key = format!("{QUICK_SETUP_DRAFT_PREFIX}{id}");
        let valid = valid_quick_setup_draft();
        let serialized = valid.to_string();
        validate_document(&key, &serialized).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite3");
        let db = LocalDatabase::open(&path).unwrap();
        db.write("ssh_profiles", "preserved profile and host pin")
            .unwrap();
        db.write(&key, &serialized).unwrap();
        drop(db);
        let db = LocalDatabase::open(&path).unwrap();
        assert_eq!(db.read(&key).unwrap(), Some(serialized));
        assert_eq!(
            db.read("ssh_profiles").unwrap().as_deref(),
            Some("preserved profile and host pin")
        );
    }
    #[test]
    fn quick_setup_generated_key_reference_is_optional_opaque_and_strategy_bound() {
        let id = "11111111-1111-4111-8111-111111111111";
        let key = format!("{QUICK_SETUP_DRAFT_PREFIX}{id}");
        let mut draft = valid_quick_setup_draft();
        validate_document(&key, &draft.to_string()).unwrap();
        let generated = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        draft["sshKey"] =
            serde_json::json!({ "strategy": "generate", "generatedKeyId": generated });
        validate_document(&key, &draft.to_string()).unwrap();
        let serialized = draft.to_string();
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDatabase::open(&dir.path().join("app.sqlite3")).unwrap();
        db.write(&key, &serialized).unwrap();
        assert_eq!(db.read(&key).unwrap(), Some(serialized));
        for invalid in [
            serde_json::json!({ "strategy": "generate", "generatedKeyId": null }),
            serde_json::json!({ "strategy": "existing", "generatedKeyId": null }),
            serde_json::json!({ "strategy": "generate", "generatedKeyId": "not-a-uuid" }),
            serde_json::json!({ "strategy": "generate", "generatedKeyId": generated.to_uppercase() }),
            serde_json::json!({ "strategy": "generate", "generatedKeyId": "../escape" }),
            serde_json::json!({ "strategy": "existing", "generatedKeyId": generated }),
            serde_json::json!({ "strategy": "agent", "generatedKeyId": generated }),
            serde_json::json!({ "strategy": "generate", "generatedKeyId": generated, "path": "/tmp/key" }),
            serde_json::json!({ "strategy": "generate", "generatedKeyId": generated, "passphrase": "never save" }),
        ] {
            let mut rejected = valid_quick_setup_draft();
            rejected["sshKey"] = invalid.clone();
            assert!(
                validate_document(&key, &rejected.to_string()).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn quick_setup_draft_rejects_unexpected_secrets_freeform_fields_and_versions() {
        let id = "11111111-1111-4111-8111-111111111111";
        let key = format!("{QUICK_SETUP_DRAFT_PREFIX}{id}");
        let valid = valid_quick_setup_draft();
        let rejected = [
            ("version", serde_json::json!(2)),
            ("step", serde_json::json!(9)),
            ("step", serde_json::json!(0)),
            ("password", serde_json::json!("never save this secret")),
            ("command", serde_json::json!("rm -rf / --no-preserve-root")),
        ];
        for (field, value) in rejected {
            let mut draft = valid.clone();
            draft[field] = value;
            assert!(
                validate_document(&key, &draft.to_string()).is_err(),
                "{field}"
            );
        }
        for username in ["root", "Deploy", "-ops", "deploy user"] {
            let mut draft = valid.clone();
            draft["administrator"]["username"] = serde_json::json!(username);
            assert!(validate_document(&key, &draft.to_string()).is_err());
        }
        let mut draft = valid.clone();
        draft["administrator"]["secret"] = serde_json::json!("never save");
        assert!(validate_document(&key, &draft.to_string()).is_err());
        let mut draft = valid.clone();
        draft["sshKey"]["passphrase"] = serde_json::json!("never save");
        assert!(validate_document(&key, &draft.to_string()).is_err());
        for port in [0, -1, 65536] {
            let mut draft = valid.clone();
            draft["access"]["port"] = serde_json::json!(port);
            assert!(validate_document(&key, &draft.to_string()).is_err());
        }
        for (choice, engine) in [
            ("kubernetes", serde_json::Value::Null),
            ("dokploy", serde_json::json!("podman")),
            ("dokploy", serde_json::Value::Null),
            ("skip", serde_json::json!("docker")),
            ("containers", serde_json::json!("lxc")),
        ] {
            let mut draft = valid.clone();
            draft["stack"]["choice"] = serde_json::json!(choice);
            draft["stack"]["engine"] = engine;
            assert!(
                validate_document(&key, &draft.to_string()).is_err(),
                "{choice}"
            );
        }
        for choice in ["dokploy", "javascript", "containers", "skip"] {
            let mut draft = valid.clone();
            draft["stack"] = serde_json::json!({ "choice": choice });
            if choice == "javascript" {
                draft["runtimes"] = serde_json::json!(["nvm-node"]);
            }
            assert!(
                validate_document(&key, &draft.to_string()).is_err(),
                "missing engine for {choice}"
            );
        }
        for utilities in [
            serde_json::json!(["git", "git"]),
            serde_json::json!(["tmux"]),
            serde_json::json!(["git", "curl", "ripgrep", "fd", "fzf", "jq", "btop", "unzip", "jq"]),
        ] {
            let mut draft = valid.clone();
            draft["tools"]["utilities"] = utilities;
            assert!(validate_document(&key, &draft.to_string()).is_err());
        }
        for runtimes in [
            serde_json::json!(["bun", "bun"]),
            serde_json::json!(["deno"]),
            serde_json::json!(["bun", "nvm-node", "uv", "bun"]),
        ] {
            let mut draft = valid.clone();
            draft["runtimes"] = runtimes;
            assert!(validate_document(&key, &draft.to_string()).is_err());
        }
        let mut draft = valid.clone();
        draft["stack"] = serde_json::json!({ "choice": "javascript", "engine": null });
        draft["runtimes"] = serde_json::json!(["bun", "uv"]);
        assert!(validate_document(&key, &draft.to_string()).is_err());
        draft["runtimes"] = serde_json::json!(["bun", "nvm-node", "uv"]);
        validate_document(&key, &draft.to_string()).unwrap();
        let mut draft = valid.clone();
        draft["tools"]["editor"] = serde_json::json!("vscode");
        assert!(validate_document(&key, &draft.to_string()).is_err());
        let oversized = format!("{}{}", valid, " ".repeat(5_000));
        assert!(validate_document(&key, &oversized).is_err());
        assert!(validate_document(
            "vps-pilot:quick-setup-draft:v1:not-a-uuid",
            &valid.to_string()
        )
        .is_err());
    }
    #[test]
    fn bootstrap_replaces_every_invalid_quick_setup_draft_with_a_bounded_sentinel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite3");
        let first_id = "11111111-1111-4111-8111-111111111111";
        let second_id = "22222222-2222-4222-8222-222222222222";
        let third_id = "33333333-3333-4333-8333-333333333333";
        let fourth_id = "44444444-4444-4444-8444-444444444444";
        let fifth_id = "55555555-5555-4555-8555-555555555555";
        let first_key = format!("{QUICK_SETUP_DRAFT_PREFIX}{first_id}");
        let second_key = format!("{QUICK_SETUP_DRAFT_PREFIX}{second_id}");
        let third_key = format!("{QUICK_SETUP_DRAFT_PREFIX}{third_id}");
        let fourth_key = format!("{QUICK_SETUP_DRAFT_PREFIX}{fourth_id}");
        let fifth_key = format!("{QUICK_SETUP_DRAFT_PREFIX}{fifth_id}");
        let corrupt = r#"{"version":2,"step":9}"#.to_string();
        let malformed = "{not-json".to_string();
        let oversized = format!("{{\"version\":1}}{}", " ".repeat(130_000));
        let valid = valid_quick_setup_draft().to_string();
        {
            let db = LocalDatabase::open(&path).unwrap();
            db.write(&first_key, &corrupt).unwrap();
            db.write(&second_key, &valid).unwrap();
            db.write(&third_key, &oversized).unwrap();
            db.write(&fourth_key, &malformed).unwrap();
            db.write(&fifth_key, "").unwrap();
        }
        let db = LocalDatabase::open(&path).unwrap();
        let connection = db.0.lock().unwrap();
        let documents = bootstrap_documents(&connection).unwrap();
        drop(connection);
        assert_eq!(
            documents.get(&first_key).map(String::as_str),
            Some(QUICK_SETUP_INVALID_SENTINEL)
        );
        assert_eq!(documents.get(&second_key), Some(&valid));
        assert_eq!(
            documents.get(&third_key).map(String::as_str),
            Some(QUICK_SETUP_INVALID_SENTINEL)
        );
        assert_eq!(
            documents.get(&fourth_key).map(String::as_str),
            Some(QUICK_SETUP_INVALID_SENTINEL)
        );
        assert_eq!(
            documents.get(&fifth_key).map(String::as_str),
            Some(QUICK_SETUP_INVALID_SENTINEL)
        );
        assert!(documents.values().all(|value| value != &corrupt));
        assert!(documents.values().all(|value| value != &malformed));
        assert_eq!(db.read(&first_key).unwrap(), Some(corrupt));
        assert_eq!(
            db.read(&third_key).unwrap().map(|value| value.len()),
            Some(oversized.len())
        );
        assert_eq!(db.read(&fourth_key).unwrap(), Some(malformed));
        assert_eq!(db.read(&fifth_key).unwrap().as_deref(), Some(""));
    }
    #[test]
    fn document_scope_blocks_credentials_profiles_and_sql_injection() {
        assert!(validate_document("ssh_profiles", "{}").is_err());
        assert!(
            validate_document("vps-pilot:sample-workspace:v1", "{\"password\":\"secret\"}")
                .is_err()
        );
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDatabase::open(&dir.path().join("app.sqlite3")).unwrap();
        let value = "{\"name\":\"'; DROP TABLE documents; --\"}";
        db.write("fixture", value).unwrap();
        assert_eq!(db.read("fixture").unwrap().as_deref(), Some(value));
        assert!(db.read("settings").unwrap().is_some());
        assert_eq!(db.import("fixture", "new").unwrap(), value);
        assert!(db.compare_and_swap("fixture", "stale", "new").is_err());
        assert_eq!(db.read("fixture").unwrap().as_deref(), Some(value));
    }
}
