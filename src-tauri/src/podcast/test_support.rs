use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::http::{Method, Request};

pub(crate) fn test_directory(name: &str) -> PathBuf {
  let stamp = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
  let directory = std::env::temp_dir().join(format!("zone-podcast-{name}-{}-{stamp}", std::process::id(),));
  fs::create_dir_all(&directory).expect("create test directory");
  directory
}
pub(crate) fn rss_fixture(enclosure_url: &str) -> Vec<u8> {
  format!(
    r#"<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
      <channel>
        <title>Zone 测试播客</title>
        <description><![CDATA[<p>一档 <strong>本地优先</strong> 的节目。</p>]]></description>
        <itunes:author>Zone 主播</itunes:author>
        <itunes:image href="https://cdn.example.test/show.jpg" />
        <item>
          <guid isPermaLink="false">episode-one</guid>
          <title>第一集</title>
          <link>https://www.example.test/episodes/one</link>
          <description><![CDATA[<p>第一集的 <em>简介</em></p>]]></description>
          <pubDate>Sat, 25 Jul 2026 08:00:00 +0000</pubDate>
          <itunes:duration>01:02:03</itunes:duration>
          <enclosure url="{enclosure_url}" length="23" type="audio/mpeg" />
        </item>
      </channel>
    </rss>"#
  )
  .into_bytes()
}
pub(crate) fn artwork_request(method: Method, url: &str) -> Request<Vec<u8>> {
  let token = URL_SAFE_NO_PAD.encode(url.as_bytes());
  Request::builder()
    .method(method)
    .uri(format!("zone-podcast-artwork://localhost/{token}"))
    .body(Vec::new())
    .expect("build artwork request")
}
pub(crate) fn parsed_fixture(enclosure_url: &str) -> ParsedPodcast {
  parsed_fixture_at(
    enclosure_url,
    "https://feeds.example.test/show.xml",
  )
}
pub(crate) fn parsed_fixture_at(enclosure_url: &str, feed_url: &str) -> ParsedPodcast {
  parse_feed_bytes(
    &rss_fixture(enclosure_url),
    feed_url,
    Some("提示标题"),
    Some("提示作者"),
    Some("https://cdn.example.test/hint.jpg"),
    Some("\"etag-one\"".to_string()),
    Some("Sat, 25 Jul 2026 08:00:00 GMT".to_string()),
  )
  .expect("parse fixture")
}
pub(crate) fn parse_test_feed(xml: &str, name: &str) -> ParsedPodcast {
  parse_feed_bytes(
    xml.as_bytes(),
    &format!("https://feeds.example.test/{name}.xml"),
    None,
    None,
    None,
    None,
    None,
  )
  .unwrap_or_else(|error| panic!("parse {name} fixture: {error}"))
}
pub(crate) fn parsed_fixture_with_episode_count(count: usize) -> ParsedPodcast {
  let mut parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
  let template = parsed.episodes[0].clone();
  for index in 1..count {
    let identity_key = format!("guid:episode-{}", index + 1);
    let mut episode = template.clone();
    episode.id = hash_identifier("episode", &[&parsed.feed.id, &identity_key]);
    episode.identity_key = identity_key;
    episode.guid = Some(format!("episode-{}", index + 1));
    episode.title = format!("第{}集", index + 1);
    episode.published_at = template
      .published_at
      .map(|timestamp| timestamp.saturating_sub(i64::try_from(index).unwrap_or(0) * 86_400_000));
    episode.enclosure_url = format!("https://media.example.test/episode-{}.mp3", index + 1);
    parsed.episodes.push(episode);
  }
  parsed
}
