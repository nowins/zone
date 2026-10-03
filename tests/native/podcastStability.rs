use std::{fs::{self, OpenOptions}, io::Write, path::PathBuf, sync::{Arc, atomic::{AtomicU8, AtomicUsize, Ordering}}, time::Duration};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use sha2::{Digest, Sha256};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Config { phase: String, duration_ms: u64, cycles: usize, port: u16, #[serde(default)] allow_disk_full: bool, #[serde(default)] webview_directory: Option<PathBuf>, #[serde(default)] crash_delay_ms: Option<u64>, #[serde(default)] switch_rounds: Option<usize> }
struct Fixture { directory: PathBuf, mode: Arc<AtomicU8>, requests: Arc<AtomicUsize>, audio_hash: Vec<u8> }
fn config(directory: &std::path::Path) -> Config {
  serde_json::from_slice(&fs::read(directory.join("config.json")).unwrap()).unwrap()
}

pub fn run() {
  let directory = PathBuf::from(std::env::var("ZONE_PODCAST_STABILITY_DIR").expect("isolated test directory required"));
  let options = config(&directory);
  assert!(options.duration_ms <= 14_400_000 && options.cycles <= 2000 && options.switch_rounds.unwrap_or(1) <= 5, "fixture bounds exceeded");
  fs::create_dir_all(&directory).unwrap();
  let seconds = if options.phase == "soak" { (options.duration_ms / 1000 + 600).max(900) } else { 300 };
  let rate = 8000u32;
  let length = rate as usize * 2 * seconds as usize;
  let mut wav = vec![0; length + 44];
  wav[..4].copy_from_slice(b"RIFF"); wav[4..8].copy_from_slice(&((length + 36) as u32).to_le_bytes());
  wav[8..16].copy_from_slice(b"WAVEfmt "); wav[16..20].copy_from_slice(&16u32.to_le_bytes());
  wav[20..24].copy_from_slice(&[1, 0, 1, 0]); wav[24..28].copy_from_slice(&rate.to_le_bytes());
  wav[28..32].copy_from_slice(&(rate * 2).to_le_bytes()); wav[32..36].copy_from_slice(&[2, 0, 16, 0]);
  wav[36..40].copy_from_slice(b"data"); wav[40..44].copy_from_slice(&(length as u32).to_le_bytes());
  for (index, value) in wav[44..].chunks_exact_mut(2).enumerate() {
    let signal = ((index as f64 * 440.0 * std::f64::consts::TAU / rate as f64).sin() * 6000.0) as i16;
    value.copy_from_slice(&signal.to_le_bytes());
  }
  let listener = std::net::TcpListener::bind(("127.0.0.1", options.port)).unwrap();
  listener.set_nonblocking(true).unwrap();
  let wav = Arc::new(wav);
  let mode = Arc::new(AtomicU8::new(0));
  let requests = Arc::new(AtomicUsize::new(0));
  let server_mode = mode.clone(); let request_count = requests.clone(); let server_wav = wav.clone();
  tauri::async_runtime::spawn(async move {
    let listener = tokio::net::TcpListener::from_std(listener).unwrap();
    loop {
      let (mut stream, _) = listener.accept().await.unwrap();
      let wav = server_wav.clone(); let mode = server_mode.clone();
      request_count.fetch_add(1, Ordering::Relaxed);
      tauri::async_runtime::spawn(async move {
        let mut input = [0u8; 8192];
        let count = match stream.read(&mut input).await { Ok(count) => count, Err(_) => return };
        if mode.load(Ordering::Relaxed) == 4 { return; }
        if mode.load(Ordering::Relaxed) == 1 {
          let _ = stream.write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await; return;
        }
        let request = String::from_utf8_lossy(&input[..count]).to_ascii_lowercase();
        let range = request.lines().find_map(|line| line.strip_prefix("range: bytes="));
        let (start, end) = range.and_then(|range| range.split_once('-')).map(|(start, end)|
          (start.parse::<usize>().unwrap_or(0), end.parse::<usize>().unwrap_or(wav.len() - 1)))
          .unwrap_or((0, wav.len() - 1));
        let end = end.min(wav.len() - 1);
        if start > end { return; }
        let headers = format!("HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nETag: \"fixture-v1\"\r\nConnection: close\r\n\r\n", end-start+1, wav.len());
        if stream.write_all(headers.as_bytes()).await.is_err() { return; }
        let mode_at_start = mode.load(Ordering::Relaxed);
        let served_end = if mode_at_start == 2 { start + (end-start)/2 } else { end };
        for chunk in wav[start..=served_end].chunks(64 * 1024) {
          if mode.load(Ordering::Relaxed) == 1 { return; }
          if stream.write_all(chunk).await.is_err() { return; }
          if mode_at_start == 3 { tokio::time::sleep(Duration::from_millis(100)).await; }
        }
      });
    }
  });
  let state = crate::podcast::PodcastState::initialize_at_with_artwork_cache(&directory, directory.join("artwork")).unwrap();
  let xml = "<rss version=\"2.0\"><channel><title>稳定性测试</title><item><guid>stream</guid><title>在线音频</title><enclosure url=\"https://example.com/a.wav\" type=\"audio/wav\"/></item><item><guid>local</guid><title>离线音频</title><enclosure url=\"https://example.com/b.wav\" type=\"audio/wav\"/></item></channel></rss>";
  let mut parsed = crate::podcast::parse_feed_bytes(xml.as_bytes(), "https://example.com/stability.xml", None, None, None, None, None).unwrap();
  let first = parsed.episodes.iter().find(|episode| episode.title == "在线音频").unwrap().id.clone();
  let second = parsed.episodes.iter().find(|episode| episode.title == "离线音频").unwrap().id.clone();
  for episode in &mut parsed.episodes { episode.enclosure_url = format!("http://127.0.0.1:{}/audio.wav", options.port); }
  let db = directory.join("zone.sqlite");
  crate::podcast::store_subscription(&db, parsed).unwrap();
  let local = directory.join("podcast-downloads").join(format!("{second}.wav"));
  if options.phase != "full-disk" { fs::write(&local, wav.as_ref()).unwrap(); }
  if matches!(options.phase.as_str(), "short" | "soak" | "crash-playback" | "suspend") {
    crate::podcast::open_database(&db).unwrap().execute_batch("DELETE FROM podcast_progress; DELETE FROM podcast_queue;").unwrap();
  }
  if options.phase != "full-disk" {
    crate::podcast::open_database(&db).unwrap().execute("INSERT INTO podcast_downloads (episode_id, local_path, state, downloaded_bytes, updated_at) VALUES (?1, ?2, 'downloaded', ?3, 1) ON CONFLICT(episode_id) DO UPDATE SET local_path=excluded.local_path, state='downloaded'", rusqlite::params![second, local.to_string_lossy(), wav.len() as i64]).unwrap();
  }
  let script = include_str!("podcastStability.js").replace("__STREAM_ID__", &first).replace("__LOCAL_ID__", &second);
  let profile = options.webview_directory.clone().unwrap_or_else(|| directory.join("webview"));
  let mut context = tauri::generate_context!();
  context.config_mut().identifier = "com.zone.player.podcast.stability".into(); context.config_mut().app.windows.clear();
  let switch_budget = options.cycles as u64 * options.switch_rounds.unwrap_or(1) as u64 * 100 + 150_000;
  let timeout = options.duration_ms.max(120_000).max(switch_budget) + 300_000;
  let audio_hash = Sha256::digest(wav.as_ref()).to_vec();
  tauri::Builder::default().manage(state).manage(Fixture { directory, mode, requests, audio_hash })
    .invoke_handler(tauri::generate_handler![stability_config, stability_network, stability_record, stability_download, stability_disk, stability_release_reserve,
      crate::podcast::podcast_list_queue, crate::podcast::podcast_get_episode_detail, crate::podcast::podcast_save_progress,
      crate::podcast::podcast_load_active_episode, crate::podcast::podcast_save_active_episode,
      crate::podcast::podcast_queue_remove, crate::podcast::podcast_queue_add, crate::podcast::podcast_queue_clear])
    .register_uri_scheme_protocol("zone-stability", |_ctx, _request| tauri::http::Response::builder().header("Content-Type", "text/html")
      .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; media-src 'self' http://zone-audio.localhost http://zone-podcast.localhost; connect-src 'self' http://zone-audio.localhost http://zone-podcast.localhost")
      .body(b"<!doctype html><html><body></body></html>".to_vec()).unwrap())
    .register_asynchronous_uri_scheme_protocol("zone-podcast", |ctx, request, responder| {
      let state = ctx.app_handle().state::<crate::podcast::PodcastState>().inner().clone();
      tauri::async_runtime::spawn(async move { responder.respond(crate::podcast::stream_protocol::serve_podcast_stream_protocol_with_network_policy(state, request, true).await); });
    })
    .register_asynchronous_uri_scheme_protocol("zone-audio", |_ctx, request, responder| {
      tauri::async_runtime::spawn_blocking(move || responder.respond(crate::audio_protocol::serve_audio_protocol_with_cache(request, None)));
    })
    .setup(move |app| {
      tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::CustomProtocol("zone-stability://localhost/".parse().unwrap()))
        .title("Zone 播客稳定性测试").visible(false).inner_size(1180.0, 760.0)
        .data_directory(profile)
        .additional_browser_args("--autoplay-policy=no-user-gesture-required").initialization_script(&script).build()?;
      let handle = app.handle().clone(); std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(timeout)); handle.exit(2); });
      Ok(())
    }).run(context).unwrap();
}

#[tauri::command]
fn stability_config(state: tauri::State<'_, Fixture>) -> Config { config(&state.directory) }
#[tauri::command]
fn stability_network(state: tauri::State<'_, Fixture>, mode: u8) { state.mode.store(mode, Ordering::Relaxed); }
#[tauri::command]
fn stability_record(app: tauri::AppHandle, state: tauri::State<'_, Fixture>, value: serde_json::Value) -> Result<(), String> {
  let mut record = value.clone(); record["requests"] = state.requests.load(Ordering::Relaxed).into();
  if value["kind"] == "result" {
    let connection = crate::podcast::open_database(&state.directory.join("zone.sqlite"))?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    record["databaseIntegrity"] = integrity.clone().into();
    if integrity != "ok" { record["ok"] = false.into(); record["error"] = "database integrity check failed".into(); }
  }
  let line = serde_json::to_string(&record).unwrap();
  OpenOptions::new().create(true).append(true).open(state.directory.join("events.jsonl")).and_then(|mut file| writeln!(file, "{line}")).map_err(|error| error.to_string())?;
  if value["kind"] == "checkpoint" { fs::write(state.directory.join("checkpoint.json"), &line).map_err(|error| error.to_string())?; }
  if value["kind"] == "result" {
    fs::write(state.directory.join("result.json"), &line).map_err(|error| error.to_string())?;
    app.exit(if record["ok"] == true { 0 } else { 1 });
  }
  Ok(())
}
#[tauri::command]
async fn stability_download(state: tauri::State<'_, Fixture>, episode_id: String) -> Result<crate::podcast::PodcastDownloadResult, String> {
  let db = state.directory.join("zone.sqlite"); let downloads = state.directory.join("podcast-downloads");
  let active = crate::podcast::episode_file_operations(&db)?;
  let _guard = crate::podcast::EpisodeFileGuard::acquire(&active, &episode_id)?;
  let source = crate::podcast::load_episode_download_source(&db, &episode_id)?;
  let result = crate::podcast::download_episode_with_network_policy(&db, &downloads, &episode_id, &source.enclosure_url, source.enclosure_type.as_deref(), true).await;
  if let Err(error) = &result {
    let length = fs::metadata(downloads.join(format!("{episode_id}.part"))).map(|metadata| metadata.len()).unwrap_or(0);
    let _ = crate::podcast::mark_download_failed_for_source(&db, &episode_id, &source.enclosure_url, length, error);
  }
  if let Ok(download) = &result {
    let bytes = fs::read(&download.local_path).map_err(|error| error.to_string())?;
    if Sha256::digest(&bytes).as_slice() != state.audio_hash.as_slice() { return Err("completed download differs from source audio".into()); }
  }
  result
}
#[tauri::command]
fn stability_disk(state: tauri::State<'_, Fixture>, fill: bool) -> Result<(), String> {
  let options = config(&state.directory);
  let root = state.directory.parent().ok_or("missing test volume")?;
  if !options.allow_disk_full || !root.join("zone-stability-disposable-volume.marker").is_file() { return Err("disk fill requires a marked disposable test volume".into()); }
  let filler = root.join("zone-stability-filler.bin");
  if !fill { return fs::remove_file(filler).map_err(|error| error.to_string()); }
  let reserve = root.join("zone-stability-reserve.bin");
  fs::write(&reserve, vec![0u8; 2 * 1024 * 1024]).map_err(|error| error.to_string())?;
  let connection = crate::podcast::open_database(&state.directory.join("zone.sqlite"))?;
  let busy: i64 = connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0)).map_err(|error| error.to_string())?;
  if busy != 0 { return Err("test database checkpoint is busy".into()); }
  let mut file = fs::File::create(&filler).map_err(|error| error.to_string())?;
  let block = [0u8; 64 * 1024]; let mut bytes = 0;
  loop {
    match file.write_all(&block) { Ok(()) => { bytes += block.len(); }, Err(error) if matches!(error.raw_os_error(), Some(28 | 112)) => break, Err(error) => return Err(error.to_string()) }
    if bytes > 128 * 1024 * 1024 { return Err("test volume exceeds the safety limit".into()); }
  }
  // Exhaust the final allocation units; a rejected 64 KiB write may leave room
  // for a SQLite journal page, especially after a new settings row was added.
  for block in [vec![0u8; 4096], vec![0u8; 1]] {
    loop {
      match file.write_all(&block) {
        Ok(()) => bytes += block.len(),
        Err(error) if matches!(error.raw_os_error(), Some(28 | 112)) => break,
        Err(error) => return Err(error.to_string()),
      }
      if bytes > 128 * 1024 * 1024 { return Err("test volume exceeds the safety limit".into()); }
    }
  }
  drop(file); Ok(())
}

#[tauri::command]
fn stability_release_reserve(state: tauri::State<'_, Fixture>) -> Result<(), String> {
  let root = state.directory.parent().ok_or("missing test volume")?;
  if !config(&state.directory).allow_disk_full || !root.join("zone-stability-disposable-volume.marker").is_file() { return Err("unmarked test volume".into()); }
  fs::remove_file(root.join("zone-stability-reserve.bin")).map_err(|error| error.to_string())
}
