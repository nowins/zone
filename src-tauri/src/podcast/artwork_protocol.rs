use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::header::{self, HeaderMap};
use reqwest::{StatusCode, Url};
use tauri::http::{Method, Request, Response};
use super::*;

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
