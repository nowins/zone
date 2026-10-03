use super::lists::{collection_name, new_collection_id};
use super::*;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastShowGroup {
  pub id: String,
  pub name: String,
  pub feed_ids: Vec<String>,
  pub updated_at: i64,
}

pub(crate) fn show_groups(path: &Path) -> Result<Vec<PodcastShowGroup>, String> {
  let db = open_database(path)?;
  let mut statement = db
    .prepare("SELECT id,name,updated_at FROM podcast_show_groups ORDER BY name COLLATE NOCASE,id")
    .map_err(|e| e.to_string())?;
  let mut groups = statement
    .query_map([], |row| {
      Ok(PodcastShowGroup {
        id: row.get(0)?,
        name: row.get(1)?,
        updated_at: row.get(2)?,
        feed_ids: vec![],
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  for group in &mut groups {
    let mut statement = db
      .prepare("SELECT feed_id FROM podcast_show_group_members WHERE group_id=?1 ORDER BY feed_id")
      .map_err(|e| e.to_string())?;
    group.feed_ids = statement
      .query_map([&group.id], |r| r.get(0))
      .map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>()
      .map_err(|e| e.to_string())?;
  }
  Ok(groups)
}
pub(crate) fn save_show_group(
  path: &Path,
  id: Option<&str>,
  name: &str,
  feeds: &[String],
  expected: Option<i64>,
) -> Result<PodcastShowGroup, String> {
  let name = collection_name(name)?;
  if feeds.len() > 500 {
    return Err("分组最多选择 500 个节目".into());
  }
  let mut unique = HashSet::new();
  for feed in feeds {
    validate_identifier(feed)?;
    if !unique.insert(feed) {
      return Err("分组节目重复".into());
    }
  }
  let mut db = open_database(path)?;
  let tx = db
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|e| e.to_string())?;
  for feed in feeds {
    let exists: bool = tx
      .query_row(
        "SELECT EXISTS(SELECT 1 FROM podcast_feeds WHERE id=?1)",
        [feed],
        |r| r.get(0),
      )
      .map_err(|e| e.to_string())?;
    if !exists {
      return Err("节目不存在，请刷新分组".into());
    }
  }
  let time = unix_time_millis();
  let (identifier, updated) = if let Some(id) = id {
    validate_identifier(id)?;
    let old: i64 = tx
      .query_row(
        "SELECT updated_at FROM podcast_show_groups WHERE id=?1",
        [id],
        |r| r.get(0),
      )
      .optional()
      .map_err(|e| e.to_string())?
      .ok_or("节目分组不存在")?;
    if expected != Some(old) {
      return Err("分组已变化，请重新编辑".into());
    }
    let updated = time.max(old + 1);
    tx.execute(
      "UPDATE podcast_show_groups SET name=?2,updated_at=?3 WHERE id=?1",
      params![id, name, updated],
    )
    .map_err(|e| e.to_string())?;
    (id.to_string(), updated)
  } else {
    let count: i64 = tx
      .query_row("SELECT COUNT(*) FROM podcast_show_groups", [], |r| r.get(0))
      .map_err(|e| e.to_string())?;
    if count >= 100 {
      return Err("最多创建 100 个节目分组".into());
    }
    let id = new_collection_id("podcast-show-group", &name);
    tx.execute(
      "INSERT INTO podcast_show_groups(id,name,created_at,updated_at) VALUES(?1,?2,?3,?3)",
      params![id, name, time],
    )
    .map_err(|e| e.to_string())?;
    (id, time)
  };
  tx.execute(
    "DELETE FROM podcast_show_group_members WHERE group_id=?1",
    [&identifier],
  )
  .map_err(|e| e.to_string())?;
  for feed in feeds {
    tx.execute(
      "INSERT INTO podcast_show_group_members(group_id,feed_id) VALUES(?1,?2)",
      params![identifier, feed],
    )
    .map_err(|e| e.to_string())?;
  }
  tx.commit().map_err(|e| e.to_string())?;
  Ok(PodcastShowGroup {
    id: identifier,
    name,
    feed_ids: feeds.to_vec(),
    updated_at: updated,
  })
}
#[tauri::command]
pub fn podcast_list_show_groups(
  state: State<'_, PodcastState>,
) -> Result<Vec<PodcastShowGroup>, String> {
  state.ensure_ready()?;
  show_groups(&state.db_path)
}
#[tauri::command]
pub fn podcast_save_show_group(
  state: State<'_, PodcastState>,
  id: Option<String>,
  name: String,
  feed_ids: Vec<String>,
  expected_updated_at: Option<i64>,
) -> Result<PodcastShowGroup, String> {
  state.ensure_ready()?;
  save_show_group(
    &state.db_path,
    id.as_deref(),
    &name,
    &feed_ids,
    expected_updated_at,
  )
}
#[tauri::command]
pub fn podcast_delete_show_group(state: State<'_, PodcastState>, id: String) -> Result<(), String> {
  state.ensure_ready()?;
  validate_identifier(&id)?;
  open_database(&state.db_path)?
    .execute("DELETE FROM podcast_show_groups WHERE id=?1", [id])
    .map_err(|e| e.to_string())?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  #[test]
  fn groups_support_multiple_memberships_conflicts_and_delete_without_unfollowing() {
    let dir = test_directory("show-groups");
    let state = PodcastState::initialize_at(&dir).unwrap();
    let parsed = parsed_fixture_with_episode_count(1);
    let feed = parsed.feed.id.clone();
    store_subscription(&state.db_path, parsed).unwrap();
    let first = save_show_group(&state.db_path, None, "中文", &[feed.clone()], None).unwrap();
    let second = save_show_group(&state.db_path, None, "通勤", &[feed.clone()], None).unwrap();
    assert_eq!(show_groups(&state.db_path).unwrap().len(), 2);
    let changed = save_show_group(
      &state.db_path,
      Some(&first.id),
      "中文访谈",
      &[],
      Some(first.updated_at),
    )
    .unwrap();
    assert!(save_show_group(
      &state.db_path,
      Some(&first.id),
      "旧编辑",
      &[feed.clone()],
      Some(first.updated_at)
    )
    .is_err());
    assert!(save_show_group(&state.db_path, None, "坏数据", &["0".repeat(64)], None).is_err());
    assert_eq!(show_groups(&state.db_path).unwrap().len(), 2);
    open_database(&state.db_path)
      .unwrap()
      .execute("DELETE FROM podcast_show_groups WHERE id=?1", [second.id])
      .unwrap();
    assert_eq!(show_groups(&state.db_path).unwrap()[0].name, changed.name);
    let followed: i64 = open_database(&state.db_path)
      .unwrap()
      .query_row(
        "SELECT subscribed FROM podcast_feeds WHERE id=?1",
        [feed],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(followed, 1);
  }
}
