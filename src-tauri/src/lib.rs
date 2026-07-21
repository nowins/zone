use encoding_rs::GBK;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::{Accessor, ItemKey};
use lofty::read_from_path;
use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::http::{header, Method, Request, Response, StatusCode};
#[cfg(target_os = "windows")]
use tauri::Manager;
use walkdir::WalkDir;

mod system_media;

const AUDIO_RANGE_CHUNK_SIZE: u64 = 1024 * 1024;

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
    if matches!(character, '°' | '±' | '²' | '³' | 'Ä' | 'Å' | 'Æ' | 'Ç' | 'È' | 'É' | 'Ê' | 'Ë' | 'Ì' | 'Í' | 'Î' | 'Ï' | 'Ð' | 'Ñ' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | '×' | 'Ø' | 'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ý' | 'Þ' | 'ß' | 'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'æ' | 'ç' | 'è' | 'é' | 'ê' | 'ë' | 'ì' | 'í' | 'î' | 'ï' | 'ð' | 'ñ' | 'ò' | 'ó' | 'ô' | 'õ' | 'ö' | '÷' | 'ø' | 'ù' | 'ú' | 'û' | 'ü') {
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
      update_system_media,
      update_system_media_timeline,
    ])
    .run(tauri::generate_context!())
    .expect("error while running Zone");
}
