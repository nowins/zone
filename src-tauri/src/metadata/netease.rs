use super::*;
use crate::podcast::{read_limited, send_public_get};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;

#[cfg(test)]
use std::path::Path;
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const NETEASE_ARTIST_PROVIDER_ID: &str = "netease-artist";
pub(crate) const NETEASE_ARTIST_PROVIDER_NAME: &str = "网易云音乐（歌手资料）";

const NETEASE_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const NETEASE_SEARCH_LIMIT: usize = 8;
const NETEASE_CANDIDATE_LIMIT: usize = 5;
const NETEASE_BIOGRAPHY_LIMIT: usize = 20_000;
const NETEASE_CANDIDATE_BIOGRAPHY_LIMIT: usize = 260;

#[derive(Debug, Deserialize)]
struct NeteaseSearchResponse {
  code: i32,
  result: Option<NeteaseSearchResult>,
}

#[derive(Debug, Deserialize)]
struct NeteaseSearchResult {
  #[serde(default)]
  artists: Vec<NeteaseArtistSummary>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NeteaseArtistSummary {
  id: i64,
  name: String,
  #[serde(default)]
  alias: Vec<String>,
  pic_url: Option<String>,
  img1v1_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NeteaseArtistHeadResponse {
  code: i32,
  data: Option<NeteaseArtistHeadData>,
}

#[derive(Debug, Deserialize)]
struct NeteaseArtistHeadData {
  artist: Option<NeteaseArtistDetail>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NeteaseArtistDetail {
  id: i64,
  name: String,
  cover: Option<String>,
  avatar: Option<String>,
  #[serde(default)]
  trans_names: Vec<String>,
  #[serde(default)]
  alias: Vec<String>,
  #[serde(default)]
  identities: Vec<String>,
  brief_desc: Option<String>,
  album_size: Option<u32>,
  music_size: Option<u32>,
  mv_size: Option<u32>,
}

#[derive(Clone, Debug)]
pub(crate) struct NeteaseResolvedCandidate {
  pub(crate) resolved: ResolvedMetadataCandidate,
  artwork_url: Option<String>,
}

pub(crate) async fn search_netease_artist_candidates(
  kind: MetadataEntityKind,
  tracks: &[MetadataTrackInput],
) -> Result<Vec<NeteaseResolvedCandidate>, String> {
  validate_metadata_tracks(tracks)?;
  if kind != MetadataEntityKind::Artist {
    return Ok(Vec::new());
  }
  let artist = tracks[0].artist.trim();
  if artist.is_empty() || artist.chars().count() > 4_096 {
    return Err("网易云歌手搜索内容无效".to_string());
  }

  let summaries = request_netease_artist_search(artist).await?;
  let mut ranked = summaries
    .into_iter()
    .filter_map(|summary| {
      let confidence = artist_match_confidence(artist, &summary.name, &summary.alias);
      (confidence >= 60).then_some((summary, confidence))
    })
    .collect::<Vec<_>>();
  ranked.sort_by(|left, right| {
    right
      .1
      .cmp(&left.1)
      .then_with(|| left.0.name.cmp(&right.0.name))
  });
  ranked.truncate(NETEASE_CANDIDATE_LIMIT);

  let mut candidates = Vec::new();
  for (index, (summary, confidence)) in ranked.into_iter().enumerate() {
    if index >= 3 {
      if let Some(candidate) =
        artist_candidate_from_summary(artist, confidence, summary)
      {
        candidates.push(candidate);
      }
      continue;
    }
    match request_netease_artist_detail(summary.id).await {
      Ok(detail) => {
        if let Some(candidate) =
          artist_candidate_from_detail(artist, confidence, &summary, detail)
        {
          candidates.push(candidate);
        }
      }
      Err(error) => {
        eprintln!(
          "[metadata:netease] artist detail {} failed: {error}",
          summary.id
        );
        if let Some(candidate) =
          artist_candidate_from_summary(artist, confidence, summary)
        {
          candidates.push(candidate);
        }
      }
    }
  }
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
  Ok(candidates)
}

pub(crate) async fn apply_netease_artist_candidate(
  state: &MetadataState,
  candidate_id: &str,
  kind: MetadataEntityKind,
  tracks: &[MetadataTrackInput],
) -> Result<(), String> {
  state.ensure_ready()?;
  validate_metadata_tracks(tracks)?;
  if kind != MetadataEntityKind::Artist {
    return Err("网易云歌手资料只支持艺术家".to_string());
  }
  let id = candidate_id
    .strip_prefix("netease:artist:")
    .and_then(|value| value.parse::<i64>().ok())
    .filter(|value| *value > 0)
    .ok_or_else(|| "网易云歌手候选标识无效".to_string())?;
  let detail = request_netease_artist_detail(id).await?;
  let summary = NeteaseArtistSummary {
    id: detail.id,
    name: detail.name.clone(),
    alias: detail.alias.clone(),
    pic_url: detail.cover.clone(),
    img1v1_url: detail.avatar.clone(),
  };
  let confidence =
    artist_match_confidence(&tracks[0].artist, &summary.name, &summary.alias);
  let mut candidate =
    artist_candidate_from_detail(&tracks[0].artist, confidence, &summary, detail)
      .filter(|candidate| candidate.resolved.candidate.id == candidate_id)
      .ok_or_else(|| "网易云歌手候选已变化，请重新查找".to_string())?;

  if let Some(artwork_url) = candidate.artwork_url.as_deref() {
    match cache_provider_artwork(
      state.artwork_cache_dir(),
      artwork_url,
      "网易云歌手图片",
      is_netease_artwork_host,
    )
    .await
    {
      Ok(path) => candidate.resolved.values.push((
        "artist_image_path".to_string(),
        Value::String(path.to_string_lossy().to_string()),
      )),
      Err(error) => eprintln!("[metadata:netease] artwork cache failed: {error}"),
    }
  }

  persist_metadata_candidate(state, &candidate.resolved, tracks)
}

async fn request_netease_artist_search(
  query: &str,
) -> Result<Vec<NeteaseArtistSummary>, String> {
  let mut url = Url::parse("https://music.163.com/api/search/get/web")
    .map_err(|_| "无法构造网易云歌手搜索地址".to_string())?;
  url
    .query_pairs_mut()
    .append_pair("csrf_token", "")
    .append_pair("s", query)
    .append_pair("type", "100")
    .append_pair("limit", &NETEASE_SEARCH_LIMIT.to_string())
    .append_pair("offset", "0")
    .append_pair("total", "true");
  let response =
    request_netease_json::<NeteaseSearchResponse>(url, "/api/search/get/web", "网易云歌手搜索")
      .await?;
  if response.code != 200 {
    return Err(format!("网易云歌手搜索返回错误 {}", response.code));
  }
  Ok(response.result.map(|result| result.artists).unwrap_or_default())
}

async fn request_netease_artist_detail(id: i64) -> Result<NeteaseArtistDetail, String> {
  if id <= 0 {
    return Err("网易云歌手标识无效".to_string());
  }
  let mut url = Url::parse("https://music.163.com/api/artist/head/info/get")
    .map_err(|_| "无法构造网易云歌手资料地址".to_string())?;
  url.query_pairs_mut().append_pair("id", &id.to_string());
  let response = request_netease_json_once::<NeteaseArtistHeadResponse>(
    url,
    "/api/artist/head/info/get",
    "网易云歌手资料",
  )
  .await?;
  if response.code != 200 {
    return Err(format!("网易云歌手资料返回错误 {}", response.code));
  }
  response
    .data
    .and_then(|data| data.artist)
    .filter(|artist| artist.id == id)
    .ok_or_else(|| "网易云歌手资料缺少艺术家信息".to_string())
}

async fn request_netease_json<T>(
  url: Url,
  expected_path: &str,
  label: &str,
) -> Result<T, String>
where
  T: for<'de> Deserialize<'de>,
{
  let mut last_error = format!("{label}暂时不可用");
  for _ in 0..2 {
    match request_netease_json_once(url.clone(), expected_path, label).await {
      Ok(value) => return Ok(value),
      Err(error) => last_error = error,
    }
  }
  Err(last_error)
}

async fn request_netease_json_once<T>(
  url: Url,
  expected_path: &str,
  label: &str,
) -> Result<T, String>
where
  T: for<'de> Deserialize<'de>,
{
  let public_response = send_public_get(url, Duration::from_secs(15), None)
    .await
    .map_err(netease_network_error)?;
  if public_response.final_url.scheme() != "https"
    || !public_response
      .final_url
      .host_str()
      .is_some_and(|host| host.eq_ignore_ascii_case("music.163.com"))
    || public_response.final_url.path() != expected_path
  {
    return Err(format!("{label}返回了不受支持的地址"));
  }
  let bytes = read_limited(public_response.response, NETEASE_RESPONSE_LIMIT, label).await?;
  serde_json::from_slice::<T>(&bytes).map_err(|_| format!("{label}结果格式无效"))
}

fn netease_network_error(error: String) -> String {
  error
    .replace("播客来源", "网易云音乐")
    .replace("播客请求", "网易云音乐请求")
}

fn artist_match_confidence(local_artist: &str, name: &str, aliases: &[String]) -> u8 {
  std::iter::once(name)
    .chain(aliases.iter().map(String::as_str))
    .map(|value| text_similarity(local_artist, value))
    .max()
    .unwrap_or(0)
}

fn artist_candidate_from_detail(
  local_artist: &str,
  summary_confidence: u8,
  summary: &NeteaseArtistSummary,
  detail: NeteaseArtistDetail,
) -> Option<NeteaseResolvedCandidate> {
  let name = clean_text(Some(&detail.name), 4_096)?;
  let aliases = deduplicate_text(
    detail
      .alias
      .iter()
      .chain(detail.trans_names.iter())
      .map(String::as_str),
    32,
    4_096,
  );
  let identities =
    deduplicate_text(detail.identities.iter().map(String::as_str), 32, 4_096);
  let confidence =
    artist_match_confidence(local_artist, &name, &aliases).max(summary_confidence);
  if confidence < 60 {
    return None;
  }
  let biography = clean_text(detail.brief_desc.as_deref(), NETEASE_BIOGRAPHY_LIMIT);
  let artwork_url = detail
    .cover
    .as_deref()
    .and_then(netease_artwork_url)
    .or_else(|| detail.avatar.as_deref().and_then(netease_artwork_url))
    .or_else(|| summary.pic_url.as_deref().and_then(netease_artwork_url))
    .or_else(|| summary.img1v1_url.as_deref().and_then(netease_artwork_url));
  Some(build_artist_candidate(
    detail.id,
    name,
    aliases,
    identities,
    biography,
    detail.album_size,
    detail.music_size,
    detail.mv_size,
    confidence,
    artwork_url,
  ))
}

fn artist_candidate_from_summary(
  local_artist: &str,
  summary_confidence: u8,
  summary: NeteaseArtistSummary,
) -> Option<NeteaseResolvedCandidate> {
  let name = clean_text(Some(&summary.name), 4_096)?;
  let aliases =
    deduplicate_text(summary.alias.iter().map(String::as_str), 32, 4_096);
  let confidence =
    artist_match_confidence(local_artist, &name, &aliases).max(summary_confidence);
  if confidence < 60 {
    return None;
  }
  let artwork_url = summary
    .pic_url
    .as_deref()
    .and_then(netease_artwork_url)
    .or_else(|| summary.img1v1_url.as_deref().and_then(netease_artwork_url));
  Some(build_artist_candidate(
    summary.id,
    name,
    aliases,
    Vec::new(),
    None,
    None,
    None,
    None,
    confidence,
    artwork_url,
  ))
}

#[allow(clippy::too_many_arguments)]
fn build_artist_candidate(
  id: i64,
  name: String,
  aliases: Vec<String>,
  identities: Vec<String>,
  biography: Option<String>,
  album_size: Option<u32>,
  music_size: Option<u32>,
  mv_size: Option<u32>,
  confidence: u8,
  artwork_url: Option<String>,
) -> NeteaseResolvedCandidate {
  let mut values = vec![("name".to_string(), Value::String(name.clone()))];
  if !aliases.is_empty() {
    values.push((
      "aliases".to_string(),
      Value::Array(aliases.iter().cloned().map(Value::String).collect()),
    ));
  }
  if !identities.is_empty() {
    values.push((
      "identities".to_string(),
      Value::Array(identities.iter().cloned().map(Value::String).collect()),
    ));
  }
  if let Some(biography) = biography.as_ref() {
    values.push((
      "biography".to_string(),
      Value::String(biography.clone()),
    ));
  }
  if let Some(album_size) = album_size {
    values.push(("album_count".to_string(), Value::from(album_size)));
  }
  if let Some(music_size) = music_size {
    values.push(("song_count".to_string(), Value::from(music_size)));
  }
  if let Some(mv_size) = mv_size {
    values.push(("mv_count".to_string(), Value::from(mv_size)));
  }

  let mut fields = values
    .iter()
    .map(|(key, value)| MetadataCandidateField {
      key: key.clone(),
      label: field_label(key).to_string(),
      value: if key == "biography" {
        candidate_biography(value.as_str().unwrap_or_default())
      } else {
        display_value(value)
      },
    })
    .collect::<Vec<_>>();
  fields.retain(|field| !field.value.trim().is_empty());
  let subtitle = match (album_size, music_size) {
    (Some(albums), Some(songs)) => format!("{albums} 张专辑 · {songs} 首歌曲"),
    (Some(albums), None) => format!("{albums} 张专辑"),
    (None, Some(songs)) => format!("{songs} 首歌曲"),
    (None, None) if aliases.is_empty() => "歌手资料".to_string(),
    (None, None) => aliases.join("、"),
  };
  let source_path = format!("https://music.163.com/#/artist?id={id}");
  NeteaseResolvedCandidate {
    resolved: ResolvedMetadataCandidate {
      candidate: MetadataCandidate {
        id: format!("netease:artist:{id}"),
        kind: MetadataEntityKind::Artist,
        provider_id: NETEASE_ARTIST_PROVIDER_ID.to_string(),
        provider_name: NETEASE_ARTIST_PROVIDER_NAME.to_string(),
        title: name.clone(),
        subtitle,
        source_path,
        confidence,
        fields,
      },
      display_name: name,
      values,
      external_ids: vec![(
        NETEASE_ARTIST_PROVIDER_ID.to_string(),
        id.to_string(),
      )],
    },
    artwork_url,
  }
}

fn candidate_biography(value: &str) -> String {
  let mut output = value
    .trim()
    .chars()
    .take(NETEASE_CANDIDATE_BIOGRAPHY_LIMIT + 1)
    .collect::<String>();
  if output.chars().count() > NETEASE_CANDIDATE_BIOGRAPHY_LIMIT {
    output = output
      .chars()
      .take(NETEASE_CANDIDATE_BIOGRAPHY_LIMIT)
      .collect();
    output.push('…');
  }
  output
}

fn clean_text(value: Option<&str>, limit: usize) -> Option<String> {
  let value = value?.trim();
  if value.is_empty() {
    return None;
  }
  Some(value.chars().take(limit).collect())
}

fn deduplicate_text<'a>(
  values: impl Iterator<Item = &'a str>,
  item_limit: usize,
  text_limit: usize,
) -> Vec<String> {
  let mut seen = HashSet::new();
  values
    .filter_map(|value| clean_text(Some(value), text_limit))
    .filter(|value| seen.insert(value.to_lowercase()))
    .take(item_limit)
    .collect()
}

fn netease_artwork_url(value: &str) -> Option<String> {
  let mut url = Url::parse(value.trim()).ok()?;
  if url.scheme() == "http" {
    url.set_scheme("https").ok()?;
  }
  if url.scheme() != "https" || !url.host_str().is_some_and(is_netease_artwork_host) {
    return None;
  }
  // NetEase distributes the same object across p1/p2/p3. p1 has proven more
  // reliable on mainland dual-stack and fake-IP proxy setups.
  if url.host_str().is_some_and(|host| {
    matches!(
      host.to_ascii_lowercase().as_str(),
      "p1.music.126.net" | "p2.music.126.net" | "p3.music.126.net" | "p4.music.126.net"
    )
  }) {
    url.set_host(Some("p1.music.126.net")).ok()?;
  }
  Some(url.to_string())
}

fn is_netease_artwork_host(host: &str) -> bool {
  let host = host.to_ascii_lowercase();
  host == "music.126.net" || host.ends_with(".music.126.net")
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

  fn detail() -> NeteaseArtistDetail {
    NeteaseArtistDetail {
      id: 3066,
      name: "胡彦斌".to_string(),
      cover: Some("http://p1.music.126.net/artist.jpg".to_string()),
      avatar: None,
      trans_names: Vec::new(),
      alias: vec!["Anson Hu".to_string()],
      identities: vec!["歌手".to_string(), "音乐人".to_string()],
      brief_desc: Some("歌手简介".repeat(200)),
      album_size: Some(39),
      music_size: Some(653),
      mv_size: Some(102),
    }
  }

  #[test]
  fn exact_artist_detail_becomes_a_high_confidence_candidate() {
    let summary = NeteaseArtistSummary {
      id: 3066,
      name: "胡彦斌".to_string(),
      alias: Vec::new(),
      pic_url: None,
      img1v1_url: None,
    };
    let candidate =
      artist_candidate_from_detail("胡彦斌", 100, &summary, detail()).unwrap();
    assert_eq!(candidate.resolved.candidate.confidence, 100);
    assert_eq!(
      candidate.resolved.candidate.provider_id,
      NETEASE_ARTIST_PROVIDER_ID
    );
    assert!(candidate
      .resolved
      .values
      .iter()
      .any(|(key, value)| key == "biography"
        && value.as_str().is_some_and(|value| value.chars().count() > 260)));
    let preview = candidate
      .resolved
      .candidate
      .fields
      .iter()
      .find(|field| field.key == "biography")
      .unwrap();
    assert!(preview.value.ends_with('…'));
  }

  #[test]
  fn artwork_urls_are_upgraded_and_limited_to_netease_hosts() {
    assert_eq!(
      netease_artwork_url("http://p1.music.126.net/artist.jpg").as_deref(),
      Some("https://p1.music.126.net/artist.jpg")
    );
    assert_eq!(
      netease_artwork_url("https://p2.music.126.net/artist.jpg").as_deref(),
      Some("https://p1.music.126.net/artist.jpg")
    );
    assert!(netease_artwork_url("https://example.com/artist.jpg").is_none());
  }

  #[tokio::test]
  async fn netease_artist_live_smoke() {
    if std::env::var("ZONE_METADATA_LIVE").ok().as_deref() != Some("1") {
      eprintln!("requires ZONE_METADATA_LIVE=1 and public internet access");
      return;
    }
    let nonce = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    let root = std::env::temp_dir().join(format!(
      "zone-netease-metadata-live-{}-{nonce}",
      std::process::id()
    ));
    std::fs::create_dir_all(&root).expect("create live test directory");
    let audio_path = root.join("月光.mp3");
    std::fs::write(&audio_path, b"ID3-live-smoke").expect("write audio fixture");
    let state = MetadataState::initialize_at(&root.join("data"))
      .expect("initialize metadata");
    let mut track = input();
    track.path = audio_path.to_string_lossy().to_string();

    let candidates = search_netease_artist_candidates(
      MetadataEntityKind::Artist,
      &[track.clone()],
    )
    .await
    .expect("search NetEase artist");
    let candidate = candidates
      .iter()
      .find(|candidate| candidate.resolved.candidate.title == "胡彦斌")
      .expect("find exact artist candidate");
    assert!(candidate
      .resolved
      .values
      .iter()
      .any(|(key, value)| key == "biography"
        && value.as_str().is_some_and(|value| !value.is_empty())));
    let candidate_id = candidate.resolved.candidate.id.clone();
    apply_netease_artist_candidate(
      &state,
      &candidate_id,
      MetadataEntityKind::Artist,
      &[track],
    )
    .await
    .expect("apply NetEase artist candidate");

    let context = read_context_metadata(
      &state,
      MetadataEntityKind::Artist,
      &["track-1".to_string()],
    )
    .expect("read applied context")
    .expect("artist context");
    assert!(context.fields.iter().any(|field| field.key == "biography"));
    assert!(context.fields.iter().any(|field| {
      field.key == "artist_image_path" && Path::new(&field.value).is_file()
    }));
    std::fs::remove_dir_all(root).expect("cleanup live test directory");
  }
}
