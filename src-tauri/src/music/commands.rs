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
pub(crate) fn music_scan_library(
  state: State<'_, MusicState>,
  folders: Vec<MusicFolder>,
) -> Result<MusicScanWriteResult, String> {
  scan_and_store_library(state.inner(), folders)
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
pub(crate) fn music_clear_library(state: State<'_, MusicState>) -> Result<(), String> {
  clear_library(state.inner())
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

