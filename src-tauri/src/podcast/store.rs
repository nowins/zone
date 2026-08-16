use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use super::*;

pub(crate) fn open_database(path: &Path) -> Result<Connection, String> {
  // Podcast state shares the unified zone.sqlite file.
  crate::db::open_zone_database(path)
}

pub(crate) fn store_subscription(db_path: &Path, parsed: ParsedPodcast) -> Result<PodcastSubscribeResult, String> {
  store_feed(db_path, &podcast_downloads_dir_for_db(db_path), parsed, true)
}

pub(crate) fn store_preview(db_path: &Path, parsed: ParsedPodcast) -> Result<PodcastSubscribeResult, String> {
  store_feed(db_path, &podcast_downloads_dir_for_db(db_path), parsed, false)
}

// Single source of truth for the managed downloads directory. PodcastState is
// built from the same derivation, so state.downloads_dir and the store-side
// file guards cannot drift apart.
pub(crate) fn podcast_downloads_dir_for_db(db_path: &Path) -> PathBuf {
  db_path
    .parent()
    .map(|parent| parent.join("podcast-downloads"))
    .unwrap_or_else(|| PathBuf::from("podcast-downloads"))
}

fn store_feed(
  db_path: &Path,
  downloads_dir: &Path,
  parsed: ParsedPodcast,
  requested_subscribed: bool,
) -> Result<PodcastSubscribeResult, String> {
  // File deletions are collected while the transaction is open and executed
  // only after a successful commit: a rolled-back refresh must not strand
  // downloads whose rows survive, and file I/O must not stretch the write lock.
  // Leftovers from a crash in between are swept at startup.
  let mut pending_file_deletes: Vec<PathBuf> = Vec::new();
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客订阅：{error}"))?;
  let ParsedPodcast {
    mut feed,
    mut episodes,
    etag,
    last_modified,
  } = parsed;
  let current_feed_url = transaction
    .query_row(
      "SELECT feed_url FROM podcast_feeds WHERE id = ?1",
      [&feed.id],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取播客订阅地址：{error}"))?;
  let url_owner_id = transaction
    .query_row(
      "SELECT id FROM podcast_feeds WHERE feed_url = ?1",
      [&feed.feed_url],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取播客订阅地址：{error}"))?;
  match (current_feed_url, url_owner_id) {
    (Some(current_feed_url), Some(url_owner_id)) if url_owner_id != feed.id => {
      feed.feed_url = current_feed_url;
    }
    (None, Some(url_owner_id)) => {
      feed.id = url_owner_id;
      remap_episode_identifiers(&mut episodes, &feed.id);
    }
    _ => {}
  }
  let existing_subscription = transaction
    .query_row(
      "SELECT subscribed, subscribed_at FROM podcast_feeds WHERE id = ?1",
      [&feed.id],
      |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, Option<i64>>(1)?)),
    )
    .optional()
    .map_err(|error| format!("无法读取播客关注状态：{error}"))?;
  let existing_subscribed = existing_subscription
    .as_ref()
    .is_some_and(|(subscribed, _)| *subscribed);
  feed.subscribed = requested_subscribed || existing_subscribed;
  feed.subscribed_at = if feed.subscribed {
    existing_subscription
      .and_then(|(_, subscribed_at)| subscribed_at)
      .or(Some(feed.last_fetched_at))
  } else {
    None
  };
  feed.last_checked_at = Some(feed.last_checked_at.unwrap_or(feed.last_fetched_at));
  feed.last_refresh_error = None;
  transaction
    .execute(
      "
      INSERT INTO podcast_feeds (
        id, feed_url, title, author, description, artwork_url,
        etag, last_modified, last_fetched_at, subscribed,
        subscribed_at, last_checked_at, last_refresh_error
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(id) DO UPDATE SET
        feed_url = excluded.feed_url,
        title = excluded.title,
        author = excluded.author,
        description = excluded.description,
        artwork_url = excluded.artwork_url,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        last_fetched_at = excluded.last_fetched_at,
        subscribed = excluded.subscribed,
        subscribed_at = excluded.subscribed_at,
        last_checked_at = excluded.last_checked_at,
        last_refresh_error = excluded.last_refresh_error
      ",
      params![
        feed.id,
        feed.feed_url,
        feed.title,
        feed.author,
        feed.description,
        feed.artwork_url,
        etag,
        last_modified,
        feed.last_fetched_at,
        i64::from(feed.subscribed),
        feed.subscribed_at,
        feed.last_checked_at,
        feed.last_refresh_error,
      ],
    )
    .map_err(|error| format!("无法保存播客订阅：{error}"))?;

  let mut inserted_count = 0usize;
  let mut updated_count = 0usize;
  {
    let mut insert = transaction
      .prepare(
        "
        INSERT INTO podcast_episodes (
          id, feed_id, identity_key, guid, title, description, published_at,
          duration_seconds, enclosure_url, enclosure_type, artwork_url, expected_bytes,
          first_seen_at, webpage_url
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO NOTHING
        ",
      )
      .map_err(|error| format!("无法准备播客单集写入：{error}"))?;
    let mut update = transaction
      .prepare(
        "
        UPDATE podcast_episodes SET
          identity_key = ?3,
          guid = ?4,
          title = ?5,
          description = ?6,
          published_at = ?7,
          duration_seconds = ?8,
          enclosure_url = ?9,
          enclosure_type = ?10,
          artwork_url = ?11,
          expected_bytes = ?12,
          webpage_url = ?14
        WHERE id = ?1 AND feed_id = ?2
          AND (
            identity_key IS NOT ?3
            OR guid IS NOT ?4
            OR title IS NOT ?5
            OR description IS NOT ?6
            OR published_at IS NOT ?7
            OR duration_seconds IS NOT ?8
            OR enclosure_url IS NOT ?9
            OR enclosure_type IS NOT ?10
            OR artwork_url IS NOT ?11
            OR expected_bytes IS NOT ?12
            OR webpage_url IS NOT ?14
          )
        ",
      )
      .map_err(|error| format!("无法准备播客单集更新：{error}"))?;
    for episode in &episodes {
      let values = params![
        episode.id,
        episode.feed_id,
        episode.identity_key,
        episode.guid,
        episode.title,
        episode.description,
        episode.published_at,
        episode.duration_seconds,
        episode.enclosure_url,
        episode.enclosure_type,
        episode.artwork_url,
        episode.expected_bytes.and_then(|value| i64::try_from(value).ok()),
        feed.last_fetched_at,
        episode.webpage_url,
      ];
      let inserted = insert
        .execute(values)
        .map_err(|error| format!("无法保存播客单集：{error}"))?;
      inserted_count += inserted;
      if inserted == 0 {
        // Enclosure URL identity drives streaming and offline files. Refresh must
        // drop managed downloads before the episode row switches to the new URL,
        // otherwise playbackLocalPath keeps serving a stale CDN object.
        invalidate_download_if_enclosure_changed(
          &transaction,
          &downloads_dir,
          &episode.id,
          &episode.enclosure_url,
          &mut pending_file_deletes,
        )?;
        updated_count += update
          .execute(params![
          episode.id,
          episode.feed_id,
          episode.identity_key,
          episode.guid,
          episode.title,
          episode.description,
          episode.published_at,
          episode.duration_seconds,
          episode.enclosure_url,
          episode.enclosure_type,
          episode.artwork_url,
          episode.expected_bytes.and_then(|value| i64::try_from(value).ok()),
          feed.last_fetched_at,
          episode.webpage_url,
          ])
          .map_err(|error| format!("无法更新播客单集：{error}"))?;
      }
      reconcile_episode_resources(&transaction, episode)?;
    }
  }
  prune_missing_feed_episodes(&transaction, &downloads_dir, &feed.id, &episodes, &mut pending_file_deletes)?;
  let (latest_episode_at, unplayed_count) = transaction
    .query_row(
      "
      SELECT
        MAX(COALESCE(e.published_at, e.first_seen_at)),
        SUM(
          CASE
            WHEN COALESCE(p.completed, 0) = 0
              AND COALESCE(p.position_seconds, 0) <= 0
            THEN 1
            ELSE 0
          END
        )
      FROM podcast_episodes e
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      WHERE e.feed_id = ?1
      ",
      [&feed.id],
      |row| {
        Ok((
          row.get::<_, Option<i64>>(0)?,
          row.get::<_, Option<i64>>(1)?.unwrap_or(0),
        ))
      },
    )
    .map_err(|error| format!("无法读取播客节目统计：{error}"))?;
  feed.latest_episode_at = latest_episode_at;
  feed.unplayed_count = unplayed_count.max(0) as u64;
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客订阅：{error}"))?;
  for path in &pending_file_deletes {
    if let Err(error) = remove_file_if_present(path, "播客下载文件") {
      eprintln!(
        "[podcast] 订阅源已更新，但下载文件清理失败（{}）：{error}",
        path.display(),
      );
    }
  }

  Ok(PodcastSubscribeResult {
    feed,
    episode_count: episodes.len(),
    inserted_count,
    updated_count,
  })
}

fn prune_missing_feed_episodes(
  transaction: &Transaction<'_>,
  downloads_dir: &Path,
  feed_id: &str,
  current_episodes: &[ParsedPodcastEpisode],
  pending_file_deletes: &mut Vec<PathBuf>,
) -> Result<(), String> {
  let current_ids = current_episodes
    .iter()
    .map(|episode| episode.id.as_str())
    .collect::<HashSet<_>>();
  let existing_ids = {
    let mut statement = transaction
      .prepare("SELECT id FROM podcast_episodes WHERE feed_id = ?1")
      .map_err(|error| format!("无法读取播客单集：{error}"))?;
    let rows = statement
      .query_map([feed_id], |row| row.get::<_, String>(0))
      .map_err(|error| format!("无法读取播客单集：{error}"))?;
    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("无法读取播客单集：{error}"))?
  };

  for episode_id in existing_ids {
    if current_ids.contains(episode_id.as_str()) {
      continue;
    }
    let (
      has_progress,
      is_saved,
      is_queued,
      has_active_download,
    ) = transaction
      .query_row(
        "
        SELECT
          EXISTS(
            SELECT 1
            FROM podcast_progress
            WHERE episode_id = ?1
              AND (completed = 1 OR position_seconds > 0)
          ),
          EXISTS(SELECT 1 FROM podcast_saved_episodes WHERE episode_id = ?1),
          EXISTS(SELECT 1 FROM podcast_queue WHERE episode_id = ?1),
          EXISTS(
            SELECT 1
            FROM podcast_downloads
            WHERE episode_id = ?1
              AND state IN ('downloaded', 'downloading')
          )
        ",
        [&episode_id],
        |row| {
          Ok((
            row.get::<_, i64>(0)? != 0,
            row.get::<_, i64>(1)? != 0,
            row.get::<_, i64>(2)? != 0,
            row.get::<_, i64>(3)? != 0,
          ))
        },
      )
      .map_err(|error| format!("无法检查播客单集保留条件：{error}"))?;
    if has_progress || is_saved || is_queued || has_active_download {
      continue;
    }

    let local_path = transaction
      .query_row(
        "SELECT local_path FROM podcast_downloads WHERE episode_id = ?1",
        [&episode_id],
        |row| row.get::<_, Option<String>>(0),
      )
      .optional()
      .map_err(|error| format!("无法读取播客下载信息：{error}"))?
      .flatten();
    if let Some(local_path) = local_path {
      let path = PathBuf::from(local_path);
      if is_managed_download_path(downloads_dir, &episode_id, &path) {
        pending_file_deletes.push(path);
      }
    }
    pending_file_deletes.push(downloads_dir.join(format!("{episode_id}.part")));
    transaction
      .execute(
        "DELETE FROM podcast_episodes WHERE id = ?1 AND feed_id = ?2",
        params![episode_id, feed_id],
      )
      .map_err(|error| format!("无法清理已下架的播客单集：{error}"))?;
  }
  Ok(())
}

fn invalidate_download_if_enclosure_changed(
  transaction: &Transaction<'_>,
  downloads_dir: &Path,
  episode_id: &str,
  next_enclosure_url: &str,
  pending_file_deletes: &mut Vec<PathBuf>,
) -> Result<(), String> {
  let previous_enclosure_url = transaction
    .query_row(
      "SELECT enclosure_url FROM podcast_episodes WHERE id = ?1",
      [episode_id],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取播客音频地址：{error}"))?;
  let Some(previous_enclosure_url) = previous_enclosure_url else {
    return Ok(());
  };
  if previous_enclosure_url == next_enclosure_url {
    return Ok(());
  }

  let local_path = transaction
    .query_row(
      "SELECT local_path FROM podcast_downloads WHERE episode_id = ?1",
      [episode_id],
      |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取播客下载信息：{error}"))?
    .flatten();
  if let Some(local_path) = local_path {
    let path = PathBuf::from(local_path);
    if is_managed_download_path(downloads_dir, episode_id, &path) {
      pending_file_deletes.push(path);
    }
  }
  pending_file_deletes.push(downloads_dir.join(format!("{episode_id}.part")));
  transaction
    .execute(
      "DELETE FROM podcast_downloads WHERE episode_id = ?1",
      [episode_id],
    )
    .map_err(|error| format!("无法清除失效的播客下载记录：{error}"))?;
  Ok(())
}

fn reconcile_episode_resources(
  transaction: &Transaction<'_>,
  episode: &ParsedPodcastEpisode,
) -> Result<(), String> {
  let Some(resources) = episode.resources.as_ref() else {
    return Ok(());
  };
  let mut existing_statement = transaction
    .prepare("SELECT id FROM podcast_episode_resources WHERE episode_id = ?1")
    .map_err(|error| format!("无法读取播客单集资源：{error}"))?;
  let existing_ids = existing_statement
    .query_map([&episode.id], |row| row.get::<_, String>(0))
    .map_err(|error| format!("无法读取播客单集资源：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客单集资源：{error}"))?;
  drop(existing_statement);

  let mut active_ids = HashSet::new();
  for resource in resources {
    let resource_id = parsed_episode_resource_id(&episode.id, resource);
    active_ids.insert(resource_id.clone());
    transaction
      .execute(
        "
        INSERT INTO podcast_episode_resources (
          id, episode_id, kind, source_kind, url, mime_type, language,
          relation, ordinal, etag, last_modified, fetched_at, error_message
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          episode_id = excluded.episode_id,
          kind = excluded.kind,
          source_kind = excluded.source_kind,
          url = excluded.url,
          mime_type = excluded.mime_type,
          language = excluded.language,
          relation = excluded.relation,
          ordinal = excluded.ordinal
        ",
        params![
          resource_id,
          episode.id,
          resource.kind,
          resource.source_kind,
          resource.url,
          resource.mime_type,
          resource.language,
          resource.relation,
          i64::try_from(resource.ordinal).unwrap_or(i64::MAX),
        ],
      )
      .map_err(|error| format!("无法保存播客单集资源：{error}"))?;
    if resource.source_kind == "psc" {
      replace_podcast_chapters(transaction, &resource_id, &resource.chapters)?;
    }
  }
  for existing_id in existing_ids {
    if active_ids.contains(&existing_id) {
      continue;
    }
    transaction
      .execute(
        "DELETE FROM podcast_episode_resources WHERE id = ?1 AND episode_id = ?2",
        params![existing_id, episode.id],
      )
      .map_err(|error| format!("无法清理播客单集资源：{error}"))?;
  }
  Ok(())
}

fn parsed_episode_resource_id(
  episode_id: &str,
  resource: &ParsedEpisodeResource,
) -> String {
  hash_identifier(
    "episode-resource",
    &[
      episode_id,
      resource.kind,
      resource.source_kind,
      resource.url.as_deref().unwrap_or_default(),
      resource.mime_type.as_deref().unwrap_or_default(),
      resource.language.as_deref().unwrap_or_default(),
      resource.relation.as_deref().unwrap_or_default(),
    ],
  )
}

pub(crate) fn replace_podcast_chapters(
  transaction: &Transaction<'_>,
  resource_id: &str,
  chapters: &[ParsedPodcastChapter],
) -> Result<(), String> {
  transaction
    .execute(
      "DELETE FROM podcast_chapters WHERE resource_id = ?1",
      [resource_id],
    )
    .map_err(|error| format!("无法更新播客章节：{error}"))?;
  let mut insert = transaction
    .prepare(
      "
      INSERT INTO podcast_chapters (
        resource_id, ordinal, start_ms, end_ms, title, href, image_url, visible
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ",
    )
    .map_err(|error| format!("无法准备播客章节写入：{error}"))?;
  for (ordinal, chapter) in chapters.iter().take(PODCAST_CHAPTER_MAX_COUNT).enumerate() {
    insert
      .execute(params![
        resource_id,
        i64::try_from(ordinal).unwrap_or(i64::MAX),
        chapter.start_ms,
        chapter.end_ms,
        chapter.title,
        chapter.href,
        chapter.image_url,
        i64::from(chapter.visible),
      ])
      .map_err(|error| format!("无法保存播客章节：{error}"))?;
  }
  Ok(())
}

pub(crate) fn list_refresh_targets(
  db_path: &Path,
  feed_id: Option<&str>,
  force: bool,
  now: i64,
) -> Result<Vec<PodcastRefreshTarget>, String> {
  let connection = open_database(db_path)?;
  if let Some(feed_id) = feed_id {
    let exists = connection
      .query_row(
        "SELECT 1 FROM podcast_feeds WHERE id = ?1",
        [feed_id],
        |_| Ok(()),
      )
      .optional()
      .map_err(|error| format!("无法读取播客订阅：{error}"))?
      .is_some();
    if !exists {
      return Err("播客节目不存在".to_string());
    }
  }
  let cutoff = now.saturating_sub(PODCAST_REFRESH_INTERVAL);
  let mut statement = connection
    .prepare(
      "
      SELECT id, feed_url, title, author, artwork_url, etag, last_modified
      FROM podcast_feeds
      WHERE ((?1 IS NULL AND subscribed = 1) OR id = ?1)
        AND (?2 = 1 OR last_checked_at IS NULL OR last_checked_at <= ?3)
      ORDER BY COALESCE(last_checked_at, 0), title COLLATE NOCASE
      ",
    )
    .map_err(|error| format!("无法读取播客刷新列表：{error}"))?;
  let rows = statement
    .query_map(
      params![feed_id, i64::from(force), cutoff],
      |row| {
        Ok(PodcastRefreshTarget {
          id: row.get(0)?,
          feed_url: row.get(1)?,
          title: row.get(2)?,
          author: row.get(3)?,
          artwork_url: row.get(4)?,
          etag: row.get(5)?,
          last_modified: row.get(6)?,
        })
      },
    )
    .map_err(|error| format!("无法读取播客刷新列表：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客刷新列表：{error}"))
}

pub(crate) fn mark_refresh_not_modified(
  db_path: &Path,
  feed_id: &str,
  checked_at: i64,
  etag: Option<String>,
  last_modified: Option<String>,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  let changed = connection
    .execute(
      "
      UPDATE podcast_feeds SET
        etag = COALESCE(?3, etag),
        last_modified = COALESCE(?4, last_modified),
        last_checked_at = ?2,
        last_refresh_error = NULL
      WHERE id = ?1
      ",
      params![feed_id, checked_at, etag, last_modified],
    )
    .map_err(|error| format!("无法保存播客刷新状态：{error}"))?;
  if changed == 0 {
    return Err("播客节目不存在".to_string());
  }
  Ok(())
}

pub(crate) fn mark_refresh_failed(
  db_path: &Path,
  feed_id: &str,
  checked_at: i64,
  message: &str,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  let changed = connection
    .execute(
      "
      UPDATE podcast_feeds SET
        last_checked_at = ?2,
        last_refresh_error = ?3
      WHERE id = ?1
      ",
      params![feed_id, checked_at, message],
    )
    .map_err(|error| format!("无法保存播客刷新错误：{error}"))?;
  if changed == 0 {
    return Err("播客节目不存在".to_string());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;

  #[test]
  fn feed_refresh_prunes_unreferenced_episodes_but_keeps_user_state() {
    let directory = test_directory("prune-missing-episodes");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let mut initial = parsed_fixture_with_episode_count(3);
    let feed_id = initial.feed.id.clone();
    let kept_with_progress = initial.episodes[0].id.clone();
    let kept_saved = initial.episodes[1].id.clone();
    let prune_candidate = initial.episodes[2].id.clone();
    store_subscription(&state.db_path, initial.clone()).expect("store subscription");
    save_progress(&state.db_path, &kept_with_progress, 15.0, 100.0).expect("progress");
    set_episode_saved(&state.db_path, &kept_saved, true).expect("save episode");

    initial.feed.last_fetched_at = initial.feed.last_fetched_at.saturating_add(1);
    initial.feed.last_checked_at = Some(initial.feed.last_fetched_at);
    initial.episodes.truncate(2);
    store_preview(&state.db_path, initial).expect("refresh without third episode");

    let remaining = list_episodes(&state.db_path, &state.downloads_dir, &feed_id)
      .expect("list remaining episodes");
    let remaining_ids = remaining
      .iter()
      .map(|episode| episode.id.as_str())
      .collect::<HashSet<_>>();
    assert!(remaining_ids.contains(kept_with_progress.as_str()));
    assert!(remaining_ids.contains(kept_saved.as_str()));
    assert!(!remaining_ids.contains(prune_candidate.as_str()));

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn episode_resources_migrate_reconcile_and_preserve_cached_metadata() {
    let directory = test_directory("episode-resources");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let rss = r#"<?xml version="1.0"?>
      <rss version="2.0"
        xmlns:podcast="https://podcastindex.org/namespace/1.0"
        xmlns:psc="http://podlove.org/simple-chapters">
        <channel>
          <title>资源持久化</title>
          <description>resource persistence</description>
          <item>
            <guid>resource-episode</guid>
            <title>资源单集</title>
            <enclosure url="https://media.example.test/resource.mp3" type="audio/mpeg" />
            <podcast:chapters url="https://cdn.example.test/resource.json"
              type="application/json+chapters" />
            <podcast:transcript url="https://cdn.example.test/resource.vtt"
              type="text/vtt" language="zh" />
            <psc:chapters>
              <psc:chapter start="30" title="第二章" />
              <psc:chapter start="0" title="第一章" />
            </psc:chapters>
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(rss, "resource-persistence");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed.clone()).expect("store resource feed");
    let detail = get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("resource detail");
    assert!(detail.has_chapters);
    assert_eq!(detail.transcript_count, 1);
    let connection = open_database(&state.db_path).expect("open resource database");
    assert_eq!(
      connection
        .query_row(
          "SELECT COUNT(*) FROM podcast_episode_resources WHERE episode_id = ?1",
          [&episode_id],
          |row| row.get::<_, i64>(0),
        )
        .expect("resource count"),
      3,
    );
    assert_eq!(
      connection
        .query_row(
          "SELECT COUNT(*) FROM podcast_chapters",
          [],
          |row| row.get::<_, i64>(0),
        )
        .expect("chapter count"),
      2,
    );
    connection
      .execute(
        "
        UPDATE podcast_episode_resources
        SET etag = 'cached', fetched_at = 42
        WHERE episode_id = ?1 AND source_kind = 'podcast-json'
        ",
        [&episode_id],
      )
      .expect("seed resource cache");
    drop(connection);

    let mut incomplete = parsed.clone();
    incomplete.episodes[0].resources = None;
    store_subscription(&state.db_path, incomplete).expect("store incomplete resource scan");
    let connection = open_database(&state.db_path).expect("reopen resource database");
    assert_eq!(
      connection
        .query_row(
          "
          SELECT etag, fetched_at
          FROM podcast_episode_resources
          WHERE episode_id = ?1 AND source_kind = 'podcast-json'
          ",
          [&episode_id],
          |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .expect("preserved cache"),
      (Some("cached".to_string()), Some(42)),
    );
    drop(connection);

    let mut without_resources = parsed;
    without_resources.episodes[0].resources = Some(Vec::new());
    store_subscription(&state.db_path, without_resources).expect("remove feed resources");
    let detail = get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("detail without resources");
    assert!(!detail.has_chapters);
    assert_eq!(detail.transcript_count, 0);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn legacy_database_migration_marks_existing_feeds_as_subscribed() {
    let directory = test_directory("legacy-migration");
    let legacy_path = directory.join("podcasts.sqlite");
    {
      let connection = Connection::open(&legacy_path).expect("open legacy database");
      connection
        .execute_batch(
          "
          CREATE TABLE podcast_feeds (
            id TEXT PRIMARY KEY,
            feed_url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            author TEXT,
            description TEXT,
            artwork_url TEXT,
            etag TEXT,
            last_modified TEXT,
            last_fetched_at INTEGER NOT NULL
          );
          INSERT INTO podcast_feeds (
            id, feed_url, title, author, description, artwork_url,
            etag, last_modified, last_fetched_at
          ) VALUES (
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'https://feeds.example.test/legacy.xml',
            '旧版节目',
            NULL, NULL, NULL, NULL, NULL, 1
          );
          CREATE TABLE podcast_episodes (
            id TEXT PRIMARY KEY,
            feed_id TEXT NOT NULL REFERENCES podcast_feeds(id) ON DELETE CASCADE,
            identity_key TEXT NOT NULL,
            guid TEXT,
            title TEXT NOT NULL,
            description TEXT,
            published_at INTEGER,
            duration_seconds REAL,
            enclosure_url TEXT NOT NULL,
            enclosure_type TEXT,
            artwork_url TEXT,
            expected_bytes INTEGER,
            UNIQUE(feed_id, identity_key)
          );
          INSERT INTO podcast_episodes (
            id, feed_id, identity_key, guid, title, description, published_at,
            duration_seconds, enclosure_url, enclosure_type, artwork_url, expected_bytes
          ) VALUES (
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'guid:legacy-episode',
            'legacy-episode',
            '旧版单集',
            NULL,
            0,
            60,
            'https://media.example.test/legacy.mp3',
            'audio/mpeg',
            NULL,
            100
          );
          ",
        )
        .expect("create legacy schema");
    }

    let db_path = crate::db::initialize_zone_database(&directory).expect("import legacy into zone db");
    {
      let connection = open_database(&db_path).expect("open unified database");
      let subscribed = connection
        .query_row(
          "SELECT subscribed FROM podcast_feeds WHERE title = '旧版节目'",
          [],
          |row| row.get::<_, i64>(0),
        )
        .expect("read migrated subscription");
      assert_eq!(subscribed, 1);
      let (subscribed_at, last_checked_at, last_refresh_error) = connection
        .query_row(
          "
          SELECT subscribed_at, last_checked_at, last_refresh_error
          FROM podcast_feeds
          WHERE title = '旧版节目'
          ",
          [],
          |row| {
            Ok((
              row.get::<_, Option<i64>>(0)?,
              row.get::<_, Option<i64>>(1)?,
              row.get::<_, Option<String>>(2)?,
            ))
          },
        )
        .expect("read migrated refresh state");
      assert_eq!(subscribed_at, Some(1));
      assert_eq!(last_checked_at, Some(1));
      assert!(last_refresh_error.is_none());
      let (first_seen_at, webpage_url) = connection
        .query_row(
          "
          SELECT first_seen_at, webpage_url
          FROM podcast_episodes
          WHERE title = '旧版单集'
          ",
          [],
          |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .expect("read migrated episode discovery state");
      assert_eq!(first_seen_at, 1);
      assert!(webpage_url.is_none());
      for table in ["podcast_saved_episodes", "podcast_queue"] {
        let exists = connection
          .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
          )
          .optional()
          .expect("inspect migrated table")
          .is_some();
        assert!(exists, "{table} should be created during migration");
      }
    }
    let feeds = list_feeds(&db_path).expect("list migrated feeds");
    assert_eq!(feeds.len(), 1);
    assert!(feeds[0].subscribed);
    assert_eq!(feeds[0].subscribed_at, Some(1));
    assert_eq!(feeds[0].last_checked_at, Some(1));

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn sqlite_subscription_download_and_progress_round_trip() {
    let directory = test_directory("database");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    let first = store_subscription(&state.db_path, parsed.clone()).expect("first subscribe");
    assert_eq!(first.episode_count, 1);
    assert_eq!(first.inserted_count, 1);
    let second = store_subscription(&state.db_path, parsed).expect("second subscribe");
    assert_eq!(second.inserted_count, 0);
    assert_eq!(list_feeds(&state.db_path).expect("list feeds").len(), 1);

    save_progress(&state.db_path, &episode_id, 120.0, 100.0).expect("save progress");
    mark_download_started(&state.db_path, &episode_id, 7, Some(23))
      .expect("save in-progress download");
    let downloading =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
        .expect("read in-progress download");
    assert_eq!(downloading.episode.download_state, "downloading");
    assert_eq!(downloading.episode.downloaded_bytes, 7);
    assert_eq!(downloading.episode.total_bytes, Some(23));
    let fake_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
    fs::write(&fake_path, b"ID3-test-download").expect("write managed download");
    mark_download_complete(&state.db_path, &episode_id, &fake_path.to_string_lossy(), 23, Some(23))
      .expect("save download");
    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &first.feed.id).expect("list episodes");
    assert_eq!(episodes.len(), 1);
    assert_eq!(episodes[0].progress_seconds, 100.0);
    assert!(episodes[0].completed);
    assert_eq!(episodes[0].download_state, "downloaded");
    assert_eq!(episodes[0].downloaded_bytes, 23);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn refresh_selection_throttles_recent_checks_and_rejects_unknown_ids() {
    let directory = test_directory("refresh-selection");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let checked_at = parsed.feed.last_checked_at.expect("initial checked timestamp");
    store_subscription(&state.db_path, parsed).expect("store subscription");

    assert!(
      list_refresh_targets(&state.db_path, None, false, checked_at)
        .expect("throttled global refresh")
        .is_empty()
    );
    assert_eq!(
      list_refresh_targets(&state.db_path, Some(&feed_id), true, checked_at)
        .expect("forced selected refresh")
        .len(),
      1,
    );
    open_database(&state.db_path)
      .expect("open refresh database")
      .execute(
        "UPDATE podcast_feeds SET last_checked_at = ?2 WHERE id = ?1",
        params![feed_id, checked_at.saturating_sub(PODCAST_REFRESH_INTERVAL + 1)],
      )
      .expect("age refresh timestamp");
    assert_eq!(
      list_refresh_targets(&state.db_path, None, false, checked_at)
        .expect("eligible global refresh")
        .len(),
      1,
    );
    assert!(
      list_refresh_targets(&state.db_path, Some(&"f".repeat(64)), true, checked_at)
        .expect_err("unknown selected feed")
        .contains("不存在")
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn enclosure_url_change_invalidates_managed_offline_downloads() {
    let directory = test_directory("enclosure-url-invalidates-download");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed.clone()).expect("store initial subscription");

    let final_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
    let part_path = state.downloads_dir.join(format!("{episode_id}.part"));
    fs::write(&final_path, b"ID3-stale").expect("write managed download");
    fs::write(&part_path, b"ID3-part").expect("write part download");
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &final_path.to_string_lossy(),
      9,
      Some(9),
    )
    .expect("mark managed download");

    let before = get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("detail before enclosure change");
    assert_eq!(before.episode.download_state, "downloaded");
    assert_eq!(
      before.episode.local_path.as_deref(),
      Some(final_path.to_string_lossy().as_ref())
    );

    let mut changed = parsed;
    changed.feed.last_fetched_at = changed.feed.last_fetched_at.saturating_add(1);
    changed.feed.last_checked_at = Some(changed.feed.last_fetched_at);
    changed.episodes[0].enclosure_url =
      "https://cdn.example.test/rotated/episode-1.mp3".to_string();
    let result = store_preview(&state.db_path, changed).expect("store enclosure rotation");
    assert_eq!(result.inserted_count, 0);
    assert_eq!(result.updated_count, 1);

    assert!(!final_path.exists());
    assert!(!part_path.exists());
    let after = get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("detail after enclosure change");
    assert_eq!(
      after.episode.enclosure_url,
      "https://cdn.example.test/rotated/episode-1.mp3"
    );
    assert_eq!(after.episode.download_state, "none");
    assert!(after.episode.local_path.is_none());
    let download_row_exists = open_database(&state.db_path)
      .expect("open database")
      .query_row(
        "SELECT 1 FROM podcast_downloads WHERE episode_id = ?1",
        [&episode_id],
        |_| Ok(()),
      )
      .optional()
      .expect("inspect download row")
      .is_some();
    assert!(!download_row_exists);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn successful_feed_store_clears_missing_validators_and_counts_only_changes() {
    let directory = test_directory("refresh-store-outcome");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed.clone()).expect("store initial subscription");

    let mut changed = parsed;
    changed.etag = None;
    changed.last_modified = None;
    changed.feed.last_fetched_at = changed.feed.last_fetched_at.saturating_add(1);
    changed.feed.last_checked_at = Some(changed.feed.last_fetched_at);
    changed.episodes[0].title = "第一集（修订）".to_string();
    let result = store_preview(&state.db_path, changed.clone()).expect("store changed refresh");
    assert_eq!(result.inserted_count, 0);
    assert_eq!(result.updated_count, 1);
    let (etag, last_modified) = open_database(&state.db_path)
      .expect("open refreshed database")
      .query_row(
        "SELECT etag, last_modified FROM podcast_feeds WHERE id = ?1",
        [&feed_id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
      )
      .expect("read cleared validators");
    assert!(etag.is_none());
    assert!(last_modified.is_none());
    let episode =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("updated episode");
    assert_eq!(episode.episode.title, "第一集（修订）");

    let unchanged = store_preview(&state.db_path, changed).expect("store unchanged refresh");
    assert_eq!(unchanged.inserted_count, 0);
    assert_eq!(unchanged.updated_count, 0);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn refresh_keeps_its_existing_url_when_the_canonical_url_has_another_owner() {
    let directory = test_directory("refresh-url-owner-conflict");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let source_url = "https://feeds.example.test/source.xml";
    let canonical_url = "https://feeds.example.test/canonical.xml";
    let source = parsed_fixture_at(
      "https://media.example.test/episode-1.mp3",
      source_url,
    );
    let canonical = parsed_fixture_at(
      "https://media.example.test/episode-1.mp3",
      canonical_url,
    );
    let source_id = source.feed.id.clone();
    let canonical_id = canonical.feed.id.clone();
    assert_ne!(source_id, canonical_id);
    store_subscription(&state.db_path, source).expect("store source subscription");
    store_preview(&state.db_path, canonical.clone()).expect("store canonical preview");

    let mut redirected_refresh = canonical;
    retain_refresh_identifiers(&mut redirected_refresh, &source_id);
    let refreshed =
      store_preview(&state.db_path, redirected_refresh).expect("store conflicting redirect refresh");
    assert_eq!(refreshed.feed.id, source_id);
    assert_eq!(refreshed.feed.feed_url, source_url);
    assert!(refreshed.feed.subscribed);

    let connection = open_database(&state.db_path).expect("open conflicted database");
    let mut statement = connection
      .prepare("SELECT id, feed_url, subscribed FROM podcast_feeds ORDER BY id")
      .expect("prepare feed identities");
    let rows = statement
      .query_map([], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, i64>(2)? != 0,
        ))
      })
      .expect("read feed identities")
      .collect::<Result<Vec<_>, _>>()
      .expect("collect feed identities");
    assert_eq!(rows.len(), 2);
    assert!(
      rows
        .iter()
        .any(|row| row.0 == source_id && row.1 == source_url && row.2)
    );
    assert!(
      rows
        .iter()
        .any(|row| row.0 == canonical_id && row.1 == canonical_url && !row.2)
    );
    drop(statement);
    drop(connection);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn preview_reuses_the_url_owner_and_preserves_all_episode_state() {
    let directory = test_directory("preview-url-owner-reuse");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let source_url = "https://feeds.example.test/source.xml";
    let canonical_url = "https://feeds.example.test/canonical.xml";
    let source = parsed_fixture_at(
      "https://media.example.test/episode-1.mp3",
      source_url,
    );
    let owner_feed_id = source.feed.id.clone();
    let owner_episode_id = source.episodes[0].id.clone();
    store_subscription(&state.db_path, source).expect("store source subscription");

    let mut canonical_refresh = parsed_fixture_at(
      "https://media.example.test/episode-1.mp3",
      canonical_url,
    );
    retain_refresh_identifiers(&mut canonical_refresh, &owner_feed_id);
    let canonical_owner =
      store_preview(&state.db_path, canonical_refresh).expect("store canonical redirect");
    assert_eq!(canonical_owner.feed.id, owner_feed_id);
    assert_eq!(canonical_owner.feed.feed_url, canonical_url);

    save_progress(&state.db_path, &owner_episode_id, 30.0, 100.0).expect("save episode progress");
    set_episode_saved(&state.db_path, &owner_episode_id, true).expect("save episode");
    queue_add(&state.db_path, &owner_episode_id, false).expect("queue episode");
    let local_path = state.downloads_dir.join(format!("{owner_episode_id}.mp3"));
    fs::write(&local_path, b"ID3-url-owner").expect("write managed download");
    mark_download_complete(
      &state.db_path,
      &owner_episode_id,
      &local_path.to_string_lossy(),
      13,
      Some(13),
    )
    .expect("save managed download");

    let mut incoming = parsed_fixture_at(
      "https://media.example.test/episode-1.mp3",
      canonical_url,
    );
    let discarded_feed_id = incoming.feed.id.clone();
    let discarded_episode_id = incoming.episodes[0].id.clone();
    assert_ne!(discarded_feed_id, owner_feed_id);
    assert_ne!(discarded_episode_id, owner_episode_id);
    incoming.episodes[0].title = "第一集（目录更新）".to_string();
    let reused = store_preview(&state.db_path, incoming).expect("reuse canonical URL owner");
    assert_eq!(reused.feed.id, owner_feed_id);
    assert_eq!(reused.feed.feed_url, canonical_url);
    assert!(reused.feed.subscribed);
    assert_eq!(reused.inserted_count, 0);
    assert_eq!(reused.updated_count, 1);

    let connection = open_database(&state.db_path).expect("open reused database");
    let feed_count = connection
      .query_row("SELECT COUNT(*) FROM podcast_feeds", [], |row| row.get::<_, i64>(0))
      .expect("count feeds");
    assert_eq!(feed_count, 1);
    assert!(
      connection
        .query_row(
          "SELECT 1 FROM podcast_feeds WHERE id = ?1",
          [&discarded_feed_id],
          |_| Ok(()),
        )
        .optional()
        .expect("inspect discarded feed identity")
        .is_none()
    );
    assert!(
      connection
        .query_row(
          "SELECT 1 FROM podcast_episodes WHERE id = ?1",
          [&discarded_episode_id],
          |_| Ok(()),
        )
        .optional()
        .expect("inspect discarded episode identity")
        .is_none()
    );
    drop(connection);

    let detail = get_episode_detail(
      &state.db_path,
      &state.downloads_dir,
      &owner_episode_id,
    )
    .expect("read preserved episode state");
    assert_eq!(detail.episode.title, "第一集（目录更新）");
    assert_eq!(detail.episode.progress_seconds, 30.0);
    assert_eq!(detail.episode.download_state, "downloaded");
    assert_eq!(
      detail.episode.local_path.as_deref(),
      Some(local_path.to_string_lossy().as_ref())
    );
    assert!(detail.saved);
    assert_eq!(detail.queue_position, Some(0));

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
}
