use super::*;
use crate::library::is_supported_audio;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const SIDECAR_RESPONSE_LIMIT: u64 = 256 * 1024;
const SIDECAR_ARTWORK_LIMIT: u64 = 8 * 1024 * 1024;
const SIDECAR_TRACK_LIMIT: usize = 500;
const SIDECAR_TEXT_LIMIT: usize = 500;
const SIDECAR_DESCRIPTION_LIMIT: usize = 20_000;
const SIDECAR_GENRE_LIMIT: usize = 64;
const SIDECAR_EXTERNAL_ID_LIMIT: usize = 32;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarDocument {
  kind: Option<String>,
  title: Option<String>,
  name: Option<String>,
  artist: Option<String>,
  album: Option<String>,
  album_artist: Option<String>,
  track_number: Option<u32>,
  disc_number: Option<u32>,
  year: Option<u32>,
  genres: Option<Vec<String>>,
  description: Option<String>,
  biography: Option<String>,
  image: Option<String>,
  cover: Option<String>,
  artist_image: Option<String>,
  artist_images: Option<Vec<String>>,
  album_cover: Option<String>,
  external_ids: Option<BTreeMap<String, String>>,
}

pub(crate) fn find_sidecar_candidates(
  kind: MetadataEntityKind,
  tracks: &[MetadataTrackInput],
) -> Result<Vec<ResolvedMetadataCandidate>, String> {
  validate_metadata_tracks(tracks)?;
  let mut paths = Vec::new();
  let mut seen_paths = HashSet::new();

  for track in tracks {
    let audio_path = Path::new(&track.path);
    for candidate_path in candidate_paths(kind, audio_path) {
      let Some(candidate_path) = candidate_path else {
        continue;
      };
      let canonical = candidate_path
        .canonicalize()
        .map_err(|error| format!("无法读取本地补充文件：{error}"))?;
      let key = canonical.to_string_lossy().to_lowercase();
      if seen_paths.insert(key) {
        paths.push(canonical);
      }
    }
  }

  let mut candidates = paths
    .into_iter()
    .filter_map(|path| match load_sidecar(kind, &path, tracks) {
      Ok(Some(candidate)) => Some(Ok(candidate)),
      Ok(None) => None,
      Err(error) => Some(Err(error)),
    })
    .collect::<Result<Vec<_>, _>>()?;
  candidates.sort_by(|left, right| {
    left
      .candidate
      .source_path
      .to_lowercase()
      .cmp(&right.candidate.source_path.to_lowercase())
  });
  Ok(candidates)
}

pub(crate) fn validate_metadata_tracks(tracks: &[MetadataTrackInput]) -> Result<(), String> {
  if tracks.is_empty() || tracks.len() > SIDECAR_TRACK_LIMIT {
    return Err("本地补充信息的歌曲范围无效".to_string());
  }
  let mut ids = HashSet::new();
  for track in tracks {
    if track.id.trim().is_empty() || track.id.len() > 256 || !ids.insert(track.id.as_str()) {
      return Err("本地补充信息包含无效歌曲".to_string());
    }
    if track.path.len() > 4_096 {
      return Err("音乐文件路径过长".to_string());
    }
    if [&track.title, &track.artist, &track.album]
      .into_iter()
      .any(|value| value.chars().count() > SIDECAR_TEXT_LIMIT)
      || track
        .album_artist
        .as_deref()
        .is_some_and(|value| value.chars().count() > SIDECAR_TEXT_LIMIT)
    {
      return Err("音乐文件信息过长".to_string());
    }
    if track.track_number.is_some_and(|value| value > 100_000)
      || track.disc_number.is_some_and(|value| value > 10_000)
      || track.year.is_some_and(|value| value > 9_999)
      || track.duration_seconds.is_some_and(|value| value > 7 * 24 * 60 * 60)
    {
      return Err("音乐文件信息无效".to_string());
    }
    if track.genres.as_ref().is_some_and(|genres| {
      genres.len() > SIDECAR_GENRE_LIMIT
        || genres
          .iter()
          .any(|genre| genre.chars().count() > SIDECAR_TEXT_LIMIT)
    }) {
      return Err("音乐文件流派信息无效".to_string());
    }
    let path = Path::new(&track.path);
    if !path.is_file() || !is_supported_audio(path) {
      return Err("本地补充信息只能用于曲库中的音乐文件".to_string());
    }
  }
  Ok(())
}

fn candidate_paths(kind: MetadataEntityKind, audio_path: &Path) -> Vec<Option<PathBuf>> {
  let parent = audio_path.parent();
  match kind {
    MetadataEntityKind::Track => {
      let file_name = audio_path
        .file_stem()
        .map(|value| format!("{}.zone.json", value.to_string_lossy()));
      vec![parent.and_then(|dir| {
        file_name
          .as_deref()
          .and_then(|name| find_child_case_insensitive(dir, name))
      })]
    }
    MetadataEntityKind::Album => vec![
      parent.and_then(|dir| find_child_case_insensitive(dir, "album.zone.json")),
    ],
    MetadataEntityKind::Artist => vec![
      parent.and_then(|dir| find_child_case_insensitive(dir, "artist.zone.json")),
      parent
        .and_then(Path::parent)
        .and_then(|dir| find_child_case_insensitive(dir, "artist.zone.json")),
    ],
  }
}

fn find_child_case_insensitive(parent: &Path, expected_name: &str) -> Option<PathBuf> {
  fs::read_dir(parent)
    .ok()?
    .filter_map(Result::ok)
    .find(|entry| {
      entry
        .file_name()
        .to_string_lossy()
        .eq_ignore_ascii_case(expected_name)
        && entry.path().is_file()
    })
    .map(|entry| entry.path())
}

fn load_sidecar(
  kind: MetadataEntityKind,
  path: &Path,
  tracks: &[MetadataTrackInput],
) -> Result<Option<ResolvedMetadataCandidate>, String> {
  let metadata = fs::metadata(path).map_err(|error| format!("无法读取本地补充文件：{error}"))?;
  if metadata.len() == 0 || metadata.len() > SIDECAR_RESPONSE_LIMIT {
    return Err("本地补充文件为空或超过 256 KiB".to_string());
  }
  let bytes = fs::read(path).map_err(|error| format!("无法读取本地补充文件：{error}"))?;
  let document: SidecarDocument =
    serde_json::from_slice(&bytes).map_err(|_| "本地补充文件不是有效的 JSON".to_string())?;

  if let Some(document_kind) = clean_short(document.kind.as_deref()) {
    if document_kind.to_lowercase() != kind.as_str() {
      return Ok(None);
    }
  }

  let base_dir = path
    .parent()
    .ok_or_else(|| "本地补充文件缺少所在目录".to_string())?;
  let first = tracks
    .first()
    .ok_or_else(|| "本地补充信息缺少歌曲".to_string())?;
  let mut values = Vec::new();

  let display_name = match kind {
    MetadataEntityKind::Track => {
      push_string(&mut values, "title", document.title.as_deref(), SIDECAR_TEXT_LIMIT);
      push_string(&mut values, "artist", document.artist.as_deref(), SIDECAR_TEXT_LIMIT);
      push_string(&mut values, "album", document.album.as_deref(), SIDECAR_TEXT_LIMIT);
      push_string(
        &mut values,
        "album_artist",
        document.album_artist.as_deref(),
        SIDECAR_TEXT_LIMIT,
      );
      push_year(&mut values, document.year);
      push_position(&mut values, "track_number", document.track_number);
      push_position(&mut values, "disc_number", document.disc_number);
      push_genres(&mut values, document.genres.as_deref());
      push_string(
        &mut values,
        "description",
        document.description.as_deref(),
        SIDECAR_DESCRIPTION_LIMIT,
      );
      let artwork = resolve_artwork(
        base_dir,
        document.album_cover.as_deref().or(document.cover.as_deref()),
        path
          .file_stem()
          .and_then(|value| value.to_str())
          .unwrap_or("track.zone"),
      )?;
      push_path(&mut values, "album_cover_path", artwork.as_deref());
      clean_short(document.title.as_deref()).unwrap_or_else(|| first.title.clone())
    }
    MetadataEntityKind::Album => {
      let title = clean_short(document.title.as_deref())
        .or_else(|| clean_short(document.album.as_deref()));
      if let Some(title) = title.as_deref() {
        values.push(("title".to_string(), Value::String(title.to_string())));
      }
      let artist = clean_short(document.album_artist.as_deref())
        .or_else(|| clean_short(document.artist.as_deref()));
      if let Some(artist) = artist.as_deref() {
        values.push(("artist".to_string(), Value::String(artist.to_string())));
      }
      push_year(&mut values, document.year);
      push_genres(&mut values, document.genres.as_deref());
      push_string(
        &mut values,
        "description",
        document.description.as_deref(),
        SIDECAR_DESCRIPTION_LIMIT,
      );
      let artwork = resolve_artwork(
        base_dir,
        document.album_cover.as_deref().or(document.cover.as_deref()),
        "album.zone",
      )?;
      push_path(&mut values, "album_cover_path", artwork.as_deref());
      title.unwrap_or_else(|| first.album.clone())
    }
    MetadataEntityKind::Artist => {
      let name = clean_short(document.name.as_deref())
        .or_else(|| clean_short(document.artist.as_deref()));
      if let Some(name) = name.as_deref() {
        values.push(("name".to_string(), Value::String(name.to_string())));
      }
      let biography = clean_long(
        document.biography.as_deref().or(document.description.as_deref()),
        SIDECAR_DESCRIPTION_LIMIT,
      );
      if let Some(biography) = biography {
        values.push(("biography".to_string(), Value::String(biography)));
      }
      let artworks = resolve_artist_artworks(base_dir, &document)?;
      if !artworks.is_empty() {
        values.push((
          "artist_image_paths".to_string(),
          Value::Array(
            artworks
              .into_iter()
              .map(|path| Value::String(path.to_string_lossy().to_string()))
              .collect(),
          ),
        ));
      }
      name.unwrap_or_else(|| first.artist.clone())
    }
  };

  if values.is_empty() {
    return Ok(None);
  }

  let canonical_path = path
    .canonicalize()
    .map_err(|error| format!("无法解析本地补充文件路径：{error}"))?;
  let source_path = canonical_path.to_string_lossy().to_string();
  let id = sidecar_candidate_id(kind, &canonical_path);
  let fields = values
    .iter()
    .map(|(key, value)| MetadataCandidateField {
      key: if key == "artist_image_paths" {
        "artist_image_path".to_string()
      } else {
        key.clone()
      },
      label: field_label(key).to_string(),
      value: if key == "artist_image_paths" {
        value
          .as_array()
          .and_then(|paths| paths.first())
          .and_then(Value::as_str)
          .unwrap_or_default()
          .to_string()
      } else {
        display_value(value)
      },
    })
    .collect();
  let external_ids = normalize_external_ids(document.external_ids);
  let subtitle = canonical_path
    .file_name()
    .map(|value| value.to_string_lossy().to_string())
    .unwrap_or_else(|| "本地补充文件".to_string());

  Ok(Some(ResolvedMetadataCandidate {
    candidate: MetadataCandidate {
      id,
      kind,
      provider_id: LOCAL_SIDECAR_PROVIDER_ID.to_string(),
      provider_name: LOCAL_SIDECAR_PROVIDER_NAME.to_string(),
      title: display_name.clone(),
      subtitle,
      source_path,
      confidence: 100,
      fields,
    },
    display_name,
    values,
    external_ids,
  }))
}

fn push_string(
  values: &mut Vec<(String, Value)>,
  key: &str,
  raw: Option<&str>,
  limit: usize,
) {
  if let Some(value) = clean_long(raw, limit) {
    values.push((key.to_string(), Value::String(value)));
  }
}

fn push_year(values: &mut Vec<(String, Value)>, year: Option<u32>) {
  if let Some(year) = year.filter(|year| (1..=9_999).contains(year)) {
    values.push(("year".to_string(), Value::from(year)));
  }
}

fn push_position(values: &mut Vec<(String, Value)>, key: &str, value: Option<u32>) {
  if let Some(value) = value.filter(|value| *value > 0 && *value <= 100_000) {
    values.push((key.to_string(), Value::from(value)));
  }
}

fn push_genres(values: &mut Vec<(String, Value)>, genres: Option<&[String]>) {
  let Some(genres) = genres else {
    return;
  };
  let mut normalized = Vec::new();
  let mut seen = HashSet::new();
  for genre in genres.iter().take(SIDECAR_GENRE_LIMIT) {
    let Some(genre) = clean_short(Some(genre)) else {
      continue;
    };
    let key = genre.to_lowercase();
    if seen.insert(key) {
      normalized.push(Value::String(genre));
    }
  }
  if !normalized.is_empty() {
    values.push(("genres".to_string(), Value::Array(normalized)));
  }
}

fn push_path(values: &mut Vec<(String, Value)>, key: &str, path: Option<&Path>) {
  if let Some(path) = path {
    values.push((
      key.to_string(),
      Value::String(path.to_string_lossy().to_string()),
    ));
  }
}

fn clean_short(value: Option<&str>) -> Option<String> {
  clean_long(value, SIDECAR_TEXT_LIMIT)
}

fn clean_long(value: Option<&str>, limit: usize) -> Option<String> {
  let value = value?.trim();
  if value.is_empty() {
    return None;
  }
  Some(value.chars().take(limit).collect())
}

fn normalize_external_ids(value: Option<BTreeMap<String, String>>) -> Vec<(String, String)> {
  value
    .unwrap_or_default()
    .into_iter()
    .filter_map(|(provider_id, external_id)| {
      let provider_id = clean_short(Some(&provider_id))?;
      let external_id = clean_short(Some(&external_id))?;
      Some((provider_id.to_lowercase(), external_id))
    })
    .take(SIDECAR_EXTERNAL_ID_LIMIT)
    .collect()
}

fn resolve_artwork(
  base_dir: &Path,
  requested: Option<&str>,
  convention_stem: &str,
) -> Result<Option<PathBuf>, String> {
  let requested = clean_short(requested);
  let candidate = if let Some(requested) = requested {
    let relative = Path::new(&requested);
    if relative.is_absolute() || relative.components().any(|part| {
      matches!(
        part,
        std::path::Component::ParentDir
          | std::path::Component::RootDir
          | std::path::Component::Prefix(_)
      )
    }) {
      return Err("本地补充图片必须位于补充文件所在目录".to_string());
    }
    find_child_case_insensitive(base_dir, &requested)
  } else {
    ["jpg", "jpeg", "png", "webp"]
      .into_iter()
      .find_map(|extension| {
        find_child_case_insensitive(base_dir, &format!("{convention_stem}.{extension}"))
      })
  };
  let Some(candidate) = candidate else {
    return Ok(None);
  };
  let canonical_base = base_dir
    .canonicalize()
    .map_err(|error| format!("无法解析本地补充图片目录：{error}"))?;
  let canonical = candidate
    .canonicalize()
    .map_err(|error| format!("无法读取本地补充图片：{error}"))?;
  if !canonical.starts_with(&canonical_base) {
    return Err("本地补充图片超出允许目录".to_string());
  }
  validate_artwork(&canonical)?;
  Ok(Some(canonical))
}

fn resolve_artist_artworks(
  base_dir: &Path,
  document: &SidecarDocument,
) -> Result<Vec<PathBuf>, String> {
  let mut requested = document.artist_images.clone().unwrap_or_default();
  if let Some(legacy) = document
    .artist_image
    .as_ref()
    .or(document.image.as_ref())
  {
    requested.push(legacy.clone());
  }
  let mut artworks = Vec::new();
  let mut seen = HashSet::new();
  for value in requested.into_iter().take(8) {
    let Some(path) = resolve_artwork(base_dir, Some(&value), "artist.zone")? else {
      continue;
    };
    let key = path.to_string_lossy().to_lowercase();
    if seen.insert(key) {
      artworks.push(path);
    }
  }
  if artworks.is_empty() {
    if let Some(path) = resolve_artwork(base_dir, None, "artist.zone")? {
      artworks.push(path);
    }
  }
  Ok(artworks)
}

fn validate_artwork(path: &Path) -> Result<(), String> {
  let metadata = fs::metadata(path).map_err(|error| format!("无法读取本地补充图片：{error}"))?;
  if metadata.len() == 0 || metadata.len() > SIDECAR_ARTWORK_LIMIT {
    return Err("本地补充图片为空或超过 8 MiB".to_string());
  }
  let bytes = fs::read(path).map_err(|error| format!("无法读取本地补充图片：{error}"))?;
  let valid = bytes.starts_with(&[0xff, 0xd8, 0xff])
    || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
    || (bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP");
  if !valid {
    return Err("本地补充图片格式不受支持".to_string());
  }
  Ok(())
}

fn sidecar_candidate_id(kind: MetadataEntityKind, path: &Path) -> String {
  let mut hasher = Sha256::new();
  hasher.update(b"zone-sidecar:");
  hasher.update(kind.as_str().as_bytes());
  hasher.update(b":");
  hasher.update(path.to_string_lossy().as_bytes());
  let digest = hasher.finalize();
  let mut id = String::with_capacity(64);
  for byte in digest {
    id.push_str(&format!("{byte:02x}"));
  }
  format!("sidecar:{id}")
}

pub(crate) fn field_label(key: &str) -> &'static str {
  match key {
    "name" => "艺术家",
    "title" => "标题",
    "artist" => "艺术家",
    "album" => "专辑",
    "album_artist" => "专辑艺术家",
    "year" => "年份",
    "track_number" => "曲序",
    "disc_number" => "碟号",
    "genres" => "流派",
    "description" => "介绍",
    "biography" => "歌手简介",
    "aliases" => "别名",
    "identities" => "身份",
    "album_count" => "专辑数",
    "song_count" => "歌曲数",
    "mv_count" => "MV 数",
    "artist_image_path" => "歌手图片",
    "artist_image_paths" => "歌手图片",
    "album_cover_path" => "专辑封面",
    _ => "补充信息",
  }
}

pub(crate) fn display_value(value: &Value) -> String {
  match value {
    Value::String(value) => value.clone(),
    Value::Number(value) => value.to_string(),
    Value::Array(values) => values
      .iter()
      .filter_map(Value::as_str)
      .collect::<Vec<_>>()
      .join("、"),
    _ => value.to_string(),
  }
}
