use encoding_rs::GBK;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::{Accessor, ItemKey};
use lofty::read_from_path;
use notify::event::{CreateKind, ModifyKind, RemoveKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager, State};
use walkdir::WalkDir;

#[derive(Default)]
pub(crate) struct LibraryWatcherState {
  watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MusicFolder {
  pub path: String,
  pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Track {
  pub id: String,
  pub path: String,
  pub file_name: String,
  pub title: String,
  pub artist: String,
  pub album: String,
  pub album_artist: String,
  pub track_number: Option<u32>,
  pub disc_number: Option<u32>,
  pub year: Option<u32>,
  pub genres: Vec<String>,
  pub duration_seconds: Option<u64>,
  pub added_at: Option<u64>,
  pub extension: String,
  pub cover_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ScanResult {
  pub folders: Vec<String>,
  pub tracks: Vec<Track>,
  pub skipped: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryFilesChanged {
  paths: Vec<String>,
}

#[tauri::command]
pub(crate) fn select_music_folder() -> Option<MusicFolder> {
  let folder = rfd::FileDialog::new().set_title("选择音乐文件夹").pick_folder()?;
  let name = folder
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("音乐")
    .to_string();

  Some(MusicFolder {
    path: folder.to_string_lossy().to_string(),
    name,
  })
}

#[tauri::command]
pub(crate) fn scan_library(app: tauri::AppHandle, folders: Vec<String>) -> Result<ScanResult, String> {
  let result = scan_library_controlled(folders, &|| false, &|_| {})?;
  crate::image_scope::allow_tracks(&app, &result.tracks);
  Ok(result)
}

pub(crate) fn scan_library_controlled(
  folders: Vec<String>, cancelled: &dyn Fn() -> bool, progress: &dyn Fn(usize),
) -> Result<ScanResult, String> {
  let mut tracks = Vec::new();
  let mut skipped = 0usize;

  for folder in &folders {
    if cancelled() { return Err("曲库扫描已取消".into()); }
    let root = PathBuf::from(folder);
    if !root.is_dir() {
      return Err("音乐文件夹暂不可用，已保留原资料库".into());
    }

    for entry in WalkDir::new(&root).follow_links(false) {
      if cancelled() { return Err("曲库扫描已取消".into()); }
      let entry = entry.map_err(|_| "音乐文件夹读取不完整，已保留原资料库".to_string())?;
      if !entry.file_type().is_file() {
        continue;
      }

      let path = entry.path();
      if !is_supported_audio(path) {
        skipped += 1;
        continue;
      }

      // An unreadable file cannot authoritatively replace a previous snapshot.
      fs::File::open(path).map_err(|_| "音乐文件读取失败，已保留原资料库".to_string())?;

      tracks.push(track_from_path(path));
      if tracks.len() % 25 == 0 { progress(tracks.len()); }
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

  if cancelled() { return Err("曲库扫描已取消".into()); }
  progress(tracks.len());
  Ok(ScanResult {
    folders,
    tracks,
    skipped,
  })
}

#[tauri::command]
pub(crate) fn watch_music_folders(
  app: tauri::AppHandle,
  state: State<'_, LibraryWatcherState>,
  folders: Vec<String>,
) -> Result<(), String> {
  let mut watcher_slot = state
    .watcher
    .lock()
    .map_err(|_| "无法更新曲库目录监听".to_string())?;
  *watcher_slot = None;

  if folders.is_empty() {
    return Ok(());
  }

  let app_handle = app.clone();
  let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| match result {
    Ok(event) if should_refresh_library(&event) => {
      let mut paths = event
        .paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
      paths.sort();
      paths.dedup();
      paths.truncate(12);
      eprintln!("[library] filesystem change kind={:?} paths={}", event.kind, paths.len());
      if let Err(error) = app_handle.emit("library-files-changed", LibraryFilesChanged { paths }) {
        eprintln!("[library] unable to notify frontend: {error}");
      }
    }
    Ok(_) => {}
    Err(error) => eprintln!("[library] filesystem watcher error: {error}"),
  })
  .map_err(|error| format!("无法初始化曲库目录监听：{error}"))?;

  let mut watched_count = 0usize;
  let mut failures = Vec::new();
  for folder in folders {
    let path = PathBuf::from(&folder);
    if !path.is_dir() {
      failures.push(folder);
      continue;
    }
    match watcher.watch(&path, RecursiveMode::Recursive) {
      Ok(()) => watched_count += 1,
      Err(error) => {
        eprintln!("[library] unable to watch {}: {error}", path.display());
        failures.push(path.to_string_lossy().to_string());
      }
    }
  }

  if watched_count == 0 {
    return Err("没有可监听的音乐目录".to_string());
  }
  if !failures.is_empty() {
    eprintln!(
      "[library] watching {watched_count} folders; {} folders unavailable",
      failures.len(),
    );
  }
  *watcher_slot = Some(watcher);
  Ok(())
}

fn should_refresh_library(event: &Event) -> bool {
  if event.paths.iter().any(|path| is_supported_audio(path)) {
    return true;
  }

  matches!(
    event.kind,
    EventKind::Create(CreateKind::Folder)
      | EventKind::Remove(RemoveKind::Folder)
      | EventKind::Modify(ModifyKind::Name(_))
  )
}

pub(crate) fn is_supported_audio(path: &Path) -> bool {
  let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
    return false;
  };

  matches!(
    extension.to_lowercase().as_str(),
    "mp3" | "flac" | "m4a" | "aac" | "wav" | "ogg"
  )
}

fn track_from_path(path: &Path) -> Track {
  let tagged_file = read_from_path(path).ok();
  let primary_tag = tagged_file.as_ref().and_then(|file| file.primary_tag().or_else(|| file.first_tag()));
  let file_stem = path
    .file_stem()
    .and_then(|value| value.to_str())
    .unwrap_or("未命名歌曲")
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
    .map(|value| fallback_text(&value, "未知专辑"))
    .unwrap_or_else(|| {
      path
        .parent()
        .and_then(|value| value.file_name())
        .and_then(|value| value.to_str())
        .unwrap_or("未知专辑")
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

static COVER_CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 启动时注入 Tauri 约定的缓存目录；否则封面会落进 NSIS 当前用户安装目录
///（%LOCALAPPDATA%\Zone），随卸载被一起删掉。
pub(crate) fn init_cover_cache_dir(app: &tauri::AppHandle) {
  if let Ok(dir) = app.path().app_cache_dir() {
    let _ = COVER_CACHE_DIR.set(dir.join("covers"));
  }
}

fn cover_cache_dir() -> Option<PathBuf> {
  COVER_CACHE_DIR.get().cloned().or_else(|| {
    std::env::var_os("LOCALAPPDATA")
      .map(PathBuf::from)
      .map(|path| path.join("Zone").join("covers"))
  })
}

fn split_artist_title(file_stem: &str) -> (String, String) {
  let cleaned = file_stem
    .trim_start_matches(|character: char| character.is_ascii_digit() || character == '.' || character == '-' || character == '_' || character == ' ')
    .trim();

  if let Some((artist, title)) = cleaned.split_once(" - ") {
    return (fallback_text(artist, "未知艺术家"), fallback_text(title, cleaned));
  }

  ("未知艺术家".to_string(), fallback_text(cleaned, "未命名歌曲"))
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

pub(crate) fn stable_track_id(path: &Path) -> String {
  path.to_string_lossy()
    .bytes()
    .fold(0xcbf29ce484222325u64, |hash, byte| {
      (hash ^ byte as u64).wrapping_mul(0x100000001b3)
    })
    .to_string()
}

#[cfg(test)]
mod library_tests {
  use super::*;

  #[test]
  fn untagged_files_use_chinese_fallbacks_without_losing_the_file_title() {
    assert_eq!(split_artist_title(""), ("未知艺术家".into(), "未命名歌曲".into()));
    assert_eq!(split_artist_title("歌曲"), ("未知艺术家".into(), "歌曲".into()));
    assert_eq!(split_artist_title("歌手 - 歌曲"), ("歌手".into(), "歌曲".into()));
  }

  #[test]
  fn library_watcher_refreshes_only_for_audio_or_directory_changes() {
    let audio = Event::new(EventKind::Any).add_path(PathBuf::from("music/Track.FLAC"));
    let cover = Event::new(EventKind::Create(CreateKind::File))
      .add_path(PathBuf::from("music/cover.jpg"));
    let folder = Event::new(EventKind::Create(CreateKind::Folder))
      .add_path(PathBuf::from("music/New Album"));
    let rename = Event::new(EventKind::Modify(ModifyKind::Name(
      notify::event::RenameMode::Both,
    )))
    .add_path(PathBuf::from("music/Old Name"))
    .add_path(PathBuf::from("music/New Name"));

    assert!(should_refresh_library(&audio));
    assert!(!should_refresh_library(&cover));
    assert!(should_refresh_library(&folder));
    assert!(should_refresh_library(&rename));
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
}
