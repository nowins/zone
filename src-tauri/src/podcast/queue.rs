use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use super::*;

#[derive(Clone, Debug)]
pub(crate) struct QueueRecord {
  pub(crate) episode_id: String,
  pub(crate) added_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PodcastQueueAutofillMode {
  SameFeed,
  RandomUnplayed,
}

impl PodcastQueueAutofillMode {
  pub(crate) fn parse(value: &str) -> Result<Self, String> {
    match value {
      "same-feed" => Ok(Self::SameFeed),
      "random-unplayed" => Ok(Self::RandomUnplayed),
      _ => Err("播客智能续播模式无效".to_string()),
    }
  }
}

pub(crate) fn ensure_episode_exists(connection: &Connection, episode_id: &str) -> Result<(), String> {
  let exists = connection
    .query_row(
      "SELECT 1 FROM podcast_episodes WHERE id = ?1",
      [episode_id],
      |_| Ok(()),
    )
    .optional()
    .map_err(|error| format!("无法读取播客单集：{error}"))?
    .is_some();
  if !exists {
    return Err("播客单集不存在".to_string());
  }
  Ok(())
}

fn read_queue_records(connection: &Connection) -> Result<Vec<QueueRecord>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT episode_id, added_at
      FROM podcast_queue
      ORDER BY position, added_at, episode_id
      ",
    )
    .map_err(|error| format!("无法读取播客待播列表：{error}"))?;
  let rows = statement
    .query_map([], |row| {
      Ok(QueueRecord {
        episode_id: row.get(0)?,
        added_at: row.get(1)?,
      })
    })
    .map_err(|error| format!("无法读取播客待播列表：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客待播列表：{error}"))
}

fn rewrite_queue(transaction: &Transaction<'_>, records: &[QueueRecord]) -> Result<(), String> {
  transaction
    .execute("DELETE FROM podcast_queue", [])
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  let mut insert = transaction
    .prepare(
      "
      INSERT INTO podcast_queue (episode_id, position, added_at)
      VALUES (?1, ?2, ?3)
      ",
    )
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  for (position, record) in records.iter().enumerate() {
    insert
      .execute(params![
        record.episode_id,
        i64::try_from(position).unwrap_or(i64::MAX),
        record.added_at,
      ])
      .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  }
  Ok(())
}

pub(crate) fn queue_add(db_path: &Path, episode_id: &str, play_next: bool) -> Result<(), String> {
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  ensure_episode_exists(&transaction, episode_id)?;
  let mut records = read_queue_records(&transaction)?;
  if let Some(index) = records.iter().position(|record| record.episode_id == episode_id) {
    if play_next && index > 0 {
      let record = records.remove(index);
      records.insert(0, record);
      rewrite_queue(&transaction, &records)?;
    }
  } else {
    if records.len() >= PODCAST_QUEUE_LIMIT {
      return Err(format!("播客待播列表最多可加入 {PODCAST_QUEUE_LIMIT} 集"));
    }
    let record = QueueRecord {
      episode_id: episode_id.to_string(),
      added_at: unix_time_millis(),
    };
    if play_next {
      records.insert(0, record);
    } else {
      records.push(record);
    }
    rewrite_queue(&transaction, &records)?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客待播列表：{error}"))
}

pub(crate) fn queue_remove(db_path: &Path, episode_id: &str) -> Result<(), String> {
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  let mut records = read_queue_records(&transaction)?;
  let previous_len = records.len();
  records.retain(|record| record.episode_id != episode_id);
  if records.len() != previous_len {
    rewrite_queue(&transaction, &records)?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客待播列表：{error}"))
}

pub(crate) fn queue_remove_many(db_path: &Path, episode_ids: &[String]) -> Result<Vec<String>, String> {
  let episode_ids = validate_bulk_episode_identifiers(episode_ids)?;
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  let mut records = read_queue_records(&transaction)?;
  let queued_ids = records
    .iter()
    .map(|record| record.episode_id.as_str())
    .collect::<HashSet<_>>();
  if episode_ids
    .iter()
    .any(|episode_id| !queued_ids.contains(episode_id.as_str()))
  {
    return Err("播客待播列表已发生变化，请刷新后重试".to_string());
  }
  let removed_ids = episode_ids
    .iter()
    .map(String::as_str)
    .collect::<HashSet<_>>();
  records.retain(|record| !removed_ids.contains(record.episode_id.as_str()));
  rewrite_queue(&transaction, &records)?;
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客待播列表：{error}"))?;
  Ok(episode_ids)
}

pub(crate) fn validate_queue_identifiers(episode_ids: &[String]) -> Result<(), String> {
  if episode_ids.len() > PODCAST_QUEUE_LIMIT {
    return Err(format!("播客待播列表最多可加入 {PODCAST_QUEUE_LIMIT} 集"));
  }
  let mut unique = HashSet::with_capacity(episode_ids.len());
  for episode_id in episode_ids {
    validate_identifier(episode_id)?;
    if !unique.insert(episode_id.as_str()) {
      return Err("播客待播列表包含重复单集".to_string());
    }
  }
  Ok(())
}

pub(crate) fn queue_reorder(db_path: &Path, episode_ids: &[String]) -> Result<(), String> {
  validate_queue_identifiers(episode_ids)?;
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法重新排列播客待播列表：{error}"))?;
  let current = read_queue_records(&transaction)?;
  let added_at_by_id = current
    .iter()
    .map(|record| (record.episode_id.as_str(), record.added_at))
    .collect::<HashMap<_, _>>();
  if current.len() != episode_ids.len()
    || episode_ids
      .iter()
      .any(|episode_id| !added_at_by_id.contains_key(episode_id.as_str()))
  {
    return Err("播客待播列表已发生变化，请刷新后重试".to_string());
  }
  let reordered = episode_ids
    .iter()
    .map(|episode_id| QueueRecord {
      episode_id: episode_id.clone(),
      added_at: added_at_by_id[episode_id.as_str()],
    })
    .collect::<Vec<_>>();
  rewrite_queue(&transaction, &reordered)?;
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客待播列表：{error}"))
}

pub(crate) fn queue_restore(db_path:&Path, episode_ids:&[String], expected_ids:&[String], expected_active:Option<&str>)->Result<(),String> {
  validate_queue_identifiers(episode_ids)?;validate_queue_identifiers(expected_ids)?;
  if let Some(id)=expected_active{validate_identifier(id)?;}
  let mut db=open_database(db_path)?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
  let current=read_queue_records(&tx)?;let active=load_active_episode_session_in(&tx)?.and_then(|session|session.active_episode_id);
  if current.iter().map(|r|r.episode_id.as_str()).collect::<Vec<_>>() != expected_ids.iter().map(String::as_str).collect::<Vec<_>>() || active.as_deref()!=expected_active {return Err("待播或当前单集已变化，无法撤销".into());}
  let mut records=Vec::new();for id in episode_ids {ensure_episode_exists(&tx,id)?;if active.as_deref()==Some(id.as_str()){return Err("当前单集不能恢复到待播".into());}records.push(QueueRecord{episode_id:id.clone(),added_at:current.iter().find(|r|r.episode_id==*id).map(|r|r.added_at).unwrap_or_else(unix_time_millis)});}
  rewrite_queue(&tx,&records)?;tx.commit().map_err(|e|e.to_string())
}

pub(crate) fn queue_clear(db_path: &Path) -> Result<(), String> {
  let connection = open_database(db_path)?;
  connection
    .execute("DELETE FROM podcast_queue", [])
    .map_err(|error| format!("无法清空播客待播列表：{error}"))?;
  Ok(())
}

pub(crate) fn queue_autofill(
  db_path: &Path,
  current_episode_id: &str,
  mode: PodcastQueueAutofillMode,
) -> Result<Option<String>, String> {
  validate_identifier(current_episode_id)?;
  let feed:String=open_database(db_path)?.query_row("SELECT feed_id FROM podcast_episodes WHERE id=?1",[current_episode_id],|r|r.get(0)).map_err(|e|e.to_string())?;
  let specific=read_preferences(db_path,Some(&feed))?;
  let oldest_first=if specific.inherit_playback {read_preferences(db_path,None)?.oldest_first}else{specific.oldest_first};
  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  ensure_episode_exists(&transaction, current_episode_id)?;
  if !read_queue_records(&transaction)?.is_empty() {
    transaction
      .commit()
      .map_err(|error| format!("无法提交播客待播列表：{error}"))?;
    return Ok(None);
  }

  let candidate = match mode {
    PodcastQueueAutofillMode::SameFeed => transaction
      .query_row(
        "
        WITH current_episode AS (
          SELECT
            id AS episode_id,
            feed_id,
            COALESCE(published_at, first_seen_at) AS episode_time
          FROM podcast_episodes
          WHERE id = ?1
        )
        SELECT e.id
        FROM podcast_episodes e
        JOIN current_episode current ON current.feed_id = e.feed_id
        LEFT JOIN podcast_progress p ON p.episode_id = e.id
        WHERE e.id != ?1
          AND COALESCE(p.completed, 0) = 0
          AND TRIM(e.enclosure_url) != ''
          AND (
            (?2=0 AND COALESCE(e.published_at, e.first_seen_at) < current.episode_time)
            OR (?2=1 AND COALESCE(e.published_at, e.first_seen_at) > current.episode_time)
            OR (
              COALESCE(e.published_at, e.first_seen_at) = current.episode_time
              AND e.id > current.episode_id
            )
          )
        ORDER BY
          CASE WHEN ?2=0 THEN COALESCE(e.published_at, e.first_seen_at) END DESC,
          CASE WHEN ?2=1 THEN COALESCE(e.published_at, e.first_seen_at) END ASC,
          e.id
        LIMIT 1
        ",
        params![current_episode_id,i64::from(oldest_first)],
        |row| row.get::<_, String>(0),
      )
      .optional()
      .map_err(|error| format!("无法选择同节目续播单集：{error}"))?,
    PodcastQueueAutofillMode::RandomUnplayed => transaction
      .query_row(
        "
        SELECT e.id
        FROM podcast_episodes e
        JOIN podcast_feeds f ON f.id = e.feed_id
        LEFT JOIN podcast_progress p ON p.episode_id = e.id
        WHERE f.subscribed = 1
          AND e.id != ?1
          AND COALESCE(p.completed, 0) = 0
          AND COALESCE(p.position_seconds, 0) <= 0
          AND TRIM(e.enclosure_url) != ''
        ORDER BY RANDOM()
        LIMIT 1
        ",
        [current_episode_id],
        |row| row.get::<_, String>(0),
      )
      .optional()
      .map_err(|error| format!("无法选择随机未听单集：{error}"))?,
  };

  if let Some(episode_id) = candidate.as_deref() {
    transaction
      .execute(
        "
        INSERT INTO podcast_queue (episode_id, position, added_at)
        VALUES (?1, 0, ?2)
        ",
        params![episode_id, unix_time_millis()],
      )
      .map_err(|error| format!("无法更新播客待播列表：{error}"))?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交播客待播列表：{error}"))?;
  Ok(candidate)
}

pub(crate) fn list_queue(db_path: &Path, downloads_dir: &Path) -> Result<Vec<PodcastQueueItem>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT
        e.id, e.feed_id, e.title, e.description, e.published_at,
        COALESCE(NULLIF(p.duration_seconds, 0), e.duration_seconds), e.enclosure_url, e.enclosure_type, e.artwork_url,
        COALESCE(d.state, 'none'), d.local_path,
        COALESCE(d.downloaded_bytes, 0), COALESCE(d.total_bytes, e.expected_bytes),
        COALESCE(p.position_seconds, 0), COALESCE(p.completed, 0),
        f.title, f.artwork_url,
        CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,
        e.first_seen_at, e.webpage_url,
        q.position, q.added_at, p.updated_at AS last_listened_at
      FROM podcast_queue q
      JOIN podcast_episodes e ON e.id = q.episode_id
      JOIN podcast_feeds f ON f.id = e.feed_id
      LEFT JOIN podcast_downloads d ON d.episode_id = e.id
      LEFT JOIN podcast_progress p ON p.episode_id = e.id
      LEFT JOIN podcast_saved_episodes s ON s.episode_id = e.id
      ORDER BY q.position, q.added_at, e.id
      ",
    )
    .map_err(|error| format!("无法读取播客待播列表：{error}"))?;
  let rows = statement
    .query_map([], |row| {
      Ok(PodcastQueueItem {
        episode: podcast_episode_from_row(row, downloads_dir)?,
        position: row
          .get::<_, i64>(20)
          .ok()
          .and_then(|value| u32::try_from(value).ok())
          .unwrap_or(0),
        added_at: row.get(21)?,
      })
    })
    .map_err(|error| format!("无法读取播客待播列表：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取播客待播列表：{error}"))
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn customized_show_order_continues_towards_newer_episodes() {
    let dir=test_directory("queue-show-order");let state=PodcastState::initialize_at(&dir).unwrap();let parsed=parsed_fixture_with_episode_count(3);
    let oldest=parsed.episodes[2].id.clone();let next=parsed.episodes[1].id.clone();let feed=parsed.feed.id.clone();store_subscription(&state.db_path,parsed).unwrap();
    write_preferences(&state.db_path,Some(&feed),&PodcastPreferences{inherit_playback:false,oldest_first:true,..Default::default()}).unwrap();
    assert_eq!(queue_autofill(&state.db_path,&oldest,PodcastQueueAutofillMode::SameFeed).unwrap(),Some(next));
  }
  use crate::podcast::test_support::*;

  #[test]
  fn queue_is_ordered_deduplicated_reorder_safe_and_persistent() {
    let directory = test_directory("queue");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    queue_add(&state.db_path, &ids[0], false).expect("append first");
    queue_add(&state.db_path, &ids[1], false).expect("append second");
    queue_add(&state.db_path, &ids[0], false).expect("deduplicate first");
    queue_add(&state.db_path, &ids[2], true).expect("play third next");
    set_episode_saved(&state.db_path, &ids[1], true).expect("save queued episode");
    let initial = list_queue(&state.db_path, &state.downloads_dir).expect("list initial queue");
    assert_eq!(
      initial
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      vec![ids[2].as_str(), ids[0].as_str(), ids[1].as_str()]
    );
    assert_eq!(
      initial.iter().map(|item| item.position).collect::<Vec<_>>(),
      vec![0, 1, 2]
    );
    assert!(initial[2].episode.saved);

    let reordered = vec![ids[1].clone(), ids[2].clone(), ids[0].clone()];
    queue_reorder(&state.db_path, &reordered).expect("reorder queue");
    let after_reorder = list_queue(&state.db_path, &state.downloads_dir).expect("list reordered queue");
    assert_eq!(
      after_reorder
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      reordered.iter().map(String::as_str).collect::<Vec<_>>()
    );

    assert!(queue_reorder(&state.db_path, &reordered[..2]).is_err());
    assert!(validate_queue_identifiers(&[ids[0].clone(), ids[0].clone()]).is_err());
    let unchanged = list_queue(&state.db_path, &state.downloads_dir).expect("list unchanged queue");
    assert_eq!(
      unchanged
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      reordered.iter().map(String::as_str).collect::<Vec<_>>()
    );

    let reopened = PodcastState::initialize_at(&directory).expect("reopen podcast state");
    let persisted = list_queue(&reopened.db_path, &reopened.downloads_dir).expect("list persisted queue");
    assert_eq!(
      persisted
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      reordered.iter().map(String::as_str).collect::<Vec<_>>()
    );

    queue_remove(&reopened.db_path, &ids[2]).expect("remove queued episode");
    let after_remove = list_queue(&reopened.db_path, &reopened.downloads_dir).expect("list after remove");
    assert_eq!(
      after_remove.iter().map(|item| item.position).collect::<Vec<_>>(),
      vec![0, 1]
    );
    queue_clear(&reopened.db_path).expect("clear queue");
    assert!(list_queue(&reopened.db_path, &reopened.downloads_dir)
      .expect("list cleared queue")
      .is_empty());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn queue_autofill_preserves_manual_queue_and_selects_nearest_older_unfinished_episode() {
    let directory = test_directory("queue-autofill-same-feed");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(4);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    set_episode_played(&state.db_path, &episode_ids[1], true).expect("complete nearest older episode");
    save_progress(&state.db_path, &episode_ids[2], 30.0, 100.0).expect("partially play next older episode");

    queue_add(&state.db_path, &episode_ids[3], false).expect("add manual queue item");
    let skipped = queue_autofill(
      &state.db_path,
      &episode_ids[0],
      PodcastQueueAutofillMode::SameFeed,
    )
    .expect("keep manual queue");
    assert!(skipped.is_none());
    let manual_queue = list_queue(&state.db_path, &state.downloads_dir).expect("list manual queue");
    assert_eq!(manual_queue.len(), 1);
    assert_eq!(manual_queue[0].episode.id, episode_ids[3]);

    queue_clear(&state.db_path).expect("clear manual queue");
    let selected = queue_autofill(
      &state.db_path,
      &episode_ids[0],
      PodcastQueueAutofillMode::SameFeed,
    )
    .expect("autofill same feed");
    assert_eq!(selected.as_deref(), Some(episode_ids[2].as_str()));
    let automatic_queue = list_queue(&state.db_path, &state.downloads_dir).expect("list automatic queue");
    assert_eq!(automatic_queue.len(), 1);
    assert_eq!(automatic_queue[0].episode.id, episode_ids[2]);
    assert_eq!(automatic_queue[0].position, 0);

    queue_clear(&state.db_path).expect("clear automatic queue");
    let no_older_episode = queue_autofill(
      &state.db_path,
      &episode_ids[3],
      PodcastQueueAutofillMode::SameFeed,
    )
    .expect("find no older episode");
    assert!(no_older_episode.is_none());
    assert!(list_queue(&state.db_path, &state.downloads_dir)
      .expect("list empty queue")
      .is_empty());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn same_feed_queue_autofill_uses_stable_id_order_for_equal_first_seen_times() {
    let directory = test_directory("queue-autofill-same-time");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let mut parsed = parsed_fixture_with_episode_count(3);
    for episode in &mut parsed.episodes {
      episode.published_at = None;
    }
    let mut episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    episode_ids.sort();
    store_subscription(&state.db_path, parsed).expect("store episodes without publish times");

    let selected = queue_autofill(
      &state.db_path,
      &episode_ids[0],
      PodcastQueueAutofillMode::SameFeed,
    )
    .expect("autofill equal-time episode");
    assert_eq!(selected.as_deref(), Some(episode_ids[1].as_str()));
    let queue = list_queue(&state.db_path, &state.downloads_dir).expect("list equal-time queue");
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].episode.id, episode_ids[1]);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn random_queue_autofill_only_uses_unplayed_episodes_from_followed_feeds() {
    let directory = test_directory("queue-autofill-random");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(5);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store followed feed");
    set_episode_played(&state.db_path, &episode_ids[1], true).expect("complete filtered episode");
    save_progress(&state.db_path, &episode_ids[2], 20.0, 100.0).expect("partially play filtered episode");
    open_database(&state.db_path)
      .expect("open podcast database")
      .execute(
        "UPDATE podcast_episodes SET enclosure_url = '' WHERE id = ?1",
        [&episode_ids[4]],
      )
      .expect("remove invalid enclosure");

    let preview = parsed_fixture_at(
      "https://media.example.test/preview-episode.mp3",
      "https://feeds.example.test/preview-random.xml",
    );
    let preview_episode_id = preview.episodes[0].id.clone();
    store_preview(&state.db_path, preview).expect("store unfollowed preview");

    let selected = queue_autofill(
      &state.db_path,
      &episode_ids[0],
      PodcastQueueAutofillMode::RandomUnplayed,
    )
    .expect("autofill random unplayed");
    assert_eq!(selected.as_deref(), Some(episode_ids[3].as_str()));
    assert_ne!(selected.as_deref(), Some(preview_episode_id.as_str()));

    queue_clear(&state.db_path).expect("clear random queue");
    save_progress(&state.db_path, &episode_ids[3], 1.0, 100.0).expect("partially play last candidate");
    let no_candidate = queue_autofill(
      &state.db_path,
      &episode_ids[0],
      PodcastQueueAutofillMode::RandomUnplayed,
    )
    .expect("find no random candidate");
    assert!(no_candidate.is_none());
    assert!(list_queue(&state.db_path, &state.downloads_dir)
      .expect("list empty random queue")
      .is_empty());

    assert!(PodcastQueueAutofillMode::parse("unsupported").is_err());
    assert!(
      queue_autofill(
        &state.db_path,
        "invalid",
        PodcastQueueAutofillMode::SameFeed,
      )
      .is_err()
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn bulk_queue_remove_is_atomic_and_reindexes_remaining_episodes() {
    let directory = test_directory("bulk-queue-remove");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(4);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    for episode_id in &episode_ids {
      queue_add(&state.db_path, episode_id, false).expect("append episode");
    }

    let removed_ids = queue_remove_many(
      &state.db_path,
      &[
        episode_ids[1].clone(),
        episode_ids[1].clone(),
        episode_ids[3].clone(),
      ],
    )
    .expect("remove selected episodes");
    assert_eq!(
      removed_ids,
      vec![episode_ids[1].clone(), episode_ids[3].clone()]
    );
    let remaining = list_queue(&state.db_path, &state.downloads_dir).expect("list remaining queue");
    assert_eq!(
      remaining
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      vec![episode_ids[0].as_str(), episode_ids[2].as_str()]
    );
    assert_eq!(
      remaining.iter().map(|item| item.position).collect::<Vec<_>>(),
      vec![0, 1]
    );

    assert!(
      queue_remove_many(
        &state.db_path,
        &[episode_ids[0].clone(), episode_ids[1].clone()],
      )
      .is_err()
    );
    assert!(
      queue_remove_many(
        &state.db_path,
        &[episode_ids[0].clone(), "invalid".to_string()],
      )
      .is_err()
    );
    let after_rejected =
      list_queue(&state.db_path, &state.downloads_dir).expect("list unchanged queue");
    assert_eq!(
      after_rejected
        .iter()
        .map(|item| item.episode.id.as_str())
        .collect::<Vec<_>>(),
      vec![episode_ids[0].as_str(), episode_ids[2].as_str()]
    );
    assert!(queue_remove_many(&state.db_path, &[]).is_err());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn queue_undo_restores_order_and_rejects_changed_queue_or_active_session() {
    let dir=test_directory("queue-undo");let state=PodcastState::initialize_at(&dir).unwrap();let parsed=parsed_fixture_with_episode_count(3);let ids=parsed.episodes.iter().map(|e|e.id.clone()).collect::<Vec<_>>();store_subscription(&state.db_path,parsed).unwrap();for id in &ids{queue_add(&state.db_path,id,false).unwrap();}
    queue_remove(&state.db_path,&ids[1]).unwrap();let remaining=vec![ids[0].clone(),ids[2].clone()];queue_restore(&state.db_path,&ids,&remaining,None).unwrap();assert_eq!(list_queue(&state.db_path,&state.downloads_dir).unwrap().iter().map(|q|q.episode.id.clone()).collect::<Vec<_>>(),ids);
    assert!(queue_restore(&state.db_path,&ids,&remaining,None).is_err());queue_clear(&state.db_path).unwrap();save_active_episode_session(&state.db_path,Some(ids[0].clone())).unwrap();assert!(queue_restore(&state.db_path,&ids,&[],None).is_err());assert!(queue_restore(&state.db_path,&ids,&[],Some(&ids[0])).is_err());assert!(list_queue(&state.db_path,&state.downloads_dir).unwrap().is_empty());
  }
  #[test]
  fn queue_total_bytes_falls_back_to_episode_expected_bytes_without_shifting_rows() {
    let directory = test_directory("queue-expected-bytes");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    mark_download_failed_for_source(&state.db_path, &episode_id,
      "https://media.example.test/episode-1.mp3", 0, "test failure")
      .expect("store download row without total bytes");
    queue_add(&state.db_path, &episode_id, false).expect("queue episode");

    let queue = list_queue(&state.db_path, &state.downloads_dir).expect("list queue");
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].episode.id, episode_id);
    assert_eq!(queue[0].episode.download_state, "failed");
    assert_eq!(queue[0].episode.total_bytes, Some(23));
    assert_eq!(queue[0].position, 0);
    assert!(queue[0].added_at > 0);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
}
