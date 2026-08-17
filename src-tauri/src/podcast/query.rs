use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use super::*;

pub(crate) fn get_recent_preview(
  db_path: &Path,
  feed_url: &str,
  now: i64,
) -> Result<Option<PodcastSubscribeResult>, String> {
  let normalized_url = normalize_url(feed_url, false)?;
  let cutoff = now.saturating_sub(PODCAST_REFRESH_INTERVAL);
  let connection = open_database(db_path)?;
  connection
    .query_row(
      "
      SELECT
        f.id, f.feed_url, f.title, f.author, f.description, f.artwork_url,
        f.last_fetched_at, f.subscribed, f.subscribed_at,
        f.last_checked_at, f.last_refresh_error,
        (
          SELECT MAX(COALESCE(e.published_at, e.first_seen_at))
          FROM podcast_episodes e
          WHERE e.feed_id = f.id
        ),
        (
          SELECT COUNT(*)
          FROM podcast_episodes e
          LEFT JOIN podcast_progress p ON p.episode_id = e.id
          WHERE e.feed_id = f.id
            AND COALESCE(p.completed, 0) = 0
            AND COALESCE(p.position_seconds, 0) <= 0
        ),
        (
          SELECT COUNT(*)
          FROM podcast_episodes e
          WHERE e.feed_id = f.id
        ),
        (
          SELECT latest.title
          FROM podcast_episodes latest
          WHERE latest.feed_id = f.id
          ORDER BY COALESCE(latest.published_at, latest.first_seen_at) DESC, latest.id
          LIMIT 1
        )
      FROM podcast_feeds f
      WHERE f.feed_url = ?1 AND f.last_fetched_at >= ?2
      LIMIT 1
      ",
      params![normalized_url, cutoff],
      |row| {
        let episode_count = row.get::<_, i64>(13)?.max(0);
        Ok(PodcastSubscribeResult {
          feed: PodcastFeed {
            id: row.get(0)?,
            feed_url: row.get(1)?,
            title: row.get(2)?,
            author: row.get(3)?,
            description: row.get(4)?,
            artwork_url: row.get(5)?,
            last_fetched_at: row.get(6)?,
            subscribed: row.get::<_, i64>(7)? != 0,
            subscribed_at: row.get(8)?,
            last_checked_at: row.get(9)?,
            last_refresh_error: row.get(10)?,
          latest_episode_at: row.get(11)?,
          unplayed_count: row.get::<_, i64>(12)?.max(0) as u64,
          latest_episode_title: row.get(14)?,
        },
          episode_count: usize::try_from(episode_count).unwrap_or(usize::MAX),
          inserted_count: 0,
          updated_count: 0,
        })
      },
    )
    .optional()
    .map_err(|error| format!("无法读取播客预览缓存：{error}"))
}

pub(crate) fn list_feeds(db_path: &Path) -> Result<Vec<PodcastFeed>, String> {
  list_feeds_with_policy(db_path, false)
}

pub(crate) fn list_feeds_with_policy(
  db_path: &Path,
  include_unsubscribed: bool,
) -> Result<Vec<PodcastFeed>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(&format!(
      "
      SELECT
        f.id, f.feed_url, f.title, f.author, f.description, f.artwork_url,
        f.last_fetched_at, f.subscribed, f.subscribed_at,
        f.last_checked_at, f.last_refresh_error,
        (
          SELECT MAX(COALESCE(e.published_at, e.first_seen_at))
          FROM podcast_episodes e
          WHERE e.feed_id = f.id
        ),
        (
          SELECT COUNT(*)
          FROM podcast_episodes e
          LEFT JOIN podcast_progress p ON p.episode_id = e.id
          WHERE e.feed_id = f.id
            AND COALESCE(p.completed, 0) = 0
            AND COALESCE(p.position_seconds, 0) <= 0
        ),
        (
          SELECT latest.title
          FROM podcast_episodes latest
          WHERE latest.feed_id = f.id
          ORDER BY COALESCE(latest.published_at, latest.first_seen_at) DESC, latest.id
          LIMIT 1
        )
      FROM podcast_feeds f
      WHERE {subscription_filter}
      ORDER BY f.title COLLATE NOCASE, f.id
      ",
      subscription_filter = if include_unsubscribed {
        "1 = 1"
      } else {
        "f.subscribed = 1"
      },
    ))
    .map_err(|error| format!("无法读取播客订阅：{error}"))?;
  let rows = statement
    .query_map([], |row| {
      Ok(PodcastFeed {
        id: row.get(0)?,
        feed_url: row.get(1)?,
        title: row.get(2)?,
        author: row.get(3)?,
        description: row.get(4)?,
        artwork_url: row.get(5)?,
        last_fetched_at: row.get(6)?,
        subscribed: row.get::<_, i64>(7)? != 0,
        subscribed_at: row.get(8)?,
        last_checked_at: row.get(9)?,
          last_refresh_error: row.get(10)?,
          latest_episode_at: row.get(11)?,
          unplayed_count: row.get::<_, i64>(12)?.max(0) as u64,
          latest_episode_title: row.get(13)?,
        })
    })
    .map_err(|error| format!("无法读取播客订阅：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客订阅：{error}"))
}

pub(crate) fn set_following(db_path: &Path, feed_id: &str, following: bool) -> Result<(), String> {
  let connection = open_database(db_path)?;
  let changed = connection
    .execute(
      "
      UPDATE podcast_feeds SET
        subscribed = ?2,
        subscribed_at = CASE
          WHEN ?2 = 0 THEN NULL
          WHEN subscribed = 0 OR subscribed_at IS NULL THEN ?3
          ELSE subscribed_at
        END
      WHERE id = ?1
      ",
      params![feed_id, i64::from(following), unix_time_millis()],
    )
    .map_err(|error| format!("无法更新播客关注状态：{error}"))?;
  if changed == 0 {
    return Err("播客节目不存在".to_string());
  }
  Ok(())
}

pub(crate) fn list_episodes(
  db_path: &Path,
  downloads_dir: &Path,
  feed_id: &str,
) -> Result<Vec<PodcastEpisode>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT
        e.id, e.feed_id, e.title, e.description, e.published_at,
        e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
        COALESCE(d.state, 'none'), d.local_path,
        COALESCE(d.downloaded_bytes, 0), d.total_bytes,
        COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
        f.title, f.artwork_url,
        CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
        e.first_seen_at, e.webpage_url
      FROM podcast_episodes e
      JOIN podcast_feeds f ON f.id = e.feed_id
      LEFT JOIN podcast_downloads d ON d.episode_id = e.id
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
      WHERE e.feed_id = ?1
      ORDER BY e.published_at IS NULL, e.published_at DESC, e.title COLLATE NOCASE
      LIMIT 5000
      ",
    )
    .map_err(|error| format!("无法读取播客单集：{error}"))?;
  let rows = statement
    .query_map([feed_id], |row| podcast_episode_from_row(row, downloads_dir))
    .map_err(|error| format!("无法读取播客单集：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客单集：{error}"))
}

pub(crate) fn list_related_episodes(
  db_path: &Path,
  downloads_dir: &Path,
  episode_id: &str,
  limit: usize,
) -> Result<Vec<PodcastEpisode>, String> {
  validate_identifier(episode_id)?;
  let connection = open_database(db_path)?;
  ensure_episode_exists(&connection, episode_id)?;
  let limit = limit.clamp(1, PODCAST_RELATED_EPISODE_MAX_LIMIT) as i64;
  let mut statement = connection
    .prepare(
      "
      WITH current_episode AS (
        SELECT feed_id
        FROM podcast_episodes
        WHERE id = ?1
      )
      SELECT
        e.id, e.feed_id, e.title, e.description, e.published_at,
        e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
        COALESCE(d.state, 'none'), d.local_path,
        COALESCE(d.downloaded_bytes, 0), d.total_bytes,
        COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
        f.title, f.artwork_url,
        CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
        e.first_seen_at, e.webpage_url
      FROM podcast_episodes e
      JOIN current_episode current ON current.feed_id = e.feed_id
      JOIN podcast_feeds f ON f.id = e.feed_id
      LEFT JOIN podcast_downloads d ON d.episode_id = e.id
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
      WHERE e.id != ?1
        AND TRIM(e.enclosure_url) != ''
      ORDER BY
        e.published_at IS NULL,
        COALESCE(e.published_at, e.first_seen_at) DESC,
        e.id
      LIMIT ?2
      ",
    )
    .map_err(|error| format!("无法读取相关播客单集：{error}"))?;
  let rows = statement
    .query_map(
      params![episode_id, limit],
      |row| podcast_episode_from_row(row, downloads_dir),
    )
    .map_err(|error| format!("无法读取相关播客单集：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取相关播客单集：{error}"))
}

pub(crate) fn list_home(db_path: &Path, downloads_dir: &Path) -> Result<PodcastHome, String> {
  let connection = open_database(db_path)?;
  prune_stale_download_records(&connection, downloads_dir)?;
  let continue_listening = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE p.position_seconds > 0 AND p.completed = 0
    ORDER BY p.updated_at DESC
    LIMIT ?1
    ",
    PODCAST_HOME_CONTINUE_LIMIT,
  )?;
  let latest_episodes = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE f.subscribed = 1
    ORDER BY COALESCE(e.published_at, e.first_seen_at) DESC, e.id
    LIMIT ?1
    ",
    PODCAST_HOME_LATEST_LIMIT,
  )?;
  let unplayed_episodes = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE f.subscribed = 1
      AND COALESCE(p.completed, 0) = 0
      AND COALESCE(p.position_seconds, 0) <= 0
    ORDER BY COALESCE(e.published_at, e.first_seen_at) DESC, e.id
    LIMIT ?1
    ",
    PODCAST_HOME_UNPLAYED_LIMIT,
  )?;
  let download_priority_episodes = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE f.subscribed = 1
    ORDER BY
      CASE
        WHEN d.state = 'downloaded'
          AND NULLIF(TRIM(d.local_path), '') IS NOT NULL
        THEN 0
        ELSE 1
      END,
      COALESCE(e.published_at, e.first_seen_at) DESC,
      e.id
    LIMIT ?1
    ",
    PODCAST_HOME_DOWNLOAD_PRIORITY_LIMIT,
  )?;
  let downloaded_episodes = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_episodes e
    JOIN podcast_feeds f ON f.id = e.feed_id
    JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE d.state = 'downloaded'
    ORDER BY d.updated_at DESC, e.id
    LIMIT ?1
    ",
    PODCAST_HOME_DOWNLOADED_LIMIT.saturating_mul(4),
  )?
  .into_iter()
  .filter(|episode| episode.download_state == "downloaded")
  .take(PODCAST_HOME_DOWNLOADED_LIMIT)
  .collect();
  let saved_episodes = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      1,
      e.first_seen_at, e.webpage_url
    FROM podcast_saved_episodes s
    JOIN podcast_episodes e ON e.id = s.episode_id
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_progress p ON p.episode_id = e.id
    ORDER BY s.saved_at DESC, e.id
    LIMIT ?1
    ",
    PODCAST_HOME_SAVED_LIMIT,
  )?;
  let recently_played_episodes = query_home_episodes(
    &connection,
    downloads_dir,
    "
    SELECT
      e.id, e.feed_id, e.title, e.description, e.published_at,
      e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
      COALESCE(d.state, 'none'), d.local_path,
      COALESCE(d.downloaded_bytes, 0), d.total_bytes,
      COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
      f.title, f.artwork_url,
      CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
      e.first_seen_at, e.webpage_url
    FROM podcast_progress p
    JOIN podcast_episodes e ON e.id = p.episode_id
    JOIN podcast_feeds f ON f.id = e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id = e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
    WHERE p.position_seconds > 0 OR p.completed = 1
    ORDER BY p.updated_at DESC, e.id
    LIMIT ?1
    ",
    PODCAST_HOME_RECENTLY_PLAYED_LIMIT,
  )?;

  Ok(PodcastHome {
    continue_listening,
    latest_episodes,
    unplayed_episodes,
    download_priority_episodes,
    downloaded_episodes,
    saved_episodes,
    recently_played_episodes,
  })
}

pub(crate) fn list_downloads(
  db_path: &Path,
  downloads_dir: &Path,
  offset: usize,
  limit: usize,
) -> Result<PodcastDownloadPage, String> {
  let mut connection = open_database(db_path)?;
  prune_stale_download_records(&connection, downloads_dir)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Deferred)
    .map_err(|error| format!("无法读取播客下载资料库：{error}"))?;
  let (total_count, total_bytes, feed_count) = transaction
    .query_row(
      "
      SELECT
        COUNT(*),
        COALESCE(
          SUM(
            CASE
              WHEN d.downloaded_bytes > 0 THEN d.downloaded_bytes
              ELSE 0
            END
          ),
          0
        ),
        COUNT(DISTINCT e.feed_id)
      FROM podcast_downloads d
      JOIN podcast_episodes e ON e.id = d.episode_id
      WHERE d.state = 'downloaded'
      ",
      [],
      |row| {
        Ok((
          row.get::<_, i64>(0)?.max(0) as u64,
          row.get::<_, i64>(1)?.max(0) as u64,
          row.get::<_, i64>(2)?.max(0) as u64,
        ))
      },
    )
    .map_err(|error| format!("无法统计播客下载资料库：{error}"))?;

  let limit = limit.clamp(1, PODCAST_DOWNLOAD_PAGE_MAX_LIMIT);
  let sql_limit = i64::try_from(limit).unwrap_or(i64::MAX);
  let sql_offset = i64::try_from(offset).unwrap_or(i64::MAX);
  let episodes = {
    let mut statement = transaction
      .prepare(
        "
        SELECT
          e.id, e.feed_id, e.title, e.description, e.published_at,
          e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
          d.state, d.local_path, d.downloaded_bytes, d.total_bytes,
          COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
          f.title, f.artwork_url,
          CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
          e.first_seen_at, e.webpage_url
        FROM podcast_downloads d
        JOIN podcast_episodes e ON e.id = d.episode_id
        JOIN podcast_feeds f ON f.id = e.feed_id
        LEFT JOIN podcast_progress p ON p.episode_id = e.id
        LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
        WHERE d.state = 'downloaded'
        ORDER BY d.updated_at DESC, e.id
        LIMIT ?1 OFFSET ?2
        ",
      )
      .map_err(|error| format!("无法读取播客下载资料库：{error}"))?;
    let rows = statement
      .query_map(params![sql_limit, sql_offset], |row| {
        podcast_episode_from_row(row, downloads_dir)
      })
      .map_err(|error| format!("无法读取播客下载资料库：{error}"))?;
    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("无法读取播客下载资料库：{error}"))?
      .into_iter()
      .filter(|episode| episode.download_state == "downloaded")
      .collect::<Vec<_>>()
  };
  let returned_end = u64::try_from(offset)
    .unwrap_or(u64::MAX)
    .saturating_add(u64::try_from(episodes.len()).unwrap_or(u64::MAX));

  Ok(PodcastDownloadPage {
    episodes,
    total_count,
    total_bytes,
    feed_count,
    has_more: returned_end < total_count,
  })
}

fn prune_stale_download_records(
  connection: &Connection,
  downloads_dir: &Path,
) -> Result<(), String> {
  let downloads = {
    let mut statement = connection
      .prepare(
        "
        SELECT episode_id, local_path, updated_at
        FROM podcast_downloads
        WHERE state = 'downloaded'
        ",
      )
      .map_err(|error| format!("无法检查播客下载状态：{error}"))?;
    let rows = statement
      .query_map([], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, Option<String>>(1)?,
          row.get::<_, i64>(2)?,
        ))
      })
      .map_err(|error| format!("无法检查播客下载状态：{error}"))?;
    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("无法检查播客下载状态：{error}"))?
  };

  for (episode_id, local_path, updated_at) in downloads {
    let valid = local_path.as_deref().is_some_and(|value| {
      let path = PathBuf::from(value);
      path.is_file() && is_managed_download_path(downloads_dir, &episode_id, &path)
    });
    if valid {
      continue;
    }
    connection
      .execute(
        "
        DELETE FROM podcast_downloads
        WHERE episode_id = ?1
          AND state = 'downloaded'
          AND (
            (local_path IS NULL AND ?2 IS NULL)
            OR local_path = ?2
          )
          AND updated_at = ?3
        ",
        params![episode_id, local_path, updated_at],
      )
      .map_err(|error| format!("无法清理失效的播客下载状态：{error}"))?;
  }
  Ok(())
}

fn query_home_episodes(
  connection: &Connection,
  downloads_dir: &Path,
  sql: &str,
  limit: usize,
) -> Result<Vec<PodcastEpisode>, String> {
  let mut statement = connection
    .prepare(sql)
    .map_err(|error| format!("无法读取播客首页：{error}"))?;
  let rows = statement
    .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
      podcast_episode_from_row(row, downloads_dir)
    })
    .map_err(|error| format!("无法读取播客首页：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客首页：{error}"))
}

pub(crate) fn podcast_episode_from_row(
  row: &rusqlite::Row<'_>,
  downloads_dir: &Path,
) -> rusqlite::Result<PodcastEpisode> {
  let id = row.get::<_, String>(0)?;
  let mut download_state = row.get::<_, String>(9)?;
  let raw_local_path = row.get::<_, Option<String>>(10)?;
  let mut downloaded_bytes = row.get::<_, i64>(11)?.max(0) as u64;
  let mut total_bytes = row.get::<_, Option<i64>>(12)?.map(|value| value.max(0) as u64);
  let local_path = if download_state == "downloaded" {
    raw_local_path.filter(|value| {
      let path = PathBuf::from(value);
      path.is_file() && is_managed_download_path(downloads_dir, &id, &path)
    })
  } else {
    None
  };
  if download_state == "downloaded" && local_path.is_none() {
    download_state = "none".to_string();
    downloaded_bytes = 0;
    total_bytes = None;
  }
  Ok(PodcastEpisode {
    id,
    feed_id: row.get(1)?,
    title: row.get(2)?,
    description: row.get(3)?,
    published_at: row.get(4)?,
    duration_seconds: row.get(5)?,
    enclosure_url: row.get(6)?,
    enclosure_type: row.get(7)?,
    artwork_url: row.get(8)?,
    download_state,
    local_path,
    downloaded_bytes,
    total_bytes,
    progress_seconds: row.get(13)?,
    completed: row.get::<_, i64>(14)? != 0,
    feed_title: row.get(15)?,
    feed_artwork_url: row.get(16)?,
    saved: row.get::<_, i64>(17)? != 0,
    first_seen_at: row.get(18)?,
    webpage_url: row.get(19)?,
  })
}

pub(crate) const PODCAST_EPISODE_DETAIL_SELECT: &str = "
  SELECT
    e.id, e.feed_id, e.title, e.description, e.published_at,
    e.duration_seconds, e.enclosure_url, e.enclosure_type, e.artwork_url,
    COALESCE(d.state, 'none'), d.local_path,
    COALESCE(d.downloaded_bytes, 0), d.total_bytes,
    COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
    f.title, f.artwork_url,
    CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
    e.first_seen_at, e.webpage_url,
    e.expected_bytes, d.error_message, s.saved_at, q.position,
    f.feed_url, f.author, f.description, f.last_fetched_at, f.subscribed,
    f.subscribed_at, f.last_checked_at, f.last_refresh_error,
    (
      SELECT MAX(COALESCE(feed_episode.published_at, feed_episode.first_seen_at))
      FROM podcast_episodes feed_episode
      WHERE feed_episode.feed_id = f.id
    ),
    (
      SELECT COUNT(*)
      FROM podcast_episodes feed_episode
      LEFT JOIN podcast_progress feed_progress
        ON feed_progress.episode_id = feed_episode.id
      WHERE feed_episode.feed_id = f.id
        AND COALESCE(feed_progress.completed, 0) = 0
        AND COALESCE(feed_progress.position_seconds, 0) <= 0
    ),
    EXISTS(
      SELECT 1
      FROM podcast_episode_resources resource
      WHERE resource.episode_id = e.id
        AND resource.kind = 'chapters'
    ),
    (
      SELECT COUNT(*)
      FROM podcast_episode_resources resource
      WHERE resource.episode_id = e.id
        AND resource.kind = 'transcript'
    ),
    (
      SELECT latest.title
      FROM podcast_episodes latest
      WHERE latest.feed_id = f.id
      ORDER BY COALESCE(latest.published_at, latest.first_seen_at) DESC, latest.id
      LIMIT 1
    )
  FROM podcast_episodes e
  JOIN podcast_feeds f ON f.id = e.feed_id
  LEFT JOIN podcast_downloads d ON d.episode_id = e.id
  LEFT JOIN podcast_progress p ON p.episode_id = e.id
  LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
  LEFT JOIN podcast_queue q ON q.episode_id = e.id
";

pub(crate) fn podcast_episode_detail_from_row(
  row: &rusqlite::Row<'_>,
  downloads_dir: &Path,
) -> rusqlite::Result<PodcastEpisodeDetail> {
  let episode = podcast_episode_from_row(row, downloads_dir)?;
  let expected_bytes = row
    .get::<_, Option<i64>>(20)?
    .and_then(|value| u64::try_from(value).ok());
  let queue_position = row
    .get::<_, Option<i64>>(23)?
    .and_then(|value| u32::try_from(value).ok());
  Ok(PodcastEpisodeDetail {
    saved: episode.saved,
    episode,
    feed: PodcastFeed {
      id: row.get(1)?,
      feed_url: row.get(24)?,
      title: row.get(15)?,
      author: row.get(25)?,
      description: row.get(26)?,
      artwork_url: row.get(16)?,
      last_fetched_at: row.get(27)?,
      subscribed: row.get::<_, i64>(28)? != 0,
      subscribed_at: row.get(29)?,
      last_checked_at: row.get(30)?,
      last_refresh_error: row.get(31)?,
      latest_episode_at: row.get(32)?,
      unplayed_count: row.get::<_, i64>(33)?.max(0) as u64,
      latest_episode_title: row.get(36)?,
    },
    expected_bytes,
    download_error: row.get(21)?,
    saved_at: row.get(22)?,
    queue_position,
    has_chapters: row.get::<_, i64>(34)? != 0,
    transcript_count: row
      .get::<_, i64>(35)?
      .max(0)
      .try_into()
      .unwrap_or(u32::MAX),
  })
}
pub(crate) fn set_episode_saved(db_path: &Path, episode_id: &str, saved: bool) -> Result<(), String> {
  let connection = open_database(db_path)?;
  ensure_episode_exists(&connection, episode_id)?;
  if saved {
    connection
      .execute(
        "
        INSERT INTO podcast_saved_episodes (episode_id, saved_at)
        VALUES (?1, ?2)
        ON CONFLICT(episode_id) DO NOTHING
        ",
        params![episode_id, unix_time_millis()],
      )
      .map_err(|error| format!("无法保存播客单集：{error}"))?;
  } else {
    connection
      .execute(
        "DELETE FROM podcast_saved_episodes WHERE episode_id = ?1",
        [episode_id],
      )
      .map_err(|error| format!("无法取消保存播客单集：{error}"))?;
  }
  Ok(())
}

pub(crate) fn list_saved_episodes(
  db_path: &Path,
  downloads_dir: &Path,
) -> Result<Vec<PodcastEpisodeDetail>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(&format!(
      "{PODCAST_EPISODE_DETAIL_SELECT}
       WHERE s.episode_id IS NOT NULL
       ORDER BY s.saved_at DESC, e.id
       LIMIT 5000"
    ))
    .map_err(|error| format!("无法读取已保存的播客单集：{error}"))?;
  let rows = statement
    .query_map([], |row| podcast_episode_detail_from_row(row, downloads_dir))
    .map_err(|error| format!("无法读取已保存的播客单集：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取已保存的播客单集：{error}"))
}

pub(crate) fn set_episode_played(db_path: &Path, episode_id: &str, played: bool) -> Result<(), String> {
  let connection = open_database(db_path)?;
  set_episode_played_on_connection(&connection, episode_id, played)
}

fn set_episode_played_on_connection(
  connection: &Connection,
  episode_id: &str,
  played: bool,
) -> Result<(), String> {
  let progress = connection
    .query_row(
      "
      SELECT e.duration_seconds, p.duration_seconds, p.position_seconds
      FROM podcast_episodes e
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      WHERE e.id = ?1
      ",
      [episode_id],
      |row| {
        Ok((
          row.get::<_, Option<f64>>(0)?,
          row.get::<_, Option<f64>>(1)?,
          row.get::<_, Option<f64>>(2)?,
        ))
      },
    )
    .optional()
    .map_err(|error| format!("无法读取播客播放状态：{error}"))?
    .ok_or_else(|| "播客单集不存在".to_string())?;

  if !played {
    connection
      .execute("DELETE FROM podcast_progress WHERE episode_id = ?1", [episode_id])
      .map_err(|error| format!("无法标记播客单集为未播放：{error}"))?;
    return Ok(());
  }

  let duration_seconds = progress
    .1
    .filter(|value| value.is_finite() && *value > 0.0)
    .or_else(|| progress.0.filter(|value| value.is_finite() && *value > 0.0));
  let current_position = progress
    .2
    .filter(|value| value.is_finite() && *value >= 0.0)
    .unwrap_or(0.0);
  let position_seconds = duration_seconds.unwrap_or(current_position);
  connection
    .execute(
      "
      INSERT INTO podcast_progress (
        episode_id, position_seconds, duration_seconds, completed, updated_at
      ) VALUES (?1, ?2, ?3, 1, ?4)
      ON CONFLICT(episode_id) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        completed = 1,
        updated_at = excluded.updated_at
      ",
      params![episode_id, position_seconds, duration_seconds, unix_time_millis()],
    )
    .map_err(|error| format!("无法标记播客单集为已播放：{error}"))?;
  Ok(())
}

pub(crate) fn validate_bulk_episode_identifiers(episode_ids: &[String]) -> Result<Vec<String>, String> {
  if episode_ids.is_empty() {
    return Err("请至少选择一集播客".to_string());
  }
  if episode_ids.len() > PODCAST_EPISODE_BATCH_LIMIT {
    return Err(format!(
      "一次最多可处理 {PODCAST_EPISODE_BATCH_LIMIT} 集播客"
    ));
  }
  for episode_id in episode_ids {
    validate_identifier(episode_id)?;
  }
  let mut unique = HashSet::with_capacity(episode_ids.len());
  Ok(
    episode_ids
      .iter()
      .filter(|episode_id| unique.insert(episode_id.as_str()))
      .cloned()
      .collect(),
  )
}

pub(crate) fn set_episodes_played(
  db_path: &Path,
  episode_ids: &[String],
  played: bool,
) -> Result<Vec<String>, String> {
  let episode_ids = validate_bulk_episode_identifiers(episode_ids)?;
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法批量更新播客播放状态：{error}"))?;
  for episode_id in &episode_ids {
    ensure_episode_exists(&transaction, episode_id)?;
  }
  for episode_id in &episode_ids {
    set_episode_played_on_connection(&transaction, episode_id, played)?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客播放状态：{error}"))?;
  Ok(episode_ids)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;

  #[test]
  fn recent_preview_reuses_database_content_until_refresh_is_due() {
    let directory = test_directory("preview-cache");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/preview-cache.mp3");
    let feed_url = parsed.feed.feed_url.clone();
    let feed_id = parsed.feed.id.clone();
    store_preview(&state.db_path, parsed).expect("store preview cache");
    let now = unix_time_millis();

    let cached = get_recent_preview(&state.db_path, &feed_url, now)
      .expect("read preview cache")
      .expect("fresh preview");
    assert_eq!(cached.feed.id, feed_id);
    assert_eq!(cached.episode_count, 1);
    assert_eq!(cached.inserted_count, 0);
    assert_eq!(cached.updated_count, 0);

    open_database(&state.db_path)
      .expect("open preview cache database")
      .execute(
        "UPDATE podcast_feeds SET last_fetched_at = ?2 WHERE id = ?1",
        params![
          feed_id,
          now.saturating_sub(PODCAST_REFRESH_INTERVAL + 1),
        ],
      )
      .expect("age preview cache");
    assert!(
      get_recent_preview(&state.db_path, &feed_url, now)
        .expect("read expired preview cache")
        .is_none()
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn preview_does_not_pollute_library_and_following_controls_home_latest() {
    let directory = test_directory("preview-home");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let episode_id = parsed.episodes[0].id.clone();

    let preview = store_preview(&state.db_path, parsed.clone()).expect("store preview");
    assert!(!preview.feed.subscribed);
    assert!(preview.feed.subscribed_at.is_none());
    assert_eq!(preview.inserted_count, 1);
    assert_eq!(preview.updated_count, 0);
    assert!(preview.feed.latest_episode_at.is_some());
    assert_eq!(preview.feed.unplayed_count, 1);
    let preview_first_seen = get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("preview episode")
      .episode
      .first_seen_at;
    assert!(list_feeds(&state.db_path).expect("list preview feeds").is_empty());
    let preview_home = list_home(&state.db_path, &state.downloads_dir).expect("preview home");
    assert!(preview_home.continue_listening.is_empty());
    assert!(preview_home.latest_episodes.is_empty());
    assert!(preview_home.downloaded_episodes.is_empty());
    assert!(preview_home.saved_episodes.is_empty());

    let followed = store_subscription(&state.db_path, parsed.clone()).expect("follow preview");
    assert!(followed.feed.subscribed);
    assert!(followed.feed.subscribed_at.is_some());
    assert_eq!(followed.feed.unplayed_count, 1);
    assert!(preview_first_seen <= followed.feed.subscribed_at.expect("subscription time"));
    assert_eq!(followed.inserted_count, 0);
    assert_eq!(followed.updated_count, 0);
    let refreshed = store_preview(&state.db_path, parsed).expect("refresh followed preview");
    assert!(refreshed.feed.subscribed);
    assert_eq!(refreshed.updated_count, 0);
    assert_eq!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
        .expect("refreshed episode")
        .episode
        .first_seen_at,
      preview_first_seen,
    );
    assert_eq!(list_feeds(&state.db_path).expect("list followed feeds").len(), 1);
    let followed_home = list_home(&state.db_path, &state.downloads_dir).expect("followed home");
    assert_eq!(followed_home.latest_episodes.len(), 1);
    assert_eq!(
      followed_home.latest_episodes[0].feed_title.as_deref(),
      Some("Zone 测试播客")
    );

    save_progress(&state.db_path, &episode_id, 30.0, 100.0).expect("save unfinished progress");
    let local_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
    fs::write(&local_path, b"ID3-home-download").expect("write managed download");
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &local_path.to_string_lossy(),
      17,
      Some(17),
    )
    .expect("save managed download");
    set_following(&state.db_path, &feed_id, false).expect("unfollow feed");
    let subscribed_at = open_database(&state.db_path)
      .expect("open unfollowed feed")
      .query_row(
        "SELECT subscribed_at FROM podcast_feeds WHERE id = ?1",
        [&feed_id],
        |row| row.get::<_, Option<i64>>(0),
      )
      .expect("read unfollow timestamp");
    assert!(subscribed_at.is_none());

    assert!(list_feeds(&state.db_path).expect("list unfollowed feeds").is_empty());
    let unfollowed_home = list_home(&state.db_path, &state.downloads_dir).expect("unfollowed home");
    assert!(unfollowed_home.latest_episodes.is_empty());
    assert_eq!(unfollowed_home.continue_listening.len(), 1);
    assert_eq!(unfollowed_home.downloaded_episodes.len(), 1);
    assert_eq!(
      unfollowed_home.downloaded_episodes[0].local_path.as_deref(),
      Some(local_path.to_string_lossy().as_ref())
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn list_feeds_with_policy_includes_unsubscribed_previews_for_home_pins() {
    let directory = test_directory("list-feeds-policy");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let preview = parsed_fixture_at(
      "https://media.example.test/preview-episode.mp3",
      "https://feeds.example.test/preview-only.xml",
    );
    store_preview(&state.db_path, preview).expect("store preview");
    store_subscription(
      &state.db_path,
      parsed_fixture("https://media.example.test/episode-1.mp3"),
    )
    .expect("store subscription");

    assert_eq!(list_feeds(&state.db_path).expect("followed only").len(), 1);
    let all = list_feeds_with_policy(&state.db_path, true).expect("all feeds");
    assert_eq!(all.len(), 2);
    assert!(all.iter().any(|feed| !feed.subscribed));
    assert!(all.iter().all(|feed| !feed.title.is_empty()));
    let followed = all.iter().find(|feed| feed.subscribed).expect("followed feed");
    assert_eq!(followed.latest_episode_title.as_deref(), Some("第一集"));

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn home_filters_unplayed_and_download_priority_across_the_full_database() {
    let directory = test_directory("home-database-filters");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(45);
    let feed_id = parsed.feed.id.clone();
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store large subscription");

    {
      let mut connection = open_database(&state.db_path).expect("open progress database");
      let transaction = connection.transaction().expect("begin progress transaction");
      for episode_id in &episode_ids[..40] {
        transaction
          .execute(
            "
            INSERT INTO podcast_progress (
              episode_id, position_seconds, duration_seconds, completed, updated_at
            ) VALUES (?1, 3723, 3723, 1, 1)
            ",
            [episode_id],
          )
          .expect("mark recent episode completed");
      }
      transaction.commit().expect("commit completed episodes");
    }

    for episode_id in &episode_ids[..40] {
      let stale_path = state
        .downloads_dir
        .join(format!("{episode_id}.mp3"));
      mark_download_complete(
        &state.db_path,
        episode_id,
        &stale_path.to_string_lossy(),
        1024,
        Some(1024),
      )
      .expect("mark stale download");
    }

    let priority_episode_id = &episode_ids[44];
    let local_path = state
      .downloads_dir
      .join(format!("{priority_episode_id}.mp3"));
    let audio = b"ID3-priority";
    fs::write(&local_path, audio).expect("write priority download");
    mark_download_complete(
      &state.db_path,
      priority_episode_id,
      &local_path.to_string_lossy(),
      audio.len() as u64,
      Some(audio.len() as u64),
    )
    .expect("mark priority download");

    let preview = parsed_fixture_at(
      "https://media.example.test/preview-episode.mp3",
      "https://feeds.example.test/unfollowed.xml",
    );
    let preview_feed_id = preview.feed.id.clone();
    store_preview(&state.db_path, preview).expect("store unfollowed preview");

    let home = list_home(&state.db_path, &state.downloads_dir).expect("load filtered home");
    assert_eq!(home.latest_episodes.len(), PODCAST_HOME_LATEST_LIMIT);
    assert_eq!(home.latest_episodes[0].id, episode_ids[0]);
    assert_eq!(home.latest_episodes[39].id, episode_ids[39]);
    assert!(
      !home
        .latest_episodes
        .iter()
        .any(|episode| episode.id == priority_episode_id.as_str())
    );
    assert_eq!(
      home
        .unplayed_episodes
        .iter()
        .map(|episode| episode.id.as_str())
        .collect::<Vec<_>>(),
      episode_ids[40..]
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>(),
    );
    assert_eq!(
      home.download_priority_episodes.len(),
      PODCAST_HOME_DOWNLOAD_PRIORITY_LIMIT,
    );
    assert_eq!(
      home.download_priority_episodes[0].id.as_str(),
      priority_episode_id,
    );
    assert_eq!(home.download_priority_episodes[0].download_state, "downloaded");
    assert_eq!(
      home.download_priority_episodes[0].local_path.as_deref(),
      Some(local_path.to_string_lossy().as_ref())
    );
    let connection = open_database(&state.db_path).expect("open cleaned download database");
    let download_count = connection
      .query_row(
        "SELECT COUNT(*) FROM podcast_downloads WHERE state = 'downloaded'",
        [],
        |row| row.get::<_, i64>(0),
      )
      .expect("count valid downloads");
    assert_eq!(download_count, 1);
    drop(connection);
    assert_eq!(home.download_priority_episodes[1].id, episode_ids[0]);
    for episode in home
      .unplayed_episodes
      .iter()
      .chain(home.download_priority_episodes.iter())
    {
      assert_eq!(episode.feed_id, feed_id);
      assert_ne!(episode.feed_id, preview_feed_id);
    }

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn home_recent_lists_fall_back_to_first_seen_when_publish_time_is_missing() {
    let directory = test_directory("home-recent-fallback");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    let connection = open_database(&state.db_path).expect("open ordering database");
    connection
      .execute(
        "
        UPDATE podcast_episodes SET
          published_at = CASE id
            WHEN ?1 THEN 100
            WHEN ?2 THEN NULL
            WHEN ?3 THEN 200
          END,
          first_seen_at = CASE id
            WHEN ?1 THEN 1000
            WHEN ?2 THEN 3000
            WHEN ?3 THEN 2000
          END
        WHERE id IN (?1, ?2, ?3)
        ",
        params![episode_ids[0], episode_ids[1], episode_ids[2]],
      )
      .expect("set deterministic recent timestamps");
    drop(connection);

    let expected = [
      episode_ids[1].as_str(),
      episode_ids[2].as_str(),
      episode_ids[0].as_str(),
    ];
    let home = list_home(&state.db_path, &state.downloads_dir).expect("load ordered home");
    for episodes in [
      &home.latest_episodes,
      &home.unplayed_episodes,
      &home.download_priority_episodes,
    ] {
      assert_eq!(
        episodes
          .iter()
          .map(|episode| episode.id.as_str())
          .collect::<Vec<_>>(),
        expected,
      );
    }

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn library_feed_stats_and_recent_playback_reflect_progress_history() {
    let directory = test_directory("library-feed-stats");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let feed_id = parsed.feed.id.clone();
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let preview = parsed_fixture_at(
      "https://media.example.test/history-episode.mp3",
      "https://feeds.example.test/history.xml",
    );
    let preview_episode_id = preview.episodes[0].id.clone();
    store_preview(&state.db_path, preview).expect("store unfollowed history");

    let mut connection = open_database(&state.db_path).expect("open library database");
    let transaction = connection.transaction().expect("begin library transaction");
    transaction
      .execute(
        "
        UPDATE podcast_episodes SET
          published_at = CASE id
            WHEN ?1 THEN 100
            WHEN ?2 THEN NULL
            WHEN ?3 THEN 200
          END,
          first_seen_at = CASE id
            WHEN ?1 THEN 1000
            WHEN ?2 THEN 3000
            WHEN ?3 THEN 2000
          END
        WHERE id IN (?1, ?2, ?3)
        ",
        params![episode_ids[0], episode_ids[1], episode_ids[2]],
      )
      .expect("set deterministic feed recency");
    for (episode_id, position, completed, updated_at) in [
      (episode_ids[0].as_str(), 120.0, 0, 100),
      (episode_ids[1].as_str(), 3723.0, 1, 200),
      (preview_episode_id.as_str(), 60.0, 0, 300),
    ] {
      transaction
        .execute(
          "
          INSERT INTO podcast_progress (
            episode_id, position_seconds, duration_seconds, completed, updated_at
          ) VALUES (?1, ?2, 3723, ?3, ?4)
          ",
          params![episode_id, position, completed, updated_at],
        )
        .expect("store deterministic playback history");
    }
    transaction.commit().expect("commit library state");
    drop(connection);

    let feeds = list_feeds(&state.db_path).expect("list feed stats");
    assert_eq!(feeds.len(), 1);
    assert_eq!(feeds[0].id, feed_id);
    assert_eq!(feeds[0].latest_episode_at, Some(3000));
    assert_eq!(feeds[0].unplayed_count, 1);

    let home = list_home(&state.db_path, &state.downloads_dir).expect("list playback history");
    assert_eq!(
      home
        .recently_played_episodes
        .iter()
        .map(|episode| episode.id.as_str())
        .collect::<Vec<_>>(),
      vec![
        preview_episode_id.as_str(),
        episode_ids[1].as_str(),
        episode_ids[0].as_str(),
      ],
    );
    assert!(
      !home
        .recently_played_episodes
        .iter()
        .any(|episode| episode.id == episode_ids[2])
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn downloaded_library_is_paginated_beyond_the_bounded_home_summary() {
    let directory = test_directory("downloaded-library-size");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(45);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store large subscription");

    for (index, episode_id) in episode_ids.iter().enumerate() {
      let local_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
      fs::write(&local_path, b"ID3-library").expect("write managed download");
      let downloaded_bytes = u64::try_from(index + 1).expect("download size");
      mark_download_complete(
        &state.db_path,
        episode_id,
        &local_path.to_string_lossy(),
        downloaded_bytes,
        Some(downloaded_bytes),
      )
      .expect("store managed download");
    }

    let first = list_downloads(&state.db_path, &state.downloads_dir, 0, 20)
      .expect("list first download page");
    let second = list_downloads(&state.db_path, &state.downloads_dir, 20, 20)
      .expect("list second download page");
    let third = list_downloads(&state.db_path, &state.downloads_dir, 40, 20)
      .expect("list final download page");
    assert_eq!(first.episodes.len(), 20);
    assert_eq!(second.episodes.len(), 20);
    assert_eq!(third.episodes.len(), 5);
    assert!(first.has_more);
    assert!(second.has_more);
    assert!(!third.has_more);
    for page in [&first, &second, &third] {
      assert_eq!(page.total_count, 45);
      assert_eq!(page.total_bytes, (1_u64..=45).sum::<u64>());
      assert_eq!(page.feed_count, 1);
    }
    let paged_ids = first
      .episodes
      .iter()
      .chain(second.episodes.iter())
      .chain(third.episodes.iter())
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    assert_eq!(paged_ids.len(), 45);
    assert_eq!(
      paged_ids.iter().cloned().collect::<HashSet<_>>(),
      episode_ids.iter().cloned().collect::<HashSet<_>>(),
    );

    let home = list_home(&state.db_path, &state.downloads_dir).expect("list downloaded library");
    assert_eq!(home.downloaded_episodes.len(), PODCAST_HOME_DOWNLOADED_LIMIT);
    assert_eq!(
      home
        .downloaded_episodes
        .iter()
        .map(|episode| episode.id.as_str())
        .collect::<Vec<_>>(),
      paged_ids[..PODCAST_HOME_DOWNLOADED_LIMIT]
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>(),
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn related_episode_list_is_bounded_ordered_and_keeps_episode_state() {
    let directory = test_directory("related-episodes");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(6);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store related episodes");
    save_progress(&state.db_path, &episode_ids[2], 30.0, 100.0)
      .expect("save related progress");
    open_database(&state.db_path)
      .expect("open podcast database")
      .execute(
        "UPDATE podcast_episodes SET enclosure_url = '' WHERE id = ?1",
        [&episode_ids[1]],
      )
      .expect("remove related enclosure");

    let related = list_related_episodes(
      &state.db_path,
      &state.downloads_dir,
      &episode_ids[0],
      3,
    )
    .expect("list related episodes");
    assert_eq!(
      related
        .iter()
        .map(|episode| episode.id.as_str())
        .collect::<Vec<_>>(),
      vec![
        episode_ids[2].as_str(),
        episode_ids[3].as_str(),
        episode_ids[4].as_str(),
      ]
    );
    assert_eq!(related[0].progress_seconds, 30.0);
    assert!(!related.iter().any(|episode| episode.id == episode_ids[0]));
    assert!(!related.iter().any(|episode| episode.id == episode_ids[1]));
    assert!(
      list_related_episodes(
        &state.db_path,
        &state.downloads_dir,
        "missing",
        PODCAST_RELATED_EPISODE_MAX_LIMIT + 1,
      )
      .is_err()
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn episode_lists_hide_unmanaged_or_missing_download_paths() {
    let directory = test_directory("download-path-security");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let outside_path = directory.join(format!("{episode_id}.mp3"));
    fs::write(&outside_path, b"ID3-outside-download").expect("write outside download");
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &outside_path.to_string_lossy(),
      20,
      Some(20),
    )
    .expect("save tampered download path");

    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &feed_id).expect("list episodes");
    assert_eq!(episodes[0].download_state, "none");
    assert!(episodes[0].local_path.is_none());
    assert_eq!(episodes[0].downloaded_bytes, 0);

    let missing_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &missing_path.to_string_lossy(),
      20,
      Some(20),
    )
    .expect("save missing managed path");
    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &feed_id).expect("list missing episode");
    assert_eq!(episodes[0].download_state, "none");
    assert!(episodes[0].local_path.is_none());

    let home = list_home(&state.db_path, &state.downloads_dir).expect("list home");
    assert!(home.downloaded_episodes.is_empty());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn saved_episode_detail_and_home_state_round_trip_across_refresh_and_restart() {
    let directory = test_directory("saved-detail");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed.clone()).expect("store subscription");

    let initial = get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("initial detail");
    assert_eq!(initial.feed.id, feed_id);
    assert_eq!(initial.feed.title, "Zone 测试播客");
    assert_eq!(initial.expected_bytes, Some(23));
    assert!(!initial.saved);
    assert!(!initial.episode.saved);
    assert!(initial.saved_at.is_none());
    assert!(initial.queue_position.is_none());

    set_episode_saved(&state.db_path, &episode_id, true).expect("save episode");
    let first_saved =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("saved detail");
    let saved_at = first_saved.saved_at.expect("saved timestamp");
    assert!(first_saved.saved);
    assert!(first_saved.episode.saved);

    set_episode_saved(&state.db_path, &episode_id, true).expect("save episode idempotently");
    let second_saved =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("resaved detail");
    assert_eq!(second_saved.saved_at, Some(saved_at));
    assert_eq!(
      list_saved_episodes(&state.db_path, &state.downloads_dir)
        .expect("list saved")
        .len(),
      1
    );
    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &feed_id).expect("list feed episodes");
    assert!(episodes[0].saved);
    let home = list_home(&state.db_path, &state.downloads_dir).expect("list home");
    assert_eq!(home.saved_episodes.len(), 1);
    assert!(home.saved_episodes[0].saved);
    assert!(home.latest_episodes[0].saved);

    store_subscription(&state.db_path, parsed).expect("refresh subscription");
    set_following(&state.db_path, &feed_id, false).expect("unfollow feed");
    let reopened = PodcastState::initialize_at(&directory).expect("reopen podcast state");
    let after_restart =
      get_episode_detail(&reopened.db_path, &reopened.downloads_dir, &episode_id).expect("detail after restart");
    assert!(after_restart.saved);
    assert_eq!(after_restart.saved_at, Some(saved_at));

    set_episode_saved(&reopened.db_path, &episode_id, false).expect("unsave episode");
    let unsaved =
      get_episode_detail(&reopened.db_path, &reopened.downloads_dir, &episode_id).expect("unsaved detail");
    assert!(!unsaved.saved);
    assert!(!unsaved.episode.saved);
    assert!(list_saved_episodes(&reopened.db_path, &reopened.downloads_dir)
      .expect("list unsaved")
      .is_empty());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn played_and_unplayed_markers_reuse_progress_without_touching_other_state() {
    let directory = test_directory("played-state");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    set_episode_saved(&state.db_path, &episode_id, true).expect("save episode");
    queue_add(&state.db_path, &episode_id, false).expect("queue episode");
    save_progress(&state.db_path, &episode_id, 30.0, 100.0).expect("save progress");

    set_episode_played(&state.db_path, &episode_id, true).expect("mark played");
    let played =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("played detail");
    assert!(played.episode.completed);
    assert_eq!(played.episode.progress_seconds, 100.0);
    assert!(played.saved);
    assert_eq!(played.queue_position, Some(0));
    assert!(list_home(&state.db_path, &state.downloads_dir)
      .expect("home after played")
      .continue_listening
      .is_empty());
    save_progress(&state.db_path, &episode_id, 45.0, 100.0)
      .expect("ongoing playback must not undo an explicit played marker");
    assert!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
        .expect("played detail after progress")
        .episode
        .completed
    );

    set_episode_played(&state.db_path, &episode_id, false).expect("mark unplayed");
    let unplayed =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("unplayed detail");
    assert!(!unplayed.episode.completed);
    assert_eq!(unplayed.episode.progress_seconds, 0.0);
    assert!(unplayed.saved);
    assert_eq!(unplayed.queue_position, Some(0));
    let progress_exists = open_database(&state.db_path)
      .expect("open database")
      .query_row(
        "SELECT 1 FROM podcast_progress WHERE episode_id = ?1",
        [&episode_id],
        |_| Ok(()),
      )
      .optional()
      .expect("inspect progress")
      .is_some();
    assert!(!progress_exists);
    save_progress(&state.db_path, &episode_id, 45.0, 100.0)
      .expect("progress after marking unplayed");
    assert!(
      !get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id)
        .expect("unplayed detail after progress")
        .episode
        .completed
    );

    set_episode_played(&state.db_path, &episode_id, false)
      .expect("clear progress before using feed duration");
    set_episode_played(&state.db_path, &episode_id, true).expect("mark played from feed duration");
    let played_from_feed =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("played from feed detail");
    assert_eq!(played_from_feed.episode.progress_seconds, 3_723.0);
    assert!(set_episode_played(&state.db_path, &"f".repeat(64), true).is_err());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn bulk_played_markers_preflight_all_episodes_and_update_atomically() {
    let directory = test_directory("bulk-played-state");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    save_progress(&state.db_path, &episode_ids[0], 30.0, 100.0).expect("save first progress");
    save_progress(&state.db_path, &episode_ids[2], 20.0, 100.0).expect("save untouched progress");

    let marked_ids = set_episodes_played(
      &state.db_path,
      &[
        episode_ids[0].clone(),
        episode_ids[0].clone(),
        episode_ids[1].clone(),
      ],
      true,
    )
    .expect("mark selected episodes played");
    assert_eq!(marked_ids, episode_ids[..2]);
    let marked = get_episode_details(
      &state.db_path,
      &state.downloads_dir,
      &marked_ids,
    )
    .expect("read marked episodes");
    assert!(marked.iter().all(|detail| detail.episode.completed));
    assert_eq!(marked[0].episode.progress_seconds, 100.0);
    assert_eq!(marked[1].episode.progress_seconds, 3_723.0);
    let untouched =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_ids[2])
        .expect("read untouched episode");
    assert!(!untouched.episode.completed);
    assert_eq!(untouched.episode.progress_seconds, 20.0);

    let missing_episode_id = "f".repeat(64);
    assert!(
      set_episodes_played(
        &state.db_path,
        &[episode_ids[0].clone(), missing_episode_id],
        false,
      )
      .is_err()
    );
    assert!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_ids[0])
        .expect("read episode after rejected update")
        .episode
        .completed
    );

    set_episodes_played(
      &state.db_path,
      &[episode_ids[0].clone(), episode_ids[1].clone()],
      false,
    )
    .expect("mark selected episodes unplayed");
    let unplayed = get_episode_details(
      &state.db_path,
      &state.downloads_dir,
      &episode_ids[..2],
    )
    .expect("read unplayed episodes");
    assert!(unplayed.iter().all(|detail| {
      !detail.episode.completed && detail.episode.progress_seconds == 0.0
    }));
    let connection = open_database(&state.db_path).expect("open database");
    for episode_id in &episode_ids[..2] {
      let progress_exists = connection
        .query_row(
          "SELECT 1 FROM podcast_progress WHERE episode_id = ?1",
          [episode_id],
          |_| Ok(()),
        )
        .optional()
        .expect("inspect cleared progress")
        .is_some();
      assert!(!progress_exists);
    }
    assert!(set_episodes_played(&state.db_path, &[], true).is_err());
    assert!(
      set_episodes_played(
        &state.db_path,
        &vec![episode_ids[0].clone(); PODCAST_EPISODE_BATCH_LIMIT + 1],
        true,
      )
      .is_err()
    );

    drop(connection);
    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
}
