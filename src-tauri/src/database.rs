use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

const ERROR: &str = "Local database could not be read or saved. Existing data was preserved.";
pub struct LocalDatabase(Mutex<Connection>);
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub live_stats: bool,
    pub interval_seconds: u64,
    pub visible_stats: Vec<Stat>,
    pub zoom_percent: u16,
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
fn ui_key(key: &str) -> bool {
    (key == "vps-pilot:sample-workspace:v1" || key == "vps-pilot-updates")
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
}
fn validate_document(key: &str, value: &str) -> Result<(), String> {
    if !ui_key(key) || value.len() > 128_000 {
        return Err("Unsupported saved preference.".into());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|_| "Invalid saved preference.")?;
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
#[derive(Serialize)]
pub struct Bootstrap {
    settings: Settings,
    documents: HashMap<String, String>,
}
#[tauri::command(async)]
pub fn app_bootstrap(db: tauri::State<'_, Arc<LocalDatabase>>) -> Result<Bootstrap, String> {
    let settings = db.settings()?;
    let connection = db.0.lock().map_err(|_| ERROR)?;
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
        if ui_key(&key) {
            validate_document(&key, &value)?;
            documents.insert(key, value);
        }
    }
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
