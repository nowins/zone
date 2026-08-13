use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::store::{open_music_db, track_exists};
use super::types::*;
use crate::db::unix_millis;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RadioSeedRecord {
  pub kind: String,
  pub id: String,
  pub label: String,
  pub track_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RadioSessionRecord {
  pub id: String,
  pub kind: String,
  pub seed: RadioSeedRecord,
  pub status: String,
  pub played_ids: Vec<String>,
  pub banned_ids: Vec<String>,
  pub queued_ids: Vec<String>,
  pub skipped_ids: Vec<String>,
  pub constraints: Value,
  pub created_at: i64,
  pub updated_at: i64,
  pub last_active_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RadioSessionUpsertInput {
  pub id: String,
  #[serde(default)]
  pub kind: Option<String>,
  pub seed: RadioSeedRecord,
  pub status: String,
  #[serde(default)]
  pub played_ids: Vec<String>,
  #[serde(default)]
  pub banned_ids: Vec<String>,
  #[serde(default)]
  pub queued_ids: Vec<String>,
  #[serde(default)]
  pub skipped_ids: Vec<String>,
  #[serde(default)]
  pub constraints: Option<Value>,
  #[serde(default)]
  pub created_at: Option<i64>,
  #[serde(default)]
  pub updated_at: Option<i64>,
  #[serde(default)]
  pub last_active_at: Option<i64>,
}

pub(crate) fn upsert_radio_session(
  state: &MusicState,
  input: RadioSessionUpsertInput,
) -> Result<RadioSessionRecord, String> {
  let mut connection = open_music_db(state)?;
  let tx = connection
    .transaction()
    .map_err(|error| format!("无法保存电台会话：{error}"))?;
  let now = unix_millis();
  let kind = input.kind.unwrap_or_else(|| "smartdj".to_string());
  let status = match input.status.as_str() {
    "idle" | "playing" | "exhausted" | "stopped" => input.status,
    _ => "playing".to_string(),
  };
  let created_at = input.created_at.unwrap_or(now);
  let updated_at = input.updated_at.unwrap_or(now);
  let last_active_at = input.last_active_at.unwrap_or(updated_at);
  let constraints = input.constraints.unwrap_or_else(|| serde_json::json!({}));
  let constraints_json = serde_json::to_string(&constraints)
    .map_err(|error| format!("无法序列化电台约束：{error}"))?;
  let seed_track_ids_json = serde_json::to_string(&input.seed.track_ids)
    .map_err(|error| format!("无法序列化电台种子：{error}"))?;
  let seed_kind = match input.seed.kind.as_str() {
    "track" | "album" | "artist" | "playlist" | "mixed" => input.seed.kind.clone(),
    _ => "track".to_string(),
  };

  tx.execute(
    "
    INSERT INTO radio_sessions (
      id, kind, seed_kind, seed_id, seed_label, seed_track_ids_json,
      status, constraints_json, created_at, updated_at, last_active_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      seed_kind = excluded.seed_kind,
      seed_id = excluded.seed_id,
      seed_label = excluded.seed_label,
      seed_track_ids_json = excluded.seed_track_ids_json,
      status = excluded.status,
      constraints_json = excluded.constraints_json,
      updated_at = excluded.updated_at,
      last_active_at = excluded.last_active_at
    ",
    params![
      input.id,
      kind,
      seed_kind,
      input.seed.id,
      input.seed.label,
      seed_track_ids_json,
      status,
      constraints_json,
      created_at,
      updated_at,
      last_active_at
    ],
  )
  .map_err(|error| format!("无法写入电台会话：{error}"))?;

  tx.execute(
    "DELETE FROM radio_session_items WHERE session_id = ?1",
    params![input.id],
  )
  .map_err(|error| format!("无法清理电台会话曲目：{error}"))?;

  write_items(&tx, &input.id, "played", &input.played_ids, now)?;
  write_items(&tx, &input.id, "queued", &input.queued_ids, now)?;
  write_items(&tx, &input.id, "banned", &input.banned_ids, now)?;
  write_items(&tx, &input.id, "skipped", &input.skipped_ids, now)?;

  // Mark this session as the latest active one when playing.
  if status == "playing" {
    tx.execute(
      "
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES ('radio.active_session_id', ?1, ?2)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
      ",
      params![serde_json::to_string(&input.id).unwrap_or_else(|_| format!("\"{}\"", input.id)), now],
    )
    .map_err(|error| format!("无法记录活动电台会话：{error}"))?;
  }

  tx.commit()
    .map_err(|error| format!("无法提交电台会话：{error}"))?;

  get_radio_session(state, Some(input.id))?.ok_or_else(|| "电台会话保存后读取失败".to_string())
}

pub(crate) fn get_radio_session(
  state: &MusicState,
  session_id: Option<String>,
) -> Result<Option<RadioSessionRecord>, String> {
  let connection = open_music_db(state)?;
  let id = match session_id {
    Some(value) if !value.trim().is_empty() => value,
    _ => match active_session_id(&connection)? {
      Some(value) => value,
      None => return Ok(None),
    },
  };

  let row = connection
    .query_row(
      "
      SELECT
        id, kind, seed_kind, seed_id, seed_label, seed_track_ids_json,
        status, constraints_json, created_at, updated_at, last_active_at
      FROM radio_sessions
      WHERE id = ?1
      ",
      params![id],
      |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, String>(2)?,
          row.get::<_, String>(3)?,
          row.get::<_, String>(4)?,
          row.get::<_, String>(5)?,
          row.get::<_, String>(6)?,
          row.get::<_, String>(7)?,
          row.get::<_, i64>(8)?,
          row.get::<_, i64>(9)?,
          row.get::<_, i64>(10)?,
        ))
      },
    )
    .optional()
    .map_err(|error| format!("无法读取电台会话：{error}"))?;

  let Some((
    id,
    kind,
    seed_kind,
    seed_id,
    seed_label,
    seed_track_ids_json,
    status,
    constraints_json,
    created_at,
    updated_at,
    last_active_at,
  )) = row
  else {
    return Ok(None);
  };

  let seed_track_ids = serde_json::from_str::<Vec<String>>(&seed_track_ids_json).unwrap_or_default();
  let constraints = serde_json::from_str::<Value>(&constraints_json).unwrap_or_else(|_| serde_json::json!({}));
  let played_ids = read_items(&connection, &id, "played")?;
  let queued_ids = read_items(&connection, &id, "queued")?;
  let banned_ids = read_items(&connection, &id, "banned")?;
  let skipped_ids = read_items(&connection, &id, "skipped")?;

  Ok(Some(RadioSessionRecord {
    id,
    kind,
    seed: RadioSeedRecord {
      kind: seed_kind,
      id: seed_id,
      label: seed_label,
      track_ids: seed_track_ids,
    },
    status,
    played_ids,
    banned_ids,
    queued_ids,
    skipped_ids,
    constraints,
    created_at,
    updated_at,
    last_active_at,
  }))
}

pub(crate) fn stop_radio_session(
  state: &MusicState,
  session_id: Option<String>,
) -> Result<(), String> {
  let connection = open_music_db(state)?;
  let now = unix_millis();
  if let Some(id) = session_id.filter(|value| !value.trim().is_empty()) {
    connection
      .execute(
        "
        UPDATE radio_sessions
        SET status = 'stopped', updated_at = ?2, last_active_at = ?2
        WHERE id = ?1
        ",
        params![id, now],
      )
      .map_err(|error| format!("无法停止电台会话：{error}"))?;
  } else {
    connection
      .execute(
        "
        UPDATE radio_sessions
        SET status = 'stopped', updated_at = ?1, last_active_at = ?1
        WHERE status = 'playing'
        ",
        params![now],
      )
      .map_err(|error| format!("无法停止电台会话：{error}"))?;
  }
  connection
    .execute(
      "DELETE FROM app_settings WHERE key = 'radio.active_session_id'",
      [],
    )
    .map_err(|error| format!("无法清理活动电台会话：{error}"))?;
  Ok(())
}

fn write_items(
  connection: &Connection,
  session_id: &str,
  role: &str,
  track_ids: &[String],
  now: i64,
) -> Result<(), String> {
  for track_id in track_ids {
    if track_id.trim().is_empty() || !track_exists(connection, track_id) {
      continue;
    }
    connection
      .execute(
        "
        INSERT OR IGNORE INTO radio_session_items (
          session_id, track_id, role, score, reason, created_at
        ) VALUES (?1, ?2, ?3, NULL, NULL, ?4)
        ",
        params![session_id, track_id, role, now],
      )
      .map_err(|error| format!("无法写入电台会话曲目：{error}"))?;
  }
  Ok(())
}

fn read_items(connection: &Connection, session_id: &str, role: &str) -> Result<Vec<String>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT track_id
      FROM radio_session_items
      WHERE session_id = ?1 AND role = ?2
      ORDER BY created_at ASC, track_id ASC
      ",
    )
    .map_err(|error| format!("无法读取电台会话曲目：{error}"))?;
  let rows = statement
    .query_map(params![session_id, role], |row| row.get::<_, String>(0))
    .map_err(|error| format!("无法读取电台会话曲目：{error}"))?;
  let mut values = Vec::new();
  for row in rows {
    values.push(row.map_err(|error| format!("无法读取电台会话曲目：{error}"))?);
  }
  Ok(values)
}

fn active_session_id(connection: &Connection) -> Result<Option<String>, String> {
  let value = connection
    .query_row(
      "SELECT value_json FROM app_settings WHERE key = 'radio.active_session_id'",
      [],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取活动电台会话：{error}"))?;
  Ok(value.and_then(|raw| serde_json::from_str::<String>(&raw).ok()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::library::{MusicFolder, Track};
  use crate::music::store::import_legacy_player_state;
  use std::collections::HashMap;
  use std::fs;

  fn test_root(name: &str) -> std::path::PathBuf {
    let directory = std::env::temp_dir().join(format!(
      "zone-radio-{}-{}-{}",
      name,
      std::process::id(),
      unix_millis()
    ));
    fs::create_dir_all(&directory).expect("create test root");
    directory
  }

  fn sample_track(id: &str, path: &str) -> Track {
    Track {
      id: id.to_string(),
      path: path.to_string(),
      file_name: format!("{id}.mp3"),
      title: id.to_string(),
      artist: "Artist".to_string(),
      album: "Album".to_string(),
      album_artist: "Artist".to_string(),
      track_number: Some(1),
      disc_number: Some(1),
      year: Some(2024),
      genres: vec!["Pop".to_string()],
      duration_seconds: Some(200),
      added_at: Some(1_700_000_000_000),
      extension: "mp3".to_string(),
      cover_path: None,
    }
  }

  #[test]
  fn radio_session_roundtrip_and_active_lookup() {
    let root = test_root("roundtrip");
    let state = MusicState::initialize_at(&root).expect("init");
    let music_dir = root.join("Music");
    fs::create_dir_all(&music_dir).expect("music dir");
    let track_path = music_dir.join("a.mp3");
    fs::write(&track_path, b"id3").expect("track");
    import_legacy_player_state(
      &state,
      LegacyPlayerStateV1 {
        library_schema_version: Some(6),
        folders: vec![MusicFolder {
          path: music_dir.to_string_lossy().to_string(),
          name: "Music".to_string(),
        }],
        tracks: vec![sample_track("track-1", &track_path.to_string_lossy())],
        active_track_id: None,
        queue: vec![],
        play_history: vec![],
        track_activity: HashMap::new(),
        volume: Some(0.8),
        shuffle: Some(false),
        repeat: Some("off".to_string()),
        playlists: vec![],
        selected_playlist_id: None,
        home_pins: vec![],
      },
    )
    .expect("import");

    let saved = upsert_radio_session(
      &state,
      RadioSessionUpsertInput {
        id: "radio-1".to_string(),
        kind: Some("smartdj".to_string()),
        seed: RadioSeedRecord {
          kind: "track".to_string(),
          id: "track-1".to_string(),
          label: "示例".to_string(),
          track_ids: vec!["track-1".to_string()],
        },
        status: "playing".to_string(),
        played_ids: vec![],
        banned_ids: vec![],
        queued_ids: vec!["track-1".to_string()],
        skipped_ids: vec![],
        constraints: Some(serde_json::json!({"horizon": 12})),
        created_at: Some(10),
        updated_at: Some(20),
        last_active_at: Some(20),
      },
    )
    .expect("save");
    assert_eq!(saved.id, "radio-1");
    assert_eq!(saved.seed.label, "示例");
    assert_eq!(saved.queued_ids, vec!["track-1".to_string()]);

    let active = get_radio_session(&state, None).expect("get active").expect("present");
    assert_eq!(active.id, "radio-1");
    assert_eq!(active.status, "playing");

    stop_radio_session(&state, Some("radio-1".to_string())).expect("stop");
    let stopped = get_radio_session(&state, Some("radio-1".to_string()))
      .expect("get stopped")
      .expect("present");
    assert_eq!(stopped.status, "stopped");
    assert!(get_radio_session(&state, None).expect("active after stop").is_none());
  }
}
