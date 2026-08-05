mod audio_protocol;
mod db;
mod library;
mod lyrics;
mod lyrics_provider;
mod metadata;
mod music;
mod podcast;
mod qrc;
mod system_media;

use tauri::http::{header, Response, StatusCode};
use tauri::Manager;

#[tauri::command]
fn update_system_media(state: system_media::SystemMediaState) -> Result<(), String> {
  system_media::update(state)
}

#[tauri::command]
fn update_system_media_timeline(
  duration_seconds: f64,
  position_seconds: f64,
) -> Result<(), String> {
  system_media::update_timeline(duration_seconds, position_seconds)
}

pub fn run() {
  #[cfg(target_os = "windows")]
  if let Err(error) = system_media::set_process_app_id() {
    eprintln!("Unable to set the Windows AppUserModelID: {error}");
  }

  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .manage(library::LibraryWatcherState::default())
    .register_uri_scheme_protocol("zone-audio", |_ctx, request| audio_protocol::serve_audio_protocol(request))
    .register_asynchronous_uri_scheme_protocol("zone-podcast-artwork", |_ctx, request, responder| {
      tauri::async_runtime::spawn(async move {
        let response = podcast::serve_podcast_artwork_protocol(request).await;
        responder.respond(response);
      });
    })
    .register_asynchronous_uri_scheme_protocol("zone-podcast", |ctx, request, responder| {
      let Some(state) = ctx.app_handle().try_state::<podcast::PodcastState>() else {
        responder.respond(
          Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body("podcast state unavailable".as_bytes().to_vec())
            .unwrap(),
        );
        return;
      };
      let state = state.inner().clone();
      tauri::async_runtime::spawn(async move {
        let response = podcast::serve_podcast_stream_protocol(state, request).await;
        responder.respond(response);
      });
    })
    .setup(|app| {
      let podcast_state = match podcast::PodcastState::initialize(app.handle()) {
        Ok(state) => state,
        Err(error) => {
          eprintln!("[podcast] initialization failed: {error}");
          podcast::PodcastState::unavailable(error)
        }
      };
      app.manage(podcast_state);
      let metadata_state = match metadata::MetadataState::initialize(app.handle()) {
        Ok(state) => state,
        Err(error) => {
          eprintln!("[metadata] initialization failed: {error}");
          metadata::MetadataState::unavailable(error)
        }
      };
      app.manage(metadata_state);
      let music_state = match music::MusicState::initialize(app.handle()) {
        Ok(state) => state,
        Err(error) => {
          eprintln!("[music] initialization failed: {error}");
          music::MusicState::unavailable(error)
        }
      };
      app.manage(music_state);

      #[cfg(target_os = "windows")]
      if let Some(window) = app.get_webview_window("main") {
        match window.hwnd() {
          Ok(hwnd) => {
            if let Err(error) = system_media::initialize(app.handle().clone(), hwnd.0 as isize) {
              eprintln!("Windows media integration is unavailable: {error}");
            }
          }
          Err(error) => eprintln!("Unable to get the main window handle: {error}"),
        }
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      library::select_music_folder,
      lyrics::select_lyrics_file,
      lyrics::export_lyrics_file,
      library::scan_library,
      library::watch_music_folders,
      music::music_get_library_snapshot,
      music::music_import_legacy_player_state,
      music::music_scan_library,
      music::music_save_playlists,
      music::music_save_home_pins,
      music::music_save_track_activity,
      music::music_save_playback_state,
      music::music_clear_library,
      music::music_session_start,
      music::music_session_end,
      lyrics::load_local_lyrics,
      lyrics_provider::request_lyrics_provider,
      lyrics_provider::decrypt_qrc_lyrics,
      metadata::metadata_list_providers,
      metadata::metadata_search_sidecars,
      metadata::metadata_apply_sidecar,
      metadata::metadata_search_apple_music,
      metadata::metadata_apply_apple_music,
      metadata::metadata_search_netease_music,
      metadata::metadata_apply_netease_music,
      metadata::metadata_apply_manual,
      metadata::metadata_get_track_overlays,
      metadata::metadata_get_context,
      metadata::metadata_clear_context,
      update_system_media,
      update_system_media_timeline,
      podcast::podcast_search_apple,
      podcast::podcast_browse_apple,
      podcast::podcast_subscribe,
      podcast::podcast_preview_feed,
      podcast::podcast_refresh_feeds,
      podcast::podcast_list_feeds,
      podcast::podcast_set_following,
      podcast::podcast_list_home,
      podcast::podcast_list_downloads,
      podcast::podcast_list_episodes,
      podcast::podcast_list_related_episodes,
      podcast::podcast_get_episode_detail,
      podcast::podcast_get_episode_chapters,
      podcast::podcast_set_episode_saved,
      podcast::podcast_list_saved_episodes,
      podcast::podcast_set_episode_played,
      podcast::podcast_set_episodes_played,
      podcast::podcast_list_queue,
      podcast::podcast_queue_add,
      podcast::podcast_queue_remove,
      podcast::podcast_queue_remove_many,
      podcast::podcast_queue_reorder,
      podcast::podcast_queue_clear,
      podcast::podcast_queue_autofill,
      podcast::podcast_download_episode,
      podcast::podcast_delete_episode_download,
      podcast::podcast_delete_episode_downloads,
      podcast::podcast_clear_completed_downloads,
      podcast::podcast_save_progress,
    ])
    .run(tauri::generate_context!())
    .expect("error while running Zone");
}

