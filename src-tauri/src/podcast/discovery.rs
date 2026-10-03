use super::*;
use crate::db::unix_millis;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use std::future::Future;

const XYZRANK_URL: &str = "https://xyzrank.com/api/podcasts?limit=50&offset=0";
const DISCOVERY_LIMIT: usize = 24;
const DISCOVERY_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const DISCOVERY_CACHE_TTL_MS: i64 = 15 * 60 * 1000;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_KEYS: [(&str, PodcastDiscoverySource); 2] = [
  ("podcast.discovery.xyzrank.v1", PodcastDiscoverySource::Xyzrank),
  ("podcast.discovery.apple.v1", PodcastDiscoverySource::Apple),
];

#[derive(Deserialize)]
struct XyzrankResponse { items: Vec<serde_json::Value> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct XyzrankItem {
  name: String,
  #[serde(default)] authors_text: String,
  #[serde(default, rename = "logoURL")] logo_url: Option<String>,
  #[serde(default)] primary_genre_name: Option<String>,
  #[serde(default)] rank: Option<usize>,
  #[serde(default)] links: Vec<XyzrankLink>,
}

#[derive(Deserialize)]
struct XyzrankLink { name: String, url: String }

pub(crate) fn parse_xyzrank_shows(bytes: &[u8]) -> Result<Vec<PodcastDiscoveryShow>, String> {
  if bytes.len() > DISCOVERY_RESPONSE_LIMIT { return Err("中文播客榜响应过大".into()); }
  let response: XyzrankResponse = serde_json::from_slice(bytes).map_err(|_| "中文播客榜数据格式无效".to_string())?;
  let mut seen = HashSet::new();
  let mut shows = Vec::new();
  for (index, value) in response.items.into_iter().take(50).enumerate() {
    let Ok(item) = serde_json::from_value::<XyzrankItem>(value) else { continue };
    let Some(title) = clean_text(&item.name, PODCAST_TITLE_LIMIT) else { continue };
    let Some(feed_url) = item.links.iter().filter(|link| link.name.eq_ignore_ascii_case("rss"))
      .find_map(|link| normalize_url(&link.url, false).ok()) else { continue };
    if !seen.insert(feed_url.clone()) { continue; }
    shows.push(PodcastDiscoveryShow {
      id: hash_identifier("xyzrank", &[&feed_url]), title,
      author: clean_text(&item.authors_text, PODCAST_TITLE_LIMIT).unwrap_or_default(),
      feed_url,
      artwork_url: item.logo_url.as_deref().and_then(clean_url_string),
      genres: item.primary_genre_name.as_deref().and_then(|value| clean_text(value, 100)).into_iter().collect(),
      rank: item.rank.filter(|rank| *rank > 0 && *rank <= 100_000).unwrap_or(index + 1),
    });
  }
  shows.sort_by_key(|show| show.rank);
  shows.truncate(DISCOVERY_LIMIT);
  if shows.is_empty() { return Err("中文播客榜暂无可用 RSS 节目".into()); }
  Ok(shows)
}

pub(crate) async fn fetch_xyzrank_shows(url: reqwest::Url, allow_private_network: bool) -> Result<Vec<PodcastDiscoveryShow>, String> {
  let bytes = with_network_retries(DISCOVERY_TIMEOUT, || with_network_limit(NetworkClass::Metadata, async {
    let response = send_public_get_with_policy(url.clone(), DISCOVERY_TIMEOUT, None, allow_private_network).await?;
    read_limited(response.response, DISCOVERY_RESPONSE_LIMIT, "中文播客榜").await
  })).await?;
  parse_xyzrank_shows(&bytes)
}

fn cache_key(source: PodcastDiscoverySource) -> &'static str {
  CACHE_KEYS.iter().find(|(_, value)| *value == source).unwrap().0
}

fn valid_cached_page(page: &PodcastDiscoveryPage, source: PodcastDiscoverySource) -> bool {
  page.source == source && page.fetched_at > 0 && page.fetched_at <= unix_millis()
    && !page.shows.is_empty() && page.shows.len() <= DISCOVERY_LIMIT
    && page.shows.iter().all(|show| !show.id.is_empty() && show.id.len() <= 200
      && clean_text(&show.title, PODCAST_TITLE_LIMIT).as_deref() == Some(show.title.as_str())
      && show.author.chars().count() <= PODCAST_TITLE_LIMIT
      && show.rank > 0 && show.rank <= 100_000
      && normalize_url(&show.feed_url, false).ok().as_deref() == Some(show.feed_url.as_str())
      && show.artwork_url.as_deref().is_none_or(|value| clean_url_string(value).as_deref() == Some(value))
      && show.genres.len() <= 10 && show.genres.iter().all(|genre| genre.chars().count() <= 100))
}

pub(crate) fn load_discovery_cache(db_path: &Path) -> Result<Option<PodcastDiscoveryPage>, String> {
  let connection = open_database(db_path)?;
  let mut newest: Option<PodcastDiscoveryPage> = None;
  for (key, source) in CACHE_KEYS {
    let json: Option<String> = connection.query_row("SELECT value_json FROM app_settings WHERE key = ?1 AND length(value_json) <= ?2", params![key, DISCOVERY_RESPONSE_LIMIT as i64], |row| row.get(0))
      .optional().map_err(|error| format!("无法读取播客榜单缓存：{error}"))?;
    let Some(json) = json else { continue };
    let Ok(mut page) = serde_json::from_str::<PodcastDiscoveryPage>(&json) else { continue };
    if !valid_cached_page(&page, source) { continue; }
    page.stale = unix_millis() - page.fetched_at >= DISCOVERY_CACHE_TTL_MS;
    if newest.as_ref().is_none_or(|old| page.fetched_at > old.fetched_at) { newest = Some(page); }
  }
  Ok(newest)
}

pub(crate) fn save_discovery_cache(db_path: &Path, page: &PodcastDiscoveryPage) -> Result<(), String> {
  if !valid_cached_page(page, page.source) { return Err("播客榜单缓存内容无效".into()); }
  let json = serde_json::to_string(page).map_err(|error| error.to_string())?;
  let connection = open_database(db_path)?;
  connection.execute("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
    params![cache_key(page.source), json, page.fetched_at]).map_err(|error| format!("无法保存播客榜单缓存：{error}"))?;
  Ok(())
}

// Provider failures must not replace the last successful snapshot or hide cancellation.
pub(crate) async fn browse_discovery_with<X, A, XF, AF>(db_path: PathBuf, xyzrank: X, apple: A) -> Result<PodcastDiscoveryPage, String>
where X: FnOnce() -> XF, A: FnOnce() -> AF,
  XF: Future<Output = Result<Vec<PodcastDiscoveryShow>, String>>,
  AF: Future<Output = Result<Vec<PodcastDiscoveryShow>, String>>,
{
  let (source, result) = match xyzrank().await {
    Ok(shows) if !shows.is_empty() => (PodcastDiscoverySource::Xyzrank, Ok(shows)),
    Err(error) if error == "已取消播客网络请求" => return Err(error),
    _ => (PodcastDiscoverySource::Apple, apple().await),
  };
  match result {
    Ok(mut shows) if !shows.is_empty() => {
      shows.truncate(DISCOVERY_LIMIT);
      let page = PodcastDiscoveryPage { shows, source, fetched_at: unix_millis(), stale: false };
      let snapshot = page.clone();
      // This derived cache is best effort; database writes are never interrupted mid-transaction.
      let _ = tauri::async_runtime::spawn_blocking(move || save_discovery_cache(&db_path, &snapshot)).await;
      Ok(page)
    }
    Err(error) if error == "已取消播客网络请求" => Err(error),
    _ => {
      let cached = tauri::async_runtime::spawn_blocking(move || load_discovery_cache(&db_path)).await
        .map_err(|error| format!("播客数据任务异常结束：{error}"))??;
      cached.map(|mut page| { page.stale = true; page }).ok_or_else(|| "播客榜单暂时不可用，请稍后重试".into())
    }
  }
}

#[tauri::command]
pub async fn podcast_browse_discovery(state: tauri::State<'_, PodcastState>, request_id: Option<String>) -> Result<PodcastDiscoveryPage, String> {
  state.ensure_ready()?;
  run_network_task(request_id.as_deref(), browse_discovery_with(state.db_path.clone(),
    || fetch_xyzrank_shows(XYZRANK_URL.parse().expect("fixed XYZRank URL"), false),
    || browse_apple_cn(DISCOVERY_LIMIT as u8))).await
}

#[tauri::command]
pub async fn podcast_load_discovery_cache(state: tauri::State<'_, PodcastState>) -> Result<Option<PodcastDiscoveryPage>, String> {
  state.ensure_ready()?;
  let path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || load_discovery_cache(&path)).await.map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::test_directory;
  use std::sync::atomic::{AtomicBool, Ordering};

  fn fixture(feed: &str, rank: usize) -> serde_json::Value {
    serde_json::json!({"id":"upstream-id", "rank":rank, "name":" 中文节目 ", "authorsText":"作者", "logoURL":"https://example.com/cover.jpg",
      "primaryGenreName":"科技", "links":[{"name":"xyz","url":"https://www.xiaoyuzhoufm.com/podcast/1"}, {"name":"rss","url":feed}]})
  }
  fn shows() -> Vec<PodcastDiscoveryShow> {
    parse_xyzrank_shows(&serde_json::to_vec(&serde_json::json!({"items":[fixture("https://example.com/feed.xml", 1)]})).unwrap()).unwrap()
  }
  fn state(name: &str) -> PodcastState { PodcastState::initialize_at(&test_directory(name)).unwrap() }

  #[test]
  fn xyzrank_filters_unsafe_and_missing_rss_deduplicates_and_keeps_stable_ids() {
    let items = serde_json::json!({"items":[
      fixture("https://EXAMPLE.com/feed.xml", 2), fixture("https://example.com/feed.xml", 3),
      fixture("http://127.0.0.1/feed.xml", 1), fixture("https://user:pass@example.com/feed", 4),
      fixture("https://example.com:444/feed", 5), fixture("file:///feed", 6),
      {"name":"只有小宇宙网页","links":[{"name":"xyz","url":"https://example.com/show"}]},
      {"name":42}, fixture("https://other.example/feed", 1)]});
    let parsed = parse_xyzrank_shows(&serde_json::to_vec(&items).unwrap()).unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].rank, 1);
    assert_eq!(parsed[1].title, "中文节目");
    assert_eq!(parsed[1].id, shows()[0].id);
    assert_eq!(parsed[1].genres, ["科技"]);
    assert_eq!(parsed[1].artwork_url.as_deref(), Some("https://example.com/cover.jpg"));
  }

  #[test]
  fn xyzrank_rejects_empty_malformed_and_oversized_catalogues() {
    for bytes in [b"{}".as_slice(), b"{\"items\":[]}", b"<html>bad gateway</html>"] {
      assert!(parse_xyzrank_shows(bytes).is_err());
    }
    assert!(parse_xyzrank_shows(&vec![b' '; DISCOVERY_RESPONSE_LIMIT + 1]).unwrap_err().contains("过大"));
    let items: Vec<_> = (1..=50).map(|rank| fixture(&format!("https://example.com/feed/{rank}"), rank)).collect();
    assert_eq!(parse_xyzrank_shows(&serde_json::to_vec(&serde_json::json!({"items":items})).unwrap()).unwrap().len(), DISCOVERY_LIMIT);
  }

  #[tokio::test]
  async fn primary_success_is_persisted_without_calling_apple() {
    let state = state("discovery-primary");
    let called = AtomicBool::new(false);
    let page = browse_discovery_with(state.db_path.clone(), || async { Ok(shows()) }, || async {
      called.store(true, Ordering::Relaxed); Err("offline".into())
    }).await.unwrap();
    assert!(!called.load(Ordering::Relaxed));
    assert_eq!(page.source, PodcastDiscoverySource::Xyzrank);
    assert!(!page.stale);
    let restarted = PodcastState::initialize_at(state.db_path.parent().unwrap()).unwrap();
    let cached = load_discovery_cache(&restarted.db_path).unwrap().unwrap();
    assert_eq!(cached.fetched_at, page.fetched_at);
    assert_eq!(cached.shows[0].feed_url, page.shows[0].feed_url);
  }

  #[tokio::test]
  async fn apple_fallback_is_labelled_and_cached_then_both_failures_preserve_snapshot() {
    let state = state("discovery-fallback");
    let page = browse_discovery_with(state.db_path.clone(), || async { Err("timeout".into()) }, || async { Ok(shows()) }).await.unwrap();
    assert_eq!(page.source, PodcastDiscoverySource::Apple);
    let cached = browse_discovery_with(state.db_path.clone(), || async { Err("offline".into()) }, || async { Err("offline".into()) }).await.unwrap();
    assert!(cached.stale);
    assert_eq!(cached.source, PodcastDiscoverySource::Apple);
    assert_eq!(cached.fetched_at, page.fetched_at);
    assert!(!load_discovery_cache(&state.db_path).unwrap().unwrap().stale);
  }

  #[tokio::test]
  async fn cancellation_never_starts_fallback_or_returns_cache() {
    let state = state("discovery-cancel");
    save_discovery_cache(&state.db_path, &PodcastDiscoveryPage { shows: shows(), source: PodcastDiscoverySource::Xyzrank, fetched_at: unix_millis(), stale: false }).unwrap();
    let called = AtomicBool::new(false);
    let result = browse_discovery_with(state.db_path.clone(), || async { Err("已取消播客网络请求".into()) }, || async {
      called.store(true, Ordering::Relaxed); Ok(shows())
    }).await;
    assert!(result.unwrap_err().contains("取消"));
    assert!(!called.load(Ordering::Relaxed));
    assert!(browse_discovery_with(state.db_path, || async { Err("failed".into()) }, || async { Err("已取消播客网络请求".into()) }).await.unwrap_err().contains("取消"));
  }

  #[tokio::test]
  async fn empty_providers_without_cache_report_retryable_failure() {
    let state = state("discovery-empty");
    assert!(browse_discovery_with(state.db_path, || async { Ok(vec![]) }, || async { Ok(vec![]) }).await.unwrap_err().contains("重试"));
  }

  #[test]
  fn corrupt_cache_is_ignored_and_preserved_without_touching_other_settings() {
    let state = state("discovery-corrupt");
    let connection = open_database(&state.db_path).unwrap();
    connection.execute_batch("INSERT INTO app_settings VALUES ('music.fixture', '42', 1); INSERT INTO app_settings VALUES ('podcast.discovery.xyzrank.v1', 'broken', 1);").unwrap();
    assert!(load_discovery_cache(&state.db_path).unwrap().is_none());
    let mut page = PodcastDiscoveryPage { shows: shows(), source: PodcastDiscoverySource::Apple, fetched_at: unix_millis() - DISCOVERY_CACHE_TTL_MS - 1, stale: false };
    save_discovery_cache(&state.db_path, &page).unwrap();
    assert!(load_discovery_cache(&state.db_path).unwrap().unwrap().stale);
    assert_eq!(connection.query_row("SELECT value_json FROM app_settings WHERE key='music.fixture'", [], |row| row.get::<_, String>(0)).unwrap(), "42");
    assert_eq!(connection.query_row("SELECT value_json FROM app_settings WHERE key='podcast.discovery.xyzrank.v1'", [], |row| row.get::<_, String>(0)).unwrap(), "broken");
    page.fetched_at = unix_millis() + 60_000;
    assert!(save_discovery_cache(&state.db_path, &page).is_err());
    page.fetched_at = unix_millis(); page.shows[0].feed_url = "http://127.0.0.1/feed".into();
    assert!(save_discovery_cache(&state.db_path, &page).is_err());
  }

  #[test]
  fn newest_provider_snapshot_wins_and_invalid_source_is_not_trusted() {
    let state = state("discovery-newest");
    let mut page = PodcastDiscoveryPage { shows: shows(), source: PodcastDiscoverySource::Xyzrank, fetched_at: unix_millis() - 2000, stale: false };
    save_discovery_cache(&state.db_path, &page).unwrap();
    page.source = PodcastDiscoverySource::Apple; page.fetched_at += 1000;
    save_discovery_cache(&state.db_path, &page).unwrap();
    assert_eq!(load_discovery_cache(&state.db_path).unwrap().unwrap().source, PodcastDiscoverySource::Apple);
    open_database(&state.db_path).unwrap().execute("UPDATE app_settings SET value_json=?1 WHERE key='podcast.discovery.apple.v1'", [serde_json::to_string(&PodcastDiscoveryPage { source: PodcastDiscoverySource::Xyzrank, ..page }).unwrap()]).unwrap();
    assert_eq!(load_discovery_cache(&state.db_path).unwrap().unwrap().source, PodcastDiscoverySource::Xyzrank);
  }

  #[tokio::test]
  #[ignore = "requires explicit ZONE_PODCAST_LIVE=1 opt-in and public networking"]
  async fn live_xyzrank_catalogue_has_playable_rss_candidates() {
    assert_eq!(std::env::var("ZONE_PODCAST_LIVE").as_deref(), Ok("1"));
    let shows = fetch_xyzrank_shows(XYZRANK_URL.parse().unwrap(), false).await.unwrap();
    assert!(!shows.is_empty());
    let feed = fetch_and_parse_feed(&shows[0].feed_url, Some(&shows[0].title), Some(&shows[0].author), shows[0].artwork_url.as_deref()).await.unwrap();
    assert!(!feed.episodes.is_empty());
    assert!(feed.episodes.iter().any(|episode| validate_public_url_shape(&episode.enclosure_url).is_ok()));
  }
}
