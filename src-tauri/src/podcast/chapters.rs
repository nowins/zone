use reqwest::header::{self, HeaderMap, HeaderValue};
use reqwest::{StatusCode, Url};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use std::path::Path;
use super::*;

#[derive(Clone, Debug)]
pub(crate) struct StoredChapterResource {
  pub(crate) id: String,
  pub(crate) episode_id: String,
  pub(crate) source_kind: String,
  pub(crate) url: Option<String>,
  pub(crate) mime_type: Option<String>,
  pub(crate) etag: Option<String>,
  pub(crate) last_modified: Option<String>,
  pub(crate) fetched_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JsonChapterDocument {
  pub(crate) version: String,
  pub(crate) chapters: Vec<JsonChapter>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JsonChapter {
  pub(crate) start_time: f64,
  pub(crate) end_time: Option<f64>,
  pub(crate) title: Option<String>,
  pub(crate) img: Option<String>,
  pub(crate) url: Option<String>,
  pub(crate) toc: Option<bool>,
}
pub(crate) fn get_episode_detail(
  db_path: &Path,
  downloads_dir: &Path,
  episode_id: &str,
) -> Result<PodcastEpisodeDetail, String> {
  let connection = open_database(db_path)?;
  connection
    .query_row(
      &format!("{PODCAST_EPISODE_DETAIL_SELECT} WHERE e.id = ?1"),
      [episode_id],
      |row| podcast_episode_detail_from_row(row, downloads_dir),
    )
    .optional()
    .map_err(|error| format!("无法读取播客单集详情：{error}"))?
    .ok_or_else(|| "播客单集不存在".to_string())
}

pub(crate) async fn get_episode_chapters_with_network_policy(
  db_path: &Path,
  episode_id: &str,
  allow_private_network: bool,
) -> Result<PodcastChapterDocument, String> {
  validate_identifier(episode_id)?;
  let resources = list_chapter_resources(db_path, episode_id)?;
  let external = resources
    .iter()
    .find(|resource| resource.source_kind == "podcast-json");
  let embedded = resources
    .iter()
    .find(|resource| resource.source_kind == "psc");
  if let Some(resource) = external {
    let cached = chapter_document_from_resource(db_path, resource, false)?;
    if resource.fetched_at.is_some_and(|fetched_at| {
      unix_time_millis().saturating_sub(fetched_at)
        < PODCAST_CHAPTER_REFRESH_INTERVAL
    }) {
      if let Some(cached) = cached.clone() {
        return Ok(cached);
      }
    }
    match refresh_external_chapter_resource(
      db_path,
      resource,
      allow_private_network,
    )
    .await
    {
      Ok(document) => return Ok(document),
      Err(reason) => {
        record_chapter_resource_error(db_path, resource, &reason)?;
        if let Some(cached) = cached {
          return Ok(PodcastChapterDocument {
            stale: true,
            ..cached
          });
        }
        if let Some(embedded) = embedded {
          if let Some(document) =
            chapter_document_from_resource(db_path, embedded, false)?
          {
            return Ok(document);
          }
        }
        return Err(reason);
      }
    }
  }
  if let Some(resource) = embedded {
    if let Some(document) = chapter_document_from_resource(db_path, resource, false)? {
      return Ok(document);
    }
  }
  Err("这集没有可用章节".to_string())
}

fn list_chapter_resources(
  db_path: &Path,
  episode_id: &str,
) -> Result<Vec<StoredChapterResource>, String> {
  let connection = open_database(db_path)?;
  ensure_episode_exists(&connection, episode_id)?;
  let mut statement = connection
    .prepare(
      "
      SELECT
        id, episode_id, source_kind, url, mime_type, etag, last_modified,
        fetched_at
      FROM podcast_episode_resources
      WHERE episode_id = ?1 AND kind = 'chapters'
      ORDER BY
        CASE source_kind WHEN 'podcast-json' THEN 0 WHEN 'psc' THEN 1 ELSE 2 END,
        ordinal,
        id
      ",
    )
    .map_err(|error| format!("无法读取播客章节来源：{error}"))?;
  let resources = statement
    .query_map([episode_id], |row| {
      Ok(StoredChapterResource {
        id: row.get(0)?,
        episode_id: row.get(1)?,
        source_kind: row.get(2)?,
        url: row.get(3)?,
        mime_type: row.get(4)?,
        etag: row.get(5)?,
        last_modified: row.get(6)?,
        fetched_at: row.get(7)?,
      })
    })
    .map_err(|error| format!("无法读取播客章节来源：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客章节来源：{error}"))?;
  Ok(resources)
}

fn chapter_document_from_resource(
  db_path: &Path,
  resource: &StoredChapterResource,
  stale: bool,
) -> Result<Option<PodcastChapterDocument>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT start_ms, end_ms, title, href, image_url
      FROM podcast_chapters
      WHERE resource_id = ?1 AND visible = 1
      ORDER BY start_ms, ordinal
      LIMIT ?2
      ",
    )
    .map_err(|error| format!("无法读取播客章节：{error}"))?;
  let chapters = statement
    .query_map(
      params![
        resource.id,
        i64::try_from(PODCAST_CHAPTER_MAX_COUNT).unwrap_or(i64::MAX),
      ],
      |row| {
        Ok(PodcastChapter {
          start_seconds: row.get::<_, i64>(0)? as f64 / 1_000.0,
          end_seconds: row
            .get::<_, Option<i64>>(1)?
            .map(|value| value as f64 / 1_000.0),
          title: row.get(2)?,
          href: row.get(3)?,
          image_url: row.get(4)?,
        })
      },
    )
    .map_err(|error| format!("无法读取播客章节：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客章节：{error}"))?;
  Ok((!chapters.is_empty()).then(|| PodcastChapterDocument {
    episode_id: resource.episode_id.clone(),
    source_kind: resource.source_kind.clone(),
    chapters,
    stale,
  }))
}

async fn refresh_external_chapter_resource(
  db_path: &Path,
  resource: &StoredChapterResource,
  allow_private_network: bool,
) -> Result<PodcastChapterDocument, String> {
  with_network_retries(PODCAST_CHAPTER_TIMEOUT, || with_network_limit(NetworkClass::Metadata, refresh_external_chapter_resource_once(db_path, resource, allow_private_network))).await
}

async fn refresh_external_chapter_resource_once(db_path: &Path, resource: &StoredChapterResource, allow_private_network: bool) -> Result<PodcastChapterDocument, String> {
  let raw_url = resource.url
    .as_deref()
    .ok_or_else(|| "播客章节来源地址无效".to_string())?;
  let url = validate_url_shape_with_policy(raw_url, allow_private_network)?;
  if !allow_private_network && url.scheme() != "https" {
    return Err("播客章节来源必须使用 HTTPS".to_string());
  }
  if !resource
    .mime_type
    .as_deref()
    .is_some_and(is_json_chapter_mime_type)
  {
    return Err("播客章节格式暂不受支持".to_string());
  }
  let mut headers = HeaderMap::new();
  if let Some(value) = resource
    .etag
    .as_deref()
    .and_then(|value| HeaderValue::from_str(value).ok())
  {
    headers.insert(header::IF_NONE_MATCH, value);
  }
  if let Some(value) = resource
    .last_modified
    .as_deref()
    .and_then(|value| HeaderValue::from_str(value).ok())
  {
    headers.insert(header::IF_MODIFIED_SINCE, value);
  }
  let public_response = send_public_get_with_headers(
    url,
    PODCAST_CHAPTER_TIMEOUT,
    None,
    allow_private_network,
    &headers,
  )
  .await?;
  let response_etag = header_text(public_response.response.headers(), header::ETAG);
  let response_last_modified =
    header_text(public_response.response.headers(), header::LAST_MODIFIED);
  if public_response.response.status() == StatusCode::NOT_MODIFIED {
    mark_chapter_resource_not_modified(
      db_path,
      resource,
      response_etag.as_deref(),
      response_last_modified.as_deref(),
    )?;
    return chapter_document_from_resource(db_path, resource, false)?
      .ok_or_else(|| "章节来源返回未修改，但本地没有可用缓存".to_string());
  }
  if let Some(content_type) =
    header_text(public_response.response.headers(), header::CONTENT_TYPE)
  {
    let content_type = content_type
      .split(';')
      .next()
      .unwrap_or_default()
      .trim()
      .to_ascii_lowercase();
    if !matches!(
      content_type.as_str(),
      "application/json+chapters"
        | "application/json"
        | "text/json"
        | "text/plain"
        | "application/octet-stream"
    ) {
      return Err("播客章节来源返回了不支持的内容类型".to_string());
    }
  }
  let final_url = public_response.final_url.clone();
  let bytes = read_limited(
    public_response.response,
    PODCAST_CHAPTER_RESPONSE_LIMIT,
    "播客章节",
  )
  .await?;
  let chapters = parse_json_chapters(&bytes, &final_url)?;
  store_external_chapters(
    db_path,
    resource,
    raw_url,
    &chapters,
    response_etag.as_deref(),
    response_last_modified.as_deref(),
  )?;
  chapter_document_from_resource(db_path, resource, false)?
    .ok_or_else(|| "章节文件没有可显示的章节".to_string())
}

fn parse_json_chapters(
  bytes: &[u8],
  base_url: &Url,
) -> Result<Vec<ParsedPodcastChapter>, String> {
  let document = serde_json::from_slice::<JsonChapterDocument>(bytes)
    .map_err(|_| "无法解析播客章节文件".to_string())?;
  if document.version.trim().is_empty() {
    return Err("播客章节文件缺少版本信息".to_string());
  }
  if document.chapters.len() > PODCAST_CHAPTER_MAX_COUNT {
    return Err("播客章节数量超过限制".to_string());
  }
  let mut chapters = Vec::with_capacity(document.chapters.len());
  for (index, chapter) in document.chapters.into_iter().enumerate() {
    if !chapter.start_time.is_finite() || chapter.start_time < 0.0 {
      continue;
    }
    let start_ms = (chapter.start_time * 1_000.0).round();
    if !start_ms.is_finite() || start_ms > i64::MAX as f64 {
      continue;
    }
    let end_ms = chapter.end_time.and_then(|end_time| {
      let value = (end_time * 1_000.0).round();
      (end_time.is_finite()
        && end_time > chapter.start_time
        && value <= i64::MAX as f64)
        .then_some(value as i64)
    });
    chapters.push(ParsedPodcastChapter {
      start_ms: start_ms as i64,
      end_ms,
      title: chapter
        .title
        .as_deref()
        .and_then(|value| clean_text(value, PODCAST_TITLE_LIMIT))
        .unwrap_or_else(|| format!("章节 {}", index + 1)),
      href: chapter
        .url
        .as_deref()
        .and_then(|value| resolve_resource_url(value, Some(base_url), true)),
      image_url: chapter
        .img
        .as_deref()
        .and_then(|value| resolve_resource_url(value, Some(base_url), true)),
      visible: chapter.toc.unwrap_or(true),
    });
  }
  chapters.sort_by_key(|chapter| chapter.start_ms);
  chapters.dedup_by_key(|chapter| chapter.start_ms);
  if !chapters.iter().any(|chapter| chapter.visible) {
    return Err("章节文件没有可显示的章节".to_string());
  }
  Ok(chapters)
}

fn store_external_chapters(
  db_path: &Path,
  resource: &StoredChapterResource,
  expected_url: &str,
  chapters: &[ParsedPodcastChapter],
  etag: Option<&str>,
  last_modified: Option<&str>,
) -> Result<(), String> {
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客章节：{error}"))?;
  let current_url = transaction
    .query_row(
      "
      SELECT url
      FROM podcast_episode_resources
      WHERE id = ?1 AND episode_id = ?2 AND source_kind = 'podcast-json'
      ",
      params![resource.id, resource.episode_id],
      |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|error| format!("无法确认播客章节来源：{error}"))?
    .flatten();
  if current_url.as_deref() != Some(expected_url) {
    return Err("播客章节来源已更新，请重试".to_string());
  }
  replace_podcast_chapters(&transaction, &resource.id, chapters)?;
  transaction
    .execute(
      "
      UPDATE podcast_episode_resources SET
        etag = ?3,
        last_modified = ?4,
        fetched_at = ?5,
        error_message = NULL
      WHERE id = ?1 AND episode_id = ?2
      ",
      params![
        resource.id,
        resource.episode_id,
        etag,
        last_modified,
        unix_time_millis(),
      ],
    )
    .map_err(|error| format!("无法更新播客章节缓存：{error}"))?;
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客章节缓存：{error}"))
}

fn mark_chapter_resource_not_modified(
  db_path: &Path,
  resource: &StoredChapterResource,
  etag: Option<&str>,
  last_modified: Option<&str>,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  connection
    .execute(
      "
      UPDATE podcast_episode_resources SET
        etag = COALESCE(?3, etag),
        last_modified = COALESCE(?4, last_modified),
        fetched_at = ?5,
        error_message = NULL
      WHERE id = ?1 AND episode_id = ?2
      ",
      params![
        resource.id,
        resource.episode_id,
        etag,
        last_modified,
        unix_time_millis(),
      ],
    )
    .map_err(|error| format!("无法更新播客章节缓存：{error}"))?;
  Ok(())
}

fn record_chapter_resource_error(
  db_path: &Path,
  resource: &StoredChapterResource,
  message: &str,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  connection
    .execute(
      "
      UPDATE podcast_episode_resources
      SET error_message = ?3
      WHERE id = ?1 AND episode_id = ?2
      ",
      params![
        resource.id,
        resource.episode_id,
        truncate_chars(message, 1_000),
      ],
    )
    .map_err(|error| format!("无法记录播客章节错误：{error}"))?;
  Ok(())
}

pub(crate) fn get_episode_details(
  db_path: &Path,
  downloads_dir: &Path,
  episode_ids: &[String],
) -> Result<Vec<PodcastEpisodeDetail>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(&format!("{PODCAST_EPISODE_DETAIL_SELECT} WHERE e.id = ?1"))
    .map_err(|error| format!("无法读取播客单集详情：{error}"))?;
  episode_ids
    .iter()
    .map(|episode_id| {
      statement
        .query_row([episode_id], |row| {
          podcast_episode_detail_from_row(row, downloads_dir)
        })
        .optional()
        .map_err(|error| format!("无法读取播客单集详情：{error}"))?
        .ok_or_else(|| "播客单集不存在".to_string())
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  use tokio::io::AsyncReadExt;
  use tokio::io::AsyncWriteExt;
  use tokio::net::TcpListener;

  #[test]
  fn json_chapters_are_sorted_deduplicated_and_keep_visibility() {
    let base_url = Url::parse("https://cdn.example.test/path/chapters.json")
      .expect("chapter base URL");
    let chapters = parse_json_chapters(
      r#"{
        "version": "1.2.0",
        "chapters": [
          {"startTime": 30.5, "title": "后半段", "url": "../topic"},
          {"startTime": 0, "title": "开场"},
          {"startTime": 15, "toc": false, "img": "https://cdn.example.test/silent.jpg"},
          {"startTime": 30.5, "title": "重复起点"},
          {"startTime": -1, "title": "无效"}
        ]
      }"#
        .as_bytes(),
      &base_url,
    )
    .expect("parse JSON chapters");
    assert_eq!(
      chapters
        .iter()
        .map(|chapter| chapter.start_ms)
        .collect::<Vec<_>>(),
      vec![0, 15_000, 30_500],
    );
    assert!(!chapters[1].visible);
    assert_eq!(chapters[1].title, "章节 3");
    assert_eq!(
      chapters[2].href.as_deref(),
      Some("https://cdn.example.test/topic"),
    );
    assert_eq!(chapters[2].title, "后半段");
  }
  #[tokio::test]
  async fn external_chapters_use_conditional_requests_and_stale_cache_fallback() {
    let directory = test_directory("external-chapters");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let rss = r#"<?xml version="1.0"?>
      <rss version="2.0"
        xmlns:podcast="https://podcastindex.org/namespace/1.0">
        <channel>
          <title>外部章节</title>
          <description>external chapter fixture</description>
          <item>
            <guid>external-chapter-episode</guid>
            <title>外部章节单集</title>
            <enclosure url="https://media.example.test/external.mp3" type="audio/mpeg" />
            <podcast:chapters url="https://cdn.example.test/external.json"
              type="application/json+chapters" />
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(rss, "external-chapters");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store external chapter feed");

    let listener = TcpListener::bind("127.0.0.1:0")
      .await
      .expect("bind chapter server");
    let address = listener.local_addr().expect("chapter server address");
    let local_url = format!("http://localhost:{}/chapters.json", address.port());
    open_database(&state.db_path)
      .expect("open chapter database")
      .execute(
        "
        UPDATE podcast_episode_resources
        SET url = ?1
        WHERE episode_id = ?2 AND source_kind = 'podcast-json'
        ",
        params![local_url, episode_id],
      )
      .expect("point chapters at local server");
    let server = tokio::spawn(async move {
      for request_index in 0..2 {
        let (mut stream, _) = listener.accept().await.expect("accept chapter request");
        let mut request = vec![0u8; 8_192];
        let read = stream.read(&mut request).await.expect("read chapter request");
        let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
        if request_index == 0 {
          assert!(!request.contains("if-none-match:"));
          let body = r#"{
            "version":"1.2.0",
            "chapters":[
              {"startTime":0,"title":"开场"},
              {"startTime":60,"title":"正题"}
            ]
          }"#
            .as_bytes();
          let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json+chapters\r\nETag: \"chapter-v1\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len(),
          );
          stream.write_all(headers.as_bytes()).await.expect("write chapter headers");
          stream.write_all(body).await.expect("write chapter body");
        } else {
          assert!(request.contains("if-none-match: \"chapter-v1\""), "{request}");
          stream
            .write_all(
              b"HTTP/1.1 304 Not Modified\r\nETag: \"chapter-v1\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("write chapter not modified");
        }
        stream.shutdown().await.expect("shutdown chapter response");
      }
    });

    let first = get_episode_chapters_with_network_policy(
      &state.db_path,
      &episode_id,
      true,
    )
    .await
    .expect("fetch external chapters");
    assert_eq!(first.source_kind, "podcast-json");
    assert_eq!(first.chapters.len(), 2);
    assert!(!first.stale);
    let fresh_cache = get_episode_chapters_with_network_policy(
      &state.db_path,
      &episode_id,
      true,
    )
    .await
    .expect("reuse fresh chapter cache without another request");
    assert_eq!(fresh_cache.chapters.len(), 2);
    assert!(!fresh_cache.stale);
    open_database(&state.db_path)
      .expect("open chapter cache database")
      .execute(
        "
        UPDATE podcast_episode_resources
        SET fetched_at = 0
        WHERE episode_id = ?1 AND source_kind = 'podcast-json'
        ",
        [&episode_id],
      )
      .expect("age chapter cache for conditional request");
    let second = get_episode_chapters_with_network_policy(
      &state.db_path,
      &episode_id,
      true,
    )
    .await
    .expect("reuse conditional chapter cache");
    assert_eq!(second.chapters[1].start_seconds, 60.0);
    assert!(!second.stale);
    server.await.expect("chapter server task");
    open_database(&state.db_path)
      .expect("open chapter cache database")
      .execute(
        "
        UPDATE podcast_episode_resources
        SET fetched_at = 0
        WHERE episode_id = ?1 AND source_kind = 'podcast-json'
        ",
        [&episode_id],
      )
      .expect("expire chapter cache for stale fallback");

    let stale = get_episode_chapters_with_network_policy(
      &state.db_path,
      &episode_id,
      true,
    )
    .await
    .expect("fall back to stale chapter cache");
    assert!(stale.stale);
    assert_eq!(stale.chapters.len(), 2);
    assert!(open_database(&state.db_path)
      .expect("open stale chapter database")
      .query_row(
        "
        SELECT error_message
        FROM podcast_episode_resources
        WHERE episode_id = ?1 AND source_kind = 'podcast-json'
        ",
        [&episode_id],
        |row| row.get::<_, Option<String>>(0),
      )
      .expect("chapter error state")
      .is_some());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
}
