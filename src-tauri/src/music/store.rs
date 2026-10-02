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

pub(crate) fn open_music_db(state: &MusicState) -> Result<Connection, String> {
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

pub(crate) fn track_exists(connection: &Connection, track_id: &str) -> bool {
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
  for pin in pins {
    if pin.size.as_deref().is_some_and(|v| !matches!(v, "small" | "medium" | "wide" | "large"))
      || pin.tone.as_deref().is_some_and(|v| !matches!(v, "cover" | "pink" | "teal" | "blue" | "orange" | "purple")) {
      return Err("无效的磁贴外观设置".into());
    }
  }
  connection
    .execute("DELETE FROM music_home_pins", [])
    .map_err(|error| format!("无法清理 quickplay 固定项：{error}"))?;
  for (position, pin) in pins.iter().enumerate() {
    connection
      .execute(
        "INSERT INTO music_home_pins (id, kind, target_id, position, created_at, size, live, tone) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![pin.id, pin.kind, pin.target_id, position as i64, pin.created_at, pin.size, pin.live, pin.tone],
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
      SELECT id, kind, target_id, created_at, size, live, tone
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
        size: row.get(4)?,
        live: row.get(5)?,
        tone: row.get(6)?,
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
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始导入旧播放状态：{error}"))?;
  // A retained legacy source must not overwrite newer edits on a later retry,
  // including libraries that contain only playlists or podcast pins.
  if table_has_rows(&transaction, "music_tracks")?
    || get_setting::<String>(&transaction, "migration.zone_player_state_v1")?.is_some()
  {
    set_setting(
      &transaction,
      "migration.zone_player_state_v1",
      &Value::String("skipped_existing".into()),
    )?;
    transaction.commit().map_err(|error| format!("无法确认旧状态迁移：{error}"))?;
    drop(connection);
    return load_library_snapshot(state);
  }

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

pub(crate) fn scan_and_store_library_controlled(
  state: &MusicState, folders: Vec<MusicFolder>, cancelled: &dyn Fn() -> bool, progress: &dyn Fn(usize),
) -> Result<MusicScanWriteResult, String> {
  let folder_paths = folders.iter().map(|folder| folder.path.clone()).collect::<Vec<_>>();
  let scan = library::scan_library_controlled(folder_paths, cancelled, progress)?;
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
    if cancelled() { return Err("曲库扫描已取消".into()); }
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

  if cancelled() { return Err("曲库扫描已取消".into()); }
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
  let mut connection = open_music_db(state)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始保存磁贴：{error}"))?;
  replace_home_pins(&transaction, &pins)?;
  let _ = bump_library_revision(&transaction)?;
  transaction.commit().map_err(|error| format!("无法提交磁贴设置：{error}"))?;
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
  let mut connection = open_music_db(state)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始清空音乐库：{error}"))?;
  transaction
    .execute_batch(
      "
      DELETE FROM music_play_history;
      DELETE FROM music_queue_items;
      DELETE FROM music_playback_state;
      DELETE FROM music_home_pins WHERE kind != 'podcastFeed';
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
  let _ = bump_library_revision(&transaction)?;
  transaction.commit().map_err(|error| format!("无法提交音乐库清理：{error}"))?;
  Ok(())
}


fn classify_session_outcome(
  outcome: &str,
  listened_ms: i64,
  max_progress_ms: i64,
  duration_ms: Option<i64>,
) -> (String, bool, bool, bool) {
  let duration = duration_ms.unwrap_or(0).max(0);
  let progress = max_progress_ms.max(0);
  let listened = listened_ms.max(0);

  // Effective play: listened beyond max(3s, 1% duration).
  let effective_threshold = if duration > 0 {
    (duration / 100).max(3_000)
  } else {
    3_000
  };
  // Complete: natural completed, or progress/listen reaches 90%.
  let complete_threshold = if duration > 0 {
    ((duration as f64) * 0.9).round() as i64
  } else {
    i64::MAX
  };
  // Skip window: early abandon before max(15s, 20% duration).
  let skip_window = if duration > 0 {
    ((duration as f64) * 0.2).round() as i64
  } else {
    15_000
  }
  .max(15_000);

  let mut normalized = match outcome {
    "completed" | "skipped" | "replaced" | "stopped" | "error" | "playing" => outcome.to_string(),
    _ => "stopped".to_string(),
  };

  let counted_complete = normalized == "completed"
    || progress >= complete_threshold
    || listened >= complete_threshold;
  if counted_complete {
    normalized = "completed".to_string();
  }

  // Explicit early skip should not be upgraded to play just because it passed 3s.
  let explicit_skip = matches!(normalized.as_str(), "skipped" | "replaced")
    && progress >= 3_000
    && progress < skip_window
    && listened < effective_threshold.max(skip_window);

  let counted_skip = !counted_complete
    && (
      (normalized == "skipped" && progress >= 3_000 && progress < skip_window)
        || (normalized != "completed"
          && progress >= 3_000
          && progress < skip_window
          && listened < effective_threshold)
    );

  let counted_play = counted_complete
    || (!counted_skip && (listened >= effective_threshold || progress >= effective_threshold));

  if counted_skip {
    normalized = "skipped".to_string();
  } else if counted_play && normalized == "skipped" {
    // Long "skip" gestures after meaningful listen become a normal stop/replace.
    normalized = "stopped".to_string();
  }

  let _ = explicit_skip;
  (normalized, counted_play, counted_complete, counted_skip)
}

pub(crate) fn start_play_session(
  state: &MusicState,
  input: MusicPlaySessionStartInput,
) -> Result<(), String> {
  let connection = open_music_db(state)?;
  if !track_exists(&connection, &input.track_id) {
    return Ok(());
  }
  let now = unix_millis();
  connection
    .execute(
      "
      INSERT INTO music_play_sessions (
        id, track_id, started_at, ended_at, start_position_ms, end_position_ms,
        duration_ms, listened_ms, outcome, source, session_kind
      ) VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, 0, 'playing', ?6, 'music')
      ON CONFLICT(id) DO UPDATE SET
        track_id = excluded.track_id,
        started_at = excluded.started_at,
        start_position_ms = excluded.start_position_ms,
        duration_ms = excluded.duration_ms,
        outcome = 'playing',
        source = excluded.source,
        ended_at = NULL,
        end_position_ms = NULL,
        listened_ms = 0
      ",
      params![
        input.session_id,
        input.track_id,
        now,
        input.start_position_ms.unwrap_or(0).max(0),
        input.duration_ms,
        input.source.unwrap_or_else(|| "queue".to_string()),
      ],
    )
    .map_err(|error| format!("无法开始播放会话：{error}"))?;
  Ok(())
}

pub(crate) fn end_play_session(
  state: &MusicState,
  input: MusicPlaySessionEndInput,
) -> Result<MusicPlaySessionEndResult, String> {
  let mut connection = open_music_db(state)?;
  if !track_exists(&connection, &input.track_id) {
    return Ok(MusicPlaySessionEndResult {
      track_id: input.track_id,
      activity: TrackActivityRecord {
        added_at: 0,
        play_count: 0,
        completed_count: 0,
        skip_count: 0,
        last_played_at: None,
        last_skipped_at: None,
      },
      outcome: "stopped".to_string(),
      counted_play: false,
      counted_complete: false,
      counted_skip: false,
    });
  }

  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法结束播放会话：{error}"))?;
  let now = unix_millis();
  let listened_ms = input.listened_ms.unwrap_or(0).max(0);
  let max_progress_ms = input
    .max_progress_ms
    .or(input.end_position_ms)
    .unwrap_or(0)
    .max(0);
  let (outcome, counted_play, counted_complete, counted_skip) = classify_session_outcome(
    &input.outcome,
    listened_ms,
    max_progress_ms,
    input.duration_ms,
  );

  // Ensure a start row exists even if start event was missed.
  transaction
    .execute(
      "
      INSERT INTO music_play_sessions (
        id, track_id, started_at, ended_at, start_position_ms, end_position_ms,
        duration_ms, listened_ms, outcome, source, session_kind
      ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'music')
      ON CONFLICT(id) DO UPDATE SET
        ended_at = excluded.ended_at,
        end_position_ms = excluded.end_position_ms,
        duration_ms = COALESCE(excluded.duration_ms, music_play_sessions.duration_ms),
        listened_ms = excluded.listened_ms,
        outcome = excluded.outcome,
        source = COALESCE(excluded.source, music_play_sessions.source)
      ",
      params![
        input.session_id,
        input.track_id,
        now,
        input.start_position_ms.unwrap_or(0).max(0),
        input.end_position_ms.unwrap_or(max_progress_ms).max(0),
        input.duration_ms,
        listened_ms,
        outcome,
        input.source.unwrap_or_else(|| "queue".to_string()),
      ],
    )
    .map_err(|error| format!("无法写入播放会话：{error}"))?;

  // Load current stats
  let current = transaction
    .query_row(
      "
      SELECT
        COALESCE(t.added_at, 0),
        COALESCE(s.play_count, 0),
        COALESCE(s.complete_count, 0),
        COALESCE(s.skip_count, 0),
        s.first_played_at,
        s.last_played_at,
        s.last_completed_at,
        s.last_skipped_at,
        COALESCE(s.total_listen_ms, 0)
      FROM music_tracks t
      LEFT JOIN music_track_stats s ON s.track_id = t.id
      WHERE t.id = ?1
      ",
      params![input.track_id],
      |row| {
        Ok((
          row.get::<_, i64>(0)?,
          row.get::<_, i64>(1)?,
          row.get::<_, i64>(2)?,
          row.get::<_, i64>(3)?,
          row.get::<_, Option<i64>>(4)?,
          row.get::<_, Option<i64>>(5)?,
          row.get::<_, Option<i64>>(6)?,
          row.get::<_, Option<i64>>(7)?,
          row.get::<_, i64>(8)?,
        ))
      },
    )
    .map_err(|error| format!("无法读取曲目统计：{error}"))?;

  let (
    added_at,
    mut play_count,
    mut complete_count,
    mut skip_count,
    first_played_at,
    mut last_played_at,
    mut last_completed_at,
    mut last_skipped_at,
    mut total_listen_ms,
  ) = current;

  if counted_play {
    play_count += 1;
    last_played_at = Some(now);
  }
  if counted_complete {
    complete_count += 1;
    last_completed_at = Some(now);
    last_played_at = Some(now);
  }
  if counted_skip {
    skip_count += 1;
    last_skipped_at = Some(now);
  }
  total_listen_ms = total_listen_ms.saturating_add(listened_ms);

  transaction
    .execute(
      "
      INSERT INTO music_track_stats (
        track_id, play_count, complete_count, skip_count, favorite,
        first_played_at, last_played_at, last_completed_at, last_skipped_at,
        total_listen_ms, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(track_id) DO UPDATE SET
        play_count = excluded.play_count,
        complete_count = excluded.complete_count,
        skip_count = excluded.skip_count,
        first_played_at = COALESCE(music_track_stats.first_played_at, excluded.first_played_at),
        last_played_at = excluded.last_played_at,
        last_completed_at = excluded.last_completed_at,
        last_skipped_at = excluded.last_skipped_at,
        total_listen_ms = excluded.total_listen_ms,
        updated_at = excluded.updated_at
      ",
      params![
        input.track_id,
        play_count,
        complete_count,
        skip_count,
        first_played_at.or(last_played_at),
        last_played_at,
        last_completed_at,
        last_skipped_at,
        total_listen_ms,
        now
      ],
    )
    .map_err(|error| format!("无法更新曲目统计：{error}"))?;

  transaction
    .commit()
    .map_err(|error| format!("无法提交播放会话：{error}"))?;

  Ok(MusicPlaySessionEndResult {
    track_id: input.track_id,
    activity: TrackActivityRecord {
      added_at,
      play_count,
      completed_count: complete_count,
      skip_count,
      last_played_at,
      last_skipped_at,
    },
    outcome,
    counted_play,
    counted_complete,
    counted_skip,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::library::Track;

  #[test]
  fn clear_is_atomic_and_preserves_podcast_pins_and_audio_files() {
    let root = test_root("atomic-clear");
    let state = MusicState::initialize_at(&root).unwrap();
    let path = root.join("track.mp3");
    fs::write(&path, b"id3").unwrap();
    let legacy = serde_json::json!({
      "tracks": [sample_track("one", &path.to_string_lossy())],
      "queue": ["one"],
      "playlists": [{ "id": "custom", "name": "测试", "description": "", "kind": "manual", "trackIds": ["one"] }],
      "homePins": [
        { "id": "track:one", "kind": "track", "targetId": "one", "createdAt": 1 },
        { "id": "podcastFeed:feed", "kind": "podcastFeed", "targetId": "feed", "createdAt": 2 }
      ]
    });
    import_legacy_player_state(&state, serde_json::from_value(legacy).unwrap()).unwrap();
    let before = load_library_snapshot(&state).unwrap();
    let connection = open_music_db(&state).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_clear BEFORE DELETE ON music_tracks BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
    assert!(clear_library(&state).is_err());
    let after = load_library_snapshot(&state).unwrap();
    assert_eq!(serde_json::to_value(&before).unwrap(), serde_json::to_value(&after).unwrap());
    connection.execute_batch("DROP TRIGGER fail_clear").unwrap();
    clear_library(&state).unwrap();
    let cleared = load_library_snapshot(&state).unwrap();
    assert!(cleared.tracks.is_empty());
    assert!(cleared.playback.queue.is_empty());
    assert_eq!(cleared.playlists.len(), 1);
    assert!(cleared.playlists[0].track_ids.is_empty());
    assert_eq!(cleared.home_pins.len(), 1);
    assert_eq!(cleared.home_pins[0].kind, "podcastFeed");
    assert!(path.exists());
  }

  #[test]
  fn retrying_empty_music_migration_preserves_newer_podcast_pins() {
    let state = MusicState::initialize_at(&test_root("retry-empty-migration")).unwrap();
    let legacy = serde_json::json!({ "homePins": [{ "id": "pin", "kind": "podcastFeed", "targetId": "feed", "createdAt": 1 }] });
    let first = import_legacy_player_state(&state, serde_json::from_value(legacy.clone()).unwrap()).unwrap();
    assert_eq!(first.home_pins.len(), 1);
    save_home_pins(&state, vec![]).unwrap();
    let retry = import_legacy_player_state(&state, serde_json::from_value(legacy).unwrap()).unwrap();
    assert!(retry.home_pins.is_empty());
  }

  #[test]
  fn home_pin_customization_round_trips_and_failed_replacement_is_atomic() {
    let root = test_root("pin-customization");
    let state = MusicState::initialize_at(&root).unwrap();
    let small: HomePinRecord = serde_json::from_value(serde_json::json!({
      "id": "track:one", "kind": "track", "targetId": "one", "createdAt": 17,
      "size": "small", "tone": "teal", "live": false
    })).unwrap();
    let legacy: HomePinRecord = serde_json::from_value(serde_json::json!({
      "id": "podcastFeed:two", "kind": "podcastFeed", "targetId": "two", "createdAt": 20
    })).unwrap();
    save_home_pins(&state, vec![legacy.clone(), small.clone()]).unwrap();
    let reopened = MusicState::initialize_at(&root).unwrap();
    let before = load_library_snapshot(&reopened).unwrap();
    assert_eq!(before.home_pins[0].id, legacy.id);
    assert_eq!(before.home_pins[0].size, None);
    assert_eq!(before.home_pins[1].size.as_deref(), Some("small"));
    assert_eq!(before.home_pins[1].tone.as_deref(), Some("teal"));
    assert_eq!(before.home_pins[1].live, Some(false));
    // A constraint failure after the first INSERT must restore the entire wall.
    assert!(save_home_pins(&state, vec![small.clone(), small.clone()]).is_err());
    let mut invalid = small.clone();
    invalid.tone = Some("invalid".into());
    assert!(save_home_pins(&state, vec![invalid]).is_err());
    let after = load_library_snapshot(&state).unwrap();
    assert_eq!(serde_json::to_value(&before.home_pins).unwrap(), serde_json::to_value(&after.home_pins).unwrap());
    assert_eq!(before.library_revision, after.library_revision);
    save_home_pins(&state, vec![small, legacy]).unwrap();
    assert_eq!(load_library_snapshot(&state).unwrap().home_pins[0].id, "track:one");
  }

  #[test]
  fn cancellation_after_scanning_rolls_back_folder_and_revision_changes() {
    let root = test_root("cancel-scan");
    let state = MusicState::initialize_at(&root).unwrap();
    let folder = MusicFolder { path: root.to_string_lossy().to_string(), name: "Original".into() };
    scan_and_store_library_controlled(&state, vec![folder], &|| false, &|_| {}).unwrap();
    let before = load_library_snapshot(&state).unwrap();
    let cancelled = std::cell::Cell::new(false);
    let result = scan_and_store_library_controlled(&state, vec![], &|| cancelled.get(), &|_| cancelled.set(true));
    assert!(result.unwrap_err().contains("取消"));
    let after = load_library_snapshot(&state).unwrap();
    assert_eq!(after.folders.len(), 1);
    assert_eq!(after.folders[0].name, before.folders[0].name);
    assert_eq!(after.library_revision, before.library_revision);
  }

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

  #[test]
  fn unavailable_scan_keeps_the_snapshot_and_reconnection_preserves_activity() {
    let root = test_root("offline-scan");
    let state = MusicState::initialize_at(&root).unwrap();
    let dir = root.join("Music");
    fs::create_dir(&dir).unwrap();
    let file = dir.join("one.mp3");
    fs::write(&file, b"id3").unwrap();
    let folder = MusicFolder { path: dir.to_string_lossy().into(), name: "音乐".into() };
    let first = scan_and_store_library_controlled(&state, vec![folder.clone()], &|| false, &|_| {}).unwrap();
    let id = first.tracks[0].id.clone();
    save_track_activity(&state, serde_json::from_value(serde_json::json!({ id.clone(): {
      "addedAt": 1, "playCount": 7, "completedCount": 5, "skipCount": 0
    } })).unwrap()).unwrap();
    save_home_pins(&state, serde_json::from_value(serde_json::json!([
      { "id": "pin", "kind": "track", "targetId": id, "createdAt": 1 }
    ])).unwrap()).unwrap();
    let before = load_library_snapshot(&state).unwrap();
    fs::rename(&dir, root.join("Offline")).unwrap();
    assert!(scan_and_store_library_controlled(&state, vec![folder.clone()], &|| false, &|_| {}).unwrap_err().contains("已保留"));
    assert_eq!(serde_json::to_value(&before).unwrap(), serde_json::to_value(load_library_snapshot(&state).unwrap()).unwrap());
    fs::rename(root.join("Offline"), &dir).unwrap();
    let invalid = MusicFolder { path: root.join("Missing").to_string_lossy().into(), name: "离线".into() };
    fs::write(dir.join("two.mp3"), b"id3").unwrap();
    assert!(scan_and_store_library_controlled(&state, vec![folder.clone(), invalid], &|| false, &|_| {}).is_err());
    assert_eq!(serde_json::to_value(&before).unwrap(), serde_json::to_value(load_library_snapshot(&state).unwrap()).unwrap());
    scan_and_store_library_controlled(&state, vec![folder.clone()], &|| false, &|_| {}).unwrap();
    assert_eq!(load_library_snapshot(&state).unwrap().track_activity[&id].play_count, 7);
    fs::remove_file(&file).unwrap();
    fs::remove_file(dir.join("two.mp3")).unwrap();
    let empty = scan_and_store_library_controlled(&state, vec![folder], &|| false, &|_| {}).unwrap();
    assert!(empty.tracks.is_empty(), "a successfully scanned empty directory is authoritative");
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
  fn classifies_completed_and_skipped_sessions() {
    let root = test_root("sessions");
    let state = MusicState::initialize_at(&root).expect("init music state");
    let music_dir = root.join("Music");
    fs::create_dir_all(&music_dir).expect("create music dir");
    let track_path = music_dir.join("a.mp3");
    fs::write(&track_path, b"id3").expect("write fake track");

    // Seed one track through legacy import.
    let legacy = LegacyPlayerStateV1 {
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
    };
    import_legacy_player_state(&state, legacy).expect("import");

    start_play_session(
      &state,
      MusicPlaySessionStartInput {
        session_id: "s1".to_string(),
        track_id: "track-1".to_string(),
        start_position_ms: Some(0),
        duration_ms: Some(200_000),
        source: Some("queue".to_string()),
      },
    )
    .expect("start");

    let completed = end_play_session(
      &state,
      MusicPlaySessionEndInput {
        session_id: "s1".to_string(),
        track_id: "track-1".to_string(),
        start_position_ms: Some(0),
        end_position_ms: Some(190_000),
        duration_ms: Some(200_000),
        listened_ms: Some(190_000),
        outcome: "completed".to_string(),
        source: Some("queue".to_string()),
        max_progress_ms: Some(190_000),
      },
    )
    .expect("complete");
    assert!(completed.counted_play);
    assert!(completed.counted_complete);
    assert!(!completed.counted_skip);
    assert_eq!(completed.activity.play_count, 1);
    assert_eq!(completed.activity.completed_count, 1);

    start_play_session(
      &state,
      MusicPlaySessionStartInput {
        session_id: "s2".to_string(),
        track_id: "track-1".to_string(),
        start_position_ms: Some(0),
        duration_ms: Some(200_000),
        source: Some("queue".to_string()),
      },
    )
    .expect("start skip session");
    let skipped = end_play_session(
      &state,
      MusicPlaySessionEndInput {
        session_id: "s2".to_string(),
        track_id: "track-1".to_string(),
        start_position_ms: Some(0),
        end_position_ms: Some(8_000),
        duration_ms: Some(200_000),
        listened_ms: Some(8_000),
        outcome: "skipped".to_string(),
        source: Some("queue".to_string()),
        max_progress_ms: Some(8_000),
      },
    )
    .expect("skip");
    assert!(!skipped.counted_play);
    assert!(!skipped.counted_complete);
    assert!(skipped.counted_skip);
    assert_eq!(skipped.activity.play_count, 1);
    assert_eq!(skipped.activity.skip_count, 1);
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
        size: None,
        live: None,
        tone: None,
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


#[allow(dead_code)]
pub(crate) fn open_music_db_path(db_path: &std::path::Path) -> Result<Connection, String> {
  crate::db::open_zone_database(db_path)
}

pub(crate) fn track_exists_on(connection: &Connection, track_id: &str) -> bool {
  track_exists(connection, track_id)
}
