use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use std::fs;
use std::path::Path;

use crate::db::initialize_zone_database;
use crate::library::{MusicFolder, Track};
use super::store::ensure_default_playlist;

pub(crate) const DEFAULT_PLAYLIST_ID: &str = "favorites";
pub(crate) const DEFAULT_PLAYLIST_NAME: &str = "收藏";
pub(crate) const DEFAULT_PLAYLIST_DESCRIPTION: &str = "收藏的歌曲";

#[derive(Clone, Debug)]
pub(crate) struct MusicState {
  pub(crate) db_path: PathBuf,
  pub(crate) initialization_error: Option<String>,
}

impl MusicState {
  pub(crate) fn initialize(app: &AppHandle) -> Result<Self, String> {
    let app_data_dir = app
      .path()
      .app_data_dir()
      .map_err(|error| format!("无法定位音乐数据目录：{error}"))?;
    Self::initialize_at(&app_data_dir)
  }

  pub(crate) fn initialize_at(app_data_dir: &Path) -> Result<Self, String> {
    fs::create_dir_all(app_data_dir).map_err(|error| format!("无法创建音乐数据目录：{error}"))?;
    let db_path = initialize_zone_database(app_data_dir)?;
    ensure_default_playlist(&db_path)?;
    Ok(Self {
      db_path,
      initialization_error: None,
    })
  }

  pub(crate) fn unavailable(error: String) -> Self {
    Self {
      db_path: PathBuf::new(),
      initialization_error: Some(error),
    }
  }

  pub(crate) fn ensure_ready(&self) -> Result<(), String> {
    if let Some(error) = self.initialization_error.as_deref() {
      Err(format!("音乐库功能初始化失败：{error}"))
    } else {
      Ok(())
    }
  }

  pub(crate) fn db_path(&self) -> &Path {
    &self.db_path
  }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicLibrarySnapshot {
  pub folders: Vec<MusicFolder>,
  pub tracks: Vec<Track>,
  pub playlists: Vec<PlaylistRecord>,
  pub home_pins: Vec<HomePinRecord>,
  pub track_activity: HashMap<String, TrackActivityRecord>,
  pub playback: MusicPlaybackSnapshot,
  pub library_revision: i64,
  pub has_library: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicPlaybackSnapshot {
  pub active_track_id: Option<String>,
  pub queue: Vec<String>,
  pub play_history: Vec<String>,
  pub volume: f64,
  pub shuffle: bool,
  pub repeat: String,
  pub selected_playlist_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackActivityRecord {
  pub added_at: i64,
  pub play_count: i64,
  pub completed_count: i64,
  pub skip_count: i64,
  pub last_played_at: Option<i64>,
  pub last_skipped_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomePinRecord {
  pub id: String,
  pub kind: String,
  pub target_id: String,
  pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaylistRecord {
  pub id: String,
  pub name: String,
  pub description: String,
  pub kind: String,
  #[serde(default)]
  pub track_ids: Vec<String>,
  #[serde(default)]
  pub smart: Option<Value>,
  #[serde(default)]
  pub excluded_track_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyPlayerStateV1 {
  #[serde(default)]
  pub library_schema_version: Option<i64>,
  #[serde(default)]
  pub folders: Vec<MusicFolder>,
  #[serde(default)]
  pub tracks: Vec<Track>,
  #[serde(default)]
  pub active_track_id: Option<String>,
  #[serde(default)]
  pub queue: Vec<String>,
  #[serde(default)]
  pub play_history: Vec<String>,
  #[serde(default)]
  pub track_activity: HashMap<String, TrackActivityRecord>,
  #[serde(default)]
  pub volume: Option<f64>,
  #[serde(default)]
  pub shuffle: Option<bool>,
  #[serde(default)]
  pub repeat: Option<String>,
  #[serde(default)]
  pub playlists: Vec<PlaylistRecord>,
  #[serde(default)]
  pub selected_playlist_id: Option<String>,
  #[serde(default)]
  pub home_pins: Vec<HomePinRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicPlaybackStateInput {
  #[serde(default)]
  pub active_track_id: Option<String>,
  #[serde(default)]
  pub queue: Vec<String>,
  #[serde(default)]
  pub play_history: Vec<String>,
  #[serde(default)]
  pub volume: Option<f64>,
  #[serde(default)]
  pub shuffle: Option<bool>,
  #[serde(default)]
  pub repeat: Option<String>,
  #[serde(default)]
  pub selected_playlist_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicScanWriteResult {
  pub folders: Vec<String>,
  pub tracks: Vec<Track>,
  pub skipped: usize,
  pub library_revision: i64,
}
