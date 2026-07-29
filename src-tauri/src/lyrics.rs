use encoding_rs::GBK;
use lofty::file::TaggedFileExt;
use lofty::prelude::ItemKey;
use lofty::read_from_path;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use crate::library::stable_track_id;

const LYRICS_EXPORT_CONTENT_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub(crate) struct LocalLyricsSource {
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
pub(crate) fn select_lyrics_file() -> Option<String> {
  rfd::FileDialog::new()
    .set_title("选择歌词文件")
    .add_filter("歌词", &["ttml", "lrc", "txt"])
    .pick_file()
    .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn export_lyrics_file(
  suggested_name: String,
  format: String,
  content: String,
) -> Result<Option<String>, String> {
  if content.trim().is_empty() {
    return Err("没有可导出的歌词内容".to_string());
  }
  if content.len() > LYRICS_EXPORT_CONTENT_LIMIT {
    return Err("歌词内容过大，无法导出".to_string());
  }
  let extension = match format.as_str() {
    "ttml" => "ttml",
    "lrc" => "lrc",
    _ => return Err("不支持的歌词导出格式".to_string()),
  };
  let file_name = normalized_lyrics_export_name(&suggested_name, extension);
  let Some(path) = rfd::FileDialog::new()
    .set_title("导出歌词")
    .set_file_name(&file_name)
    .add_filter(if extension == "ttml" { "TTML 歌词" } else { "LRC 歌词" }, &[extension])
    .save_file()
  else {
    return Ok(None);
  };

  fs::write(&path, content.as_bytes()).map_err(|_| "无法写入歌词文件".to_string())?;
  Ok(Some(path.to_string_lossy().to_string()))
}

fn normalized_lyrics_export_name(value: &str, extension: &str) -> String {
  let cleaned = value
    .chars()
    .map(|character| {
      if character.is_control() || matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
        ' '
      } else {
        character
      }
    })
    .collect::<String>()
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
    .trim_end_matches(['.', ' '])
    .chars()
    .take(124)
    .collect::<String>();
  let mut file_name = if cleaned.is_empty() { "歌词".to_string() } else { cleaned };
  let expected_suffix = format!(".{extension}");
  if !file_name.to_lowercase().ends_with(&expected_suffix) {
    file_name.push_str(&expected_suffix);
  }
  file_name
}

#[tauri::command]
pub(crate) fn load_local_lyrics(
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
  fn lyrics_export_names_are_safe_and_keep_the_selected_format() {
    assert_eq!(
      normalized_lyrics_export_name("  21: Guns? / Live.ttml  ", "ttml"),
      "21 Guns Live.ttml"
    );
    assert_eq!(normalized_lyrics_export_name("...", "lrc"), "歌词.lrc");
    assert_eq!(normalized_lyrics_export_name("track.lrc", "ttml"), "track.lrc.ttml");
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
