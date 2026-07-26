use feed_rs::model::{Entry as ParsedEntry, Feed as ParsedFeed};
use reqwest::header::{self, HeaderMap};
use reqwest::{StatusCode, Url};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const APPLE_SEARCH_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const PODCAST_FEED_RESPONSE_LIMIT: usize = 20 * 1024 * 1024;
const PODCAST_AUDIO_RESPONSE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const PODCAST_REDIRECT_LIMIT: usize = 5;
const PODCAST_DESCRIPTION_LIMIT: usize = 20_000;
const PODCAST_TITLE_LIMIT: usize = 500;
const USER_AGENT: &str = "Zone/0.1 (local podcast player)";

#[derive(Clone, Debug)]
pub struct PodcastState {
  db_path: PathBuf,
  downloads_dir: PathBuf,
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
pub struct PodcastFeed {
  id: String,
  feed_url: String,
  title: String,
  author: Option<String>,
  description: Option<String>,
  artwork_url: Option<String>,
  last_fetched_at: i64,
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
      initialization_error: None,
    })
  }

  pub fn unavailable(error: String) -> Self {
    Self {
      db_path: PathBuf::new(),
      downloads_dir: PathBuf::new(),
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
pub async fn podcast_list_feeds(state: State<'_, PodcastState>) -> Result<Vec<PodcastFeed>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || list_feeds(&db_path))
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
  tauri::async_runtime::spawn_blocking(move || list_episodes(&db_path, &feed_id))
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
        last_fetched_at INTEGER NOT NULL
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

      CREATE INDEX IF NOT EXISTS podcast_episodes_feed_published
        ON podcast_episodes(feed_id, published_at DESC);
      ",
    )
    .map_err(|error| format!("无法初始化播客数据库：{error}"))?;
  Ok(connection)
}

fn store_subscription(db_path: &Path, parsed: ParsedPodcast) -> Result<PodcastSubscribeResult, String> {
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction()
    .map_err(|error| format!("无法更新播客订阅：{error}"))?;
  let feed = parsed.feed;
  transaction
    .execute(
      "
      INSERT INTO podcast_feeds (
        id, feed_url, title, author, description, artwork_url,
        etag, last_modified, last_fetched_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(id) DO UPDATE SET
        feed_url = excluded.feed_url,
        title = excluded.title,
        author = excluded.author,
        description = excluded.description,
        artwork_url = excluded.artwork_url,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        last_fetched_at = excluded.last_fetched_at
      ",
      params![
        feed.id,
        feed.feed_url,
        feed.title,
        feed.author,
        feed.description,
        feed.artwork_url,
        parsed.etag,
        parsed.last_modified,
        feed.last_fetched_at,
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
    for episode in &parsed.episodes {
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
    episode_count: parsed.episodes.len(),
    inserted_count,
  })
}

fn list_feeds(db_path: &Path) -> Result<Vec<PodcastFeed>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT id, feed_url, title, author, description, artwork_url, last_fetched_at
      FROM podcast_feeds
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
      })
    })
    .map_err(|error| format!("无法读取播客订阅：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客订阅：{error}"))
}

fn list_episodes(db_path: &Path, feed_id: &str) -> Result<Vec<PodcastEpisode>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT
        e.id, e.feed_id, e.title, e.description, e.published_at,
        e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
        COALESCE(d.state, 'none'), d.local_path,
        COALESCE(d.downloaded_bytes, 0), d.total_bytes,
        COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0)
      FROM podcast_episodes e
      LEFT JOIN podcast_downloads d ON d.episode_id = e.id
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      WHERE e.feed_id = ?1
      ORDER BY e.published_at IS NULL, e.published_at DESC, e.title COLLATE NOCASE
      LIMIT 5000
      ",
    )
    .map_err(|error| format!("无法读取播客单集：{error}"))?;
  let rows = statement
    .query_map([feed_id], |row| {
      let downloaded_bytes = row.get::<_, i64>(11)?.max(0) as u64;
      let total_bytes = row.get::<_, Option<i64>>(12)?.map(|value| value.max(0) as u64);
      Ok(PodcastEpisode {
        id: row.get(0)?,
        feed_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        published_at: row.get(4)?,
        duration_seconds: row.get(5)?,
        enclosure_url: row.get(6)?,
        enclosure_type: row.get(7)?,
        artwork_url: row.get(8)?,
        download_state: row.get(9)?,
        local_path: row.get(10)?,
        downloaded_bytes,
        total_bytes,
        progress_seconds: row.get(13)?,
        completed: row.get::<_, i64>(14)? != 0,
      })
    })
    .map_err(|error| format!("无法读取播客单集：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客单集：{error}"))
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
        completed = excluded.completed,
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
      request = request.header(header::RANGE, range);
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
    let next_url = url.join(location).map_err(|_| "播客来源重定向地址无效".to_string())?;
    if url.scheme() == "https" && next_url.scheme() == "http" {
      return Err("播客来源拒绝从 HTTPS 降级到 HTTP".to_string());
    }
    url = next_url;
  }
  Err("播客来源重定向次数过多".to_string())
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
    mark_download_complete(&state.db_path, &episode_id, &fake_path.to_string_lossy(), 23, Some(23))
      .expect("save download");
    let episodes = list_episodes(&state.db_path, &first.feed.id).expect("list episodes");
    assert_eq!(episodes.len(), 1);
    assert_eq!(episodes[0].progress_seconds, 100.0);
    assert!(episodes[0].completed);
    assert_eq!(episodes[0].download_state, "downloaded");
    assert_eq!(episodes[0].downloaded_bytes, 23);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn content_range_parser_rejects_inconsistent_ranges() {
    assert_eq!(parse_content_range("bytes 10-19/100"), Some((10, 19, Some(100))));
    assert_eq!(parse_content_range("bytes 0-9/*"), Some((0, 9, None)));
    assert_eq!(parse_content_range("bytes 20-10/100"), None);
    assert_eq!(parse_content_range("bytes 0-100/100"), None);
    assert_eq!(parse_content_range("items 0-9/100"), None);
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
    let episodes = list_episodes(&state.db_path, &feed_id).expect("list episodes");
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
}
