use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use crate::db::{open_zone_database, unix_millis};
use crate::library::{self, MusicFolder, Track};

use super::types::*;

pub(crate) fn ensure_default_playlist(db_path: &Path) -> Result<(), String> {
  let connection = open_zone_database(db_path)?;
  let now = unix_millis();
  connection
    .execute(
      "
      INSERT INTO music_playlists (
        id, name, description, kind, is_system, definition_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'manual', 1, NULL, ?4, ?4)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        is_system = 1
      ",
      params![
        DEFAULT_PLAYLIST_ID,
        DEFAULT_PLAYLIST_NAME,
        DEFAULT_PLAYLIST_DESCRIPTION,
        now
      ],
    )
    .map_err(|error| format!("无法初始化默认收藏列表：{error}"))?;
  Ok(())
}

fn open_music_db(state: &MusicState) -> Result<Connection, String> {
  state.ensure_ready()?;
  open_zone_database(state.db_path())
}

fn bump_library_revision(connection: &Connection) -> Result<i64, String> {
  let now = unix_millis();
  let current = get_setting::<i64>(connection, "music.library_revision")?.unwrap_or(0);
  let next = current.saturating_add(1);
  set_setting(connection, "music.library_revision", &Value::from(next))?;
  let _ = now;
  Ok(next)
}

fn set_setting(connection: &Connection, key: &str, value: &Value) -> Result<(), String> {
  let now = unix_millis();
  let value_json =
    serde_json::to_string(value).map_err(|error| format!("无法序列化设置 {key}：{error}"))?;
  connection
    .execute(
      "
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
      ",
      params![key, value_json, now],
    )
    .map_err(|error| format!("无法写入设置 {key}：{error}"))?;
  Ok(())
}

fn get_setting<T: for<'de> serde::Deserialize<'de>>(
  connection: &Connection,
  key: &str,
) -> Result<Option<T>, String> {
  let value = connection
    .query_row(
      "SELECT value_json FROM app_settings WHERE key = ?1",
      params![key],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取设置 {key}：{error}"))?;
  Ok(value.and_then(|raw| serde_json::from_str(&raw).ok()))
}

fn table_has_rows(connection: &Connection, table: &str) -> Result<bool, String> {
  let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} LIMIT 1)");
  connection
    .query_row(&sql, [], |row| row.get::<_, i64>(0))
    .map(|value| value == 1)
    .map_err(|error| format!("无法检查表 {table}：{error}"))
}

fn folder_for_path(folders: &[MusicFolder], path: &str) -> Option<String> {
  folders
    .iter()
    .filter(|folder| {
      path == folder.path
        || path.starts_with(&(folder.path.clone() + "\\"))
        || path.starts_with(&(folder.path.clone() + "/"))
    })
    .max_by_key(|folder| folder.path.len())
    .map(|folder| folder.path.clone())
}

fn track_exists(connection: &Connection, track_id: &str) -> bool {
  connection
    .query_row(
      "SELECT COUNT(*) FROM music_tracks WHERE id = ?1",
      params![track_id],
      |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .unwrap_or(false)
}

fn upsert_folder(connection: &Connection, folder: &MusicFolder, now: i64) -> Result<(), String> {
  connection
    .execute(
      "
      INSERT INTO music_folders (path, name, added_at, last_scanned_at, enabled)
      VALUES (?1, ?2, ?3, ?3, 1)
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name,
        last_scanned_at = excluded.last_scanned_at,
        enabled = 1
      ",
      params![folder.path, folder.name, now],
    )
    .map_err(|error| format!("无法保存音乐文件夹：{error}"))?;
  Ok(())
}

fn upsert_track(
  connection: &Connection,
  track: &Track,
  folder_path: Option<&str>,
  now: i64,
) -> Result<(), String> {
  let genres_json = serde_json::to_string(&track.genres)
    .map_err(|error| format!("无法序列化曲目流派：{error}"))?;
  let metadata = fs::metadata(&track.path).ok();
  let file_mtime_ms = metadata
    .as_ref()
    .and_then(|value| value.modified().ok())
    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|duration| duration.as_millis() as i64);
  let file_size = metadata.map(|value| value.len() as i64);
  connection
    .execute(
      "
      INSERT INTO music_tracks (
        id, path, folder_path, file_name, extension, title, artist, album, album_artist,
        track_number, disc_number, year, duration_seconds, genres_json, cover_path,
        file_mtime_ms, file_size, added_at, missing, scanned_at, raw_tags_json
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
        ?10, ?11, ?12, ?13, ?14, ?15,
        ?16, ?17, ?18, 0, ?19, NULL
      )
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        folder_path = excluded.folder_path,
        file_name = excluded.file_name,
        extension = excluded.extension,
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        album_artist = excluded.album_artist,
        track_number = excluded.track_number,
        disc_number = excluded.disc_number,
        year = excluded.year,
        duration_seconds = excluded.duration_seconds,
        genres_json = excluded.genres_json,
        cover_path = excluded.cover_path,
        file_mtime_ms = excluded.file_mtime_ms,
        file_size = excluded.file_size,
        added_at = COALESCE(music_tracks.added_at, excluded.added_at),
        missing = 0,
        scanned_at = excluded.scanned_at
      ",
      params![
        track.id,
        track.path,
        folder_path,
        track.file_name,
        track.extension,
        track.title,
        track.artist,
        track.album,
        track.album_artist,
        track.track_number.map(|value| value as i64),
        track.disc_number.map(|value| value as i64),
        track.year.map(|value| value as i64),
        track.duration_seconds.map(|value| value as f64),
        genres_json,
        track.cover_path,
        file_mtime_ms,
        file_size,
        track.added_at.map(|value| value as i64),
        now
      ],
    )
    .map_err(|error| format!("无法保存曲目：{error}"))?;
  Ok(())
}

fn replace_playlist(connection: &Connection, playlist: &PlaylistRecord, now: i64) -> Result<(), String> {
  let kind = if playlist.kind == "smart" { "smart" } else { "manual" };
  let definition_json = if kind == "smart" {
    let payload = serde_json::json!({
      "smart": playlist.smart.clone().unwrap_or(Value::Null),
      "excludedTrackIds": playlist.excluded_track_ids,
    });
    Some(serde_json::to_string(&payload).map_err(|error| format!("无法序列化智能播放列表：{error}"))?)
  } else {
    None
  };
  let is_system = i64::from(playlist.id == DEFAULT_PLAYLIST_ID);
  connection
    .execute(
      "
      INSERT INTO music_playlists (
        id, name, description, kind, is_system, definition_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        kind = excluded.kind,
        is_system = excluded.is_system,
        definition_json = excluded.definition_json,
        updated_at = excluded.updated_at
      ",
      params![playlist.id, playlist.name, playlist.description, kind, is_system, definition_json, now],
    )
    .map_err(|error| format!("无法保存播放列表：{error}"))?;
  connection
    .execute("DELETE FROM music_playlist_items WHERE playlist_id = ?1", params![playlist.id])
    .map_err(|error| format!("无法清理播放列表曲目：{error}"))?;
  if kind == "manual" {
    for (position, track_id) in playlist.track_ids.iter().enumerate() {
      if !track_exists(connection, track_id) {
        continue;
      }
      connection
        .execute(
          "INSERT OR IGNORE INTO music_playlist_items (playlist_id, track_id, position, added_at) VALUES (?1, ?2, ?3, ?4)",
          params![playlist.id, track_id, position as i64, now],
        )
        .map_err(|error| format!("无法保存播放列表曲目：{error}"))?;
    }
  }
  Ok(())
}

fn replace_home_pins(connection: &Connection, pins: &[HomePinRecord]) -> Result<(), String> {
  connection
    .execute("DELETE FROM music_home_pins", [])
    .map_err(|error| format!("无法清理 quickplay 固定项：{error}"))?;
  for (position, pin) in pins.iter().enumerate() {
    connection
      .execute(
        "INSERT INTO music_home_pins (id, kind, target_id, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![pin.id, pin.kind, pin.target_id, position as i64, pin.created_at],
      )
      .map_err(|error| format!("无法保存 quickplay 固定项：{error}"))?;
  }
  Ok(())
}

fn upsert_track_activity(
  connection: &Connection,
  track_id: &str,
  activity: &TrackActivityRecord,
) -> Result<(), String> {
  if !track_exists(connection, track_id) {
    return Ok(());
  }
  let now = unix_millis();
  connection
    .execute(
      "
      INSERT INTO music_track_stats (
        track_id, play_count, complete_count, skip_count, favorite,
        first_played_at, last_played_at, last_completed_at, last_skipped_at,
        total_listen_ms, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, NULL, ?7, 0, ?8)
      ON CONFLICT(track_id) DO UPDATE SET
        play_count = excluded.play_count,
        complete_count = excluded.complete_count,
        skip_count = excluded.skip_count,
        first_played_at = COALESCE(music_track_stats.first_played_at, excluded.first_played_at),
        last_played_at = excluded.last_played_at,
        last_skipped_at = excluded.last_skipped_at,
        updated_at = excluded.updated_at
      ",
      params![
        track_id,
        activity.play_count,
        activity.completed_count,
        activity.skip_count,
        activity.last_played_at,
        activity.last_played_at,
        activity.last_skipped_at,
        now
      ],
    )
    .map_err(|error| format!("无法保存播放统计：{error}"))?;
  if activity.added_at > 0 {
    connection
      .execute(
        "UPDATE music_tracks SET added_at = COALESCE(added_at, ?2) WHERE id = ?1",
        params![track_id, activity.added_at],
      )
      .map_err(|error| format!("无法回填曲目加入时间：{error}"))?;
  }
  Ok(())
}

fn replace_queue_and_history(
  connection: &Connection,
  queue: &[String],
  history: &[String],
) -> Result<(), String> {
  connection
    .execute("DELETE FROM music_queue_items", [])
    .map_err(|error| format!("无法清理播放队列：{error}"))?;
  connection
    .execute("DELETE FROM music_play_history", [])
    .map_err(|error| format!("无法清理播放历史：{error}"))?;
  let now = unix_millis();
  for (position, track_id) in queue.iter().enumerate() {
    if !track_exists(connection, track_id) {
      continue;
    }
    connection
      .execute(
        "INSERT INTO music_queue_items (position, track_id, added_at) VALUES (?1, ?2, ?3)",
        params![position as i64, track_id, now],
      )
      .map_err(|error| format!("无法保存播放队列：{error}"))?;
  }
  for (position, track_id) in history.iter().enumerate() {
    if !track_exists(connection, track_id) {
      continue;
    }
    connection
      .execute(
        "INSERT INTO music_play_history (position, track_id, played_at) VALUES (?1, ?2, ?3)",
        params![position as i64, track_id, now],
      )
      .map_err(|error| format!("无法保存播放历史：{error}"))?;
  }
  Ok(())
}

fn upsert_playback_state(
  connection: &Connection,
  active_track_id: Option<&str>,
  volume: f64,
  shuffle: bool,
  repeat: &str,
) -> Result<(), String> {
  let repeat_mode = match repeat {
    "one" | "all" | "off" => repeat,
    _ => "off",
  };
  let active = active_track_id.filter(|track_id| track_exists(connection, track_id));
  let now = unix_millis();
  connection
    .execute(
      "
      INSERT INTO music_playback_state (
        id, active_track_id, position_ms, shuffle, repeat_mode, volume, updated_at
      ) VALUES (1, ?1, 0, ?2, ?3, ?4, ?5)
      ON CONFLICT(id) DO UPDATE SET
        active_track_id = excluded.active_track_id,
        shuffle = excluded.shuffle,
        repeat_mode = excluded.repeat_mode,
        volume = excluded.volume,
        updated_at = excluded.updated_at
      ",
      params![
        active,
        i64::from(shuffle),
        repeat_mode,
        volume.clamp(0.0, 1.0),
        now
      ],
    )
    .map_err(|error| format!("无法保存播放状态：{error}"))?;
  Ok(())
}

fn list_folders(connection: &Connection) -> Result<Vec<MusicFolder>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT path, name
      FROM music_folders
      WHERE enabled = 1
      ORDER BY name COLLATE NOCASE, path COLLATE NOCASE
      ",
    )
    .map_err(|error| format!("无法读取音乐文件夹：{error}"))?;
  let rows = statement
    .query_map([], |row| {
      Ok(MusicFolder {
        path: row.get(0)?,
        name: row.get(1)?,
      })
    })
    .map_err(|error| format!("无法读取音乐文件夹：{error}"))?;
  let folders = rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取音乐文件夹：{error}"))?;
  Ok(folders)
}

fn list_tracks(connection: &Connection) -> Result<Vec<Track>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT
        id, path, file_name, title, artist, album, album_artist,
        track_number, disc_number, year, duration_seconds, genres_json,
        added_at, extension, cover_path
      FROM music_tracks
      WHERE missing = 0
      ORDER BY lower(artist), lower(album),
        COALESCE(disc_number, 2147483647),
        COALESCE(track_number, 2147483647),
        lower(title)
      ",
    )
    .map_err(|error| format!("无法读取曲目：{error}"))?;
  let rows = statement
    .query_map([], |row| {
      let genres_json: String = row.get(11)?;
      let genres = serde_json::from_str(&genres_json).unwrap_or_default();
      Ok(Track {
        id: row.get(0)?,
        path: row.get(1)?,
        file_name: row.get(2)?,
        title: row.get(3)?,
        artist: row.get(4)?,
        album: row.get(5)?,
        album_artist: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        track_number: row.get::<_, Option<i64>>(7)?.and_then(|value| u32::try_from(value).ok()),
        disc_number: row.get::<_, Option<i64>>(8)?.and_then(|value| u32::try_from(value).ok()),
        year: row.get::<_, Option<i64>>(9)?.and_then(|value| u32::try_from(value).ok()),
        genres,
        duration_seconds: row.get::<_, Option<f64>>(10)?.map(|value| value.round() as u64),
        added_at: row.get::<_, Option<i64>>(12)?.and_then(|value| u64::try_from(value).ok()),
        extension: row.get(13)?,
        cover_path: row.get(14)?,
      })
    })
    .map_err(|error| format!("无法读取曲目：{error}"))?;
  let tracks = rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取曲目：{error}"))?;
  Ok(tracks)
}

fn list_playlists(connection: &Connection) -> Result<Vec<PlaylistRecord>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT id, name, description, kind, definition_json
      FROM music_playlists
      ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END, name COLLATE NOCASE
      ",
    )
    .map_err(|error| format!("无法读取播放列表：{error}"))?;
  let rows = statement
    .query_map(params![DEFAULT_PLAYLIST_ID], |row| {
      Ok((
        row.get::<_, String>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, String>(2)?,
        row.get::<_, String>(3)?,
        row.get::<_, Option<String>>(4)?,
      ))
    })
    .map_err(|error| format!("无法读取播放列表：{error}"))?;

  let mut playlists = Vec::new();
  for row in rows {
    let (id, name, description, kind, definition_json) =
      row.map_err(|error| format!("无法读取播放列表：{error}"))?;
    if kind == "smart" {
      let parsed = definition_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or(Value::Null);
      playlists.push(PlaylistRecord {
        id,
        name,
        description,
        kind,
        track_ids: Vec::new(),
        smart: parsed.get("smart").cloned(),
        excluded_track_ids: parsed
          .get("excludedTrackIds")
          .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
          .unwrap_or_default(),
      });
    } else {
      let mut item_statement = connection
        .prepare(
          "
          SELECT track_id
          FROM music_playlist_items
          WHERE playlist_id = ?1
          ORDER BY position ASC, added_at ASC
          ",
        )
        .map_err(|error| format!("无法读取播放列表曲目：{error}"))?;
      let track_ids = item_statement
        .query_map(params![id], |item| item.get::<_, String>(0))
        .map_err(|error| format!("无法读取播放列表曲目：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取播放列表曲目：{error}"))?;
      playlists.push(PlaylistRecord {
        id,
        name,
        description,
        kind: "manual".to_string(),
        track_ids,
        smart: None,
        excluded_track_ids: Vec::new(),
      });
    }
  }

  if !playlists.iter().any(|playlist| playlist.id == DEFAULT_PLAYLIST_ID) {
    playlists.insert(
      0,
      PlaylistRecord {
        id: DEFAULT_PLAYLIST_ID.to_string(),
        name: DEFAULT_PLAYLIST_NAME.to_string(),
        description: DEFAULT_PLAYLIST_DESCRIPTION.to_string(),
        kind: "manual".to_string(),
        track_ids: Vec::new(),
        smart: None,
        excluded_track_ids: Vec::new(),
      },
    );
  }
  Ok(playlists)
}

fn list_home_pins(connection: &Connection) -> Result<Vec<HomePinRecord>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT id, kind, target_id, created_at
      FROM music_home_pins
      ORDER BY position ASC, created_at ASC
      ",
    )
    .map_err(|error| format!("无法读取 quickplay 固定项：{error}"))?;
  let pins = statement
    .query_map([], |row| {
      Ok(HomePinRecord {
        id: row.get(0)?,
        kind: row.get(1)?,
        target_id: row.get(2)?,
        created_at: row.get(3)?,
      })
    })
    .map_err(|error| format!("无法读取 quickplay 固定项：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取 quickplay 固定项：{error}"))?;
  Ok(pins)
}

fn list_track_activity(
  connection: &Connection,
) -> Result<HashMap<String, TrackActivityRecord>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT
        t.id,
        COALESCE(t.added_at, s.updated_at, 0),
        COALESCE(s.play_count, 0),
        COALESCE(s.complete_count, 0),
        COALESCE(s.skip_count, 0),
        s.last_played_at,
        s.last_skipped_at
      FROM music_tracks t
      LEFT JOIN music_track_stats s ON s.track_id = t.id
      WHERE t.missing = 0
      ",
    )
    .map_err(|error| format!("无法读取播放统计：{error}"))?;
  let rows = statement
    .query_map([], |row| {
      Ok((
        row.get::<_, String>(0)?,
        TrackActivityRecord {
          added_at: row.get(1)?,
          play_count: row.get(2)?,
          completed_count: row.get(3)?,
          skip_count: row.get(4)?,
          last_played_at: row.get(5)?,
          last_skipped_at: row.get(6)?,
        },
      ))
    })
    .map_err(|error| format!("无法读取播放统计：{error}"))?;
  let mut map = HashMap::new();
  for row in rows {
    let (track_id, activity) = row.map_err(|error| format!("无法读取播放统计：{error}"))?;
    map.insert(track_id, activity);
  }
  Ok(map)
}

fn list_id_column(connection: &Connection, sql: &str) -> Result<Vec<String>, String> {
  let mut statement = connection
    .prepare(sql)
    .map_err(|error| format!("无法读取列表：{error}"))?;
  let values = statement
    .query_map([], |row| row.get::<_, String>(0))
    .map_err(|error| format!("无法读取列表：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取列表：{error}"))?;
  Ok(values)
}

fn read_playback_snapshot(connection: &Connection) -> Result<MusicPlaybackSnapshot, String> {
  let row = connection
    .query_row(
      "SELECT active_track_id, shuffle, repeat_mode, volume FROM music_playback_state WHERE id = 1",
      [],
      |row| {
        Ok((
          row.get::<_, Option<String>>(0)?,
          row.get::<_, i64>(1)?,
          row.get::<_, String>(2)?,
          row.get::<_, f64>(3)?,
        ))
      },
    )
    .optional()
    .map_err(|error| format!("无法读取播放状态：{error}"))?;
  let (active_track_id, shuffle, repeat, volume) =
    row.unwrap_or((None, 0, "off".to_string(), 0.8));
  Ok(MusicPlaybackSnapshot {
    active_track_id,
    queue: list_id_column(
      connection,
      "SELECT track_id FROM music_queue_items ORDER BY position ASC",
    )?,
    play_history: list_id_column(
      connection,
      "SELECT track_id FROM music_play_history ORDER BY position ASC",
    )?,
    volume,
    shuffle: shuffle != 0,
    repeat,
    selected_playlist_id: get_setting::<String>(connection, "music.selected_playlist_id")?
      .or_else(|| Some(DEFAULT_PLAYLIST_ID.to_string())),
  })
}

pub(crate) fn load_library_snapshot(state: &MusicState) -> Result<MusicLibrarySnapshot, String> {
  let connection = open_music_db(state)?;
  ensure_default_playlist(state.db_path())?;
  let folders = list_folders(&connection)?;
  let tracks = list_tracks(&connection)?;
  Ok(MusicLibrarySnapshot {
    folders: folders.clone(),
    tracks: tracks.clone(),
    playlists: list_playlists(&connection)?,
    home_pins: list_home_pins(&connection)?,
    track_activity: list_track_activity(&connection)?,
    playback: read_playback_snapshot(&connection)?,
    library_revision: get_setting::<i64>(&connection, "music.library_revision")?.unwrap_or(0),
    has_library: !folders.is_empty() || !tracks.is_empty(),
  })
}

pub(crate) fn import_legacy_player_state(
  state: &MusicState,
  legacy: LegacyPlayerStateV1,
) -> Result<MusicLibrarySnapshot, String> {
  let mut connection = open_music_db(state)?;
  if table_has_rows(&connection, "music_tracks")? {
    set_setting(
      &connection,
      "migration.zone_player_state_v1",
      &Value::String("skipped_existing".into()),
    )?;
    drop(connection);
    return load_library_snapshot(state);
  }

  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始导入旧播放状态：{error}"))?;
  let now = unix_millis();

  for folder in &legacy.folders {
    upsert_folder(&transaction, folder, now)?;
  }
  for track in &legacy.tracks {
    let folder_path = folder_for_path(&legacy.folders, &track.path);
    upsert_track(&transaction, track, folder_path.as_deref(), now)?;
  }

  let mut playlists = legacy.playlists;
  if !playlists.iter().any(|playlist| playlist.id == DEFAULT_PLAYLIST_ID) {
    playlists.insert(
      0,
      PlaylistRecord {
        id: DEFAULT_PLAYLIST_ID.to_string(),
        name: DEFAULT_PLAYLIST_NAME.to_string(),
        description: DEFAULT_PLAYLIST_DESCRIPTION.to_string(),
        kind: "manual".to_string(),
        track_ids: Vec::new(),
        smart: None,
        excluded_track_ids: Vec::new(),
      },
    );
  }
  for playlist in &playlists {
    replace_playlist(&transaction, playlist, now)?;
  }
  replace_home_pins(&transaction, &legacy.home_pins)?;
  for (track_id, activity) in &legacy.track_activity {
    upsert_track_activity(&transaction, track_id, activity)?;
  }
  replace_queue_and_history(&transaction, &legacy.queue, &legacy.play_history)?;
  upsert_playback_state(
    &transaction,
    legacy.active_track_id.as_deref(),
    legacy.volume.unwrap_or(0.8),
    legacy.shuffle.unwrap_or(false),
    legacy.repeat.as_deref().unwrap_or("off"),
  )?;
  set_setting(
    &transaction,
    "music.selected_playlist_id",
    &Value::String(
      legacy
        .selected_playlist_id
        .unwrap_or_else(|| DEFAULT_PLAYLIST_ID.to_string()),
    ),
  )?;
  if let Some(version) = legacy.library_schema_version {
    set_setting(
      &transaction,
      "music.legacy_library_schema_version",
      &Value::from(version),
    )?;
  }
  set_setting(
    &transaction,
    "migration.zone_player_state_v1",
    &Value::String("done".into()),
  )?;
  let _ = bump_library_revision(&transaction)?;
  transaction
    .commit()
    .map_err(|error| format!("无法提交旧播放状态导入：{error}"))?;
  drop(connection);
  load_library_snapshot(state)
}

pub(crate) fn scan_and_store_library(
  state: &MusicState,
  folders: Vec<MusicFolder>,
) -> Result<MusicScanWriteResult, String> {
  let folder_paths = folders.iter().map(|folder| folder.path.clone()).collect::<Vec<_>>();
  let scan = library::scan_library(folder_paths);
  let mut connection = open_music_db(state)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始保存扫描结果：{error}"))?;
  let now = unix_millis();
  let selected = folders
    .iter()
    .map(|folder| folder.path.clone())
    .collect::<HashSet<_>>();

  transaction
    .execute("UPDATE music_folders SET enabled = 0", [])
    .map_err(|error| format!("无法更新文件夹状态：{error}"))?;
  for folder in &folders {
    upsert_folder(&transaction, folder, now)?;
  }

  let scanned_ids = scan
    .tracks
    .iter()
    .map(|track| track.id.clone())
    .collect::<HashSet<_>>();
  for track in &scan.tracks {
    let folder_path = folder_for_path(&folders, &track.path);
    upsert_track(&transaction, track, folder_path.as_deref(), now)?;
  }

  let mut existing_statement = transaction
    .prepare("SELECT id, path, folder_path FROM music_tracks")
    .map_err(|error| format!("无法读取已有曲目：{error}"))?;
  let existing_rows = existing_statement
    .query_map([], |row| {
      Ok((
        row.get::<_, String>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, Option<String>>(2)?,
      ))
    })
    .map_err(|error| format!("无法读取已有曲目：{error}"))?;
  let mut to_mark_missing = Vec::new();
  for row in existing_rows {
    let (id, path, folder_path) = row.map_err(|error| format!("无法读取已有曲目：{error}"))?;
    if scanned_ids.contains(&id) {
      continue;
    }
    let still_selected = folder_path
      .as_ref()
      .map(|value| selected.contains(value))
      .unwrap_or_else(|| folder_for_path(&folders, &path).is_some());
    if still_selected || folder_path.is_none() {
      to_mark_missing.push(id);
    }
  }
  drop(existing_statement);
  for id in to_mark_missing {
    transaction
      .execute(
        "UPDATE music_tracks SET missing = 1, scanned_at = ?2 WHERE id = ?1",
        params![id, now],
      )
      .map_err(|error| format!("无法标记缺失曲目：{error}"))?;
  }

  let library_revision = bump_library_revision(&transaction)?;
  transaction
    .commit()
    .map_err(|error| format!("无法提交扫描结果：{error}"))?;

  Ok(MusicScanWriteResult {
    folders: scan.folders,
    tracks: scan.tracks,
    skipped: scan.skipped,
    library_revision,
  })
}

pub(crate) fn save_playlists(state: &MusicState, playlists: Vec<PlaylistRecord>) -> Result<(), String> {
  let mut connection = open_music_db(state)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始保存播放列表：{error}"))?;
  let now = unix_millis();
  let keep = playlists.iter().map(|playlist| playlist.id.clone()).collect::<HashSet<_>>();
  for playlist in &playlists {
    replace_playlist(&transaction, playlist, now)?;
  }
  let mut existing = transaction
    .prepare("SELECT id FROM music_playlists")
    .map_err(|error| format!("无法读取播放列表：{error}"))?;
  let removable = existing
    .query_map([], |row| row.get::<_, String>(0))
    .map_err(|error| format!("无法读取播放列表：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播放列表：{error}"))?
    .into_iter()
    .filter(|id| id != DEFAULT_PLAYLIST_ID && !keep.contains(id))
    .collect::<Vec<_>>();
  drop(existing);
  for id in removable {
    transaction
      .execute("DELETE FROM music_playlists WHERE id = ?1", params![id])
      .map_err(|error| format!("无法删除播放列表：{error}"))?;
  }
  let _ = bump_library_revision(&transaction)?;
  transaction
    .commit()
    .map_err(|error| format!("无法提交播放列表：{error}"))?;
  Ok(())
}

pub(crate) fn save_home_pins(state: &MusicState, pins: Vec<HomePinRecord>) -> Result<(), String> {
  let connection = open_music_db(state)?;
  replace_home_pins(&connection, &pins)?;
  let _ = bump_library_revision(&connection)?;
  Ok(())
}

pub(crate) fn save_track_activity(
  state: &MusicState,
  activity: HashMap<String, TrackActivityRecord>,
) -> Result<(), String> {
  let mut connection = open_music_db(state)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始保存播放统计：{error}"))?;
  for (track_id, item) in &activity {
    upsert_track_activity(&transaction, track_id, item)?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播放统计：{error}"))?;
  Ok(())
}

pub(crate) fn save_playback_state(
  state: &MusicState,
  playback: MusicPlaybackStateInput,
) -> Result<(), String> {
  let mut connection = open_music_db(state)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始保存播放状态：{error}"))?;
  replace_queue_and_history(&transaction, &playback.queue, &playback.play_history)?;
  upsert_playback_state(
    &transaction,
    playback.active_track_id.as_deref(),
    playback.volume.unwrap_or(0.8),
    playback.shuffle.unwrap_or(false),
    playback.repeat.as_deref().unwrap_or("off"),
  )?;
  if let Some(selected) = playback.selected_playlist_id {
    set_setting(
      &transaction,
      "music.selected_playlist_id",
      &Value::String(selected),
    )?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播放状态：{error}"))?;
  Ok(())
}

pub(crate) fn clear_library(state: &MusicState) -> Result<(), String> {
  let connection = open_music_db(state)?;
  connection
    .execute_batch(
      "
      DELETE FROM music_play_history;
      DELETE FROM music_queue_items;
      DELETE FROM music_playback_state;
      DELETE FROM music_home_pins;
      DELETE FROM music_playlist_items;
      DELETE FROM music_playlists WHERE id != 'favorites';
      DELETE FROM music_track_stats;
      DELETE FROM music_feature_jobs;
      DELETE FROM music_track_features;
      DELETE FROM music_tracks;
      DELETE FROM music_folders;
      ",
    )
    .map_err(|error| format!("无法清空音乐库：{error}"))?;
  ensure_default_playlist(state.db_path())?;
  let _ = bump_library_revision(&connection)?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::library::Track;

  fn test_root(name: &str) -> std::path::PathBuf {
    let directory = std::env::temp_dir().join(format!(
      "zone-music-{}-{}-{}",
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
  fn import_legacy_player_state_roundtrip() {
    let root = test_root("import");
    let state = MusicState::initialize_at(&root).expect("init music state");
    let music_dir = root.join("Music");
    fs::create_dir_all(&music_dir).expect("create music dir");
    let track_path = music_dir.join("a.mp3");
    fs::write(&track_path, b"id3").expect("write fake track");
    let legacy = LegacyPlayerStateV1 {
      library_schema_version: Some(6),
      folders: vec![MusicFolder {
        path: music_dir.to_string_lossy().to_string(),
        name: "Music".to_string(),
      }],
      tracks: vec![sample_track("track-1", &track_path.to_string_lossy())],
      active_track_id: Some("track-1".to_string()),
      queue: vec!["track-1".to_string()],
      play_history: vec!["track-1".to_string()],
      track_activity: HashMap::from([(
        "track-1".to_string(),
        TrackActivityRecord {
          added_at: 10,
          play_count: 3,
          completed_count: 2,
          skip_count: 1,
          last_played_at: Some(20),
          last_skipped_at: Some(15),
        },
      )]),
      volume: Some(0.4),
      shuffle: Some(true),
      repeat: Some("all".to_string()),
      playlists: vec![PlaylistRecord {
        id: DEFAULT_PLAYLIST_ID.to_string(),
        name: DEFAULT_PLAYLIST_NAME.to_string(),
        description: DEFAULT_PLAYLIST_DESCRIPTION.to_string(),
        kind: "manual".to_string(),
        track_ids: vec!["track-1".to_string()],
        smart: None,
        excluded_track_ids: Vec::new(),
      }],
      selected_playlist_id: Some(DEFAULT_PLAYLIST_ID.to_string()),
      home_pins: vec![HomePinRecord {
        id: "pin-1".to_string(),
        kind: "track".to_string(),
        target_id: "track-1".to_string(),
        created_at: 30,
      }],
    };

    let snapshot = import_legacy_player_state(&state, legacy).expect("import legacy");
    assert!(snapshot.has_library);
    assert_eq!(snapshot.tracks.len(), 1);
    assert_eq!(snapshot.playback.queue, vec!["track-1".to_string()]);
    assert_eq!(snapshot.playback.volume, 0.4);
    assert!(snapshot.playback.shuffle);
    assert_eq!(snapshot.track_activity.get("track-1").map(|item| item.play_count), Some(3));
  }
}
