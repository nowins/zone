use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::header::{self, HeaderMap};
use reqwest::{StatusCode, Url};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::http::{Method, Request, Response};
use super::*;

// Custom protocol responses bypass the WebView HTTP cache, so the response
// Cache-Control header alone does not prevent repeat upstream fetches when
// lists remount. This small in-process LRU absorbs exactly that repeat traffic.
pub(crate) const PODCAST_ARTWORK_CACHE_MAX_ENTRIES: usize = 128;
pub(crate) const PODCAST_ARTWORK_CACHE_MAX_BYTES: usize = 48 * 1024 * 1024;
pub(crate) const PODCAST_ARTWORK_CACHE_ENTRY_LIMIT: usize = 2 * 1024 * 1024;

struct PodcastArtworkCacheEntry {
  content_type: String,
  bytes: Vec<u8>,
}

struct PodcastArtworkCache {
  entries: HashMap<String, PodcastArtworkCacheEntry>,
  order: VecDeque<String>,
  total_bytes: usize,
  max_entries: usize,
  max_bytes: usize,
}

impl Default for PodcastArtworkCache {
  fn default() -> Self {
    Self {
      entries: HashMap::new(),
      order: VecDeque::new(),
      total_bytes: 0,
      max_entries: PODCAST_ARTWORK_CACHE_MAX_ENTRIES,
      max_bytes: PODCAST_ARTWORK_CACHE_MAX_BYTES,
    }
  }
}

impl PodcastArtworkCache {
  fn get(&mut self, key: &str) -> Option<(String, Vec<u8>)> {
    let entry = self.entries.get(key)?;
    let value = (entry.content_type.clone(), entry.bytes.clone());
    if let Some(position) = self.order.iter().position(|candidate| candidate == key) {
      let touched = self.order.remove(position);
      self.order.extend(touched);
    }
    Some(value)
  }

  fn insert(&mut self, key: String, content_type: String, bytes: Vec<u8>) {
    if bytes.len() > PODCAST_ARTWORK_CACHE_ENTRY_LIMIT {
      return;
    }
    if let Some(previous) = self.entries.remove(&key) {
      self.total_bytes = self.total_bytes.saturating_sub(previous.bytes.len());
      if let Some(position) = self.order.iter().position(|candidate| candidate == &key) {
        self.order.remove(position);
      }
    }
    self.total_bytes += bytes.len();
    self.order.push_back(key.clone());
    self.entries.insert(
      key,
      PodcastArtworkCacheEntry { content_type, bytes },
    );
    while self.order.len() > self.max_entries
      || self.total_bytes > self.max_bytes
    {
      let Some(oldest) = self.order.pop_front() else {
        break;
      };
      if let Some(removed) = self.entries.remove(&oldest) {
        self.total_bytes = self.total_bytes.saturating_sub(removed.bytes.len());
      }
    }
  }
}

static PODCAST_ARTWORK_CACHE: OnceLock<Mutex<PodcastArtworkCache>> = OnceLock::new();

fn podcast_artwork_cache() -> &'static Mutex<PodcastArtworkCache> {
  PODCAST_ARTWORK_CACHE.get_or_init(|| Mutex::new(PodcastArtworkCache::default()))
}

fn cached_podcast_artwork(key: &str) -> Option<(String, Vec<u8>)> {
  podcast_artwork_cache().lock().ok()?.get(key)
}

fn remember_podcast_artwork(key: String, content_type: &str, bytes: &[u8]) {
  if let Ok(mut cache) = podcast_artwork_cache().lock() {
    cache.insert(key, content_type.to_string(), bytes.to_vec());
  }
}

struct FetchedPodcastArtwork {
  content_type: String,
  bytes: Vec<u8>,
}

fn podcast_artwork_cache_key(url: &Url, allow_private_network: bool) -> String {
  format!("{}|{url}", u8::from(allow_private_network))
}

fn podcast_artwork_extension(content_type: &str) -> Option<&'static str> {
  match content_type {
    "image/jpeg" => Some("jpg"),
    "image/png" => Some("png"),
    "image/gif" => Some("gif"),
    "image/webp" => Some("webp"),
    _ => None,
  }
}

fn podcast_artwork_file_stem(url: &str) -> String {
  hash_identifier("podcast-artwork", &[url])
}

fn existing_podcast_artwork_file(cache_dir: &Path, url: &str) -> Option<PathBuf> {
  let stem = podcast_artwork_file_stem(url);
  let entries = fs::read_dir(cache_dir).ok()?;
  entries.filter_map(|entry| entry.ok()).map(|entry| entry.path()).find(|path| {
    path.file_stem().and_then(|value| value.to_str()) == Some(stem.as_str())
      && matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("jpg" | "png" | "gif" | "webp")
      )
  })
}

fn write_podcast_artwork_file(
  cache_dir: &Path,
  url: &str,
  content_type: &str,
  bytes: &[u8],
) -> Result<PathBuf, String> {
  let extension = podcast_artwork_extension(content_type)
    .ok_or_else(|| "播客封面来源返回了不支持的图片类型".to_string())?;
  fs::create_dir_all(cache_dir).map_err(|error| format!("无法创建播客封面缓存目录：{error}"))?;
  let path = cache_dir.join(format!("{}.{extension}", podcast_artwork_file_stem(url)));
  if path.exists() {
    return Ok(path);
  }
  let temp_path = cache_dir.join(format!("{}.{extension}.part", podcast_artwork_file_stem(url)));
  fs::write(&temp_path, bytes).map_err(|error| format!("无法写入播客封面缓存：{error}"))?;
  if let Err(error) = fs::rename(&temp_path, &path) {
    let _ = fs::remove_file(&temp_path);
    return Err(format!("无法保存播客封面缓存：{error}"));
  }
  Ok(path)
}

async fn fetch_podcast_artwork_bytes(
  url: Url,
  allow_private_network: bool,
) -> Result<FetchedPodcastArtwork, String> {
  with_network_retries(PODCAST_ARTWORK_TIMEOUT, || fetch_podcast_artwork_bytes_once(url.clone(), allow_private_network)).await
}

async fn fetch_podcast_artwork_bytes_once(url: Url, allow_private_network: bool) -> Result<FetchedPodcastArtwork, String> {
  let cache_key = podcast_artwork_cache_key(&url, allow_private_network);
  if let Some((content_type, bytes)) = cached_podcast_artwork(&cache_key) {
    return Ok(FetchedPodcastArtwork { content_type, bytes });
  }
  let public_response = send_public_get_with_policy(
    url,
    PODCAST_ARTWORK_TIMEOUT,
    None,
    allow_private_network,
  )
  .await?;
  let content_type = podcast_artwork_content_type(public_response.response.headers())?;
  let bytes = read_limited(
    public_response.response,
    PODCAST_ARTWORK_RESPONSE_LIMIT,
    "播客封面",
  )
  .await?;
  if !podcast_artwork_magic_matches(&content_type, &bytes) {
    return Err("播客封面内容格式无效".to_string());
  }
  remember_podcast_artwork(cache_key, &content_type, &bytes);
  Ok(FetchedPodcastArtwork { content_type, bytes })
}

pub(crate) async fn cache_podcast_artwork_file(
  cache_dir: PathBuf,
  artwork_url: String,
  allow_private_network: bool,
) -> Result<Option<String>, String> {
  let url_value = artwork_url.trim();
  if url_value.is_empty() {
    return Ok(None);
  }
  let url = validate_url_shape_with_policy(url_value, allow_private_network)?;
  let cache_name = url.as_str().to_string();
  if let Some(path) = existing_podcast_artwork_file(&cache_dir, &cache_name) {
    return Ok(Some(path.to_string_lossy().to_string()));
  }
  let fetched = fetch_podcast_artwork_bytes(url, allow_private_network).await?;
  let path = write_podcast_artwork_file(&cache_dir, &cache_name, &fetched.content_type, &fetched.bytes)?;
  Ok(Some(path.to_string_lossy().to_string()))
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
  let fetched = match fetch_podcast_artwork_bytes(url, allow_private_network).await {
    Ok(fetched) => fetched,
    Err(error) => return podcast_artwork_text_response(StatusCode::BAD_GATEWAY, &error),
  };
  let content_type = fetched.content_type;
  let bytes = fetched.bytes;
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

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  use tokio::io::AsyncReadExt;
  use tokio::io::AsyncWriteExt;
  use tokio::net::TcpListener;

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

  #[test]
  fn podcast_artwork_cache_evicts_by_lru_order_and_size_limits() {
    let mut cache = PodcastArtworkCache {
      max_entries: 4,
      ..PodcastArtworkCache::default()
    };
    assert!(cache.get("missing").is_none());

    cache.insert("a".to_string(), "image/png".to_string(), vec![1u8; 16]);
    cache.insert("b".to_string(), "image/jpeg".to_string(), vec![2u8; 16]);
    let hit = cache.get("a").expect("cached entry");
    assert_eq!(hit.0, "image/png");
    assert_eq!(hit.1, vec![1u8; 16]);

    // "a" was just touched, so "b" is the oldest and must be evicted first.
    for index in 0..3 {
      cache.insert(format!("fill-{index}"), "image/png".to_string(), vec![3u8; 8]);
    }
    assert!(cache.entries.len() <= 4);
    assert!(cache.get("b").is_none());
    assert!(cache.get("a").is_some());

    let chunk = 32usize;
    let mut byte_cache = PodcastArtworkCache {
      max_bytes: chunk * 2,
      ..PodcastArtworkCache::default()
    };
    byte_cache.insert("x".to_string(), "image/png".to_string(), vec![1u8; chunk]);
    byte_cache.insert("y".to_string(), "image/png".to_string(), vec![2u8; chunk]);
    byte_cache.insert("z".to_string(), "image/png".to_string(), vec![3u8; chunk]);
    assert!(byte_cache.total_bytes <= chunk * 2);
    assert_eq!(byte_cache.total_bytes, chunk * 2);
    assert!(byte_cache.get("x").is_none());

    let oversized = vec![0u8; PODCAST_ARTWORK_CACHE_ENTRY_LIMIT + 1];
    byte_cache.insert("huge".to_string(), "image/png".to_string(), oversized);
    assert!(byte_cache.get("huge").is_none());
  }

  #[tokio::test]
  async fn podcast_artwork_protocol_serves_repeats_from_cache() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind artwork server");
    let address = listener.local_addr().expect("artwork server address");
    let image = b"\x89PNG\r\n\x1a\nzone-artwork-cache".to_vec();
    let server_image = image.clone();
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.expect("accept single request");
      let mut request = vec![0u8; 8_192];
      let _ = stream.read(&mut request).await.expect("read request");
      let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        server_image.len(),
      );
      stream.write_all(headers.as_bytes()).await.expect("write headers");
      stream.write_all(&server_image).await.expect("write body");
      stream.shutdown().await.expect("shutdown response");
      // Listener drops here: any second upstream fetch would fail to connect.
    });
    let url = format!("http://{address}/cached-cover.png");

    let first = serve_podcast_artwork_protocol_with_network_policy(
      artwork_request(Method::GET, &url),
      true,
    )
    .await;
    server.await.expect("server task");
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.body(), &image);

    let second = serve_podcast_artwork_protocol_with_network_policy(
      artwork_request(Method::GET, &url),
      true,
    )
    .await;
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(second.body(), &image);

    let head = serve_podcast_artwork_protocol_with_network_policy(
      artwork_request(Method::HEAD, &url),
      true,
    )
    .await;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(
      head
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok()),
      Some(image.len().to_string().as_str()),
    );
    assert!(head.body().is_empty());
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

  #[tokio::test]
  async fn podcast_artwork_disk_cache_reuses_validated_files_and_skips_repeat_fetches() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind artwork server");
    let address = listener.local_addr().expect("artwork server address");
    let image = b"\x89PNG\r\n\x1a\nzone-artwork-disk".to_vec();
    let server_image = image.clone();
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.expect("accept single request");
      let mut request = vec![0u8; 8_192];
      let _ = stream.read(&mut request).await.expect("read request");
      let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        server_image.len(),
      );
      stream.write_all(headers.as_bytes()).await.expect("write headers");
      stream.write_all(&server_image).await.expect("write body");
      stream.shutdown().await.expect("shutdown response");
    });
    let directory = test_directory("artwork-disk-cache");
    let url = format!("http://{address}/disk-cover.png");
    let first = cache_podcast_artwork_file(directory.clone(), url.clone(), true)
      .await
      .expect("cache artwork")
      .expect("cached path");
    server.await.expect("server task");
    let first_path = PathBuf::from(&first);
    assert_eq!(first_path.extension().and_then(|value| value.to_str()), Some("png"));
    assert_eq!(fs::read(&first_path).expect("read cached artwork"), image);

    let second = cache_podcast_artwork_file(directory.clone(), url, true)
      .await
      .expect("reuse cached artwork")
      .expect("cached path");
    assert_eq!(second, first);

    let private = cache_podcast_artwork_file(
      directory.clone(),
      "http://127.0.0.1/router.png".to_string(),
      false,
    )
    .await;
    assert!(private.is_err());
    fs::remove_dir_all(directory).expect("cleanup test directory");
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
