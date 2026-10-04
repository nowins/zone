use super::*;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlaylistRules {
  pub filter: String,
  pub sort: String,
  pub feed_ids: Vec<String>,
  pub max_age_days: Option<u32>,
}
impl Default for PlaylistRules {
  fn default() -> Self {
    Self {
      filter: "unplayed".into(),
      sort: "newest".into(),
      feed_ids: vec![],
      max_age_days: None,
    }
  }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastPlaylist {
  pub id: String,
  pub name: String,
  pub kind: String,
  pub rules: PlaylistRules,
  pub updated_at: i64,
}
pub(crate) fn validate_rules(rules: &PlaylistRules) -> Result<(), String> {
  if !matches!(
    rules.filter.as_str(),
    "all" | "unplayed" | "played" | "saved" | "downloaded"
  ) || !matches!(rules.sort.as_str(), "newest" | "oldest" | "title")
    || rules
      .max_age_days
      .is_some_and(|days| days == 0 || days > 3650)
    || rules.feed_ids.len() > 500
  {
    return Err("智能列表条件无效".into());
  }
  let mut unique = HashSet::new();
  for id in &rules.feed_ids {
    validate_identifier(id)?;
    if !unique.insert(id) {
      return Err("节目条件重复".into());
    }
  }
  Ok(())
}
pub(crate) fn collection_name(name: &str) -> Result<String, String> {
  let name = name.trim();
  if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
    return Err("名称须为 1 至 80 个字符".into());
  }
  Ok(name.into())
}
pub(crate) fn new_collection_id(namespace: &str, name: &str) -> String {
  let nonce = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_nanos()
    .to_string();
  hash_identifier(namespace, &[name, &nonce, &std::process::id().to_string()])
}
fn playlist(db: &Connection, id: &str) -> Result<PodcastPlaylist, String> {
  validate_identifier(id)?;
  let result = db
    .query_row(
      "SELECT id,name,kind,rules_json,updated_at FROM podcast_playlists WHERE id=?1",
      [id],
      |r| {
        Ok((
          r.get::<_, String>(0)?,
          r.get::<_, String>(1)?,
          r.get::<_, String>(2)?,
          r.get::<_, String>(3)?,
          r.get::<_, i64>(4)?,
        ))
      },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or("播放列表不存在")?;
  let rules: PlaylistRules =
    serde_json::from_str(&result.3).map_err(|_| "播放列表条件损坏，已保留原始数据")?;
  validate_rules(&rules)?;
  Ok(PodcastPlaylist {
    id: result.0,
    name: result.1,
    kind: result.2,
    rules,
    updated_at: result.4,
  })
}
pub(crate) fn save_playlist(
  path: &Path,
  id: Option<&str>,
  name: &str,
  kind: &str,
  rules: PlaylistRules,
  expected: Option<i64>,
) -> Result<PodcastPlaylist, String> {
  let name = collection_name(name)?;
  validate_rules(&rules)?;
  if !matches!(kind, "manual" | "smart") {
    return Err("播放列表类型无效".into());
  }
  let mut db = open_database(path)?;
  let tx = db
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|e| e.to_string())?;
  let time = unix_time_millis();
  let identifier = if let Some(id) = id {
    let old = playlist(&tx, id)?;
    if old.kind != kind {
      return Err("不能改变已有播放列表的类型".into());
    }
    if expected != Some(old.updated_at) {
      return Err("列表已变化，请重新打开编辑".into());
    }
    tx.execute(
      "UPDATE podcast_playlists SET name=?2,rules_json=?3,updated_at=?4 WHERE id=?1",
      params![
        id,
        name,
        serde_json::to_string(&rules).map_err(|e| e.to_string())?,
        time.max(old.updated_at + 1)
      ],
    )
    .map_err(|e| e.to_string())?;
    id.into()
  } else {
    let count: i64 = tx
      .query_row("SELECT COUNT(*) FROM podcast_playlists", [], |r| r.get(0))
      .map_err(|e| e.to_string())?;
    if count >= 100 {
      return Err("最多创建 100 个播放列表".into());
    }
    let id = new_collection_id("podcast-playlist", &name);
    tx.execute("INSERT INTO podcast_playlists(id,name,kind,rules_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",params![id,name,kind,serde_json::to_string(&rules).map_err(|e|e.to_string())?,time]).map_err(|e|e.to_string())?;
    id
  };
  tx.commit().map_err(|e| e.to_string())?;
  playlist(&db, &identifier)
}
fn list_source(list: &PodcastPlaylist) -> Result<(String, String, String, Option<i64>), String> {
  if list.kind == "manual" {
    return Ok((
      "JOIN podcast_playlist_items li ON li.episode_id=e.id WHERE li.playlist_id=?1".into(),
      "li.position,li.added_at,e.id".into(),
      list.id.clone(),
      None,
    ));
  }
  validate_rules(&list.rules)?;
  let filter = match list.rules.filter.as_str() {
    "unplayed" => "COALESCE(p.completed,0)=0",
    "played" => "p.completed=1",
    "saved" => "s.episode_id IS NOT NULL",
    "downloaded" => "d.state='downloaded'",
    _ => "1=1",
  };
  let order = match list.rules.sort.as_str() {
    "oldest" => "e.published_at IS NULL,e.published_at,e.id",
    "title" => "e.title COLLATE NOCASE,e.id",
    _ => "e.published_at IS NULL,e.published_at DESC,e.id",
  };
  Ok((format!("WHERE {filter} AND (json_array_length(?1)=0 OR e.feed_id IN (SELECT value FROM json_each(?1))) AND (?2 IS NULL OR e.published_at>=?2)"),order.into(),serde_json::to_string(&list.rules.feed_ids).map_err(|e|e.to_string())?,list.rules.max_age_days.map(|days|unix_time_millis()-i64::from(days)*86_400_000)))
}
fn page_in(
  db: &Connection,
  downloads: &Path,
  list: &PodcastPlaylist,
  offset: usize,
  limit: usize,
) -> Result<PodcastEpisodeSearchPage, String> {
  let (source, order, key, age) = list_source(list)?;
  // Bind ?2 even for manual lists so count and page queries share the same parameters.
  let from=format!("FROM podcast_episodes e JOIN podcast_feeds f ON f.id=e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id=e.id LEFT JOIN podcast_progress p ON p.episode_id=e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id=e.id {source} AND (?2 IS NULL OR 1=1)");
  let total = db
    .query_row(&format!("SELECT COUNT(*) {from}"), params![key, age], |r| {
      r.get::<_, i64>(0)
    })
    .map_err(|e| e.to_string())?
    .max(0) as usize;
  let mut statement=db.prepare(&format!("SELECT e.id,e.feed_id,e.title,e.description,e.published_at,COALESCE(NULLIF(p.duration_seconds,0),e.duration_seconds),e.enclosure_url,e.enclosure_type,e.artwork_url,
    COALESCE(d.state,'none'),d.local_path,COALESCE(d.downloaded_bytes,0),d.total_bytes,COALESCE(p.position_seconds,0),COALESCE(p.completed,0),f.title,f.artwork_url,CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,e.first_seen_at,e.webpage_url,p.updated_at AS last_listened_at
    {from} ORDER BY {order} LIMIT ?3 OFFSET ?4")).map_err(|e|e.to_string())?;
  let episodes = statement
    .query_map(params![key, age, limit as i64, offset as i64], |r| {
      query::podcast_episode_from_row(r, downloads)
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(PodcastEpisodeSearchPage {
    matches: Vec::new(),
    has_more: offset.saturating_add(episodes.len()) < total,
    episodes,
    total,
  })
}
pub(crate) fn playlist_page(
  path: &Path,
  downloads: &Path,
  id: &str,
  offset: usize,
  limit: usize,
) -> Result<PodcastEpisodeSearchPage, String> {
  let db = open_database(path)?;
  page_in(
    &db,
    downloads,
    &playlist(&db, id)?,
    offset.min(200_000),
    limit.clamp(1, 100),
  )
}
pub(crate) fn preview_playlist(path: &Path, downloads: &Path, rules: PlaylistRules) -> Result<PodcastEpisodeSearchPage, String> {
  validate_rules(&rules)?;
  let db = open_database(path)?;
  page_in(&db, downloads, &PodcastPlaylist { id: String::new(), name: String::new(), kind: "smart".into(), rules, updated_at: 0 }, 0, 3)
}

#[tauri::command]
pub fn podcast_preview_playlist(state: State<'_, PodcastState>, rules: PlaylistRules) -> Result<PodcastEpisodeSearchPage, String> {
  state.ensure_ready()?;
  preview_playlist(&state.db_path, &state.downloads_dir, rules)
}
pub(crate) fn update_playlist_item(
  path: &Path,
  id: &str,
  episode: &str,
  add: bool,
) -> Result<(), String> {
  validate_identifier(episode)?;
  let mut db = open_database(path)?;
  let tx = db
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|e| e.to_string())?;
  if playlist(&tx, id)?.kind != "manual" {
    return Err("智能列表根据条件自动更新".into());
  }
  ensure_episode_exists(&tx, episode)?;
  if add {
    let count: i64 = tx
      .query_row(
        "SELECT COUNT(*) FROM podcast_playlist_items WHERE playlist_id=?1",
        [id],
        |r| r.get(0),
      )
      .map_err(|e| e.to_string())?;
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM podcast_playlist_items WHERE playlist_id=?1 AND episode_id=?2)",params![id,episode],|r|r.get(0)).map_err(|e|e.to_string())?;
    if count >= 500 && !exists {
      return Err("一个手动列表最多加入 500 集".into());
    }
    tx.execute("INSERT OR IGNORE INTO podcast_playlist_items(playlist_id,episode_id,position,added_at) SELECT ?1,?2,COALESCE(MAX(position),-1)+1,?3 FROM podcast_playlist_items WHERE playlist_id=?1",params![id,episode,unix_time_millis()]).map_err(|e|e.to_string())?;
  } else {
    tx.execute(
      "DELETE FROM podcast_playlist_items WHERE playlist_id=?1 AND episode_id=?2",
      params![id, episode],
    )
    .map_err(|e| e.to_string())?;
  }
  tx.execute(
    "UPDATE podcast_playlists SET updated_at=MAX(updated_at+1,?2) WHERE id=?1",
    params![id, unix_time_millis()],
  )
  .map_err(|e| e.to_string())?;
  tx.commit().map_err(|e| e.to_string())
}
pub(crate) fn reorder_playlist(path: &Path, id: &str, episodes: &[String]) -> Result<(), String> {
  validate_queue_identifiers(episodes)?;
  let mut db = open_database(path)?;
  let tx = db
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|e| e.to_string())?;
  if playlist(&tx, id)?.kind != "manual" {
    return Err("智能列表按条件排序".into());
  }
  let current: HashSet<String> = {
    let mut stmt = tx
      .prepare("SELECT episode_id FROM podcast_playlist_items WHERE playlist_id=?1")
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([id], |r| r.get(0))
      .map_err(|e| e.to_string())?
      .collect::<Result<_, _>>()
      .map_err(|e| e.to_string())?;
    rows
  };
  if current != episodes.iter().cloned().collect() {
    return Err("列表已变化，请刷新后重试".into());
  }
  for (position, episode) in episodes.iter().enumerate() {
    tx.execute(
      "UPDATE podcast_playlist_items SET position=?3 WHERE playlist_id=?1 AND episode_id=?2",
      params![id, episode, position as i64],
    )
    .map_err(|e| e.to_string())?;
  }
  tx.execute(
    "UPDATE podcast_playlists SET updated_at=MAX(updated_at+1,?2) WHERE id=?1",
    params![id, unix_time_millis()],
  )
  .map_err(|e| e.to_string())?;
  tx.commit().map_err(|e| e.to_string())
}
#[cfg(test)]
pub(crate) fn activate_playlist(
  path: &Path,
  downloads: &Path,
  id: &str,
) -> Result<Vec<PodcastQueueItem>, String> {
  activate_playlist_mode(path, downloads, id, true)
}
pub(crate) fn activate_playlist_mode(path: &Path, downloads: &Path, id: &str, start_playback: bool) -> Result<Vec<PodcastQueueItem>, String> {
  let mut db = open_database(path)?;
  let tx = db
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|e| e.to_string())?;
  let page = page_in(&tx, downloads, &playlist(&tx, id)?, 0, 500)?;
  if page.total == 0 {
    return Err("列表中没有可播放的单集".into());
  }
  if page.total > 500 {
    return Err("列表超过 500 集，请缩小智能条件后播放".into());
  }
  tx.execute("DELETE FROM podcast_queue", [])
    .map_err(|e| e.to_string())?;
  let active = if start_playback { None } else { load_active_episode_session_in(&tx)?.and_then(|session| session.active_episode_id) };
  for (position, episode) in page.episodes.iter().filter(|episode| active.as_deref() != Some(episode.id.as_str())).enumerate() {
    tx.execute(
      "INSERT INTO podcast_queue(episode_id,position,added_at) VALUES(?1,?2,?3)",
      params![episode.id, position as i64, unix_time_millis()],
    )
    .map_err(|e| e.to_string())?;
  }
  tx.commit().map_err(|e| e.to_string())?;
  list_queue(path, downloads)
}

#[tauri::command]
pub fn podcast_list_playlists(
  state: State<'_, PodcastState>,
) -> Result<Vec<PodcastPlaylist>, String> {
  state.ensure_ready()?;
  let db = open_database(&state.db_path)?;
  let mut stmt = db
    .prepare("SELECT id FROM podcast_playlists ORDER BY name COLLATE NOCASE,id")
    .map_err(|e| e.to_string())?;
  let ids = stmt
    .query_map([], |r| r.get::<_, String>(0))
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  ids.iter().map(|id| playlist(&db, id)).collect()
}
#[tauri::command]
pub fn podcast_save_playlist(
  state: State<'_, PodcastState>,
  id: Option<String>,
  name: String,
  kind: String,
  rules: PlaylistRules,
  expected_updated_at: Option<i64>,
) -> Result<PodcastPlaylist, String> {
  state.ensure_ready()?;
  save_playlist(
    &state.db_path,
    id.as_deref(),
    &name,
    &kind,
    rules,
    expected_updated_at,
  )
}
#[tauri::command]
pub fn podcast_delete_playlist(state: State<'_, PodcastState>, id: String) -> Result<(), String> {
  state.ensure_ready()?;
  validate_identifier(&id)?;
  open_database(&state.db_path)?
    .execute("DELETE FROM podcast_playlists WHERE id=?1", [id])
    .map_err(|e| e.to_string())?;
  Ok(())
}
#[tauri::command]
pub fn podcast_playlist_page(
  state: State<'_, PodcastState>,
  id: String,
  offset: usize,
  limit: usize,
) -> Result<PodcastEpisodeSearchPage, String> {
  state.ensure_ready()?;
  playlist_page(&state.db_path, &state.downloads_dir, &id, offset, limit)
}
#[tauri::command]
pub fn podcast_update_playlist_item(
  state: State<'_, PodcastState>,
  id: String,
  episode_id: String,
  add: bool,
) -> Result<(), String> {
  state.ensure_ready()?;
  update_playlist_item(&state.db_path, &id, &episode_id, add)
}
#[tauri::command]
pub fn podcast_reorder_playlist(
  state: State<'_, PodcastState>,
  id: String,
  episode_ids: Vec<String>,
) -> Result<(), String> {
  state.ensure_ready()?;
  reorder_playlist(&state.db_path, &id, &episode_ids)
}
#[tauri::command]
pub fn podcast_activate_playlist(
  state: State<'_, PodcastState>,
  id: String,
  start_playback: Option<bool>,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  activate_playlist_mode(&state.db_path, &state.downloads_dir, &id, start_playback.unwrap_or(true))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  #[test]
  fn replace_only_excludes_current_episode_and_restores_the_previous_queue() {
    let dir = test_directory("replace-list");
    let state = PodcastState::initialize_at(&dir).unwrap();
    let parsed = parsed_fixture_with_episode_count(2);
    let ids = parsed.episodes.iter().map(|episode| episode.id.clone()).collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).unwrap();
    save_active_episode_session(&state.db_path, Some(ids[0].clone())).unwrap();
    queue_add(&state.db_path, &ids[1], false).unwrap();
    let list = save_playlist(&state.db_path, None, "当前", "manual", PlaylistRules::default(), None).unwrap();
    update_playlist_item(&state.db_path, &list.id, &ids[0], true).unwrap();
    let after = activate_playlist_mode(&state.db_path, &state.downloads_dir, &list.id, false).unwrap();
    assert!(after.is_empty());
    queue_restore(&state.db_path, &[ids[1].clone()], &[], Some(&ids[0])).unwrap();
    assert_eq!(list_queue(&state.db_path, &state.downloads_dir).unwrap()[0].episode.id, ids[1]);
  }
  #[test]
  fn unsaved_preview_counts_full_archive_without_mutating_lists_or_queue() {
    let dir = test_directory("preview-list");
    let state = PodcastState::initialize_at(&dir).unwrap();
    let parsed = parsed_fixture_with_episode_count(501);
    let first = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).unwrap();
    queue_add(&state.db_path, &first, false).unwrap();
    let page = preview_playlist(&state.db_path, &state.downloads_dir, PlaylistRules::default()).unwrap();
    assert_eq!(page.total, 501);
    assert_eq!(page.episodes.len(), 3);
    assert!(page.has_more);
    assert_eq!(list_queue(&state.db_path, &state.downloads_dir).unwrap().len(), 1);
    let db = open_database(&state.db_path).unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM podcast_playlists", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    let invalid = PlaylistRules { max_age_days: Some(0), ..Default::default() };
    assert!(preview_playlist(&state.db_path, &state.downloads_dir, invalid).is_err());
  }
  #[test]
  fn manual_lists_are_persistent_ordered_deduplicated_and_independent_of_queue() {
    let dir = test_directory("manual-lists");
    let state = PodcastState::initialize_at(&dir).unwrap();
    let parsed = parsed_fixture_with_episode_count(3);
    let ids = parsed
      .episodes
      .iter()
      .map(|e| e.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed.clone()).unwrap();
    let list = save_playlist(
      &state.db_path,
      None,
      "  通勤  ",
      "manual",
      PlaylistRules::default(),
      None,
    )
    .unwrap();
    assert_eq!(list.name, "通勤");
    for id in [&ids[0], &ids[1], &ids[0]] {
      update_playlist_item(&state.db_path, &list.id, id, true).unwrap();
    }
    assert!(list_queue(&state.db_path, &state.downloads_dir)
      .unwrap()
      .is_empty());
    assert_eq!(
      playlist_page(&state.db_path, &state.downloads_dir, &list.id, 0, 50)
        .unwrap()
        .total,
      2
    );
    assert!(reorder_playlist(&state.db_path, &list.id, &ids).is_err());
    reorder_playlist(&state.db_path, &list.id, &[ids[1].clone(), ids[0].clone()]).unwrap();
    let queue = activate_playlist(&state.db_path, &state.downloads_dir, &list.id).unwrap();
    assert_eq!(queue[0].episode.id, ids[1]);
    queue_clear(&state.db_path).unwrap();
    let mut refreshed = parsed;
    refreshed.episodes.retain(|episode| episode.id == ids[2]);
    store_subscription(&state.db_path, refreshed).unwrap();
    assert_eq!(
      playlist_page(&state.db_path, &state.downloads_dir, &list.id, 0, 50)
        .unwrap()
        .total,
      2
    );
    assert!(save_playlist(
      &state.db_path,
      Some(&list.id),
      "改名",
      "manual",
      PlaylistRules::default(),
      Some(list.updated_at)
    )
    .is_err());
  }
  #[test]
  fn smart_lists_query_full_archive_and_reject_oversized_activation_without_mutation() {
    let dir = test_directory("smart-lists");
    let state = PodcastState::initialize_at(&dir).unwrap();
    let parsed = parsed_fixture_with_episode_count(501);
    let feed = parsed.feed.id.clone();
    let first = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).unwrap();
    let mut rules = PlaylistRules {
      feed_ids: vec![feed],
      sort: "oldest".into(),
      ..Default::default()
    };
    let list = save_playlist(&state.db_path, None, "未听", "smart", rules.clone(), None).unwrap();
    assert_eq!(
      playlist_page(&state.db_path, &state.downloads_dir, &list.id, 200, 50)
        .unwrap()
        .total,
      501
    );
    queue_add(&state.db_path, &first, false).unwrap();
    assert!(activate_playlist(&state.db_path, &state.downloads_dir, &list.id).is_err());
    assert_eq!(
      list_queue(&state.db_path, &state.downloads_dir)
        .unwrap()
        .len(),
      1
    );
    set_episode_played(&state.db_path, &first, true).unwrap();
    assert_eq!(
      activate_playlist(&state.db_path, &state.downloads_dir, &list.id)
        .unwrap()
        .len(),
      500
    );
    rules.filter = "saved".into();
    set_episode_saved(&state.db_path, &first, true).unwrap();
    let list = save_playlist(
      &state.db_path,
      Some(&list.id),
      "收藏",
      "smart",
      rules,
      Some(list.updated_at),
    )
    .unwrap();
    assert_eq!(
      playlist_page(&state.db_path, &state.downloads_dir, &list.id, 0, 50)
        .unwrap()
        .total,
      1
    );
    assert!(update_playlist_item(&state.db_path, &list.id, &first, true).is_err());
  }
}
