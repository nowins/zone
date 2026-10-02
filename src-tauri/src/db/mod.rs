use rusqlite::Connection;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

mod schema;

pub(crate) use schema::ensure_schema;

pub(crate) const ZONE_DB_FILE_NAME: &str = "zone.sqlite";
pub(crate) const LEGACY_PODCAST_DB_FILE_NAME: &str = "podcasts.sqlite";
pub(crate) const LEGACY_METADATA_DB_FILE_NAME: &str = "music-metadata.sqlite";

#[derive(Clone, Debug)]
pub(crate) struct ZoneDbPaths {
  pub app_data_dir: PathBuf,
  pub db_path: PathBuf,
  pub legacy_dir: PathBuf,
}

impl ZoneDbPaths {
  pub(crate) fn from_app_data_dir(app_data_dir: impl Into<PathBuf>) -> Self {
    let app_data_dir = app_data_dir.into();
    Self {
      db_path: app_data_dir.join(ZONE_DB_FILE_NAME),
      legacy_dir: app_data_dir.join("legacy"),
      app_data_dir,
    }
  }
}

pub(crate) fn open_zone_database(path: &Path) -> Result<Connection, String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| format!("无法创建数据库目录：{error}"))?;
  }

  let connection =
    Connection::open(path).map_err(|error| format!("无法打开 Zone 数据库：{error}"))?;
  configure_connection(&connection)?;
  ensure_schema_once_per_path(&connection, path)?;
  Ok(connection)
}

// ensure_schema runs dozens of CREATE/PRAGMA statements plus the podcast compat
// backfills; it is idempotent, so once per process and path is enough. Command
// handlers open a fresh connection per call (progress saves, stream chunks),
// which must not pay the full schema cost every time.
static ENSURED_SCHEMA_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn ensure_schema_once_per_path(connection: &Connection, path: &Path) -> Result<(), String> {
  let ensured_paths = ENSURED_SCHEMA_PATHS.get_or_init(|| Mutex::new(HashSet::new()));
  if ensured_paths
    .lock()
    .map_err(|_| "无法读取数据库结构状态".to_string())?
    .contains(path)
  {
    return Ok(());
  }
  ensure_schema(connection)?;
  ensured_paths
    .lock()
    .map_err(|_| "无法保存数据库结构状态".to_string())?
    .insert(path.to_path_buf());
  Ok(())
}

pub(crate) fn initialize_zone_database(app_data_dir: &Path) -> Result<PathBuf, String> {
  let paths = ZoneDbPaths::from_app_data_dir(app_data_dir);
  fs::create_dir_all(&paths.app_data_dir)
    .map_err(|error| format!("无法创建应用数据目录：{error}"))?;
  fs::create_dir_all(&paths.legacy_dir).map_err(|error| format!("无法创建迁移备份目录：{error}"))?;

  let connection = open_zone_database(&paths.db_path)?;
  import_legacy_sqlite_if_needed(
    &connection,
    &paths,
    LEGACY_PODCAST_DB_FILE_NAME,
    "migration.podcasts_sqlite",
    &[
      "podcast_feeds",
      "podcast_episodes",
      "podcast_downloads",
      "podcast_progress",
      "podcast_saved_episodes",
      "podcast_queue",
      "podcast_episode_resources",
      "podcast_chapters",
    ],
  )?;
  import_legacy_sqlite_if_needed(
    &connection,
    &paths,
    LEGACY_METADATA_DB_FILE_NAME,
    "migration.music_metadata_sqlite",
    &[
      "metadata_entities",
      "metadata_entity_links",
      "metadata_fields",
      "metadata_provider_bindings",
      "metadata_artwork_cache",
    ],
  )?;
  drop(connection);
  Ok(paths.db_path)
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
  connection
    .busy_timeout(Duration::from_secs(5))
    .map_err(|error| format!("无法配置 Zone 数据库：{error}"))?;
  connection
    .execute_batch(
      "
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      ",
    )
    .map_err(|error| format!("无法初始化 Zone 数据库连接：{error}"))?;
  Ok(())
}

fn import_legacy_sqlite_if_needed(
  connection: &Connection,
  paths: &ZoneDbPaths,
  legacy_file_name: &str,
  migration_key: &str,
  tables: &[&str],
) -> Result<(), String> {
  let legacy_path = paths.app_data_dir.join(legacy_file_name);
  if migration_flag_is_done(connection, migration_key)? {
    return archive_legacy_file(&legacy_path, &paths.legacy_dir);
  }

  if !legacy_path.exists() {
    set_migration_flag(connection, migration_key, "skipped")?;
    return Ok(());
  }

  connection
    .execute(
      "ATTACH DATABASE ?1 AS legacy_db",
      rusqlite::params![legacy_path.to_string_lossy()],
    )
    .map_err(|error| format!("无法挂载旧数据库 {legacy_file_name}：{error}"))?;

  let attach_result = (|| -> Result<(), String> {
    let transaction = connection.unchecked_transaction()
      .map_err(|error| format!("无法开始旧数据库迁移：{error}"))?;
    for table in tables {
      copy_table_rows(&transaction, table)?;
    }
    if migration_key == "migration.podcasts_sqlite" {
      crate::db::schema::ensure_podcast_schema(&transaction)?;
    }
    set_migration_flag(&transaction, migration_key, "done")?;
    transaction.commit().map_err(|error| format!("无法提交旧数据库迁移：{error}"))?;
    Ok(())
  })();

  let detach_result = connection
    .execute("DETACH DATABASE legacy_db", [])
    .map_err(|error| format!("无法卸载旧数据库 {legacy_file_name}：{error}"));

  attach_result?;
  detach_result?;

  archive_legacy_file(&legacy_path, &paths.legacy_dir)?;
  Ok(())
}

fn copy_table_rows(connection: &Connection, table: &str) -> Result<(), String> {
  // Table names are static constants from this module.
  let destination_columns = table_columns(connection, "main", table)?;
  let source_columns = match table_columns(connection, "legacy_db", table) {
    Ok(columns) => columns,
    Err(error) if error.contains("no such table") => return Ok(()),
    Err(error) => return Err(error),
  };

  let shared_columns: Vec<String> = destination_columns
    .into_iter()
    .filter(|column| source_columns.iter().any(|source| source == column))
    .collect();
  if shared_columns.is_empty() {
    return Ok(());
  }

  let column_list = shared_columns
    .iter()
    .map(|column| format!("\"{column}\""))
    .collect::<Vec<_>>()
    .join(", ");
  let sql = format!(
    "INSERT INTO {table} ({column_list}) SELECT {column_list} FROM legacy_db.{table} WHERE 1 ON CONFLICT DO NOTHING"
  );
  connection
    .execute(&sql, [])
    .map(|_| ())
    .map_err(|error| format!("无法导入表 {table}：{error}"))
}

fn table_columns(
  connection: &Connection,
  schema: &str,
  table: &str,
) -> Result<Vec<String>, String> {
  let pragma = format!("PRAGMA {schema}.table_info({table})");
  let mut statement = connection
    .prepare(&pragma)
    .map_err(|error| format!("无法读取表结构 {schema}.{table}：{error}"))?;
  let rows = statement
    .query_map([], |row| row.get::<_, String>(1))
    .map_err(|error| format!("无法读取表结构 {schema}.{table}：{error}"))?;
  let mut columns = Vec::new();
  for row in rows {
    columns.push(row.map_err(|error| format!("无法读取表结构 {schema}.{table}：{error}"))?);
  }
  if columns.is_empty() {
    let master = if schema == "main" {
      "sqlite_master".to_string()
    } else {
      format!("{schema}.sqlite_master")
    };
    let exists: i64 = connection
      .query_row(
        &format!("SELECT COUNT(*) FROM {master} WHERE type = 'table' AND name = ?1"),
        rusqlite::params![table],
        |row| row.get(0),
      )
      .unwrap_or(0);
    if exists == 0 {
      return Err(format!("no such table: {schema}.{table}"));
    }
  }
  Ok(columns)
}

fn migration_flag_is_done(connection: &Connection, key: &str) -> Result<bool, String> {
  let value = connection
    .query_row(
      "SELECT value_json FROM app_settings WHERE key = ?1",
      rusqlite::params![key],
      |row| row.get::<_, String>(0),
    )
    .optional_err()
    .map_err(|error| format!("无法读取迁移标记：{error}"))?;
  Ok(matches!(value.as_deref(), Some("\"done\"") | Some("done")))
}

fn set_migration_flag(connection: &Connection, key: &str, status: &str) -> Result<(), String> {
  let now = unix_millis();
  let value_json = serde_json::to_string(status)
    .map_err(|error| format!("无法序列化迁移标记：{error}"))?;
  connection
    .execute(
      "
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
      ",
      rusqlite::params![key, value_json, now],
    )
    .map_err(|error| format!("无法写入迁移标记：{error}"))?;
  Ok(())
}

fn archive_legacy_file(legacy_path: &Path, legacy_dir: &Path) -> Result<(), String> {
  if !legacy_path.exists() {
    return Ok(());
  }
  fs::create_dir_all(legacy_dir).map_err(|error| format!("无法创建迁移备份目录：{error}"))?;
  let file_name = legacy_path
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("legacy.sqlite");
  let mut destination = legacy_dir.join(format!("{file_name}.bak"));
  let mut suffix = 0;
  while destination.exists() {
    suffix += 1;
    destination = legacy_dir.join(format!("{file_name}.{suffix}.bak"));
  }
  // SQLite reads a consistent snapshot including any committed WAL pages.
  // Never overwrite an earlier recovery backup or remove the source first.
  let source = Connection::open_with_flags(legacy_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("无法读取旧数据库备份源：{error}"))?;
  source.execute("VACUUM INTO ?1", rusqlite::params![destination.to_string_lossy()])
    .map_err(|error| format!("无法备份旧数据库 {file_name}：{error}"))?;
  drop(source);
  fs::remove_file(legacy_path).map_err(|error| format!("无法归档旧数据库 {file_name}：{error}"))?;

  // Best-effort cleanup of sidecar journal files.
  for suffix in ["-wal", "-shm"] {
    let sidecar = PathBuf::from(format!("{}{suffix}", legacy_path.display()));
    if sidecar.exists() {
      let _ = fs::remove_file(sidecar);
    }
  }
  Ok(())
}

pub(crate) fn unix_millis() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis() as i64)
    .unwrap_or(0)
}

trait OptionalQuery<T> {
  fn optional_err(self) -> Result<Option<T>, rusqlite::Error>;
}

impl<T> OptionalQuery<T> for Result<T, rusqlite::Error> {
  fn optional_err(self) -> Result<Option<T>, rusqlite::Error> {
    match self {
      Ok(value) => Ok(Some(value)),
      Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
      Err(error) => Err(error),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use rusqlite::params;

  fn seed_interrupted_migration(root: &Path) -> PathBuf {
    let path = root.join(LEGACY_PODCAST_DB_FILE_NAME);
    let source = Connection::open(&path).unwrap();
    source.execute_batch("CREATE TABLE podcast_feeds (id TEXT PRIMARY KEY, feed_url TEXT, title TEXT, last_fetched_at INTEGER);
      INSERT INTO podcast_feeds VALUES ('feed-one', 'https://example.test/feed', '旧节目', 1);
      CREATE TABLE podcast_episodes (id TEXT PRIMARY KEY, feed_id TEXT, identity_key TEXT, title TEXT, enclosure_url TEXT);
      INSERT INTO podcast_episodes VALUES ('episode-one', 'feed-one', 'ep1', '旧单集', 'https://example.test/a.mp3');").unwrap();
    path
  }

  #[test]
  fn interrupted_import_rolls_back_and_retries_all_tables() {
    let root = test_root("atomic-import");
    let source = seed_interrupted_migration(&root);
    let target = open_zone_database(&root.join(ZONE_DB_FILE_NAME)).unwrap();
    target.execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON podcast_episodes BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
    assert!(initialize_zone_database(&root).is_err());
    assert!(source.exists());
    assert!(!migration_flag_is_done(&target, "migration.podcasts_sqlite").unwrap());
    assert_eq!(target.query_row("SELECT COUNT(*) FROM podcast_feeds", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    target.execute_batch("DROP TRIGGER fail_import").unwrap();
    // Recover partial writes made by an earlier version; first-table rows are
    // not evidence that all later tables have already migrated.
    target.execute_batch("INSERT INTO podcast_feeds (id, feed_url, title, last_fetched_at) VALUES ('feed-one', 'https://example.test/feed', '已更新节目', 1);").unwrap();
    initialize_zone_database(&root).unwrap();
    assert_eq!(target.query_row("SELECT COUNT(*) FROM podcast_episodes", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(target.query_row("SELECT title FROM podcast_feeds", [], |r| r.get::<_, String>(0)).unwrap(), "已更新节目");
    assert!(migration_flag_is_done(&target, "migration.podcasts_sqlite").unwrap());
    assert!(!source.exists());
    let backup = Connection::open(root.join("legacy/podcasts.sqlite.bak")).unwrap();
    assert_eq!(backup.query_row("SELECT COUNT(*) FROM podcast_episodes", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
  }

  #[test]
  fn committed_import_retries_archival_and_keeps_previous_backups() {
    let root = test_root("archive-retry");
    let source = seed_interrupted_migration(&root);
    let paths = ZoneDbPaths::from_app_data_dir(&root);
    fs::write(&paths.legacy_dir, b"injected directory failure").unwrap();
    let target = open_zone_database(&paths.db_path).unwrap();
    let tables = ["podcast_feeds", "podcast_episodes"];
    assert!(import_legacy_sqlite_if_needed(&target, &paths, LEGACY_PODCAST_DB_FILE_NAME, "migration.podcasts_sqlite", &tables).is_err());
    assert!(source.exists());
    assert!(migration_flag_is_done(&target, "migration.podcasts_sqlite").unwrap());
    fs::remove_file(&paths.legacy_dir).unwrap();
    fs::create_dir(&paths.legacy_dir).unwrap();
    fs::write(paths.legacy_dir.join("podcasts.sqlite.bak"), b"previous recovery backup").unwrap();
    import_legacy_sqlite_if_needed(&target, &paths, LEGACY_PODCAST_DB_FILE_NAME, "migration.podcasts_sqlite", &tables).unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(paths.legacy_dir.join("podcasts.sqlite.bak")).unwrap(), b"previous recovery backup");
    let backup = Connection::open(paths.legacy_dir.join("podcasts.sqlite.1.bak")).unwrap();
    assert_eq!(backup.query_row("SELECT COUNT(*) FROM podcast_episodes", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
  }

  #[test]
  fn archival_snapshot_includes_committed_wal_pages() {
    let root = test_root("wal-archive");
    let source_path = root.join(LEGACY_PODCAST_DB_FILE_NAME);
    let source = Connection::open(&source_path).unwrap();
    source.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE wal_test (value TEXT); INSERT INTO wal_test VALUES ('committed');").unwrap();
    let _ = archive_legacy_file(&source_path, &root.join("legacy"));
    let backup = Connection::open(root.join("legacy/podcasts.sqlite.bak")).unwrap();
    assert_eq!(backup.query_row("SELECT value FROM wal_test", [], |r| r.get::<_, String>(0)).unwrap(), "committed");
  }

  fn test_root(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    let directory =
      std::env::temp_dir().join(format!("zone-db-{name}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&directory).expect("create test root");
    directory
  }

  #[test]
  fn initialize_creates_zone_sqlite_and_core_tables() {
    let root = test_root("init");
    let db_path = initialize_zone_database(&root).expect("initialize zone db");
    assert_eq!(db_path, root.join(ZONE_DB_FILE_NAME));
    assert!(db_path.exists());

    let connection = open_zone_database(&db_path).expect("reopen");
    for table in [
      "app_settings",
      "music_tracks",
      "music_track_stats",
      "radio_sessions",
      "metadata_entities",
      "podcast_feeds",
    ] {
      let exists: i64 = connection
        .query_row(
          "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
          params![table],
          |row| row.get(0),
        )
        .expect("query table");
      assert_eq!(exists, 1, "{table} should exist");
    }
  }

  #[test]
  fn schema_ensure_is_remembered_per_path_within_the_process() {
    let root = test_root("schema-once");
    let db_path = root.join(ZONE_DB_FILE_NAME);
    drop(open_zone_database(&db_path).expect("first open ensures schema"));
    assert!(
      ENSURED_SCHEMA_PATHS
        .get()
        .expect("schema cache initialized")
        .lock()
        .expect("lock schema cache")
        .contains(&db_path),
      "first open must record the ensured path",
    );
    let connection = open_zone_database(&db_path).expect("second open reuses ensured schema");
    let table_exists: i64 = connection
      .query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'podcast_feeds'",
        [],
        |row| row.get(0),
      )
      .expect("query table");
    assert_eq!(table_exists, 1);
  }

  #[test]
  fn music_home_pins_table_is_rebuilt_to_accept_podcast_feed_pins() {
    let root = test_root("home-pins-kind-migration");
    let db_path = root.join(ZONE_DB_FILE_NAME);
    {
      let connection = Connection::open(&db_path).expect("create legacy db");
      connection
        .execute_batch(
          "
          CREATE TABLE music_home_pins (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK(kind IN ('track', 'album', 'artist', 'playlist')),
            target_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(kind, target_id)
          );
          INSERT INTO music_home_pins (id, kind, target_id, position, created_at)
            VALUES ('track:t1', 'track', 't1', 0, 1);
          ",
        )
        .expect("seed legacy home pins table");
    }

    let connection = open_zone_database(&db_path).expect("migrate home pins table");
    let surviving: String = connection
      .query_row(
        "SELECT target_id FROM music_home_pins WHERE id = 'track:t1'",
        [],
        |row| row.get(0),
      )
      .expect("legacy pin survives migration");
    assert_eq!(surviving, "t1");
    let defaults: (Option<String>, Option<bool>, Option<String>) = connection.query_row(
      "SELECT size, live, tone FROM music_home_pins WHERE id = 'track:t1'", [],
      |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).expect("legacy tile gains nullable customization fields");
    assert_eq!(defaults, (None, None, None));
    connection
      .execute(
        "INSERT INTO music_home_pins (id, kind, target_id, position, created_at)
         VALUES ('podcastFeed:feed-1', 'podcastFeed', 'feed-1', 1, 2)",
        [],
      )
      .expect("podcastFeed pin accepted after migration");

    drop(connection);
    fs::remove_dir_all(root).expect("cleanup test root");
  }

  #[test]
  fn imports_legacy_podcast_and_metadata_sqlite_once() {
    let root = test_root("legacy-import");
    let legacy_podcast = root.join(LEGACY_PODCAST_DB_FILE_NAME);
    let legacy_metadata = root.join(LEGACY_METADATA_DB_FILE_NAME);

    {
      let podcast_connection = Connection::open(&legacy_podcast).expect("open legacy podcast");
      podcast_connection
        .execute_batch(
          "
          CREATE TABLE podcast_feeds (
            id TEXT PRIMARY KEY,
            feed_url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            author TEXT,
            description TEXT,
            artwork_url TEXT,
            etag TEXT,
            last_modified TEXT,
            last_fetched_at INTEGER NOT NULL,
            subscribed INTEGER NOT NULL DEFAULT 1,
            subscribed_at INTEGER,
            last_checked_at INTEGER,
            last_refresh_error TEXT
          );
          INSERT INTO podcast_feeds (
            id, feed_url, title, last_fetched_at, subscribed
          ) VALUES (
            'feed-1', 'https://feeds.example.test/show.xml', '旧播客', 1, 1
          );
          ",
        )
        .expect("seed legacy podcast");
    }

    {
      let metadata_connection = Connection::open(&legacy_metadata).expect("open legacy metadata");
      metadata_connection
        .execute_batch(
          "
          CREATE TABLE metadata_entities (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            display_name TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            provider_name TEXT NOT NULL,
            source_path TEXT NOT NULL,
            confidence INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT INTO metadata_entities (
            id, kind, display_name, provider_id, provider_name, source_path, confidence, updated_at
          ) VALUES (
            'entity-1', 'track', '旧曲目', 'manual-edit', '手动编辑', 'manual', 100, 1
          );
          ",
        )
        .expect("seed legacy metadata");
    }

    let db_path = initialize_zone_database(&root).expect("import legacy dbs");
    let connection = open_zone_database(&db_path).expect("open unified db");

    let feed_title: String = connection
      .query_row(
        "SELECT title FROM podcast_feeds WHERE id = 'feed-1'",
        [],
        |row| row.get(0),
      )
      .expect("imported podcast feed");
    assert_eq!(feed_title, "旧播客");

    let entity_name: String = connection
      .query_row(
        "SELECT display_name FROM metadata_entities WHERE id = 'entity-1'",
        [],
        |row| row.get(0),
      )
      .expect("imported metadata entity");
    assert_eq!(entity_name, "旧曲目");

    assert!(!legacy_podcast.exists(), "legacy podcast db should be archived");
    assert!(
      !legacy_metadata.exists(),
      "legacy metadata db should be archived"
    );
    assert!(root
      .join("legacy")
      .join(format!("{LEGACY_PODCAST_DB_FILE_NAME}.bak"))
      .exists());
    assert!(root
      .join("legacy")
      .join(format!("{LEGACY_METADATA_DB_FILE_NAME}.bak"))
      .exists());

    // Second init must be idempotent and must not require legacy files.
    drop(connection);
    initialize_zone_database(&root).expect("re-initialize after archive");
  }
}
