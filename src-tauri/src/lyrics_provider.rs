use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use std::time::Instant;
use crate::qrc;

const LYRICS_PROVIDER_RESPONSE_LIMIT: usize = 1024 * 1024;
const AMLL_INDEX_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const LYRICS_PROVIDER_REQUEST_BODY_LIMIT: usize = 4 * 1024;
const QRC_ENCRYPTED_TEXT_LIMIT: usize = 128 * 1024;
static LYRICS_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub(crate) async fn request_lyrics_provider(
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
    let request = if provider_id == "qq" && body.is_some() {
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
    } else if provider_id == "qq" {
      client
        .get(url.clone())
        .header("Referer", "https://c.y.qq.com/")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Zone/0.1")
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
pub(crate) fn decrypt_qrc_lyrics(encrypted: String) -> Result<String, String> {
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
  let common_shape = url.scheme() == "https"
    && url.port().is_none()
    && url.username().is_empty()
    && url.password().is_none()
    && url.fragment().is_none();
  common_shape
    && match (url.host_str(), url.path()) {
      (Some("u.y.qq.com"), "/cgi-bin/musicu.fcg")
        | (Some("c.y.qq.com"), "/qqmusic/fcgi-bin/lyric_download.fcg") => url.query().is_none(),
      (Some("c.y.qq.com"), "/soso/fcgi-bin/client_search_cp") => validate_qq_legacy_search_query(url),
      _ => false,
    }
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
  if url.path() == "/soso/fcgi-bin/client_search_cp" {
    return if body.is_none() {
      Ok(None)
    } else {
      Err("QQ 音乐回退搜索不接受请求内容".to_string())
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

fn validate_qq_legacy_search_query(url: &reqwest::Url) -> bool {
  let pairs = url
    .query_pairs()
    .map(|(key, value)| (key.into_owned(), value.into_owned()))
    .collect::<Vec<_>>();
  pairs.len() == 4
    && unique_query_value(&pairs, "p") == Some("1")
    && unique_query_value(&pairs, "n") == Some("20")
    && unique_query_value(&pairs, "format") == Some("json")
    && unique_query_value(&pairs, "w")
      .is_some_and(|query| !query.trim().is_empty() && query.chars().count() <= 300)
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

#[cfg(test)]
mod lyrics_provider_tests {
  use super::*;

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
      "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=20&w=21+Guns+Green+Day&format=json"
    )
    .is_ok());
    assert!(validate_lyrics_provider_url(
      "qq",
      "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=20&w=21+Guns&format=json&redirect=true"
    )
    .is_err());
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
  fn qq_provider_only_accepts_expected_request_shapes() {
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
    let fallback_url = validate_lyrics_provider_url(
      "qq",
      "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=20&w=21+Guns+Green+Day&format=json"
    )
    .expect("valid QQ fallback search URL");
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
    assert!(validate_lyrics_provider_request_body("qq", &fallback_url, None).is_ok());
    assert!(validate_lyrics_provider_request_body(
      "qq",
      &fallback_url,
      Some(search_body.to_string())
    )
    .is_err());
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
