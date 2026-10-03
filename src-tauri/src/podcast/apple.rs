use reqwest::Url;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppleSearchResponse {
  pub(crate) results: Vec<AppleSearchItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppleSearchItem {
  pub(crate) collection_id: Option<i64>,
  pub(crate) collection_name: Option<String>,
  pub(crate) artist_name: Option<String>,
  pub(crate) feed_url: Option<String>,
  pub(crate) artwork_url_600: Option<String>,
  pub(crate) artwork_url_100: Option<String>,
  pub(crate) track_count: Option<u32>,
  #[serde(default)]
  pub(crate) genres: Vec<String>,
  pub(crate) primary_genre_name: Option<String>,
  pub(crate) release_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AppleDiscoveryResponse {
  pub(crate) feed: AppleDiscoveryFeed,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AppleDiscoveryFeed {
  pub(crate) results: Vec<AppleDiscoveryItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppleDiscoveryItem {
  pub(crate) id: String,
  pub(crate) name: String,
  pub(crate) artist_name: String,
  pub(crate) artwork_url_100: Option<String>,
  #[serde(default)]
  pub(crate) genres: Vec<AppleDiscoveryGenre>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AppleDiscoveryGenre {
  pub(crate) name: String,
}
pub(crate) async fn search_apple_cn(query: &str, requested_limit: u8) -> Result<Vec<PodcastSearchResult>, String> {
  let query = query.trim();
  if query.is_empty() || query.chars().count() > 200 {
    return Err("播客搜索内容无效".to_string());
  }
  let limit = requested_limit.clamp(1, 25);
  let mut url = Url::parse("https://itunes.apple.com/search").map_err(|_| "无法构造 Apple 播客搜索地址".to_string())?;
  url
    .query_pairs_mut()
    .append_pair("country", "CN")
    .append_pair("media", "podcast")
    .append_pair("entity", "podcast")
    .append_pair("limit", &limit.to_string())
    .append_pair("term", query);

  let bytes = request_apple_json(url, APPLE_SEARCH_RESPONSE_LIMIT, "Apple 播客搜索").await?;
  let response =
    serde_json::from_slice::<AppleSearchResponse>(&bytes).map_err(|_| "Apple 播客搜索结果格式无效".to_string())?;
  Ok(
    response
      .results
      .into_iter()
      .filter_map(apple_search_result_from_item)
      .collect(),
  )
}

fn apple_search_result_from_item(item: AppleSearchItem) -> Option<PodcastSearchResult> {
  let feed_url = clean_optional(item.feed_url, 4_096)?;
  if validate_public_url_shape(&feed_url).is_err() {
    return None;
  }
  let title = clean_optional(item.collection_name, PODCAST_TITLE_LIMIT).unwrap_or_else(|| "未命名播客".to_string());
  let author = clean_optional(item.artist_name, PODCAST_TITLE_LIMIT).unwrap_or_default();
  let id = item
    .collection_id
    .map(|value| value.to_string())
    .unwrap_or_else(|| hash_identifier("apple", &[&feed_url]));
  let genres = normalize_apple_search_genres(item.genres, item.primary_genre_name);
  let latest_release_at = item.release_date.as_deref().and_then(parse_iso8601_millis);
  Some(PodcastSearchResult {
    id,
    title,
    author,
    feed_url,
    artwork_url: clean_optional(item.artwork_url_600.or(item.artwork_url_100), 4_096),
    episode_count: item.track_count,
    genres,
    latest_release_at,
  })
}

fn normalize_apple_search_genres(genres: Vec<String>, primary_genre_name: Option<String>) -> Vec<String> {
  let mut normalized = Vec::new();
  let mut seen = HashSet::new();
  for genre in genres.into_iter().chain(primary_genre_name) {
    let Some(genre) = clean_text(&genre, 100) else {
      continue;
    };
    if genre.eq_ignore_ascii_case("podcasts") || genre == "播客" {
      continue;
    }
    if seen.insert(genre.to_lowercase()) {
      normalized.push(genre);
    }
  }
  normalized
}
pub(crate) async fn browse_apple_cn(requested_limit: u8) -> Result<Vec<PodcastDiscoveryShow>, String> {
  let limit = requested_limit.clamp(1, APPLE_DISCOVERY_MAX_RESULTS);
  let chart_url = Url::parse(&apple_chart_url(limit))
  .map_err(|_| "无法构造 Apple 播客榜单地址".to_string())?;
  let chart_bytes = request_apple_json(chart_url, APPLE_DISCOVERY_RESPONSE_LIMIT, "Apple 播客榜单").await?;
  let chart = serde_json::from_slice::<AppleDiscoveryResponse>(&chart_bytes)
    .map_err(|_| "Apple 播客榜单格式无效".to_string())?;
  let ids = chart
    .feed
    .results
    .iter()
    .take(limit as usize)
    .filter_map(|item| valid_apple_catalog_id(&item.id))
    .collect::<Vec<_>>();
  if ids.is_empty() {
    return Err("Apple 播客榜单没有可用节目".to_string());
  }

  let mut lookup_url =
    Url::parse("https://itunes.apple.com/lookup").map_err(|_| "无法构造 Apple 播客查询地址".to_string())?;
  lookup_url
    .query_pairs_mut()
    .append_pair("country", "CN")
    .append_pair("id", &ids.join(","));
  let lookup_bytes = request_apple_json(lookup_url, APPLE_SEARCH_RESPONSE_LIMIT, "Apple 播客目录查询").await?;
  parse_apple_discovery(chart, &lookup_bytes, limit)
}

fn apple_chart_url(limit: u8) -> String {
  let feed_limit = if limit <= 25 { 25 } else { 50 };
  format!("https://rss.marketingtools.apple.com/api/v2/cn/podcasts/top/{feed_limit}/podcasts.json")
}

async fn request_apple_json(url: Url, limit: usize, label: &str) -> Result<Vec<u8>, String> {
  with_network_retries(Duration::from_secs(15), || with_network_limit(NetworkClass::Metadata, async {
    let response = send_public_get(url.clone(), Duration::from_secs(15), None).await?;
    read_limited(response.response, limit, label).await
  })).await
}

fn parse_apple_discovery(
  chart: AppleDiscoveryResponse,
  lookup_bytes: &[u8],
  limit: u8,
) -> Result<Vec<PodcastDiscoveryShow>, String> {
  let lookup = serde_json::from_slice::<AppleSearchResponse>(lookup_bytes)
    .map_err(|_| "Apple 播客目录查询结果格式无效".to_string())?;
  let lookup_by_id = lookup
    .results
    .into_iter()
    .filter_map(|item| item.collection_id.map(|id| (id.to_string(), item)))
    .collect::<HashMap<_, _>>();

  let mut shows = Vec::new();
  for (index, item) in chart.feed.results.into_iter().take(limit as usize).enumerate() {
    let Some(id) = valid_apple_catalog_id(&item.id) else {
      continue;
    };
    let Some(lookup_item) = lookup_by_id.get(id) else {
      continue;
    };
    let Some(feed_url) = lookup_item.feed_url.as_deref().and_then(clean_url_string) else {
      continue;
    };
    let title = clean_text(&item.name, PODCAST_TITLE_LIMIT)
      .or_else(|| {
        lookup_item
          .collection_name
          .as_deref()
          .and_then(|value| clean_text(value, PODCAST_TITLE_LIMIT))
      })
      .unwrap_or_else(|| "未命名播客".to_string());
    let author = clean_text(&item.artist_name, PODCAST_TITLE_LIMIT)
      .or_else(|| {
        lookup_item
          .artist_name
          .as_deref()
          .and_then(|value| clean_text(value, PODCAST_TITLE_LIMIT))
      })
      .unwrap_or_default();
    let artwork_url = lookup_item
      .artwork_url_600
      .as_deref()
      .and_then(clean_url_string)
      .or_else(|| lookup_item.artwork_url_100.as_deref().and_then(clean_url_string))
      .or_else(|| item.artwork_url_100.as_deref().and_then(clean_url_string));
    let mut genres = Vec::new();
    for genre in item.genres {
      let Some(name) = clean_text(&genre.name, PODCAST_TITLE_LIMIT) else {
        continue;
      };
      if !genres.contains(&name) {
        genres.push(name);
      }
    }
    shows.push(PodcastDiscoveryShow {
      id: id.to_string(),
      title,
      author,
      feed_url,
      artwork_url,
      genres,
      rank: index + 1,
    });
  }
  if shows.is_empty() {
    return Err("Apple 播客榜单缺少可用订阅源".to_string());
  }
  Ok(shows)
}

fn valid_apple_catalog_id(value: &str) -> Option<&str> {
  let value = value.trim();
  (!value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit())).then_some(value)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn discovery_always_uses_a_supported_upstream_limit() {
    for limit in 1..=APPLE_DISCOVERY_MAX_RESULTS {
      let url = apple_chart_url(limit);
      assert!(url.ends_with("/25/podcasts.json") || url.ends_with("/50/podcasts.json"));
      assert!(url.contains("/cn/podcasts/top/"));
    }
    assert!(apple_chart_url(24).ends_with("/25/podcasts.json"));
    assert!(apple_chart_url(26).ends_with("/50/podcasts.json"));
  }

  #[test]
  fn apple_discovery_keeps_chart_order_and_joins_lookup_feed_urls() {
    let chart = serde_json::from_slice::<AppleDiscoveryResponse>(
      r#"{
        "feed": {
          "results": [
            {
              "id": "111",
              "name": "第一档",
              "artistName": "甲",
              "artworkUrl100": "https://img.example.test/111-small.jpg",
              "genres": [{"name": "文化"}, {"name": "文化"}]
            },
            {
              "id": "222",
              "name": "缺少订阅源",
              "artistName": "乙",
              "genres": []
            },
            {
              "id": "333",
              "name": "第三档",
              "artistName": "丙",
              "genres": [{"name": "新闻"}]
            }
          ]
        }
      }"#
        .as_bytes(),
    )
    .expect("parse chart fixture");
    let lookup = r#"{
      "resultCount": 3,
      "results": [
        {
          "collectionId": 333,
          "collectionName": "第三档 lookup",
          "artistName": "丙 lookup",
          "feedUrl": "https://feeds.example.test/333.xml",
          "artworkUrl600": "https://img.example.test/333-large.jpg"
        },
        {
          "collectionId": 222,
          "collectionName": "第二档",
          "artistName": "乙",
          "artworkUrl600": "https://img.example.test/222-large.jpg"
        },
        {
          "collectionId": 111,
          "collectionName": "第一档 lookup",
          "artistName": "甲 lookup",
          "feedUrl": "https://feeds.example.test/111.xml",
          "artworkUrl600": "https://img.example.test/111-large.jpg"
        }
      ]
    }"#;

    let shows = parse_apple_discovery(chart, lookup.as_bytes(), 3).expect("join Apple discovery");
    assert_eq!(shows.len(), 2);
    assert_eq!(shows[0].id, "111");
    assert_eq!(shows[0].rank, 1);
    assert_eq!(shows[0].title, "第一档");
    assert_eq!(shows[0].author, "甲");
    assert_eq!(shows[0].genres, vec!["文化"]);
    assert_eq!(
      shows[0].artwork_url.as_deref(),
      Some("https://img.example.test/111-large.jpg")
    );
    assert_eq!(shows[1].id, "333");
    assert_eq!(shows[1].rank, 3);
    assert_eq!(shows[1].feed_url, "https://feeds.example.test/333.xml");
  }
  #[test]
  fn apple_search_maps_clean_decision_metadata() {
    let item = serde_json::from_str::<AppleSearchItem>(
      r#"{
        "collectionId": 111,
        "collectionName": "一档科技播客",
        "artistName": "Zone",
        "feedUrl": "https://feeds.example.test/technology.xml",
        "artworkUrl600": "https://img.example.test/technology.jpg",
        "trackCount": 42,
        "genres": [" 科技 ", "科技", "", "Society & Culture", "Podcasts"],
        "primaryGenreName": "科技",
        "releaseDate": "1970-01-02T01:30:00.125+01:30"
      }"#,
    )
    .expect("parse Apple search item");

    let result = apple_search_result_from_item(item).expect("map Apple search item");
    assert_eq!(result.genres, vec!["科技", "Society & Culture"]);
    assert_eq!(result.latest_release_at, Some(86_400_125));
  }
  #[test]
  fn apple_search_ignores_invalid_release_date() {
    let item = serde_json::from_str::<AppleSearchItem>(
      r#"{
        "collectionName": "无效日期",
        "feedUrl": "https://feeds.example.test/invalid-date.xml",
        "releaseDate": "2026-02-29T08:00:00Z"
      }"#,
    )
    .expect("parse Apple search item");

    let result = apple_search_result_from_item(item).expect("map Apple search item");
    assert_eq!(result.latest_release_at, None);
    assert!(result.genres.is_empty());
  }
  #[test]
  fn apple_search_uses_primary_genre_when_genres_are_missing() {
    let item = serde_json::from_str::<AppleSearchItem>(
      r#"{
        "collectionName": "分类回退",
        "feedUrl": "https://feeds.example.test/fallback-genre.xml",
        "primaryGenreName": " 人文 "
      }"#,
    )
    .expect("parse Apple search item");

    let result = apple_search_result_from_item(item).expect("map Apple search item");
    assert_eq!(result.genres, vec!["人文"]);
    assert_eq!(result.latest_release_at, None);
  }
  #[tokio::test]
  #[ignore = "requires ZONE_PODCAST_LIVE=1 and public internet access"]
  async fn apple_cn_discovery_live_smoke() {
    if std::env::var("ZONE_PODCAST_LIVE").ok().as_deref() != Some("1") {
      eprintln!("set ZONE_PODCAST_LIVE=1 to run the podcast live smoke");
      return;
    }
    let shows = browse_apple_cn(12).await.expect("Apple CN discovery");
    assert!(shows.len() >= 5);
    assert!(shows.windows(2).all(|pair| pair[0].rank < pair[1].rank));
    for show in shows {
      validate_public_url_shape(&show.feed_url).expect("public discovery feed URL");
    }
  }
}
