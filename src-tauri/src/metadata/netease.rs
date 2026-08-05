use super::*;
use crate::podcast::{read_limited, send_public_get};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

#[cfg(test)]
use std::path::Path;
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const NETEASE_MUSIC_PROVIDER_ID: &str = "netease-music";
pub(crate) const NETEASE_MUSIC_PROVIDER_NAME: &str = "网易云音乐";

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
  songs: Vec<NeteaseSongSummary>,
  #[serde(default)]
  albums: Vec<NeteaseAlbumSummary>,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NeteaseAlbumSummary {
  id: i64,
  name: String,
  #[serde(default)]
  alias: Vec<String>,
  pic_url: Option<String>,
  publish_time: Option<i64>,
  size: Option<u32>,
  artist: Option<NeteaseArtistSummary>,
  #[serde(default)]
  artists: Vec<NeteaseArtistSummary>,
  description: Option<String>,
  brief_desc: Option<String>,
  tags: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum NeteaseDiscNumber {
  Number(u32),
  Text(String),
}

impl NeteaseDiscNumber {
  fn value(&self) -> Option<u32> {
    match self {
      Self::Number(value) => Some(*value),
      Self::Text(value) => value.trim().parse().ok(),
    }
    .filter(|value| *value > 0)
  }
}

#[derive(Clone, Debug, Deserialize)]
struct NeteaseSongSummary {
  id: i64,
  name: String,
  #[serde(default)]
  artists: Vec<NeteaseArtistSummary>,
  album: Option<NeteaseAlbumSummary>,
  duration: Option<u64>,
  no: Option<u32>,
  disc: Option<NeteaseDiscNumber>,
}

#[derive(Debug, Deserialize)]
struct NeteaseSongDetailResponse {
  code: i32,
  #[serde(default)]
  songs: Vec<NeteaseSongSummary>,
}

#[derive(Debug, Deserialize)]
struct NeteaseAlbumDetailResponse {
  code: i32,
  album: Option<NeteaseAlbumSummary>,
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
  artwork_urls: Vec<String>,
}

pub(crate) async fn search_netease_music_candidates(
  kind: MetadataEntityKind,
  tracks: &[MetadataTrackInput],
) -> Result<Vec<NeteaseResolvedCandidate>, String> {
  validate_metadata_tracks(tracks)?;
  match kind {
    MetadataEntityKind::Track => search_track_candidates(&tracks[0]).await,
    MetadataEntityKind::Album => search_album_candidates(tracks).await,
    MetadataEntityKind::Artist => search_artist_candidates(&tracks[0]).await,
  }
}

pub(crate) async fn apply_netease_music_candidate(
  state: &MetadataState,
  candidate_id: &str,
  kind: MetadataEntityKind,
  tracks: &[MetadataTrackInput],
) -> Result<(), String> {
  state.ensure_ready()?;
  validate_metadata_tracks(tracks)?;
  let mut candidate = match kind {
    MetadataEntityKind::Track => {
      let id = parse_candidate_id(candidate_id, "netease:track:", "歌曲")?;
      let song = request_netease_song_detail(id).await?;
      track_candidate(&tracks[0], song)
    }
    MetadataEntityKind::Album => {
      let id = parse_candidate_id(candidate_id, "netease:album:", "专辑")?;
      let verified = search_album_candidates(tracks)
        .await?
        .into_iter()
        .find(|candidate| candidate.resolved.candidate.id == candidate_id)
        .ok_or_else(|| "网易云专辑候选已变化，请重新查找".to_string())?;
      let album = request_netease_album_detail(id).await?;
      album_candidate_with_confidence(
        album,
        verified.resolved.candidate.confidence,
      )
    }
    MetadataEntityKind::Artist => {
      let id = parse_candidate_id(candidate_id, "netease:artist:", "歌手")?;
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
      artist_candidate_from_detail(
        &tracks[0].artist,
        confidence,
        &summary,
        detail,
      )
    }
  }
  .filter(|candidate| candidate.resolved.candidate.id == candidate_id)
  .ok_or_else(|| "网易云音乐候选已变化，请重新查找".to_string())?;

  let mut artwork_paths = Vec::new();
  let artwork_limit = if kind == MetadataEntityKind::Artist { 6 } else { 1 };
  for artwork_url in candidate.artwork_urls.iter().take(artwork_limit) {
    let label = match kind {
      MetadataEntityKind::Artist => "网易云歌手图片",
      MetadataEntityKind::Track | MetadataEntityKind::Album => "网易云专辑封面",
    };
    match cache_provider_artwork(
      state.artwork_cache_dir(),
      artwork_url,
      label,
      is_netease_artwork_host,
    )
    .await
    {
      Ok(path) => artwork_paths.push(path.to_string_lossy().to_string()),
      Err(error) => eprintln!("[metadata:netease] artwork cache failed: {error}"),
    }
  }
  if kind == MetadataEntityKind::Artist && !artwork_paths.is_empty() {
    candidate.resolved.values.push((
      "artist_image_paths".to_string(),
      Value::Array(artwork_paths.into_iter().map(Value::String).collect()),
    ));
  } else if let Some(path) = artwork_paths.into_iter().next() {
    candidate.resolved.values.push((
      "album_cover_path".to_string(),
      Value::String(path),
    ));
  }

  persist_metadata_candidate(state, &candidate.resolved, tracks)
}

async fn search_track_candidates(
  track: &MetadataTrackInput,
) -> Result<Vec<NeteaseResolvedCandidate>, String> {
  let specific_query = search_term(&[&track.title, &track.artist]);
  let mut songs = request_netease_search(&specific_query, "1", "歌曲").await?.songs;
  let mut candidates = songs
    .drain(..)
    .filter_map(|song| track_candidate(track, song))
    .collect::<Vec<_>>();
  if candidates.is_empty() {
    let broad_query = search_term(&[&track.title]);
    if broad_query != specific_query {
      candidates = request_netease_search(&broad_query, "1", "歌曲")
        .await?
        .songs
        .into_iter()
        .filter_map(|song| track_candidate(track, song))
        .collect();
    }
  }
  Ok(deduplicate_candidates(candidates))
}

async fn search_album_candidates(
  tracks: &[MetadataTrackInput],
) -> Result<Vec<NeteaseResolvedCandidate>, String> {
  let first = &tracks[0];
  let album_artist = first
    .album_artist
    .as_deref()
    .filter(|value| !is_unknown_label(value))
    .unwrap_or(&first.artist);
  let query = search_term(&[&first.album, album_artist]);
  let mut candidates = if query.is_empty() || is_unknown_label(&first.album) {
    Vec::new()
  } else {
    request_netease_search(&query, "10", "专辑")
      .await?
      .albums
      .into_iter()
      .filter_map(|album| album_candidate(first, album))
      .collect()
  };
  if candidates
    .iter()
    .any(|candidate| candidate.resolved.candidate.confidence >= 82)
  {
    return Ok(deduplicate_candidates(candidates));
  }

  let track_query = search_term(&[&first.title, &first.artist]);
  if !track_query.is_empty() {
    candidates.extend(
      request_netease_search(&track_query, "1", "歌曲")
        .await?
        .songs
        .into_iter()
        .filter_map(|song| derived_album_candidate(first, song)),
    );
  }
  Ok(deduplicate_candidates(candidates))
}

async fn search_artist_candidates(
  track: &MetadataTrackInput,
) -> Result<Vec<NeteaseResolvedCandidate>, String> {
  let artist = track.artist.trim();
  if artist.is_empty() || artist.chars().count() > 4_096 {
    return Err("网易云歌手搜索内容无效".to_string());
  }

  let summaries = request_netease_search(artist, "100", "歌手")
    .await?
    .artists;
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

fn parse_candidate_id(
  candidate_id: &str,
  prefix: &str,
  label: &str,
) -> Result<i64, String> {
  candidate_id
    .strip_prefix(prefix)
    .and_then(|value| value.parse::<i64>().ok())
    .filter(|value| *value > 0)
    .ok_or_else(|| format!("网易云{label}候选标识无效"))
}

async fn request_netease_search(
  query: &str,
  search_type: &str,
  label: &str,
) -> Result<NeteaseSearchResult, String> {
  if query.is_empty() || query.chars().count() > 500 {
    return Err(format!("网易云{label}搜索内容无效"));
  }
  if !matches!(search_type, "1" | "10" | "100") {
    return Err("网易云搜索类型无效".to_string());
  }
  let mut url = Url::parse("https://music.163.com/api/search/get/web")
    .map_err(|_| format!("无法构造网易云{label}搜索地址"))?;
  url
    .query_pairs_mut()
    .append_pair("csrf_token", "")
    .append_pair("s", query)
    .append_pair("type", search_type)
    .append_pair("limit", &NETEASE_SEARCH_LIMIT.to_string())
    .append_pair("offset", "0")
    .append_pair("total", "true");
  let request_label = format!("网易云{label}搜索");
  let response = request_netease_json::<NeteaseSearchResponse>(
    url,
    "/api/search/get/web",
    &request_label,
  )
  .await?;
  if response.code != 200 {
    return Err(format!("网易云{label}搜索返回错误 {}", response.code));
  }
  Ok(response.result.unwrap_or(NeteaseSearchResult {
    songs: Vec::new(),
    albums: Vec::new(),
    artists: Vec::new(),
  }))
}

async fn request_netease_song_detail(id: i64) -> Result<NeteaseSongSummary, String> {
  if id <= 0 {
    return Err("网易云歌曲标识无效".to_string());
  }
  let mut url = Url::parse("https://music.163.com/api/song/detail")
    .map_err(|_| "无法构造网易云歌曲资料地址".to_string())?;
  url
    .query_pairs_mut()
    .append_pair("ids", &format!("[{id}]"));
  let response = request_netease_json_once::<NeteaseSongDetailResponse>(
    url,
    "/api/song/detail",
    "网易云歌曲资料",
  )
  .await?;
  if response.code != 200 {
    return Err(format!("网易云歌曲资料返回错误 {}", response.code));
  }
  response
    .songs
    .into_iter()
    .find(|song| song.id == id)
    .ok_or_else(|| "网易云歌曲资料缺少曲目信息".to_string())
}

async fn request_netease_album_detail(id: i64) -> Result<NeteaseAlbumSummary, String> {
  if id <= 0 {
    return Err("网易云专辑标识无效".to_string());
  }
  let path = format!("/api/v1/album/{id}");
  let url = Url::parse(&format!("https://music.163.com{path}"))
    .map_err(|_| "无法构造网易云专辑资料地址".to_string())?;
  let response = request_netease_json_once::<NeteaseAlbumDetailResponse>(
    url,
    &path,
    "网易云专辑资料",
  )
  .await?;
  if response.code != 200 {
    return Err(format!("网易云专辑资料返回错误 {}", response.code));
  }
  response
    .album
    .filter(|album| album.id == id)
    .ok_or_else(|| "网易云专辑资料缺少专辑信息".to_string())
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

fn track_candidate(
  track: &MetadataTrackInput,
  song: NeteaseSongSummary,
) -> Option<NeteaseResolvedCandidate> {
  let title = clean_text(Some(&song.name), 4_096)?;
  let artists = artist_names(&song.artists);
  let artist = artists.join(" / ");
  if artist.is_empty() {
    return None;
  }
  let album = song
    .album
    .as_ref()
    .and_then(|album| clean_text(Some(&album.name), 4_096))?;
  let album_artist = song
    .album
    .as_ref()
    .map(album_artist_names)
    .filter(|artists| !artists.is_empty())
    .map(|artists| artists.join(" / "))
    .unwrap_or_else(|| artist.clone());
  let confidence = track_match_confidence(track, &title, &song.artists, &album, song.duration);
  if confidence < 60 {
    return None;
  }

  let mut values = vec![
    ("title".to_string(), Value::String(title.clone())),
    ("artist".to_string(), Value::String(artist.clone())),
    ("album".to_string(), Value::String(album.clone())),
    (
      "album_artist".to_string(),
      Value::String(album_artist),
    ),
  ];
  if let Some(year) = song
    .album
    .as_ref()
    .and_then(|album| album.publish_time)
    .and_then(year_from_unix_millis)
  {
    values.push(("year".to_string(), Value::from(year)));
  }
  if let Some(track_number) = song.no.filter(|value| *value > 0) {
    values.push(("track_number".to_string(), Value::from(track_number)));
  }
  if let Some(disc_number) = song.disc.as_ref().and_then(NeteaseDiscNumber::value) {
    values.push(("disc_number".to_string(), Value::from(disc_number)));
  }

  let album_id = song.album.as_ref().map(|album| album.id);
  let artwork_urls = song
    .album
    .as_ref()
    .and_then(|album| album.pic_url.as_deref())
    .and_then(netease_artwork_url)
    .into_iter()
    .collect();
  Some(NeteaseResolvedCandidate {
    resolved: ResolvedMetadataCandidate {
      candidate: metadata_candidate(
        MetadataEntityKind::Track,
        format!("netease:track:{}", song.id),
        title.clone(),
        format!("{artist} · {album}"),
        format!("https://music.163.com/#/song?id={}", song.id),
        confidence,
        &values,
      ),
      display_name: title,
      values,
      external_ids: netease_external_ids(
        Some(song.id),
        album_id,
        song.artists.first().map(|artist| artist.id),
      ),
    },
    artwork_urls,
  })
}

fn album_candidate(
  track: &MetadataTrackInput,
  album: NeteaseAlbumSummary,
) -> Option<NeteaseResolvedCandidate> {
  let title = clean_text(Some(&album.name), 4_096)?;
  let artists = album_artist_names(&album);
  let artist = artists.join(" / ");
  if artist.is_empty() {
    return None;
  }
  let confidence = album_match_confidence(track, &title, &album.alias, &album, &artists);
  if confidence < 60 {
    return None;
  }
  album_candidate_with_confidence(album, confidence)
}

fn album_candidate_with_confidence(
  album: NeteaseAlbumSummary,
  confidence: u8,
) -> Option<NeteaseResolvedCandidate> {
  let title = clean_text(Some(&album.name), 4_096)?;
  let artists = album_artist_names(&album);
  let artist = artists.join(" / ");
  if artist.is_empty() || confidence < 60 {
    return None;
  }
  let mut values = vec![
    ("title".to_string(), Value::String(title.clone())),
    ("artist".to_string(), Value::String(artist.clone())),
  ];
  if let Some(year) = album.publish_time.and_then(year_from_unix_millis) {
    values.push(("year".to_string(), Value::from(year)));
  }
  let genres = split_tags(album.tags.as_deref());
  if !genres.is_empty() {
    values.push((
      "genres".to_string(),
      Value::Array(genres.into_iter().map(Value::String).collect()),
    ));
  }
  if let Some(description) = clean_text(
    album.description.as_deref().or(album.brief_desc.as_deref()),
    NETEASE_BIOGRAPHY_LIMIT,
  ) {
    values.push(("description".to_string(), Value::String(description)));
  }

  let artwork_urls = album
    .pic_url
    .as_deref()
    .and_then(netease_artwork_url)
    .into_iter()
    .collect();
  let subtitle = match album.size {
    Some(size) => format!("{artist} · {size} 首歌曲"),
    None => artist.clone(),
  };
  Some(NeteaseResolvedCandidate {
    resolved: ResolvedMetadataCandidate {
      candidate: metadata_candidate(
        MetadataEntityKind::Album,
        format!("netease:album:{}", album.id),
        title.clone(),
        subtitle,
        format!("https://music.163.com/#/album?id={}", album.id),
        confidence,
        &values,
      ),
      display_name: title,
      values,
      external_ids: netease_external_ids(
        None,
        Some(album.id),
        album
          .artist
          .as_ref()
          .filter(|artist| artist.id > 0)
          .map(|artist| artist.id)
          .or_else(|| album.artists.first().map(|artist| artist.id)),
      ),
    },
    artwork_urls,
  })
}

fn derived_album_candidate(
  track: &MetadataTrackInput,
  song: NeteaseSongSummary,
) -> Option<NeteaseResolvedCandidate> {
  let matched_title = clean_text(Some(&song.name), 4_096)?;
  let mut album = song.album?;
  let album_name = clean_text(Some(&album.name), 4_096)?;
  let title_score = text_similarity(&track.title, &matched_title);
  if title_score < 75 {
    return None;
  }
  let artist_score = song
    .artists
    .iter()
    .map(|artist| artist_match_confidence(&track.artist, &artist.name, &artist.alias))
    .max()
    .unwrap_or(0);
  let album_score = if is_unknown_label(&track.album) {
    0
  } else {
    text_similarity(&track.album, &album_name)
  };
  let duration_score = duration_similarity(track.duration_seconds, song.duration);
  let confidence = ((title_score as u16 * 45
    + artist_score as u16 * 20
    + album_score as u16 * 25
    + duration_score as u16 * 10)
    / 100)
    .min(100) as u8;
  if album_artist_names(&album).is_empty() {
    album.artist = song.artists.first().cloned();
    album.artists = song.artists;
  }
  album_candidate_with_confidence(album, confidence)
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
    provider_id: NETEASE_MUSIC_PROVIDER_ID.to_string(),
    provider_name: NETEASE_MUSIC_PROVIDER_NAME.to_string(),
    title,
    subtitle,
    source_path,
    confidence,
    fields: values
      .iter()
      .map(|(key, value)| MetadataCandidateField {
        key: key.clone(),
        label: field_label(key).to_string(),
        value: if matches!(key.as_str(), "description" | "biography") {
          candidate_biography(value.as_str().unwrap_or_default())
        } else {
          display_value(value)
        },
      })
      .filter(|field| !field.value.trim().is_empty())
      .collect(),
  }
}

fn netease_external_ids(
  track_id: Option<i64>,
  album_id: Option<i64>,
  artist_id: Option<i64>,
) -> Vec<(String, String)> {
  let mut ids = Vec::new();
  if let Some(id) = track_id.filter(|id| *id > 0) {
    ids.push(("netease-track".to_string(), id.to_string()));
  }
  if let Some(id) = album_id.filter(|id| *id > 0) {
    ids.push(("netease-album".to_string(), id.to_string()));
  }
  if let Some(id) = artist_id.filter(|id| *id > 0) {
    ids.push(("netease-artist".to_string(), id.to_string()));
  }
  ids
}

fn track_match_confidence(
  track: &MetadataTrackInput,
  title: &str,
  artists: &[NeteaseArtistSummary],
  album: &str,
  duration_millis: Option<u64>,
) -> u8 {
  let title_score = text_similarity(&track.title, title);
  if title_score < 70 {
    return 0;
  }
  let artist_score = artists
    .iter()
    .map(|artist| artist_match_confidence(&track.artist, &artist.name, &artist.alias))
    .max()
    .unwrap_or(0);
  let album_score = if is_unknown_label(&track.album) {
    0
  } else {
    text_similarity(&track.album, album)
  };
  let duration_score = duration_similarity(track.duration_seconds, duration_millis);
  ((title_score as u16 * 55
    + artist_score as u16 * 25
    + album_score as u16 * 10
    + duration_score as u16 * 10)
    / 100)
    .min(100) as u8
}

fn album_match_confidence(
  track: &MetadataTrackInput,
  title: &str,
  aliases: &[String],
  album: &NeteaseAlbumSummary,
  artists: &[String],
) -> u8 {
  let album_score = std::iter::once(title)
    .chain(aliases.iter().map(String::as_str))
    .map(|value| text_similarity(&track.album, value))
    .max()
    .unwrap_or(0);
  if album_score < 60 {
    return 0;
  }
  let local_artist = track.album_artist.as_deref().unwrap_or(&track.artist);
  let artist_score = artists
    .iter()
    .map(|artist| text_similarity(local_artist, artist))
    .max()
    .unwrap_or(0);
  let year_score = match (
    track.year,
    album.publish_time.and_then(year_from_unix_millis),
  ) {
    (Some(left), Some(right)) if left == right => 100,
    (Some(_), Some(_)) => 0,
    _ => 50,
  };
  ((album_score as u16 * 65 + artist_score as u16 * 30 + year_score as u16 * 5) / 100)
    .min(100) as u8
}

fn duration_similarity(local_seconds: Option<u64>, remote_millis: Option<u64>) -> u8 {
  let (Some(local), Some(remote)) = (local_seconds, remote_millis) else {
    return 50;
  };
  match local.abs_diff(remote / 1_000) {
    0..=3 => 100,
    4..=10 => 70,
    11..=30 => 30,
    _ => 0,
  }
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

fn artist_names(artists: &[NeteaseArtistSummary]) -> Vec<String> {
  deduplicate_text(artists.iter().map(|artist| artist.name.as_str()), 32, 4_096)
}

fn album_artist_names(album: &NeteaseAlbumSummary) -> Vec<String> {
  let primary = album
    .artist
    .iter()
    .filter(|artist| artist.id > 0)
    .map(|artist| artist.name.as_str());
  deduplicate_text(
    primary.chain(album.artists.iter().map(|artist| artist.name.as_str())),
    32,
    4_096,
  )
}

fn split_tags(value: Option<&str>) -> Vec<String> {
  let Some(value) = value else {
    return Vec::new();
  };
  deduplicate_text(
    value.split([',', '，', ';', '；', '/']).map(str::trim),
    16,
    200,
  )
}

fn year_from_unix_millis(value: i64) -> Option<u32> {
  if value < 0 {
    return None;
  }
  let days = value / 86_400_000;
  let z = days + 719_468;
  let era = z / 146_097;
  let day_of_era = z - era * 146_097;
  let year_of_era =
    (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096)
      / 365;
  let mut year = year_of_era + era * 400;
  let day_of_year = day_of_era
    - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  let month_position = (5 * day_of_year + 2) / 153;
  let month = month_position + if month_position < 10 { 3 } else { -9 };
  if month <= 2 {
    year += 1;
  }
  u32::try_from(year)
    .ok()
    .filter(|year| (1..=9_999).contains(year))
}

fn deduplicate_candidates(
  candidates: Vec<NeteaseResolvedCandidate>,
) -> Vec<NeteaseResolvedCandidate> {
  let mut by_id = HashMap::new();
  for candidate in candidates {
    let id = candidate.resolved.candidate.id.clone();
    let should_replace = by_id
      .get(&id)
      .is_none_or(|current: &NeteaseResolvedCandidate| {
        candidate.resolved.candidate.confidence > current.resolved.candidate.confidence
      });
    if should_replace {
      by_id.insert(id, candidate);
    }
  }
  let mut candidates = by_id.into_values().collect::<Vec<_>>();
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
  candidates.truncate(NETEASE_CANDIDATE_LIMIT);
  candidates
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
  let artwork_urls = collect_netease_artwork_urls(&[
    detail.cover.as_deref(),
    detail.avatar.as_deref(),
    summary.pic_url.as_deref(),
    summary.img1v1_url.as_deref(),
  ]);
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
    artwork_urls,
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
  let artwork_urls = collect_netease_artwork_urls(&[
    summary.pic_url.as_deref(),
    summary.img1v1_url.as_deref(),
  ]);
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
    artwork_urls,
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
  artwork_urls: Vec<String>,
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
        provider_id: NETEASE_MUSIC_PROVIDER_ID.to_string(),
        provider_name: NETEASE_MUSIC_PROVIDER_NAME.to_string(),
        title: name.clone(),
        subtitle,
        source_path,
        confidence,
        fields,
      },
      display_name: name,
      values,
      external_ids: vec![(
        "netease-artist".to_string(),
        id.to_string(),
      )],
    },
    artwork_urls,
  }
}

fn collect_netease_artwork_urls(values: &[Option<&str>]) -> Vec<String> {
  let mut seen = HashSet::new();
  values
    .iter()
    .filter_map(|value| value.and_then(netease_artwork_url))
    .filter(|url| seen.insert(url.clone()))
    .take(6)
    .collect()
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

  fn artist_summary(id: i64, name: &str) -> NeteaseArtistSummary {
    NeteaseArtistSummary {
      id,
      name: name.to_string(),
      alias: Vec::new(),
      pic_url: None,
      img1v1_url: None,
    }
  }

  fn album_summary(
    id: i64,
    name: &str,
    artist: NeteaseArtistSummary,
  ) -> NeteaseAlbumSummary {
    NeteaseAlbumSummary {
      id,
      name: name.to_string(),
      alias: Vec::new(),
      pic_url: Some("https://p2.music.126.net/album.jpg".to_string()),
      publish_time: Some(1_000_396_800_000),
      size: Some(10),
      artist: Some(artist.clone()),
      artists: vec![artist],
      description: None,
      brief_desc: None,
      tags: None,
    }
  }

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
    let summary = artist_summary(3066, "胡彦斌");
    let candidate =
      artist_candidate_from_detail("胡彦斌", 100, &summary, detail()).unwrap();
    assert_eq!(candidate.resolved.candidate.confidence, 100);
    assert_eq!(
      candidate.resolved.candidate.provider_id,
      NETEASE_MUSIC_PROVIDER_ID
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
  fn exact_track_includes_release_and_order_fields() {
    let artist = artist_summary(3066, "胡彦斌");
    let mut album = album_summary(34766097, "靓声天王", artist.clone());
    album.publish_time = Some(1_466_611_200_000);
    let song = NeteaseSongSummary {
      id: 419827614,
      name: "月光".to_string(),
      artists: vec![artist],
      album: Some(album),
      duration: Some(272_026),
      no: Some(15),
      disc: Some(NeteaseDiscNumber::Text("1".to_string())),
    };
    let candidate = track_candidate(&input(), song).expect("track candidate");
    assert_eq!(candidate.resolved.candidate.confidence, 90);
    assert_eq!(
      candidate.resolved.candidate.provider_id,
      NETEASE_MUSIC_PROVIDER_ID
    );
    assert!(candidate
      .resolved
      .values
      .iter()
      .any(|(key, value)| key == "year" && value.as_u64() == Some(2016)));
    assert!(candidate
      .resolved
      .values
      .iter()
      .any(|(key, value)| key == "track_number" && value.as_u64() == Some(15)));
    assert_eq!(
      candidate.artwork_urls,
      ["https://p1.music.126.net/album.jpg"]
    );
  }

  #[test]
  fn exact_album_includes_year_and_description() {
    let artist = artist_summary(6452, "周杰伦");
    let mut album = album_summary(18915, "范特西", artist);
    album.alias = vec!["Fantasy".to_string()];
    album.description = Some("周杰伦第二张录音室专辑".to_string());
    let mut track = input();
    track.title = "爱在西元前".to_string();
    track.artist = "周杰伦".to_string();
    track.album = "范特西".to_string();
    track.album_artist = Some("周杰伦".to_string());
    track.year = Some(2001);
    let candidate = album_candidate(&track, album).expect("album candidate");
    assert_eq!(candidate.resolved.candidate.confidence, 100);
    assert_eq!(candidate.resolved.candidate.id, "netease:album:18915");
    assert!(candidate
      .resolved
      .values
      .iter()
      .any(|(key, value)| key == "description"
        && value.as_str() == Some("周杰伦第二张录音室专辑")));
  }

  #[test]
  fn track_match_can_recover_an_unknown_album() {
    let artist = artist_summary(3066, "胡彦斌");
    let mut album = album_summary(34766097, "靓声天王", artist_summary(0, ""));
    album.artist = None;
    album.artists.clear();
    let song = NeteaseSongSummary {
      id: 419827614,
      name: "月光".to_string(),
      artists: vec![artist],
      album: Some(album),
      duration: Some(272_026),
      no: None,
      disc: None,
    };
    let candidate = derived_album_candidate(&input(), song).expect("derived album");
    assert_eq!(candidate.resolved.candidate.title, "靓声天王");
    assert_eq!(candidate.resolved.candidate.confidence, 75);
    assert!(candidate
      .resolved
      .values
      .iter()
      .any(|(key, value)| key == "artist" && value.as_str() == Some("胡彦斌")));
  }

  #[test]
  fn unix_milliseconds_are_converted_to_release_year() {
    assert_eq!(year_from_unix_millis(0), Some(1970));
    assert_eq!(year_from_unix_millis(1_000_396_800_000), Some(2001));
    assert_eq!(year_from_unix_millis(1_466_611_200_000), Some(2016));
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
  async fn netease_music_live_smoke() {
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

    let track_candidates = search_netease_music_candidates(
      MetadataEntityKind::Track,
      &[track.clone()],
    )
    .await
    .expect("search NetEase track");
    let track_candidate = track_candidates
      .iter()
      .find(|candidate| candidate.resolved.candidate.title == "月光")
      .expect("find exact track candidate");
    let track_candidate_id = track_candidate.resolved.candidate.id.clone();
    apply_netease_music_candidate(
      &state,
      &track_candidate_id,
      MetadataEntityKind::Track,
      &[track.clone()],
    )
    .await
    .expect("apply NetEase track candidate");
    let track_context = read_context_metadata(
      &state,
      MetadataEntityKind::Track,
      &["track-1".to_string()],
    )
    .expect("read applied track context")
    .expect("track context");
    assert!(track_context.fields.iter().any(|field| {
      field.key == "album_cover_path" && Path::new(&field.value).is_file()
    }));

    let album_audio_path = root.join("范特西.mp3");
    std::fs::write(&album_audio_path, b"ID3-live-smoke").expect("write album fixture");
    let mut album_track = input();
    album_track.id = "track-2".to_string();
    album_track.path = album_audio_path.to_string_lossy().to_string();
    album_track.title = "爱在西元前".to_string();
    album_track.artist = "周杰伦".to_string();
    album_track.album = "范特西".to_string();
    album_track.album_artist = Some("周杰伦".to_string());
    album_track.year = Some(2001);
    let album_candidates = search_netease_music_candidates(
      MetadataEntityKind::Album,
      &[album_track.clone()],
    )
    .await
    .expect("search NetEase album");
    let album_candidate = album_candidates
      .iter()
      .find(|candidate| candidate.resolved.candidate.title == "范特西")
      .expect("find exact album candidate");
    let album_candidate_id = album_candidate.resolved.candidate.id.clone();
    apply_netease_music_candidate(
      &state,
      &album_candidate_id,
      MetadataEntityKind::Album,
      &[album_track],
    )
    .await
    .expect("apply NetEase album candidate");
    let album_context = read_context_metadata(
      &state,
      MetadataEntityKind::Album,
      &["track-2".to_string()],
    )
    .expect("read applied album context")
    .expect("album context");
    assert!(album_context.fields.iter().any(|field| {
      field.key == "album_cover_path" && Path::new(&field.value).is_file()
    }));

    let candidates = search_netease_music_candidates(
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
    apply_netease_music_candidate(
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
