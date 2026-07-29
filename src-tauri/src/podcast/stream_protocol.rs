use reqwest::header::{self, HeaderMap};
use reqwest::StatusCode;
use tauri::http::{Method, Request, Response};
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PodcastStreamRange {
  Bounded { start: u64, end: u64 },
  Suffix { length: u64 },
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
    Some(source.enclosure_url.as_str()),
    requested_range,
    is_head,
  )
  .await
}

async fn proxy_podcast_stream_response(
  response: reqwest::Response,
  enclosure_type: Option<&str>,
  enclosure_url: Option<&str>,
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

  let content_type = match podcast_stream_content_type(
    response.headers(),
    enclosure_type,
    enclosure_url,
  ) {
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
    if let Err(error) = ensure_stream_body_looks_like_audio(&content_type, &body) {
      return podcast_stream_text_response(StatusCode::BAD_GATEWAY, &error);
    }
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
  if let Err(error) = ensure_stream_body_looks_like_audio(&content_type, &body) {
    return podcast_stream_text_response(StatusCode::BAD_GATEWAY, &error);
  }
  podcast_stream_response_builder(StatusCode::OK, &content_type, total)
    .body(body)
    .unwrap()
}

impl PodcastStreamRange {
  pub(crate) fn to_header_value(self) -> String {
    match self {
      Self::Bounded { start, end } => format!("bytes={start}-{end}"),
      Self::Suffix { length } => format!("bytes=-{length}"),
    }
  }

  pub(crate) fn matches_response(self, start: u64, end: u64, total: u64) -> bool {
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

fn podcast_stream_content_type(
  headers: &HeaderMap,
  enclosure_type: Option<&str>,
  enclosure_url: Option<&str>,
) -> Result<String, String> {
  let response_type = header_text(headers, header::CONTENT_TYPE);
  if !response_content_type_is_audio_candidate(
    response_type.as_deref(),
    enclosure_type,
    enclosure_url,
  ) {
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

fn ensure_stream_body_looks_like_audio(content_type: &str, body: &[u8]) -> Result<(), String> {
  if content_type.starts_with("audio/") {
    return Ok(());
  }
  // Generic binary responses may be error pages or non-media payloads. Require a
  // recognized audio magic when the upstream did not advertise an audio MIME.
  if audio_prefix_looks_like_audio(body) {
    return Ok(());
  }
  Err("播客音频来源返回了非音频内容".to_string())
}

pub(crate) fn parse_unsatisfied_content_range(value: &str) -> Option<u64> {
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

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  use tokio::io::AsyncReadExt;
  use tokio::io::AsyncWriteExt;
  use tokio::net::TcpListener;
  use rusqlite::params;

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
}
