use std::sync::{Mutex, atomic::{AtomicU64, Ordering}};
static SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);
static SCAN_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub(crate) fn music_cancel_scan() { SCAN_GENERATION.fetch_add(1, Ordering::SeqCst); }

use super::*;
use std::collections::HashMap;
use tauri::State;

use crate::library::MusicFolder;

#[tauri::command]
pub(crate) fn music_get_library_snapshot(
  state: State<'_, MusicState>,
) -> Result<MusicLibrarySnapshot, String> {
  load_library_snapshot(state.inner())
}

#[tauri::command]
pub(crate) fn music_import_legacy_player_state(
  state: State<'_, MusicState>,
  legacy: LegacyPlayerStateV1,
) -> Result<MusicLibrarySnapshot, String> {
  import_legacy_player_state(state.inner(), legacy)
}

#[tauri::command]
pub(crate) async fn music_scan_library(
  progress: tauri::ipc::Channel<usize>,
  state: State<'_, MusicState>,
  folders: Vec<MusicFolder>,
) -> Result<MusicScanWriteResult, String> {
  let state = state.inner().clone();
  let generation = SCAN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
  tauri::async_runtime::spawn_blocking(move || {
    let _lock = SCAN_LOCK.lock().map_err(|_| "曲库扫描暂不可用".to_string())?;
    let cancelled = || SCAN_GENERATION.load(Ordering::SeqCst) != generation;
    if cancelled() { return Err("曲库扫描已取消".into()); }
    scan_and_store_library_controlled(&state, folders, &cancelled, &|count| { let _ = progress.send(count); })
  })
    .await
    .map_err(|error| format!("曲库扫描任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) fn music_save_playlists(
  state: State<'_, MusicState>,
  playlists: Vec<PlaylistRecord>,
) -> Result<(), String> {
  save_playlists(state.inner(), playlists)
}

#[tauri::command]
pub(crate) fn music_save_home_pins(
  state: State<'_, MusicState>,
  pins: Vec<HomePinRecord>,
) -> Result<(), String> {
  save_home_pins(state.inner(), pins)
}

#[tauri::command]
pub(crate) fn music_save_track_activity(
  state: State<'_, MusicState>,
  activity: HashMap<String, TrackActivityRecord>,
) -> Result<(), String> {
  save_track_activity(state.inner(), activity)
}

#[tauri::command]
pub(crate) fn music_save_playback_state(
  state: State<'_, MusicState>,
  playback: MusicPlaybackStateInput,
) -> Result<(), String> {
  save_playback_state(state.inner(), playback)
}

#[tauri::command]
pub(crate) async fn music_clear_library(state: State<'_, MusicState>) -> Result<(), String> {
  let state = state.inner().clone();
  SCAN_GENERATION.fetch_add(1, Ordering::SeqCst);
  tauri::async_runtime::spawn_blocking(move || {
    let _lock = SCAN_LOCK.lock().map_err(|_| "曲库扫描暂不可用".to_string())?;
    clear_library(&state)
  }).await.map_err(|error| format!("音乐库清理任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) fn music_session_start(
  state: State<'_, MusicState>,
  session: MusicPlaySessionStartInput,
) -> Result<(), String> {
  start_play_session(state.inner(), session)
}

#[tauri::command]
pub(crate) fn music_session_end(
  state: State<'_, MusicState>,
  session: MusicPlaySessionEndInput,
) -> Result<MusicPlaySessionEndResult, String> {
  end_play_session(state.inner(), session)
}



#[tauri::command]
pub(crate) fn music_analyze_features(
  state: State<'_, MusicState>,
  limit: Option<u32>,
) -> Result<FeatureJobStatus, String> {
  let connection = open_music_db(state.inner())?;
  // Enqueue candidates only; the background worker does the actual decoding
  // so this command never blocks the UI on a large library.
  let batch = limit.unwrap_or(256).clamp(1, 2000) as usize;
  let _ = enqueue_missing_feature_jobs(&connection, batch)?;
  request_feature_analysis();
  feature_status(&connection)
}

#[tauri::command]
pub(crate) fn music_feature_status(
  state: State<'_, MusicState>,
) -> Result<FeatureJobStatus, String> {
  let connection = open_music_db(state.inner())?;
  feature_status(&connection)
}

#[tauri::command]
pub(crate) fn music_list_similar_tracks(
  state: State<'_, MusicState>,
  track_id: String,
  limit: Option<u32>,
) -> Result<Vec<SimilarTrackMatch>, String> {
  let connection = open_music_db(state.inner())?;
  // Best-effort: ensure seed has features.
  if !load_feature_map(&connection)?.contains_key(&track_id) {
    let _ = analyze_and_store_track(&connection, &track_id);
  }
  find_similar_tracks(&connection, &track_id, limit.unwrap_or(24).clamp(1, 100) as usize)
}

#[tauri::command]
pub(crate) fn music_list_track_features(
  state: State<'_, MusicState>,
  track_ids: Option<Vec<String>>,
) -> Result<HashMap<String, Vec<f32>>, String> {
  let connection = open_music_db(state.inner())?;
  let mut map = load_feature_map(&connection)?;
  if let Some(ids) = track_ids {
    map.retain(|track_id, _| ids.iter().any(|id| id == track_id));
  }
  Ok(map)
}


#[tauri::command]
pub(crate) fn music_upsert_radio_session(
  state: State<'_, MusicState>,
  session: RadioSessionUpsertInput,
) -> Result<RadioSessionRecord, String> {
  upsert_radio_session(state.inner(), session)
}

#[tauri::command]
pub(crate) fn music_get_radio_session(
  state: State<'_, MusicState>,
  session_id: Option<String>,
) -> Result<Option<RadioSessionRecord>, String> {
  get_radio_session(state.inner(), session_id)
}

#[tauri::command]
pub(crate) fn music_stop_radio_session(
  state: State<'_, MusicState>,
  session_id: Option<String>,
) -> Result<(), String> {
  stop_radio_session(state.inner(), session_id)
}


#[tauri::command]
pub(crate) fn music_analyze_track_pcm(
  state: State<'_, MusicState>,
  track_id: String,
  pcm: Option<PcmFeatureSummary>,
) -> Result<TrackFeatureVector, String> {
  let connection = open_music_db(state.inner())?;
  analyze_and_store_track_with_pcm(&connection, &track_id, pcm)
}
