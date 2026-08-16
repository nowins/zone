use reqwest::header::{self, HeaderMap};
use reqwest::{StatusCode, Url};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use super::*;

pub(crate) struct PublicResponse {
  pub(crate) final_url: Url,
  pub(crate) response: reqwest::Response,
}

// reqwest pools keep-alive connections per client. Streaming fetches a 1 MiB
// chunk per request, so a fresh client per call would pay DNS + TCP + TLS on
// every chunk and every seek. Clients are cached per validated address set:
// the DNS-pinning security model is unchanged because a client is only reused
// for the exact validated addresses it was built with.
#[derive(Clone, PartialEq, Eq, Hash)]
struct PodcastClientKey {
  host: String,
  addresses: Vec<SocketAddr>,
  allow_private_network: bool,
}

const PODCAST_CLIENT_CACHE_LIMIT: usize = 16;

static PODCAST_CLIENT_CACHE: OnceLock<Mutex<HashMap<PodcastClientKey, reqwest::Client>>> =
  OnceLock::new();

fn shared_public_client(
  host: &str,
  addresses: &[SocketAddr],
  allow_private_network: bool,
) -> Result<reqwest::Client, String> {
  let key = PodcastClientKey {
    host: host.to_string(),
    addresses: addresses.to_vec(),
    allow_private_network,
  };
  let cache = PODCAST_CLIENT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
  {
    let clients = cache
      .lock()
      .map_err(|_| "播客网络客户端缓存不可用".to_string())?;
    if let Some(client) = clients.get(&key) {
      return Ok(client.clone());
    }
  }
  // The overall timeout is applied per request, not on the shared client.
  let mut client_builder = reqwest::Client::builder()
    .user_agent(USER_AGENT)
    .connect_timeout(Duration::from_secs(10))
    .redirect(reqwest::redirect::Policy::none())
    .no_proxy();
  if host.parse::<IpAddr>().is_err() {
    client_builder = client_builder.resolve_to_addrs(host, addresses);
  }
  let client = client_builder
    .build()
    .map_err(|error| format!("无法初始化播客网络请求：{error}"))?;
  let mut clients = cache
    .lock()
    .map_err(|_| "播客网络客户端缓存不可用".to_string())?;
  if clients.len() >= PODCAST_CLIENT_CACHE_LIMIT {
    clients.clear();
  }
  Ok(clients.entry(key).or_insert(client).clone())
}

pub(crate) async fn send_public_get(url: Url, timeout: Duration, range: Option<&str>) -> Result<PublicResponse, String> {
  send_public_get_with_policy(url, timeout, range, false).await
}

pub(crate) async fn send_public_get_with_policy(
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

pub(crate) async fn send_public_get_with_headers(
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
    let client = shared_public_client(host, &addresses, allow_private_network)?;
    let mut request = client
      .get(url.clone())
      .header(header::ACCEPT, "*/*")
      .timeout(timeout);
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

pub(crate) fn validate_public_url_shape(value: &str) -> Result<Url, String> {
  validate_url_shape_with_policy(value, false)
}

pub(crate) fn validate_url_shape_with_policy(value: &str, allow_private_network: bool) -> Result<Url, String> {
  let url = Url::parse(value.trim()).map_err(|_| "播客来源地址无效".to_string())?;
  validate_url_with_policy(&url, allow_private_network)?;
  Ok(url)
}

pub(crate) fn validate_url_with_policy(url: &Url, allow_private_network: bool) -> Result<(), String> {
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

pub(crate) fn is_public_ip(ip: IpAddr) -> bool {
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
  // Reject ULA/link-local/site-local/multicast/documentation, plus well-known
  // translation prefixes (NAT64 64:ff9b::/96 and deprecated 64:ff9b:1::/48)
  // that can tunnel traffic toward private IPv4 space.
  !(ip.is_unspecified()
    || ip.is_loopback()
    || (segments[0] & 0xfe00) == 0xfc00
    || (segments[0] & 0xffc0) == 0xfe80
    || (segments[0] & 0xffc0) == 0xfec0
    || (segments[0] & 0xff00) == 0xff00
    || (segments[0] == 0x2001 && segments[1] == 0x0db8)
    || (segments[0] == 0x64 && segments[1] == 0xff9b)
    || (segments[0] == 0x64 && segments[1] == 0xff9b && segments[2] == 0x1))
}

pub(crate) async fn read_limited(mut response: reqwest::Response, limit: usize, label: &str) -> Result<Vec<u8>, String> {
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

pub(crate) fn header_text(headers: &HeaderMap, name: header::HeaderName) -> Option<String> {
  headers
    .get(name)
    .and_then(|value| value.to_str().ok())
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}
pub(crate) fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
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

pub(crate) fn response_content_type_is_audio_candidate(
  response_type: Option<&str>,
  enclosure_type: Option<&str>,
  enclosure_url: Option<&str>,
) -> bool {
  let candidate = first_nonempty_mime(response_type).or_else(|| first_nonempty_mime(enclosure_type));
  if let Some(candidate) = candidate {
    return is_audio_or_generic_binary_mime(candidate);
  }
  // No usable Content-Type / enclosure type: only accept URLs that look like
  // audio files so the stream proxy does not forward arbitrary opaque bytes.
  enclosure_url.is_some_and(enclosure_url_looks_like_audio)
}

fn first_nonempty_mime(value: Option<&str>) -> Option<&str> {
  value
    .map(str::trim)
    .filter(|value| !value.is_empty())
}

fn is_audio_or_generic_binary_mime(value: &str) -> bool {
  let candidate = value
    .split(';')
    .next()
    .unwrap_or_default()
    .trim()
    .to_ascii_lowercase();
  candidate.starts_with("audio/")
    || matches!(
      candidate.as_str(),
      "application/octet-stream" | "binary/octet-stream"
    )
}

fn enclosure_url_looks_like_audio(url: &str) -> bool {
  let path = url
    .split(['?', '#'])
    .next()
    .unwrap_or(url)
    .trim()
    .to_ascii_lowercase();
  let extension = path
    .rsplit('/')
    .next()
    .unwrap_or(path.as_str())
    .rsplit('.')
    .next()
    .filter(|value| value.len() >= 2 && value.len() <= 5)
    .unwrap_or("");
  matches!(
    extension,
    "mp3" | "m4a" | "aac" | "flac" | "ogg" | "wav" | "mp4" | "opus" | "m4b"
  )
}

pub(crate) fn audio_prefix_looks_like_audio(bytes: &[u8]) -> bool {
  if bytes.starts_with(b"ID3")
    || bytes.starts_with(b"fLaC")
    || bytes.starts_with(b"OggS")
    || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE"))
    || bytes.get(4..8) == Some(b"ftyp")
  {
    return true;
  }
  bytes
    .get(0..2)
    .is_some_and(|value| value[0] == 0xff && value[1] & 0xe0 == 0xe0 && value[1] & 0x06 != 0)
}

pub(crate) async fn detect_audio_extension(path: &Path) -> Result<&'static str, String> {
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

pub(crate) fn is_managed_download_path(downloads_dir: &Path, episode_id: &str, path: &Path) -> bool {
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

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  use tokio::io::AsyncWriteExt;
  use reqwest::header::HeaderValue;
  use tokio::net::TcpListener;

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
      "64:ff9b::192.0.2.1",
      "64:ff9b:1::1",
    ] {
      assert!(!is_public_ip(value.parse().expect("special IP")), "{value}");
    }
    assert!(is_fake_ip_proxy_address("198.18.1.204".parse().expect("fake IP")));
    assert!(!is_fake_ip_proxy_address("192.168.0.1".parse().expect("private IP")));
  }
  #[test]
  fn audio_candidate_requires_mime_extension_or_magic() {
    assert!(response_content_type_is_audio_candidate(
      Some("audio/mpeg"),
      None,
      None,
    ));
    assert!(response_content_type_is_audio_candidate(
      None,
      Some("audio/mp4"),
      None,
    ));
    assert!(response_content_type_is_audio_candidate(
      None,
      None,
      Some("https://cdn.example.test/show/ep-1.mp3?token=1"),
    ));
    assert!(!response_content_type_is_audio_candidate(None, None, None));
    assert!(!response_content_type_is_audio_candidate(
      None,
      None,
      Some("https://cdn.example.test/show/ep-1"),
    ));
    assert!(!response_content_type_is_audio_candidate(
      Some("text/html"),
      None,
      Some("https://cdn.example.test/show/ep-1.mp3"),
    ));
    assert!(audio_prefix_looks_like_audio(b"ID3\x03\x00"));
    assert!(!audio_prefix_looks_like_audio(b"<html>not audio"));
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
}
