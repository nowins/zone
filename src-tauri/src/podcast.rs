use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use feed_rs::model::{Entry as ParsedEntry, Feed as ParsedFeed};
use reqwest::header::{self, HeaderMap};
use reqwest::{StatusCode, Url};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::http::{Method, Request, Response};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const APPLE_SEARCH_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const APPLE_DISCOVERY_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const APPLE_DISCOVERY_MAX_RESULTS: u8 = 50;
const PODCAST_FEED_RESPONSE_LIMIT: usize = 20 * 1024 * 1024;
const PODCAST_ARTWORK_RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const PODCAST_ARTWORK_URL_LIMIT: usize = 4 * 1024;
const PODCAST_ARTWORK_TOKEN_LIMIT: usize = 6 * 1024;
const PODCAST_AUDIO_RESPONSE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const PODCAST_STREAM_CHUNK_SIZE: u64 = 1024 * 1024;
const PODCAST_REDIRECT_LIMIT: usize = 5;
const PODCAST_DESCRIPTION_LIMIT: usize = 20_000;
const PODCAST_TITLE_LIMIT: usize = 500;
const PODCAST_STREAM_TIMEOUT: Duration = Duration::from_secs(60);
const PODCAST_ARTWORK_TIMEOUT: Duration = Duration::from_secs(30);
const PODCAST_HOME_CONTINUE_LIMIT: usize = 12;
const PODCAST_HOME_LATEST_LIMIT: usize = 40;
const PODCAST_HOME_DOWNLOADED_LIMIT: usize = 40;
const PODCAST_HOME_SAVED_LIMIT: usize = 40;
const PODCAST_QUEUE_LIMIT: usize = 500;
const USER_AGENT: &str = "Zone/0.1 (local podcast player)";

#[derive(Clone, Debug)]
pub struct PodcastState {
  db_path: PathBuf,
  downloads_dir: PathBuf,
  active_downloads: Arc<Mutex<HashSet<String>>>,
  initialization_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastSearchResult {
  id: String,
  title: String,
  author: String,
  feed_url: String,
  artwork_url: Option<String>,
  episode_count: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDiscoveryShow {
  id: String,
  title: String,
  author: String,
  feed_url: String,
  artwork_url: Option<String>,
  genres: Vec<String>,
  rank: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastFeed {
  id: String,
  feed_url: String,
  title: String,
  author: Option<String>,
  description: Option<String>,
  artwork_url: Option<String>,
  last_fetched_at: i64,
  subscribed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastEpisode {
  id: String,
  feed_id: String,
  title: String,
  description: Option<String>,
  published_at: Option<i64>,
  duration_seconds: Option<f64>,
  enclosure_url: String,
  enclosure_type: Option<String>,
  artwork_url: Option<String>,
  download_state: String,
  local_path: Option<String>,
  downloaded_bytes: u64,
  total_bytes: Option<u64>,
  progress_seconds: f64,
  completed: bool,
  feed_title: Option<String>,
  feed_artwork_url: Option<String>,
  saved: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastEpisodeDetail {
  episode: PodcastEpisode,
  feed: PodcastFeed,
  expected_bytes: Option<u64>,
  download_error: Option<String>,
  saved: bool,
  saved_at: Option<i64>,
  queue_position: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastQueueItem {
  episode: PodcastEpisode,
  position: u32,
  added_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastHome {
  continue_listening: Vec<PodcastEpisode>,
  latest_episodes: Vec<PodcastEpisode>,
  downloaded_episodes: Vec<PodcastEpisode>,
  saved_episodes: Vec<PodcastEpisode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastSubscribeResult {
  feed: PodcastFeed,
  episode_count: usize,
  inserted_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDownloadResult {
  episode_id: String,
  local_path: String,
  downloaded_bytes: u64,
  resumed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleSearchResponse {
  results: Vec<AppleSearchItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleSearchItem {
  collection_id: Option<i64>,
  collection_name: Option<String>,
  artist_name: Option<String>,
  feed_url: Option<String>,
  artwork_url_600: Option<String>,
  artwork_url_100: Option<String>,
  track_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct AppleDiscoveryResponse {
  feed: AppleDiscoveryFeed,
}

#[derive(Debug, Deserialize)]
struct AppleDiscoveryFeed {
  results: Vec<AppleDiscoveryItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleDiscoveryItem {
  id: String,
  name: String,
  artist_name: String,
  artwork_url_100: Option<String>,
  #[serde(default)]
  genres: Vec<AppleDiscoveryGenre>,
}

#[derive(Debug, Deserialize)]
struct AppleDiscoveryGenre {
  name: String,
}

#[derive(Clone, Debug)]
struct ParsedPodcast {
  feed: PodcastFeed,
  episodes: Vec<ParsedPodcastEpisode>,
  etag: Option<String>,
  last_modified: Option<String>,
}

#[derive(Clone, Debug)]
struct ParsedPodcastEpisode {
  id: String,
  feed_id: String,
  identity_key: String,
  guid: Option<String>,
  title: String,
  description: Option<String>,
  published_at: Option<i64>,
  duration_seconds: Option<f64>,
  enclosure_url: String,
  enclosure_type: Option<String>,
  artwork_url: Option<String>,
  expected_bytes: Option<u64>,
}

#[derive(Debug)]
struct EpisodeDownloadSource {
  enclosure_url: String,
  enclosure_type: Option<String>,
  local_path: Option<String>,
  downloaded_bytes: u64,
}

struct PublicResponse {
  final_url: Url,
  response: reqwest::Response,
}

struct EpisodeFileGuard {
  episode_id: String,
  active_downloads: Arc<Mutex<HashSet<String>>>,
}

impl EpisodeFileGuard {
  fn acquire(active_downloads: &Arc<Mutex<HashSet<String>>>, episode_id: &str) -> Result<Self, String> {
    let mut active = active_downloads
      .lock()
      .map_err(|_| "播客下载状态不可用".to_string())?;
    if !active.insert(episode_id.to_string()) {
      return Err("该播客单集正在下载或清理".to_string());
    }
    drop(active);
    Ok(Self {
      episode_id: episode_id.to_string(),
      active_downloads: active_downloads.clone(),
    })
  }
}

impl Drop for EpisodeFileGuard {
  fn drop(&mut self) {
    if let Ok(mut active) = self.active_downloads.lock() {
      active.remove(&self.episode_id);
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PodcastStreamRange {
  Bounded { start: u64, end: u64 },
  Suffix { length: u64 },
}

impl PodcastState {
  pub fn initialize(app: &AppHandle) -> Result<Self, String> {
    let app_data_dir = app
      .path()
      .app_data_dir()
      .map_err(|error| format!("无法定位播客数据目录：{error}"))?;
    Self::initialize_at(&app_data_dir)
  }

  fn initialize_at(app_data_dir: &Path) -> Result<Self, String> {
    fs::create_dir_all(app_data_dir).map_err(|error| format!("无法创建播客数据目录：{error}"))?;
    let downloads_dir = app_data_dir.join("podcast-downloads");
    fs::create_dir_all(&downloads_dir).map_err(|error| format!("无法创建播客下载目录：{error}"))?;
    let db_path = app_data_dir.join("podcasts.sqlite");
    let _ = open_database(&db_path)?;
    Ok(Self {
      db_path,
      downloads_dir,
      active_downloads: Arc::new(Mutex::new(HashSet::new())),
      initialization_error: None,
    })
  }

  pub fn unavailable(error: String) -> Self {
    Self {
      db_path: PathBuf::new(),
      downloads_dir: PathBuf::new(),
      active_downloads: Arc::new(Mutex::new(HashSet::new())),
      initialization_error: Some(error),
    }
  }

  fn ensure_ready(&self) -> Result<(), String> {
    if let Some(error) = self.initialization_error.as_deref() {
      Err(format!("播客功能初始化失败：{error}"))
    } else {
      Ok(())
    }
  }
}

#[tauri::command]
pub async fn podcast_search_apple(query: String, limit: Option<u8>) -> Result<Vec<PodcastSearchResult>, String> {
  search_apple_cn(&query, limit.unwrap_or(12)).await
}

#[tauri::command]
pub async fn podcast_browse_apple(limit: Option<u8>) -> Result<Vec<PodcastDiscoveryShow>, String> {
  browse_apple_cn(limit.unwrap_or(24)).await
}

#[tauri::command]
pub async fn podcast_subscribe(
  state: State<'_, PodcastState>,
  feed_url: String,
  title_hint: Option<String>,
  author_hint: Option<String>,
  artwork_url: Option<String>,
) -> Result<PodcastSubscribeResult, String> {
  state.ensure_ready()?;
  let parsed = fetch_and_parse_feed(
    &feed_url,
    title_hint.as_deref(),
    author_hint.as_deref(),
    artwork_url.as_deref(),
  )
  .await?;
  let db_path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || store_subscription(&db_path, parsed))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_preview_feed(
  state: State<'_, PodcastState>,
  feed_url: String,
  title_hint: Option<String>,
  author_hint: Option<String>,
  artwork_url: Option<String>,
) -> Result<PodcastSubscribeResult, String> {
  state.ensure_ready()?;
  let parsed = fetch_and_parse_feed(
    &feed_url,
    title_hint.as_deref(),
    author_hint.as_deref(),
    artwork_url.as_deref(),
  )
  .await?;
  let db_path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || store_preview(&db_path, parsed))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_list_feeds(state: State<'_, PodcastState>) -> Result<Vec<PodcastFeed>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || list_feeds(&db_path))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_set_following(
  state: State<'_, PodcastState>,
  feed_id: String,
  following: bool,
) -> Result<(), String> {
  state.ensure_ready()?;
  validate_identifier(&feed_id)?;
  let db_path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || set_following(&db_path, &feed_id, following))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_list_home(state: State<'_, PodcastState>) -> Result<PodcastHome, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || list_home(&db_path, &downloads_dir))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_list_episodes(
  state: State<'_, PodcastState>,
  feed_id: String,
) -> Result<Vec<PodcastEpisode>, String> {
  state.ensure_ready()?;
  validate_identifier(&feed_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || list_episodes(&db_path, &downloads_dir, &feed_id))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_get_episode_detail(
  state: State<'_, PodcastState>,
  episode_id: String,
) -> Result<PodcastEpisodeDetail, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || get_episode_detail(&db_path, &downloads_dir, &episode_id))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_set_episode_saved(
  state: State<'_, PodcastState>,
  episode_id: String,
  saved: bool,
) -> Result<PodcastEpisodeDetail, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    set_episode_saved(&db_path, &episode_id, saved)?;
    get_episode_detail(&db_path, &downloads_dir, &episode_id)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_list_saved_episodes(
  state: State<'_, PodcastState>,
) -> Result<Vec<PodcastEpisodeDetail>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || list_saved_episodes(&db_path, &downloads_dir))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_set_episode_played(
  state: State<'_, PodcastState>,
  episode_id: String,
  played: bool,
) -> Result<PodcastEpisodeDetail, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    set_episode_played(&db_path, &episode_id, played)?;
    get_episode_detail(&db_path, &downloads_dir, &episode_id)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_list_queue(state: State<'_, PodcastState>) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || list_queue(&db_path, &downloads_dir))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_queue_add(
  state: State<'_, PodcastState>,
  episode_id: String,
  play_next: bool,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    queue_add(&db_path, &episode_id, play_next)?;
    list_queue(&db_path, &downloads_dir)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_queue_remove(
  state: State<'_, PodcastState>,
  episode_id: String,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    queue_remove(&db_path, &episode_id)?;
    list_queue(&db_path, &downloads_dir)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_queue_reorder(
  state: State<'_, PodcastState>,
  episode_ids: Vec<String>,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  validate_queue_identifiers(&episode_ids)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    queue_reorder(&db_path, &episode_ids)?;
    list_queue(&db_path, &downloads_dir)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_queue_clear(state: State<'_, PodcastState>) -> Result<(), String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || queue_clear(&db_path))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_download_episode(
  state: State<'_, PodcastState>,
  episode_id: String,
) -> Result<PodcastDownloadResult, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let _file_guard = EpisodeFileGuard::acquire(&state.active_downloads, &episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  let source_id = episode_id.clone();
  let source = tauri::async_runtime::spawn_blocking(move || load_episode_download_source(&db_path, &source_id))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))??;

  if let Some(local_path) = source.local_path.as_deref() {
    let path = PathBuf::from(local_path);
    if path.is_file() && is_managed_download_path(&downloads_dir, &episode_id, &path) {
      return Ok(PodcastDownloadResult {
        episode_id,
        local_path: path.to_string_lossy().to_string(),
        downloaded_bytes: source.downloaded_bytes,
        resumed: false,
      });
    }
  }

  let result = download_episode(
    &state.db_path,
    &downloads_dir,
    &episode_id,
    &source.enclosure_url,
    source.enclosure_type.as_deref(),
  )
  .await;

  if let Err(error) = &result {
    let db_path = state.db_path.clone();
    let failed_id = episode_id.clone();
    let part_path = downloads_dir.join(format!("{episode_id}.part"));
    let downloaded_bytes = tokio::fs::metadata(&part_path)
      .await
      .map(|metadata| metadata.len())
      .unwrap_or(0);
    let message = error.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
      mark_download_failed(&db_path, &failed_id, downloaded_bytes, &message)
    })
    .await;
  }

  result
}

#[tauri::command]
pub async fn podcast_delete_episode_download(
  state: State<'_, PodcastState>,
  episode_id: String,
) -> Result<PodcastEpisodeDetail, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let _file_guard = EpisodeFileGuard::acquire(&state.active_downloads, &episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    delete_episode_download(&db_path, &downloads_dir, &episode_id)?;
    get_episode_detail(&db_path, &downloads_dir, &episode_id)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_save_progress(
  state: State<'_, PodcastState>,
  episode_id: String,
  position_seconds: f64,
  duration_seconds: f64,
) -> Result<(), String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  if !position_seconds.is_finite() || !duration_seconds.is_finite() || position_seconds < 0.0 || duration_seconds < 0.0
  {
    return Err("播客播放进度无效".to_string());
  }
  let db_path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || save_progress(&db_path, &episode_id, position_seconds, duration_seconds))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

pub async fn serve_podcast_artwork_protocol(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
  serve_podcast_artwork_protocol_with_network_policy(request, false).await
}

async fn serve_podcast_artwork_protocol_with_network_policy(
  request: Request<Vec<u8>>,
  allow_private_network: bool,
) -> Response<Vec<u8>> {
  if request.method() == Method::OPTIONS {
    return podcast_artwork_response_builder(StatusCode::NO_CONTENT, "text/plain", 0)
      .body(Vec::new())
      .unwrap();
  }
  if !matches!(*request.method(), Method::GET | Method::HEAD) {
    return podcast_artwork_text_response(StatusCode::METHOD_NOT_ALLOWED, "unsupported podcast artwork method");
  }

  let url = match decode_podcast_artwork_url(&request, allow_private_network) {
    Ok(url) => url,
    Err(error) => return podcast_artwork_text_response(StatusCode::BAD_REQUEST, &error),
  };
  let public_response = match send_public_get_with_policy(
    url,
    PODCAST_ARTWORK_TIMEOUT,
    None,
    allow_private_network,
  )
  .await
  {
    Ok(response) => response,
    Err(error) => return podcast_artwork_text_response(StatusCode::BAD_GATEWAY, &error),
  };
  let content_type = match podcast_artwork_content_type(public_response.response.headers()) {
    Ok(content_type) => content_type,
    Err(error) => return podcast_artwork_text_response(StatusCode::BAD_GATEWAY, &error),
  };
  let bytes = match read_limited(
    public_response.response,
    PODCAST_ARTWORK_RESPONSE_LIMIT,
    "播客封面",
  )
  .await
  {
    Ok(bytes) => bytes,
    Err(error) => return podcast_artwork_text_response(StatusCode::BAD_GATEWAY, &error),
  };
  if !podcast_artwork_magic_matches(&content_type, &bytes) {
    return podcast_artwork_text_response(StatusCode::BAD_GATEWAY, "播客封面内容格式无效");
  }

  let content_length = bytes.len() as u64;
  let body = if request.method() == Method::HEAD {
    Vec::new()
  } else {
    bytes
  };
  podcast_artwork_response_builder(StatusCode::OK, &content_type, content_length)
    .body(body)
    .unwrap()
}

fn decode_podcast_artwork_url(
  request: &Request<Vec<u8>>,
  allow_private_network: bool,
) -> Result<Url, String> {
  if request.uri().query().is_some() {
    return Err("播客封面地址无效".to_string());
  }
  let token = request.uri().path().trim_matches('/');
  if token.is_empty() || token.len() > PODCAST_ARTWORK_TOKEN_LIMIT || token.contains('/') {
    return Err("播客封面地址无效".to_string());
  }
  let bytes = URL_SAFE_NO_PAD
    .decode(token)
    .map_err(|_| "播客封面地址无效".to_string())?;
  if bytes.is_empty() || bytes.len() > PODCAST_ARTWORK_URL_LIMIT {
    return Err("播客封面地址无效".to_string());
  }
  let value = String::from_utf8(bytes).map_err(|_| "播客封面地址无效".to_string())?;
  validate_url_shape_with_policy(&value, allow_private_network)
}

fn podcast_artwork_content_type(headers: &HeaderMap) -> Result<String, String> {
  let value = header_text(headers, header::CONTENT_TYPE)
    .ok_or_else(|| "播客封面响应缺少图片类型".to_string())?;
  let value = value
    .split(';')
    .next()
    .unwrap_or_default()
    .trim()
    .to_ascii_lowercase();
  let normalized = match value.as_str() {
    "image/jpeg" | "image/jpg" | "image/pjpeg" => "image/jpeg",
    "image/png" | "image/x-png" => "image/png",
    "image/gif" => "image/gif",
    "image/webp" => "image/webp",
    "image/avif" => "image/avif",
    "image/bmp" => "image/bmp",
    "image/x-icon" | "image/vnd.microsoft.icon" => "image/x-icon",
    _ => return Err("播客封面来源返回了不支持的图片类型".to_string()),
  };
  Ok(normalized.to_string())
}

fn podcast_artwork_magic_matches(content_type: &str, bytes: &[u8]) -> bool {
  match content_type {
    "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
    "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
    "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
    "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
    "image/avif" => {
      bytes.get(4..12).is_some_and(|value| value == b"ftypavif")
        || bytes.get(4..12).is_some_and(|value| value == b"ftypavis")
    }
    "image/bmp" => bytes.starts_with(b"BM"),
    "image/x-icon" => bytes.starts_with(&[0, 0, 1, 0]),
    _ => false,
  }
}

fn podcast_artwork_response_builder(
  status: StatusCode,
  content_type: &str,
  content_length: u64,
) -> tauri::http::response::Builder {
  Response::builder()
    .status(status)
    .header(header::CONTENT_TYPE, content_type)
    .header(header::CONTENT_LENGTH, content_length.to_string())
    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
    .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Content-Type")
    .header(header::CACHE_CONTROL, "private, max-age=3600")
    .header("Cross-Origin-Resource-Policy", "cross-origin")
    .header("X-Content-Type-Options", "nosniff")
}

fn podcast_artwork_text_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
  podcast_artwork_response_builder(status, "text/plain; charset=utf-8", message.len() as u64)
    .body(message.as_bytes().to_vec())
    .unwrap()
}

pub async fn serve_podcast_stream_protocol(
  state: PodcastState,
  request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
  serve_podcast_stream_protocol_with_network_policy(state, request, false).await
}

async fn serve_podcast_stream_protocol_with_network_policy(
  state: PodcastState,
  request: Request<Vec<u8>>,
  allow_private_network: bool,
) -> Response<Vec<u8>> {
  if request.method() == Method::OPTIONS {
    return podcast_stream_response_builder(StatusCode::NO_CONTENT, "text/plain", 0)
      .body(Vec::new())
      .unwrap();
  }
  if !matches!(*request.method(), Method::GET | Method::HEAD) {
    return podcast_stream_text_response(StatusCode::METHOD_NOT_ALLOWED, "unsupported podcast stream method");
  }
  if let Err(error) = state.ensure_ready() {
    return podcast_stream_text_response(StatusCode::SERVICE_UNAVAILABLE, &error);
  }

  let episode_id = match podcast_stream_episode_id(&request) {
    Ok(episode_id) => episode_id,
    Err(error) => return podcast_stream_text_response(StatusCode::BAD_REQUEST, &error),
  };
  let db_path = state.db_path.clone();
  let source_id = episode_id.clone();
  let source = match tauri::async_runtime::spawn_blocking(move || {
    load_episode_download_source(&db_path, &source_id)
  })
  .await
  {
    Ok(Ok(source)) => source,
    Ok(Err(error)) if error == "播客单集不存在" => {
      return podcast_stream_text_response(StatusCode::NOT_FOUND, &error);
    }
    Ok(Err(error)) => return podcast_stream_text_response(StatusCode::INTERNAL_SERVER_ERROR, &error),
    Err(error) => {
      return podcast_stream_text_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        &format!("播客数据任务异常结束：{error}"),
      );
    }
  };

  let is_head = request.method() == Method::HEAD;
  let requested_range = if is_head {
    Ok(PodcastStreamRange::Bounded { start: 0, end: 0 })
  } else {
    match request.headers().get(header::RANGE) {
      Some(value) => value
        .to_str()
        .map_err(|_| "播客播放范围无效".to_string())
        .and_then(|value| parse_podcast_stream_range(Some(value))),
      None => parse_podcast_stream_range(None),
    }
  };
  let requested_range = match requested_range {
    Ok(range) => range,
    Err(_) => return podcast_stream_range_not_satisfiable(None),
  };
  let url = match validate_url_shape_with_policy(&source.enclosure_url, allow_private_network) {
    Ok(url) => url,
    Err(error) => return podcast_stream_text_response(StatusCode::BAD_GATEWAY, &error),
  };
  let upstream_range = requested_range.to_header_value();
  let public_response = match send_public_get_with_policy(
    url,
    PODCAST_STREAM_TIMEOUT,
    Some(&upstream_range),
    allow_private_network,
  )
  .await
  {
    Ok(response) => response,
    Err(error) => return podcast_stream_text_response(StatusCode::BAD_GATEWAY, &error),
  };

  proxy_podcast_stream_response(
    public_response.response,
    source.enclosure_type.as_deref(),
    requested_range,
    is_head,
  )
  .await
}

async fn proxy_podcast_stream_response(
  response: reqwest::Response,
  enclosure_type: Option<&str>,
  requested_range: PodcastStreamRange,
  is_head: bool,
) -> Response<Vec<u8>> {
  let status = response.status();
  if status == StatusCode::RANGE_NOT_SATISFIABLE {
    let total = header_text(response.headers(), header::CONTENT_RANGE)
      .and_then(|value| parse_unsatisfied_content_range(&value))
      .filter(|total| *total <= PODCAST_AUDIO_RESPONSE_LIMIT);
    return podcast_stream_range_not_satisfiable(total);
  }
  if !matches!(status, StatusCode::OK | StatusCode::PARTIAL_CONTENT) {
    return podcast_stream_text_response(
      StatusCode::BAD_GATEWAY,
      &format!("播客音频来源返回错误 {}", status.as_u16()),
    );
  }

  let content_type = match podcast_stream_content_type(response.headers(), enclosure_type) {
    Ok(content_type) => content_type,
    Err(error) => return podcast_stream_text_response(StatusCode::BAD_GATEWAY, &error),
  };

  if status == StatusCode::PARTIAL_CONTENT {
    let content_range = match header_text(response.headers(), header::CONTENT_RANGE)
      .and_then(|value| parse_content_range(&value))
    {
      Some((start, end, Some(total))) => (start, end, total),
      _ => {
        return podcast_stream_text_response(
          StatusCode::BAD_GATEWAY,
          "播客音频范围响应缺少完整长度",
        );
      }
    };
    let (start, end, total) = content_range;
    if total == 0 || total > PODCAST_AUDIO_RESPONSE_LIMIT {
      return podcast_stream_text_response(StatusCode::BAD_GATEWAY, "播客音频超过大小限制");
    }
    if !requested_range.matches_response(start, end, total) {
      return podcast_stream_text_response(StatusCode::BAD_GATEWAY, "播客音频范围响应与请求不一致");
    }
    let expected_length = end.saturating_sub(start).saturating_add(1);
    if expected_length == 0 || expected_length > PODCAST_STREAM_CHUNK_SIZE {
      return podcast_stream_text_response(StatusCode::BAD_GATEWAY, "播客音频范围响应超过大小限制");
    }

    if is_head {
      return podcast_stream_response_builder(StatusCode::OK, &content_type, total)
        .body(Vec::new())
        .unwrap();
    }
    let body = match read_exact_stream_body(response, expected_length).await {
      Ok(body) => body,
      Err(error) => return podcast_stream_text_response(StatusCode::BAD_GATEWAY, &error),
    };
    return podcast_stream_response_builder(StatusCode::PARTIAL_CONTENT, &content_type, expected_length)
      .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
      .body(body)
      .unwrap();
  }

  let Some(total) = response.content_length() else {
    return podcast_stream_text_response(
      StatusCode::BAD_GATEWAY,
      "播客音频来源不支持范围请求且未提供长度",
    );
  };
  if total == 0 || total > PODCAST_AUDIO_RESPONSE_LIMIT {
    return podcast_stream_text_response(StatusCode::BAD_GATEWAY, "播客音频超过大小限制");
  }
  if is_head {
    return podcast_stream_response_builder(StatusCode::OK, &content_type, total)
      .body(Vec::new())
      .unwrap();
  }
  if !matches!(requested_range, PodcastStreamRange::Bounded { start: 0, .. })
    || total > PODCAST_STREAM_CHUNK_SIZE
  {
    return podcast_stream_text_response(
      StatusCode::BAD_GATEWAY,
      "播客音频来源不支持范围播放",
    );
  }
  let body = match read_exact_stream_body(response, total).await {
    Ok(body) => body,
    Err(error) => return podcast_stream_text_response(StatusCode::BAD_GATEWAY, &error),
  };
  podcast_stream_response_builder(StatusCode::OK, &content_type, total)
    .body(body)
    .unwrap()
}

impl PodcastStreamRange {
  fn to_header_value(self) -> String {
    match self {
      Self::Bounded { start, end } => format!("bytes={start}-{end}"),
      Self::Suffix { length } => format!("bytes=-{length}"),
    }
  }

  fn matches_response(self, start: u64, end: u64, total: u64) -> bool {
    match self {
      Self::Bounded {
        start: requested_start,
        end: requested_end,
      } => start == requested_start && end <= requested_end,
      Self::Suffix { length } => {
        let expected_start = total.saturating_sub(length.min(total));
        start == expected_start && end == total.saturating_sub(1)
      }
    }
  }
}

fn podcast_stream_episode_id(request: &Request<Vec<u8>>) -> Result<String, String> {
  if request.uri().query().is_some() {
    return Err("播客流地址无效".to_string());
  }
  let episode_id = request.uri().path().trim_matches('/');
  if episode_id.contains('/') {
    return Err("播客流地址无效".to_string());
  }
  validate_identifier(episode_id)?;
  Ok(episode_id.to_string())
}

fn parse_podcast_stream_range(value: Option<&str>) -> Result<PodcastStreamRange, String> {
  let Some(value) = value else {
    return Ok(PodcastStreamRange::Bounded {
      start: 0,
      end: PODCAST_STREAM_CHUNK_SIZE - 1,
    });
  };
  let value = value.strip_prefix("bytes=").ok_or_else(|| "播客播放范围无效".to_string())?;
  if value.contains(',') {
    return Err("播客播放不支持多段范围".to_string());
  }
  let (start_text, end_text) = value
    .split_once('-')
    .ok_or_else(|| "播客播放范围无效".to_string())?;
  if start_text.is_empty() {
    let length = end_text.parse::<u64>().map_err(|_| "播客播放范围无效".to_string())?;
    if length == 0 {
      return Err("播客播放范围无效".to_string());
    }
    return Ok(PodcastStreamRange::Suffix {
      length: length.min(PODCAST_STREAM_CHUNK_SIZE),
    });
  }

  let start = start_text.parse::<u64>().map_err(|_| "播客播放范围无效".to_string())?;
  if start >= PODCAST_AUDIO_RESPONSE_LIMIT {
    return Err("播客播放范围超出限制".to_string());
  }
  let requested_end = if end_text.is_empty() {
    PODCAST_AUDIO_RESPONSE_LIMIT - 1
  } else {
    end_text.parse::<u64>().map_err(|_| "播客播放范围无效".to_string())?
  };
  if requested_end < start {
    return Err("播客播放范围无效".to_string());
  }
  let end = requested_end
    .min(start.saturating_add(PODCAST_STREAM_CHUNK_SIZE - 1))
    .min(PODCAST_AUDIO_RESPONSE_LIMIT - 1);
  Ok(PodcastStreamRange::Bounded { start, end })
}

async fn read_exact_stream_body(mut response: reqwest::Response, expected_length: u64) -> Result<Vec<u8>, String> {
  if expected_length > PODCAST_STREAM_CHUNK_SIZE {
    return Err("播客音频范围响应超过大小限制".to_string());
  }
  if response
    .content_length()
    .is_some_and(|length| length != expected_length)
  {
    return Err("播客音频范围响应长度不一致".to_string());
  }
  let mut body = Vec::with_capacity(expected_length as usize);
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|error| format!("无法读取播客音频响应：{error}"))?
  {
    if body.len().saturating_add(chunk.len()) > expected_length as usize {
      return Err("播客音频范围响应长度不一致".to_string());
    }
    body.extend_from_slice(&chunk);
  }
  if body.len() as u64 != expected_length {
    return Err("播客音频范围响应长度不一致".to_string());
  }
  Ok(body)
}

fn podcast_stream_content_type(headers: &HeaderMap, enclosure_type: Option<&str>) -> Result<String, String> {
  let response_type = header_text(headers, header::CONTENT_TYPE);
  if !response_content_type_is_audio_candidate(response_type.as_deref(), enclosure_type) {
    return Err("播客音频来源返回了非音频内容".to_string());
  }
  let candidate = response_type
    .as_deref()
    .or(enclosure_type)
    .unwrap_or("application/octet-stream")
    .split(';')
    .next()
    .unwrap_or_default()
    .trim()
    .to_ascii_lowercase();
  if candidate.is_empty() {
    Ok("application/octet-stream".to_string())
  } else {
    Ok(candidate)
  }
}

fn parse_unsatisfied_content_range(value: &str) -> Option<u64> {
  value.strip_prefix("bytes */")?.parse::<u64>().ok()
}

fn podcast_stream_response_builder(
  status: StatusCode,
  content_type: &str,
  content_length: u64,
) -> tauri::http::response::Builder {
  Response::builder()
    .status(status)
    .header(header::CONTENT_TYPE, content_type)
    .header(header::CONTENT_LENGTH, content_length.to_string())
    .header(header::ACCEPT_RANGES, "bytes")
    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
    .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range, Content-Type")
    .header(
      header::ACCESS_CONTROL_EXPOSE_HEADERS,
      "Content-Length, Content-Range, Accept-Ranges",
    )
    .header(header::CACHE_CONTROL, "no-store")
}

fn podcast_stream_text_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
  podcast_stream_response_builder(status, "text/plain; charset=utf-8", message.len() as u64)
    .body(message.as_bytes().to_vec())
    .unwrap()
}

fn podcast_stream_range_not_satisfiable(total: Option<u64>) -> Response<Vec<u8>> {
  let mut builder =
    podcast_stream_response_builder(StatusCode::RANGE_NOT_SATISFIABLE, "text/plain; charset=utf-8", 0);
  if let Some(total) = total {
    builder = builder.header(header::CONTENT_RANGE, format!("bytes */{total}"));
  }
  builder.body(Vec::new()).unwrap()
}

async fn search_apple_cn(query: &str, requested_limit: u8) -> Result<Vec<PodcastSearchResult>, String> {
  let query = query.trim();
  if query.is_empty() || query.chars().count() > 200 {
    return Err("播客搜索内容无效".to_string());
  }
  let limit = requested_limit.clamp(1, 25);
  let mut url = Url::parse("https://itunes.apple.com/search").map_err(|_| "无法构造 Apple 播客搜索地址".to_string())?;
  url
    .query_pairs_mut()
    .append_pair("country", "CN")
    .append_pair("media", "podcast")
    .append_pair("entity", "podcast")
    .append_pair("limit", &limit.to_string())
    .append_pair("term", query);

  let public_response = send_public_get(url, Duration::from_secs(15), None).await?;
  let bytes = read_limited(public_response.response, APPLE_SEARCH_RESPONSE_LIMIT, "Apple 播客搜索").await?;
  let response =
    serde_json::from_slice::<AppleSearchResponse>(&bytes).map_err(|_| "Apple 播客搜索结果格式无效".to_string())?;
  let mut results = Vec::new();
  for item in response.results {
    let Some(feed_url) = clean_optional(item.feed_url, 4_096) else {
      continue;
    };
    if validate_public_url_shape(&feed_url).is_err() {
      continue;
    }
    let title = clean_optional(item.collection_name, PODCAST_TITLE_LIMIT).unwrap_or_else(|| "未命名播客".to_string());
    let author = clean_optional(item.artist_name, PODCAST_TITLE_LIMIT).unwrap_or_default();
    let id = item
      .collection_id
      .map(|value| value.to_string())
      .unwrap_or_else(|| hash_identifier("apple", &[&feed_url]));
    results.push(PodcastSearchResult {
      id,
      title,
      author,
      feed_url,
      artwork_url: clean_optional(item.artwork_url_600.or(item.artwork_url_100), 4_096),
      episode_count: item.track_count,
    });
  }
  Ok(results)
}

async fn browse_apple_cn(requested_limit: u8) -> Result<Vec<PodcastDiscoveryShow>, String> {
  let limit = requested_limit.clamp(1, APPLE_DISCOVERY_MAX_RESULTS);
  let chart_url = Url::parse(&format!(
    "https://rss.marketingtools.apple.com/api/v2/cn/podcasts/top/{limit}/podcasts.json"
  ))
  .map_err(|_| "无法构造 Apple 播客榜单地址".to_string())?;
  let chart_response = send_public_get(chart_url, Duration::from_secs(15), None).await?;
  let chart_bytes = read_limited(
    chart_response.response,
    APPLE_DISCOVERY_RESPONSE_LIMIT,
    "Apple 播客榜单",
  )
  .await?;
  let chart = serde_json::from_slice::<AppleDiscoveryResponse>(&chart_bytes)
    .map_err(|_| "Apple 播客榜单格式无效".to_string())?;
  let ids = chart
    .feed
    .results
    .iter()
    .take(limit as usize)
    .filter_map(|item| valid_apple_catalog_id(&item.id))
    .collect::<Vec<_>>();
  if ids.is_empty() {
    return Err("Apple 播客榜单没有可用节目".to_string());
  }

  let mut lookup_url =
    Url::parse("https://itunes.apple.com/lookup").map_err(|_| "无法构造 Apple 播客查询地址".to_string())?;
  lookup_url
    .query_pairs_mut()
    .append_pair("country", "CN")
    .append_pair("id", &ids.join(","));
  let lookup_response = send_public_get(lookup_url, Duration::from_secs(15), None).await?;
  let lookup_bytes = read_limited(
    lookup_response.response,
    APPLE_SEARCH_RESPONSE_LIMIT,
    "Apple 播客目录查询",
  )
  .await?;
  parse_apple_discovery(chart, &lookup_bytes, limit)
}

fn parse_apple_discovery(
  chart: AppleDiscoveryResponse,
  lookup_bytes: &[u8],
  limit: u8,
) -> Result<Vec<PodcastDiscoveryShow>, String> {
  let lookup = serde_json::from_slice::<AppleSearchResponse>(lookup_bytes)
    .map_err(|_| "Apple 播客目录查询结果格式无效".to_string())?;
  let lookup_by_id = lookup
    .results
    .into_iter()
    .filter_map(|item| item.collection_id.map(|id| (id.to_string(), item)))
    .collect::<HashMap<_, _>>();

  let mut shows = Vec::new();
  for (index, item) in chart.feed.results.into_iter().take(limit as usize).enumerate() {
    let Some(id) = valid_apple_catalog_id(&item.id) else {
      continue;
    };
    let Some(lookup_item) = lookup_by_id.get(id) else {
      continue;
    };
    let Some(feed_url) = lookup_item.feed_url.as_deref().and_then(clean_url_string) else {
      continue;
    };
    let title = clean_text(&item.name, PODCAST_TITLE_LIMIT)
      .or_else(|| {
        lookup_item
          .collection_name
          .as_deref()
          .and_then(|value| clean_text(value, PODCAST_TITLE_LIMIT))
      })
      .unwrap_or_else(|| "未命名播客".to_string());
    let author = clean_text(&item.artist_name, PODCAST_TITLE_LIMIT)
      .or_else(|| {
        lookup_item
          .artist_name
          .as_deref()
          .and_then(|value| clean_text(value, PODCAST_TITLE_LIMIT))
      })
      .unwrap_or_default();
    let artwork_url = lookup_item
      .artwork_url_600
      .as_deref()
      .and_then(clean_url_string)
      .or_else(|| lookup_item.artwork_url_100.as_deref().and_then(clean_url_string))
      .or_else(|| item.artwork_url_100.as_deref().and_then(clean_url_string));
    let mut genres = Vec::new();
    for genre in item.genres {
      let Some(name) = clean_text(&genre.name, PODCAST_TITLE_LIMIT) else {
        continue;
      };
      if !genres.contains(&name) {
        genres.push(name);
      }
    }
    shows.push(PodcastDiscoveryShow {
      id: id.to_string(),
      title,
      author,
      feed_url,
      artwork_url,
      genres,
      rank: index + 1,
    });
  }
  if shows.is_empty() {
    return Err("Apple 播客榜单缺少可用订阅源".to_string());
  }
  Ok(shows)
}

fn valid_apple_catalog_id(value: &str) -> Option<&str> {
  let value = value.trim();
  (!value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit())).then_some(value)
}

async fn fetch_and_parse_feed(
  feed_url: &str,
  title_hint: Option<&str>,
  author_hint: Option<&str>,
  artwork_hint: Option<&str>,
) -> Result<ParsedPodcast, String> {
  let url = validate_public_url_shape(feed_url)?;
  let public_response = send_public_get(url, Duration::from_secs(30), None).await?;
  if !public_response.response.status().is_success() {
    return Err(format!(
      "播客订阅源返回错误 {}",
      public_response.response.status().as_u16()
    ));
  }
  let etag = header_text(public_response.response.headers(), header::ETAG);
  let last_modified = header_text(public_response.response.headers(), header::LAST_MODIFIED);
  let bytes = read_limited(public_response.response, PODCAST_FEED_RESPONSE_LIMIT, "播客订阅源").await?;
  parse_feed_bytes(
    &bytes,
    public_response.final_url.as_str(),
    title_hint,
    author_hint,
    artwork_hint,
    etag,
    last_modified,
  )
}

fn parse_feed_bytes(
  bytes: &[u8],
  final_url: &str,
  title_hint: Option<&str>,
  author_hint: Option<&str>,
  artwork_hint: Option<&str>,
  etag: Option<String>,
  last_modified: Option<String>,
) -> Result<ParsedPodcast, String> {
  let parsed = feed_rs::parser::parse(bytes).map_err(|error| format!("无法解析播客订阅源：{error}"))?;
  normalize_feed(
    parsed,
    final_url,
    title_hint,
    author_hint,
    artwork_hint,
    etag,
    last_modified,
  )
}

fn normalize_feed(
  parsed: ParsedFeed,
  final_url: &str,
  title_hint: Option<&str>,
  author_hint: Option<&str>,
  artwork_hint: Option<&str>,
  etag: Option<String>,
  last_modified: Option<String>,
) -> Result<ParsedPodcast, String> {
  let normalized_url = normalize_url(final_url)?;
  let feed_id = hash_identifier("feed", &[&normalized_url]);
  let title = parsed
    .title
    .as_ref()
    .map(|value| plain_text(&value.content, PODCAST_TITLE_LIMIT))
    .filter(|value| !value.is_empty())
    .or_else(|| clean_hint(title_hint, PODCAST_TITLE_LIMIT))
    .unwrap_or_else(|| "未命名播客".to_string());
  let author = parsed
    .authors
    .first()
    .map(|person| plain_text(&person.name, PODCAST_TITLE_LIMIT))
    .filter(|value| !value.is_empty())
    .or_else(|| clean_hint(author_hint, PODCAST_TITLE_LIMIT));
  let description = parsed
    .description
    .as_ref()
    .map(|value| plain_text(&value.content, PODCAST_DESCRIPTION_LIMIT))
    .filter(|value| !value.is_empty());
  let artwork_url = parsed
    .logo
    .as_ref()
    .map(|image| image.uri.clone())
    .or_else(|| parsed.icon.as_ref().map(|image| image.uri.clone()))
    .and_then(|value| clean_url_string(&value))
    .or_else(|| artwork_hint.and_then(clean_url_string));
  let fetched_at = unix_time_millis();
  let feed = PodcastFeed {
    id: feed_id.clone(),
    feed_url: normalized_url,
    title,
    author,
    description,
    artwork_url: artwork_url.clone(),
    last_fetched_at: fetched_at,
    subscribed: false,
  };

  let mut episodes = Vec::new();
  for entry in &parsed.entries {
    if let Some(episode) = normalize_episode(entry, &feed_id, artwork_url.as_deref()) {
      episodes.push(episode);
    }
  }
  if episodes.is_empty() {
    return Err("订阅源中没有可播放的音频单集".to_string());
  }

  Ok(ParsedPodcast {
    feed,
    episodes,
    etag,
    last_modified,
  })
}

fn normalize_episode(entry: &ParsedEntry, feed_id: &str, feed_artwork: Option<&str>) -> Option<ParsedPodcastEpisode> {
  let enclosure = find_enclosure(entry)?;
  let guid = clean_text(&entry.id, 4_096);
  let identity_key = if let Some(guid) = guid.as_deref() {
    format!("guid:{guid}")
  } else {
    format!("enclosure:{}", enclosure.url)
  };
  let id = hash_identifier("episode", &[feed_id, &identity_key]);
  let title = entry
    .title
    .as_ref()
    .map(|value| plain_text(&value.content, PODCAST_TITLE_LIMIT))
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "未命名单集".to_string());
  let description = entry
    .summary
    .as_ref()
    .map(|value| plain_text(&value.content, PODCAST_DESCRIPTION_LIMIT))
    .filter(|value| !value.is_empty())
    .or_else(|| {
      entry
        .content
        .as_ref()
        .and_then(|content| content.body.as_deref())
        .map(|value| plain_text(value, PODCAST_DESCRIPTION_LIMIT))
        .filter(|value| !value.is_empty())
    });
  let duration_seconds = entry
    .media
    .iter()
    .find_map(|media| media.duration.map(|duration| duration.as_secs_f64()))
    .or(enclosure.duration_seconds);
  let artwork_url = entry
    .media
    .iter()
    .flat_map(|media| media.thumbnails.iter())
    .find_map(|thumbnail| clean_url_string(thumbnail.image.uri.as_str()))
    .or_else(|| feed_artwork.map(str::to_string));

  Some(ParsedPodcastEpisode {
    id,
    feed_id: feed_id.to_string(),
    identity_key,
    guid,
    title,
    description,
    published_at: entry
      .published
      .or(entry.updated)
      .map(|timestamp| timestamp.timestamp_millis()),
    duration_seconds,
    enclosure_url: enclosure.url,
    enclosure_type: enclosure.content_type,
    artwork_url,
    expected_bytes: enclosure.length,
  })
}

struct Enclosure {
  url: String,
  content_type: Option<String>,
  length: Option<u64>,
  duration_seconds: Option<f64>,
}

fn find_enclosure(entry: &ParsedEntry) -> Option<Enclosure> {
  if let Some(content) = entry.content.as_ref() {
    if let Some(source) = content.src.as_ref() {
      if let Some(url) = clean_url_string(&source.href) {
        let content_type = clean_text(content.content_type.as_str(), 200);
        if is_possible_audio_enclosure(content_type.as_deref(), &url) {
          return Some(Enclosure {
            url,
            content_type,
            length: content.length.or(source.length),
            duration_seconds: None,
          });
        }
      }
    }
  }

  for link in &entry.links {
    if link.rel.as_deref() != Some("enclosure") {
      continue;
    }
    let Some(url) = clean_url_string(&link.href) else {
      continue;
    };
    if is_possible_audio_enclosure(link.media_type.as_deref(), &url) {
      return Some(Enclosure {
        url,
        content_type: link.media_type.clone(),
        length: link.length,
        duration_seconds: None,
      });
    }
  }

  for media in &entry.media {
    for content in &media.content {
      let Some(url) = content.url.as_ref().map(Url::to_string) else {
        continue;
      };
      let content_type = content.content_type.as_ref().map(|value| value.as_str().to_string());
      if is_possible_audio_enclosure(content_type.as_deref(), &url) {
        return Some(Enclosure {
          url,
          content_type,
          length: content.size,
          duration_seconds: content
            .duration
            .or(media.duration)
            .map(|duration| duration.as_secs_f64()),
        });
      }
    }
  }
  None
}

fn is_possible_audio_enclosure(content_type: Option<&str>, url: &str) -> bool {
  if let Some(content_type) = content_type {
    let content_type = content_type.to_ascii_lowercase();
    if content_type.starts_with("video/")
      || content_type.starts_with("image/")
      || content_type.starts_with("text/")
      || content_type.contains("json")
      || content_type.contains("xml")
    {
      return false;
    }
    if content_type.starts_with("audio/")
      || content_type == "application/octet-stream"
      || content_type == "binary/octet-stream"
    {
      return true;
    }
  }
  let path = Url::parse(url)
    .ok()
    .map(|value| value.path().to_ascii_lowercase())
    .unwrap_or_default();
  [".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg"]
    .iter()
    .any(|extension| path.ends_with(extension))
    || content_type.is_none()
}

fn open_database(path: &Path) -> Result<Connection, String> {
  let connection = Connection::open(path).map_err(|error| format!("无法打开播客数据库：{error}"))?;
  connection
    .busy_timeout(Duration::from_secs(5))
    .map_err(|error| format!("无法配置播客数据库：{error}"))?;
  connection
    .execute_batch(
      "
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS podcast_feeds (
        id TEXT PRIMARY KEY,
        feed_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        author TEXT,
        description TEXT,
        artwork_url TEXT,
        etag TEXT,
        last_modified TEXT,
        last_fetched_at INTEGER NOT NULL,
        subscribed INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS podcast_episodes (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL REFERENCES podcast_feeds(id) ON DELETE CASCADE,
        identity_key TEXT NOT NULL,
        guid TEXT,
        title TEXT NOT NULL,
        description TEXT,
        published_at INTEGER,
        duration_seconds REAL,
        enclosure_url TEXT NOT NULL,
        enclosure_type TEXT,
        artwork_url TEXT,
        expected_bytes INTEGER,
        UNIQUE(feed_id, identity_key)
      );

      CREATE TABLE IF NOT EXISTS podcast_downloads (
        episode_id TEXT PRIMARY KEY REFERENCES podcast_episodes(id) ON DELETE CASCADE,
        local_path TEXT,
        state TEXT NOT NULL CHECK(state IN ('downloading', 'downloaded', 'failed')),
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER,
        error_message TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS podcast_progress (
        episode_id TEXT PRIMARY KEY REFERENCES podcast_episodes(id) ON DELETE CASCADE,
        position_seconds REAL NOT NULL,
        duration_seconds REAL,
        completed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS podcast_saved_episodes (
        episode_id TEXT PRIMARY KEY NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
        saved_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS podcast_queue (
        episode_id TEXT PRIMARY KEY NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0),
        added_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS podcast_episodes_feed_published
        ON podcast_episodes(feed_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS podcast_saved_episodes_saved_at
        ON podcast_saved_episodes(saved_at DESC);
      CREATE INDEX IF NOT EXISTS podcast_queue_position
        ON podcast_queue(position, added_at, episode_id);
      ",
    )
    .map_err(|error| format!("无法初始化播客数据库：{error}"))?;
  let has_subscribed = {
    let mut statement = connection
      .prepare("PRAGMA table_info(podcast_feeds)")
      .map_err(|error| format!("无法检查播客数据库结构：{error}"))?;
    let columns = statement
      .query_map([], |row| row.get::<_, String>(1))
      .map_err(|error| format!("无法检查播客数据库结构：{error}"))?;
    let mut found = false;
    for column in columns {
      if column.map_err(|error| format!("无法检查播客数据库结构：{error}"))? == "subscribed" {
        found = true;
        break;
      }
    }
    found
  };
  if !has_subscribed {
    connection
      .execute(
        "ALTER TABLE podcast_feeds ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 1",
        [],
      )
      .map_err(|error| format!("无法迁移播客数据库：{error}"))?;
  }
  connection
    .execute_batch(
      "
      CREATE INDEX IF NOT EXISTS podcast_feeds_subscribed_title
        ON podcast_feeds(subscribed, title COLLATE NOCASE);
      ",
    )
    .map_err(|error| format!("无法初始化播客数据库索引：{error}"))?;
  Ok(connection)
}

fn store_subscription(db_path: &Path, parsed: ParsedPodcast) -> Result<PodcastSubscribeResult, String> {
  store_feed(db_path, parsed, true)
}

fn store_preview(db_path: &Path, parsed: ParsedPodcast) -> Result<PodcastSubscribeResult, String> {
  store_feed(db_path, parsed, false)
}

fn store_feed(
  db_path: &Path,
  parsed: ParsedPodcast,
  requested_subscribed: bool,
) -> Result<PodcastSubscribeResult, String> {
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction()
    .map_err(|error| format!("无法更新播客订阅：{error}"))?;
  let ParsedPodcast {
    mut feed,
    episodes,
    etag,
    last_modified,
  } = parsed;
  let existing_subscribed = transaction
    .query_row(
      "SELECT subscribed FROM podcast_feeds WHERE id = ?1",
      [&feed.id],
      |row| row.get::<_, i64>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取播客关注状态：{error}"))?
    .is_some_and(|value| value != 0);
  feed.subscribed = requested_subscribed || existing_subscribed;
  transaction
    .execute(
      "
      INSERT INTO podcast_feeds (
        id, feed_url, title, author, description, artwork_url,
        etag, last_modified, last_fetched_at, subscribed
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(id) DO UPDATE SET
        feed_url = excluded.feed_url,
        title = excluded.title,
        author = excluded.author,
        description = excluded.description,
        artwork_url = excluded.artwork_url,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        last_fetched_at = excluded.last_fetched_at,
        subscribed = excluded.subscribed
      ",
      params![
        feed.id,
        feed.feed_url,
        feed.title,
        feed.author,
        feed.description,
        feed.artwork_url,
        etag,
        last_modified,
        feed.last_fetched_at,
        i64::from(feed.subscribed),
      ],
    )
    .map_err(|error| format!("无法保存播客订阅：{error}"))?;

  let mut inserted_count = 0usize;
  {
    let mut insert = transaction
      .prepare(
        "
        INSERT INTO podcast_episodes (
          id, feed_id, identity_key, guid, title, description, published_at,
          duration_seconds, enclosure_url, enclosure_type, artwork_url, expected_bytes
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(id) DO NOTHING
        ",
      )
      .map_err(|error| format!("无法准备播客单集写入：{error}"))?;
    let mut update = transaction
      .prepare(
        "
        UPDATE podcast_episodes SET
          identity_key = ?3,
          guid = ?4,
          title = ?5,
          description = ?6,
          published_at = ?7,
          duration_seconds = ?8,
          enclosure_url = ?9,
          enclosure_type = ?10,
          artwork_url = ?11,
          expected_bytes = ?12
        WHERE id = ?1 AND feed_id = ?2
        ",
      )
      .map_err(|error| format!("无法准备播客单集更新：{error}"))?;
    for episode in &episodes {
      let values = params![
        episode.id,
        episode.feed_id,
        episode.identity_key,
        episode.guid,
        episode.title,
        episode.description,
        episode.published_at,
        episode.duration_seconds,
        episode.enclosure_url,
        episode.enclosure_type,
        episode.artwork_url,
        episode.expected_bytes.and_then(|value| i64::try_from(value).ok()),
      ];
      inserted_count += insert
        .execute(values)
        .map_err(|error| format!("无法保存播客单集：{error}"))?;
      update
        .execute(params![
          episode.id,
          episode.feed_id,
          episode.identity_key,
          episode.guid,
          episode.title,
          episode.description,
          episode.published_at,
          episode.duration_seconds,
          episode.enclosure_url,
          episode.enclosure_type,
          episode.artwork_url,
          episode.expected_bytes.and_then(|value| i64::try_from(value).ok()),
        ])
        .map_err(|error| format!("无法更新播客单集：{error}"))?;
    }
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客订阅：{error}"))?;

  Ok(PodcastSubscribeResult {
    feed,
    episode_count: episodes.len(),
    inserted_count,
  })
}

fn list_feeds(db_path: &Path) -> Result<Vec<PodcastFeed>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT id, feed_url, title, author, description, artwork_url, last_fetched_at, subscribed
      FROM podcast_feeds
      WHERE subscribed = 1
      ORDER BY title COLLATE NOCASE
      ",
    )
    .map_err(|error| format!("无法读取播客订阅：{error}"))?;
  let rows = statement
    .query_map([], |row| {
      Ok(PodcastFeed {
        id: row.get(0)?,
        feed_url: row.get(1)?,
        title: row.get(2)?,
        author: row.get(3)?,
        description: row.get(4)?,
        artwork_url: row.get(5)?,
        last_fetched_at: row.get(6)?,
        subscribed: row.get::<_, i64>(7)? != 0,
      })
    })
    .map_err(|error| format!("无法读取播客订阅：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客订阅：{error}"))
}

fn set_following(db_path: &Path, feed_id: &str, following: bool) -> Result<(), String> {
  let connection = open_database(db_path)?;
  let changed = connection
    .execute(
      "UPDATE podcast_feeds SET subscribed = ?2 WHERE id = ?1",
      params![feed_id, i64::from(following)],
    )
    .map_err(|error| format!("无法更新播客关注状态：{error}"))?;
  if changed == 0 {
    return Err("播客节目不存在".to_string());
  }
  Ok(())
}

fn list_episodes(
  db_path: &Path,
  downloads_dir: &Path,
  feed_id: &str,
) -> Result<Vec<PodcastEpisode>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT
        e.id, e.feed_id, e.title, e.description, e.published_at,
        e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
        COALESCE(d.state, 'none'), d.local_path,
        COALESCE(d.downloaded_bytes, 0), d.total_bytes,
        COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
        f.title, f.artwork_url,
        CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END
      FROM podcast_episodes e
      JOIN podcast_feeds f ON f.id = e.feed_id
      LEFT JOIN podcast_downloads d ON d.episode_id = e.id
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
      WHERE e.feed_id = ?1
      ORDER BY e.published_at IS NULL, e.published_at DESC, e.title COLLATE NOCASE
      LIMIT 5000
      ",
    )
    .map_err(|error| format!("无法读取播客单集：{error}"))?;
  let rows = statement
    .query_map([feed_id], |row| podcast_episode_from_row(row, downloads_dir))
    .map_err(|error| format!("无法读取播客单集：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客单集：{error}"))
}

fn list_home(db_path: &Path, downloads_dir: &Path) -> Result<PodcastHome, String> {
  let connection = open_database(db_path)?;
  let continue_listening = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE p.position_seconds > 0 AND p.completed = 0
    ORDER BY p.updated_at DESC
    LIMIT ?1
    ",
    PODCAST_HOME_CONTINUE_LIMIT,
  )?;
  let latest_episodes = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE f.subscribed = 1
    ORDER BY e.published_at IS NULL, e.published_at DESC, e.title COLLATE NOCASE
    LIMIT ?1
    ",
    PODCAST_HOME_LATEST_LIMIT,
  )?;
  let downloaded_episodes = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE d.state = 'downloaded'
    ORDER BY d.updated_at DESC
    LIMIT ?1
    ",
    PODCAST_HOME_DOWNLOADED_LIMIT.saturating_mul(4),
  )?
  .into_iter()
  .filter(|episode| episode.download_state == "downloaded")
  .take(PODCAST_HOME_DOWNLOADED_LIMIT)
  .collect();
  let saved_episodes = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      1
    FROM podcast_saved_episodes s
    JOIN podcast_episodes e ON e.id = s.episode_id
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    ORDER BY s.saved_at DESC, e.id
    LIMIT ?1
    ",
    PODCAST_HOME_SAVED_LIMIT,
  )?;

  Ok(PodcastHome {
    continue_listening,
    latest_episodes,
    downloaded_episodes,
    saved_episodes,
  })
}

fn query_home_episodes(
  connection: &Connection,
  downloads_dir: &Path,
  sql: &str,
  limit: usize,
) -> Result<Vec<PodcastEpisode>, String> {
  let mut statement = connection
    .prepare(sql)
    .map_err(|error| format!("无法读取播客首页：{error}"))?;
  let rows = statement
    .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
      podcast_episode_from_row(row, downloads_dir)
    })
    .map_err(|error| format!("无法读取播客首页：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客首页：{error}"))
}

fn podcast_episode_from_row(
  row: &rusqlite::Row<'_>,
  downloads_dir: &Path,
) -> rusqlite::Result<PodcastEpisode> {
  let id = row.get::<_, String>(0)?;
  let mut download_state = row.get::<_, String>(9)?;
  let raw_local_path = row.get::<_, Option<String>>(10)?;
  let mut downloaded_bytes = row.get::<_, i64>(11)?.max(0) as u64;
  let mut total_bytes = row.get::<_, Option<i64>>(12)?.map(|value| value.max(0) as u64);
  let local_path = if download_state == "downloaded" {
    raw_local_path.filter(|value| {
      let path = PathBuf::from(value);
      path.is_file() && is_managed_download_path(downloads_dir, &id, &path)
    })
  } else {
    None
  };
  if download_state == "downloaded" && local_path.is_none() {
    download_state = "none".to_string();
    downloaded_bytes = 0;
    total_bytes = None;
  }
  Ok(PodcastEpisode {
    id,
    feed_id: row.get(1)?,
    title: row.get(2)?,
    description: row.get(3)?,
    published_at: row.get(4)?,
    duration_seconds: row.get(5)?,
    enclosure_url: row.get(6)?,
    enclosure_type: row.get(7)?,
    artwork_url: row.get(8)?,
    download_state,
    local_path,
    downloaded_bytes,
    total_bytes,
    progress_seconds: row.get(13)?,
    completed: row.get::<_, i64>(14)? != 0,
    feed_title: row.get(15)?,
    feed_artwork_url: row.get(16)?,
    saved: row.get::<_, i64>(17)? != 0,
  })
}

const PODCAST_EPISODE_DETAIL_SELECT: &str = "
  SELECT
    e.id, e.feed_id, e.title, e.description, e.published_at,
    e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
    COALESCE(d.state, 'none'), d.local_path,
    COALESCE(d.downloaded_bytes, 0), d.total_bytes,
    COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
    f.title, f.artwork_url,
    CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
    e.expected_bytes, d.error_message, s.saved_at, q.position,
    f.feed_url, f.author, f.description, f.last_fetched_at, f.subscribed
  FROM podcast_episodes e
  JOIN podcast_feeds f ON f.id = e.feed_id
  LEFT JOIN podcast_downloads d ON d.episode_id = e.id
  LEFT JOIN podcast_progress p ON p.episode_id = e.id
  LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
  LEFT JOIN podcast_queue q ON q.episode_id = e.id
";

fn podcast_episode_detail_from_row(
  row: &rusqlite::Row<'_>,
  downloads_dir: &Path,
) -> rusqlite::Result<PodcastEpisodeDetail> {
  let episode = podcast_episode_from_row(row, downloads_dir)?;
  let expected_bytes = row
    .get::<_, Option<i64>>(18)?
    .and_then(|value| u64::try_from(value).ok());
  let queue_position = row
    .get::<_, Option<i64>>(21)?
    .and_then(|value| u32::try_from(value).ok());
  Ok(PodcastEpisodeDetail {
    saved: episode.saved,
    episode,
    feed: PodcastFeed {
      id: row.get(1)?,
      feed_url: row.get(22)?,
      title: row.get(15)?,
      author: row.get(23)?,
      description: row.get(24)?,
      artwork_url: row.get(16)?,
      last_fetched_at: row.get(25)?,
      subscribed: row.get::<_, i64>(26)? != 0,
    },
    expected_bytes,
    download_error: row.get(19)?,
    saved_at: row.get(20)?,
    queue_position,
  })
}

fn get_episode_detail(
  db_path: &Path,
  downloads_dir: &Path,
  episode_id: &str,
) -> Result<PodcastEpisodeDetail, String> {
  let connection = open_database(db_path)?;
  connection
    .query_row(
      &format!("{PODCAST_EPISODE_DETAIL_SELECT} WHERE e.id = ?1"),
      [episode_id],
      |row| podcast_episode_detail_from_row(row, downloads_dir),
    )
    .optional()
    .map_err(|error| format!("无法读取播客单集详情：{error}"))?
    .ok_or_else(|| "播客单集不存在".to_string())
}

fn set_episode_saved(db_path: &Path, episode_id: &str, saved: bool) -> Result<(), String> {
  let connection = open_database(db_path)?;
  ensure_episode_exists(&connection, episode_id)?;
  if saved {
    connection
      .execute(
        "
        INSERT INTO podcast_saved_episodes (episode_id, saved_at)
        VALUES (?1, ?2)
        ON CONFLICT(episode_id) DO NOTHING
        ",
        params![episode_id, unix_time_millis()],
      )
      .map_err(|error| format!("无法保存播客单集：{error}"))?;
  } else {
    connection
      .execute(
        "DELETE FROM podcast_saved_episodes WHERE episode_id = ?1",
        [episode_id],
      )
      .map_err(|error| format!("无法取消保存播客单集：{error}"))?;
  }
  Ok(())
}

fn list_saved_episodes(
  db_path: &Path,
  downloads_dir: &Path,
) -> Result<Vec<PodcastEpisodeDetail>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(&format!(
      "{PODCAST_EPISODE_DETAIL_SELECT}
       WHERE s.episode_id IS NOT NULL
       ORDER BY s.saved_at DESC, e.id
       LIMIT 5000"
    ))
    .map_err(|error| format!("无法读取已保存的播客单集：{error}"))?;
  let rows = statement
    .query_map([], |row| podcast_episode_detail_from_row(row, downloads_dir))
    .map_err(|error| format!("无法读取已保存的播客单集：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取已保存的播客单集：{error}"))
}

fn set_episode_played(db_path: &Path, episode_id: &str, played: bool) -> Result<(), String> {
  let connection = open_database(db_path)?;
  let progress = connection
    .query_row(
      "
      SELECT e.duration_seconds, p.duration_seconds, p.position_seconds
      FROM podcast_episodes e
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      WHERE e.id = ?1
      ",
      [episode_id],
      |row| {
        Ok((
          row.get::<_, Option<f64>>(0)?,
          row.get::<_, Option<f64>>(1)?,
          row.get::<_, Option<f64>>(2)?,
        ))
      },
    )
    .optional()
    .map_err(|error| format!("无法读取播客播放状态：{error}"))?
    .ok_or_else(|| "播客单集不存在".to_string())?;

  if !played {
    connection
      .execute("DELETE FROM podcast_progress WHERE episode_id = ?1", [episode_id])
      .map_err(|error| format!("无法标记播客单集为未播放：{error}"))?;
    return Ok(());
  }

  let duration_seconds = progress
    .1
    .filter(|value| value.is_finite() && *value > 0.0)
    .or_else(|| progress.0.filter(|value| value.is_finite() && *value > 0.0));
  let current_position = progress
    .2
    .filter(|value| value.is_finite() && *value >= 0.0)
    .unwrap_or(0.0);
  let position_seconds = duration_seconds.unwrap_or(current_position);
  connection
    .execute(
      "
      INSERT INTO podcast_progress (
        episode_id, position_seconds, duration_seconds, completed, updated_at
      ) VALUES (?1, ?2, ?3, 1, ?4)
      ON CONFLICT(episode_id) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        completed = 1,
        updated_at = excluded.updated_at
      ",
      params![episode_id, position_seconds, duration_seconds, unix_time_millis()],
    )
    .map_err(|error| format!("无法标记播客单集为已播放：{error}"))?;
  Ok(())
}

#[derive(Clone, Debug)]
struct QueueRecord {
  episode_id: String,
  added_at: i64,
}

fn ensure_episode_exists(connection: &Connection, episode_id: &str) -> Result<(), String> {
  let exists = connection
    .query_row(
      "SELECT 1 FROM podcast_episodes WHERE id = ?1",
      [episode_id],
      |_| Ok(()),
    )
    .optional()
    .map_err(|error| format!("无法读取播客单集：{error}"))?
    .is_some();
  if !exists {
    return Err("播客单集不存在".to_string());
  }
  Ok(())
}

fn read_queue_records(connection: &Connection) -> Result<Vec<QueueRecord>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT episode_id, added_at
      FROM podcast_queue
      ORDER BY position, added_at, episode_id
      ",
    )
    .map_err(|error| format!("无法读取播客待播列表：{error}"))?;
  let rows = statement
    .query_map([], |row| {
      Ok(QueueRecord {
        episode_id: row.get(0)?,
        added_at: row.get(1)?,
      })
    })
    .map_err(|error| format!("无法读取播客待播列表：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客待播列表：{error}"))
}

fn rewrite_queue(transaction: &Transaction<'_>, records: &[QueueRecord]) -> Result<(), String> {
  transaction
    .execute("DELETE FROM podcast_queue", [])
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  let mut insert = transaction
    .prepare(
      "
      INSERT INTO podcast_queue (episode_id, position, added_at)
      VALUES (?1, ?2, ?3)
      ",
    )
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  for (position, record) in records.iter().enumerate() {
    insert
      .execute(params![
        record.episode_id,
        i64::try_from(position).unwrap_or(i64::MAX),
        record.added_at,
      ])
      .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  }
  Ok(())
}

fn queue_add(db_path: &Path, episode_id: &str, play_next: bool) -> Result<(), String> {
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  ensure_episode_exists(&transaction, episode_id)?;
  let mut records = read_queue_records(&transaction)?;
  if let Some(index) = records.iter().position(|record| record.episode_id == episode_id) {
    if play_next && index > 0 {
      let record = records.remove(index);
      records.insert(0, record);
      rewrite_queue(&transaction, &records)?;
    }
  } else {
    if records.len() >= PODCAST_QUEUE_LIMIT {
      return Err(format!("播客待播列表最多可加入 {PODCAST_QUEUE_LIMIT} 集"));
    }
    let record = QueueRecord {
      episode_id: episode_id.to_string(),
      added_at: unix_time_millis(),
    };
    if play_next {
      records.insert(0, record);
    } else {
      records.push(record);
    }
    rewrite_queue(&transaction, &records)?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客待播列表：{error}"))
}

fn queue_remove(db_path: &Path, episode_id: &str) -> Result<(), String> {
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  let mut records = read_queue_records(&transaction)?;
  let previous_len = records.len();
  records.retain(|record| record.episode_id != episode_id);
  if records.len() != previous_len {
    rewrite_queue(&transaction, &records)?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客待播列表：{error}"))
}

fn validate_queue_identifiers(episode_ids: &[String]) -> Result<(), String> {
  if episode_ids.len() > PODCAST_QUEUE_LIMIT {
    return Err(format!("播客待播列表最多可加入 {PODCAST_QUEUE_LIMIT} 集"));
  }
  let mut unique = HashSet::with_capacity(episode_ids.len());
  for episode_id in episode_ids {
    validate_identifier(episode_id)?;
    if !unique.insert(episode_id.as_str()) {
      return Err("播客待播列表包含重复单集".to_string());
    }
  }
  Ok(())
}

fn queue_reorder(db_path: &Path, episode_ids: &[String]) -> Result<(), String> {
  validate_queue_identifiers(episode_ids)?;
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法重新排列播客待播列表：{error}"))?;
  let current = read_queue_records(&transaction)?;
  let added_at_by_id = current
    .iter()
    .map(|record| (record.episode_id.as_str(), record.added_at))
    .collect::<HashMap<_, _>>();
  if current.len() != episode_ids.len()
    || episode_ids
      .iter()
      .any(|episode_id| !added_at_by_id.contains_key(episode_id.as_str()))
  {
    return Err("播客待播列表已发生变化，请刷新后重试".to_string());
  }
  let reordered = episode_ids
    .iter()
    .map(|episode_id| QueueRecord {
      episode_id: episode_id.clone(),
      added_at: added_at_by_id[episode_id.as_str()],
    })
    .collect::<Vec<_>>();
  rewrite_queue(&transaction, &reordered)?;
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客待播列表：{error}"))
}

fn queue_clear(db_path: &Path) -> Result<(), String> {
  let connection = open_database(db_path)?;
  connection
    .execute("DELETE FROM podcast_queue", [])
    .map_err(|error| format!("无法清空播客待播列表：{error}"))?;
  Ok(())
}

fn list_queue(db_path: &Path, downloads_dir: &Path) -> Result<Vec<PodcastQueueItem>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT
        e.id, e.feed_id, e.title, e.description, e.published_at,
        e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
        COALESCE(d.state, 'none'), d.local_path,
        COALESCE(d.downloaded_bytes, 0), d.total_bytes,
        COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
        f.title, f.artwork_url,
        CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
        q.position, q.added_at
      FROM podcast_queue q
      JOIN podcast_episodes e ON e.id = q.episode_id
      JOIN podcast_feeds f ON f.id = e.feed_id
      LEFT JOIN podcast_downloads d ON d.episode_id = e.id
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
      ORDER BY q.position, q.added_at, e.id
      ",
    )
    .map_err(|error| format!("无法读取播客待播列表：{error}"))?;
  let rows = statement
    .query_map([], |row| {
      Ok(PodcastQueueItem {
        episode: podcast_episode_from_row(row, downloads_dir)?,
        position: row
          .get::<_, i64>(18)
          .ok()
          .and_then(|value| u32::try_from(value).ok())
          .unwrap_or(0),
        added_at: row.get(19)?,
      })
    })
    .map_err(|error| format!("无法读取播客待播列表：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客待播列表：{error}"))
}

fn load_episode_download_source(db_path: &Path, episode_id: &str) -> Result<EpisodeDownloadSource, String> {
  let connection = open_database(db_path)?;
  connection
    .query_row(
      "
      SELECT
        e.enclosure_url, e.enclosure_type, d.local_path,
        COALESCE(d.downloaded_bytes, 0)
      FROM podcast_episodes e
      LEFT JOIN podcast_downloads d ON d.episode_id = e.id
      WHERE e.id = ?1
      ",
      [episode_id],
      |row| {
        Ok(EpisodeDownloadSource {
          enclosure_url: row.get(0)?,
          enclosure_type: row.get(1)?,
          local_path: row.get(2)?,
          downloaded_bytes: row.get::<_, i64>(3)?.max(0) as u64,
        })
      },
    )
    .optional()
    .map_err(|error| format!("无法读取播客下载信息：{error}"))?
    .ok_or_else(|| "播客单集不存在".to_string())
}

fn remove_file_if_present(path: &Path, label: &str) -> Result<(), String> {
  match fs::remove_file(path) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(format!("无法删除{label}：{error}")),
  }
}

fn delete_episode_download(
  db_path: &Path,
  downloads_dir: &Path,
  episode_id: &str,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  ensure_episode_exists(&connection, episode_id)?;
  let local_path = connection
    .query_row(
      "SELECT local_path FROM podcast_downloads WHERE episode_id = ?1",
      [episode_id],
      |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取播客下载信息：{error}"))?
    .flatten();

  if let Some(local_path) = local_path {
    let path = PathBuf::from(local_path);
    if is_managed_download_path(downloads_dir, episode_id, &path) {
      remove_file_if_present(&path, "播客下载")?;
    }
  }
  remove_file_if_present(
    &downloads_dir.join(format!("{episode_id}.part")),
    "播客下载临时文件",
  )?;
  connection
    .execute(
      "DELETE FROM podcast_downloads WHERE episode_id = ?1",
      [episode_id],
    )
    .map_err(|error| format!("无法清除播客下载记录：{error}"))?;
  Ok(())
}

async fn download_episode(
  db_path: &Path,
  downloads_dir: &Path,
  episode_id: &str,
  enclosure_url: &str,
  enclosure_type: Option<&str>,
) -> Result<PodcastDownloadResult, String> {
  download_episode_with_network_policy(db_path, downloads_dir, episode_id, enclosure_url, enclosure_type, false).await
}

async fn download_episode_with_network_policy(
  db_path: &Path,
  downloads_dir: &Path,
  episode_id: &str,
  enclosure_url: &str,
  enclosure_type: Option<&str>,
  allow_private_network: bool,
) -> Result<PodcastDownloadResult, String> {
  let url = validate_url_shape_with_policy(enclosure_url, allow_private_network)?;
  let part_path = downloads_dir.join(format!("{episode_id}.part"));
  let mut offset = tokio::fs::metadata(&part_path)
    .await
    .map(|metadata| metadata.len())
    .unwrap_or(0);
  if offset > PODCAST_AUDIO_RESPONSE_LIMIT {
    let _ = tokio::fs::remove_file(&part_path).await;
    offset = 0;
  }

  let db_path_owned = db_path.to_path_buf();
  let started_id = episode_id.to_string();
  tauri::async_runtime::spawn_blocking(move || mark_download_started(&db_path_owned, &started_id, offset, None))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))??;

  let range = (offset > 0).then(|| format!("bytes={offset}-"));
  let mut public_response = send_public_get_with_policy(
    url,
    Duration::from_secs(30 * 60),
    range.as_deref(),
    allow_private_network,
  )
  .await?;
  if offset > 0 && public_response.response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
    tokio::fs::remove_file(&part_path)
      .await
      .map_err(|error| format!("无法重置失效的播客断点文件：{error}"))?;
    offset = 0;
    public_response = send_public_get_with_policy(
      validate_url_shape_with_policy(enclosure_url, allow_private_network)?,
      Duration::from_secs(30 * 60),
      None,
      allow_private_network,
    )
    .await?;
  }
  let status = public_response.response.status();
  if !status.is_success() {
    return Err(format!("播客音频来源返回错误 {}", status.as_u16()));
  }
  let response_content_type = header_text(public_response.response.headers(), header::CONTENT_TYPE);
  if !response_content_type_is_audio_candidate(response_content_type.as_deref(), enclosure_type) {
    return Err("播客音频来源返回了非音频内容".to_string());
  }

  let mut append = false;
  let mut resumed = false;
  if offset > 0 && status == StatusCode::PARTIAL_CONTENT {
    let content_range = header_text(public_response.response.headers(), header::CONTENT_RANGE)
      .ok_or_else(|| "播客音频断点响应缺少范围信息".to_string())?;
    let (start, _, _) = parse_content_range(&content_range).ok_or_else(|| "播客音频断点响应范围无效".to_string())?;
    if start != offset {
      return Err("播客音频断点响应与本地进度不一致".to_string());
    }
    append = true;
    resumed = true;
  } else if status == StatusCode::PARTIAL_CONTENT {
    let content_range = header_text(public_response.response.headers(), header::CONTENT_RANGE)
      .ok_or_else(|| "播客音频响应缺少范围信息".to_string())?;
    let (start, _, _) = parse_content_range(&content_range).ok_or_else(|| "播客音频响应范围无效".to_string())?;
    if start != 0 {
      return Err("播客音频响应没有从文件开头开始".to_string());
    }
    offset = 0;
  } else {
    offset = 0;
  }

  let response_total = header_text(public_response.response.headers(), header::CONTENT_RANGE)
    .and_then(|value| parse_content_range(&value).and_then(|(_, _, total)| total))
    .or_else(|| {
      public_response
        .response
        .content_length()
        .and_then(|length| offset.checked_add(length))
    });
  if response_total.is_some_and(|total| total > PODCAST_AUDIO_RESPONSE_LIMIT) {
    return Err("播客音频超过大小限制".to_string());
  }

  let db_path_owned = db_path.to_path_buf();
  let progress_id = episode_id.to_string();
  let total_for_db = response_total;
  tauri::async_runtime::spawn_blocking(move || {
    mark_download_started(&db_path_owned, &progress_id, offset, total_for_db)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))??;

  let mut options = tokio::fs::OpenOptions::new();
  options.create(true).write(true);
  if append {
    options.append(true);
  } else {
    options.truncate(true);
  }
  let mut file = options
    .open(&part_path)
    .await
    .map_err(|error| format!("无法创建播客下载文件：{error}"))?;
  let mut response = public_response.response;
  let mut downloaded_bytes = offset;
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|error| format!("无法读取播客音频响应：{error}"))?
  {
    downloaded_bytes = downloaded_bytes
      .checked_add(chunk.len() as u64)
      .ok_or_else(|| "播客音频大小无效".to_string())?;
    if downloaded_bytes > PODCAST_AUDIO_RESPONSE_LIMIT {
      return Err("播客音频超过大小限制".to_string());
    }
    file
      .write_all(&chunk)
      .await
      .map_err(|error| format!("无法写入播客下载文件：{error}"))?;
  }
  file
    .flush()
    .await
    .map_err(|error| format!("无法完成播客下载文件：{error}"))?;
  drop(file);

  if downloaded_bytes == 0 {
    return Err("播客音频内容为空".to_string());
  }
  let extension = detect_audio_extension(&part_path).await?;
  let final_path = downloads_dir.join(format!("{episode_id}.{extension}"));
  if tokio::fs::metadata(&final_path).await.is_ok() {
    tokio::fs::remove_file(&final_path)
      .await
      .map_err(|error| format!("无法替换旧的播客下载：{error}"))?;
  }
  tokio::fs::rename(&part_path, &final_path)
    .await
    .map_err(|error| format!("无法完成播客下载：{error}"))?;
  let local_path = final_path.to_string_lossy().to_string();

  let db_path_owned = db_path.to_path_buf();
  let completed_id = episode_id.to_string();
  let completed_path = local_path.clone();
  tauri::async_runtime::spawn_blocking(move || {
    mark_download_complete(
      &db_path_owned,
      &completed_id,
      &completed_path,
      downloaded_bytes,
      response_total.or(Some(downloaded_bytes)),
    )
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))??;

  Ok(PodcastDownloadResult {
    episode_id: episode_id.to_string(),
    local_path,
    downloaded_bytes,
    resumed,
  })
}

fn mark_download_started(
  db_path: &Path,
  episode_id: &str,
  downloaded_bytes: u64,
  total_bytes: Option<u64>,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  connection
    .execute(
      "
      INSERT INTO podcast_downloads (
        episode_id, local_path, state, downloaded_bytes, total_bytes,
        error_message, updated_at
      ) VALUES (?1, NULL, 'downloading', ?2, ?3, NULL, ?4)
      ON CONFLICT(episode_id) DO UPDATE SET
        state = 'downloading',
        downloaded_bytes = excluded.downloaded_bytes,
        total_bytes = COALESCE(excluded.total_bytes, podcast_downloads.total_bytes),
        error_message = NULL,
        updated_at = excluded.updated_at
      ",
      params![
        episode_id,
        i64::try_from(downloaded_bytes).unwrap_or(i64::MAX),
        total_bytes.and_then(|value| i64::try_from(value).ok()),
        unix_time_millis(),
      ],
    )
    .map_err(|error| format!("无法保存播客下载状态：{error}"))?;
  Ok(())
}

fn mark_download_complete(
  db_path: &Path,
  episode_id: &str,
  local_path: &str,
  downloaded_bytes: u64,
  total_bytes: Option<u64>,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  connection
    .execute(
      "
      INSERT INTO podcast_downloads (
        episode_id, local_path, state, downloaded_bytes, total_bytes,
        error_message, updated_at
      ) VALUES (?1, ?2, 'downloaded', ?3, ?4, NULL, ?5)
      ON CONFLICT(episode_id) DO UPDATE SET
        local_path = excluded.local_path,
        state = 'downloaded',
        downloaded_bytes = excluded.downloaded_bytes,
        total_bytes = excluded.total_bytes,
        error_message = NULL,
        updated_at = excluded.updated_at
      ",
      params![
        episode_id,
        local_path,
        i64::try_from(downloaded_bytes).unwrap_or(i64::MAX),
        total_bytes.and_then(|value| i64::try_from(value).ok()),
        unix_time_millis(),
      ],
    )
    .map_err(|error| format!("无法保存播客下载结果：{error}"))?;
  Ok(())
}

fn mark_download_failed(db_path: &Path, episode_id: &str, downloaded_bytes: u64, message: &str) -> Result<(), String> {
  let connection = open_database(db_path)?;
  connection
    .execute(
      "
      INSERT INTO podcast_downloads (
        episode_id, local_path, state, downloaded_bytes, total_bytes,
        error_message, updated_at
      ) VALUES (?1, NULL, 'failed', ?2, NULL, ?3, ?4)
      ON CONFLICT(episode_id) DO UPDATE SET
        state = 'failed',
        downloaded_bytes = excluded.downloaded_bytes,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at
      ",
      params![
        episode_id,
        i64::try_from(downloaded_bytes).unwrap_or(i64::MAX),
        truncate_chars(message, 1_000),
        unix_time_millis(),
      ],
    )
    .map_err(|error| format!("无法保存播客下载错误：{error}"))?;
  Ok(())
}

fn save_progress(db_path: &Path, episode_id: &str, position_seconds: f64, duration_seconds: f64) -> Result<(), String> {
  let connection = open_database(db_path)?;
  let exists = connection
    .query_row("SELECT 1 FROM podcast_episodes WHERE id = ?1", [episode_id], |_| Ok(()))
    .optional()
    .map_err(|error| format!("无法读取播客单集：{error}"))?
    .is_some();
  if !exists {
    return Err("播客单集不存在".to_string());
  }
  let clamped_position = if duration_seconds > 0.0 {
    position_seconds.min(duration_seconds)
  } else {
    position_seconds
  };
  let completed = duration_seconds > 0.0 && clamped_position / duration_seconds >= 0.95;
  connection
    .execute(
      "
      INSERT INTO podcast_progress (
        episode_id, position_seconds, duration_seconds, completed, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(episode_id) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        completed = MAX(podcast_progress.completed, excluded.completed),
        updated_at = excluded.updated_at
      ",
      params![
        episode_id,
        clamped_position,
        (duration_seconds > 0.0).then_some(duration_seconds),
        i64::from(completed),
        unix_time_millis(),
      ],
    )
    .map_err(|error| format!("无法保存播客播放进度：{error}"))?;
  Ok(())
}

async fn send_public_get(url: Url, timeout: Duration, range: Option<&str>) -> Result<PublicResponse, String> {
  send_public_get_with_policy(url, timeout, range, false).await
}

async fn send_public_get_with_policy(
  mut url: Url,
  timeout: Duration,
  range: Option<&str>,
  allow_private_network: bool,
) -> Result<PublicResponse, String> {
  for redirect_count in 0..=PODCAST_REDIRECT_LIMIT {
    validate_url_with_policy(&url, allow_private_network)?;
    let addresses = resolve_public_addresses(&url, allow_private_network).await?;
    let raw_host = url.host_str().ok_or_else(|| "播客请求地址缺少主机名".to_string())?;
    let host = host_without_ipv6_brackets(raw_host);
    let mut client_builder = reqwest::Client::builder()
      .user_agent(USER_AGENT)
      .connect_timeout(Duration::from_secs(10))
      .timeout(timeout)
      .redirect(reqwest::redirect::Policy::none())
      .no_proxy();
    if host.parse::<IpAddr>().is_err() {
      client_builder = client_builder.resolve_to_addrs(host, &addresses);
    }
    let client = client_builder
      .build()
      .map_err(|error| format!("无法初始化播客网络请求：{error}"))?;
    let mut request = client.get(url.clone()).header(header::ACCEPT, "*/*");
    if let Some(range) = range {
      request = request
        .header(header::RANGE, range)
        .header(header::ACCEPT_ENCODING, "identity");
    }
    let response = request.send().await.map_err(|error| {
      if error.is_timeout() {
        "播客来源响应超时".to_string()
      } else {
        format!("无法连接播客来源：{error}")
      }
    })?;
    if !response.status().is_redirection() {
      return Ok(PublicResponse {
        final_url: url,
        response,
      });
    }
    if redirect_count == PODCAST_REDIRECT_LIMIT {
      return Err("播客来源重定向次数过多".to_string());
    }
    let location = response
      .headers()
      .get(header::LOCATION)
      .and_then(|value| value.to_str().ok())
      .ok_or_else(|| "播客来源重定向地址无效".to_string())?;
    url = validate_podcast_redirect(&url, location, allow_private_network)?;
  }
  Err("播客来源重定向次数过多".to_string())
}

fn validate_podcast_redirect(
  current_url: &Url,
  location: &str,
  allow_private_network: bool,
) -> Result<Url, String> {
  let next_url = current_url
    .join(location)
    .map_err(|_| "播客来源重定向地址无效".to_string())?;
  if current_url.scheme() == "https" && next_url.scheme() == "http" {
    return Err("播客来源拒绝从 HTTPS 降级到 HTTP".to_string());
  }
  validate_url_with_policy(&next_url, allow_private_network)?;
  Ok(next_url)
}

async fn resolve_public_addresses(url: &Url, allow_private_network: bool) -> Result<Vec<SocketAddr>, String> {
  let host = url.host_str().ok_or_else(|| "播客请求地址缺少主机名".to_string())?;
  let host = host_without_ipv6_brackets(host);
  let port = url
    .port_or_known_default()
    .ok_or_else(|| "播客请求地址端口无效".to_string())?;
  let mut addresses = tokio::net::lookup_host((host, port))
    .await
    .map_err(|_| "无法解析播客来源地址".to_string())?
    .collect::<Vec<_>>();
  addresses.sort();
  addresses.dedup();
  // Clash-style fake-IP DNS is common on mainland Windows machines. It maps
  // hostnames into 198.18.0.0/15 and intercepts the subsequent connection.
  // Permit that range only for a hostname resolved by the OS; literal
  // benchmark-range URLs remain rejected by `validate_url_with_policy`.
  let hostname_uses_dns = host.parse::<IpAddr>().is_err();
  if addresses.is_empty()
    || (!allow_private_network
      && addresses.iter().any(|address| {
        !is_public_ip(address.ip())
          && !(hostname_uses_dns && is_fake_ip_proxy_address(address.ip()))
      }))
  {
    return Err("播客来源指向了不允许的网络地址".to_string());
  }
  Ok(addresses)
}

fn validate_public_url_shape(value: &str) -> Result<Url, String> {
  validate_url_shape_with_policy(value, false)
}

fn validate_url_shape_with_policy(value: &str, allow_private_network: bool) -> Result<Url, String> {
  let url = Url::parse(value.trim()).map_err(|_| "播客来源地址无效".to_string())?;
  validate_url_with_policy(&url, allow_private_network)?;
  Ok(url)
}

fn validate_url_with_policy(url: &Url, allow_private_network: bool) -> Result<(), String> {
  if !matches!(url.scheme(), "http" | "https")
    || url.host_str().is_none()
    || !url.username().is_empty()
    || url.password().is_some()
    || url.fragment().is_some()
  {
    return Err("播客来源地址不受支持".to_string());
  }
  let port = url
    .port_or_known_default()
    .ok_or_else(|| "播客来源地址端口无效".to_string())?;
  if !allow_private_network && !matches!(port, 80 | 443) {
    return Err("播客来源使用了不允许的端口".to_string());
  }
  let host = url.host_str().unwrap_or_default();
  let ip_text = host_without_ipv6_brackets(host);
  if let Ok(ip) = ip_text.parse::<IpAddr>() {
    if !allow_private_network && !is_public_ip(ip) {
      return Err("播客来源指向了不允许的网络地址".to_string());
    }
  }
  Ok(())
}

fn host_without_ipv6_brackets(host: &str) -> &str {
  host
    .strip_prefix('[')
    .and_then(|value| value.strip_suffix(']'))
    .unwrap_or(host)
}

fn is_public_ip(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(ip) => is_public_ipv4(ip),
    IpAddr::V6(ip) => is_public_ipv6(ip),
  }
}

fn is_fake_ip_proxy_address(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(ip) => {
      let octets = ip.octets();
      octets[0] == 198 && matches!(octets[1], 18 | 19)
    }
    IpAddr::V6(_) => false,
  }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
  let octets = ip.octets();
  !(octets[0] == 0
    || octets[0] == 10
    || octets[0] == 127
    || (octets[0] == 100 && (64..=127).contains(&octets[1]))
    || (octets[0] == 169 && octets[1] == 254)
    || (octets[0] == 172 && (16..=31).contains(&octets[1]))
    || (octets[0] == 192 && octets[1] == 168)
    || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
    || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
    || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
    || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
    || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
    || octets[0] >= 224)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
  if let Some(ipv4) = ip.to_ipv4() {
    return is_public_ipv4(ipv4);
  }
  let segments = ip.segments();
  !(ip.is_unspecified()
    || ip.is_loopback()
    || (segments[0] & 0xfe00) == 0xfc00
    || (segments[0] & 0xffc0) == 0xfe80
    || (segments[0] & 0xffc0) == 0xfec0
    || (segments[0] & 0xff00) == 0xff00
    || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

async fn read_limited(mut response: reqwest::Response, limit: usize, label: &str) -> Result<Vec<u8>, String> {
  if !response.status().is_success() {
    return Err(format!("{label}返回错误 {}", response.status().as_u16()));
  }
  if response.content_length().is_some_and(|length| length > limit as u64) {
    return Err(format!("{label}超过大小限制"));
  }
  let mut bytes = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|error| format!("无法读取{label}：{error}"))?
  {
    if bytes.len().saturating_add(chunk.len()) > limit {
      return Err(format!("{label}超过大小限制"));
    }
    bytes.extend_from_slice(&chunk);
  }
  Ok(bytes)
}

fn header_text(headers: &HeaderMap, name: header::HeaderName) -> Option<String> {
  headers
    .get(name)
    .and_then(|value| value.to_str().ok())
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}

fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
  let value = value.strip_prefix("bytes ")?;
  let (range, total) = value.split_once('/')?;
  let (start, end) = range.split_once('-')?;
  let start = start.parse::<u64>().ok()?;
  let end = end.parse::<u64>().ok()?;
  if start > end {
    return None;
  }
  let total = if total == "*" {
    None
  } else {
    Some(total.parse::<u64>().ok()?)
  };
  if total.is_some_and(|total| end >= total) {
    return None;
  }
  Some((start, end, total))
}

fn response_content_type_is_audio_candidate(response_type: Option<&str>, enclosure_type: Option<&str>) -> bool {
  let candidate = response_type.or(enclosure_type);
  let Some(candidate) = candidate else {
    return true;
  };
  let candidate = candidate
    .split(';')
    .next()
    .unwrap_or_default()
    .trim()
    .to_ascii_lowercase();
  candidate.starts_with("audio/") || matches!(candidate.as_str(), "application/octet-stream" | "binary/octet-stream")
}

async fn detect_audio_extension(path: &Path) -> Result<&'static str, String> {
  let mut file = tokio::fs::File::open(path)
    .await
    .map_err(|error| format!("无法检查播客音频：{error}"))?;
  let mut prefix = [0u8; 32];
  let length = file
    .read(&mut prefix)
    .await
    .map_err(|error| format!("无法检查播客音频：{error}"))?;
  let bytes = &prefix[..length];
  if bytes.starts_with(b"fLaC") {
    return Ok("flac");
  }
  if bytes.starts_with(b"OggS") {
    return Ok("ogg");
  }
  if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
    return Ok("wav");
  }
  if bytes.get(4..12).is_some_and(|value| value.starts_with(b"ftyp")) {
    return Ok("m4a");
  }
  if bytes
    .get(0..2)
    .is_some_and(|value| value[0] == 0xff && value[1] & 0xf6 == 0xf0)
  {
    return Ok("aac");
  }
  if bytes.starts_with(b"ID3")
    || bytes
      .get(0..2)
      .is_some_and(|value| value[0] == 0xff && value[1] & 0xe0 == 0xe0 && value[1] & 0x06 != 0)
  {
    return Ok("mp3");
  }
  Err("下载内容不是受支持的音频格式".to_string())
}

fn is_managed_download_path(downloads_dir: &Path, episode_id: &str, path: &Path) -> bool {
  path.parent() == Some(downloads_dir)
    && path
      .file_stem()
      .and_then(|value| value.to_str())
      .is_some_and(|value| value == episode_id)
    && path.extension().and_then(|value| value.to_str()).is_some_and(|value| {
      matches!(
        value.to_ascii_lowercase().as_str(),
        "mp3" | "flac" | "m4a" | "aac" | "wav" | "ogg"
      )
    })
}

fn validate_identifier(value: &str) -> Result<(), String> {
  if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return Err("播客标识无效".to_string());
  }
  Ok(())
}

fn hash_identifier(namespace: &str, values: &[&str]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(namespace.as_bytes());
  for value in values {
    hasher.update([0]);
    hasher.update(value.as_bytes());
  }
  hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn normalize_url(value: &str) -> Result<String, String> {
  let mut url = validate_public_url_shape(value)?;
  url.set_fragment(None);
  Ok(url.to_string())
}

fn clean_url_string(value: &str) -> Option<String> {
  validate_public_url_shape(value).ok().map(|url| url.to_string())
}

fn clean_hint(value: Option<&str>, limit: usize) -> Option<String> {
  value.and_then(|value| clean_text(value, limit))
}

fn clean_optional(value: Option<String>, limit: usize) -> Option<String> {
  value.and_then(|value| clean_text(&value, limit))
}

fn clean_text(value: &str, limit: usize) -> Option<String> {
  let value = truncate_chars(value.trim(), limit);
  (!value.is_empty()).then_some(value)
}

fn plain_text(value: &str, limit: usize) -> String {
  let mut output = String::new();
  let mut inside_tag = false;
  let mut pending_space = false;
  let mut output_characters = 0usize;
  for character in value.chars() {
    match character {
      '<' => inside_tag = true,
      '>' if inside_tag => {
        inside_tag = false;
        pending_space = true;
      }
      _ if inside_tag => {}
      _ if character.is_whitespace() => {
        pending_space = true;
      }
      _ => {
        if pending_space && !output.is_empty() && output_characters < limit {
          output.push(' ');
          output_characters += 1;
        }
        if output_characters >= limit {
          break;
        }
        output.push(character);
        output_characters += 1;
        pending_space = false;
      }
    }
    if output_characters >= limit {
      break;
    }
  }
  output
    .replace("&amp;", "&")
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .trim()
    .to_string()
}

fn truncate_chars(value: &str, limit: usize) -> String {
  value.chars().take(limit).collect()
}

fn unix_time_millis() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .ok()
    .and_then(|duration| i64::try_from(duration.as_millis()).ok())
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::SystemTime;
  use tokio::net::TcpListener;

  fn test_directory(name: &str) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
    let directory = std::env::temp_dir().join(format!("zone-podcast-{name}-{}-{stamp}", std::process::id(),));
    fs::create_dir_all(&directory).expect("create test directory");
    directory
  }

  fn rss_fixture(enclosure_url: &str) -> Vec<u8> {
    format!(
      r#"<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
        <channel>
          <title>Zone 测试播客</title>
          <description><![CDATA[<p>一档 <strong>本地优先</strong> 的节目。</p>]]></description>
          <itunes:author>Zone 主播</itunes:author>
          <itunes:image href="https://cdn.example.test/show.jpg" />
          <item>
            <guid isPermaLink="false">episode-one</guid>
            <title>第一集</title>
            <description><![CDATA[<p>第一集的 <em>简介</em></p>]]></description>
            <pubDate>Sat, 25 Jul 2026 08:00:00 +0000</pubDate>
            <itunes:duration>01:02:03</itunes:duration>
            <enclosure url="{enclosure_url}" length="23" type="audio/mpeg" />
          </item>
        </channel>
      </rss>"#
    )
    .into_bytes()
  }

  fn artwork_request(method: Method, url: &str) -> Request<Vec<u8>> {
    let token = URL_SAFE_NO_PAD.encode(url.as_bytes());
    Request::builder()
      .method(method)
      .uri(format!("zone-podcast-artwork://localhost/{token}"))
      .body(Vec::new())
      .expect("build artwork request")
  }

  #[test]
  fn podcast_artwork_tokens_preserve_queries_and_reject_private_targets() {
    let public_url = "https://cdn.example.test/cover.jpg?size=600&token=a%2Fb";
    let public_request = artwork_request(Method::GET, public_url);
    let decoded = decode_podcast_artwork_url(&public_request, false).expect("decode public artwork");
    assert_eq!(decoded.as_str(), public_url);

    let private_request = artwork_request(Method::GET, "http://127.0.0.1/router.png");
    assert!(decode_podcast_artwork_url(&private_request, false).is_err());
  }

  #[test]
  fn podcast_artwork_requires_supported_mime_and_matching_magic() {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "image/png; charset=binary".parse().expect("content type"));
    assert_eq!(
      podcast_artwork_content_type(&headers).expect("supported content type"),
      "image/png",
    );
    assert!(podcast_artwork_magic_matches("image/png", b"\x89PNG\r\n\x1a\nfixture"));
    assert!(!podcast_artwork_magic_matches("image/png", b"<html>not an image</html>"));

    headers.insert(header::CONTENT_TYPE, "image/svg+xml".parse().expect("svg content type"));
    assert!(podcast_artwork_content_type(&headers).is_err());
  }

  #[tokio::test]
  async fn podcast_artwork_protocol_proxies_valid_images_with_cors() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind artwork server");
    let address = listener.local_addr().expect("artwork server address");
    let image = b"\x89PNG\r\n\x1a\nzone-artwork".to_vec();
    let server_image = image.clone();
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.expect("accept artwork request");
      let mut request = vec![0u8; 8_192];
      let read = stream.read(&mut request).await.expect("read artwork request");
      let request = String::from_utf8_lossy(&request[..read]);
      assert!(request.starts_with("GET /cover.png?token=zone HTTP/1.1"), "{request}");
      let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        server_image.len(),
      );
      stream.write_all(headers.as_bytes()).await.expect("write artwork headers");
      stream.write_all(&server_image).await.expect("write artwork body");
      stream.shutdown().await.expect("shutdown artwork response");
    });

    let request = artwork_request(Method::GET, &format!("http://{address}/cover.png?token=zone"));
    let response = serve_podcast_artwork_protocol_with_network_policy(request, true).await;
    server.await.expect("artwork server task");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
      response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|value| value.to_str().ok()),
      Some("*"),
    );
    assert_eq!(
      response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok()),
      Some("image/png"),
    );
    assert_eq!(response.body(), &image);
  }

  fn parsed_fixture(enclosure_url: &str) -> ParsedPodcast {
    parse_feed_bytes(
      &rss_fixture(enclosure_url),
      "https://feeds.example.test/show.xml",
      Some("提示标题"),
      Some("提示作者"),
      Some("https://cdn.example.test/hint.jpg"),
      Some("\"etag-one\"".to_string()),
      Some("Sat, 25 Jul 2026 08:00:00 GMT".to_string()),
    )
    .expect("parse fixture")
  }

  fn parse_test_feed(xml: &str, name: &str) -> ParsedPodcast {
    parse_feed_bytes(
      xml.as_bytes(),
      &format!("https://feeds.example.test/{name}.xml"),
      None,
      None,
      None,
      None,
      None,
    )
    .unwrap_or_else(|error| panic!("parse {name} fixture: {error}"))
  }

  fn parsed_fixture_with_episode_count(count: usize) -> ParsedPodcast {
    let mut parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let template = parsed.episodes[0].clone();
    for index in 1..count {
      let identity_key = format!("guid:episode-{}", index + 1);
      let mut episode = template.clone();
      episode.id = hash_identifier("episode", &[&parsed.feed.id, &identity_key]);
      episode.identity_key = identity_key;
      episode.guid = Some(format!("episode-{}", index + 1));
      episode.title = format!("第{}集", index + 1);
      episode.published_at = template
        .published_at
        .map(|timestamp| timestamp.saturating_sub(i64::try_from(index).unwrap_or(0) * 86_400_000));
      episode.enclosure_url = format!("https://media.example.test/episode-{}.mp3", index + 1);
      parsed.episodes.push(episode);
    }
    parsed
  }

  #[test]
  fn public_url_validation_rejects_local_credentials_fragments_and_ports() {
    assert!(validate_public_url_shape("https://example.com/feed.xml").is_ok());
    assert!(validate_public_url_shape("http://93.184.216.34/audio.mp3").is_ok());
    assert!(validate_public_url_shape("http://127.0.0.1/feed.xml").is_err());
    assert!(validate_public_url_shape("http://10.0.0.8/feed.xml").is_err());
    assert!(validate_public_url_shape("http://198.18.1.204/feed.xml").is_err());
    assert!(validate_public_url_shape("http://[::1]/feed.xml").is_err());
    assert!(validate_public_url_shape("https://user:pass@example.com/feed.xml").is_err());
    assert!(validate_public_url_shape("https://example.com/feed.xml#part").is_err());
    assert!(validate_public_url_shape("https://example.com:8443/feed.xml").is_err());
    assert!(validate_public_url_shape("file:///tmp/feed.xml").is_err());
  }

  #[test]
  fn public_ip_filter_covers_ipv4_and_ipv6_special_ranges() {
    assert!(is_public_ip("8.8.8.8".parse().expect("ipv4")));
    assert!(is_public_ip("2606:4700:4700::1111".parse().expect("ipv6")));
    for value in [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.168.0.1",
      "198.18.1.204",
      "198.51.100.1",
      "224.0.0.1",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ] {
      assert!(!is_public_ip(value.parse().expect("special IP")), "{value}");
    }
    assert!(is_fake_ip_proxy_address("198.18.1.204".parse().expect("fake IP")));
    assert!(!is_fake_ip_proxy_address("192.168.0.1".parse().expect("private IP")));
  }

  #[test]
  fn podcast_redirects_reject_private_targets_and_https_downgrades() {
    let source = Url::parse("https://media.example.test/episode.mp3").expect("source URL");
    assert!(validate_podcast_redirect(&source, "https://127.0.0.1/private.mp3", false).is_err());
    assert!(validate_podcast_redirect(&source, "https://198.18.1.20/fake-ip.mp3", false).is_err());
    assert!(validate_podcast_redirect(&source, "http://media.example.test/episode.mp3", false).is_err());
    assert_eq!(
      validate_podcast_redirect(&source, "/redirected.mp3", false)
        .expect("safe redirect")
        .as_str(),
      "https://media.example.test/redirected.mp3",
    );
  }

  #[test]
  fn podcast_stream_ranges_are_single_and_capped() {
    assert_eq!(
      parse_podcast_stream_range(None).expect("default range"),
      PodcastStreamRange::Bounded {
        start: 0,
        end: PODCAST_STREAM_CHUNK_SIZE - 1,
      },
    );
    assert_eq!(
      parse_podcast_stream_range(Some("bytes=10-20")).expect("bounded range"),
      PodcastStreamRange::Bounded { start: 10, end: 20 },
    );
    assert_eq!(
      parse_podcast_stream_range(Some("bytes=10-")).expect("open range"),
      PodcastStreamRange::Bounded {
        start: 10,
        end: 10 + PODCAST_STREAM_CHUNK_SIZE - 1,
      },
    );
    assert_eq!(
      parse_podcast_stream_range(Some("bytes=-999999999")).expect("suffix range"),
      PodcastStreamRange::Suffix {
        length: PODCAST_STREAM_CHUNK_SIZE,
      },
    );
    assert!(parse_podcast_stream_range(Some("bytes=0-1,4-5")).is_err());
    assert!(parse_podcast_stream_range(Some("items=0-10")).is_err());
    assert!(parse_podcast_stream_range(Some("bytes=20-10")).is_err());
    assert!(parse_podcast_stream_range(Some("bytes=-0")).is_err());
  }

  #[test]
  fn apple_discovery_keeps_chart_order_and_joins_lookup_feed_urls() {
    let chart = serde_json::from_slice::<AppleDiscoveryResponse>(
      r#"{
        "feed": {
          "results": [
            {
              "id": "111",
              "name": "第一档",
              "artistName": "甲",
              "artworkUrl100": "https://img.example.test/111-small.jpg",
              "genres": [{"name": "文化"}, {"name": "文化"}]
            },
            {
              "id": "222",
              "name": "缺少订阅源",
              "artistName": "乙",
              "genres": []
            },
            {
              "id": "333",
              "name": "第三档",
              "artistName": "丙",
              "genres": [{"name": "新闻"}]
            }
          ]
        }
      }"#
        .as_bytes(),
    )
    .expect("parse chart fixture");
    let lookup = r#"{
      "resultCount": 3,
      "results": [
        {
          "collectionId": 333,
          "collectionName": "第三档 lookup",
          "artistName": "丙 lookup",
          "feedUrl": "https://feeds.example.test/333.xml",
          "artworkUrl600": "https://img.example.test/333-large.jpg"
        },
        {
          "collectionId": 222,
          "collectionName": "第二档",
          "artistName": "乙",
          "artworkUrl600": "https://img.example.test/222-large.jpg"
        },
        {
          "collectionId": 111,
          "collectionName": "第一档 lookup",
          "artistName": "甲 lookup",
          "feedUrl": "https://feeds.example.test/111.xml",
          "artworkUrl600": "https://img.example.test/111-large.jpg"
        }
      ]
    }"#;

    let shows = parse_apple_discovery(chart, lookup.as_bytes(), 3).expect("join Apple discovery");
    assert_eq!(shows.len(), 2);
    assert_eq!(shows[0].id, "111");
    assert_eq!(shows[0].rank, 1);
    assert_eq!(shows[0].title, "第一档");
    assert_eq!(shows[0].author, "甲");
    assert_eq!(shows[0].genres, vec!["文化"]);
    assert_eq!(
      shows[0].artwork_url.as_deref(),
      Some("https://img.example.test/111-large.jpg")
    );
    assert_eq!(shows[1].id, "333");
    assert_eq!(shows[1].rank, 3);
    assert_eq!(shows[1].feed_url, "https://feeds.example.test/333.xml");
  }

  #[test]
  fn rss_feed_is_normalized_to_stable_feed_and_episode_records() {
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    assert_eq!(parsed.feed.title, "Zone 测试播客");
    assert_eq!(parsed.feed.author.as_deref(), Some("Zone 主播"));
    assert_eq!(parsed.feed.description.as_deref(), Some("一档 本地优先 的节目。"));
    assert_eq!(parsed.feed.id.len(), 64);
    assert_eq!(parsed.episodes.len(), 1);
    let episode = &parsed.episodes[0];
    assert_eq!(episode.title, "第一集");
    assert_eq!(episode.description.as_deref(), Some("第一集的 简介"));
    assert_eq!(episode.duration_seconds, Some(3_723.0));
    assert_eq!(episode.enclosure_type.as_deref(), Some("audio/mpeg"));
    assert_eq!(episode.expected_bytes, Some(23));
    assert_eq!(episode.id.len(), 64);
  }

  #[test]
  fn chinese_hosting_feed_shapes_preserve_metadata_and_audio_urls() {
    let cdata_feed = r#"<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"
        xmlns:content="http://purl.org/rss/1.0/modules/content/"
        xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
        <channel>
          <title><![CDATA[方向之间]]></title>
          <description><![CDATA[<p>一档中文谈话节目</p>]]></description>
          <pubDate>Mon, 01 Dec 2025 01:00:00 +0000</pubDate>
          <itunes:author><![CDATA[测试播客厂牌]]></itunes:author>
          <item>
            <guid><![CDATA[episode-380]]></guid>
            <title><![CDATA[380 城市与公共空间]]></title>
            <pubDate><![CDATA[Sat, 04 Jul 2026 01:00:00 +0000]]></pubDate>
            <content:encoded><![CDATA[<p>本期节目讨论城市生活。</p>]]></content:encoded>
            <enclosure
              url="https://tracking.example.test/audio.example.test/episodes/380.m4a?source=feed&amp;token=a%2Fb"
              length="230000"
              type="audio/mp4" />
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(cdata_feed, "cdata");
    assert_eq!(parsed.feed.title, "方向之间");
    assert_eq!(parsed.feed.author.as_deref(), Some("测试播客厂牌"));
    assert_eq!(parsed.episodes[0].title, "380 城市与公共空间");
    assert_eq!(parsed.episodes[0].published_at, Some(1_783_126_800_000));
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://tracking.example.test/audio.example.test/episodes/380.m4a?source=feed&token=a%2Fb"
    );

    let nested_url_feed = r#"<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>山海晨间</title>
          <description>通勤资讯</description>
          <item>
            <guid>episode-42</guid>
            <title>第 42 期</title>
            <pubDate>Sat, 4 Jul 2026 01:00:00 +0000</pubDate>
            <enclosure
              url="http://audio.example.test//group/42.m4a?source=rss&amp;jt=https%3A%2F%2Fjump.example.test%2F42"
              length="420000"
              type="audio/x-m4a" />
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(nested_url_feed, "nested-url");
    assert_eq!(parsed.episodes[0].published_at, Some(1_783_126_800_000));
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "http://audio.example.test//group/42.m4a?source=rss&jt=https%3A%2F%2Fjump.example.test%2F42"
    );
  }

  #[test]
  fn mixed_rss_and_media_enclosures_are_deduplicated() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
        <channel>
          <title>多媒体测试节目</title>
          <description>验证音频选择</description>
          <item>
            <guid>mixed-one</guid>
            <title>同时提供两种音频</title>
            <enclosure url="https://audio.example.test/preferred.mp3" length="100" type="audio/mpeg" />
            <media:content url="https://img.example.test/cover.jpg" type="image/jpeg" />
            <media:content url="https://audio.example.test/fallback.m4a" type="audio/mp4" />
          </item>
          <item>
            <guid>media-only</guid>
            <title>只有 Media RSS 音频</title>
            <media:content url="https://img.example.test/second-cover.jpg" type="image/jpeg" />
            <media:content url="https://audio.example.test/media-only.m4a" type="audio/mp4" fileSize="200" duration="61" />
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(xml, "mixed-enclosures");
    assert_eq!(parsed.episodes.len(), 2);
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://audio.example.test/preferred.mp3"
    );
    assert_eq!(
      parsed.episodes[1].enclosure_url,
      "https://audio.example.test/media-only.m4a"
    );
    assert_eq!(parsed.episodes[1].expected_bytes, Some(200));
    assert_eq!(parsed.episodes[1].duration_seconds, Some(61.0));
  }

  #[test]
  fn atom_enclosure_is_supported() {
    let atom = r#"<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <id>urn:zone:test</id>
        <title>Atom 节目</title>
        <updated>2026-07-25T08:00:00Z</updated>
        <entry>
          <id>urn:zone:episode</id>
          <title>Atom 单集</title>
          <updated>2026-07-25T08:00:00Z</updated>
          <link rel="enclosure" type="audio/mp4" href="https://media.example.test/episode.m4a" length="128" />
        </entry>
      </feed>"#;
    let parsed = parse_feed_bytes(
      atom.as_bytes(),
      "https://feeds.example.test/atom.xml",
      None,
      None,
      None,
      None,
      None,
    )
    .expect("parse atom");
    assert_eq!(parsed.feed.title, "Atom 节目");
    assert_eq!(parsed.episodes.len(), 1);
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://media.example.test/episode.m4a"
    );
  }

  #[test]
  fn feed_without_audio_is_rejected() {
    let rss = r#"<?xml version="1.0"?>
      <rss version="2.0"><channel><title>空节目</title>
      <description>empty</description><link>https://example.test</link>
      <item><guid>text-only</guid><title>文章</title></item>
      </channel></rss>"#;
    assert!(parse_feed_bytes(
      rss.as_bytes(),
      "https://feeds.example.test/empty.xml",
      None,
      None,
      None,
      None,
      None,
    )
    .is_err());
  }

  #[test]
  fn legacy_database_migration_marks_existing_feeds_as_subscribed() {
    let directory = test_directory("legacy-migration");
    let db_path = directory.join("podcasts.sqlite");
    {
      let connection = Connection::open(&db_path).expect("open legacy database");
      connection
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
            last_fetched_at INTEGER NOT NULL
          );
          INSERT INTO podcast_feeds (
            id, feed_url, title, author, description, artwork_url,
            etag, last_modified, last_fetched_at
          ) VALUES (
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'https://feeds.example.test/legacy.xml',
            '旧版节目',
            NULL, NULL, NULL, NULL, NULL, 1
          );
          ",
        )
        .expect("create legacy schema");
    }

    {
      let connection = open_database(&db_path).expect("migrate database");
      let subscribed = connection
        .query_row(
          "SELECT subscribed FROM podcast_feeds WHERE title = '旧版节目'",
          [],
          |row| row.get::<_, i64>(0),
        )
        .expect("read migrated subscription");
      assert_eq!(subscribed, 1);
      for table in ["podcast_saved_episodes", "podcast_queue"] {
        let exists = connection
          .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
          )
          .optional()
          .expect("inspect migrated table")
          .is_some();
        assert!(exists, "{table} should be created during migration");
      }
    }
    let feeds = list_feeds(&db_path).expect("list migrated feeds");
    assert_eq!(feeds.len(), 1);
    assert!(feeds[0].subscribed);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn preview_does_not_pollute_library_and_following_controls_home_latest() {
    let directory = test_directory("preview-home");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let episode_id = parsed.episodes[0].id.clone();

    let preview = store_preview(&state.db_path, parsed.clone()).expect("store preview");
    assert!(!preview.feed.subscribed);
    assert!(list_feeds(&state.db_path).expect("list preview feeds").is_empty());
    let preview_home = list_home(&state.db_path, &state.downloads_dir).expect("preview home");
    assert!(preview_home.continue_listening.is_empty());
    assert!(preview_home.latest_episodes.is_empty());
    assert!(preview_home.downloaded_episodes.is_empty());
    assert!(preview_home.saved_episodes.is_empty());

    let followed = store_subscription(&state.db_path, parsed.clone()).expect("follow preview");
    assert!(followed.feed.subscribed);
    let refreshed = store_preview(&state.db_path, parsed).expect("refresh followed preview");
    assert!(refreshed.feed.subscribed);
    assert_eq!(list_feeds(&state.db_path).expect("list followed feeds").len(), 1);
    let followed_home = list_home(&state.db_path, &state.downloads_dir).expect("followed home");
    assert_eq!(followed_home.latest_episodes.len(), 1);
    assert_eq!(
      followed_home.latest_episodes[0].feed_title.as_deref(),
      Some("Zone 测试播客")
    );

    save_progress(&state.db_path, &episode_id, 30.0, 100.0).expect("save unfinished progress");
    let local_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
    fs::write(&local_path, b"ID3-home-download").expect("write managed download");
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &local_path.to_string_lossy(),
      17,
      Some(17),
    )
    .expect("save managed download");
    set_following(&state.db_path, &feed_id, false).expect("unfollow feed");

    assert!(list_feeds(&state.db_path).expect("list unfollowed feeds").is_empty());
    let unfollowed_home = list_home(&state.db_path, &state.downloads_dir).expect("unfollowed home");
    assert!(unfollowed_home.latest_episodes.is_empty());
    assert_eq!(unfollowed_home.continue_listening.len(), 1);
    assert_eq!(unfollowed_home.downloaded_episodes.len(), 1);
    assert_eq!(
      unfollowed_home.downloaded_episodes[0].local_path.as_deref(),
      Some(local_path.to_string_lossy().as_ref())
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn episode_lists_hide_unmanaged_or_missing_download_paths() {
    let directory = test_directory("download-path-security");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let outside_path = directory.join(format!("{episode_id}.mp3"));
    fs::write(&outside_path, b"ID3-outside-download").expect("write outside download");
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &outside_path.to_string_lossy(),
      20,
      Some(20),
    )
    .expect("save tampered download path");

    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &feed_id).expect("list episodes");
    assert_eq!(episodes[0].download_state, "none");
    assert!(episodes[0].local_path.is_none());
    assert_eq!(episodes[0].downloaded_bytes, 0);

    let missing_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &missing_path.to_string_lossy(),
      20,
      Some(20),
    )
    .expect("save missing managed path");
    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &feed_id).expect("list missing episode");
    assert_eq!(episodes[0].download_state, "none");
    assert!(episodes[0].local_path.is_none());

    let home = list_home(&state.db_path, &state.downloads_dir).expect("list home");
    assert!(home.downloaded_episodes.is_empty());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn sqlite_subscription_download_and_progress_round_trip() {
    let directory = test_directory("database");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    let first = store_subscription(&state.db_path, parsed.clone()).expect("first subscribe");
    assert_eq!(first.episode_count, 1);
    assert_eq!(first.inserted_count, 1);
    let second = store_subscription(&state.db_path, parsed).expect("second subscribe");
    assert_eq!(second.inserted_count, 0);
    assert_eq!(list_feeds(&state.db_path).expect("list feeds").len(), 1);

    save_progress(&state.db_path, &episode_id, 120.0, 100.0).expect("save progress");
    let fake_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
    fs::write(&fake_path, b"ID3-test-download").expect("write managed download");
    mark_download_complete(&state.db_path, &episode_id, &fake_path.to_string_lossy(), 23, Some(23))
      .expect("save download");
    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &first.feed.id).expect("list episodes");
    assert_eq!(episodes.len(), 1);
    assert_eq!(episodes[0].progress_seconds, 100.0);
    assert!(episodes[0].completed);
    assert_eq!(episodes[0].download_state, "downloaded");
    assert_eq!(episodes[0].downloaded_bytes, 23);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn saved_episode_detail_and_home_state_round_trip_across_refresh_and_restart() {
    let directory = test_directory("saved-detail");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed.clone()).expect("store subscription");

    let initial = get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("initial detail");
    assert_eq!(initial.feed.id, feed_id);
    assert_eq!(initial.feed.title, "Zone 测试播客");
    assert_eq!(initial.expected_bytes, Some(23));
    assert!(!initial.saved);
    assert!(!initial.episode.saved);
    assert!(initial.saved_at.is_none());
    assert!(initial.queue_position.is_none());

    set_episode_saved(&state.db_path, &episode_id, true).expect("save episode");
    let first_saved =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("saved detail");
    let saved_at = first_saved.saved_at.expect("saved timestamp");
    assert!(first_saved.saved);
    assert!(first_saved.episode.saved);

    set_episode_saved(&state.db_path, &episode_id, true).expect("save episode idempotently");
    let second_saved =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("resaved detail");
    assert_eq!(second_saved.saved_at, Some(saved_at));
    assert_eq!(
      list_saved_episodes(&state.db_path, &state.downloads_dir)
        .expect("list saved")
        .len(),
      1
    );
    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &feed_id).expect("list feed episodes");
    assert!(episodes[0].saved);
    let home = list_home(&state.db_path, &state.downloads_dir).expect("list home");
    assert_eq!(home.saved_episodes.len(), 1);
    assert!(home.saved_episodes[0].saved);
    assert!(home.latest_episodes[0].saved);

    store_subscription(&state.db_path, parsed).expect("refresh subscription");
    set_following(&state.db_path, &feed_id, false).expect("unfollow feed");
    let reopened = PodcastState::initialize_at(&directory).expect("reopen podcast state");
    let after_restart =
      get_episode_detail(&reopened.db_path, &reopened.downloads_dir, &episode_id).expect("detail after restart");
    assert!(after_restart.saved);
    assert_eq!(after_restart.saved_at, Some(saved_at));

    set_episode_saved(&reopened.db_path, &episode_id, false).expect("unsave episode");
    let unsaved =
      get_episode_detail(&reopened.db_path, &reopened.downloads_dir, &episode_id).expect("unsaved detail");
    assert!(!unsaved.saved);
    assert!(!unsaved.episode.saved);
    assert!(list_saved_episodes(&reopened.db_path, &reopened.downloads_dir)
      .expect("list unsaved")
      .is_empty());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn played_and_unplayed_markers_reuse_progress_without_touching_other_state() {
    let directory = test_directory("played-state");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    set_episode_saved(&state.db_path, &episode_id, true).expect("save episode");
    queue_add(&state.db_path, &episode_id, false).expect("queue episode");
    save_progress(&state.db_path, &episode_id, 30.0, 100.0).expect("save progress");

    set_episode_played(&state.db_path, &episode_id, true).expect("mark played");
    let played =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("played detail");
    assert!(played.episode.completed);
    assert_eq!(played.episode.progress_seconds, 100.0);
    assert!(played.saved);
    assert_eq!(played.queue_position, Some(0));
    assert!(list_home(&state.db_path, &state.downloads_dir)
      .expect("home after played")
      .continue_listening
      .is_empty());
    save_progress(&state.db_path, &episode_id, 45.0, 100.0)
      .expect("ongoing playback must not undo an explicit played marker");
    assert!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
        .expect("played detail after progress")
        .episode
        .completed
    );

    set_episode_played(&state.db_path, &episode_id, false).expect("mark unplayed");
    let unplayed =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("unplayed detail");
    assert!(!unplayed.episode.completed);
    assert_eq!(unplayed.episode.progress_seconds, 0.0);
    assert!(unplayed.saved);
    assert_eq!(unplayed.queue_position, Some(0));
    let progress_exists = open_database(&state.db_path)
      .expect("open database")
      .query_row(
        "SELECT 1 FROM podcast_progress WHERE episode_id = ?1",
        [&episode_id],
        |_| Ok(()),
      )
      .optional()
      .expect("inspect progress")
      .is_some();
    assert!(!progress_exists);
    save_progress(&state.db_path, &episode_id, 45.0, 100.0)
      .expect("progress after marking unplayed");
    assert!(
      !get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
        .expect("unplayed detail after progress")
        .episode
        .completed
    );

    set_episode_played(&state.db_path, &episode_id, false)
      .expect("clear progress before using feed duration");
    set_episode_played(&state.db_path, &episode_id, true).expect("mark played from feed duration");
    let played_from_feed =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("played from feed detail");
    assert_eq!(played_from_feed.episode.progress_seconds, 3_723.0);
    assert!(set_episode_played(&state.db_path, &"f".repeat(64), true).is_err());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn queue_is_ordered_deduplicated_reorder_safe_and_persistent() {
    let directory = test_directory("queue");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    queue_add(&state.db_path, &ids[0], false).expect("append first");
    queue_add(&state.db_path, &ids[1], false).expect("append second");
    queue_add(&state.db_path, &ids[0], false).expect("deduplicate first");
    queue_add(&state.db_path, &ids[2], true).expect("play third next");
    set_episode_saved(&state.db_path, &ids[1], true).expect("save queued episode");
    let initial = list_queue(&state.db_path, &state.downloads_dir).expect("list initial queue");
    assert_eq!(
      initial
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      vec![ids[2].as_str(), ids[0].as_str(), ids[1].as_str()]
    );
    assert_eq!(
      initial.iter().map(|item| item.position).collect::<Vec<_>>(),
      vec![0, 1, 2]
    );
    assert!(initial[2].episode.saved);

    let reordered = vec![ids[1].clone(), ids[2].clone(), ids[0].clone()];
    queue_reorder(&state.db_path, &reordered).expect("reorder queue");
    let after_reorder = list_queue(&state.db_path, &state.downloads_dir).expect("list reordered queue");
    assert_eq!(
      after_reorder
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      reordered.iter().map(String::as_str).collect::<Vec<_>>()
    );

    assert!(queue_reorder(&state.db_path, &reordered[..2]).is_err());
    assert!(validate_queue_identifiers(&[ids[0].clone(), ids[0].clone()]).is_err());
    let unchanged = list_queue(&state.db_path, &state.downloads_dir).expect("list unchanged queue");
    assert_eq!(
      unchanged
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      reordered.iter().map(String::as_str).collect::<Vec<_>>()
    );

    let reopened = PodcastState::initialize_at(&directory).expect("reopen podcast state");
    let persisted = list_queue(&reopened.db_path, &reopened.downloads_dir).expect("list persisted queue");
    assert_eq!(
      persisted
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      reordered.iter().map(String::as_str).collect::<Vec<_>>()
    );

    queue_remove(&reopened.db_path, &ids[2]).expect("remove queued episode");
    let after_remove = list_queue(&reopened.db_path, &reopened.downloads_dir).expect("list after remove");
    assert_eq!(
      after_remove.iter().map(|item| item.position).collect::<Vec<_>>(),
      vec![0, 1]
    );
    queue_clear(&reopened.db_path).expect("clear queue");
    assert!(list_queue(&reopened.db_path, &reopened.downloads_dir)
      .expect("list cleared queue")
      .is_empty());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn deleting_download_removes_only_managed_files_and_cleans_database_state() {
    let directory = test_directory("delete-download");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let final_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
    let part_path = state.downloads_dir.join(format!("{episode_id}.part"));
    fs::write(&final_path, b"ID3-managed").expect("write managed download");
    fs::write(&part_path, b"ID3-part").expect("write part download");
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &final_path.to_string_lossy(),
      11,
      Some(11),
    )
    .expect("mark managed download");

    delete_episode_download(&state.db_path, &state.downloads_dir, &episode_id).expect("delete managed download");
    assert!(!final_path.exists());
    assert!(!part_path.exists());
    let detail =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("detail after delete");
    assert_eq!(detail.episode.download_state, "none");
    assert!(detail.episode.local_path.is_none());
    delete_episode_download(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("delete download idempotently");

    fs::write(&part_path, b"ID3-failed-part").expect("write failed part");
    mark_download_failed(&state.db_path, &episode_id, 15, "网络失败").expect("mark failed download");
    let failed =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("failed detail");
    assert_eq!(failed.download_error.as_deref(), Some("网络失败"));
    delete_episode_download(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("delete failed download");
    assert!(!part_path.exists());

    let outside_path = directory.join(format!("{episode_id}.mp3"));
    fs::write(&outside_path, b"ID3-outside").expect("write outside download");
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &outside_path.to_string_lossy(),
      11,
      Some(11),
    )
    .expect("mark tampered download");
    delete_episode_download(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("clean tampered record");
    assert!(outside_path.exists());
    let download_row_exists = open_database(&state.db_path)
      .expect("open database")
      .query_row(
        "SELECT 1 FROM podcast_downloads WHERE episode_id = ?1",
        [&episode_id],
        |_| Ok(()),
      )
      .optional()
      .expect("inspect download row")
      .is_some();
    assert!(!download_row_exists);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn episode_file_guard_serializes_download_and_delete_operations() {
    let active = Arc::new(Mutex::new(HashSet::new()));
    let episode_id = "a".repeat(64);
    let first = EpisodeFileGuard::acquire(&active, &episode_id).expect("acquire first guard");
    assert!(EpisodeFileGuard::acquire(&active, &episode_id).is_err());
    drop(first);
    let second = EpisodeFileGuard::acquire(&active, &episode_id).expect("acquire after release");
    drop(second);
    assert!(active.lock().expect("lock active set").is_empty());
  }

  #[test]
  fn content_range_parser_rejects_inconsistent_ranges() {
    assert_eq!(parse_content_range("bytes 10-19/100"), Some((10, 19, Some(100))));
    assert_eq!(parse_content_range("bytes 0-9/*"), Some((0, 9, None)));
    assert_eq!(parse_content_range("bytes 20-10/100"), None);
    assert_eq!(parse_content_range("bytes 0-100/100"), None);
    assert_eq!(parse_content_range("items 0-9/100"), None);
    assert_eq!(parse_unsatisfied_content_range("bytes */100"), Some(100));
    assert_eq!(parse_unsatisfied_content_range("bytes 0-9/100"), None);
  }

  #[tokio::test]
  async fn podcast_stream_protocol_only_accepts_database_episode_ids() {
    let directory = test_directory("stream-identity");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");

    let injected = Request::builder()
      .method(Method::GET)
      .uri("zone-podcast://localhost/https://127.0.0.1/private.mp3")
      .body(Vec::new())
      .expect("build injected request");
    let injected_response =
      serve_podcast_stream_protocol_with_network_policy(state.clone(), injected, true).await;
    assert_eq!(injected_response.status(), StatusCode::BAD_REQUEST);

    let unknown = Request::builder()
      .method(Method::GET)
      .uri(format!("zone-podcast://localhost/{}", "a".repeat(64)))
      .body(Vec::new())
      .expect("build unknown request");
    let unknown_response =
      serve_podcast_stream_protocol_with_network_policy(state.clone(), unknown, true).await;
    assert_eq!(unknown_response.status(), StatusCode::NOT_FOUND);

    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    open_database(&state.db_path)
      .expect("open database")
      .execute(
        "UPDATE podcast_episodes SET enclosure_url = 'http://198.18.1.20/private.mp3' WHERE id = ?1",
        [&episode_id],
      )
      .expect("point episode at forbidden address");
    let forbidden = Request::builder()
      .method(Method::GET)
      .uri(format!("zone-podcast://localhost/{episode_id}"))
      .body(Vec::new())
      .expect("build forbidden source request");
    let forbidden_response =
      serve_podcast_stream_protocol_with_network_policy(state.clone(), forbidden, false).await;
    assert_eq!(forbidden_response.status(), StatusCode::BAD_GATEWAY);

    let options = Request::builder()
      .method(Method::OPTIONS)
      .uri("zone-podcast://localhost/not-an-episode")
      .body(Vec::new())
      .expect("build options request");
    let options_response =
      serve_podcast_stream_protocol_with_network_policy(state, options, true).await;
    assert_eq!(options_response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
      options_response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|value| value.to_str().ok()),
      Some("*"),
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[tokio::test]
  async fn podcast_stream_protocol_proxies_bounded_ranges_with_cors() {
    let directory = test_directory("stream-range");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
    let address = listener.local_addr().expect("server address");
    let audio = b"ID3-zone-podcast-stream-range".to_vec();
    let server_audio = audio.clone();
    let server = tokio::spawn(async move {
      for (start, end) in [(4usize, 8usize), (0usize, 0usize)] {
        let (mut stream, _) = listener.accept().await.expect("accept request");
        let mut request = vec![0u8; 8_192];
        let read = stream.read(&mut request).await.expect("read request");
        let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
        assert!(
          request.contains(&format!("range: bytes={start}-{end}")),
          "{request}"
        );
        let body = &server_audio[start..=end];
        let headers = format!(
          "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/mpeg\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nConnection: close\r\n\r\n",
          body.len(),
          server_audio.len(),
        );
        stream.write_all(headers.as_bytes()).await.expect("write headers");
        stream.write_all(body).await.expect("write body");
        stream.shutdown().await.expect("shutdown response");
      }
    });
    let enclosure_url = format!("http://{address}/episode.mp3");
    open_database(&state.db_path)
      .expect("open database")
      .execute(
        "UPDATE podcast_episodes SET enclosure_url = ?1 WHERE id = ?2",
        params![enclosure_url, episode_id],
      )
      .expect("point episode at test server");

    let request = Request::builder()
      .method(Method::GET)
      .uri(format!("zone-podcast://localhost/{episode_id}"))
      .header(header::RANGE, "bytes=4-8")
      .body(Vec::new())
      .expect("build stream request");
    let response =
      serve_podcast_stream_protocol_with_network_policy(state.clone(), request, true).await;

    let head_request = Request::builder()
      .method(Method::HEAD)
      .uri(format!("zone-podcast://localhost/{episode_id}"))
      .body(Vec::new())
      .expect("build stream HEAD request");
    let head_response =
      serve_podcast_stream_protocol_with_network_policy(state, head_request, true).await;
    server.await.expect("server task");

    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
      response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok()),
      Some(format!("bytes 4-8/{}", audio.len()).as_str()),
    );
    assert_eq!(
      response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|value| value.to_str().ok()),
      Some("*"),
    );
    assert_eq!(response.body(), &audio[4..=8]);
    assert_eq!(head_response.status(), StatusCode::OK);
    assert_eq!(
      head_response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok()),
      Some(audio.len().to_string().as_str()),
    );
    assert!(head_response.body().is_empty());
    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[tokio::test]
  async fn podcast_stream_protocol_does_not_hide_full_download_when_range_is_ignored() {
    let directory = test_directory("stream-no-range");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
    let address = listener.local_addr().expect("server address");
    let audio = b"ID3-server-ignored-range".to_vec();
    let server_audio = audio.clone();
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.expect("accept request");
      let mut request = vec![0u8; 8_192];
      let read = stream.read(&mut request).await.expect("read request");
      let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
      assert!(request.contains("range: bytes=4-8"), "{request}");
      let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        server_audio.len(),
      );
      stream.write_all(headers.as_bytes()).await.expect("write headers");
      stream.write_all(&server_audio).await.expect("write body");
      stream.shutdown().await.expect("shutdown response");
    });
    let enclosure_url = format!("http://{address}/episode.mp3");
    open_database(&state.db_path)
      .expect("open database")
      .execute(
        "UPDATE podcast_episodes SET enclosure_url = ?1 WHERE id = ?2",
        params![enclosure_url, episode_id],
      )
      .expect("point episode at test server");

    let request = Request::builder()
      .method(Method::GET)
      .uri(format!("zone-podcast://localhost/{episode_id}"))
      .header(header::RANGE, "bytes=4-8")
      .body(Vec::new())
      .expect("build stream request");
    let response =
      serve_podcast_stream_protocol_with_network_policy(state, request, true).await;
    server.await.expect("server task");
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[tokio::test]
  async fn audio_magic_distinguishes_raw_aac_from_mp3() {
    let directory = test_directory("magic");
    let aac = directory.join("audio-aac.part");
    let mp3 = directory.join("audio-mp3.part");
    let m4a = directory.join("audio-m4a.part");
    fs::write(&aac, [0xff, 0xf1, 0x50, 0x80]).expect("write AAC");
    fs::write(&mp3, [0xff, 0xfb, 0x90, 0x64]).expect("write MP3");
    fs::write(
      &m4a,
      [0, 0, 0, 20, b'f', b't', b'y', b'p', b'M', b'4', b'A', b' ', 0, 0, 0, 0],
    )
    .expect("write M4A");
    assert_eq!(detect_audio_extension(&aac).await.expect("AAC"), "aac");
    assert_eq!(detect_audio_extension(&mp3).await.expect("MP3"), "mp3");
    assert_eq!(detect_audio_extension(&m4a).await.expect("M4A"), "m4a");
    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[tokio::test]
  async fn download_resumes_a_part_file_with_range_and_persists_result() {
    let directory = test_directory("range");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
    let address = listener.local_addr().expect("server address");
    let audio = b"ID3-zone-podcast-range-download".to_vec();
    let split = 7usize;
    let expected_request = format!("Range: bytes={split}-");
    let server_audio = audio.clone();
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.expect("accept request");
      let mut request = vec![0u8; 8_192];
      let read = stream.read(&mut request).await.expect("read request");
      let request = String::from_utf8_lossy(&request[..read]);
      assert!(
        request
          .to_ascii_lowercase()
          .contains(&expected_request.to_ascii_lowercase()),
        "{request}"
      );
      let remaining = &server_audio[split..];
      let headers = format!(
        "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/mpeg\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
        remaining.len(),
        split,
        server_audio.len() - 1,
        server_audio.len(),
      );
      stream.write_all(headers.as_bytes()).await.expect("write headers");
      stream.write_all(remaining).await.expect("write body");
      stream.shutdown().await.expect("shutdown response");
    });

    let enclosure_url = format!("http://{address}/episode.mp3");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    let part_path = state.downloads_dir.join(format!("{episode_id}.part"));
    fs::write(&part_path, &audio[..split]).expect("write partial download");

    let result = download_episode_with_network_policy(
      &state.db_path,
      &state.downloads_dir,
      &episode_id,
      &enclosure_url,
      Some("audio/mpeg"),
      true,
    )
    .await
    .expect("resume download");
    server.await.expect("server task");
    assert!(result.resumed);
    assert_eq!(result.downloaded_bytes, audio.len() as u64);
    assert_eq!(fs::read(&result.local_path).expect("read downloaded file"), audio);
    assert!(!part_path.exists());
    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &feed_id).expect("list episodes");
    assert_eq!(episodes[0].download_state, "downloaded");
    assert_eq!(episodes[0].local_path.as_deref(), Some(result.local_path.as_str()));

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[tokio::test]
  #[ignore = "requires ZONE_PODCAST_LIVE=1 and public internet access"]
  async fn apple_cn_to_rss_to_enclosure_range_live_smoke() {
    if std::env::var("ZONE_PODCAST_LIVE").ok().as_deref() != Some("1") {
      eprintln!("set ZONE_PODCAST_LIVE=1 to run the podcast live smoke");
      return;
    }
    let query = std::env::var("ZONE_PODCAST_LIVE_QUERY").unwrap_or_else(|_| "声动早咖啡".to_string());
    let search = search_apple_cn(&query, 5).await.expect("Apple CN search");
    let candidate = search.into_iter().next().expect("Apple CN search candidate");
    let parsed = fetch_and_parse_feed(
      &candidate.feed_url,
      Some(&candidate.title),
      Some(&candidate.author),
      candidate.artwork_url.as_deref(),
    )
    .await
    .expect("fetch RSS");
    let episode = parsed.episodes.first().expect("podcast episode");
    let mut response = send_public_get(
      validate_public_url_shape(&episode.enclosure_url).expect("enclosure URL"),
      Duration::from_secs(30),
      Some("bytes=0-1023"),
    )
    .await
    .expect("enclosure range request");
    assert!(response.response.status().is_success());
    assert!(response_content_type_is_audio_candidate(
      header_text(response.response.headers(), header::CONTENT_TYPE).as_deref(),
      episode.enclosure_type.as_deref(),
    ));
    let first_chunk = response
      .response
      .chunk()
      .await
      .expect("read enclosure range")
      .expect("non-empty enclosure range");
    assert!(!first_chunk.is_empty());
  }

  #[tokio::test]
  #[ignore = "requires ZONE_PODCAST_LIVE=1 and public internet access"]
  async fn apple_cn_discovery_live_smoke() {
    if std::env::var("ZONE_PODCAST_LIVE").ok().as_deref() != Some("1") {
      eprintln!("set ZONE_PODCAST_LIVE=1 to run the podcast live smoke");
      return;
    }
    let shows = browse_apple_cn(12).await.expect("Apple CN discovery");
    assert!(shows.len() >= 5);
    assert!(shows.windows(2).all(|pair| pair[0].rank < pair[1].rank));
    for show in shows {
      validate_public_url_shape(&show.feed_url).expect("public discovery feed URL");
    }
  }

  #[tokio::test]
  #[ignore = "requires ZONE_PODCAST_LIVE=1 and public internet access"]
  async fn apple_cn_artwork_proxy_live_smoke() {
    if std::env::var("ZONE_PODCAST_LIVE").ok().as_deref() != Some("1") {
      eprintln!("set ZONE_PODCAST_LIVE=1 to run the podcast live smoke");
      return;
    }
    let shows = browse_apple_cn(5).await.expect("Apple CN discovery");
    let artwork_url = shows
      .iter()
      .find_map(|show| show.artwork_url.as_deref())
      .expect("Apple CN artwork");
    let request = artwork_request(Method::GET, artwork_url);
    let response = serve_podcast_artwork_protocol(request).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
      response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("image/")),
    );
    assert!(!response.body().is_empty());
  }
}
