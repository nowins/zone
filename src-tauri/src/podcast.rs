use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use feed_rs::model::{Entry as ParsedEntry, Feed as ParsedFeed};
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::{Namespace, ResolveResult};
use quick_xml::reader::NsReader;
use quick_xml::Reader;
use reqwest::header::{self, HeaderMap, HeaderValue};
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
const PODCAST_CHAPTER_MAX_COUNT: usize = 1_000;
const PODCAST_TRANSCRIPT_SOURCE_MAX_COUNT: usize = 16;
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
const PODCAST_HOME_UNPLAYED_LIMIT: usize = 40;
const PODCAST_HOME_DOWNLOAD_PRIORITY_LIMIT: usize = 40;
const PODCAST_HOME_DOWNLOADED_LIMIT: usize = 40;
const PODCAST_HOME_SAVED_LIMIT: usize = 40;
const PODCAST_HOME_RECENTLY_PLAYED_LIMIT: usize = 40;
const PODCAST_RELATED_EPISODE_DEFAULT_LIMIT: usize = 6;
const PODCAST_RELATED_EPISODE_MAX_LIMIT: usize = 12;
const PODCAST_DOWNLOAD_PAGE_MAX_LIMIT: usize = 100;
const PODCAST_DOWNLOAD_DELETE_LIMIT: usize = 500;
const PODCAST_EPISODE_BATCH_LIMIT: usize = 500;
const PODCAST_QUEUE_LIMIT: usize = 500;
const PODCAST_REFRESH_CONCURRENCY: usize = 3;
const PODCAST_REFRESH_INTERVAL: i64 = 30 * 60 * 1_000;
const PODCAST_SYNTHETIC_ID_PREFIX: &str = "zone-generated:";
const PODCAST_NAMESPACE_URI: &[u8] = b"https://podcastindex.org/namespace/1.0";
const PODCAST_NAMESPACE_COMPAT_URI: &[u8] =
  b"https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md";
const PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI: &[u8] =
  b"http://podlove.org/simple-chapters";
const USER_AGENT: &str = "Zone/0.1 (local podcast player)";

#[derive(Clone, Debug)]
pub struct PodcastState {
  db_path: PathBuf,
  downloads_dir: PathBuf,
  active_downloads: Arc<Mutex<HashSet<String>>>,
  active_refreshes: Arc<Mutex<HashSet<String>>>,
  refresh_semaphore: Arc<tokio::sync::Semaphore>,
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
  genres: Vec<String>,
  latest_release_at: Option<i64>,
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
  subscribed_at: Option<i64>,
  last_checked_at: Option<i64>,
  last_refresh_error: Option<String>,
  latest_episode_at: Option<i64>,
  unplayed_count: u64,
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
  first_seen_at: i64,
  webpage_url: Option<String>,
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
  has_chapters: bool,
  transcript_count: u32,
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
  unplayed_episodes: Vec<PodcastEpisode>,
  download_priority_episodes: Vec<PodcastEpisode>,
  downloaded_episodes: Vec<PodcastEpisode>,
  saved_episodes: Vec<PodcastEpisode>,
  recently_played_episodes: Vec<PodcastEpisode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDownloadPage {
  episodes: Vec<PodcastEpisode>,
  total_count: u64,
  total_bytes: u64,
  feed_count: u64,
  has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastSubscribeResult {
  feed: PodcastFeed,
  episode_count: usize,
  inserted_count: usize,
  updated_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastRefreshFailure {
  feed_id: String,
  title: String,
  message: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastRefreshReport {
  checked: usize,
  not_modified: usize,
  inserted: usize,
  updated: usize,
  failures: Vec<PodcastRefreshFailure>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDownloadResult {
  episode_id: String,
  local_path: String,
  downloaded_bytes: u64,
  resumed: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDownloadDeleteResult {
  requested_count: usize,
  deleted_count: usize,
  deleted_bytes: u64,
  deleted_episode_ids: Vec<String>,
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
  #[serde(default)]
  genres: Vec<String>,
  primary_genre_name: Option<String>,
  release_date: Option<String>,
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
  webpage_url: Option<String>,
  resources: Option<Vec<ParsedEpisodeResource>>,
}

#[derive(Clone, Debug)]
struct ParsedEpisodeResource {
  kind: &'static str,
  source_kind: &'static str,
  url: Option<String>,
  mime_type: Option<String>,
  language: Option<String>,
  relation: Option<String>,
  ordinal: usize,
  chapters: Vec<ParsedPodcastChapter>,
}

#[derive(Clone, Debug)]
struct ParsedPodcastChapter {
  start_ms: i64,
  end_ms: Option<i64>,
  title: String,
  href: Option<String>,
  image_url: Option<String>,
  visible: bool,
}

#[derive(Clone, Debug, Default)]
struct ParsedEpisodeExtensions {
  resources: Vec<ParsedEpisodeResource>,
}

#[derive(Clone, Debug)]
struct PodcastRefreshTarget {
  id: String,
  feed_url: String,
  title: String,
  author: Option<String>,
  artwork_url: Option<String>,
  etag: Option<String>,
  last_modified: Option<String>,
}

#[derive(Debug)]
enum PodcastRefreshOutcome {
  Skipped,
  NotModified,
  Updated {
    inserted: usize,
    updated: usize,
  },
  Failed(PodcastRefreshFailure),
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

  fn acquire_many(
    active_downloads: &Arc<Mutex<HashSet<String>>>,
    episode_ids: &[String],
  ) -> Result<Vec<Self>, String> {
    let mut active = active_downloads
      .lock()
      .map_err(|_| "播客下载状态不可用".to_string())?;
    if episode_ids
      .iter()
      .any(|episode_id| active.contains(episode_id))
    {
      return Err("所选播客单集中有项目正在下载或清理".to_string());
    }
    for episode_id in episode_ids {
      active.insert(episode_id.clone());
    }
    let guards = episode_ids
      .iter()
      .map(|episode_id| Self {
        episode_id: episode_id.clone(),
        active_downloads: active_downloads.clone(),
      })
      .collect();
    drop(active);
    Ok(guards)
  }
}

impl Drop for EpisodeFileGuard {
  fn drop(&mut self) {
    if let Ok(mut active) = self.active_downloads.lock() {
      active.remove(&self.episode_id);
    }
  }
}

struct FeedRefreshGuard {
  feed_id: String,
  active_refreshes: Arc<Mutex<HashSet<String>>>,
}

impl FeedRefreshGuard {
  fn acquire(
    active_refreshes: &Arc<Mutex<HashSet<String>>>,
    feed_id: &str,
  ) -> Result<Option<Self>, String> {
    let mut active = active_refreshes
      .lock()
      .map_err(|_| "播客刷新状态不可用".to_string())?;
    if !active.insert(feed_id.to_string()) {
      return Ok(None);
    }
    drop(active);
    Ok(Some(Self {
      feed_id: feed_id.to_string(),
      active_refreshes: active_refreshes.clone(),
    }))
  }
}

impl Drop for FeedRefreshGuard {
  fn drop(&mut self) {
    if let Ok(mut active) = self.active_refreshes.lock() {
      active.remove(&self.feed_id);
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
      active_refreshes: Arc::new(Mutex::new(HashSet::new())),
      refresh_semaphore: Arc::new(tokio::sync::Semaphore::new(PODCAST_REFRESH_CONCURRENCY)),
      initialization_error: None,
    })
  }

  pub fn unavailable(error: String) -> Self {
    Self {
      db_path: PathBuf::new(),
      downloads_dir: PathBuf::new(),
      active_downloads: Arc::new(Mutex::new(HashSet::new())),
      active_refreshes: Arc::new(Mutex::new(HashSet::new())),
      refresh_semaphore: Arc::new(tokio::sync::Semaphore::new(PODCAST_REFRESH_CONCURRENCY)),
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
pub async fn podcast_refresh_feeds(
  state: State<'_, PodcastState>,
  feed_id: Option<String>,
  force: bool,
) -> Result<PodcastRefreshReport, String> {
  state.ensure_ready()?;
  if let Some(feed_id) = feed_id.as_deref() {
    validate_identifier(feed_id)?;
  }
  let db_path = state.db_path.clone();
  let target_feed_id = feed_id.clone();
  let targets = tauri::async_runtime::spawn_blocking(move || {
    list_refresh_targets(&db_path, target_feed_id.as_deref(), force, unix_time_millis())
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))??;

  let mut report = PodcastRefreshReport::default();
  for chunk in targets.chunks(PODCAST_REFRESH_CONCURRENCY) {
    let outcomes = match chunk {
      [first] => vec![
          refresh_feed_target(
            state.db_path.clone(),
            state.active_refreshes.clone(),
            state.refresh_semaphore.clone(),
            first.clone(),
            false,
          )
        .await,
      ],
      [first, second] => {
        let (first, second) = tokio::join!(
          refresh_feed_target(
            state.db_path.clone(),
            state.active_refreshes.clone(),
            state.refresh_semaphore.clone(),
            first.clone(),
            false,
          ),
          refresh_feed_target(
            state.db_path.clone(),
            state.active_refreshes.clone(),
            state.refresh_semaphore.clone(),
            second.clone(),
            false,
          ),
        );
        vec![first, second]
      }
      [first, second, third] => {
        let (first, second, third) = tokio::join!(
          refresh_feed_target(
            state.db_path.clone(),
            state.active_refreshes.clone(),
            state.refresh_semaphore.clone(),
            first.clone(),
            false,
          ),
          refresh_feed_target(
            state.db_path.clone(),
            state.active_refreshes.clone(),
            state.refresh_semaphore.clone(),
            second.clone(),
            false,
          ),
          refresh_feed_target(
            state.db_path.clone(),
            state.active_refreshes.clone(),
            state.refresh_semaphore.clone(),
            third.clone(),
            false,
          ),
        );
        vec![first, second, third]
      }
      _ => unreachable!("refresh chunks are limited to three feeds"),
    };
    for outcome in outcomes {
      match outcome {
        PodcastRefreshOutcome::Skipped => continue,
        PodcastRefreshOutcome::NotModified => report.not_modified += 1,
        PodcastRefreshOutcome::Updated { inserted, updated } => {
          report.inserted += inserted;
          report.updated += updated;
        }
        PodcastRefreshOutcome::Failed(failure) => report.failures.push(failure),
      }
      report.checked += 1;
    }
  }
  Ok(report)
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
pub async fn podcast_list_downloads(
  state: State<'_, PodcastState>,
  offset: usize,
  limit: usize,
) -> Result<PodcastDownloadPage, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    list_downloads(&db_path, &downloads_dir, offset, limit)
  })
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
pub async fn podcast_list_related_episodes(
  state: State<'_, PodcastState>,
  episode_id: String,
  limit: Option<u8>,
) -> Result<Vec<PodcastEpisode>, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let limit = usize::from(limit.unwrap_or(PODCAST_RELATED_EPISODE_DEFAULT_LIMIT as u8))
    .clamp(1, PODCAST_RELATED_EPISODE_MAX_LIMIT);
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    list_related_episodes(&db_path, &downloads_dir, &episode_id, limit)
  })
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
pub async fn podcast_set_episodes_played(
  state: State<'_, PodcastState>,
  episode_ids: Vec<String>,
  played: bool,
) -> Result<Vec<PodcastEpisodeDetail>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let episode_ids = set_episodes_played(&db_path, &episode_ids, played)?;
    get_episode_details(&db_path, &downloads_dir, &episode_ids)
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
pub async fn podcast_queue_remove_many(
  state: State<'_, PodcastState>,
  episode_ids: Vec<String>,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    queue_remove_many(&db_path, &episode_ids)?;
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
pub async fn podcast_queue_autofill(
  state: State<'_, PodcastState>,
  current_episode_id: String,
  mode: String,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  validate_identifier(&current_episode_id)?;
  let mode = PodcastQueueAutofillMode::parse(&mode)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    queue_autofill(&db_path, &current_episode_id, mode)?;
    list_queue(&db_path, &downloads_dir)
  })
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
pub async fn podcast_delete_episode_downloads(
  state: State<'_, PodcastState>,
  episode_ids: Vec<String>,
) -> Result<PodcastDownloadDeleteResult, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  let active_downloads = state.active_downloads.clone();
  tauri::async_runtime::spawn_blocking(move || {
    delete_episode_downloads_guarded(
      &db_path,
      &downloads_dir,
      &active_downloads,
      episode_ids,
      false,
    )
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_clear_completed_downloads(
  state: State<'_, PodcastState>,
) -> Result<PodcastDownloadDeleteResult, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  let active_downloads = state.active_downloads.clone();
  tauri::async_runtime::spawn_blocking(move || {
    clear_completed_episode_downloads_guarded(
      &db_path,
      &downloads_dir,
      &active_downloads,
    )
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
  Ok(
    response
      .results
      .into_iter()
      .filter_map(apple_search_result_from_item)
      .collect(),
  )
}

fn apple_search_result_from_item(item: AppleSearchItem) -> Option<PodcastSearchResult> {
  let feed_url = clean_optional(item.feed_url, 4_096)?;
  if validate_public_url_shape(&feed_url).is_err() {
    return None;
  }
  let title = clean_optional(item.collection_name, PODCAST_TITLE_LIMIT).unwrap_or_else(|| "未命名播客".to_string());
  let author = clean_optional(item.artist_name, PODCAST_TITLE_LIMIT).unwrap_or_default();
  let id = item
    .collection_id
    .map(|value| value.to_string())
    .unwrap_or_else(|| hash_identifier("apple", &[&feed_url]));
  let genres = normalize_apple_search_genres(item.genres, item.primary_genre_name);
  let latest_release_at = item.release_date.as_deref().and_then(parse_iso8601_millis);
  Some(PodcastSearchResult {
    id,
    title,
    author,
    feed_url,
    artwork_url: clean_optional(item.artwork_url_600.or(item.artwork_url_100), 4_096),
    episode_count: item.track_count,
    genres,
    latest_release_at,
  })
}

fn normalize_apple_search_genres(genres: Vec<String>, primary_genre_name: Option<String>) -> Vec<String> {
  let mut normalized = Vec::new();
  let mut seen = HashSet::new();
  for genre in genres.into_iter().chain(primary_genre_name) {
    let Some(genre) = clean_text(&genre, 100) else {
      continue;
    };
    if genre.eq_ignore_ascii_case("podcasts") || genre == "播客" {
      continue;
    }
    if seen.insert(genre.to_lowercase()) {
      normalized.push(genre);
    }
  }
  normalized
}

fn parse_iso8601_millis(value: &str) -> Option<i64> {
  let bytes = value.trim().as_bytes();
  if bytes.len() < 10 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
    return None;
  }
  let year = parse_ascii_number(bytes.get(0..4)?)?;
  let month = parse_ascii_number(bytes.get(5..7)?)?;
  let day = parse_ascii_number(bytes.get(8..10)?)?;
  if year == 0 || !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) {
    return None;
  }

  let mut hour = 0;
  let mut minute = 0;
  let mut second = 0;
  let mut millisecond = 0;
  let mut offset_minutes = 0i64;
  if bytes.len() > 10 {
    if !matches!(bytes.get(10), Some(b'T' | b't' | b' ')) || bytes.len() < 19 {
      return None;
    }
    hour = parse_ascii_number(bytes.get(11..13)?)?;
    minute = parse_ascii_number(bytes.get(14..16)?)?;
    second = parse_ascii_number(bytes.get(17..19)?)?;
    if bytes.get(13) != Some(&b':')
      || bytes.get(16) != Some(&b':')
      || hour > 23
      || minute > 59
      || second > 59
    {
      return None;
    }

    let mut cursor = 19;
    if bytes.get(cursor) == Some(&b'.') {
      cursor += 1;
      let fraction_start = cursor;
      while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        cursor += 1;
      }
      if cursor == fraction_start {
        return None;
      }
      let fraction = &bytes[fraction_start..cursor];
      millisecond = i64::from(fraction[0] - b'0') * 100;
      if fraction.len() > 1 {
        millisecond += i64::from(fraction[1] - b'0') * 10;
      }
      if fraction.len() > 2 {
        millisecond += i64::from(fraction[2] - b'0');
      }
    }

    match bytes.get(cursor) {
      Some(b'Z' | b'z') if cursor + 1 == bytes.len() => {}
      Some(sign @ (b'+' | b'-')) => {
        let remainder = bytes.get(cursor + 1..)?;
        let (offset_hour, offset_minute) = match remainder {
          [hour_1, hour_2, b':', minute_1, minute_2] => (
            parse_ascii_number(&[*hour_1, *hour_2])?,
            parse_ascii_number(&[*minute_1, *minute_2])?,
          ),
          [hour_1, hour_2, minute_1, minute_2] => (
            parse_ascii_number(&[*hour_1, *hour_2])?,
            parse_ascii_number(&[*minute_1, *minute_2])?,
          ),
          _ => return None,
        };
        if offset_hour > 23 || offset_minute > 59 {
          return None;
        }
        offset_minutes = i64::from(offset_hour * 60 + offset_minute);
        if *sign == b'-' {
          offset_minutes = -offset_minutes;
        }
      }
      _ => return None,
    }
  }

  let days = days_from_civil(i64::from(year), i64::from(month), i64::from(day));
  days
    .checked_mul(86_400_000)?
    .checked_add(i64::from(hour) * 3_600_000)?
    .checked_add(i64::from(minute) * 60_000)?
    .checked_add(i64::from(second) * 1_000)?
    .checked_add(millisecond)?
    .checked_sub(offset_minutes * 60_000)
}

fn parse_ascii_number(bytes: &[u8]) -> Option<u32> {
  if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
    return None;
  }
  bytes
    .iter()
    .try_fold(0u32, |value, digit| value.checked_mul(10)?.checked_add(u32::from(*digit - b'0')))
}

fn days_in_month(year: u32, month: u32) -> u32 {
  match month {
    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
    4 | 6 | 9 | 11 => 30,
    2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
    2 => 28,
    _ => 0,
  }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
  let adjusted_year = year - if month <= 2 { 1 } else { 0 };
  let era = if adjusted_year >= 0 {
    adjusted_year
  } else {
    adjusted_year - 399
  } / 400;
  let year_of_era = adjusted_year - era * 400;
  let adjusted_month = month + if month > 2 { -3 } else { 9 };
  let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
  let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  era * 146_097 + day_of_era - 719_468
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

async fn refresh_feed_target(
  db_path: PathBuf,
  active_refreshes: Arc<Mutex<HashSet<String>>>,
  refresh_semaphore: Arc<tokio::sync::Semaphore>,
  target: PodcastRefreshTarget,
  allow_private_network: bool,
) -> PodcastRefreshOutcome {
  let _refresh_guard = match FeedRefreshGuard::acquire(&active_refreshes, &target.id) {
    Ok(Some(guard)) => guard,
    Ok(None) => return PodcastRefreshOutcome::Skipped,
    Err(message) => {
      return PodcastRefreshOutcome::Failed(PodcastRefreshFailure {
        feed_id: target.id,
        title: target.title,
        message,
      })
    }
  };
  let _refresh_permit = match refresh_semaphore.acquire_owned().await {
    Ok(permit) => permit,
    Err(_) => {
      return PodcastRefreshOutcome::Failed(PodcastRefreshFailure {
        feed_id: target.id,
        title: target.title,
        message: "播客刷新调度已停止".to_string(),
      })
    }
  };
  let checked_at = unix_time_millis();
  let result = async {
    let url = validate_url_shape_with_policy(&target.feed_url, allow_private_network)?;
    let mut request_headers = HeaderMap::new();
    if let Some(value) = target.etag.as_deref().and_then(|value| HeaderValue::from_str(value).ok()) {
      request_headers.insert(header::IF_NONE_MATCH, value);
    }
    if let Some(value) = target
      .last_modified
      .as_deref()
      .and_then(|value| HeaderValue::from_str(value).ok())
    {
      request_headers.insert(header::IF_MODIFIED_SINCE, value);
    }
    let public_response = send_public_get_with_headers(
      url,
      Duration::from_secs(30),
      None,
      allow_private_network,
      &request_headers,
    )
    .await?;
    let response_etag = header_text(public_response.response.headers(), header::ETAG);
    let response_last_modified =
      header_text(public_response.response.headers(), header::LAST_MODIFIED);
    if public_response.response.status() == StatusCode::NOT_MODIFIED {
      let db_path = db_path.clone();
      let feed_id = target.id.clone();
      tauri::async_runtime::spawn_blocking(move || {
        mark_refresh_not_modified(
          &db_path,
          &feed_id,
          checked_at,
          response_etag,
          response_last_modified,
        )
      })
      .await
      .map_err(|error| format!("播客数据任务异常结束：{error}"))??;
      return Ok(PodcastRefreshOutcome::NotModified);
    }
    if !public_response.response.status().is_success() {
      return Err(format!(
        "播客订阅源返回错误 {}",
        public_response.response.status().as_u16()
      ));
    }
    let bytes = read_limited(
      public_response.response,
      PODCAST_FEED_RESPONSE_LIMIT,
      "播客订阅源",
    )
    .await?;
    let mut parsed = parse_feed_bytes_with_network_policy(
      &bytes,
      public_response.final_url.as_str(),
      Some(&target.title),
      target.author.as_deref(),
      target.artwork_url.as_deref(),
      response_etag,
      response_last_modified,
      allow_private_network,
    )?;
    retain_refresh_identifiers(&mut parsed, &target.id);
    parsed.feed.last_checked_at = Some(checked_at);
    let db_path = db_path.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || store_preview(&db_path, parsed))
      .await
      .map_err(|error| format!("播客数据任务异常结束：{error}"))??;
    Ok(PodcastRefreshOutcome::Updated {
      inserted: stored.inserted_count,
      updated: stored.updated_count,
    })
  }
  .await;

  match result {
    Ok(outcome) => outcome,
    Err(message) => {
      let stored_message = truncate_chars(&message, 2_000);
      let error_db_path = db_path.clone();
      let error_feed_id = target.id.clone();
      let stored_message_for_db = stored_message.clone();
      let database_error = tauri::async_runtime::spawn_blocking(move || {
        mark_refresh_failed(
          &error_db_path,
          &error_feed_id,
          checked_at,
          &stored_message_for_db,
        )
      })
      .await
      .map_err(|error| format!("播客数据任务异常结束：{error}"))
      .and_then(|result| result);
      let message = match database_error {
        Ok(()) => stored_message,
        Err(database_error) => format!("{stored_message}；{database_error}"),
      };
      PodcastRefreshOutcome::Failed(PodcastRefreshFailure {
        feed_id: target.id,
        title: target.title,
        message,
      })
    }
  }
}

fn retain_refresh_identifiers(parsed: &mut ParsedPodcast, feed_id: &str) {
  parsed.feed.id = feed_id.to_string();
  remap_episode_identifiers(&mut parsed.episodes, feed_id);
}

fn remap_episode_identifiers(episodes: &mut [ParsedPodcastEpisode], feed_id: &str) {
  for episode in episodes {
    episode.feed_id = feed_id.to_string();
    episode.id = hash_identifier("episode", &[feed_id, &episode.identity_key]);
  }
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
  parse_feed_bytes_with_network_policy(
    bytes,
    final_url,
    title_hint,
    author_hint,
    artwork_hint,
    etag,
    last_modified,
    false,
  )
}

fn parse_feed_bytes_with_network_policy(
  bytes: &[u8],
  final_url: &str,
  title_hint: Option<&str>,
  author_hint: Option<&str>,
  artwork_hint: Option<&str>,
  etag: Option<String>,
  last_modified: Option<String>,
  allow_private_network: bool,
) -> Result<ParsedPodcast, String> {
  if bytes.len() > PODCAST_FEED_RESPONSE_LIMIT {
    return Err("播客订阅源超过大小限制".to_string());
  }
  let mut repaired_document = None;
  let parsed = match podcast_feed_parser(final_url).parse(bytes) {
    Ok(parsed) => parsed,
    Err(original_error) => {
      let Some(repaired) = repair_feed_bytes(bytes) else {
        return Err(format!("无法解析播客订阅源：{original_error}"));
      };
      let parsed = podcast_feed_parser(final_url)
        .parse(repaired.as_slice())
        .map_err(|_| format!("无法解析播客订阅源：{original_error}"))?;
      repaired_document = Some(repaired);
      parsed
    }
  };
  let normalized_document = repaired_document.as_deref().unwrap_or(bytes);
  let rss_enclosures = extract_rss_enclosures(normalized_document, final_url);
  let episode_extensions = extract_episode_extensions(normalized_document, final_url);
  normalize_feed(
    parsed,
    final_url,
    title_hint,
    author_hint,
    artwork_hint,
    etag,
    last_modified,
    &rss_enclosures,
    episode_extensions.as_deref(),
    allow_private_network,
  )
}

fn podcast_feed_parser(base_uri: &str) -> feed_rs::parser::Parser {
  feed_rs::parser::Builder::new()
    .base_uri(Some(base_uri))
    .id_generator(|links, title, uri| {
      let link = links.first().map(|value| value.href.as_str()).unwrap_or("");
      let title = title.as_ref().map(|value| value.content.as_str()).unwrap_or("");
      let uri = uri.unwrap_or("");
      format!(
        "{PODCAST_SYNTHETIC_ID_PREFIX}{}",
        hash_identifier("feed-generated-id", &[uri, link, title])
      )
    })
    .build()
}

fn repair_feed_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
  let encoding = detect_feed_encoding(bytes);
  let (decoded, _, _) = encoding.decode(bytes);
  let decoded = decoded.trim_start_matches(|character: char| {
    character == '\u{feff}' || character == '\0' || character.is_ascii_whitespace()
  });
  let mut text = decoded
    .chars()
    .filter(|character| is_allowed_xml_character(*character))
    .collect::<String>();
  rewrite_xml_encoding_as_utf8(&mut text);
  Some(repair_entities_outside_cdata(&text)?.into_bytes())
}

fn detect_feed_encoding(bytes: &[u8]) -> &'static Encoding {
  if let Some((encoding, _)) = Encoding::for_bom(bytes) {
    return encoding;
  }
  let head = &bytes[..bytes.len().min(512)];
  let little_endian_marker = find_bytes(head, b"<\0?\0x\0m\0l\0");
  let big_endian_marker = find_bytes(head, b"\0<\0?\0x\0m\0l");
  match (little_endian_marker, big_endian_marker) {
    (Some(little), Some(big)) => return if little < big { UTF_16LE } else { UTF_16BE },
    (Some(_), None) => return UTF_16LE,
    (None, Some(_)) => return UTF_16BE,
    (None, None) => {}
  }
  declared_xml_encoding(head).unwrap_or(UTF_8)
}

fn declared_xml_encoding(head: &[u8]) -> Option<&'static Encoding> {
  let lowered = head.iter().map(u8::to_ascii_lowercase).collect::<Vec<_>>();
  let declaration_start = find_bytes(&lowered, b"<?xml")?;
  let declaration_end = find_bytes(&lowered[declaration_start..], b"?>")? + declaration_start;
  let encoding_start = find_bytes(&lowered[declaration_start..declaration_end], b"encoding")?
    + declaration_start
    + b"encoding".len();
  let mut cursor = encoding_start;
  while lowered.get(cursor).is_some_and(u8::is_ascii_whitespace) {
    cursor += 1;
  }
  if lowered.get(cursor) != Some(&b'=') {
    return None;
  }
  cursor += 1;
  while lowered.get(cursor).is_some_and(u8::is_ascii_whitespace) {
    cursor += 1;
  }
  let quote = *lowered.get(cursor)?;
  if quote != b'"' && quote != b'\'' {
    return None;
  }
  cursor += 1;
  let end = lowered[cursor..declaration_end].iter().position(|byte| *byte == quote)? + cursor;
  Encoding::for_label(&lowered[cursor..end])
}

fn rewrite_xml_encoding_as_utf8(text: &mut String) {
  let Some(declaration_end) = text.find("?>") else {
    return;
  };
  let declaration = &text[..declaration_end];
  if !declaration.trim_start().starts_with("<?xml") {
    return;
  }
  let lowered = declaration.to_ascii_lowercase();
  let Some(name_start) = lowered.find("encoding") else {
    return;
  };
  let Some(equals_offset) = lowered[name_start + b"encoding".len()..].find('=') else {
    return;
  };
  let equals = name_start + b"encoding".len() + equals_offset;
  let Some(quote_offset) = lowered[equals + 1..].find(['"', '\'']) else {
    return;
  };
  let quote_start = equals + 1 + quote_offset;
  let quote = lowered.as_bytes()[quote_start];
  let Some(value_length) = lowered[quote_start + 1..].bytes().position(|byte| byte == quote) else {
    return;
  };
  let value_start = quote_start + 1;
  let value_end = value_start + value_length;
  text.replace_range(value_start..value_end, "UTF-8");
}

fn repair_entities_outside_cdata(text: &str) -> Option<String> {
  let mut output = String::with_capacity(text.len());
  let mut remainder = text;
  while let Some(cdata_start) = remainder.find("<![CDATA[") {
    append_repaired_xml_entities(&mut output, &remainder[..cdata_start])?;
    let cdata = &remainder[cdata_start..];
    let Some(cdata_end) = cdata.find("]]>") else {
      append_repair_fragment(&mut output, cdata)?;
      return Some(output);
    };
    let cdata_end = cdata_end + b"]]>".len();
    append_repair_fragment(&mut output, &cdata[..cdata_end])?;
    remainder = &cdata[cdata_end..];
  }
  append_repaired_xml_entities(&mut output, remainder)?;
  Some(output)
}

fn append_repaired_xml_entities(output: &mut String, text: &str) -> Option<()> {
  let bytes = text.as_bytes();
  let mut cursor = 0usize;
  while cursor < bytes.len() {
    if bytes[cursor] != b'&' {
      let character = text[cursor..].chars().next().expect("valid UTF-8 character");
      if output.len().saturating_add(character.len_utf8()) > PODCAST_FEED_RESPONSE_LIMIT {
        return None;
      }
      output.push(character);
      cursor += character.len_utf8();
      continue;
    }

    let entity_end = bytes[cursor + 1..bytes.len().min(cursor + 35)]
      .iter()
      .position(|byte| *byte == b';')
      .map(|offset| cursor + 1 + offset);
    let Some(entity_end) = entity_end else {
      append_repair_fragment(output, "&amp;")?;
      cursor += 1;
      continue;
    };
    let entity = &text[cursor + 1..entity_end];
    if is_valid_xml_entity(entity) {
      append_repair_fragment(output, &text[cursor..=entity_end])?;
      cursor = entity_end + 1;
      continue;
    }
    if is_named_entity(entity) {
      if let Some(replacement) = html_entity_numeric_reference(entity) {
        append_repair_fragment(output, replacement)?;
      } else {
        append_repair_fragment(output, "&amp;")?;
        append_repair_fragment(output, entity)?;
        append_repair_fragment(output, ";")?;
      }
      cursor = entity_end + 1;
      continue;
    }
    append_repair_fragment(output, "&amp;")?;
    cursor += 1;
  }
  Some(())
}

fn append_repair_fragment(output: &mut String, value: &str) -> Option<()> {
  if output.len().saturating_add(value.len()) > PODCAST_FEED_RESPONSE_LIMIT {
    return None;
  }
  output.push_str(value);
  Some(())
}

fn is_valid_xml_entity(entity: &str) -> bool {
  matches!(entity, "amp" | "lt" | "gt" | "quot" | "apos")
    || entity
      .strip_prefix('#')
      .is_some_and(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
    || entity
      .strip_prefix("#x")
      .or_else(|| entity.strip_prefix("#X"))
      .is_some_and(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn is_named_entity(entity: &str) -> bool {
  entity.len() <= 32
    && entity.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
    && entity.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn html_entity_numeric_reference(entity: &str) -> Option<&'static str> {
  match entity {
    "nbsp" => Some("&#160;"),
    "copy" => Some("&#169;"),
    "reg" => Some("&#174;"),
    "middot" => Some("&#183;"),
    "ndash" => Some("&#8211;"),
    "mdash" => Some("&#8212;"),
    "lsquo" => Some("&#8216;"),
    "rsquo" => Some("&#8217;"),
    "ldquo" => Some("&#8220;"),
    "rdquo" => Some("&#8221;"),
    "bull" => Some("&#8226;"),
    "hellip" => Some("&#8230;"),
    "trade" => Some("&#8482;"),
    _ => None,
  }
}

fn is_allowed_xml_character(character: char) -> bool {
  matches!(character, '\t' | '\n' | '\r')
    || (character >= '\u{20}' && character != '\u{fffe}' && character != '\u{ffff}')
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
  (!needle.is_empty() && needle.len() <= haystack.len())
    .then(|| haystack.windows(needle.len()).position(|window| window == needle))
    .flatten()
}

fn extract_rss_enclosures(bytes: &[u8], base_uri: &str) -> Vec<Option<Enclosure>> {
  let mut reader = Reader::from_reader(bytes);
  let mut enclosures = Vec::new();
  let mut current_entry = None;
  let mut base_stack = vec![Url::parse(base_uri).ok()];
  loop {
    match reader.read_event() {
      Ok(Event::Start(element)) => {
        let name = element.name();
        let base_url = element_base_url(&element, reader.decoder(), base_stack.last().and_then(Option::as_ref));
        base_stack.push(base_url);
        if is_feed_entry_element(name.as_ref()) {
          enclosures.push(None);
          current_entry = Some(enclosures.len() - 1);
        } else if is_rss_enclosure_element(name.as_ref()) {
          if let Some(index) = current_entry {
            if enclosures[index].is_none() {
              enclosures[index] =
                enclosure_from_xml(&element, reader.decoder(), base_stack.last().and_then(Option::as_ref));
            }
          }
        }
      }
      Ok(Event::Empty(element)) => {
        let name = element.name();
        let base_url = element_base_url(&element, reader.decoder(), base_stack.last().and_then(Option::as_ref));
        if is_feed_entry_element(name.as_ref()) {
          enclosures.push(None);
        } else if is_rss_enclosure_element(name.as_ref()) {
          if let Some(index) = current_entry {
            if enclosures[index].is_none() {
              enclosures[index] = enclosure_from_xml(&element, reader.decoder(), base_url.as_ref());
            }
          }
        }
      }
      Ok(Event::End(element)) => {
        let name = element.name();
        if is_feed_entry_element(name.as_ref()) {
          current_entry = None;
        }
        if base_stack.len() > 1 {
          base_stack.pop();
        }
      }
      Ok(Event::Eof) => break,
      Err(_) => return Vec::new(),
      _ => {}
    }
  }
  enclosures
}

fn extract_episode_extensions(
  bytes: &[u8],
  base_uri: &str,
) -> Option<Vec<ParsedEpisodeExtensions>> {
  let mut reader = NsReader::from_reader(bytes);
  let mut extensions = Vec::<ParsedEpisodeExtensions>::new();
  let mut current_entry = None;
  let mut psc_entry = None;
  let mut base_stack = vec![Url::parse(base_uri).ok()];
  loop {
    let decoder = reader.decoder();
    let (namespace, event) = reader.read_resolved_event().ok()?;
    let namespace_uri = match &namespace {
      ResolveResult::Bound(Namespace(value)) => Some((*value).to_vec()),
      _ => None,
    };
    drop(namespace);
    match event {
      Event::Start(element) => {
        let local_name = element.local_name();
        let base_url = element_base_url(
          &element,
          decoder,
          base_stack.last().and_then(Option::as_ref),
        );
        base_stack.push(base_url);
        if is_feed_entry_element(local_name.as_ref()) {
          extensions.push(ParsedEpisodeExtensions::default());
          current_entry = Some(extensions.len() - 1);
          psc_entry = None;
          continue;
        }
        let Some(entry_index) = current_entry else {
          continue;
        };
        collect_episode_extension_element(
          namespace_uri.as_deref(),
          &element,
          decoder,
          base_stack.last().and_then(Option::as_ref),
          entry_index,
          &mut psc_entry,
          &mut extensions,
        );
      }
      Event::Empty(element) => {
        let local_name = element.local_name();
        let base_url = element_base_url(
          &element,
          decoder,
          base_stack.last().and_then(Option::as_ref),
        );
        if is_feed_entry_element(local_name.as_ref()) {
          extensions.push(ParsedEpisodeExtensions::default());
          continue;
        }
        let Some(entry_index) = current_entry else {
          continue;
        };
        collect_episode_extension_element(
          namespace_uri.as_deref(),
          &element,
          decoder,
          base_url.as_ref(),
          entry_index,
          &mut psc_entry,
          &mut extensions,
        );
        if namespace_is(
          namespace_uri.as_deref(),
          PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI,
        ) && local_name.as_ref() == b"chapters"
        {
          psc_entry = None;
        }
      }
      Event::End(element) => {
        let local_name = element.local_name();
        if namespace_is(namespace_uri.as_deref(), PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI)
          && local_name.as_ref() == b"chapters"
        {
          psc_entry = None;
        }
        if is_feed_entry_element(local_name.as_ref()) {
          current_entry = None;
          psc_entry = None;
        }
        if base_stack.len() > 1 {
          base_stack.pop();
        }
      }
      Event::Eof => break,
      _ => {}
    }
  }
  for entry in &mut extensions {
    normalize_parsed_episode_resources(&mut entry.resources);
  }
  Some(extensions)
}

fn collect_episode_extension_element(
  namespace: Option<&[u8]>,
  element: &BytesStart<'_>,
  decoder: quick_xml::Decoder,
  base_url: Option<&Url>,
  entry_index: usize,
  psc_entry: &mut Option<usize>,
  extensions: &mut [ParsedEpisodeExtensions],
) {
  let local_name = element.local_name();
  if namespace_is_podcast(namespace) && local_name.as_ref() == b"chapters" {
    if extensions[entry_index]
      .resources
      .iter()
      .any(|resource| resource.source_kind == "podcast-json")
    {
      return;
    }
    let url = xml_attribute(element, decoder, b"url")
      .and_then(|value| resolve_resource_url(&value, base_url, true));
    let mime_type = xml_attribute(element, decoder, b"type")
      .and_then(|value| clean_text(&value, 200));
    if let (Some(url), Some(mime_type)) = (url, mime_type) {
      if is_json_chapter_mime_type(&mime_type) {
        extensions[entry_index].resources.push(ParsedEpisodeResource {
          kind: "chapters",
          source_kind: "podcast-json",
          url: Some(url),
          mime_type: Some(mime_type),
          language: None,
          relation: None,
          ordinal: 0,
          chapters: Vec::new(),
        });
      }
    }
    return;
  }
  if namespace_is_podcast(namespace) && local_name.as_ref() == b"transcript" {
    let transcript_count = extensions[entry_index]
      .resources
      .iter()
      .filter(|resource| resource.kind == "transcript")
      .count();
    if transcript_count >= PODCAST_TRANSCRIPT_SOURCE_MAX_COUNT {
      return;
    }
    let url = xml_attribute(element, decoder, b"url")
      .and_then(|value| resolve_resource_url(&value, base_url, true));
    let mime_type = xml_attribute(element, decoder, b"type")
      .and_then(|value| clean_text(&value, 200));
    if let (Some(url), Some(mime_type)) = (url, mime_type) {
      extensions[entry_index].resources.push(ParsedEpisodeResource {
        kind: "transcript",
        source_kind: "podcast-transcript",
        url: Some(url),
        mime_type: Some(mime_type),
        language: xml_attribute(element, decoder, b"language")
          .and_then(|value| clean_text(&value, 50)),
        relation: xml_attribute(element, decoder, b"rel")
          .and_then(|value| clean_text(&value, 100)),
        ordinal: transcript_count,
        chapters: Vec::new(),
      });
    }
    return;
  }
  if namespace_is(namespace, PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI)
    && local_name.as_ref() == b"chapters"
  {
    if extensions[entry_index]
      .resources
      .iter()
      .any(|resource| resource.source_kind == "psc")
    {
      return;
    }
    extensions[entry_index].resources.push(ParsedEpisodeResource {
      kind: "chapters",
      source_kind: "psc",
      url: None,
      mime_type: Some("application/xml".to_string()),
      language: None,
      relation: None,
      ordinal: 1,
      chapters: Vec::new(),
    });
    *psc_entry = Some(entry_index);
    return;
  }
  if namespace_is(namespace, PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI)
    && local_name.as_ref() == b"chapter"
    && *psc_entry == Some(entry_index)
  {
    let Some(resource) = extensions[entry_index]
      .resources
      .iter_mut()
      .find(|resource| resource.source_kind == "psc")
    else {
      return;
    };
    if resource.chapters.len() >= PODCAST_CHAPTER_MAX_COUNT {
      return;
    }
    let start_ms = xml_attribute(element, decoder, b"start")
      .and_then(|value| parse_psc_time_ms(&value));
    let title = xml_attribute(element, decoder, b"title")
      .and_then(|value| clean_text(&value, PODCAST_TITLE_LIMIT));
    if let (Some(start_ms), Some(title)) = (start_ms, title) {
      resource.chapters.push(ParsedPodcastChapter {
        start_ms,
        end_ms: None,
        title,
        href: xml_attribute(element, decoder, b"href")
          .and_then(|value| resolve_resource_url(&value, base_url, false)),
        image_url: xml_attribute(element, decoder, b"image")
          .and_then(|value| resolve_resource_url(&value, base_url, false)),
        visible: true,
      });
    }
  }
}

fn namespace_is(namespace: Option<&[u8]>, expected: &[u8]) -> bool {
  namespace == Some(expected)
}

fn namespace_is_podcast(namespace: Option<&[u8]>) -> bool {
  namespace_is(namespace, PODCAST_NAMESPACE_URI)
    || namespace_is(namespace, PODCAST_NAMESPACE_COMPAT_URI)
}

fn xml_attribute(
  element: &BytesStart<'_>,
  decoder: quick_xml::Decoder,
  local_name: &[u8],
) -> Option<String> {
  element
    .attributes()
    .with_checks(false)
    .filter_map(Result::ok)
    .find(|attribute| attribute.key.local_name().as_ref() == local_name)
    .and_then(|attribute| {
      attribute
        .decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder)
        .ok()
        .map(|value| value.into_owned())
    })
}

fn resolve_resource_url(
  value: &str,
  base_url: Option<&Url>,
  require_https: bool,
) -> Option<String> {
  let url = Url::parse(value.trim())
    .ok()
    .or_else(|| base_url.and_then(|base_url| base_url.join(value.trim()).ok()))?;
  if require_https && url.scheme() != "https" {
    return None;
  }
  validate_url_with_policy(&url, false).ok()?;
  clean_url_string(url.as_str())
}

fn is_json_chapter_mime_type(value: &str) -> bool {
  matches!(
    value
      .split(';')
      .next()
      .unwrap_or_default()
      .trim()
      .to_ascii_lowercase()
      .as_str(),
    "application/json+chapters" | "application/json"
  )
}

fn parse_psc_time_ms(value: &str) -> Option<i64> {
  let parts = value.trim().split(':').collect::<Vec<_>>();
  if parts.is_empty() || parts.len() > 3 {
    return None;
  }
  let seconds = parts.last()?.parse::<f64>().ok()?;
  if !seconds.is_finite() || seconds < 0.0 || (parts.len() > 1 && seconds >= 60.0) {
    return None;
  }
  let mut total_seconds = seconds;
  if parts.len() >= 2 {
    let minutes = parts[parts.len() - 2].parse::<u64>().ok()?;
    if parts.len() == 3 && minutes >= 60 {
      return None;
    }
    total_seconds += minutes as f64 * 60.0;
  }
  if parts.len() == 3 {
    let hours = parts[0].parse::<u64>().ok()?;
    total_seconds += hours as f64 * 3_600.0;
  }
  let milliseconds = (total_seconds * 1_000.0).round();
  (milliseconds.is_finite() && milliseconds >= 0.0 && milliseconds <= i64::MAX as f64)
    .then_some(milliseconds as i64)
}

fn normalize_parsed_episode_resources(resources: &mut Vec<ParsedEpisodeResource>) {
  for resource in resources.iter_mut() {
    resource.chapters.sort_by_key(|chapter| chapter.start_ms);
    resource
      .chapters
      .dedup_by_key(|chapter| chapter.start_ms);
  }
  resources.retain(|resource| {
    resource.source_kind != "psc" || !resource.chapters.is_empty()
  });
  let mut seen = HashSet::new();
  resources.retain(|resource| {
    let key = format!(
      "{}\0{}\0{}\0{}\0{}",
      resource.kind,
      resource.source_kind,
      resource.url.as_deref().unwrap_or_default(),
      resource.mime_type.as_deref().unwrap_or_default(),
      resource.language.as_deref().unwrap_or_default(),
    );
    seen.insert(key)
  });
  for (ordinal, resource) in resources.iter_mut().enumerate() {
    resource.ordinal = ordinal;
  }
}

fn is_feed_entry_element(name: &[u8]) -> bool {
  name == b"item" || name == b"entry"
}

fn is_rss_enclosure_element(name: &[u8]) -> bool {
  name == b"enclosure"
    || (name.ends_with(b":enclosure") && !name.eq_ignore_ascii_case(b"media:enclosure"))
}

fn element_base_url(
  element: &BytesStart<'_>,
  decoder: quick_xml::Decoder,
  inherited: Option<&Url>,
) -> Option<Url> {
  for attribute in element.attributes().with_checks(false) {
    let Ok(attribute) = attribute else {
      continue;
    };
    if attribute.key.as_ref() != b"xml:base" {
      continue;
    }
    let value = attribute
      .decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder)
      .ok()?;
    return Url::parse(&value)
      .ok()
      .or_else(|| inherited.and_then(|base_url| base_url.join(&value).ok()));
  }
  inherited.cloned()
}

fn enclosure_from_xml(
  element: &BytesStart<'_>,
  decoder: quick_xml::Decoder,
  base_url: Option<&Url>,
) -> Option<Enclosure> {
  let mut raw_url = None;
  let mut content_type = None;
  let mut length = None;
  for attribute in element.attributes().with_checks(false) {
    let Ok(attribute) = attribute else {
      continue;
    };
    let Ok(value) = attribute.decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder) else {
      continue;
    };
    match attribute.key.local_name().as_ref() {
      b"url" | b"resource" => raw_url = clean_text(&value, 4_096),
      b"type" => content_type = clean_text(&value, 200),
      b"length" => length = value.trim().parse::<u64>().ok(),
      _ => {}
    }
  }
  let raw_url = raw_url?;
  let resolved = Url::parse(&raw_url)
    .ok()
    .or_else(|| base_url.and_then(|base_url| base_url.join(&raw_url).ok()))?;
  let url = clean_url_string(resolved.as_str())?;
  if !is_possible_audio_enclosure(content_type.as_deref(), &url) {
    return None;
  }
  Some(Enclosure {
    url,
    content_type,
    length,
    duration_seconds: None,
  })
}

fn normalize_feed(
  parsed: ParsedFeed,
  final_url: &str,
  title_hint: Option<&str>,
  author_hint: Option<&str>,
  artwork_hint: Option<&str>,
  etag: Option<String>,
  last_modified: Option<String>,
  rss_enclosures: &[Option<Enclosure>],
  episode_extensions: Option<&[ParsedEpisodeExtensions]>,
  allow_private_network: bool,
) -> Result<ParsedPodcast, String> {
  let normalized_url = normalize_url(final_url, allow_private_network)?;
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
    .or_else(|| clean_hint(author_hint, PODCAST_TITLE_LIMIT))
    .or_else(|| {
      parsed.contributors.iter().find_map(|person| {
        let value = if matches!(person.name.as_str(), "managingEditor" | "webMaster") {
          person.email.as_deref().unwrap_or(&person.name)
        } else {
          &person.name
        };
        let value = plain_text(value, PODCAST_TITLE_LIMIT);
        (!value.is_empty()).then_some(value)
      })
    });
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
    subscribed_at: None,
    last_checked_at: Some(fetched_at),
    last_refresh_error: None,
    latest_episode_at: None,
    unplayed_count: 0,
  };

  let mut episodes = Vec::new();
  for (index, entry) in parsed.entries.iter().enumerate() {
    if let Some(episode) = normalize_episode(
      entry,
      &feed_id,
      artwork_url.as_deref(),
      rss_enclosures.get(index).and_then(Option::as_ref),
      episode_extensions
        .map(|extensions| {
          extensions
            .get(index)
            .map(|entry| entry.resources.clone())
            .unwrap_or_default()
        }),
    ) {
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

fn normalize_episode(
  entry: &ParsedEntry,
  feed_id: &str,
  feed_artwork: Option<&str>,
  rss_enclosure: Option<&Enclosure>,
  resources: Option<Vec<ParsedEpisodeResource>>,
) -> Option<ParsedPodcastEpisode> {
  let enclosure = rss_enclosure.cloned().or_else(|| find_enclosure(entry))?;
  let guid = clean_text(&entry.id, 4_096).filter(|value| !value.starts_with(PODCAST_SYNTHETIC_ID_PREFIX));
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
  let webpage_url = entry.links.iter().find_map(|link| {
    if link.rel.as_deref() == Some("enclosure")
      || link
        .media_type
        .as_deref()
        .is_some_and(|content_type| content_type.to_ascii_lowercase().starts_with("audio/"))
    {
      return None;
    }
    clean_url_string(&link.href)
  });

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
    webpage_url,
    resources,
  })
}

#[derive(Clone)]
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
        subscribed INTEGER NOT NULL DEFAULT 1,
        subscribed_at INTEGER,
        last_checked_at INTEGER,
        last_refresh_error TEXT
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
        first_seen_at INTEGER NOT NULL,
        webpage_url TEXT,
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

      CREATE TABLE IF NOT EXISTS podcast_episode_resources (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('chapters', 'transcript')),
        source_kind TEXT NOT NULL CHECK(
          source_kind IN ('podcast-json', 'psc', 'podcast-transcript')
        ),
        url TEXT,
        mime_type TEXT,
        language TEXT,
        relation TEXT,
        ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0),
        etag TEXT,
        last_modified TEXT,
        fetched_at INTEGER,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS podcast_chapters (
        resource_id TEXT NOT NULL REFERENCES podcast_episode_resources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
        end_ms INTEGER,
        title TEXT NOT NULL,
        href TEXT,
        image_url TEXT,
        visible INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(resource_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS podcast_episodes_feed_published
        ON podcast_episodes(feed_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS podcast_saved_episodes_saved_at
        ON podcast_saved_episodes(saved_at DESC);
      CREATE INDEX IF NOT EXISTS podcast_queue_position
        ON podcast_queue(position, added_at, episode_id);
      CREATE INDEX IF NOT EXISTS podcast_episode_resources_episode
        ON podcast_episode_resources(episode_id, kind, ordinal);
      CREATE INDEX IF NOT EXISTS podcast_chapters_resource_start
        ON podcast_chapters(resource_id, start_ms, ordinal);
      ",
    )
    .map_err(|error| format!("无法初始化播客数据库：{error}"))?;
  ensure_database_column(
    &connection,
    "podcast_feeds",
    "subscribed",
    "subscribed INTEGER NOT NULL DEFAULT 1",
  )?;
  ensure_database_column(
    &connection,
    "podcast_feeds",
    "subscribed_at",
    "subscribed_at INTEGER",
  )?;
  ensure_database_column(
    &connection,
    "podcast_feeds",
    "last_checked_at",
    "last_checked_at INTEGER",
  )?;
  ensure_database_column(
    &connection,
    "podcast_feeds",
    "last_refresh_error",
    "last_refresh_error TEXT",
  )?;
  ensure_database_column(
    &connection,
    "podcast_episodes",
    "first_seen_at",
    "first_seen_at INTEGER NOT NULL DEFAULT 0",
  )?;
  ensure_database_column(
    &connection,
    "podcast_episodes",
    "webpage_url",
    "webpage_url TEXT",
  )?;
  connection
    .execute_batch(
      "
      UPDATE podcast_feeds SET
        subscribed_at = CASE
          WHEN subscribed = 1 THEN COALESCE(subscribed_at, last_fetched_at)
          ELSE NULL
        END,
        last_checked_at = COALESCE(last_checked_at, last_fetched_at);

      UPDATE podcast_episodes SET
        first_seen_at = COALESCE(
          NULLIF(first_seen_at, 0),
          (SELECT last_fetched_at FROM podcast_feeds WHERE id = podcast_episodes.feed_id),
          published_at,
          0
        )
      WHERE first_seen_at = 0;

      CREATE INDEX IF NOT EXISTS podcast_feeds_subscribed_title
        ON podcast_feeds(subscribed, title COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS podcast_feeds_refresh
        ON podcast_feeds(subscribed, last_checked_at);
      CREATE INDEX IF NOT EXISTS podcast_episodes_first_seen
        ON podcast_episodes(feed_id, first_seen_at DESC);
      ",
    )
    .map_err(|error| format!("无法初始化播客数据库索引：{error}"))?;
  Ok(connection)
}

fn ensure_database_column(
  connection: &Connection,
  table: &str,
  column: &str,
  definition: &str,
) -> Result<(), String> {
  let mut statement = connection
    .prepare(&format!("PRAGMA table_info({table})"))
    .map_err(|error| format!("无法检查播客数据库结构：{error}"))?;
  let columns = statement
    .query_map([], |row| row.get::<_, String>(1))
    .map_err(|error| format!("无法检查播客数据库结构：{error}"))?;
  for existing in columns {
    if existing.map_err(|error| format!("无法检查播客数据库结构：{error}"))? == column {
      return Ok(());
    }
  }
  connection
    .execute(&format!("ALTER TABLE {table} ADD COLUMN {definition}"), [])
    .map_err(|error| format!("无法迁移播客数据库：{error}"))?;
  Ok(())
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
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客订阅：{error}"))?;
  let ParsedPodcast {
    mut feed,
    mut episodes,
    etag,
    last_modified,
  } = parsed;
  let current_feed_url = transaction
    .query_row(
      "SELECT feed_url FROM podcast_feeds WHERE id = ?1",
      [&feed.id],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取播客订阅地址：{error}"))?;
  let url_owner_id = transaction
    .query_row(
      "SELECT id FROM podcast_feeds WHERE feed_url = ?1",
      [&feed.feed_url],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取播客订阅地址：{error}"))?;
  match (current_feed_url, url_owner_id) {
    (Some(current_feed_url), Some(url_owner_id)) if url_owner_id != feed.id => {
      feed.feed_url = current_feed_url;
    }
    (None, Some(url_owner_id)) => {
      feed.id = url_owner_id;
      remap_episode_identifiers(&mut episodes, &feed.id);
    }
    _ => {}
  }
  let existing_subscription = transaction
    .query_row(
      "SELECT subscribed, subscribed_at FROM podcast_feeds WHERE id = ?1",
      [&feed.id],
      |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, Option<i64>>(1)?)),
    )
    .optional()
    .map_err(|error| format!("无法读取播客关注状态：{error}"))?;
  let existing_subscribed = existing_subscription
    .as_ref()
    .is_some_and(|(subscribed, _)| *subscribed);
  feed.subscribed = requested_subscribed || existing_subscribed;
  feed.subscribed_at = if feed.subscribed {
    existing_subscription
      .and_then(|(_, subscribed_at)| subscribed_at)
      .or(Some(feed.last_fetched_at))
  } else {
    None
  };
  feed.last_checked_at = Some(feed.last_checked_at.unwrap_or(feed.last_fetched_at));
  feed.last_refresh_error = None;
  transaction
    .execute(
      "
      INSERT INTO podcast_feeds (
        id, feed_url, title, author, description, artwork_url,
        etag, last_modified, last_fetched_at, subscribed,
        subscribed_at, last_checked_at, last_refresh_error
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(id) DO UPDATE SET
        feed_url = excluded.feed_url,
        title = excluded.title,
        author = excluded.author,
        description = excluded.description,
        artwork_url = excluded.artwork_url,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        last_fetched_at = excluded.last_fetched_at,
        subscribed = excluded.subscribed,
        subscribed_at = excluded.subscribed_at,
        last_checked_at = excluded.last_checked_at,
        last_refresh_error = excluded.last_refresh_error
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
        feed.subscribed_at,
        feed.last_checked_at,
        feed.last_refresh_error,
      ],
    )
    .map_err(|error| format!("无法保存播客订阅：{error}"))?;

  let mut inserted_count = 0usize;
  let mut updated_count = 0usize;
  {
    let mut insert = transaction
      .prepare(
        "
        INSERT INTO podcast_episodes (
          id, feed_id, identity_key, guid, title, description, published_at,
          duration_seconds, enclosure_url, enclosure_type, artwork_url, expected_bytes,
          first_seen_at, webpage_url
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
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
          expected_bytes = ?12,
          webpage_url = ?14
        WHERE id = ?1 AND feed_id = ?2
          AND (
            identity_key IS NOT ?3
            OR guid IS NOT ?4
            OR title IS NOT ?5
            OR description IS NOT ?6
            OR published_at IS NOT ?7
            OR duration_seconds IS NOT ?8
            OR enclosure_url IS NOT ?9
            OR enclosure_type IS NOT ?10
            OR artwork_url IS NOT ?11
            OR expected_bytes IS NOT ?12
            OR webpage_url IS NOT ?14
          )
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
        feed.last_fetched_at,
        episode.webpage_url,
      ];
      let inserted = insert
        .execute(values)
        .map_err(|error| format!("无法保存播客单集：{error}"))?;
      inserted_count += inserted;
      if inserted == 0 {
        updated_count += update
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
          feed.last_fetched_at,
          episode.webpage_url,
          ])
          .map_err(|error| format!("无法更新播客单集：{error}"))?;
      }
      reconcile_episode_resources(&transaction, episode)?;
    }
  }
  let (latest_episode_at, unplayed_count) = transaction
    .query_row(
      "
      SELECT
        MAX(COALESCE(e.published_at, e.first_seen_at)),
        SUM(
          CASE
            WHEN COALESCE(p.completed, 0) = 0
              AND COALESCE(p.position_seconds, 0) <= 0
            THEN 1
            ELSE 0
          END
        )
      FROM podcast_episodes e
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      WHERE e.feed_id = ?1
      ",
      [&feed.id],
      |row| {
        Ok((
          row.get::<_, Option<i64>>(0)?,
          row.get::<_, Option<i64>>(1)?.unwrap_or(0),
        ))
      },
    )
    .map_err(|error| format!("无法读取播客节目统计：{error}"))?;
  feed.latest_episode_at = latest_episode_at;
  feed.unplayed_count = unplayed_count.max(0) as u64;
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客订阅：{error}"))?;

  Ok(PodcastSubscribeResult {
    feed,
    episode_count: episodes.len(),
    inserted_count,
    updated_count,
  })
}

fn reconcile_episode_resources(
  transaction: &Transaction<'_>,
  episode: &ParsedPodcastEpisode,
) -> Result<(), String> {
  let Some(resources) = episode.resources.as_ref() else {
    return Ok(());
  };
  let mut existing_statement = transaction
    .prepare("SELECT id FROM podcast_episode_resources WHERE episode_id = ?1")
    .map_err(|error| format!("无法读取播客单集资源：{error}"))?;
  let existing_ids = existing_statement
    .query_map([&episode.id], |row| row.get::<_, String>(0))
    .map_err(|error| format!("无法读取播客单集资源：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客单集资源：{error}"))?;
  drop(existing_statement);

  let mut active_ids = HashSet::new();
  for resource in resources {
    let resource_id = parsed_episode_resource_id(&episode.id, resource);
    active_ids.insert(resource_id.clone());
    transaction
      .execute(
        "
        INSERT INTO podcast_episode_resources (
          id, episode_id, kind, source_kind, url, mime_type, language,
          relation, ordinal, etag, last_modified, fetched_at, error_message
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          episode_id = excluded.episode_id,
          kind = excluded.kind,
          source_kind = excluded.source_kind,
          url = excluded.url,
          mime_type = excluded.mime_type,
          language = excluded.language,
          relation = excluded.relation,
          ordinal = excluded.ordinal
        ",
        params![
          resource_id,
          episode.id,
          resource.kind,
          resource.source_kind,
          resource.url,
          resource.mime_type,
          resource.language,
          resource.relation,
          i64::try_from(resource.ordinal).unwrap_or(i64::MAX),
        ],
      )
      .map_err(|error| format!("无法保存播客单集资源：{error}"))?;
    if resource.source_kind == "psc" {
      replace_podcast_chapters(transaction, &resource_id, &resource.chapters)?;
    }
  }
  for existing_id in existing_ids {
    if active_ids.contains(&existing_id) {
      continue;
    }
    transaction
      .execute(
        "DELETE FROM podcast_episode_resources WHERE id = ?1 AND episode_id = ?2",
        params![existing_id, episode.id],
      )
      .map_err(|error| format!("无法清理播客单集资源：{error}"))?;
  }
  Ok(())
}

fn parsed_episode_resource_id(
  episode_id: &str,
  resource: &ParsedEpisodeResource,
) -> String {
  hash_identifier(
    "episode-resource",
    &[
      episode_id,
      resource.kind,
      resource.source_kind,
      resource.url.as_deref().unwrap_or_default(),
      resource.mime_type.as_deref().unwrap_or_default(),
      resource.language.as_deref().unwrap_or_default(),
      resource.relation.as_deref().unwrap_or_default(),
    ],
  )
}

fn replace_podcast_chapters(
  transaction: &Transaction<'_>,
  resource_id: &str,
  chapters: &[ParsedPodcastChapter],
) -> Result<(), String> {
  transaction
    .execute(
      "DELETE FROM podcast_chapters WHERE resource_id = ?1",
      [resource_id],
    )
    .map_err(|error| format!("无法更新播客章节：{error}"))?;
  let mut insert = transaction
    .prepare(
      "
      INSERT INTO podcast_chapters (
        resource_id, ordinal, start_ms, end_ms, title, href, image_url, visible
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ",
    )
    .map_err(|error| format!("无法准备播客章节写入：{error}"))?;
  for (ordinal, chapter) in chapters.iter().take(PODCAST_CHAPTER_MAX_COUNT).enumerate() {
    insert
      .execute(params![
        resource_id,
        i64::try_from(ordinal).unwrap_or(i64::MAX),
        chapter.start_ms,
        chapter.end_ms,
        chapter.title,
        chapter.href,
        chapter.image_url,
        i64::from(chapter.visible),
      ])
      .map_err(|error| format!("无法保存播客章节：{error}"))?;
  }
  Ok(())
}

fn list_refresh_targets(
  db_path: &Path,
  feed_id: Option<&str>,
  force: bool,
  now: i64,
) -> Result<Vec<PodcastRefreshTarget>, String> {
  let connection = open_database(db_path)?;
  if let Some(feed_id) = feed_id {
    let exists = connection
      .query_row(
        "SELECT 1 FROM podcast_feeds WHERE id = ?1",
        [feed_id],
        |_| Ok(()),
      )
      .optional()
      .map_err(|error| format!("无法读取播客订阅：{error}"))?
      .is_some();
    if !exists {
      return Err("播客节目不存在".to_string());
    }
  }
  let cutoff = now.saturating_sub(PODCAST_REFRESH_INTERVAL);
  let mut statement = connection
    .prepare(
      "
      SELECT id, feed_url, title, author, artwork_url, etag, last_modified
      FROM podcast_feeds
      WHERE ((?1 IS NULL AND subscribed = 1) OR id = ?1)
        AND (?2 = 1 OR last_checked_at IS NULL OR last_checked_at <= ?3)
      ORDER BY COALESCE(last_checked_at, 0), title COLLATE NOCASE
      ",
    )
    .map_err(|error| format!("无法读取播客刷新列表：{error}"))?;
  let rows = statement
    .query_map(
      params![feed_id, i64::from(force), cutoff],
      |row| {
        Ok(PodcastRefreshTarget {
          id: row.get(0)?,
          feed_url: row.get(1)?,
          title: row.get(2)?,
          author: row.get(3)?,
          artwork_url: row.get(4)?,
          etag: row.get(5)?,
          last_modified: row.get(6)?,
        })
      },
    )
    .map_err(|error| format!("无法读取播客刷新列表：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客刷新列表：{error}"))
}

fn mark_refresh_not_modified(
  db_path: &Path,
  feed_id: &str,
  checked_at: i64,
  etag: Option<String>,
  last_modified: Option<String>,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  let changed = connection
    .execute(
      "
      UPDATE podcast_feeds SET
        etag = COALESCE(?3, etag),
        last_modified = COALESCE(?4, last_modified),
        last_checked_at = ?2,
        last_refresh_error = NULL
      WHERE id = ?1
      ",
      params![feed_id, checked_at, etag, last_modified],
    )
    .map_err(|error| format!("无法保存播客刷新状态：{error}"))?;
  if changed == 0 {
    return Err("播客节目不存在".to_string());
  }
  Ok(())
}

fn mark_refresh_failed(
  db_path: &Path,
  feed_id: &str,
  checked_at: i64,
  message: &str,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  let changed = connection
    .execute(
      "
      UPDATE podcast_feeds SET
        last_checked_at = ?2,
        last_refresh_error = ?3
      WHERE id = ?1
      ",
      params![feed_id, checked_at, message],
    )
    .map_err(|error| format!("无法保存播客刷新错误：{error}"))?;
  if changed == 0 {
    return Err("播客节目不存在".to_string());
  }
  Ok(())
}

fn list_feeds(db_path: &Path) -> Result<Vec<PodcastFeed>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT
        f.id, f.feed_url, f.title, f.author, f.description, f.artwork_url,
        f.last_fetched_at, f.subscribed, f.subscribed_at,
        f.last_checked_at, f.last_refresh_error,
        (
          SELECT MAX(COALESCE(e.published_at, e.first_seen_at))
          FROM podcast_episodes e
          WHERE e.feed_id = f.id
        ),
        (
          SELECT COUNT(*)
          FROM podcast_episodes e
          LEFT JOIN podcast_progress p ON p.episode_id = e.id
          WHERE e.feed_id = f.id
            AND COALESCE(p.completed, 0) = 0
            AND COALESCE(p.position_seconds, 0) <= 0
        )
      FROM podcast_feeds f
      WHERE f.subscribed = 1
      ORDER BY f.title COLLATE NOCASE, f.id
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
        subscribed_at: row.get(8)?,
        last_checked_at: row.get(9)?,
        last_refresh_error: row.get(10)?,
        latest_episode_at: row.get(11)?,
        unplayed_count: row.get::<_, i64>(12)?.max(0) as u64,
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
      "
      UPDATE podcast_feeds SET
        subscribed = ?2,
        subscribed_at = CASE
          WHEN ?2 = 0 THEN NULL
          WHEN subscribed = 0 OR subscribed_at IS NULL THEN ?3
          ELSE subscribed_at
        END
      WHERE id = ?1
      ",
      params![feed_id, i64::from(following), unix_time_millis()],
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
        CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
        e.first_seen_at, e.webpage_url
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

fn list_related_episodes(
  db_path: &Path,
  downloads_dir: &Path,
  episode_id: &str,
  limit: usize,
) -> Result<Vec<PodcastEpisode>, String> {
  validate_identifier(episode_id)?;
  let connection = open_database(db_path)?;
  ensure_episode_exists(&connection, episode_id)?;
  let limit = limit.clamp(1, PODCAST_RELATED_EPISODE_MAX_LIMIT) as i64;
  let mut statement = connection
    .prepare(
      "
      WITH current_episode AS (
        SELECT feed_id
        FROM podcast_episodes
        WHERE id = ?1
      )
      SELECT
        e.id, e.feed_id, e.title, e.description, e.published_at,
        e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
        COALESCE(d.state, 'none'), d.local_path,
        COALESCE(d.downloaded_bytes, 0), d.total_bytes,
        COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
        f.title, f.artwork_url,
        CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
        e.first_seen_at, e.webpage_url
      FROM podcast_episodes e
      JOIN current_episode current ON current.feed_id = e.feed_id
      JOIN podcast_feeds f ON f.id = e.feed_id
      LEFT JOIN podcast_downloads d ON d.episode_id = e.id
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
      WHERE e.id != ?1
        AND TRIM(e.enclosure_url) != ''
      ORDER BY
        e.published_at IS NULL,
        COALESCE(e.published_at, e.first_seen_at) DESC,
        e.id
      LIMIT ?2
      ",
    )
    .map_err(|error| format!("无法读取相关播客单集：{error}"))?;
  let rows = statement
    .query_map(
      params![episode_id, limit],
      |row| podcast_episode_from_row(row, downloads_dir),
    )
    .map_err(|error| format!("无法读取相关播客单集：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取相关播客单集：{error}"))
}

fn list_home(db_path: &Path, downloads_dir: &Path) -> Result<PodcastHome, String> {
  let connection = open_database(db_path)?;
  prune_stale_download_records(&connection, downloads_dir)?;
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
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
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
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE f.subscribed = 1
    ORDER BY COALESCE(e.published_at, e.first_seen_at) DESC, e.id
    LIMIT ?1
    ",
    PODCAST_HOME_LATEST_LIMIT,
  )?;
  let unplayed_episodes = query_home_episodes(
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
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE f.subscribed = 1
      AND COALESCE(p.completed, 0) = 0
      AND COALESCE(p.position_seconds, 0) <= 0
    ORDER BY COALESCE(e.published_at, e.first_seen_at) DESC, e.id
    LIMIT ?1
    ",
    PODCAST_HOME_UNPLAYED_LIMIT,
  )?;
  let download_priority_episodes = query_home_episodes(
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
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE f.subscribed = 1
    ORDER BY
      CASE
        WHEN d.state = 'downloaded'
          AND NULLIF(TRIM(d.local_path), '') IS NOT NULL
        THEN 0
        ELSE 1
      END,
      COALESCE(e.published_at, e.first_seen_at) DESC,
      e.id
    LIMIT ?1
    ",
    PODCAST_HOME_DOWNLOAD_PRIORITY_LIMIT,
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
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE d.state = 'downloaded'
    ORDER BY d.updated_at DESC, e.id
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
      1,
      e.first_seen_at, e.webpage_url
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
  let recently_played_episodes = query_home_episodes(
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
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_progress p
    JOIN podcast_episodes e ON e.id = p.episode_id
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE p.position_seconds > 0 OR p.completed = 1
    ORDER BY p.updated_at DESC, e.id
    LIMIT ?1
    ",
    PODCAST_HOME_RECENTLY_PLAYED_LIMIT,
  )?;

  Ok(PodcastHome {
    continue_listening,
    latest_episodes,
    unplayed_episodes,
    download_priority_episodes,
    downloaded_episodes,
    saved_episodes,
    recently_played_episodes,
  })
}

fn list_downloads(
  db_path: &Path,
  downloads_dir: &Path,
  offset: usize,
  limit: usize,
) -> Result<PodcastDownloadPage, String> {
  let mut connection = open_database(db_path)?;
  prune_stale_download_records(&connection, downloads_dir)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Deferred)
    .map_err(|error| format!("无法读取播客下载资料库：{error}"))?;
  let (total_count, total_bytes, feed_count) = transaction
    .query_row(
      "
      SELECT
        COUNT(*),
        COALESCE(
          SUM(
            CASE
              WHEN d.downloaded_bytes > 0 THEN d.downloaded_bytes
              ELSE 0
            END
          ),
          0
        ),
        COUNT(DISTINCT e.feed_id)
      FROM podcast_downloads d
      JOIN podcast_episodes e ON e.id = d.episode_id
      WHERE d.state = 'downloaded'
      ",
      [],
      |row| {
        Ok((
          row.get::<_, i64>(0)?.max(0) as u64,
          row.get::<_, i64>(1)?.max(0) as u64,
          row.get::<_, i64>(2)?.max(0) as u64,
        ))
      },
    )
    .map_err(|error| format!("无法统计播客下载资料库：{error}"))?;

  let limit = limit.clamp(1, PODCAST_DOWNLOAD_PAGE_MAX_LIMIT);
  let sql_limit = i64::try_from(limit).unwrap_or(i64::MAX);
  let sql_offset = i64::try_from(offset).unwrap_or(i64::MAX);
  let episodes = {
    let mut statement = transaction
      .prepare(
        "
        SELECT
          e.id, e.feed_id, e.title, e.description, e.published_at,
          e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
          d.state, d.local_path, d.downloaded_bytes, d.total_bytes,
          COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
          f.title, f.artwork_url,
          CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
          e.first_seen_at, e.webpage_url
        FROM podcast_downloads d
        JOIN podcast_episodes e ON e.id = d.episode_id
        JOIN podcast_feeds f ON f.id = e.feed_id
        LEFT JOIN podcast_progress p ON p.episode_id = e.id
        LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
        WHERE d.state = 'downloaded'
        ORDER BY d.updated_at DESC, e.id
        LIMIT ?1 OFFSET ?2
        ",
      )
      .map_err(|error| format!("无法读取播客下载资料库：{error}"))?;
    let rows = statement
      .query_map(params![sql_limit, sql_offset], |row| {
        podcast_episode_from_row(row, downloads_dir)
      })
      .map_err(|error| format!("无法读取播客下载资料库：{error}"))?;
    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("无法读取播客下载资料库：{error}"))?
      .into_iter()
      .filter(|episode| episode.download_state == "downloaded")
      .collect::<Vec<_>>()
  };
  let returned_end = u64::try_from(offset)
    .unwrap_or(u64::MAX)
    .saturating_add(u64::try_from(episodes.len()).unwrap_or(u64::MAX));

  Ok(PodcastDownloadPage {
    episodes,
    total_count,
    total_bytes,
    feed_count,
    has_more: returned_end < total_count,
  })
}

fn prune_stale_download_records(
  connection: &Connection,
  downloads_dir: &Path,
) -> Result<(), String> {
  let downloads = {
    let mut statement = connection
      .prepare(
        "
        SELECT episode_id, local_path, updated_at
        FROM podcast_downloads
        WHERE state = 'downloaded'
        ",
      )
      .map_err(|error| format!("无法检查播客下载状态：{error}"))?;
    let rows = statement
      .query_map([], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, Option<String>>(1)?,
          row.get::<_, i64>(2)?,
        ))
      })
      .map_err(|error| format!("无法检查播客下载状态：{error}"))?;
    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("无法检查播客下载状态：{error}"))?
  };

  for (episode_id, local_path, updated_at) in downloads {
    let valid = local_path.as_deref().is_some_and(|value| {
      let path = PathBuf::from(value);
      path.is_file() && is_managed_download_path(downloads_dir, &episode_id, &path)
    });
    if valid {
      continue;
    }
    connection
      .execute(
        "
        DELETE FROM podcast_downloads
        WHERE episode_id = ?1
          AND state = 'downloaded'
          AND (
            (local_path IS NULL AND ?2 IS NULL)
            OR local_path = ?2
          )
          AND updated_at = ?3
        ",
        params![episode_id, local_path, updated_at],
      )
      .map_err(|error| format!("无法清理失效的播客下载状态：{error}"))?;
  }
  Ok(())
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
    first_seen_at: row.get(18)?,
    webpage_url: row.get(19)?,
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
    e.first_seen_at, e.webpage_url,
    e.expected_bytes, d.error_message, s.saved_at, q.position,
    f.feed_url, f.author, f.description, f.last_fetched_at, f.subscribed,
    f.subscribed_at, f.last_checked_at, f.last_refresh_error,
    (
      SELECT MAX(COALESCE(feed_episode.published_at, feed_episode.first_seen_at))
      FROM podcast_episodes feed_episode
      WHERE feed_episode.feed_id = f.id
    ),
    (
      SELECT COUNT(*)
      FROM podcast_episodes feed_episode
      LEFT JOIN podcast_progress feed_progress
        ON feed_progress.episode_id = feed_episode.id
      WHERE feed_episode.feed_id = f.id
        AND COALESCE(feed_progress.completed, 0) = 0
        AND COALESCE(feed_progress.position_seconds, 0) <= 0
    ),
    EXISTS(
      SELECT 1
      FROM podcast_episode_resources resource
      WHERE resource.episode_id = e.id
        AND resource.kind = 'chapters'
    ),
    (
      SELECT COUNT(*)
      FROM podcast_episode_resources resource
      WHERE resource.episode_id = e.id
        AND resource.kind = 'transcript'
    )
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
    .get::<_, Option<i64>>(20)?
    .and_then(|value| u64::try_from(value).ok());
  let queue_position = row
    .get::<_, Option<i64>>(23)?
    .and_then(|value| u32::try_from(value).ok());
  Ok(PodcastEpisodeDetail {
    saved: episode.saved,
    episode,
    feed: PodcastFeed {
      id: row.get(1)?,
      feed_url: row.get(24)?,
      title: row.get(15)?,
      author: row.get(25)?,
      description: row.get(26)?,
      artwork_url: row.get(16)?,
      last_fetched_at: row.get(27)?,
      subscribed: row.get::<_, i64>(28)? != 0,
      subscribed_at: row.get(29)?,
      last_checked_at: row.get(30)?,
      last_refresh_error: row.get(31)?,
      latest_episode_at: row.get(32)?,
      unplayed_count: row.get::<_, i64>(33)?.max(0) as u64,
    },
    expected_bytes,
    download_error: row.get(21)?,
    saved_at: row.get(22)?,
    queue_position,
    has_chapters: row.get::<_, i64>(34)? != 0,
    transcript_count: row
      .get::<_, i64>(35)?
      .max(0)
      .try_into()
      .unwrap_or(u32::MAX),
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

fn get_episode_details(
  db_path: &Path,
  downloads_dir: &Path,
  episode_ids: &[String],
) -> Result<Vec<PodcastEpisodeDetail>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(&format!("{PODCAST_EPISODE_DETAIL_SELECT} WHERE e.id = ?1"))
    .map_err(|error| format!("无法读取播客单集详情：{error}"))?;
  episode_ids
    .iter()
    .map(|episode_id| {
      statement
        .query_row([episode_id], |row| {
          podcast_episode_detail_from_row(row, downloads_dir)
        })
        .optional()
        .map_err(|error| format!("无法读取播客单集详情：{error}"))?
        .ok_or_else(|| "播客单集不存在".to_string())
    })
    .collect()
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
  set_episode_played_on_connection(&connection, episode_id, played)
}

fn set_episode_played_on_connection(
  connection: &Connection,
  episode_id: &str,
  played: bool,
) -> Result<(), String> {
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

fn validate_bulk_episode_identifiers(episode_ids: &[String]) -> Result<Vec<String>, String> {
  if episode_ids.is_empty() {
    return Err("请至少选择一集播客".to_string());
  }
  if episode_ids.len() > PODCAST_EPISODE_BATCH_LIMIT {
    return Err(format!(
      "一次最多可处理 {PODCAST_EPISODE_BATCH_LIMIT} 集播客"
    ));
  }
  for episode_id in episode_ids {
    validate_identifier(episode_id)?;
  }
  let mut unique = HashSet::with_capacity(episode_ids.len());
  Ok(
    episode_ids
      .iter()
      .filter(|episode_id| unique.insert(episode_id.as_str()))
      .cloned()
      .collect(),
  )
}

fn set_episodes_played(
  db_path: &Path,
  episode_ids: &[String],
  played: bool,
) -> Result<Vec<String>, String> {
  let episode_ids = validate_bulk_episode_identifiers(episode_ids)?;
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法批量更新播客播放状态：{error}"))?;
  for episode_id in &episode_ids {
    ensure_episode_exists(&transaction, episode_id)?;
  }
  for episode_id in &episode_ids {
    set_episode_played_on_connection(&transaction, episode_id, played)?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客播放状态：{error}"))?;
  Ok(episode_ids)
}

#[derive(Clone, Debug)]
struct QueueRecord {
  episode_id: String,
  added_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PodcastQueueAutofillMode {
  SameFeed,
  RandomUnplayed,
}

impl PodcastQueueAutofillMode {
  fn parse(value: &str) -> Result<Self, String> {
    match value {
      "same-feed" => Ok(Self::SameFeed),
      "random-unplayed" => Ok(Self::RandomUnplayed),
      _ => Err("播客智能续播模式无效".to_string()),
    }
  }
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

fn queue_remove_many(db_path: &Path, episode_ids: &[String]) -> Result<Vec<String>, String> {
  let episode_ids = validate_bulk_episode_identifiers(episode_ids)?;
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  let mut records = read_queue_records(&transaction)?;
  let queued_ids = records
    .iter()
    .map(|record| record.episode_id.as_str())
    .collect::<HashSet<_>>();
  if episode_ids
    .iter()
    .any(|episode_id| !queued_ids.contains(episode_id.as_str()))
  {
    return Err("播客待播列表已发生变化，请刷新后重试".to_string());
  }
  let removed_ids = episode_ids
    .iter()
    .map(String::as_str)
    .collect::<HashSet<_>>();
  records.retain(|record| !removed_ids.contains(record.episode_id.as_str()));
  rewrite_queue(&transaction, &records)?;
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客待播列表：{error}"))?;
  Ok(episode_ids)
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

fn queue_autofill(
  db_path: &Path,
  current_episode_id: &str,
  mode: PodcastQueueAutofillMode,
) -> Result<Option<String>, String> {
  validate_identifier(current_episode_id)?;
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  ensure_episode_exists(&transaction, current_episode_id)?;
  if !read_queue_records(&transaction)?.is_empty() {
    transaction
      .commit()
      .map_err(|error| format!("无法提交播客待播列表：{error}"))?;
    return Ok(None);
  }

  let candidate = match mode {
    PodcastQueueAutofillMode::SameFeed => transaction
      .query_row(
        "
        WITH current_episode AS (
          SELECT
            id AS episode_id,
            feed_id,
            COALESCE(published_at, first_seen_at) AS episode_time
          FROM podcast_episodes
          WHERE id = ?1
        )
        SELECT e.id
        FROM podcast_episodes e
        JOIN current_episode current ON current.feed_id = e.feed_id
        LEFT JOIN podcast_progress p ON p.episode_id = e.id
        WHERE e.id != ?1
          AND COALESCE(p.completed, 0) = 0
          AND TRIM(e.enclosure_url) != ''
          AND (
            COALESCE(e.published_at, e.first_seen_at) < current.episode_time
            OR (
              COALESCE(e.published_at, e.first_seen_at) = current.episode_time
              AND e.id > current.episode_id
            )
          )
        ORDER BY
          COALESCE(e.published_at, e.first_seen_at) DESC,
          e.id
        LIMIT 1
        ",
        [current_episode_id],
        |row| row.get::<_, String>(0),
      )
      .optional()
      .map_err(|error| format!("无法选择同节目续播单集：{error}"))?,
    PodcastQueueAutofillMode::RandomUnplayed => transaction
      .query_row(
        "
        SELECT e.id
        FROM podcast_episodes e
        JOIN podcast_feeds f ON f.id = e.feed_id
        LEFT JOIN podcast_progress p ON p.episode_id = e.id
        WHERE f.subscribed = 1
          AND e.id != ?1
          AND COALESCE(p.completed, 0) = 0
          AND COALESCE(p.position_seconds, 0) <= 0
          AND TRIM(e.enclosure_url) != ''
        ORDER BY RANDOM()
        LIMIT 1
        ",
        [current_episode_id],
        |row| row.get::<_, String>(0),
      )
      .optional()
      .map_err(|error| format!("无法选择随机未听单集：{error}"))?,
  };

  if let Some(episode_id) = candidate.as_deref() {
    transaction
      .execute(
        "
        INSERT INTO podcast_queue (episode_id, position, added_at)
        VALUES (?1, 0, ?2)
        ",
        params![episode_id, unix_time_millis()],
      )
      .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客待播列表：{error}"))?;
  Ok(candidate)
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
        COALESCE(d.downloaded_bytes, 0), COALESCE(d.total_bytes, e.expected_bytes),
        COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
        f.title, f.artwork_url,
        CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
        e.first_seen_at, e.webpage_url,
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
          .get::<_, i64>(20)
          .ok()
          .and_then(|value| u32::try_from(value).ok())
          .unwrap_or(0),
        added_at: row.get(21)?,
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

fn normalize_download_delete_ids(episode_ids: Vec<String>) -> Result<Vec<String>, String> {
  if episode_ids.len() > PODCAST_DOWNLOAD_DELETE_LIMIT {
    return Err(format!(
      "每次最多可清理 {PODCAST_DOWNLOAD_DELETE_LIMIT} 集播客"
    ));
  }
  validate_and_normalize_download_delete_ids(episode_ids)
}

fn validate_and_normalize_download_delete_ids(
  episode_ids: Vec<String>,
) -> Result<Vec<String>, String> {
  for episode_id in &episode_ids {
    validate_identifier(episode_id)?;
  }
  let mut normalized = episode_ids;
  normalized.sort_unstable();
  normalized.dedup();
  Ok(normalized)
}

fn list_completed_download_ids(db_path: &Path) -> Result<Vec<String>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT d.episode_id
      FROM podcast_downloads d
      JOIN podcast_progress p ON p.episode_id = d.episode_id
      WHERE d.state = 'downloaded' AND p.completed = 1
      ORDER BY p.updated_at, d.episode_id
      ",
    )
    .map_err(|error| format!("无法读取已听完的播客下载：{error}"))?;
  let rows = statement
    .query_map([], |row| row.get(0))
    .map_err(|error| format!("无法读取已听完的播客下载：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取已听完的播客下载：{error}"))
}

fn delete_episode_downloads_guarded(
  db_path: &Path,
  downloads_dir: &Path,
  active_downloads: &Arc<Mutex<HashSet<String>>>,
  episode_ids: Vec<String>,
  completed_only: bool,
) -> Result<PodcastDownloadDeleteResult, String> {
  let episode_ids = normalize_download_delete_ids(episode_ids)?;
  delete_normalized_episode_downloads_guarded(
    db_path,
    downloads_dir,
    active_downloads,
    episode_ids,
    completed_only,
  )
}

fn delete_normalized_episode_downloads_guarded(
  db_path: &Path,
  downloads_dir: &Path,
  active_downloads: &Arc<Mutex<HashSet<String>>>,
  episode_ids: Vec<String>,
  completed_only: bool,
) -> Result<PodcastDownloadDeleteResult, String> {
  let requested_count = episode_ids.len();
  let _file_guards = EpisodeFileGuard::acquire_many(active_downloads, &episode_ids)?;
  delete_episode_downloads(
    db_path,
    downloads_dir,
    &episode_ids,
    completed_only,
    requested_count,
  )
}

fn clear_completed_episode_downloads_guarded(
  db_path: &Path,
  downloads_dir: &Path,
  active_downloads: &Arc<Mutex<HashSet<String>>>,
) -> Result<PodcastDownloadDeleteResult, String> {
  let episode_ids = validate_and_normalize_download_delete_ids(
    list_completed_download_ids(db_path)?,
  )?;
  delete_normalized_episode_downloads_guarded(
    db_path,
    downloads_dir,
    active_downloads,
    episode_ids,
    true,
  )
}

#[derive(Debug)]
struct EpisodeDownloadDeleteTarget {
  episode_id: String,
  final_path: PathBuf,
  part_path: PathBuf,
}

#[derive(Debug)]
struct StagedDownloadFile {
  original_path: PathBuf,
  staged_path: PathBuf,
  bytes: u64,
}

fn load_episode_download_delete_targets(
  transaction: &Transaction<'_>,
  downloads_dir: &Path,
  episode_ids: &[String],
  completed_only: bool,
) -> Result<Vec<EpisodeDownloadDeleteTarget>, String> {
  let mut targets = Vec::new();
  for episode_id in episode_ids {
    let local_path = transaction
      .query_row(
        "
        SELECT d.local_path
        FROM podcast_downloads d
        WHERE d.episode_id = ?1
          AND d.state = 'downloaded'
          AND (
            ?2 = 0
            OR EXISTS (
              SELECT 1
              FROM podcast_progress p
              WHERE p.episode_id = d.episode_id AND p.completed = 1
            )
          )
        ",
        params![episode_id, i64::from(completed_only)],
        |row| row.get::<_, Option<String>>(0),
      )
      .optional()
      .map_err(|error| format!("无法读取播客下载信息：{error}"))?
      .flatten();
    let Some(local_path) = local_path else {
      continue;
    };
    let final_path = PathBuf::from(local_path);
    if !is_managed_download_path(downloads_dir, episode_id, &final_path) {
      continue;
    }
    targets.push(EpisodeDownloadDeleteTarget {
      episode_id: episode_id.clone(),
      final_path,
      part_path: downloads_dir.join(format!("{episode_id}.part")),
    });
  }
  Ok(targets)
}

fn create_download_delete_staging_dir(downloads_dir: &Path) -> Result<PathBuf, String> {
  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or(0);
  for attempt in 0..100u16 {
    let path = downloads_dir.join(format!(
      ".zone-delete-{}-{timestamp:x}-{attempt:x}",
      std::process::id(),
    ));
    match fs::create_dir(&path) {
      Ok(()) => return Ok(path),
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(error) => return Err(format!("无法创建播客下载暂存目录：{error}")),
    }
  }
  Err("无法创建唯一的播客下载暂存目录".to_string())
}

fn path_entry_exists(path: &Path) -> Result<bool, String> {
  match fs::symlink_metadata(path) {
    Ok(_) => Ok(true),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(error) => Err(format!("无法检查播客下载文件：{error}")),
  }
}

fn stage_download_file(
  original_path: &Path,
  staging_dir: &Path,
  rename_file: &mut dyn FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<Option<StagedDownloadFile>, String> {
  let metadata = match fs::symlink_metadata(original_path) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(format!("无法检查播客下载文件：{error}")),
  };
  if !metadata.file_type().is_file() {
    return Err("播客下载路径不是普通文件".to_string());
  }
  let file_name = original_path
    .file_name()
    .ok_or_else(|| "播客下载文件名无效".to_string())?;
  let staged_path = staging_dir.join(file_name);
  if path_entry_exists(&staged_path)? {
    return Err("播客下载暂存目标已存在".to_string());
  }
  rename_file(original_path, &staged_path)
    .map_err(|error| format!("无法暂存播客下载文件：{error}"))?;
  Ok(Some(StagedDownloadFile {
    original_path: original_path.to_path_buf(),
    staged_path,
    bytes: metadata.len(),
  }))
}

fn rollback_staged_download_files(
  staged_files: &[StagedDownloadFile],
  staging_dir: &Path,
) -> Result<(), String> {
  let mut failures = Vec::new();
  for staged in staged_files.iter().rev() {
    let staged_exists = match path_entry_exists(&staged.staged_path) {
      Ok(exists) => exists,
      Err(error) => {
        failures.push(error);
        continue;
      }
    };
    if !staged_exists {
      match path_entry_exists(&staged.original_path) {
        Ok(true) => {}
        Ok(false) => failures.push(format!(
          "暂存文件与原文件均不存在：{}",
          staged.original_path.display(),
        )),
        Err(error) => failures.push(error),
      }
      continue;
    }
    match path_entry_exists(&staged.original_path) {
      Ok(true) => {
        failures.push(format!(
          "原路径已存在，未覆盖：{}",
          staged.original_path.display(),
        ));
      }
      Ok(false) => {
        if let Err(error) = fs::rename(&staged.staged_path, &staged.original_path) {
          failures.push(format!(
            "无法恢复播客下载文件 {}：{error}",
            staged.original_path.display(),
          ));
        }
      }
      Err(error) => failures.push(error),
    }
  }
  if failures.is_empty() {
    match fs::remove_dir(staging_dir) {
      Ok(()) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => failures.push(format!("无法移除播客下载暂存目录：{error}")),
    }
  }
  if failures.is_empty() {
    Ok(())
  } else {
    Err(failures.join("；"))
  }
}

fn rollback_download_delete_error(
  error: String,
  staged_files: &[StagedDownloadFile],
  staging_dir: &Path,
) -> String {
  match rollback_staged_download_files(staged_files, staging_dir) {
    Ok(()) => error,
    Err(rollback_error) => format!("{error}；恢复暂存文件时发生错误：{rollback_error}"),
  }
}

fn rollback_download_delete_transaction(
  transaction: Transaction<'_>,
  error: String,
  staged_files: &[StagedDownloadFile],
  staging_dir: &Path,
) -> String {
  let error = match transaction.rollback() {
    Ok(()) => error,
    Err(rollback_error) => {
      format!("{error}；回滚播客下载数据库时发生错误：{rollback_error}")
    }
  };
  rollback_download_delete_error(error, staged_files, staging_dir)
}

fn cleanup_committed_staged_download_files(
  staged_files: &[StagedDownloadFile],
  staging_dir: &Path,
) {
  for staged in staged_files {
    if let Err(error) = remove_file_if_present(&staged.staged_path, "播客下载暂存文件") {
      eprintln!(
        "[podcast] 已清除下载记录，但暂存文件清理失败（{}）：{error}",
        staged.staged_path.display(),
      );
    }
  }
  if let Err(error) = fs::remove_dir(staging_dir) {
    if error.kind() != std::io::ErrorKind::NotFound {
      eprintln!(
        "[podcast] 已清除下载记录，但暂存目录清理失败（{}）：{error}",
        staging_dir.display(),
      );
    }
  }
}

fn delete_episode_downloads(
  db_path: &Path,
  downloads_dir: &Path,
  episode_ids: &[String],
  completed_only: bool,
  requested_count: usize,
) -> Result<PodcastDownloadDeleteResult, String> {
  let mut rename_file = |from: &Path, to: &Path| fs::rename(from, to);
  delete_episode_downloads_with_rename(
    db_path,
    downloads_dir,
    episode_ids,
    completed_only,
    requested_count,
    &mut rename_file,
  )
}

fn delete_episode_downloads_with_rename(
  db_path: &Path,
  downloads_dir: &Path,
  episode_ids: &[String],
  completed_only: bool,
  requested_count: usize,
  rename_file: &mut dyn FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<PodcastDownloadDeleteResult, String> {
  if episode_ids.is_empty() {
    return Ok(PodcastDownloadDeleteResult {
      requested_count,
      ..PodcastDownloadDeleteResult::default()
    });
  }

  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始清理播客下载：{error}"))?;
  let targets = load_episode_download_delete_targets(
    &transaction,
    downloads_dir,
    episode_ids,
    completed_only,
  )?;
  if targets.is_empty() {
    drop(transaction);
    return Ok(PodcastDownloadDeleteResult {
      requested_count,
      ..PodcastDownloadDeleteResult::default()
    });
  }

  let staging_dir = create_download_delete_staging_dir(downloads_dir)?;
  let mut staged_files = Vec::new();
  for target in &targets {
    for path in [&target.final_path, &target.part_path] {
      match stage_download_file(path, &staging_dir, rename_file) {
        Ok(Some(staged)) => staged_files.push(staged),
        Ok(None) => {}
        Err(error) => {
          return Err(rollback_download_delete_transaction(
            transaction,
            error,
            &staged_files,
            &staging_dir,
          ));
        }
      }
    }
  }

  let mut deleted_episode_ids = Vec::with_capacity(targets.len());
  for target in &targets {
    let deleted = match transaction
      .execute(
        "
        DELETE FROM podcast_downloads
        WHERE episode_id = ?1
          AND state = 'downloaded'
          AND (
            ?2 = 0
            OR EXISTS (
              SELECT 1
              FROM podcast_progress p
              WHERE p.episode_id = podcast_downloads.episode_id
                AND p.completed = 1
            )
          )
        ",
        params![target.episode_id, i64::from(completed_only)],
      )
    {
      Ok(deleted) => deleted,
      Err(error) => {
        return Err(rollback_download_delete_transaction(
          transaction,
          format!("无法清除播客下载记录：{error}"),
          &staged_files,
          &staging_dir,
        ));
      }
    };
    if deleted != 1 {
      return Err(rollback_download_delete_transaction(
        transaction,
        "播客下载状态已发生变化，请刷新后重试".to_string(),
        &staged_files,
        &staging_dir,
      ));
    }
    deleted_episode_ids.push(target.episode_id.clone());
  }

  if let Err(error) = transaction.commit() {
    return Err(rollback_download_delete_error(
      format!("无法提交播客下载清理：{error}"),
      &staged_files,
      &staging_dir,
    ));
  }
  let deleted_bytes = staged_files
    .iter()
    .fold(0u64, |total, staged| total.saturating_add(staged.bytes));
  cleanup_committed_staged_download_files(&staged_files, &staging_dir);
  Ok(PodcastDownloadDeleteResult {
    requested_count,
    deleted_count: deleted_episode_ids.len(),
    deleted_bytes,
    deleted_episode_ids,
  })
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
  url: Url,
  timeout: Duration,
  range: Option<&str>,
  allow_private_network: bool,
) -> Result<PublicResponse, String> {
  let request_headers = HeaderMap::new();
  send_public_get_with_headers(
    url,
    timeout,
    range,
    allow_private_network,
    &request_headers,
  )
  .await
}

async fn send_public_get_with_headers(
  mut url: Url,
  timeout: Duration,
  range: Option<&str>,
  allow_private_network: bool,
  request_headers: &HeaderMap,
) -> Result<PublicResponse, String> {
  let header_origin = url_origin(&url);
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
    if url_origin(&url) == header_origin {
      request = request.headers(request_headers.clone());
    }
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
    if response.status() == StatusCode::NOT_MODIFIED || !response.status().is_redirection() {
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

fn url_origin(url: &Url) -> (String, Option<String>, Option<u16>) {
  (
    url.scheme().to_ascii_lowercase(),
    url.host_str().map(str::to_ascii_lowercase),
    url.port_or_known_default(),
  )
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

fn normalize_url(value: &str, allow_private_network: bool) -> Result<String, String> {
  let mut url = validate_url_shape_with_policy(value, allow_private_network)?;
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
            <link>https://www.example.test/episodes/one</link>
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
    parsed_fixture_at(
      enclosure_url,
      "https://feeds.example.test/show.xml",
    )
  }

  fn parsed_fixture_at(enclosure_url: &str, feed_url: &str) -> ParsedPodcast {
    parse_feed_bytes(
      &rss_fixture(enclosure_url),
      feed_url,
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
  fn apple_search_maps_clean_decision_metadata() {
    let item = serde_json::from_str::<AppleSearchItem>(
      r#"{
        "collectionId": 111,
        "collectionName": "一档科技播客",
        "artistName": "Zone",
        "feedUrl": "https://feeds.example.test/technology.xml",
        "artworkUrl600": "https://img.example.test/technology.jpg",
        "trackCount": 42,
        "genres": [" 科技 ", "科技", "", "Society & Culture", "Podcasts"],
        "primaryGenreName": "科技",
        "releaseDate": "1970-01-02T01:30:00.125+01:30"
      }"#,
    )
    .expect("parse Apple search item");

    let result = apple_search_result_from_item(item).expect("map Apple search item");
    assert_eq!(result.genres, vec!["科技", "Society & Culture"]);
    assert_eq!(result.latest_release_at, Some(86_400_125));
  }

  #[test]
  fn apple_search_ignores_invalid_release_date() {
    let item = serde_json::from_str::<AppleSearchItem>(
      r#"{
        "collectionName": "无效日期",
        "feedUrl": "https://feeds.example.test/invalid-date.xml",
        "releaseDate": "2026-02-29T08:00:00Z"
      }"#,
    )
    .expect("parse Apple search item");

    let result = apple_search_result_from_item(item).expect("map Apple search item");
    assert_eq!(result.latest_release_at, None);
    assert!(result.genres.is_empty());
  }

  #[test]
  fn apple_search_uses_primary_genre_when_genres_are_missing() {
    let item = serde_json::from_str::<AppleSearchItem>(
      r#"{
        "collectionName": "分类回退",
        "feedUrl": "https://feeds.example.test/fallback-genre.xml",
        "primaryGenreName": " 人文 "
      }"#,
    )
    .expect("parse Apple search item");

    let result = apple_search_result_from_item(item).expect("map Apple search item");
    assert_eq!(result.genres, vec!["人文"]);
    assert_eq!(result.latest_release_at, None);
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
    assert_eq!(
      episode.webpage_url.as_deref(),
      Some("https://www.example.test/episodes/one")
    );
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
            <media:content url="https://img.example.test/cover.jpg" type="image/jpeg" />
            <media:content url="https://audio.example.test/fallback.m4a" type="audio/mp4" />
            <enclosure url="https://audio.example.test/preferred.mp3" length="100" type="audio/mpeg" />
          </item>
          <item>
            <guid>media-only</guid>
            <title>只有 Media RSS 音频</title>
            <media:content url="https://img.example.test/second-cover.jpg" type="image/jpeg" />
            <media:content url="https://audio.example.test/media-only.m4a" type="audio/mp4" fileSize="200" duration="61" />
          </item>
          <item xml:base="https://cdn.example.test/show/">
            <guid>xml-base</guid>
            <title>使用 XML 基准地址</title>
            <media:content url="https://audio.example.test/wrong-before-relative.m4a" type="audio/mp4" />
            <enclosure url="relative.mp3" type="audio/mpeg" />
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(xml, "mixed-enclosures");
    assert_eq!(parsed.episodes.len(), 3);
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://audio.example.test/preferred.mp3"
    );
    assert_eq!(parsed.episodes[0].enclosure_type.as_deref(), Some("audio/mpeg"));
    assert_eq!(parsed.episodes[0].expected_bytes, Some(100));
    assert_eq!(
      parsed.episodes[1].enclosure_url,
      "https://audio.example.test/media-only.m4a"
    );
    assert_eq!(parsed.episodes[1].expected_bytes, Some(200));
    assert_eq!(parsed.episodes[1].duration_seconds, Some(61.0));
    assert_eq!(
      parsed.episodes[2].enclosure_url,
      "https://cdn.example.test/show/relative.mp3"
    );
  }

  #[test]
  fn rss_one_rdf_enclosures_are_supported() {
    let rdf = r#"<?xml version="1.0" encoding="UTF-8"?>
      <rdf:RDF
        xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
        xmlns="http://purl.org/rss/1.0/"
        xmlns:enc="http://purl.oclc.org/net/rss_2.0/enc#">
        <channel rdf:about="https://feeds.example.test/rdf.xml">
          <title>RDF 节目</title>
          <link>https://shows.example.test/rdf</link>
          <description>RSS 1.0 测试</description>
          <items><rdf:Seq><rdf:li resource="https://shows.example.test/rdf/1" /></rdf:Seq></items>
        </channel>
        <item rdf:about="https://shows.example.test/rdf/1">
          <title>RDF 单集</title>
          <link>https://shows.example.test/rdf/1</link>
          <enc:enclosure
            rdf:resource="https://audio.example.test/rdf-1.mp3"
            enc:type="audio/mpeg"
            enc:length="300" />
        </item>
      </rdf:RDF>"#;
    let parsed = parse_test_feed(rdf, "rss-one");
    assert_eq!(parsed.feed.title, "RDF 节目");
    assert_eq!(parsed.episodes.len(), 1);
    assert_eq!(parsed.episodes[0].title, "RDF 单集");
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://audio.example.test/rdf-1.mp3"
    );
    assert_eq!(parsed.episodes[0].expected_bytes, Some(300));
  }

  #[test]
  fn dirty_feed_repair_preserves_cdata_and_visible_unknown_entities() {
    let dirty = r#"
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>研究&nbsp;电台</title>
          <description>脏 XML 恢复测试</description>
          <managingEditor>编辑部</managingEditor>
          <item>
            <title><![CDATA[AT&T 特别节目]]></title>
            <description>A &bogus123; B{control}</description>
            <enclosure
              url="https://audio.example.test/dirty.mp3?source=rss&episode=1"
              type="audio/mpeg" />
          </item>
        </channel>
      </rss>"#
      .replace("{control}", "\u{000b}");
    let mut bytes = vec![0xff, 0xfe];
    for unit in dirty.encode_utf16() {
      bytes.extend_from_slice(&unit.to_le_bytes());
    }
    assert!(feed_rs::parser::parse(bytes.as_slice()).is_err());
    let parsed = parse_feed_bytes(
      &bytes,
      "https://feeds.example.test/dirty.xml",
      None,
      None,
      None,
      None,
      None,
    )
    .expect("repair dirty fixture");
    assert_eq!(parsed.feed.title, "研究 电台");
    assert_eq!(parsed.feed.author.as_deref(), Some("编辑部"));
    assert_eq!(parsed.episodes[0].title, "AT&T 特别节目");
    assert_eq!(parsed.episodes[0].description.as_deref(), Some("A &bogus123; B"));
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://audio.example.test/dirty.mp3?source=rss&episode=1"
    );
    let hinted = parse_feed_bytes(
      &bytes,
      "https://feeds.example.test/dirty.xml",
      None,
      Some("目录中的节目作者"),
      None,
      None,
      None,
    )
    .expect("parse dirty fixture with author hint");
    assert_eq!(hinted.feed.author.as_deref(), Some("目录中的节目作者"));
  }

  #[test]
  fn utf16_feeds_and_relative_enclosures_have_stable_records() {
    let xml = r#"<?xml version="1.0" encoding="UTF-16"?>
      <rss version="2.0">
        <channel>
          <title>清晨电台</title>
          <description>编码兼容测试</description>
          <item>
            <title>第一期：你好</title>
            <enclosure url="../audio/utf16-one.mp3" type="audio/mpeg" />
          </item>
        </channel>
      </rss>"#;
    let mut little_endian = vec![0xff, 0xfe];
    let mut big_endian = Vec::new();
    for unit in xml.encode_utf16() {
      little_endian.extend_from_slice(&unit.to_le_bytes());
      big_endian.extend_from_slice(&unit.to_be_bytes());
    }

    let parse = |bytes: &[u8], name: &str| {
      parse_feed_bytes(
        bytes,
        "https://feeds.example.test/shows/feed.xml",
        None,
        None,
        None,
        None,
        None,
      )
      .unwrap_or_else(|error| panic!("parse {name} UTF-16 fixture: {error}"))
    };
    let little = parse(&little_endian, "little-endian");
    let big = parse(&big_endian, "big-endian");
    assert_eq!(little.feed.title, "清晨电台");
    assert_eq!(little.episodes[0].title, "第一期：你好");
    assert_eq!(
      little.episodes[0].enclosure_url,
      "https://feeds.example.test/audio/utf16-one.mp3"
    );
    assert!(little.episodes[0].guid.is_none());
    assert_eq!(little.episodes[0].id, big.episodes[0].id);
  }

  #[test]
  fn unrecoverable_feed_reports_the_original_parse_error() {
    let broken = br#"<?xml version="1.0"?><rss version="2.0"><channel><title>&bogus;</title>"#;
    let original = feed_rs::parser::Builder::new()
      .base_uri(Some("https://feeds.example.test/broken.xml"))
      .build()
      .parse(broken.as_slice())
      .expect_err("fixture should fail")
      .to_string();
    let error = parse_feed_bytes(
      broken,
      "https://feeds.example.test/broken.xml",
      None,
      None,
      None,
      None,
      None,
    )
    .expect_err("repair should still fail");
    assert!(error.contains(&original), "{error}");
  }

  #[test]
  fn feed_repair_keeps_input_and_output_within_the_response_limit() {
    let oversized = vec![b' '; PODCAST_FEED_RESPONSE_LIMIT + 1];
    let error = parse_feed_bytes(
      &oversized,
      "https://feeds.example.test/oversized.xml",
      None,
      None,
      None,
      None,
      None,
    )
    .expect_err("oversized feed should fail before parsing");
    assert_eq!(error, "播客订阅源超过大小限制");

    let expanding = "&".repeat(PODCAST_FEED_RESPONSE_LIMIT / b"&amp;".len() + 1);
    assert!(repair_feed_bytes(expanding.as_bytes()).is_none());
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
  fn podcast_resources_are_namespace_aware_and_align_with_audio_entries() {
    let rss = r#"<?xml version="1.0"?>
      <rss version="2.0"
        xmlns:p2="https://podcastindex.org/namespace/1.0"
        xmlns:psc="http://podlove.org/simple-chapters"
        xmlns:wrong="https://example.test/not-podcast">
        <channel>
          <title>章节节目</title>
          <description>chapter fixture</description>
          <link>https://example.test/show</link>
          <item>
            <guid>article-only</guid>
            <title>无音频文章</title>
            <wrong:chapters url="https://example.test/wrong.json"
              type="application/json+chapters" />
          </item>
          <item>
            <guid>chapter-episode</guid>
            <title>带章节单集</title>
            <enclosure url="https://media.example.test/chapter.mp3"
              type="audio/mpeg" length="128" />
            <p2:chapters url="https://cdn.example.test/chapters.json"
              type="application/json+chapters" />
            <p2:transcript url="https://cdn.example.test/transcript.vtt"
              type="text/vtt" language="zh-CN" rel="captions" />
            <psc:chapters version="1.1">
              <psc:chapter start="35:12.250" title="后半段" />
              <psc:chapter start="0" title="开场" />
              <psc:chapter start="7:48" title="主题"
                href="https://example.test/topic" />
            </psc:chapters>
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(rss, "chapter-resources");
    assert_eq!(parsed.episodes.len(), 1);
    let resources = parsed.episodes[0]
      .resources
      .as_ref()
      .expect("complete resource scan");
    assert_eq!(resources.len(), 3);
    let json = resources
      .iter()
      .find(|resource| resource.source_kind == "podcast-json")
      .expect("Podcasting 2.0 chapters");
    assert_eq!(
      json.url.as_deref(),
      Some("https://cdn.example.test/chapters.json")
    );
    let transcript = resources
      .iter()
      .find(|resource| resource.kind == "transcript")
      .expect("transcript resource");
    assert_eq!(transcript.language.as_deref(), Some("zh-CN"));
    assert_eq!(transcript.relation.as_deref(), Some("captions"));
    let psc = resources
      .iter()
      .find(|resource| resource.source_kind == "psc")
      .expect("PSC chapters");
    assert_eq!(
      psc
        .chapters
        .iter()
        .map(|chapter| chapter.start_ms)
        .collect::<Vec<_>>(),
      vec![0, 468_000, 2_112_250],
    );
    assert!(!resources.iter().any(|resource| {
      resource.url.as_deref() == Some("https://example.test/wrong.json")
    }));
  }

  #[test]
  fn podcast_namespace_compatibility_uri_and_psc_times_are_supported() {
    let rss = r#"<?xml version="1.0"?>
      <rss version="2.0"
        xmlns:any="https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md">
        <channel>
          <title>兼容命名空间</title>
          <description>compat fixture</description>
          <item>
            <guid>compat-episode</guid>
            <title>兼容单集</title>
            <enclosure url="https://media.example.test/compat.mp3" type="audio/mpeg" />
            <any:chapters url="https://cdn.example.test/compat.json"
              type="application/json" />
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(rss, "chapter-compat");
    assert!(parsed.episodes[0]
      .resources
      .as_ref()
      .is_some_and(|resources| {
        resources
          .iter()
          .any(|resource| resource.source_kind == "podcast-json")
      }));
    assert_eq!(parse_psc_time_ms("37"), Some(37_000));
    assert_eq!(parse_psc_time_ms("7:48"), Some(468_000));
    assert_eq!(parse_psc_time_ms("35:12.250"), Some(2_112_250));
    assert_eq!(parse_psc_time_ms("05:12:03.5"), Some(18_723_500));
    for invalid in ["", "-1", "1:60", "1:60:00", "1:2:3:4", "NaN"] {
      assert_eq!(parse_psc_time_ms(invalid), None, "{invalid}");
    }
  }

  #[test]
  fn episode_resources_migrate_reconcile_and_preserve_cached_metadata() {
    let directory = test_directory("episode-resources");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let rss = r#"<?xml version="1.0"?>
      <rss version="2.0"
        xmlns:podcast="https://podcastindex.org/namespace/1.0"
        xmlns:psc="http://podlove.org/simple-chapters">
        <channel>
          <title>资源持久化</title>
          <description>resource persistence</description>
          <item>
            <guid>resource-episode</guid>
            <title>资源单集</title>
            <enclosure url="https://media.example.test/resource.mp3" type="audio/mpeg" />
            <podcast:chapters url="https://cdn.example.test/resource.json"
              type="application/json+chapters" />
            <podcast:transcript url="https://cdn.example.test/resource.vtt"
              type="text/vtt" language="zh" />
            <psc:chapters>
              <psc:chapter start="30" title="第二章" />
              <psc:chapter start="0" title="第一章" />
            </psc:chapters>
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(rss, "resource-persistence");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed.clone()).expect("store resource feed");
    let detail = get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("resource detail");
    assert!(detail.has_chapters);
    assert_eq!(detail.transcript_count, 1);
    let connection = open_database(&state.db_path).expect("open resource database");
    assert_eq!(
      connection
        .query_row(
          "SELECT COUNT(*) FROM podcast_episode_resources WHERE episode_id = ?1",
          [&episode_id],
          |row| row.get::<_, i64>(0),
        )
        .expect("resource count"),
      3,
    );
    assert_eq!(
      connection
        .query_row(
          "SELECT COUNT(*) FROM podcast_chapters",
          [],
          |row| row.get::<_, i64>(0),
        )
        .expect("chapter count"),
      2,
    );
    connection
      .execute(
        "
        UPDATE podcast_episode_resources
        SET etag = 'cached', fetched_at = 42
        WHERE episode_id = ?1 AND source_kind = 'podcast-json'
        ",
        [&episode_id],
      )
      .expect("seed resource cache");
    drop(connection);

    let mut incomplete = parsed.clone();
    incomplete.episodes[0].resources = None;
    store_subscription(&state.db_path, incomplete).expect("store incomplete resource scan");
    let connection = open_database(&state.db_path).expect("reopen resource database");
    assert_eq!(
      connection
        .query_row(
          "
          SELECT etag, fetched_at
          FROM podcast_episode_resources
          WHERE episode_id = ?1 AND source_kind = 'podcast-json'
          ",
          [&episode_id],
          |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .expect("preserved cache"),
      (Some("cached".to_string()), Some(42)),
    );
    drop(connection);

    let mut without_resources = parsed;
    without_resources.episodes[0].resources = Some(Vec::new());
    store_subscription(&state.db_path, without_resources).expect("remove feed resources");
    let detail = get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("detail without resources");
    assert!(!detail.has_chapters);
    assert_eq!(detail.transcript_count, 0);

    fs::remove_dir_all(directory).expect("cleanup test directory");
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
          CREATE TABLE podcast_episodes (
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
          INSERT INTO podcast_episodes (
            id, feed_id, identity_key, guid, title, description, published_at,
            duration_seconds, enclosure_url, enclosure_type, artwork_url, expected_bytes
          ) VALUES (
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'guid:legacy-episode',
            'legacy-episode',
            '旧版单集',
            NULL,
            0,
            60,
            'https://media.example.test/legacy.mp3',
            'audio/mpeg',
            NULL,
            100
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
      let (subscribed_at, last_checked_at, last_refresh_error) = connection
        .query_row(
          "
          SELECT subscribed_at, last_checked_at, last_refresh_error
          FROM podcast_feeds
          WHERE title = '旧版节目'
          ",
          [],
          |row| {
            Ok((
              row.get::<_, Option<i64>>(0)?,
              row.get::<_, Option<i64>>(1)?,
              row.get::<_, Option<String>>(2)?,
            ))
          },
        )
        .expect("read migrated refresh state");
      assert_eq!(subscribed_at, Some(1));
      assert_eq!(last_checked_at, Some(1));
      assert!(last_refresh_error.is_none());
      let (first_seen_at, webpage_url) = connection
        .query_row(
          "
          SELECT first_seen_at, webpage_url
          FROM podcast_episodes
          WHERE title = '旧版单集'
          ",
          [],
          |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .expect("read migrated episode discovery state");
      assert_eq!(first_seen_at, 1);
      assert!(webpage_url.is_none());
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
    assert_eq!(feeds[0].subscribed_at, Some(1));
    assert_eq!(feeds[0].last_checked_at, Some(1));

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
    assert!(preview.feed.subscribed_at.is_none());
    assert_eq!(preview.inserted_count, 1);
    assert_eq!(preview.updated_count, 0);
    assert!(preview.feed.latest_episode_at.is_some());
    assert_eq!(preview.feed.unplayed_count, 1);
    let preview_first_seen = get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("preview episode")
      .episode
      .first_seen_at;
    assert!(list_feeds(&state.db_path).expect("list preview feeds").is_empty());
    let preview_home = list_home(&state.db_path, &state.downloads_dir).expect("preview home");
    assert!(preview_home.continue_listening.is_empty());
    assert!(preview_home.latest_episodes.is_empty());
    assert!(preview_home.downloaded_episodes.is_empty());
    assert!(preview_home.saved_episodes.is_empty());

    let followed = store_subscription(&state.db_path, parsed.clone()).expect("follow preview");
    assert!(followed.feed.subscribed);
    assert!(followed.feed.subscribed_at.is_some());
    assert_eq!(followed.feed.unplayed_count, 1);
    assert!(preview_first_seen <= followed.feed.subscribed_at.expect("subscription time"));
    assert_eq!(followed.inserted_count, 0);
    assert_eq!(followed.updated_count, 0);
    let refreshed = store_preview(&state.db_path, parsed).expect("refresh followed preview");
    assert!(refreshed.feed.subscribed);
    assert_eq!(refreshed.updated_count, 0);
    assert_eq!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
        .expect("refreshed episode")
        .episode
        .first_seen_at,
      preview_first_seen,
    );
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
    let subscribed_at = open_database(&state.db_path)
      .expect("open unfollowed feed")
      .query_row(
        "SELECT subscribed_at FROM podcast_feeds WHERE id = ?1",
        [&feed_id],
        |row| row.get::<_, Option<i64>>(0),
      )
      .expect("read unfollow timestamp");
    assert!(subscribed_at.is_none());

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
  fn home_filters_unplayed_and_download_priority_across_the_full_database() {
    let directory = test_directory("home-database-filters");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(45);
    let feed_id = parsed.feed.id.clone();
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store large subscription");

    {
      let mut connection = open_database(&state.db_path).expect("open progress database");
      let transaction = connection.transaction().expect("begin progress transaction");
      for episode_id in &episode_ids[..40] {
        transaction
          .execute(
            "
            INSERT INTO podcast_progress (
              episode_id, position_seconds, duration_seconds, completed, updated_at
            ) VALUES (?1, 3723, 3723, 1, 1)
            ",
            [episode_id],
          )
          .expect("mark recent episode completed");
      }
      transaction.commit().expect("commit completed episodes");
    }

    for episode_id in &episode_ids[..40] {
      let stale_path = state
        .downloads_dir
        .join(format!("{episode_id}.mp3"));
      mark_download_complete(
        &state.db_path,
        episode_id,
        &stale_path.to_string_lossy(),
        1024,
        Some(1024),
      )
      .expect("mark stale download");
    }

    let priority_episode_id = &episode_ids[44];
    let local_path = state
      .downloads_dir
      .join(format!("{priority_episode_id}.mp3"));
    let audio = b"ID3-priority";
    fs::write(&local_path, audio).expect("write priority download");
    mark_download_complete(
      &state.db_path,
      priority_episode_id,
      &local_path.to_string_lossy(),
      audio.len() as u64,
      Some(audio.len() as u64),
    )
    .expect("mark priority download");

    let preview = parsed_fixture_at(
      "https://media.example.test/preview-episode.mp3",
      "https://feeds.example.test/unfollowed.xml",
    );
    let preview_feed_id = preview.feed.id.clone();
    store_preview(&state.db_path, preview).expect("store unfollowed preview");

    let home = list_home(&state.db_path, &state.downloads_dir).expect("load filtered home");
    assert_eq!(home.latest_episodes.len(), PODCAST_HOME_LATEST_LIMIT);
    assert_eq!(home.latest_episodes[0].id, episode_ids[0]);
    assert_eq!(home.latest_episodes[39].id, episode_ids[39]);
    assert!(
      !home
        .latest_episodes
        .iter()
        .any(|episode| episode.id == priority_episode_id.as_str())
    );
    assert_eq!(
      home
        .unplayed_episodes
        .iter()
        .map(|episode| episode.id.as_str())
        .collect::<Vec<_>>(),
      episode_ids[40..]
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>(),
    );
    assert_eq!(
      home.download_priority_episodes.len(),
      PODCAST_HOME_DOWNLOAD_PRIORITY_LIMIT,
    );
    assert_eq!(
      home.download_priority_episodes[0].id.as_str(),
      priority_episode_id,
    );
    assert_eq!(home.download_priority_episodes[0].download_state, "downloaded");
    assert_eq!(
      home.download_priority_episodes[0].local_path.as_deref(),
      Some(local_path.to_string_lossy().as_ref())
    );
    let connection = open_database(&state.db_path).expect("open cleaned download database");
    let download_count = connection
      .query_row(
        "SELECT COUNT(*) FROM podcast_downloads WHERE state = 'downloaded'",
        [],
        |row| row.get::<_, i64>(0),
      )
      .expect("count valid downloads");
    assert_eq!(download_count, 1);
    drop(connection);
    assert_eq!(home.download_priority_episodes[1].id, episode_ids[0]);
    for episode in home
      .unplayed_episodes
      .iter()
      .chain(home.download_priority_episodes.iter())
    {
      assert_eq!(episode.feed_id, feed_id);
      assert_ne!(episode.feed_id, preview_feed_id);
    }

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn home_recent_lists_fall_back_to_first_seen_when_publish_time_is_missing() {
    let directory = test_directory("home-recent-fallback");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    let connection = open_database(&state.db_path).expect("open ordering database");
    connection
      .execute(
        "
        UPDATE podcast_episodes SET
          published_at = CASE id
            WHEN ?1 THEN 100
            WHEN ?2 THEN NULL
            WHEN ?3 THEN 200
          END,
          first_seen_at = CASE id
            WHEN ?1 THEN 1000
            WHEN ?2 THEN 3000
            WHEN ?3 THEN 2000
          END
        WHERE id IN (?1, ?2, ?3)
        ",
        params![episode_ids[0], episode_ids[1], episode_ids[2]],
      )
      .expect("set deterministic recent timestamps");
    drop(connection);

    let expected = [
      episode_ids[1].as_str(),
      episode_ids[2].as_str(),
      episode_ids[0].as_str(),
    ];
    let home = list_home(&state.db_path, &state.downloads_dir).expect("load ordered home");
    for episodes in [
      &home.latest_episodes,
      &home.unplayed_episodes,
      &home.download_priority_episodes,
    ] {
      assert_eq!(
        episodes
          .iter()
          .map(|episode| episode.id.as_str())
          .collect::<Vec<_>>(),
        expected,
      );
    }

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn library_feed_stats_and_recent_playback_reflect_progress_history() {
    let directory = test_directory("library-feed-stats");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let feed_id = parsed.feed.id.clone();
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let preview = parsed_fixture_at(
      "https://media.example.test/history-episode.mp3",
      "https://feeds.example.test/history.xml",
    );
    let preview_episode_id = preview.episodes[0].id.clone();
    store_preview(&state.db_path, preview).expect("store unfollowed history");

    let mut connection = open_database(&state.db_path).expect("open library database");
    let transaction = connection.transaction().expect("begin library transaction");
    transaction
      .execute(
        "
        UPDATE podcast_episodes SET
          published_at = CASE id
            WHEN ?1 THEN 100
            WHEN ?2 THEN NULL
            WHEN ?3 THEN 200
          END,
          first_seen_at = CASE id
            WHEN ?1 THEN 1000
            WHEN ?2 THEN 3000
            WHEN ?3 THEN 2000
          END
        WHERE id IN (?1, ?2, ?3)
        ",
        params![episode_ids[0], episode_ids[1], episode_ids[2]],
      )
      .expect("set deterministic feed recency");
    for (episode_id, position, completed, updated_at) in [
      (episode_ids[0].as_str(), 120.0, 0, 100),
      (episode_ids[1].as_str(), 3723.0, 1, 200),
      (preview_episode_id.as_str(), 60.0, 0, 300),
    ] {
      transaction
        .execute(
          "
          INSERT INTO podcast_progress (
            episode_id, position_seconds, duration_seconds, completed, updated_at
          ) VALUES (?1, ?2, 3723, ?3, ?4)
          ",
          params![episode_id, position, completed, updated_at],
        )
        .expect("store deterministic playback history");
    }
    transaction.commit().expect("commit library state");
    drop(connection);

    let feeds = list_feeds(&state.db_path).expect("list feed stats");
    assert_eq!(feeds.len(), 1);
    assert_eq!(feeds[0].id, feed_id);
    assert_eq!(feeds[0].latest_episode_at, Some(3000));
    assert_eq!(feeds[0].unplayed_count, 1);

    let home = list_home(&state.db_path, &state.downloads_dir).expect("list playback history");
    assert_eq!(
      home
        .recently_played_episodes
        .iter()
        .map(|episode| episode.id.as_str())
        .collect::<Vec<_>>(),
      vec![
        preview_episode_id.as_str(),
        episode_ids[1].as_str(),
        episode_ids[0].as_str(),
      ],
    );
    assert!(
      !home
        .recently_played_episodes
        .iter()
        .any(|episode| episode.id == episode_ids[2])
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn downloaded_library_is_paginated_beyond_the_bounded_home_summary() {
    let directory = test_directory("downloaded-library-size");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(45);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store large subscription");

    for (index, episode_id) in episode_ids.iter().enumerate() {
      let local_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
      fs::write(&local_path, b"ID3-library").expect("write managed download");
      let downloaded_bytes = u64::try_from(index + 1).expect("download size");
      mark_download_complete(
        &state.db_path,
        episode_id,
        &local_path.to_string_lossy(),
        downloaded_bytes,
        Some(downloaded_bytes),
      )
      .expect("store managed download");
    }

    let first = list_downloads(&state.db_path, &state.downloads_dir, 0, 20)
      .expect("list first download page");
    let second = list_downloads(&state.db_path, &state.downloads_dir, 20, 20)
      .expect("list second download page");
    let third = list_downloads(&state.db_path, &state.downloads_dir, 40, 20)
      .expect("list final download page");
    assert_eq!(first.episodes.len(), 20);
    assert_eq!(second.episodes.len(), 20);
    assert_eq!(third.episodes.len(), 5);
    assert!(first.has_more);
    assert!(second.has_more);
    assert!(!third.has_more);
    for page in [&first, &second, &third] {
      assert_eq!(page.total_count, 45);
      assert_eq!(page.total_bytes, (1_u64..=45).sum::<u64>());
      assert_eq!(page.feed_count, 1);
    }
    let paged_ids = first
      .episodes
      .iter()
      .chain(second.episodes.iter())
      .chain(third.episodes.iter())
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    assert_eq!(paged_ids.len(), 45);
    assert_eq!(
      paged_ids.iter().cloned().collect::<HashSet<_>>(),
      episode_ids.iter().cloned().collect::<HashSet<_>>(),
    );

    let home = list_home(&state.db_path, &state.downloads_dir).expect("list downloaded library");
    assert_eq!(home.downloaded_episodes.len(), PODCAST_HOME_DOWNLOADED_LIMIT);
    assert_eq!(
      home
        .downloaded_episodes
        .iter()
        .map(|episode| episode.id.as_str())
        .collect::<Vec<_>>(),
      paged_ids[..PODCAST_HOME_DOWNLOADED_LIMIT]
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>(),
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn related_episode_list_is_bounded_ordered_and_keeps_episode_state() {
    let directory = test_directory("related-episodes");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(6);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store related episodes");
    save_progress(&state.db_path, &episode_ids[2], 30.0, 100.0)
      .expect("save related progress");
    open_database(&state.db_path)
      .expect("open podcast database")
      .execute(
        "UPDATE podcast_episodes SET enclosure_url = '' WHERE id = ?1",
        [&episode_ids[1]],
      )
      .expect("remove related enclosure");

    let related = list_related_episodes(
      &state.db_path,
      &state.downloads_dir,
      &episode_ids[0],
      3,
    )
    .expect("list related episodes");
    assert_eq!(
      related
        .iter()
        .map(|episode| episode.id.as_str())
        .collect::<Vec<_>>(),
      vec![
        episode_ids[2].as_str(),
        episode_ids[3].as_str(),
        episode_ids[4].as_str(),
      ]
    );
    assert_eq!(related[0].progress_seconds, 30.0);
    assert!(!related.iter().any(|episode| episode.id == episode_ids[0]));
    assert!(!related.iter().any(|episode| episode.id == episode_ids[1]));
    assert!(
      list_related_episodes(
        &state.db_path,
        &state.downloads_dir,
        "missing",
        PODCAST_RELATED_EPISODE_MAX_LIMIT + 1,
      )
      .is_err()
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
  fn refresh_selection_throttles_recent_checks_and_rejects_unknown_ids() {
    let directory = test_directory("refresh-selection");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let checked_at = parsed.feed.last_checked_at.expect("initial checked timestamp");
    store_subscription(&state.db_path, parsed).expect("store subscription");

    assert!(
      list_refresh_targets(&state.db_path, None, false, checked_at)
        .expect("throttled global refresh")
        .is_empty()
    );
    assert_eq!(
      list_refresh_targets(&state.db_path, Some(&feed_id), true, checked_at)
        .expect("forced selected refresh")
        .len(),
      1,
    );
    open_database(&state.db_path)
      .expect("open refresh database")
      .execute(
        "UPDATE podcast_feeds SET last_checked_at = ?2 WHERE id = ?1",
        params![feed_id, checked_at.saturating_sub(PODCAST_REFRESH_INTERVAL + 1)],
      )
      .expect("age refresh timestamp");
    assert_eq!(
      list_refresh_targets(&state.db_path, None, false, checked_at)
        .expect("eligible global refresh")
        .len(),
      1,
    );
    assert!(
      list_refresh_targets(&state.db_path, Some(&"f".repeat(64)), true, checked_at)
        .expect_err("unknown selected feed")
        .contains("不存在")
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn successful_feed_store_clears_missing_validators_and_counts_only_changes() {
    let directory = test_directory("refresh-store-outcome");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed.clone()).expect("store initial subscription");

    let mut changed = parsed;
    changed.etag = None;
    changed.last_modified = None;
    changed.feed.last_fetched_at = changed.feed.last_fetched_at.saturating_add(1);
    changed.feed.last_checked_at = Some(changed.feed.last_fetched_at);
    changed.episodes[0].title = "第一集（修订）".to_string();
    let result = store_preview(&state.db_path, changed.clone()).expect("store changed refresh");
    assert_eq!(result.inserted_count, 0);
    assert_eq!(result.updated_count, 1);
    let (etag, last_modified) = open_database(&state.db_path)
      .expect("open refreshed database")
      .query_row(
        "SELECT etag, last_modified FROM podcast_feeds WHERE id = ?1",
        [&feed_id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
      )
      .expect("read cleared validators");
    assert!(etag.is_none());
    assert!(last_modified.is_none());
    let episode =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("updated episode");
    assert_eq!(episode.episode.title, "第一集（修订）");

    let unchanged = store_preview(&state.db_path, changed).expect("store unchanged refresh");
    assert_eq!(unchanged.inserted_count, 0);
    assert_eq!(unchanged.updated_count, 0);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn refresh_keeps_its_existing_url_when_the_canonical_url_has_another_owner() {
    let directory = test_directory("refresh-url-owner-conflict");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let source_url = "https://feeds.example.test/source.xml";
    let canonical_url = "https://feeds.example.test/canonical.xml";
    let source = parsed_fixture_at(
      "https://media.example.test/episode-1.mp3",
      source_url,
    );
    let canonical = parsed_fixture_at(
      "https://media.example.test/episode-1.mp3",
      canonical_url,
    );
    let source_id = source.feed.id.clone();
    let canonical_id = canonical.feed.id.clone();
    assert_ne!(source_id, canonical_id);
    store_subscription(&state.db_path, source).expect("store source subscription");
    store_preview(&state.db_path, canonical.clone()).expect("store canonical preview");

    let mut redirected_refresh = canonical;
    retain_refresh_identifiers(&mut redirected_refresh, &source_id);
    let refreshed =
      store_preview(&state.db_path, redirected_refresh).expect("store conflicting redirect refresh");
    assert_eq!(refreshed.feed.id, source_id);
    assert_eq!(refreshed.feed.feed_url, source_url);
    assert!(refreshed.feed.subscribed);

    let connection = open_database(&state.db_path).expect("open conflicted database");
    let mut statement = connection
      .prepare("SELECT id, feed_url, subscribed FROM podcast_feeds ORDER BY id")
      .expect("prepare feed identities");
    let rows = statement
      .query_map([], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, i64>(2)? != 0,
        ))
      })
      .expect("read feed identities")
      .collect::<Result<Vec<_>, _>>()
      .expect("collect feed identities");
    assert_eq!(rows.len(), 2);
    assert!(
      rows
        .iter()
        .any(|row| row.0 == source_id && row.1 == source_url && row.2)
    );
    assert!(
      rows
        .iter()
        .any(|row| row.0 == canonical_id && row.1 == canonical_url && !row.2)
    );
    drop(statement);
    drop(connection);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn preview_reuses_the_url_owner_and_preserves_all_episode_state() {
    let directory = test_directory("preview-url-owner-reuse");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let source_url = "https://feeds.example.test/source.xml";
    let canonical_url = "https://feeds.example.test/canonical.xml";
    let source = parsed_fixture_at(
      "https://media.example.test/episode-1.mp3",
      source_url,
    );
    let owner_feed_id = source.feed.id.clone();
    let owner_episode_id = source.episodes[0].id.clone();
    store_subscription(&state.db_path, source).expect("store source subscription");

    let mut canonical_refresh = parsed_fixture_at(
      "https://media.example.test/episode-1.mp3",
      canonical_url,
    );
    retain_refresh_identifiers(&mut canonical_refresh, &owner_feed_id);
    let canonical_owner =
      store_preview(&state.db_path, canonical_refresh).expect("store canonical redirect");
    assert_eq!(canonical_owner.feed.id, owner_feed_id);
    assert_eq!(canonical_owner.feed.feed_url, canonical_url);

    save_progress(&state.db_path, &owner_episode_id, 30.0, 100.0).expect("save episode progress");
    set_episode_saved(&state.db_path, &owner_episode_id, true).expect("save episode");
    queue_add(&state.db_path, &owner_episode_id, false).expect("queue episode");
    let local_path = state.downloads_dir.join(format!("{owner_episode_id}.mp3"));
    fs::write(&local_path, b"ID3-url-owner").expect("write managed download");
    mark_download_complete(
      &state.db_path,
      &owner_episode_id,
      &local_path.to_string_lossy(),
      13,
      Some(13),
    )
    .expect("save managed download");

    let mut incoming = parsed_fixture_at(
      "https://media.example.test/episode-1.mp3",
      canonical_url,
    );
    let discarded_feed_id = incoming.feed.id.clone();
    let discarded_episode_id = incoming.episodes[0].id.clone();
    assert_ne!(discarded_feed_id, owner_feed_id);
    assert_ne!(discarded_episode_id, owner_episode_id);
    incoming.episodes[0].title = "第一集（目录更新）".to_string();
    let reused = store_preview(&state.db_path, incoming).expect("reuse canonical URL owner");
    assert_eq!(reused.feed.id, owner_feed_id);
    assert_eq!(reused.feed.feed_url, canonical_url);
    assert!(reused.feed.subscribed);
    assert_eq!(reused.inserted_count, 0);
    assert_eq!(reused.updated_count, 1);

    let connection = open_database(&state.db_path).expect("open reused database");
    let feed_count = connection
      .query_row("SELECT COUNT(*) FROM podcast_feeds", [], |row| row.get::<_, i64>(0))
      .expect("count feeds");
    assert_eq!(feed_count, 1);
    assert!(
      connection
        .query_row(
          "SELECT 1 FROM podcast_feeds WHERE id = ?1",
          [&discarded_feed_id],
          |_| Ok(()),
        )
        .optional()
        .expect("inspect discarded feed identity")
        .is_none()
    );
    assert!(
      connection
        .query_row(
          "SELECT 1 FROM podcast_episodes WHERE id = ?1",
          [&discarded_episode_id],
          |_| Ok(()),
        )
        .optional()
        .expect("inspect discarded episode identity")
        .is_none()
    );
    drop(connection);

    let detail = get_episode_detail(
      &state.db_path,
      &state.downloads_dir,
      &owner_episode_id,
    )
    .expect("read preserved episode state");
    assert_eq!(detail.episode.title, "第一集（目录更新）");
    assert_eq!(detail.episode.progress_seconds, 30.0);
    assert_eq!(detail.episode.download_state, "downloaded");
    assert_eq!(
      detail.episode.local_path.as_deref(),
      Some(local_path.to_string_lossy().as_ref())
    );
    assert!(detail.saved);
    assert_eq!(detail.queue_position, Some(0));

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
  fn bulk_played_markers_preflight_all_episodes_and_update_atomically() {
    let directory = test_directory("bulk-played-state");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    save_progress(&state.db_path, &episode_ids[0], 30.0, 100.0).expect("save first progress");
    save_progress(&state.db_path, &episode_ids[2], 20.0, 100.0).expect("save untouched progress");

    let marked_ids = set_episodes_played(
      &state.db_path,
      &[
        episode_ids[0].clone(),
        episode_ids[0].clone(),
        episode_ids[1].clone(),
      ],
      true,
    )
    .expect("mark selected episodes played");
    assert_eq!(marked_ids, episode_ids[..2]);
    let marked = get_episode_details(
      &state.db_path,
      &state.downloads_dir,
      &marked_ids,
    )
    .expect("read marked episodes");
    assert!(marked.iter().all(|detail| detail.episode.completed));
    assert_eq!(marked[0].episode.progress_seconds, 100.0);
    assert_eq!(marked[1].episode.progress_seconds, 3_723.0);
    let untouched =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_ids[2])
        .expect("read untouched episode");
    assert!(!untouched.episode.completed);
    assert_eq!(untouched.episode.progress_seconds, 20.0);

    let missing_episode_id = "f".repeat(64);
    assert!(
      set_episodes_played(
        &state.db_path,
        &[episode_ids[0].clone(), missing_episode_id],
        false,
      )
      .is_err()
    );
    assert!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_ids[0])
        .expect("read episode after rejected update")
        .episode
        .completed
    );

    set_episodes_played(
      &state.db_path,
      &[episode_ids[0].clone(), episode_ids[1].clone()],
      false,
    )
    .expect("mark selected episodes unplayed");
    let unplayed = get_episode_details(
      &state.db_path,
      &state.downloads_dir,
      &episode_ids[..2],
    )
    .expect("read unplayed episodes");
    assert!(unplayed.iter().all(|detail| {
      !detail.episode.completed && detail.episode.progress_seconds == 0.0
    }));
    let connection = open_database(&state.db_path).expect("open database");
    for episode_id in &episode_ids[..2] {
      let progress_exists = connection
        .query_row(
          "SELECT 1 FROM podcast_progress WHERE episode_id = ?1",
          [episode_id],
          |_| Ok(()),
        )
        .optional()
        .expect("inspect cleared progress")
        .is_some();
      assert!(!progress_exists);
    }
    assert!(set_episodes_played(&state.db_path, &[], true).is_err());
    assert!(
      set_episodes_played(
        &state.db_path,
        &vec![episode_ids[0].clone(); PODCAST_EPISODE_BATCH_LIMIT + 1],
        true,
      )
      .is_err()
    );

    drop(connection);
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
  fn queue_autofill_preserves_manual_queue_and_selects_nearest_older_unfinished_episode() {
    let directory = test_directory("queue-autofill-same-feed");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(4);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    set_episode_played(&state.db_path, &episode_ids[1], true).expect("complete nearest older episode");
    save_progress(&state.db_path, &episode_ids[2], 30.0, 100.0).expect("partially play next older episode");

    queue_add(&state.db_path, &episode_ids[3], false).expect("add manual queue item");
    let skipped = queue_autofill(
      &state.db_path,
      &episode_ids[0],
      PodcastQueueAutofillMode::SameFeed,
    )
    .expect("keep manual queue");
    assert!(skipped.is_none());
    let manual_queue = list_queue(&state.db_path, &state.downloads_dir).expect("list manual queue");
    assert_eq!(manual_queue.len(), 1);
    assert_eq!(manual_queue[0].episode.id, episode_ids[3]);

    queue_clear(&state.db_path).expect("clear manual queue");
    let selected = queue_autofill(
      &state.db_path,
      &episode_ids[0],
      PodcastQueueAutofillMode::SameFeed,
    )
    .expect("autofill same feed");
    assert_eq!(selected.as_deref(), Some(episode_ids[2].as_str()));
    let automatic_queue = list_queue(&state.db_path, &state.downloads_dir).expect("list automatic queue");
    assert_eq!(automatic_queue.len(), 1);
    assert_eq!(automatic_queue[0].episode.id, episode_ids[2]);
    assert_eq!(automatic_queue[0].position, 0);

    queue_clear(&state.db_path).expect("clear automatic queue");
    let no_older_episode = queue_autofill(
      &state.db_path,
      &episode_ids[3],
      PodcastQueueAutofillMode::SameFeed,
    )
    .expect("find no older episode");
    assert!(no_older_episode.is_none());
    assert!(list_queue(&state.db_path, &state.downloads_dir)
      .expect("list empty queue")
      .is_empty());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn same_feed_queue_autofill_uses_stable_id_order_for_equal_first_seen_times() {
    let directory = test_directory("queue-autofill-same-time");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let mut parsed = parsed_fixture_with_episode_count(3);
    for episode in &mut parsed.episodes {
      episode.published_at = None;
    }
    let mut episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    episode_ids.sort();
    store_subscription(&state.db_path, parsed).expect("store episodes without publish times");

    let selected = queue_autofill(
      &state.db_path,
      &episode_ids[0],
      PodcastQueueAutofillMode::SameFeed,
    )
    .expect("autofill equal-time episode");
    assert_eq!(selected.as_deref(), Some(episode_ids[1].as_str()));
    let queue = list_queue(&state.db_path, &state.downloads_dir).expect("list equal-time queue");
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].episode.id, episode_ids[1]);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn random_queue_autofill_only_uses_unplayed_episodes_from_followed_feeds() {
    let directory = test_directory("queue-autofill-random");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(5);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store followed feed");
    set_episode_played(&state.db_path, &episode_ids[1], true).expect("complete filtered episode");
    save_progress(&state.db_path, &episode_ids[2], 20.0, 100.0).expect("partially play filtered episode");
    open_database(&state.db_path)
      .expect("open podcast database")
      .execute(
        "UPDATE podcast_episodes SET enclosure_url = '' WHERE id = ?1",
        [&episode_ids[4]],
      )
      .expect("remove invalid enclosure");

    let preview = parsed_fixture_at(
      "https://media.example.test/preview-episode.mp3",
      "https://feeds.example.test/preview-random.xml",
    );
    let preview_episode_id = preview.episodes[0].id.clone();
    store_preview(&state.db_path, preview).expect("store unfollowed preview");

    let selected = queue_autofill(
      &state.db_path,
      &episode_ids[0],
      PodcastQueueAutofillMode::RandomUnplayed,
    )
    .expect("autofill random unplayed");
    assert_eq!(selected.as_deref(), Some(episode_ids[3].as_str()));
    assert_ne!(selected.as_deref(), Some(preview_episode_id.as_str()));

    queue_clear(&state.db_path).expect("clear random queue");
    save_progress(&state.db_path, &episode_ids[3], 1.0, 100.0).expect("partially play last candidate");
    let no_candidate = queue_autofill(
      &state.db_path,
      &episode_ids[0],
      PodcastQueueAutofillMode::RandomUnplayed,
    )
    .expect("find no random candidate");
    assert!(no_candidate.is_none());
    assert!(list_queue(&state.db_path, &state.downloads_dir)
      .expect("list empty random queue")
      .is_empty());

    assert!(PodcastQueueAutofillMode::parse("unsupported").is_err());
    assert!(
      queue_autofill(
        &state.db_path,
        "invalid",
        PodcastQueueAutofillMode::SameFeed,
      )
      .is_err()
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn bulk_queue_remove_is_atomic_and_reindexes_remaining_episodes() {
    let directory = test_directory("bulk-queue-remove");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(4);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    for episode_id in &episode_ids {
      queue_add(&state.db_path, episode_id, false).expect("append episode");
    }

    let removed_ids = queue_remove_many(
      &state.db_path,
      &[
        episode_ids[1].clone(),
        episode_ids[1].clone(),
        episode_ids[3].clone(),
      ],
    )
    .expect("remove selected episodes");
    assert_eq!(
      removed_ids,
      vec![episode_ids[1].clone(), episode_ids[3].clone()]
    );
    let remaining = list_queue(&state.db_path, &state.downloads_dir).expect("list remaining queue");
    assert_eq!(
      remaining
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      vec![episode_ids[0].as_str(), episode_ids[2].as_str()]
    );
    assert_eq!(
      remaining.iter().map(|item| item.position).collect::<Vec<_>>(),
      vec![0, 1]
    );

    assert!(
      queue_remove_many(
        &state.db_path,
        &[episode_ids[0].clone(), episode_ids[1].clone()],
      )
      .is_err()
    );
    assert!(
      queue_remove_many(
        &state.db_path,
        &[episode_ids[0].clone(), "invalid".to_string()],
      )
      .is_err()
    );
    let after_rejected =
      list_queue(&state.db_path, &state.downloads_dir).expect("list unchanged queue");
    assert_eq!(
      after_rejected
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      vec![episode_ids[0].as_str(), episode_ids[2].as_str()]
    );
    assert!(queue_remove_many(&state.db_path, &[]).is_err());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn queue_total_bytes_falls_back_to_episode_expected_bytes_without_shifting_rows() {
    let directory = test_directory("queue-expected-bytes");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    mark_download_failed(&state.db_path, &episode_id, 0, "test failure")
      .expect("store download row without total bytes");
    queue_add(&state.db_path, &episode_id, false).expect("queue episode");

    let queue = list_queue(&state.db_path, &state.downloads_dir).expect("list queue");
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].episode.id, episode_id);
    assert_eq!(queue[0].episode.download_state, "failed");
    assert_eq!(queue[0].episode.total_bytes, Some(23));
    assert_eq!(queue[0].position, 0);
    assert!(queue[0].added_at > 0);

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
  fn bulk_download_delete_removes_only_selected_downloads() {
    let directory = test_directory("bulk-delete-downloads");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let mut paths = Vec::new();
    let mut expected_deleted_bytes = 0u64;
    for (index, episode_id) in episode_ids.iter().enumerate() {
      let path = state.downloads_dir.join(format!("{episode_id}.mp3"));
      let payload = format!("ID3-bulk-{index}").into_bytes();
      fs::write(&path, &payload).expect("write managed download");
      mark_download_complete(
        &state.db_path,
        episode_id,
        &path.to_string_lossy(),
        payload.len() as u64,
        Some(payload.len() as u64),
      )
      .expect("mark managed download");
      if index != 1 {
        expected_deleted_bytes += payload.len() as u64;
      }
      paths.push(path);
    }
    let part_path = state.downloads_dir.join(format!("{}.part", episode_ids[0]));
    let part_payload = b"ID3-bulk-part";
    fs::write(&part_path, part_payload).expect("write managed partial download");
    expected_deleted_bytes += part_payload.len() as u64;

    let result = delete_episode_downloads_guarded(
      &state.db_path,
      &state.downloads_dir,
      &state.active_downloads,
      vec![episode_ids[2].clone(), episode_ids[0].clone()],
      false,
    )
    .expect("delete selected downloads");
    assert_eq!(result.requested_count, 2);
    assert_eq!(result.deleted_count, 2);
    assert_eq!(result.deleted_bytes, expected_deleted_bytes);
    let mut expected_deleted_ids = vec![episode_ids[0].clone(), episode_ids[2].clone()];
    expected_deleted_ids.sort_unstable();
    assert_eq!(result.deleted_episode_ids, expected_deleted_ids);
    assert!(!paths[0].exists());
    assert!(!part_path.exists());
    assert!(paths[1].exists());
    assert!(!paths[2].exists());
    assert_eq!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_ids[0])
        .expect("selected detail")
        .episode
        .download_state,
      "none"
    );
    assert_eq!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_ids[1])
        .expect("unselected detail")
        .episode
        .download_state,
      "downloaded"
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn clearing_completed_downloads_keeps_unplayed_downloads() {
    let directory = test_directory("clear-completed-downloads");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let paths = episode_ids
      .iter()
      .enumerate()
      .map(|(index, episode_id)| {
        let path = state.downloads_dir.join(format!("{episode_id}.mp3"));
        let payload = format!("ID3-completed-{index}").into_bytes();
        fs::write(&path, &payload).expect("write managed download");
        mark_download_complete(
          &state.db_path,
          episode_id,
          &path.to_string_lossy(),
          payload.len() as u64,
          Some(payload.len() as u64),
        )
        .expect("mark managed download");
        path
      })
      .collect::<Vec<_>>();
    set_episode_played(&state.db_path, &episode_ids[0], true)
      .expect("mark first episode completed");
    set_episode_played(&state.db_path, &episode_ids[2], true)
      .expect("mark third episode completed");

    let result = clear_completed_episode_downloads_guarded(
      &state.db_path,
      &state.downloads_dir,
      &state.active_downloads,
    )
    .expect("clear completed downloads");
    assert_eq!(result.requested_count, 2);
    assert_eq!(result.deleted_count, 2);
    assert!(!paths[0].exists());
    assert!(paths[1].exists());
    assert!(!paths[2].exists());
    assert_eq!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_ids[1])
        .expect("unplayed detail")
        .episode
        .download_state,
      "downloaded"
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn clearing_completed_downloads_is_not_truncated_at_selection_limit() {
    let directory = test_directory("clear-all-completed-downloads");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(PODCAST_DOWNLOAD_DELETE_LIMIT + 1);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let mut connection = open_database(&state.db_path).expect("open podcast database");
    let transaction = connection
      .transaction_with_behavior(TransactionBehavior::Immediate)
      .expect("begin fixture transaction");
    for (index, episode_id) in episode_ids.iter().enumerate() {
      let local_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
      transaction
        .execute(
          "
          INSERT INTO podcast_downloads (
            episode_id, local_path, state, downloaded_bytes, total_bytes,
            error_message, updated_at
          ) VALUES (?1, ?2, 'downloaded', 1, 1, NULL, ?3)
          ",
          params![
            episode_id,
            local_path.to_string_lossy(),
            i64::try_from(index).unwrap_or(i64::MAX),
          ],
        )
        .expect("insert completed download");
      transaction
        .execute(
          "
          INSERT INTO podcast_progress (
            episode_id, position_seconds, duration_seconds, completed, updated_at
          ) VALUES (?1, 1, 1, 1, ?2)
          ",
          params![
            episode_id,
            i64::try_from(index).unwrap_or(i64::MAX),
          ],
        )
        .expect("insert completed progress");
    }
    transaction.commit().expect("commit fixture transaction");
    drop(connection);

    assert_eq!(
      list_completed_download_ids(&state.db_path)
        .expect("list all completed downloads")
        .len(),
      PODCAST_DOWNLOAD_DELETE_LIMIT + 1
    );
    let result = clear_completed_episode_downloads_guarded(
      &state.db_path,
      &state.downloads_dir,
      &state.active_downloads,
    )
    .expect("clear every completed download");
    assert_eq!(result.requested_count, PODCAST_DOWNLOAD_DELETE_LIMIT + 1);
    assert_eq!(result.deleted_count, PODCAST_DOWNLOAD_DELETE_LIMIT + 1);
    assert_eq!(
      result.deleted_episode_ids.len(),
      PODCAST_DOWNLOAD_DELETE_LIMIT + 1
    );
    assert!(
      state
        .active_downloads
        .lock()
        .expect("inspect active downloads")
        .is_empty()
    );
    let remaining_downloads = {
      let connection = open_database(&state.db_path).expect("reopen podcast database");
      connection
        .query_row("SELECT COUNT(*) FROM podcast_downloads", [], |row| {
          row.get::<_, i64>(0)
        })
        .expect("count remaining downloads")
    };
    assert_eq!(remaining_downloads, 0);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn bulk_download_delete_preflight_prevents_partial_cleanup() {
    let directory = test_directory("bulk-delete-preflight");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let paths = episode_ids
      .iter()
      .enumerate()
      .map(|(index, episode_id)| {
        let path = state.downloads_dir.join(format!("{episode_id}.mp3"));
        let payload = format!("ID3-preflight-{index}").into_bytes();
        fs::write(&path, &payload).expect("write managed download");
        mark_download_complete(
          &state.db_path,
          episode_id,
          &path.to_string_lossy(),
          payload.len() as u64,
          Some(payload.len() as u64),
        )
        .expect("mark managed download");
        path
      })
      .collect::<Vec<_>>();

    assert!(
      delete_episode_downloads_guarded(
        &state.db_path,
        &state.downloads_dir,
        &state.active_downloads,
        vec![episode_ids[0].clone(), "invalid".to_string(), episode_ids[1].clone()],
        false,
      )
      .is_err()
    );
    assert!(paths.iter().all(|path| path.exists()));
    assert!(
      delete_episode_downloads_guarded(
        &state.db_path,
        &state.downloads_dir,
        &state.active_downloads,
        vec![episode_ids[0].clone(); PODCAST_DOWNLOAD_DELETE_LIMIT + 1],
        false,
      )
      .is_err()
    );
    assert!(paths.iter().all(|path| path.exists()));

    let active_guard = EpisodeFileGuard::acquire(
      &state.active_downloads,
      &episode_ids[1],
    )
    .expect("reserve active episode");
    assert!(
      delete_episode_downloads_guarded(
        &state.db_path,
        &state.downloads_dir,
        &state.active_downloads,
        vec![episode_ids[0].clone(), episode_ids[1].clone()],
        false,
      )
      .is_err()
    );
    assert!(paths.iter().all(|path| path.exists()));
    drop(active_guard);

    let result = delete_episode_downloads_guarded(
      &state.db_path,
      &state.downloads_dir,
      &state.active_downloads,
      vec![
        episode_ids[0].clone(),
        episode_ids[0].clone(),
        episode_ids[1].clone(),
      ],
      false,
    )
    .expect("delete deduplicated selection");
    assert_eq!(result.requested_count, 2);
    assert_eq!(result.deleted_count, 2);
    assert_eq!(result.deleted_episode_ids.len(), 2);
    assert!(!paths[0].exists());
    assert!(!paths[1].exists());
    assert!(paths[2].exists());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn bulk_download_delete_restores_staged_files_when_a_later_rename_fails() {
    let directory = test_directory("bulk-delete-stage-rollback");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(2);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let paths = episode_ids
      .iter()
      .enumerate()
      .map(|(index, episode_id)| {
        let path = state.downloads_dir.join(format!("{episode_id}.mp3"));
        let payload = format!("ID3-rollback-{index}").into_bytes();
        fs::write(&path, &payload).expect("write managed download");
        mark_download_complete(
          &state.db_path,
          episode_id,
          &path.to_string_lossy(),
          payload.len() as u64,
          Some(payload.len() as u64),
        )
        .expect("mark managed download");
        (path, payload)
      })
      .collect::<Vec<_>>();

    let mut rename_count = 0usize;
    let mut injected_rename = |from: &Path, to: &Path| {
      rename_count += 1;
      if rename_count == 2 {
        return Err(std::io::Error::new(
          std::io::ErrorKind::Other,
          "injected staging failure",
        ));
      }
      fs::rename(from, to)
    };
    let result = delete_episode_downloads_with_rename(
      &state.db_path,
      &state.downloads_dir,
      &episode_ids,
      false,
      episode_ids.len(),
      &mut injected_rename,
    );
    assert!(result.is_err());
    assert_eq!(rename_count, 2);
    for ((path, payload), episode_id) in paths.iter().zip(&episode_ids) {
      assert_eq!(fs::read(path).expect("read restored download"), *payload);
      assert_eq!(
        get_episode_detail(&state.db_path, &state.downloads_dir, episode_id)
          .expect("detail after rollback")
          .episode
          .download_state,
        "downloaded"
      );
    }
    assert!(
      fs::read_dir(&state.downloads_dir)
        .expect("inspect downloads directory")
        .all(|entry| {
          !entry
            .expect("read downloads entry")
            .file_name()
            .to_string_lossy()
            .starts_with(".zone-delete-")
        })
    );

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
  fn feed_refresh_guard_deduplicates_the_same_feed_only() {
    let active = Arc::new(Mutex::new(HashSet::new()));
    let first_id = "a".repeat(64);
    let second_id = "b".repeat(64);
    let first = FeedRefreshGuard::acquire(&active, &first_id)
      .expect("acquire first feed")
      .expect("first feed should be available");
    assert!(
      FeedRefreshGuard::acquire(&active, &first_id)
        .expect("inspect duplicate feed")
        .is_none()
    );
    let second = FeedRefreshGuard::acquire(&active, &second_id)
      .expect("acquire second feed")
      .expect("different feed should refresh concurrently");
    drop(first);
    assert!(
      FeedRefreshGuard::acquire(&active, &first_id)
        .expect("reacquire released feed")
        .is_some()
    );
    drop(second);
  }

  #[test]
  fn refresh_semaphore_caps_work_across_shared_state_clones() {
    let directory = test_directory("refresh-semaphore");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let cloned = state.clone();
    let mut permits = (0..PODCAST_REFRESH_CONCURRENCY)
      .map(|_| {
        state
          .refresh_semaphore
          .clone()
          .try_acquire_owned()
          .expect("acquire refresh permit")
      })
      .collect::<Vec<_>>();
    assert_eq!(cloned.refresh_semaphore.available_permits(), 0);
    assert!(cloned.refresh_semaphore.clone().try_acquire_owned().is_err());
    permits.pop();
    assert_eq!(cloned.refresh_semaphore.available_permits(), 1);
    assert!(cloned.refresh_semaphore.clone().try_acquire_owned().is_ok());

    fs::remove_dir_all(directory).expect("cleanup test directory");
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
  async fn conditional_refresh_handles_not_modified_without_advancing_fetch_time() {
    let directory = test_directory("refresh-not-modified");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind refresh server");
    let address = listener.local_addr().expect("refresh server address");
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.expect("accept refresh request");
      let mut request = vec![0u8; 8_192];
      let read = stream.read(&mut request).await.expect("read refresh request");
      let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
      assert!(request.contains("if-none-match: \"etag-one\""), "{request}");
      assert!(
        request.contains("if-modified-since: sat, 25 jul 2026 08:00:00 gmt"),
        "{request}"
      );
      stream
        .write_all(
          b"HTTP/1.1 304 Not Modified\r\nETag: \"etag-two\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await
        .expect("write not-modified response");
      stream.shutdown().await.expect("shutdown refresh response");
    });
    let feed_url = format!("http://{address}/feed.xml");
    open_database(&state.db_path)
      .expect("open refresh database")
      .execute(
        "
        UPDATE podcast_feeds SET
          feed_url = ?2,
          last_fetched_at = 123,
          last_checked_at = 0,
          last_refresh_error = '旧错误'
        WHERE id = ?1
        ",
        params![feed_id, feed_url],
      )
      .expect("point feed at refresh server");
    let target = list_refresh_targets(&state.db_path, Some(&feed_id), true, unix_time_millis())
      .expect("load refresh target")
      .pop()
      .expect("refresh target");
    let outcome = refresh_feed_target(
      state.db_path.clone(),
      state.active_refreshes.clone(),
      state.refresh_semaphore.clone(),
      target,
      true,
    )
    .await;
    server.await.expect("refresh server task");
    assert!(matches!(outcome, PodcastRefreshOutcome::NotModified));
    let (etag, last_fetched_at, last_checked_at, last_refresh_error) = open_database(&state.db_path)
      .expect("open refreshed database")
      .query_row(
        "
        SELECT etag, last_fetched_at, last_checked_at, last_refresh_error
        FROM podcast_feeds
        WHERE id = ?1
        ",
        [&feed_id],
        |row| {
          Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<String>>(3)?,
          ))
        },
      )
      .expect("read not-modified state");
    assert_eq!(etag.as_deref(), Some("\"etag-two\""));
    assert_eq!(last_fetched_at, 123);
    assert!(last_checked_at.is_some_and(|value| value > 0));
    assert!(last_refresh_error.is_none());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[tokio::test]
  async fn successful_refresh_preserves_ids_and_reports_inserted_and_changed_episodes() {
    let directory = test_directory("refresh-updated");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let original_episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    let original_first_seen =
      get_episode_detail(&state.db_path, &state.downloads_dir, &original_episode_id)
        .expect("initial episode")
        .episode
        .first_seen_at;

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind refresh server");
    let address = listener.local_addr().expect("refresh server address");
    let body = r#"<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Zone 测试播客</title>
          <description>刷新后的节目简介</description>
          <item>
            <guid isPermaLink="false">episode-one</guid>
            <title>第一集（修订）</title>
            <link>https://www.example.test/episodes/one-updated</link>
            <enclosure url="https://media.example.test/episode-1.mp3" type="audio/mpeg" />
          </item>
          <item>
            <guid isPermaLink="false">episode-two</guid>
            <title>第二集</title>
            <link>https://www.example.test/episodes/two</link>
            <enclosure url="https://media.example.test/episode-2.mp3" type="audio/mpeg" />
          </item>
        </channel>
      </rss>"#
      .as_bytes()
      .to_vec();
    let server_body = body.clone();
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.expect("accept refresh request");
      let mut request = vec![0u8; 8_192];
      let read = stream.read(&mut request).await.expect("read refresh request");
      let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
      assert!(request.contains("if-none-match: \"etag-one\""), "{request}");
      let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        server_body.len(),
      );
      stream.write_all(headers.as_bytes()).await.expect("write refresh headers");
      stream.write_all(&server_body).await.expect("write refresh body");
      stream.shutdown().await.expect("shutdown refresh response");
    });
    let feed_url = format!("http://{address}/feed.xml");
    open_database(&state.db_path)
      .expect("open refresh database")
      .execute(
        "
        UPDATE podcast_feeds SET
          feed_url = ?2,
          last_checked_at = 0,
          last_refresh_error = '旧错误'
        WHERE id = ?1
        ",
        params![feed_id, feed_url],
      )
      .expect("point feed at refresh server");
    let target = list_refresh_targets(&state.db_path, Some(&feed_id), true, unix_time_millis())
      .expect("load refresh target")
      .pop()
      .expect("refresh target");
    let outcome = refresh_feed_target(
      state.db_path.clone(),
      state.active_refreshes.clone(),
      state.refresh_semaphore.clone(),
      target,
      true,
    )
    .await;
    server.await.expect("refresh server task");
    assert!(matches!(
      &outcome,
      PodcastRefreshOutcome::Updated {
        inserted: 1,
        updated: 1,
      }
    ), "{outcome:?}");
    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &feed_id).expect("list refreshed episodes");
    assert_eq!(episodes.len(), 2);
    let updated = episodes
      .iter()
      .find(|episode| episode.id == original_episode_id)
      .expect("stable existing episode");
    assert_eq!(updated.title, "第一集（修订）");
    assert_eq!(updated.first_seen_at, original_first_seen);
    assert_eq!(
      updated.webpage_url.as_deref(),
      Some("https://www.example.test/episodes/one-updated")
    );
    let inserted = episodes
      .iter()
      .find(|episode| episode.title == "第二集")
      .expect("inserted episode");
    assert_eq!(
      inserted.id,
      hash_identifier("episode", &[&feed_id, "guid:episode-two"])
    );
    assert!(inserted.first_seen_at >= original_first_seen);
    let feed = list_feeds(&state.db_path)
      .expect("list refreshed feeds")
      .pop()
      .expect("refreshed feed");
    assert_eq!(feed.id, feed_id);
    assert!(feed.last_refresh_error.is_none());
    let validators = open_database(&state.db_path)
      .expect("open refreshed database")
      .query_row(
        "SELECT etag, last_modified FROM podcast_feeds WHERE id = ?1",
        [&feed.id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
      )
      .expect("read refreshed validators");
    assert_eq!(validators, (None, None));

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[tokio::test]
  async fn conditional_headers_are_not_forwarded_across_origins() {
    let redirect_listener = TcpListener::bind("127.0.0.1:0")
      .await
      .expect("bind redirect server");
    let redirect_address = redirect_listener.local_addr().expect("redirect address");
    let destination_listener = TcpListener::bind("127.0.0.1:0")
      .await
      .expect("bind destination server");
    let destination_address = destination_listener.local_addr().expect("destination address");
    let destination = tokio::spawn(async move {
      let (mut stream, _) = destination_listener
        .accept()
        .await
        .expect("accept redirected request");
      let mut request = vec![0u8; 8_192];
      let read = stream.read(&mut request).await.expect("read redirected request");
      let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
      assert!(!request.contains("if-none-match:"), "{request}");
      assert!(!request.contains("if-modified-since:"), "{request}");
      stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
        .await
        .expect("write destination response");
      stream.shutdown().await.expect("shutdown destination response");
    });
    let redirect = tokio::spawn(async move {
      let (mut stream, _) = redirect_listener.accept().await.expect("accept initial request");
      let mut request = vec![0u8; 8_192];
      let read = stream.read(&mut request).await.expect("read initial request");
      let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
      assert!(request.contains("if-none-match: \"private-validator\""), "{request}");
      let response = format!(
        "HTTP/1.1 302 Found\r\nLocation: http://{destination_address}/final.xml\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      );
      stream
        .write_all(response.as_bytes())
        .await
        .expect("write redirect response");
      stream.shutdown().await.expect("shutdown redirect response");
    });
    let mut headers = HeaderMap::new();
    headers.insert(
      header::IF_NONE_MATCH,
      HeaderValue::from_static("\"private-validator\""),
    );
    headers.insert(
      header::IF_MODIFIED_SINCE,
      HeaderValue::from_static("Sat, 25 Jul 2026 08:00:00 GMT"),
    );
    let response = send_public_get_with_headers(
      Url::parse(&format!("http://localhost:{}/start.xml", redirect_address.port()))
        .expect("initial URL"),
      Duration::from_secs(5),
      None,
      true,
      &headers,
    )
    .await
    .expect("follow safe test redirect");
    assert_eq!(response.response.status(), StatusCode::OK);
    redirect.await.expect("redirect server task");
    destination.await.expect("destination server task");
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
