use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::http::{header, Method, Request, Response, StatusCode};
use crate::library::is_supported_audio;

const AUDIO_RANGE_CHUNK_SIZE: u64 = 1024 * 1024;

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

#[cfg(test)]
pub(crate) fn serve_audio_protocol(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
  serve_audio_protocol_with_cache(request, None)
}

pub(crate) fn serve_audio_protocol_with_cache(request: Request<Vec<u8>>, cache_dir: Option<&Path>) -> Response<Vec<u8>> {
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

  let path = if let Some(cache_dir) = cache_dir {
    match crate::audio_transcode::playback_path(&path, cache_dir) {
      Ok(path) => path,
      Err(message) => return text_response(StatusCode::UNPROCESSABLE_ENTITY, &message),
    }
  } else { path };

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

  let mut body = if request.method() == Method::HEAD { Vec::new() } else { vec![0; length as usize] };
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
    length,
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
mod audio_protocol_tests {
  use super::*;
  use std::time::SystemTime;
  use std::time::UNIX_EPOCH;

  #[test]
  fn downloaded_podcast_audio_is_served_with_range_and_cors() {
    let stamp = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    let directory = std::env::temp_dir().join(format!(
      "zone-podcast-audio-{}-{stamp}",
      std::process::id(),
    ));
    fs::create_dir_all(&directory).expect("create test directory");
    let path = directory.join("episode.mp3");
    let audio = b"ID3-zone-podcast-audio";
    fs::write(&path, audio).expect("write audio fixture");

    let protocol_path = path.to_string_lossy().replace('\\', "/").replace(' ', "%20");
    let request = Request::builder()
      .method(Method::GET)
      .uri(format!("zone-audio://localhost/{protocol_path}"))
      .header(header::RANGE, "bytes=4-8")
      .body(Vec::new())
      .expect("build range request");
    let response = serve_audio_protocol(request);

    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
      response.headers().get(header::CONTENT_RANGE).and_then(|value| value.to_str().ok()),
      Some("bytes 4-8/22"),
    );
    assert_eq!(
      response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).and_then(|value| value.to_str().ok()),
      Some("*"),
    );
    assert_eq!(response.body(), &audio[4..=8]);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  #[ignore = "requires ZONE_AUDIO_FIXTURES containing a real ALAC M4A"]
  fn alac_range_and_head_use_the_pcm_cache() {
    let source = PathBuf::from(std::env::var("ZONE_AUDIO_FIXTURES").expect("fixtures")).join("alac.m4a");
    let cache = std::env::temp_dir().join(format!("zone-alac-protocol-{}", std::process::id()));
    let uri = format!("zone-audio://localhost/{}", source.to_string_lossy().replace('\\', "/"));
    let request = Request::builder().uri(&uri).header(header::RANGE, "bytes=0-43").body(Vec::new()).unwrap();
    let response = serve_audio_protocol_with_cache(request, Some(&cache));
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/wav");
    assert_eq!(&response.body()[0..4], b"RIFF");
    let head = Request::builder().method(Method::HEAD).uri(&uri).header(header::RANGE, "bytes=0-43").body(Vec::new()).unwrap();
    let response = serve_audio_protocol_with_cache(head, Some(&cache));
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "44");
    assert!(response.body().is_empty());
    fs::remove_dir_all(cache).unwrap();
  }
}
