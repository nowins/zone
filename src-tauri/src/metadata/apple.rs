use super::*;
use crate::podcast::{read_limited, send_public_get};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const APPLE_MUSIC_PROVIDER_ID: &str = "apple-music-cn";
pub(crate) const APPLE_MUSIC_PROVIDER_NAME: &str = "Apple 音乐目录（中国区）";

const APPLE_SEARCH_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const APPLE_ARTWORK_RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const APPLE_SEARCH_LIMIT: usize = 25;
const APPLE_CANDIDATE_LIMIT: usize = 12;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleMusicSearchResponse {
  #[serde(default)]
  results: Vec<AppleMusicItem>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleMusicItem {
  wrapper_type: Option<String>,
  kind: Option<String>,
  artist_id: Option<i64>,
  collection_id: Option<i64>,
  track_id: Option<i64>,
  artist_name: Option<String>,
  collection_name: Option<String>,
  track_name: Option<String>,
  artwork_url_100: Option<String>,
  release_date: Option<String>,
  primary_genre_name: Option<String>,
  track_time_millis: Option<u64>,
  track_number: Option<u32>,
  disc_number: Option<u32>,
  track_view_url: Option<String>,
  collection_view_url: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppleResolvedCandidate {
  pub(crate) resolved: ResolvedMetadataCandidate,
  artwork_url: Option<String>,
}

pub(crate) async fn search_apple_music_candidates(
  kind: MetadataEntityKind,
  tracks: &[MetadataTrackInput],
) -> Result<Vec<AppleResolvedCandidate>, String> {
  validate_metadata_tracks(tracks)?;
  match kind {
    MetadataEntityKind::Track => search_track_candidates(&tracks[0]).await,
    MetadataEntityKind::Album => search_album_candidates(tracks).await,
    MetadataEntityKind::Artist => Ok(Vec::new()),
  }
}

pub(crate) async fn apply_apple_music_candidate(
  state: &MetadataState,
  candidate_id: &str,
  kind: MetadataEntityKind,
  tracks: &[MetadataTrackInput],
) -> Result<(), String> {
  state.ensure_ready()?;
  let candidates = search_apple_music_candidates(kind, tracks).await?;
  let mut candidate = candidates
    .into_iter()
    .find(|candidate| candidate.resolved.candidate.id == candidate_id)
    .ok_or_else(|| "Apple 音乐候选已变化，请重新查找".to_string())?;

  if let Some(artwork_url) = candidate.artwork_url.as_deref() {
    match cache_apple_artwork(state.artwork_cache_dir(), artwork_url).await {
      Ok(path) => candidate.resolved.values.push((
        "album_cover_path".to_string(),
        Value::String(path.to_string_lossy().to_string()),
      )),
      Err(error) => eprintln!("[metadata:apple] artwork cache failed: {error}"),
    }
  }

  persist_metadata_candidate(state, &candidate.resolved, tracks)
}

async fn search_track_candidates(
  track: &MetadataTrackInput,
) -> Result<Vec<AppleResolvedCandidate>, String> {
  let specific_query = search_term(&[&track.title, &track.artist]);
  let mut items = request_apple_music(&specific_query, "song").await?;
  let mut candidates = track_candidates_from_items(track, &items);

  if candidates.is_empty() {
    let broad_query = search_term(&[&track.title]);
    if broad_query != specific_query {
      items = request_apple_music(&broad_query, "song").await?;
      candidates = track_candidates_from_items(track, &items);
    }
  }
  Ok(candidates)
}

async fn search_album_candidates(
  tracks: &[MetadataTrackInput],
) -> Result<Vec<AppleResolvedCandidate>, String> {
  let first = &tracks[0];
  let album_artist = first
    .album_artist
    .as_deref()
    .filter(|value| !is_unknown_label(value))
    .unwrap_or(&first.artist);
  let album_query = search_term(&[&first.album, album_artist]);
  let mut candidates = if album_query.is_empty() {
    Vec::new()
  } else {
    match request_apple_music(&album_query, "album").await {
      Ok(album_items) => album_candidates_from_album_items(first, &album_items),
      Err(error) => {
        eprintln!("[metadata:apple] album search failed, trying track fallback: {error}");
        Vec::new()
      }
    }
  };
  if candidates
    .first()
    .is_some_and(|candidate| candidate.resolved.candidate.confidence >= 82)
  {
    return Ok(candidates);
  }

  let specific_track_query = search_term(&[&first.title, &first.artist]);
  let mut track_items = request_apple_music(&specific_track_query, "song").await?;
  let mut derived = album_candidates_from_track_items(first, &track_items);
  if derived.is_empty() {
    let broad_track_query = search_term(&[&first.title]);
    if broad_track_query != specific_track_query {
      track_items = request_apple_music(&broad_track_query, "song").await?;
      derived = album_candidates_from_track_items(first, &track_items);
    }
  }
  candidates.extend(derived);
  Ok(deduplicate_candidates(candidates))
}

async fn request_apple_music(
  query: &str,
  entity: &str,
) -> Result<Vec<AppleMusicItem>, String> {
  if query.is_empty() || query.chars().count() > 500 {
    return Err("Apple 音乐搜索内容无效".to_string());
  }
  if !matches!(entity, "song" | "album") {
    return Err("Apple 音乐搜索类型无效".to_string());
  }

  let mut url = Url::parse("https://itunes.apple.com/search")
    .map_err(|_| "无法构造 Apple 音乐搜索地址".to_string())?;
  url
    .query_pairs_mut()
    .append_pair("country", "CN")
    .append_pair("media", "music")
    .append_pair("entity", entity)
    .append_pair("limit", &APPLE_SEARCH_LIMIT.to_string())
    .append_pair("term", query);

  let mut last_error = "Apple 音乐目录暂时不可用".to_string();
  for _ in 0..2 {
    match request_apple_music_once(url.clone()).await {
      Ok(items) => return Ok(items),
      Err(error) => last_error = error,
    }
  }
  Err(last_error)
}

async fn request_apple_music_once(url: Url) -> Result<Vec<AppleMusicItem>, String> {
  let public_response = send_public_get(url, Duration::from_secs(15), None)
    .await
    .map_err(apple_network_error)?;
  if public_response.final_url.scheme() != "https"
    || !public_response
      .final_url
      .host_str()
      .is_some_and(|host| host.eq_ignore_ascii_case("itunes.apple.com"))
    || public_response.final_url.path() != "/search"
  {
    return Err("Apple 音乐目录返回了不受支持的地址".to_string());
  }
  let bytes = read_limited(
    public_response.response,
    APPLE_SEARCH_RESPONSE_LIMIT,
    "Apple 音乐搜索",
  )
  .await?;
  let response = serde_json::from_slice::<AppleMusicSearchResponse>(&bytes)
    .map_err(|_| "Apple 音乐搜索结果格式无效".to_string())?;
  Ok(response.results)
}

fn apple_network_error(error: String) -> String {
  error
    .replace("播客来源", "Apple 音乐目录")
    .replace("播客请求", "Apple 音乐请求")
}

fn track_candidates_from_items(
  track: &MetadataTrackInput,
  items: &[AppleMusicItem],
) -> Vec<AppleResolvedCandidate> {
  let candidates = items
    .iter()
    .filter_map(|item| {
      if item.kind.as_deref() != Some("song") && item.wrapper_type.as_deref() != Some("track") {
        return None;
      }
      let track_id = item.track_id?;
      let title = clean_apple_text(item.track_name.as_deref())?;
      let artist = clean_apple_text(item.artist_name.as_deref())?;
      let album = clean_apple_text(item.collection_name.as_deref())?;
      let confidence = track_match_confidence(track, item, &title, &artist, &album);
      if confidence < 60 {
        return None;
      }

      let mut values = vec![
        ("title".to_string(), Value::String(title.clone())),
        ("artist".to_string(), Value::String(artist.clone())),
        ("album".to_string(), Value::String(album.clone())),
        ("album_artist".to_string(), Value::String(artist.clone())),
      ];
      push_apple_release_fields(&mut values, item);
      if let Some(track_number) = item.track_number {
        values.push(("track_number".to_string(), Value::from(track_number)));
      }
      if let Some(disc_number) = item.disc_number {
        values.push(("disc_number".to_string(), Value::from(disc_number)));
      }
      let candidate = metadata_candidate(
        MetadataEntityKind::Track,
        format!("apple:track:{track_id}"),
        title.clone(),
        format!("{artist} · {album}"),
        apple_source(item, track_id, false),
        confidence,
        &values,
      );
      Some(AppleResolvedCandidate {
        resolved: ResolvedMetadataCandidate {
          candidate,
          display_name: title,
          values,
          external_ids: apple_external_ids(item),
        },
        artwork_url: item.artwork_url_100.as_deref().and_then(apple_artwork_url),
      })
    })
    .collect();
  deduplicate_candidates(candidates)
}

fn album_candidates_from_album_items(
  track: &MetadataTrackInput,
  items: &[AppleMusicItem],
) -> Vec<AppleResolvedCandidate> {
  let candidates = items
    .iter()
    .filter_map(|item| {
      if item.wrapper_type.as_deref() != Some("collection") && item.kind.as_deref() != Some("album") {
        return None;
      }
      let collection_id = item.collection_id?;
      let album = clean_apple_text(item.collection_name.as_deref())?;
      let artist = clean_apple_text(item.artist_name.as_deref())?;
      let confidence = album_match_confidence(track, item, &album, &artist);
      if confidence < 60 {
        return None;
      }
      Some(album_candidate(item, collection_id, album, artist, confidence))
    })
    .collect();
  deduplicate_candidates(candidates)
}

fn album_candidates_from_track_items(
  track: &MetadataTrackInput,
  items: &[AppleMusicItem],
) -> Vec<AppleResolvedCandidate> {
  let candidates = items
    .iter()
    .filter_map(|item| {
      if item.kind.as_deref() != Some("song") {
        return None;
      }
      let collection_id = item.collection_id?;
      let matched_title = clean_apple_text(item.track_name.as_deref())?;
      let album = clean_apple_text(item.collection_name.as_deref())?;
      let artist = clean_apple_text(item.artist_name.as_deref())?;
      let confidence =
        derived_album_match_confidence(track, item, &matched_title, &album, &artist);
      if confidence < 60 {
        return None;
      }
      Some(album_candidate(item, collection_id, album, artist, confidence))
    })
    .collect();
  deduplicate_candidates(candidates)
}

fn album_candidate(
  item: &AppleMusicItem,
  collection_id: i64,
  album: String,
  artist: String,
  confidence: u8,
) -> AppleResolvedCandidate {
  let mut values = vec![
    ("title".to_string(), Value::String(album.clone())),
    ("artist".to_string(), Value::String(artist.clone())),
  ];
  push_apple_release_fields(&mut values, item);
  let candidate = metadata_candidate(
    MetadataEntityKind::Album,
    format!("apple:album:{collection_id}"),
    album.clone(),
    artist.clone(),
    apple_source(item, collection_id, true),
    confidence,
    &values,
  );
  AppleResolvedCandidate {
    resolved: ResolvedMetadataCandidate {
      candidate,
      display_name: album,
      values,
      external_ids: apple_external_ids(item),
    },
    artwork_url: item.artwork_url_100.as_deref().and_then(apple_artwork_url),
  }
}

fn metadata_candidate(
  kind: MetadataEntityKind,
  id: String,
  title: String,
  subtitle: String,
  source_path: String,
  confidence: u8,
  values: &[(String, Value)],
) -> MetadataCandidate {
  MetadataCandidate {
    id,
    kind,
    provider_id: APPLE_MUSIC_PROVIDER_ID.to_string(),
    provider_name: APPLE_MUSIC_PROVIDER_NAME.to_string(),
    title,
    subtitle,
    source_path,
    confidence,
    fields: values
      .iter()
      .map(|(key, value)| MetadataCandidateField {
        key: key.clone(),
        label: field_label(key).to_string(),
        value: display_value(value),
      })
      .collect(),
  }
}

fn push_apple_release_fields(values: &mut Vec<(String, Value)>, item: &AppleMusicItem) {
  if let Some(year) = item
    .release_date
    .as_deref()
    .and_then(|value| value.get(..4))
    .and_then(|value| value.parse::<u32>().ok())
    .filter(|value| (1..=9_999).contains(value))
  {
    values.push(("year".to_string(), Value::from(year)));
  }
  if let Some(genre) = clean_apple_text(item.primary_genre_name.as_deref()) {
    values.push((
      "genres".to_string(),
      Value::Array(vec![Value::String(genre)]),
    ));
  }
}

fn apple_external_ids(item: &AppleMusicItem) -> Vec<(String, String)> {
  let mut ids = Vec::new();
  if let Some(id) = item.track_id {
    ids.push(("apple-track".to_string(), id.to_string()));
  }
  if let Some(id) = item.collection_id {
    ids.push(("apple-album".to_string(), id.to_string()));
  }
  if let Some(id) = item.artist_id {
    ids.push(("apple-artist".to_string(), id.to_string()));
  }
  ids
}

fn apple_source(item: &AppleMusicItem, id: i64, album: bool) -> String {
  let source = if album {
    item.collection_view_url.as_deref()
  } else {
    item.track_view_url.as_deref()
  };
  source
    .and_then(|value| clean_apple_text(Some(value)))
    .unwrap_or_else(|| {
      if album {
        format!("Apple 音乐专辑 {id}")
      } else {
        format!("Apple 音乐曲目 {id}")
      }
    })
}

fn track_match_confidence(
  track: &MetadataTrackInput,
  item: &AppleMusicItem,
  title: &str,
  artist: &str,
  album: &str,
) -> u8 {
  let title_score = text_similarity(&track.title, title);
  if title_score < 70 {
    return 0;
  }
  let artist_score = text_similarity(&track.artist, artist);
  let album_score = if is_unknown_label(&track.album) {
    0
  } else {
    text_similarity(&track.album, album)
  };
  let duration_score = duration_similarity(track.duration_seconds, item.track_time_millis);
  ((title_score as u16 * 55
    + artist_score as u16 * 25
    + album_score as u16 * 10
    + duration_score as u16 * 10)
    / 100)
    .min(100) as u8
}

fn album_match_confidence(
  track: &MetadataTrackInput,
  item: &AppleMusicItem,
  album: &str,
  artist: &str,
) -> u8 {
  let album_score = text_similarity(&track.album, album);
  if album_score < 60 {
    return 0;
  }
  let local_artist = track.album_artist.as_deref().unwrap_or(&track.artist);
  let artist_score = text_similarity(local_artist, artist);
  let year_score = match (
    track.year,
    item
      .release_date
      .as_deref()
      .and_then(|value| value.get(..4))
      .and_then(|value| value.parse::<u32>().ok()),
  ) {
    (Some(left), Some(right)) if left == right => 100,
    (Some(_), Some(_)) => 0,
    _ => 50,
  };
  ((album_score as u16 * 65 + artist_score as u16 * 30 + year_score as u16 * 5) / 100)
    .min(100) as u8
}

fn derived_album_match_confidence(
  track: &MetadataTrackInput,
  item: &AppleMusicItem,
  matched_title: &str,
  album: &str,
  artist: &str,
) -> u8 {
  let title_score = text_similarity(&track.title, matched_title);
  if title_score < 75 {
    return 0;
  }
  let artist_score = text_similarity(&track.artist, artist);
  let album_score = if is_unknown_label(&track.album) {
    0
  } else {
    text_similarity(&track.album, album)
  };
  let duration_score = duration_similarity(track.duration_seconds, item.track_time_millis);
  ((title_score as u16 * 45
    + artist_score as u16 * 20
    + album_score as u16 * 25
    + duration_score as u16 * 10)
    / 100)
    .min(100) as u8
}

fn duration_similarity(local_seconds: Option<u64>, remote_millis: Option<u64>) -> u8 {
  let (Some(local), Some(remote)) = (local_seconds, remote_millis) else {
    return 50;
  };
  let remote = remote / 1_000;
  let difference = local.abs_diff(remote);
  match difference {
    0..=3 => 100,
    4..=10 => 70,
    11..=30 => 30,
    _ => 0,
  }
}

fn text_similarity(left: &str, right: &str) -> u8 {
  let left = normalize_match_text(left);
  let right = normalize_match_text(right);
  if left.is_empty() || right.is_empty() {
    return 0;
  }
  if left == right {
    return 100;
  }
  if left.contains(&right) || right.contains(&left) {
    let shorter = left.chars().count().min(right.chars().count());
    let longer = left.chars().count().max(right.chars().count());
    return ((shorter * 85) / longer.max(1)).max(60).min(85) as u8;
  }

  let left_chars: HashSet<char> = left.chars().collect();
  let right_chars: HashSet<char> = right.chars().collect();
  let shared = left_chars.intersection(&right_chars).count();
  ((shared * 200) / (left_chars.len() + right_chars.len()).max(1)).min(100) as u8
}

fn normalize_match_text(value: &str) -> String {
  value
    .chars()
    .flat_map(char::to_lowercase)
    .filter(|value| value.is_alphanumeric())
    .collect()
}

fn search_term(parts: &[&str]) -> String {
  parts
    .iter()
    .map(|value| value.trim())
    .filter(|value| !value.is_empty() && !is_unknown_label(value))
    .collect::<Vec<_>>()
    .join(" ")
    .chars()
    .take(500)
    .collect()
}

fn is_unknown_label(value: &str) -> bool {
  matches!(
    value.trim().to_lowercase().as_str(),
    "" | "未知歌曲" | "未知专辑" | "未知艺术家" | "unknown" | "unknown album"
      | "unknown artist"
  )
}

fn clean_apple_text(value: Option<&str>) -> Option<String> {
  let value = value?.trim();
  if value.is_empty() {
    return None;
  }
  Some(value.chars().take(4_096).collect())
}

fn deduplicate_candidates(
  candidates: Vec<AppleResolvedCandidate>,
) -> Vec<AppleResolvedCandidate> {
  let mut by_id = HashMap::new();
  for candidate in candidates {
    let id = candidate.resolved.candidate.id.clone();
    let should_replace = by_id
      .get(&id)
      .is_none_or(|current: &AppleResolvedCandidate| {
        candidate.resolved.candidate.confidence > current.resolved.candidate.confidence
      });
    if should_replace {
      by_id.insert(id, candidate);
    }
  }
  let mut candidates: Vec<_> = by_id.into_values().collect();
  candidates.sort_by(|left, right| {
    right
      .resolved
      .candidate
      .confidence
      .cmp(&left.resolved.candidate.confidence)
      .then_with(|| {
        left
          .resolved
          .candidate
          .title
          .cmp(&right.resolved.candidate.title)
      })
  });
  candidates.truncate(APPLE_CANDIDATE_LIMIT);
  candidates
}

fn apple_artwork_url(value: &str) -> Option<String> {
  let mut url = Url::parse(value.trim()).ok()?;
  if url.scheme() == "http" {
    url.set_scheme("https").ok()?;
  }
  if url.scheme() != "https" || !is_apple_artwork_host(url.host_str()?) {
    return None;
  }
  let path = url
    .path()
    .replace("100x100bb", "600x600bb")
    .replace("100x100-75", "600x600bb");
  url.set_path(&path);
  Some(url.to_string())
}

fn is_apple_artwork_host(host: &str) -> bool {
  let host = host.to_ascii_lowercase();
  host == "mzstatic.com"
    || host.ends_with(".mzstatic.com")
    || host == "itunes.apple.com"
    || host.ends_with(".itunes.apple.com")
}

async fn cache_apple_artwork(cache_dir: &Path, value: &str) -> Result<PathBuf, String> {
  let url = Url::parse(value).map_err(|_| "Apple 封面地址无效".to_string())?;
  if url.scheme() != "https" || !url.host_str().is_some_and(is_apple_artwork_host) {
    return Err("Apple 封面地址不受支持".to_string());
  }
  let cache_key = sha256_hex(url.as_str().as_bytes());
  for extension in ["jpg", "png", "webp"] {
    let path = cache_dir.join(format!("{cache_key}.{extension}"));
    if path.is_file() {
      return Ok(path);
    }
  }

  let public_response = send_public_get(url, Duration::from_secs(30), None)
    .await
    .map_err(apple_network_error)?;
  if public_response.final_url.scheme() != "https"
    || !public_response
      .final_url
      .host_str()
      .is_some_and(is_apple_artwork_host)
  {
    return Err("Apple 封面重定向地址不受支持".to_string());
  }
  let bytes = read_limited(
    public_response.response,
    APPLE_ARTWORK_RESPONSE_LIMIT,
    "Apple 专辑封面",
  )
  .await?;
  let extension = image_extension(&bytes)
    .ok_or_else(|| "Apple 封面格式不受支持".to_string())?;
  let final_path = cache_dir.join(format!("{cache_key}.{extension}"));
  let nonce = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .ok()
    .map(|duration| duration.as_nanos())
    .unwrap_or(0);
  let temporary_path = cache_dir.join(format!(
    "{cache_key}.{}-{nonce}.part",
    std::process::id()
  ));
  tokio::fs::write(&temporary_path, &bytes)
    .await
    .map_err(|error| format!("无法缓存 Apple 专辑封面：{error}"))?;
  if let Err(error) = tokio::fs::rename(&temporary_path, &final_path).await {
    if !final_path.is_file() {
      let _ = tokio::fs::remove_file(&temporary_path).await;
      return Err(format!("无法保存 Apple 专辑封面：{error}"));
    }
    let _ = tokio::fs::remove_file(&temporary_path).await;
  }
  Ok(final_path)
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
  if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
    Some("jpg")
  } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    Some("png")
  } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
    Some("webp")
  } else {
    None
  }
}

fn sha256_hex(value: &[u8]) -> String {
  let digest = Sha256::digest(value);
  let mut output = String::with_capacity(64);
  for byte in digest {
    output.push_str(&format!("{byte:02x}"));
  }
  output
}

#[cfg(test)]
mod tests {
  use super::*;

  fn input() -> MetadataTrackInput {
    MetadataTrackInput {
      id: "track-1".to_string(),
      path: "C:\\music\\月光.mp3".to_string(),
      title: "月光".to_string(),
      artist: "胡彦斌".to_string(),
      album: "未知专辑".to_string(),
      album_artist: None,
      track_number: None,
      disc_number: None,
      year: None,
      genres: None,
      duration_seconds: Some(272),
    }
  }

  fn apple_item() -> AppleMusicItem {
    AppleMusicItem {
      wrapper_type: Some("track".to_string()),
      kind: Some("song".to_string()),
      artist_id: Some(1),
      collection_id: Some(2),
      track_id: Some(3),
      artist_name: Some("胡彦斌".to_string()),
      collection_name: Some("音乐斌潮".to_string()),
      track_name: Some("月光".to_string()),
      artwork_url_100: Some(
        "https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg".to_string(),
      ),
      release_date: Some("2008-07-04T12:00:00Z".to_string()),
      primary_genre_name: Some("国语流行".to_string()),
      track_time_millis: Some(272_027),
      track_number: Some(1),
      disc_number: Some(1),
      track_view_url: Some("https://music.apple.com/cn/song/3".to_string()),
      collection_view_url: Some("https://music.apple.com/cn/album/2".to_string()),
    }
  }

  #[test]
  fn exact_track_match_becomes_a_high_confidence_candidate() {
    let candidates = track_candidates_from_items(&input(), &[apple_item()]);
    assert_eq!(candidates.len(), 1);
    assert!(candidates[0].resolved.candidate.confidence >= 90);
    assert_eq!(
      candidates[0].resolved.candidate.provider_id,
      APPLE_MUSIC_PROVIDER_ID
    );
    assert!(candidates[0]
      .resolved
      .values
      .iter()
      .any(|(key, value)| key == "genres" && value == &serde_json::json!(["国语流行"])));
  }

  #[test]
  fn mismatched_titles_are_rejected_before_artist_or_duration_can_help() {
    let mut item = apple_item();
    item.track_name = Some("完全不同".to_string());
    assert!(track_candidates_from_items(&input(), &[item]).is_empty());
  }

  #[test]
  fn artwork_urls_are_upgraded_and_limited_to_apple_hosts() {
    assert_eq!(
      apple_artwork_url(
        "http://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg"
      )
      .as_deref(),
      Some("https://is1-ssl.mzstatic.com/image/thumb/Music/600x600bb.jpg")
    );
    assert!(apple_artwork_url("https://example.com/100x100bb.jpg").is_none());
    assert_eq!(image_extension(&[0xff, 0xd8, 0xff, 0]), Some("jpg"));
    assert_eq!(image_extension(b"not-an-image"), None);
  }

  #[test]
  fn composite_artist_names_still_keep_a_manual_candidate() {
    let mut track = input();
    track.artist = "胡彦斌/其他歌手".to_string();
    let candidates = track_candidates_from_items(&track, &[apple_item()]);
    assert_eq!(candidates.len(), 1);
    assert!(candidates[0].resolved.candidate.confidence >= 60);
  }

  #[tokio::test]
  async fn apple_music_cn_live_smoke() {
    if std::env::var("ZONE_METADATA_LIVE").ok().as_deref() != Some("1") {
      eprintln!("requires ZONE_METADATA_LIVE=1 and public internet access");
      return;
    }
    let nonce = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    let root = std::env::temp_dir().join(format!(
      "zone-apple-metadata-live-{}-{nonce}",
      std::process::id()
    ));
    std::fs::create_dir_all(&root).expect("create live test directory");
    let audio_path = root.join("月光.mp3");
    std::fs::write(&audio_path, b"ID3-live-smoke").expect("write audio fixture");
    let state = MetadataState::initialize_at(&root.join("data")).expect("initialize metadata");
    let mut track = input();
    track.path = audio_path.to_string_lossy().to_string();

    let candidates = search_apple_music_candidates(MetadataEntityKind::Track, &[track.clone()])
      .await
      .expect("search Apple music catalog");
    let candidate = candidates
      .iter()
      .find(|candidate| candidate.resolved.candidate.title == "月光")
      .expect("find exact song candidate");
    let candidate_id = candidate.resolved.candidate.id.clone();
    apply_apple_music_candidate(
      &state,
      &candidate_id,
      MetadataEntityKind::Track,
      &[track],
    )
    .await
    .expect("apply Apple music candidate");

    let overlays =
      read_track_overlays(&state, &["track-1".to_string()]).expect("read applied overlay");
    assert_eq!(overlays[0].title.as_deref(), Some("月光"));
    assert!(overlays[0]
      .cover_path
      .as_deref()
      .is_some_and(|path| Path::new(path).is_file()));
    std::fs::remove_dir_all(root).expect("cleanup live test directory");
  }
}
