use super::*;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastBookmark { pub id:String, pub position_seconds:f64, pub label:String }

pub(crate) fn list_bookmarks(path:&Path,episode:&str)->Result<Vec<PodcastBookmark>,String> {
  validate_identifier(episode)?;let db=open_database(path)?;
  let mut statement=db.prepare("SELECT id,position_ms,label FROM podcast_bookmarks WHERE episode_id=?1 ORDER BY position_ms,id").map_err(|e|e.to_string())?;
  let result=statement.query_map([episode],|r|Ok(PodcastBookmark{id:r.get(0)?,position_seconds:r.get::<_,i64>(1)? as f64/1000.0,label:r.get(2)?})).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string());result
}
pub(crate) fn add_bookmark(path:&Path,episode:&str,position:f64,label:&str)->Result<(),String> {
  validate_identifier(episode)?;let label=label.trim();
  if !position.is_finite()||position<0.0||position>7.0*86400.0||label.chars().count()>200||label.chars().any(char::is_control){return Err("书签时间或备注无效".into());}
  let mut db=open_database(path)?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
  let duration:Option<Option<f64>>=tx.query_row("SELECT duration_seconds FROM podcast_episodes WHERE id=?1",[episode],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
  let Some(duration)=duration else{return Err("单集不存在".into());};
  if duration.is_some_and(|duration|duration>0.0&&position>duration){return Err("书签超过单集时长".into());}
  let milliseconds=(position*1000.0).round() as i64;
  let existing:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM podcast_bookmarks WHERE episode_id=?1 AND position_ms=?2)",params![episode,milliseconds],|r|r.get(0)).map_err(|e|e.to_string())?;
  if !existing {let count:i64=tx.query_row("SELECT COUNT(*) FROM podcast_bookmarks WHERE episode_id=?1",[episode],|r|r.get(0)).map_err(|e|e.to_string())?;let total:i64=tx.query_row("SELECT COUNT(*) FROM podcast_bookmarks",[],|r|r.get(0)).map_err(|e|e.to_string())?;if count>=100||total>=10000{return Err("书签数量达到上限".into());}}
  tx.execute("INSERT INTO podcast_bookmarks(id,episode_id,position_ms,label,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(episode_id,position_ms) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at",params![super::lists::new_collection_id("bookmark",episode),episode,milliseconds,label,unix_time_millis()]).map_err(|e|e.to_string())?;
  tx.commit().map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn podcast_list_bookmarks(state:State<'_,PodcastState>,episode_id:String)->Result<Vec<PodcastBookmark>,String>{state.ensure_ready()?;let path=state.db_path.clone();tauri::async_runtime::spawn_blocking(move||list_bookmarks(&path,&episode_id)).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn podcast_add_bookmark(state:State<'_,PodcastState>,episode_id:String,position_seconds:f64,label:String)->Result<Vec<PodcastBookmark>,String>{state.ensure_ready()?;let path=state.db_path.clone();tauri::async_runtime::spawn_blocking(move||{add_bookmark(&path,&episode_id,position_seconds,&label)?;list_bookmarks(&path,&episode_id)}).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn podcast_remove_bookmark(state:State<'_,PodcastState>,episode_id:String,bookmark_id:String)->Result<Vec<PodcastBookmark>,String>{state.ensure_ready()?;validate_identifier(&episode_id)?;validate_identifier(&bookmark_id)?;let path=state.db_path.clone();tauri::async_runtime::spawn_blocking(move||{open_database(&path)?.execute("DELETE FROM podcast_bookmarks WHERE id=?1 AND episode_id=?2",params![bookmark_id,episode_id]).map_err(|e|e.to_string())?;list_bookmarks(&path,&episode_id)}).await.map_err(|e|e.to_string())?}

#[cfg(test)]
mod tests {
  use super::*;use super::super::test_support::*;
  #[test]
  fn bookmarks_persist_deduplicate_and_protect_rss_history() {
    let directory=test_directory("bookmarks");let state=PodcastState::initialize_at(&directory).unwrap();let mut parsed=parsed_fixture("https://example.com/a.mp3");let episode=parsed.episodes[0].id.clone();store_subscription(&state.db_path,parsed.clone()).unwrap();
    add_bookmark(&state.db_path,&episode,30.0,"第一处").unwrap();add_bookmark(&state.db_path,&episode,30.0,"修改备注").unwrap();
    assert_eq!(list_bookmarks(&state.db_path,&episode).unwrap().len(),1);assert_eq!(list_bookmarks(&state.db_path,&episode).unwrap()[0].label,"修改备注");
    assert!(add_bookmark(&state.db_path,&episode,f64::NAN,"").is_err());assert!(add_bookmark(&state.db_path,&episode,99999.0,"").is_err());
    parsed.episodes.clear();store_subscription(&state.db_path,parsed).unwrap();
    let restarted=PodcastState::initialize_at(&directory).unwrap();assert_eq!(list_bookmarks(&restarted.db_path,&episode).unwrap()[0].position_seconds,30.0);
    fs::remove_dir_all(directory).unwrap();
  }
}
