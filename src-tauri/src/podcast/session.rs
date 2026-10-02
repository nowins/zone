use super::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use crate::db::unix_millis;

const ACTIVE_EPISODE_KEY: &str = "podcast.active_episode.v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastActiveEpisodeSession {
  pub(crate) active_episode_id: Option<String>,
}

pub(crate) fn load_active_episode_session(db_path: &Path) -> Result<Option<PodcastActiveEpisodeSession>, String> {
  let connection = open_database(db_path)?;
  let json: Option<String> = connection.query_row("SELECT value_json FROM app_settings WHERE key = ?1", [ACTIVE_EPISODE_KEY], |row| row.get(0))
    .optional().map_err(|error| format!("无法读取播客当前单集：{error}"))?;
  let Some(json) = json else { return Ok(None) };
  let mut session: PodcastActiveEpisodeSession = serde_json::from_str(&json).map_err(|error| format!("播客当前单集记录无效：{error}"))?;
  if let Some(id) = &session.active_episode_id {
    validate_identifier(id)?;
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM podcast_episodes WHERE id = ?1)", [id], |row| row.get(0))
      .map_err(|error| format!("无法核对播客当前单集：{error}"))?;
    if !exists { session.active_episode_id = None; }
  }
  Ok(Some(session))
}

pub(crate) fn save_active_episode_session(db_path: &Path, episode_id: Option<String>) -> Result<(), String> {
  if let Some(id) = &episode_id { validate_identifier(id)?; }
  let connection = open_database(db_path)?;
  if let Some(id) = &episode_id {
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM podcast_episodes WHERE id = ?1)", [id], |row| row.get(0))
      .map_err(|error| format!("无法核对播客当前单集：{error}"))?;
    if !exists { return Err("播客单集不存在".into()); }
  }
  let json = serde_json::to_string(&PodcastActiveEpisodeSession { active_episode_id: episode_id }).map_err(|error| error.to_string())?;
  connection.execute("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
    params![ACTIVE_EPISODE_KEY, json, unix_millis()]).map_err(|error| format!("无法保存播客当前单集：{error}"))?;
  Ok(())
}

#[tauri::command]
pub async fn podcast_load_active_episode(state: tauri::State<'_, PodcastState>) -> Result<Option<PodcastActiveEpisodeSession>, String> {
  state.ensure_ready()?;
  let path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || load_active_episode_session(&path)).await.map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_save_active_episode(state: tauri::State<'_, PodcastState>, episode_id: Option<String>) -> Result<(), String> {
  state.ensure_ready()?;
  let path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || save_active_episode_session(&path, episode_id)).await.map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;

  #[test]
  fn active_episode_survives_restart_and_clear_without_touching_other_settings() {
    let directory = test_directory("active-session");
    let state = PodcastState::initialize_at(&directory).unwrap();
    let parsed = parsed_fixture("https://example.com/audio.mp3");
    let id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).unwrap();
    assert!(load_active_episode_session(&state.db_path).unwrap().is_none());
    open_database(&state.db_path).unwrap().execute("INSERT INTO app_settings VALUES ('music.fixture', '42', 1)", []).unwrap();
    save_active_episode_session(&state.db_path, Some(id.clone())).unwrap();
    let restarted = PodcastState::initialize_at(&directory).unwrap();
    assert_eq!(load_active_episode_session(&restarted.db_path).unwrap().unwrap().active_episode_id, Some(id));
    save_active_episode_session(&state.db_path, None).unwrap();
    assert!(load_active_episode_session(&state.db_path).unwrap().unwrap().active_episode_id.is_none());
    let music: String = open_database(&state.db_path).unwrap().query_row("SELECT value_json FROM app_settings WHERE key = 'music.fixture'", [], |row| row.get(0)).unwrap();
    assert_eq!(music, "42");
  }

  #[test]
  fn corrupt_active_episode_record_is_preserved_on_read_failure() {
    let directory = test_directory("corrupt-active-session");
    let state = PodcastState::initialize_at(&directory).unwrap();
    open_database(&state.db_path).unwrap().execute("INSERT INTO app_settings VALUES (?1, 'broken', 1)", [ACTIVE_EPISODE_KEY]).unwrap();
    assert!(load_active_episode_session(&state.db_path).is_err());
    assert!(save_active_episode_session(&state.db_path, Some("invalid".into())).is_err());
    let json: String = open_database(&state.db_path).unwrap().query_row("SELECT value_json FROM app_settings WHERE key = ?1", [ACTIVE_EPISODE_KEY], |row| row.get(0)).unwrap();
    assert_eq!(json, "broken");
  }
}
