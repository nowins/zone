use super::*;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastBookmark { pub id:String, pub position_seconds:f64, pub label:String }

pub(crate) fn list_bookmarks(path:&Path,episode:&str)->Result<Vec<PodcastBookmark>,String> {
  validate_identifier(episode)?;let db=open_database(path)?;
  let mut statement=db.prepare("SELECT id,position_ms,label FROM podcast_bookmarks WHERE episode_id=?1 ORDER BY position_ms,id").map_err(|e|e.to_string())?;
  let result=statement.query_map([episode],|r|Ok(PodcastBookmark{id:r.get(0)?,position_seconds:r.get::<_,i64>(1)? as f64/1000.0,label:r.get(2)?})).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string());result
}
#[cfg(test)]
pub(crate) fn add_bookmark(path:&Path,episode:&str,position:f64,label:&str)->Result<(),String> {
  write_bookmark(path, episode, position, label, None, false)
}
fn write_bookmark(path:&Path,episode:&str,position:f64,label:&str,restore_id:Option<&str>,preserve_existing:bool)->Result<(),String> {
  validate_identifier(episode)?;let label=label.trim();
  if let Some(id)=restore_id { validate_identifier(id)?; }
  if !position.is_finite()||position<0.0||position>7.0*86400.0||label.chars().count()>200||label.chars().any(char::is_control){return Err("书签时间或备注无效".into());}
  let mut db=open_database(path)?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
  let duration:Option<Option<f64>>=tx.query_row("SELECT duration_seconds FROM podcast_episodes WHERE id=?1",[episode],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
  let Some(duration)=duration else{return Err("单集不存在".into());};
  if duration.is_some_and(|duration|duration>0.0&&position>duration){return Err("书签超过单集时长".into());}
  let milliseconds=(position*1000.0).round() as i64;
  let existing:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM podcast_bookmarks WHERE episode_id=?1 AND position_ms=?2)",params![episode,milliseconds],|r|r.get(0)).map_err(|e|e.to_string())?;
  if restore_id.is_some() && existing { return Err("该时间已有书签，无法撤销删除".into()); }
  if preserve_existing && existing { return Ok(()); }
  if !existing {let count:i64=tx.query_row("SELECT COUNT(*) FROM podcast_bookmarks WHERE episode_id=?1",[episode],|r|r.get(0)).map_err(|e|e.to_string())?;let total:i64=tx.query_row("SELECT COUNT(*) FROM podcast_bookmarks",[],|r|r.get(0)).map_err(|e|e.to_string())?;if count>=100||total>=10000{return Err("书签数量达到上限".into());}}
  let id=restore_id.map(str::to_owned).unwrap_or_else(||super::lists::new_collection_id("bookmark",episode));
  tx.execute("INSERT INTO podcast_bookmarks(id,episode_id,position_ms,label,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(episode_id,position_ms) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at",params![id,episode,milliseconds,label,unix_time_millis()]).map_err(|e|e.to_string())?;
  tx.commit().map_err(|e|e.to_string())
}
pub(crate) fn update_bookmark(path:&Path,episode:&str,id:&str,label:&str,expected:&str)->Result<(),String> {
  validate_identifier(episode)?;validate_identifier(id)?;let label=label.trim();
  if label.chars().count()>200||label.chars().any(char::is_control){return Err("书签备注无效".into());}
  let mut db=open_database(path)?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
  let current:Option<String>=tx.query_row("SELECT label FROM podcast_bookmarks WHERE episode_id=?1 AND id=?2",params![episode,id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
  if current.as_deref()!=Some(expected){return Err("书签已变化，请重新读取后编辑".into());}
  tx.execute("UPDATE podcast_bookmarks SET label=?3,updated_at=?4 WHERE episode_id=?1 AND id=?2",params![episode,id,label,unix_time_millis()]).map_err(|e|e.to_string())?;
  tx.commit().map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn podcast_update_bookmark(state:State<'_,PodcastState>,episode_id:String,bookmark_id:String,label:String,expected_label:String)->Result<Vec<PodcastBookmark>,String>{state.ensure_ready()?;let path=state.db_path.clone();tauri::async_runtime::spawn_blocking(move||{update_bookmark(&path,&episode_id,&bookmark_id,&label,&expected_label)?;list_bookmarks(&path,&episode_id)}).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn podcast_restore_bookmark(state:State<'_,PodcastState>,episode_id:String,bookmark:PodcastBookmark)->Result<Vec<PodcastBookmark>,String>{state.ensure_ready()?;let path=state.db_path.clone();tauri::async_runtime::spawn_blocking(move||{write_bookmark(&path,&episode_id,bookmark.position_seconds,&bookmark.label,Some(&bookmark.id),false)?;list_bookmarks(&path,&episode_id)}).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn podcast_list_bookmarks(state:State<'_,PodcastState>,episode_id:String)->Result<Vec<PodcastBookmark>,String>{state.ensure_ready()?;let path=state.db_path.clone();tauri::async_runtime::spawn_blocking(move||list_bookmarks(&path,&episode_id)).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn podcast_add_bookmark(state:State<'_,PodcastState>,episode_id:String,position_seconds:f64,label:String,preserve_existing:Option<bool>)->Result<Vec<PodcastBookmark>,String>{state.ensure_ready()?;let path=state.db_path.clone();tauri::async_runtime::spawn_blocking(move||{write_bookmark(&path,&episode_id,position_seconds,&label,None,preserve_existing.unwrap_or(false))?;list_bookmarks(&path,&episode_id)}).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn podcast_remove_bookmark(state:State<'_,PodcastState>,episode_id:String,bookmark_id:String)->Result<Vec<PodcastBookmark>,String>{state.ensure_ready()?;validate_identifier(&episode_id)?;validate_identifier(&bookmark_id)?;let path=state.db_path.clone();tauri::async_runtime::spawn_blocking(move||{open_database(&path)?.execute("DELETE FROM podcast_bookmarks WHERE id=?1 AND episode_id=?2",params![bookmark_id,episode_id]).map_err(|e|e.to_string())?;list_bookmarks(&path,&episode_id)}).await.map_err(|e|e.to_string())?}

#[cfg(test)]
mod tests {
  use super::*;use super::super::test_support::*;
  #[test]
  fn bookmark_edits_and_delete_undo_protect_newer_notes_at_the_same_time() {
    let directory=test_directory("bookmark-edit-undo");let state=PodcastState::initialize_at(&directory).unwrap();let parsed=parsed_fixture("https://example.com/a.mp3");let episode=parsed.episodes[0].id.clone();store_subscription(&state.db_path,parsed).unwrap();
    add_bookmark(&state.db_path,&episode,30.0,"原备注").unwrap();let original=list_bookmarks(&state.db_path,&episode).unwrap().remove(0);
    update_bookmark(&state.db_path,&episode,&original.id,"新备注","原备注").unwrap();
    assert!(update_bookmark(&state.db_path,&episode,&original.id,"旧编辑","原备注").is_err());
    assert_eq!(list_bookmarks(&state.db_path,&episode).unwrap()[0].label,"新备注");
    write_bookmark(&state.db_path,&episode,30.0,"",None,true).unwrap();
    assert_eq!(list_bookmarks(&state.db_path,&episode).unwrap()[0].label,"新备注");
    open_database(&state.db_path).unwrap().execute("DELETE FROM podcast_bookmarks WHERE id=?1",[&original.id]).unwrap();
    write_bookmark(&state.db_path,&episode,30.0,"新备注",Some(&original.id),false).unwrap();
    assert_eq!(list_bookmarks(&state.db_path,&episode).unwrap()[0].id,original.id);
    assert!(write_bookmark(&state.db_path,&episode,30.0,"被删除备注",Some(&original.id),false).is_err());
    assert_eq!(list_bookmarks(&state.db_path,&episode).unwrap()[0].label,"新备注");
  }
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
