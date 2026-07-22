use encoding_rs::GBK;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::{Accessor, ItemKey};
use lofty::read_from_path;
use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use std::time::Instant;
use std::time::UNIX_EPOCH;
use tauri::http::{header, Method, Request, Response, StatusCode};
#[cfg(target_os = "windows")]
use tauri::Manager;
use walkdir::WalkDir;

mod qrc;
mod system_media;

const AUDIO_RANGE_CHUNK_SIZE: u64 = 1024 * 1024;
const LYRICS_PROVIDER_RESPONSE_LIMIT: usize = 1024 * 1024;
const AMLL_INDEX_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const LYRICS_PROVIDER_REQUEST_BODY_LIMIT: usize = 4 * 1024;
const QRC_ENCRYPTED_TEXT_LIMIT: usize = 128 * 1024;
static LYRICS_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize)]
struct MusicFolder {
  path: String,
  name: String,
}

#[derive(Debug, Serialize)]
struct Track {
  id: String,
  path: String,
  file_name: String,
  title: String,
  artist: String,
  album: String,
  album_artist: String,
  track_number: Option<u32>,
  disc_number: Option<u32>,
  year: Option<u32>,
  genres: Vec<String>,
  duration_seconds: Option<u64>,
  added_at: Option<u64>,
  extension: String,
  cover_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct ScanResult {
  folders: Vec<String>,
  tracks: Vec<Track>,
  skipped: usize,
}

#[derive(Debug, Serialize)]
struct LocalLyricsSource {
  source_id: String,
  origin: String,
  format_hint: String,
  label: String,
  content: String,
  path: Option<String>,
  modified_at: Option<u64>,
  is_manual: bool,
}

#[tauri::command]
fn select_music_folder() -> Option<MusicFolder> {
  let folder = rfd::FileDialog::new().set_title("Choose music folder").pick_folder()?;
  let name = folder
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("music")
    .to_string();

  Some(MusicFolder {
    path: folder.to_string_lossy().to_string(),
    name,
  })
}

#[tauri::command]
fn select_lyrics_file() -> Option<String> {
  rfd::FileDialog::new()
    .set_title("选择歌词文件")
    .add_filter("歌词", &["ttml", "lrc", "txt"])
    .pick_file()
    .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn load_local_lyrics(
  track_path: String,
  manual_path: Option<String>,
) -> Result<Option<LocalLyricsSource>, String> {
  let track_path = PathBuf::from(track_path);
  if !track_path.is_file() {
    return Err("音频文件不存在".to_string());
  }

  // A manual binding is an explicit override. Automatic discovery resumes as
  // soon as the binding is cleared by the user.
  if let Some(manual_path) = manual_path.filter(|value| !value.trim().is_empty()) {
    let path = PathBuf::from(manual_path);
    return read_lyrics_source(&path, "manual", true).map(Some);
  }

  if let Some(content) = embedded_lyrics(&track_path) {
    return Ok(Some(LocalLyricsSource {
      source_id: format!("embedded:{}", stable_track_id(&track_path)),
      origin: "embedded".to_string(),
      format_hint: infer_lyrics_format(&content, None).to_string(),
      label: "内嵌歌词".to_string(),
      content,
      path: None,
      modified_at: file_modified_at(&track_path),
      is_manual: false,
    }));
  }

  let Some(path) = find_sidecar_lyrics(&track_path) else {
    return Ok(None);
  };

  read_lyrics_source(&path, "sidecar", false).map(Some)
}

#[tauri::command]
async fn request_lyrics_provider(
  provider_id: String,
  url: String,
  timeout_ms: u64,
  body: Option<String>,
) -> Result<String, String> {
  let url = validate_lyrics_provider_url(&provider_id, &url)?;
  let body = validate_lyrics_provider_request_body(&provider_id, &url, body)?;
  let response_limit = lyrics_provider_response_limit(&provider_id, &url);
  let timeout = Duration::from_millis(timeout_ms.clamp(1_500, 20_000));
  let request_id = LYRICS_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
  let started_at = Instant::now();
  eprintln!(
    "[lyrics:{request_id}] start provider={} method={} endpoint={} timeout={}ms",
    provider_id,
    if body.is_some() { "POST" } else { "GET" },
    url.path(),
    timeout.as_millis(),
  );
  let client = reqwest::Client::builder()
    .user_agent("Zone/0.1 (local music player)")
    .timeout(timeout)
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .map_err(|_| "无法初始化在线歌词请求".to_string())?;
  let mut attempt = 0;
  let response = loop {
    let send_started_at = Instant::now();
    let request = if provider_id == "qq" {
      let content_type = if url.path() == "/cgi-bin/musicu.fcg" {
        "application/json"
      } else {
        "application/x-www-form-urlencoded"
      };
      client
        .post(url.clone())
        .header("Content-Type", content_type)
        .header("Referer", "https://c.y.qq.com/")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Zone/0.1")
        .body(body.clone().unwrap_or_default())
    } else {
      client.get(url.clone())
    };
    let response = match request.send().await {
      Ok(response) => response,
      Err(error) => {
        eprintln!(
          "[lyrics:{request_id}] transport-error attempt={} elapsed={}ms timeout={} connect={} request={} body={}",
          attempt + 1,
          send_started_at.elapsed().as_millis(),
          error.is_timeout(),
          error.is_connect(),
          error.is_request(),
          error.is_body(),
        );
        if error.is_timeout() {
          return Err("在线歌词来源响应超时".to_string());
        } else {
          return Err("无法连接在线歌词来源".to_string());
        }
      }
    };
    eprintln!(
      "[lyrics:{request_id}] headers attempt={} status={} elapsed={}ms content_length={:?}",
      attempt + 1,
      response.status().as_u16(),
      send_started_at.elapsed().as_millis(),
      response.content_length(),
    );
    if attempt == 0 && is_retryable_provider_status(response.status()) {
      eprintln!(
        "[lyrics:{request_id}] retry-gateway status={} next_attempt=2",
        response.status().as_u16(),
      );
      attempt += 1;
      continue;
    }
    break response;
  };

  if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
    return Err("在线歌词来源请求过于频繁，请稍后重试".to_string());
  }
  if !response.status().is_success() {
    return Err(format!("在线歌词来源返回错误 {}", response.status().as_u16()));
  }
  if response
    .content_length()
    .is_some_and(|length| length > response_limit as u64)
  {
    return Err("在线歌词响应超过大小限制".to_string());
  }

  let mut response = response;
  let mut bytes = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|error| {
      eprintln!(
        "[lyrics:{request_id}] body-error elapsed={}ms timeout={} connect={} body={}",
        started_at.elapsed().as_millis(),
        error.is_timeout(),
        error.is_connect(),
        error.is_body(),
      );
      "无法读取在线歌词响应".to_string()
    })?
  {
    if bytes.len().saturating_add(chunk.len()) > response_limit {
      return Err("在线歌词响应超过大小限制".to_string());
    }
    bytes.extend_from_slice(&chunk);
  }
  eprintln!(
    "[lyrics:{request_id}] complete status={} bytes={} elapsed={}ms",
    response.status().as_u16(),
    bytes.len(),
    started_at.elapsed().as_millis(),
  );
  String::from_utf8(bytes).map_err(|_| "在线歌词响应编码无效".to_string())
}

#[tauri::command]
fn decrypt_qrc_lyrics(encrypted: String) -> Result<String, String> {
  if encrypted.len() > QRC_ENCRYPTED_TEXT_LIMIT {
    return Err("QQ 音乐歌词数据超过大小限制".to_string());
  }
  let compact = encrypted
    .chars()
    .filter(|character| !character.is_whitespace())
    .collect::<String>();
  if compact.is_empty()
    || compact.len() % 16 != 0
    || !compact.bytes().all(|byte| byte.is_ascii_hexdigit())
  {
    return Err("QQ 音乐歌词数据无效".to_string());
  }
  let decoded = qrc::decrypt_lyrics(&compact, LYRICS_PROVIDER_RESPONSE_LIMIT)
    .ok_or_else(|| "无法解密 QQ 音乐歌词".to_string())?;
  if decoded.len() > LYRICS_PROVIDER_RESPONSE_LIMIT {
    return Err("QQ 音乐歌词解压后超过大小限制".to_string());
  }
  Ok(decoded)
}

fn lyrics_provider_response_limit(provider_id: &str, url: &reqwest::Url) -> usize {
  if provider_id == "amll-ttml-db"
    && url.path() == "/amll-dev/amll-ttml-db/refs/heads/main/metadata/raw-lyrics-index.jsonl"
  {
    AMLL_INDEX_RESPONSE_LIMIT
  } else {
    LYRICS_PROVIDER_RESPONSE_LIMIT
  }
}

fn is_retryable_provider_status(status: reqwest::StatusCode) -> bool {
  matches!(
    status,
    reqwest::StatusCode::BAD_GATEWAY
      | reqwest::StatusCode::SERVICE_UNAVAILABLE
      | reqwest::StatusCode::GATEWAY_TIMEOUT
  )
}

fn validate_lyrics_provider_url(provider_id: &str, value: &str) -> Result<reqwest::Url, String> {
  let url = reqwest::Url::parse(value).map_err(|_| "在线歌词请求地址无效".to_string())?;
  let allowed = match provider_id {
    "lrclib" => {
      url.scheme() == "https"
        && url.host_str() == Some("lrclib.net")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && (url.path() == "/api/search" || url.path().starts_with("/api/get/"))
    }
    "amll-ttml-db" => validate_amll_ttml_url(&url),
    "netease" => validate_netease_lyrics_url(&url),
    "qq" => validate_qq_lyrics_url(&url),
    _ => false,
  };
  if !allowed {
    return Err("在线歌词来源或请求地址未获允许".to_string());
  }
  Ok(url)
}

fn validate_qq_lyrics_url(url: &reqwest::Url) -> bool {
  url.scheme() == "https"
    && url.port().is_none()
    && url.username().is_empty()
    && url.password().is_none()
    && url.query().is_none()
    && url.fragment().is_none()
    && matches!(
      (url.host_str(), url.path()),
      (Some("u.y.qq.com"), "/cgi-bin/musicu.fcg")
        | (Some("c.y.qq.com"), "/qqmusic/fcgi-bin/lyric_download.fcg")
    )
}

fn validate_lyrics_provider_request_body(
  provider_id: &str,
  url: &reqwest::Url,
  body: Option<String>,
) -> Result<Option<String>, String> {
  if provider_id != "qq" {
    return if body.is_none() {
      Ok(None)
    } else {
      Err("该在线歌词来源不接受请求内容".to_string())
    };
  }
  let body = body.ok_or_else(|| "QQ 音乐请求缺少必要内容".to_string())?;
  if body.is_empty() || body.len() > LYRICS_PROVIDER_REQUEST_BODY_LIMIT {
    return Err("QQ 音乐请求内容无效".to_string());
  }
  let valid = match url.path() {
    "/cgi-bin/musicu.fcg" => validate_qq_search_body(&body),
    "/qqmusic/fcgi-bin/lyric_download.fcg" => validate_qq_lyric_body(&body),
    _ => false,
  };
  if !valid {
    return Err("QQ 音乐请求内容无效".to_string());
  }
  Ok(Some(body))
}

fn validate_qq_search_body(body: &str) -> bool {
  let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
    return false;
  };
  let Some(root) = value.as_object() else {
    return false;
  };
  let Some(request) = root.get("req_1").and_then(serde_json::Value::as_object) else {
    return false;
  };
  let Some(params) = request.get("param").and_then(serde_json::Value::as_object) else {
    return false;
  };
  let Some(query) = params.get("query").and_then(serde_json::Value::as_str) else {
    return false;
  };
  root.len() == 1
    && request.len() == 3
    && params.len() == 4
    && request.get("method").and_then(serde_json::Value::as_str)
      == Some("DoSearchForQQMusicDesktop")
    && request.get("module").and_then(serde_json::Value::as_str)
      == Some("music.search.SearchCgiService")
    && params.get("num_per_page").and_then(serde_json::Value::as_str) == Some("20")
    && params.get("page_num").and_then(serde_json::Value::as_str) == Some("1")
    && params.get("search_type").and_then(serde_json::Value::as_u64) == Some(0)
    && !query.trim().is_empty()
    && query.chars().count() <= 300
}

fn validate_qq_lyric_body(body: &str) -> bool {
  let Ok(url) = reqwest::Url::parse(&format!("https://zone.invalid/?{body}")) else {
    return false;
  };
  if url.fragment().is_some() {
    return false;
  }
  let pairs = url
    .query_pairs()
    .map(|(key, value)| (key.into_owned(), value.into_owned()))
    .collect::<Vec<_>>();
  pairs.len() == 4
    && unique_query_value(&pairs, "version") == Some("15")
    && unique_query_value(&pairs, "miniversion") == Some("82")
    && unique_query_value(&pairs, "lrctype") == Some("4")
    && unique_query_value(&pairs, "musicid")
      .and_then(|value| value.parse::<u64>().ok())
      .is_some_and(|id| id > 0)
}

fn validate_amll_ttml_url(url: &reqwest::Url) -> bool {
  if url.scheme() != "https"
    || url.host_str() != Some("raw.githubusercontent.com")
    || url.port().is_some()
    || !url.username().is_empty()
    || url.password().is_some()
    || url.query().is_some()
    || url.fragment().is_some()
  {
    return false;
  }

  if url.path() == "/amll-dev/amll-ttml-db/refs/heads/main/metadata/raw-lyrics-index.jsonl" {
    return true;
  }
  let Some(file_name) = url
    .path()
    .strip_prefix("/amll-dev/amll-ttml-db/refs/heads/main/raw-lyrics/")
  else {
    return false;
  };
  !file_name.is_empty()
    && file_name.ends_with(".ttml")
    && file_name
      .chars()
      .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
}

fn validate_netease_lyrics_url(url: &reqwest::Url) -> bool {
  if url.scheme() != "https"
    || url.host_str() != Some("music.163.com")
    || url.port().is_some()
    || !url.username().is_empty()
    || url.password().is_some()
    || url.fragment().is_some()
  {
    return false;
  }

  let pairs = url
    .query_pairs()
    .map(|(key, value)| (key.into_owned(), value.into_owned()))
    .collect::<Vec<_>>();
  match url.path() {
    "/api/search/get/web" => {
      if pairs.len() != 6 {
        return false;
      }
      let Some(search) = unique_query_value(&pairs, "s") else {
        return false;
      };
      !search.trim().is_empty()
        && search.chars().count() <= 300
        && unique_query_value(&pairs, "csrf_token") == Some("")
        && unique_query_value(&pairs, "type") == Some("1")
        && unique_query_value(&pairs, "offset") == Some("0")
        && unique_query_value(&pairs, "total") == Some("true")
        && unique_query_value(&pairs, "limit")
          .and_then(|value| value.parse::<u8>().ok())
          .is_some_and(|limit| (1..=10).contains(&limit))
    }
    "/api/song/lyric" => {
      pairs.len() == 5
        && unique_query_value(&pairs, "id")
          .and_then(|value| value.parse::<u64>().ok())
          .is_some_and(|id| id > 0)
        && ["lv", "tv", "rv", "kv"]
          .iter()
          .all(|key| unique_query_value(&pairs, key) == Some("-1"))
    }
    _ => false,
  }
}

fn unique_query_value<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
  let mut matches = pairs
    .iter()
    .filter(|(candidate, _)| candidate == key)
    .map(|(_, value)| value.as_str());
  let value = matches.next()?;
  if matches.next().is_some() {
    return None;
  }
  Some(value)
}

#[tauri::command]
fn scan_library(folders: Vec<String>) -> ScanResult {
  let mut tracks = Vec::new();
  let mut skipped = 0usize;

  for folder in &folders {
    let root = PathBuf::from(folder);
    if !root.exists() {
      skipped += 1;
      continue;
    }

    for entry in WalkDir::new(&root).follow_links(false).into_iter().filter_map(Result::ok) {
      if !entry.file_type().is_file() {
        continue;
      }

      let path = entry.path();
      if !is_supported_audio(path) {
        skipped += 1;
        continue;
      }

      tracks.push(track_from_path(path));
    }
  }

  tracks.sort_by(|a, b| {
    a.artist
      .to_lowercase()
      .cmp(&b.artist.to_lowercase())
      .then(a.album.to_lowercase().cmp(&b.album.to_lowercase()))
      .then(a.track_number.unwrap_or(u32::MAX).cmp(&b.track_number.unwrap_or(u32::MAX)))
      .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
  });

  ScanResult {
    folders,
    tracks,
    skipped,
  }
}

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

fn is_supported_audio(path: &Path) -> bool {
  let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
    return false;
  };

  matches!(
    extension.to_lowercase().as_str(),
    "mp3" | "flac" | "m4a" | "aac" | "wav" | "ogg"
  )
}

fn embedded_lyrics(path: &Path) -> Option<String> {
  let tagged_file = read_from_path(path).ok()?;
  tagged_file
    .tags()
    .iter()
    .find_map(|tag| tag.get_string(&ItemKey::Lyrics))
    .map(str::trim)
    .filter(|content| !content.is_empty())
    .map(str::to_string)
}

fn find_sidecar_lyrics(track_path: &Path) -> Option<PathBuf> {
  let parent = track_path.parent()?;
  let track_stem = track_path.file_stem()?.to_string_lossy();
  let mut candidates = parent
    .read_dir()
    .ok()?
    .filter_map(Result::ok)
    .map(|entry| entry.path())
    .filter(|path| path.is_file())
    .filter(|path| {
      path
        .file_stem()
        .map(|stem| stem.to_string_lossy().eq_ignore_ascii_case(&track_stem))
        .unwrap_or(false)
    })
    .filter(|path| lyrics_extension_priority(path).is_some())
    .collect::<Vec<_>>();

  candidates.sort_by(|left, right| {
    lyrics_extension_priority(left)
      .cmp(&lyrics_extension_priority(right))
      .then_with(|| left.to_string_lossy().to_lowercase().cmp(&right.to_string_lossy().to_lowercase()))
  });
  candidates.into_iter().next()
}

fn lyrics_extension_priority(path: &Path) -> Option<u8> {
  match path.extension()?.to_string_lossy().to_lowercase().as_str() {
    "ttml" => Some(0),
    "lrc" => Some(1),
    "txt" => Some(2),
    _ => None,
  }
}

fn read_lyrics_source(path: &Path, origin: &str, is_manual: bool) -> Result<LocalLyricsSource, String> {
  if !path.is_file() || lyrics_extension_priority(path).is_none() {
    return Err("歌词文件不存在或格式不受支持".to_string());
  }

  let content = decode_lyrics_file(path)?;
  if content.trim().is_empty() {
    return Err("歌词文件为空".to_string());
  }

  let file_name = path
    .file_name()
    .map(|value| value.to_string_lossy().to_string())
    .unwrap_or_else(|| "本地歌词".to_string());
  let format_hint = infer_lyrics_format(&content, path.extension().and_then(|value| value.to_str()));

  Ok(LocalLyricsSource {
    source_id: format!("{origin}:{}", path.to_string_lossy()),
    origin: origin.to_string(),
    format_hint: format_hint.to_string(),
    label: file_name,
    content,
    path: Some(path.to_string_lossy().to_string()),
    modified_at: file_modified_at(path),
    is_manual,
  })
}

fn infer_lyrics_format(content: &str, extension: Option<&str>) -> &'static str {
  if let Some(extension) = extension {
    if extension.eq_ignore_ascii_case("ttml") {
      return "ttml";
    }
    if extension.eq_ignore_ascii_case("lrc") {
      return "lrc";
    }
  }

  if content.trim_start().starts_with('<') && content.to_lowercase().contains("<tt") {
    "ttml"
  } else if content.lines().any(|line| {
    let trimmed = line.trim_start();
    trimmed.starts_with('[') && trimmed.contains(':') && trimmed.contains(']')
  }) {
    "lrc"
  } else {
    "plain"
  }
}

fn decode_lyrics_file(path: &Path) -> Result<String, String> {
  let bytes = fs::read(path).map_err(|_| "无法读取歌词文件".to_string())?;
  if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
    return String::from_utf8(bytes[3..].to_vec()).map_err(|_| "歌词文件编码无效".to_string());
  }
  if bytes.starts_with(&[0xff, 0xfe]) {
    return decode_utf16(&bytes[2..], true);
  }
  if bytes.starts_with(&[0xfe, 0xff]) {
    return decode_utf16(&bytes[2..], false);
  }
  if let Ok(content) = String::from_utf8(bytes.clone()) {
    return Ok(content);
  }

  let (decoded, _, had_errors) = GBK.decode(&bytes);
  if had_errors {
    Err("歌词文件编码不受支持".to_string())
  } else {
    Ok(decoded.into_owned())
  }
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<String, String> {
  if bytes.len() % 2 != 0 {
    return Err("歌词文件编码无效".to_string());
  }
  let units = bytes.chunks_exact(2).map(|chunk| {
    if little_endian {
      u16::from_le_bytes([chunk[0], chunk[1]])
    } else {
      u16::from_be_bytes([chunk[0], chunk[1]])
    }
  });
  std::char::decode_utf16(units)
    .collect::<Result<String, _>>()
    .map_err(|_| "歌词文件编码无效".to_string())
}

fn file_modified_at(path: &Path) -> Option<u64> {
  fs::metadata(path)
    .ok()?
    .modified()
    .ok()?
    .duration_since(UNIX_EPOCH)
    .ok()
    .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn track_from_path(path: &Path) -> Track {
  let tagged_file = read_from_path(path).ok();
  let primary_tag = tagged_file.as_ref().and_then(|file| file.primary_tag().or_else(|| file.first_tag()));
  let file_stem = path
    .file_stem()
    .and_then(|value| value.to_str())
    .unwrap_or("Untitled")
    .trim();
  let file_name = path
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or(file_stem)
    .to_string();
  let extension = path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or("")
    .to_lowercase();
  let (fallback_artist, fallback_title) = split_artist_title(file_stem);
  let title = primary_tag
    .and_then(|tag| tag.title())
    .map(|value| fallback_text(&value, &fallback_title))
    .unwrap_or(fallback_title);
  let artist = primary_tag
    .and_then(|tag| tag.artist())
    .map(|value| fallback_text(&value, &fallback_artist))
    .unwrap_or(fallback_artist);
  let album = primary_tag
    .and_then(|tag| tag.album())
    .map(|value| fallback_text(&value, "Unknown album"))
    .unwrap_or_else(|| {
      path
        .parent()
        .and_then(|value| value.file_name())
        .and_then(|value| value.to_str())
        .unwrap_or("Unknown album")
        .to_string()
    });
  let album_artist = primary_tag
    .and_then(|tag| tag.get_string(&ItemKey::AlbumArtist))
    .map(|value| fallback_text(value, &artist))
    .unwrap_or_else(|| artist.clone());
  let track_number = primary_tag.and_then(|tag| tag.track());
  let disc_number = primary_tag.and_then(|tag| tag.disk());
  let year = primary_tag.and_then(|tag| tag.year());
  let genres = primary_tag
    .and_then(|tag| tag.genre())
    .map(|value| split_genres(&fallback_text(&value, "")))
    .unwrap_or_default();
  let duration_seconds = tagged_file
    .as_ref()
    .map(|file| file.properties().duration().as_secs())
    .filter(|duration| *duration > 0);
  let added_at = fs::metadata(path)
    .ok()
    .and_then(|metadata| metadata.created().or_else(|_| metadata.modified()).ok())
    .and_then(|timestamp| timestamp.duration_since(UNIX_EPOCH).ok())
    .and_then(|duration| u64::try_from(duration.as_millis()).ok());
  let cover_path = embedded_cover_path(path, primary_tag).or_else(|| folder_cover_path(path));

  Track {
    id: stable_track_id(path),
    path: path.to_string_lossy().to_string(),
    file_name,
    title,
    artist,
    album,
    album_artist,
    track_number,
    disc_number,
    year,
    genres,
    duration_seconds,
    added_at,
    extension,
    cover_path,
  }
}

fn split_genres(value: &str) -> Vec<String> {
  let mut genres = Vec::new();
  for part in value.split([';', ',', '|', '\0']) {
    let genre = part.trim();
    if genre.is_empty() || genres.iter().any(|item: &String| item.eq_ignore_ascii_case(genre)) {
      continue;
    }
    genres.push(genre.to_string());
  }
  genres
}

fn folder_cover_path(path: &Path) -> Option<String> {
  const COVER_NAMES: [&str; 8] = [
    "cover.jpg",
    "cover.jpeg",
    "cover.png",
    "folder.jpg",
    "folder.jpeg",
    "folder.png",
    "album.jpg",
    "album.png",
  ];

  let parent = path.parent()?;
  for name in COVER_NAMES {
    let candidate = parent.join(name);
    if candidate.exists() {
      return Some(candidate.to_string_lossy().to_string());
    }
  }

  None
}

fn embedded_cover_path(path: &Path, tag: Option<&lofty::tag::Tag>) -> Option<String> {
  let picture = tag?.pictures().first()?;
  let data = picture.data();
  if data.is_empty() {
    return None;
  }

  let extension = image_extension(data)?;
  let cache_dir = cover_cache_dir()?;
  fs::create_dir_all(&cache_dir).ok()?;
  let cover_path = cache_dir.join(format!("{}.{}", stable_track_id(path), extension));

  if !cover_path.exists() {
    fs::write(&cover_path, data).ok()?;
  }

  Some(cover_path.to_string_lossy().to_string())
}

fn image_extension(data: &[u8]) -> Option<&'static str> {
  if data.starts_with(&[0xff, 0xd8, 0xff]) {
    return Some("jpg");
  }

  if data.starts_with(&[0x89, b'P', b'N', b'G']) {
    return Some("png");
  }

  if data.starts_with(b"GIF8") {
    return Some("gif");
  }

  if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
    return Some("webp");
  }

  None
}

fn cover_cache_dir() -> Option<PathBuf> {
  std::env::var_os("LOCALAPPDATA")
    .map(PathBuf::from)
    .map(|path| path.join("Zone").join("covers"))
}

fn split_artist_title(file_stem: &str) -> (String, String) {
  let cleaned = file_stem
    .trim_start_matches(|character: char| character.is_ascii_digit() || character == '.' || character == '-' || character == '_' || character == ' ')
    .trim();

  if let Some((artist, title)) = cleaned.split_once(" - ") {
    return (fallback_text(artist, "Unknown artist"), fallback_text(title, cleaned));
  }

  ("Unknown artist".to_string(), fallback_text(cleaned, "Untitled"))
}

fn fallback_text(value: &str, fallback: &str) -> String {
  let repaired = repair_mojibake(value);
  let trimmed = repaired.trim();
  if trimmed.is_empty() {
    fallback.to_string()
  } else {
    trimmed.to_string()
  }
}

fn repair_mojibake(value: &str) -> String {
  let trimmed = value.trim();
  if !looks_like_gbk_mojibake(trimmed) {
    return trimmed.to_string();
  }

  let mut bytes = Vec::with_capacity(trimmed.len());
  for character in trimmed.chars() {
    let codepoint = character as u32;
    if codepoint > 0xff {
      return trimmed.to_string();
    }
    bytes.push(codepoint as u8);
  }

  let (decoded, _, had_errors) = GBK.decode(&bytes);
  if had_errors {
    return trimmed.to_string();
  }

  let decoded = decoded.trim();
  if text_quality(decoded) > text_quality(trimmed) {
    decoded.to_string()
  } else {
    trimmed.to_string()
  }
}

fn looks_like_gbk_mojibake(value: &str) -> bool {
  let mut suspicious = 0;
  let mut high_latin = 0;

  for character in value.chars() {
    let codepoint = character as u32;
    if (0x00c0..=0x00ff).contains(&codepoint) {
      high_latin += 1;
    }
    // GBK lead bytes 0xb0-0xbf surface as Latin-1 symbols (° ± ² ³ ´ µ ¶ · ¸ ¹ º » ¼ ½ ¾ ¿),
    // which almost never appear in genuine titles.
    if (0x00b0..=0x00bf).contains(&codepoint)
      || matches!(character, 'Ä' | 'Å' | 'Æ' | 'Ç' | 'È' | 'É' | 'Ê' | 'Ë' | 'Ì' | 'Í' | 'Î' | 'Ï' | 'Ð' | 'Ñ' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | '×' | 'Ø' | 'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ý' | 'Þ' | 'ß' | 'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'æ' | 'ç' | 'è' | 'é' | 'ê' | 'ë' | 'ì' | 'í' | 'î' | 'ï' | 'ð' | 'ñ' | 'ò' | 'ó' | 'ô' | 'õ' | 'ö' | '÷' | 'ø' | 'ù' | 'ú' | 'û' | 'ü') {
      suspicious += 1;
    }
  }

  suspicious >= 2 || high_latin >= 3
}

fn text_quality(value: &str) -> i32 {
  let mut score = 0;
  for character in value.chars() {
    if ('\u{4e00}'..='\u{9fff}').contains(&character) {
      score += 4;
    } else if character.is_ascii_alphanumeric() {
      score += 1;
    } else if (character as u32) >= 0x00c0 && (character as u32) <= 0x00ff {
      score -= 2;
    }
  }
  score
}

fn stable_track_id(path: &Path) -> String {
  path.to_string_lossy()
    .bytes()
    .fold(0xcbf29ce484222325u64, |hash, byte| {
      (hash ^ byte as u64).wrapping_mul(0x100000001b3)
    })
    .to_string()
}

fn audio_content_type(path: &Path) -> &'static str {
  match path.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase().as_str() {
    "mp3" => "audio/mpeg",
    "flac" => "audio/flac",
    "m4a" => "audio/mp4",
    "aac" => "audio/aac",
    "wav" => "audio/wav",
    "ogg" => "audio/ogg",
    _ => "application/octet-stream",
  }
}

fn serve_audio_protocol(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
  if request.method() == Method::OPTIONS {
    return response_builder(StatusCode::NO_CONTENT, "text/plain", 0)
      .body(Vec::new())
      .unwrap();
  }

  let Some(path) = protocol_path_to_file_path(request.uri().path()) else {
    return text_response(StatusCode::BAD_REQUEST, "invalid audio path");
  };

  if !path.exists() || !path.is_file() || !is_supported_audio(&path) {
    return text_response(StatusCode::NOT_FOUND, "audio file not found");
  }

  let Ok(metadata) = fs::metadata(&path) else {
    return text_response(StatusCode::NOT_FOUND, "audio file not found");
  };

  let file_len = metadata.len();
  let content_type = audio_content_type(&path);
  let requested_range = match request.headers().get(header::RANGE) {
    Some(value) => match value
      .to_str()
      .ok()
      .and_then(|value| parse_range_header(value, file_len))
    {
      Some(range) => Some(range),
      None => return range_not_satisfiable_response(content_type, file_len),
    },
    None => None,
  };

  if file_len == 0 {
    return response_builder(StatusCode::OK, content_type, 0)
      .body(Vec::new())
      .unwrap();
  }

  let (start, requested_end) = requested_range.unwrap_or((0, file_len - 1));
  let end = capped_range_end(start, requested_end);
  let is_partial = requested_range.is_some() || end < file_len - 1;

  if start > end || end >= file_len {
    return range_not_satisfiable_response(content_type, file_len);
  };

  let length = end.saturating_sub(start).saturating_add(1);
  let Ok(mut file) = fs::File::open(&path) else {
    return text_response(StatusCode::NOT_FOUND, "audio file not found");
  };

  if file.seek(SeekFrom::Start(start)).is_err() {
    return text_response(StatusCode::RANGE_NOT_SATISFIABLE, "invalid range");
  }

  let mut body = vec![0; length as usize];
  if file.read_exact(&mut body).is_err() {
    return text_response(StatusCode::INTERNAL_SERVER_ERROR, "failed to read audio");
  }

  let mut builder = response_builder(
    if is_partial {
      StatusCode::PARTIAL_CONTENT
    } else {
      StatusCode::OK
    },
    content_type,
    body.len() as u64,
  );

  if is_partial {
    builder = builder.header(
      header::CONTENT_RANGE,
      format!("bytes {start}-{end}/{file_len}"),
    );
  }

  builder.body(body).unwrap()
}

fn capped_range_end(start: u64, requested_end: u64) -> u64 {
  start
    + requested_end
      .saturating_sub(start)
      .min(AUDIO_RANGE_CHUNK_SIZE - 1)
}

fn response_builder(status: StatusCode, content_type: &str, content_length: u64) -> tauri::http::response::Builder {
  Response::builder()
    .status(status)
    .header(header::CONTENT_TYPE, content_type)
    .header(header::CONTENT_LENGTH, content_length.to_string())
    .header(header::ACCEPT_RANGES, "bytes")
    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
    .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range, Content-Type")
    .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Length, Content-Range, Accept-Ranges")
}

fn text_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
  response_builder(status, "text/plain; charset=utf-8", message.len() as u64)
    .body(message.as_bytes().to_vec())
    .unwrap()
}

fn range_not_satisfiable_response(content_type: &str, file_len: u64) -> Response<Vec<u8>> {
  response_builder(StatusCode::RANGE_NOT_SATISFIABLE, content_type, 0)
    .header(header::CONTENT_RANGE, format!("bytes */{file_len}"))
    .body(Vec::new())
    .unwrap()
}

fn protocol_path_to_file_path(path: &str) -> Option<PathBuf> {
  let decoded = percent_decode(path.trim_start_matches('/'))?;
  if decoded.is_empty() {
    return None;
  }

  #[cfg(windows)]
  {
    Some(PathBuf::from(decoded.replace('/', "\\")))
  }

  #[cfg(not(windows))]
  {
    Some(PathBuf::from(format!("/{decoded}")))
  }
}

fn parse_range_header(value: &str, file_len: u64) -> Option<(u64, u64)> {
  if file_len == 0 {
    return None;
  }

  let range = value.strip_prefix("bytes=")?;
  let (start_text, end_text) = range.split_once('-')?;

  if start_text.is_empty() {
    let suffix_len = end_text.parse::<u64>().ok()?.min(file_len);
    if suffix_len == 0 {
      return None;
    }

    return Some((file_len - suffix_len, file_len - 1));
  }

  let start = start_text.parse::<u64>().ok()?;
  let end = if end_text.is_empty() {
    file_len - 1
  } else {
    end_text.parse::<u64>().ok()?.min(file_len - 1)
  };

  if start > end || start >= file_len {
    None
  } else {
    Some((start, end))
  }
}

fn percent_decode(value: &str) -> Option<String> {
  let bytes = value.as_bytes();
  let mut decoded = Vec::with_capacity(bytes.len());
  let mut index = 0;

  while index < bytes.len() {
    if bytes[index] == b'%' {
      let high = bytes.get(index + 1).and_then(|byte| hex_value(*byte))?;
      let low = bytes.get(index + 2).and_then(|byte| hex_value(*byte))?;
      decoded.push((high << 4) | low);
      index += 3;
    } else {
      decoded.push(bytes[index]);
      index += 1;
    }
  }

  String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
  match byte {
    b'0'..=b'9' => Some(byte - b'0'),
    b'a'..=b'f' => Some(byte - b'a' + 10),
    b'A'..=b'F' => Some(byte - b'A' + 10),
    _ => None,
  }
}

#[cfg(test)]
mod lyrics_tests {
  use super::*;
  use std::time::SystemTime;

  fn test_directory(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    let directory = std::env::temp_dir().join(format!(
      "zone-lyrics-{name}-{}-{stamp}",
      std::process::id(),
    ));
    fs::create_dir_all(&directory).expect("create test directory");
    directory
  }

  #[test]
  fn sidecar_discovery_is_case_insensitive_and_prefers_ttml() {
    let directory = test_directory("priority");
    let audio = directory.join("Track.mp3");
    fs::write(&audio, []).expect("audio placeholder");
    fs::write(directory.join("track.txt"), "plain").expect("plain lyrics");
    fs::write(directory.join("TRACK.LRC"), "[00:01.00]line").expect("lrc lyrics");
    let ttml = directory.join("Track.ttml");
    fs::write(&ttml, "<tt></tt>").expect("ttml lyrics");

    assert_eq!(find_sidecar_lyrics(&audio), Some(ttml));
    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn lyric_reader_decodes_utf16_bom() {
    let directory = test_directory("utf16");
    let path = directory.join("Track.lrc");
    let mut bytes = vec![0xff, 0xfe];
    for unit in "[00:01.00]夜色".encode_utf16() {
      bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(&path, bytes).expect("write utf16 lyrics");

    assert_eq!(decode_lyrics_file(&path).expect("decode lyrics"), "[00:01.00]夜色");
    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn explicit_binding_is_marked_as_manual() {
    let directory = test_directory("manual");
    let path = directory.join("picked.txt");
    fs::write(&path, "first line\nsecond line").expect("write lyrics");

    let source = read_lyrics_source(&path, "manual", true).expect("read source");
    assert_eq!(source.origin, "manual");
    assert!(source.is_manual);
    assert_eq!(source.format_hint, "plain");
    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn mojibake_repairs_gbk_tags_with_symbol_bytes() {
    assert_eq!(repair_mojibake("ºì¶¹"), "红豆");
    assert_eq!(repair_mojibake("Íõ·Æ"), "王菲");
  }

  #[test]
  fn mojibake_leaves_genuine_latin_text_alone() {
    assert_eq!(repair_mojibake("Café del Mar"), "Café del Mar");
    assert_eq!(repair_mojibake("Eyes On Me"), "Eyes On Me");
  }

  #[test]
  fn provider_request_only_allows_registered_https_endpoints() {
    assert!(validate_lyrics_provider_url(
      "lrclib",
      "https://lrclib.net/api/search?track_name=Night"
    )
    .is_ok());
    assert!(validate_lyrics_provider_url("lrclib", "http://lrclib.net/api/search").is_err());
    assert!(validate_lyrics_provider_url("lrclib", "https://example.com/api/search").is_err());
    assert!(validate_lyrics_provider_url("lrclib", "https://lrclib.net.evil.test/api/search").is_err());
    assert!(validate_lyrics_provider_url(
      "netease",
      "https://music.163.com/api/search/get/web?csrf_token=&s=21+Guns+Green+Day&type=1&limit=8&offset=0&total=true"
    )
    .is_ok());
    assert!(validate_lyrics_provider_url(
      "netease",
      "https://music.163.com/api/song/lyric?id=32194502&lv=-1&tv=-1&rv=-1&kv=-1"
    )
    .is_ok());
    assert!(validate_lyrics_provider_url(
      "netease",
      "http://music.163.com/api/song/lyric?id=32194502&lv=-1&tv=-1&rv=-1&kv=-1"
    )
    .is_err());
    assert!(validate_lyrics_provider_url(
      "netease",
      "https://music.163.com/api/song/lyric?id=32194502&lv=-1&tv=-1&rv=-1&kv=-1&redirect=true"
    )
    .is_err());
    assert!(validate_lyrics_provider_url(
      "netease",
      "https://example.com/api/song/lyric?id=32194502&lv=-1&tv=-1&rv=-1&kv=-1"
    )
    .is_err());
    assert!(validate_lyrics_provider_url(
      "amll-ttml-db",
      "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/metadata/raw-lyrics-index.jsonl"
    )
    .is_ok());
    assert!(validate_lyrics_provider_url(
      "amll-ttml-db",
      "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/raw-lyrics/1689089845000-39523898-31c2fa0c.ttml"
    )
    .is_ok());
    assert!(validate_lyrics_provider_url(
      "amll-ttml-db",
      "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/raw-lyrics/unsafe.json"
    )
    .is_err());
    assert!(validate_lyrics_provider_url(
      "amll-ttml-db",
      "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/raw-lyrics/%2e%2e%2funsafe.ttml"
    )
    .is_err());
    assert!(validate_lyrics_provider_url(
      "amll-ttml-db",
      "https://example.com/amll-dev/amll-ttml-db/refs/heads/main/raw-lyrics/test.ttml"
    )
    .is_err());
    assert!(validate_lyrics_provider_url(
      "qq",
      "https://u.y.qq.com/cgi-bin/musicu.fcg"
    )
    .is_ok());
    assert!(validate_lyrics_provider_url(
      "qq",
      "https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg"
    )
    .is_ok());
    assert!(validate_lyrics_provider_url(
      "qq",
      "https://u.y.qq.com/cgi-bin/musicu.fcg?redirect=true"
    )
    .is_err());
    assert!(validate_lyrics_provider_url(
      "qq",
      "https://y.qq.com/cgi-bin/musicu.fcg"
    )
    .is_err());
    assert!(validate_lyrics_provider_url("unknown", "https://lrclib.net/api/search").is_err());
  }

  #[test]
  fn qq_provider_only_accepts_expected_post_bodies() {
    let search_url = validate_lyrics_provider_url(
      "qq",
      "https://u.y.qq.com/cgi-bin/musicu.fcg"
    )
    .expect("valid QQ search URL");
    let lyric_url = validate_lyrics_provider_url(
      "qq",
      "https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg"
    )
    .expect("valid QQ lyric URL");
    let search_body = r#"{"req_1":{"method":"DoSearchForQQMusicDesktop","module":"music.search.SearchCgiService","param":{"num_per_page":"20","page_num":"1","query":"21 Guns Green Day","search_type":0}}}"#;
    assert!(validate_lyrics_provider_request_body(
      "qq",
      &search_url,
      Some(search_body.to_string())
    )
    .is_ok());
    assert!(validate_lyrics_provider_request_body(
      "qq",
      &search_url,
      Some(search_body.replace("21 Guns Green Day", ""))
    )
    .is_err());
    assert!(validate_lyrics_provider_request_body(
      "qq",
      &lyric_url,
      Some("version=15&miniversion=82&lrctype=4&musicid=902359".to_string())
    )
    .is_ok());
    assert!(validate_lyrics_provider_request_body(
      "qq",
      &lyric_url,
      Some("version=15&miniversion=82&lrctype=4&musicid=902359&redirect=true".to_string())
    )
    .is_err());
    assert!(validate_lyrics_provider_request_body("qq", &lyric_url, None).is_err());
  }

  #[test]
  fn qrc_decrypter_rejects_untrusted_shapes_before_decryption() {
    assert!(decrypt_qrc_lyrics("not-hex".to_string()).is_err());
    assert!(decrypt_qrc_lyrics("00".repeat(QRC_ENCRYPTED_TEXT_LIMIT)).is_err());
  }

  #[test]
  fn provider_response_limit_only_expands_for_the_amll_index() {
    let index = validate_lyrics_provider_url(
      "amll-ttml-db",
      "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/metadata/raw-lyrics-index.jsonl"
    )
    .expect("valid AMLL index");
    let lyric = validate_lyrics_provider_url(
      "amll-ttml-db",
      "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/raw-lyrics/test.ttml"
    )
    .expect("valid AMLL lyric");
    assert_eq!(lyrics_provider_response_limit("amll-ttml-db", &index), AMLL_INDEX_RESPONSE_LIMIT);
    assert_eq!(lyrics_provider_response_limit("amll-ttml-db", &lyric), LYRICS_PROVIDER_RESPONSE_LIMIT);
  }

  #[test]
  fn provider_request_retries_only_transient_gateway_failures() {
    assert!(is_retryable_provider_status(reqwest::StatusCode::BAD_GATEWAY));
    assert!(is_retryable_provider_status(reqwest::StatusCode::SERVICE_UNAVAILABLE));
    assert!(is_retryable_provider_status(reqwest::StatusCode::GATEWAY_TIMEOUT));
    assert!(!is_retryable_provider_status(reqwest::StatusCode::BAD_REQUEST));
    assert!(!is_retryable_provider_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
  }
}

pub fn run() {
  #[cfg(target_os = "windows")]
  if let Err(error) = system_media::set_process_app_id() {
    eprintln!("Unable to set the Windows AppUserModelID: {error}");
  }

  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .register_uri_scheme_protocol("zone-audio", |_ctx, request| serve_audio_protocol(request))
    .setup(|app| {
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
      select_music_folder,
      select_lyrics_file,
      scan_library,
      load_local_lyrics,
      request_lyrics_provider,
      decrypt_qrc_lyrics,
      update_system_media,
      update_system_media_timeline,
    ])
    .run(tauri::generate_context!())
    .expect("error while running Zone");
}
