mod audio_protocol;
mod audio_transcode;
mod db;
mod diagnostics;
mod image_scope;
mod library;
mod lyrics;
mod lyrics_provider;
mod metadata;
mod music;
mod podcast;
mod provider_health;
mod qrc;
mod system_media;
mod window_mode;
#[cfg(target_os = "windows")]
mod webview_runtime;

use tauri::http::{header, Response, StatusCode};
use tauri::{Emitter, Manager};

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


fn setup_system_tray(app: &tauri::App) {
  use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
  };

  let show_item = match MenuItem::with_id(app, "show", "显示 Zone", true, None::<&str>) {
    Ok(item) => item,
    Err(error) => {
      eprintln!("[tray] menu item failed: {error}");
      return;
    }
  };
  let play_item = match MenuItem::with_id(app, "toggle", "播放/暂停", true, None::<&str>) {
    Ok(item) => item,
    Err(error) => {
      eprintln!("[tray] menu item failed: {error}");
      return;
    }
  };
  let prev_item = match MenuItem::with_id(app, "previous", "上一首", true, None::<&str>) {
    Ok(item) => item,
    Err(error) => {
      eprintln!("[tray] menu item failed: {error}");
      return;
    }
  };
  let next_item = match MenuItem::with_id(app, "next", "下一首", true, None::<&str>) {
    Ok(item) => item,
    Err(error) => {
      eprintln!("[tray] menu item failed: {error}");
      return;
    }
  };
  let quit_item = match MenuItem::with_id(app, "quit", "退出", true, None::<&str>) {
    Ok(item) => item,
    Err(error) => {
      eprintln!("[tray] menu item failed: {error}");
      return;
    }
  };
  let menu = match Menu::with_items(app, &[&show_item, &play_item, &prev_item, &next_item, &quit_item]) {
    Ok(menu) => menu,
    Err(error) => {
      eprintln!("[tray] menu failed: {error}");
      return;
    }
  };

  let tray_result = TrayIconBuilder::new()
    .menu(&menu)
    .tooltip("Zone")
    .on_menu_event(|app, event| {
      match event.id.as_ref() {
        "show" => {
          if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
          }
        }
        "quit" => {
          app.exit(0);
        }
        "toggle" | "previous" | "next" => {
          if let Some(window) = app.get_webview_window("main") {
            let event_name = match event.id.as_ref() {
              "toggle" => "zone://tray-toggle",
              "previous" => "zone://tray-previous",
              _ => "zone://tray-next",
            };
            let _ = window.emit(event_name, ());
          }
        }
        _ => {}
      }
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        let app = tray.app_handle();
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.show();
          let _ = window.set_focus();
        }
      }
    })
    .build(app);

  if let Err(error) = tray_result {
    eprintln!("[tray] unavailable: {error}");
  }
}

pub fn run() {
  #[cfg(target_os = "windows")]
  webview_runtime::configure();
  #[cfg(target_os = "windows")]
  if let Err(error) = system_media::set_process_app_id() {
    eprintln!("Unable to set the Windows AppUserModelID: {error}");
  }

  let initial_window_fitted = std::sync::atomic::AtomicBool::new(false);
  tauri::Builder::default()
    .on_page_load(move |webview, payload| {
      if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Finished
        && payload.url().scheme() != "about"
        && !initial_window_fitted.swap(true, std::sync::atomic::Ordering::Relaxed) {
        if let Some(window) = webview.app_handle().get_webview_window("main") {
          if let Err(error) = window_mode::fit_initial_window(&window) {
            eprintln!("Unable to fit the initial window to the desktop: {error}");
          }
        }
      }
    })
    .plugin(tauri_plugin_single_instance::init(|app, _, _| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
      }
    }))
    .plugin(tauri_plugin_opener::init())
    .manage(library::LibraryWatcherState::default())
    .manage(window_mode::CompactWindowState::default())
    .register_asynchronous_uri_scheme_protocol("zone-audio", |ctx, request, responder| {
      let cache_dir = ctx.app_handle().path().app_cache_dir().ok().map(|path| path.join("audio-transcodes"));
      tauri::async_runtime::spawn_blocking(move || {
        responder.respond(audio_protocol::serve_audio_protocol_with_cache(request, cache_dir.as_deref()));
      });
    })
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
      library::init_cover_cache_dir(app.handle());
      let podcast_state = match podcast::PodcastState::initialize(app.handle()) {
        Ok(state) => state,
        Err(error) => {
          eprintln!("[podcast] initialization failed: {error}");
          podcast::PodcastState::unavailable(error)
        }
      };
      podcast::start_podcast_maintenance(app.handle().clone(), podcast_state.clone());
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
      music::start_feature_worker(app.handle().clone(), app.state::<music::MusicState>().inner().clone());
      setup_system_tray(app);

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
      window_mode::get_compact_mode,
      window_mode::get_main_window_visibility,
      window_mode::set_compact_mode,
      window_mode::set_compact_pinned,
      diagnostics::export_diagnostics,
      library::select_music_folder,
      lyrics::select_lyrics_file,
      lyrics::export_lyrics_file,
      library::scan_library,
      library::watch_music_folders,
      music::music_get_library_snapshot,
      music::music_import_legacy_player_state,
      music::music_scan_library,
      music::music_cancel_scan,
      music::music_decode_beat_window,
      music::music_cancel_beat_window,
      music::music_save_playlists,
      music::music_save_home_pins,
      music::music_save_track_activity,
      music::music_save_playback_state,
      music::music_clear_library,
      music::music_session_start,
      music::music_session_end,
      music::music_analyze_features,
      music::music_feature_status,
      music::music_list_similar_tracks,
      music::music_list_track_features,
      music::music_analyze_track_pcm,
      music::music_upsert_radio_session,
      music::music_get_radio_session,
      music::music_stop_radio_session,
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
      podcast::podcast_cancel_network_request,
      podcast::podcast_browse_apple,
      podcast::podcast_browse_discovery,
      podcast::podcast_load_discovery_cache,
      podcast::podcast_subscribe,
      podcast::podcast_preview_feed,
      podcast::podcast_refresh_feeds,
      podcast::podcast_get_preferences,
      podcast::podcast_set_preferences,
      podcast::podcast_list_download_jobs,
      podcast::podcast_enqueue_download,
      podcast::podcast_pause_download_job,
      podcast::podcast_import_opml,
      podcast::podcast_export_opml,
      podcast::podcast_export_backup,
      podcast::podcast_restore_backup,
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
      podcast::podcast_cache_artwork,
      podcast::podcast_save_progress,
      podcast::podcast_load_active_episode,
      podcast::podcast_save_active_episode,
    ])
    .run(tauri::generate_context!())
    .expect("error while running Zone");
}
