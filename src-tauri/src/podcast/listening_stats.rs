use super::*;
use rusqlite::{params,TransactionBehavior};
use serde::Serialize;
use tauri::State;
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ListeningStats {pub total_seconds:f64,pub recent_seconds:f64,pub episode_count:i64,pub feed_count:i64,pub days:Vec<ListeningDay>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ListeningDay {pub day:String,pub seconds:f64}
pub(crate) fn record(path:&Path,episode:&str,id:&str,seconds:f64)->Result<(),String>{
  validate_identifier(episode)?;validate_identifier(id)?;if !seconds.is_finite()||!(0.0..=60.0).contains(&seconds){return Err("实际收听时长无效".into());}
  let mut db=open_database(path)?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
  let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM podcast_episodes WHERE id=?1)",[episode],|r|r.get(0)).map_err(|e|e.to_string())?;if !exists{return Err("统计单集不存在".into());}
  let inserted=tx.execute("INSERT INTO podcast_listening_batches(id,recorded_at) VALUES(?1,?2) ON CONFLICT(id) DO NOTHING",params![id,unix_time_millis()]).map_err(|e|e.to_string())?;
  if inserted>0 {tx.execute("INSERT INTO podcast_listening_daily(day,episode_id,seconds) VALUES(strftime('%Y-%m-%d','now','localtime'),?1,?2) ON CONFLICT(day,episode_id) DO UPDATE SET seconds=seconds+excluded.seconds",params![episode,seconds]).map_err(|e|e.to_string())?;}
  tx.execute("DELETE FROM podcast_listening_batches WHERE recorded_at<?1",[unix_time_millis()-31*86400000]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;Ok(())
}
pub(crate) fn statistics(path:&Path)->Result<ListeningStats,String>{
  let db=open_database(path)?;let (total_seconds,recent_seconds,episode_count,feed_count)=db.query_row("SELECT COALESCE(SUM(s.seconds),0),COALESCE(SUM(CASE WHEN s.day>=strftime('%Y-%m-%d','now','localtime','-6 days') THEN s.seconds ELSE 0 END),0),COUNT(DISTINCT s.episode_id),COUNT(DISTINCT e.feed_id) FROM podcast_listening_daily s JOIN podcast_episodes e ON e.id=s.episode_id",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|e|e.to_string())?;
  let mut q=db.prepare("SELECT day,SUM(seconds) FROM podcast_listening_daily GROUP BY day ORDER BY day DESC LIMIT 14").map_err(|e|e.to_string())?;let days=q.query_map([],|r|Ok(ListeningDay{day:r.get(0)?,seconds:r.get(1)?})).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;Ok(ListeningStats{total_seconds,recent_seconds,episode_count,feed_count,days})
}
#[tauri::command]
pub async fn podcast_record_listening(state:State<'_,PodcastState>,episode_id:String,batch_id:String,seconds:f64)->Result<(),String>{state.ensure_ready()?;let path=state.db_path.clone();tauri::async_runtime::spawn_blocking(move||record(&path,&episode_id,&batch_id,seconds)).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn podcast_listening_stats(state:State<'_,PodcastState>)->Result<ListeningStats,String>{state.ensure_ready()?;let path=state.db_path.clone();tauri::async_runtime::spawn_blocking(move||statistics(&path)).await.map_err(|e|e.to_string())?}
#[cfg(test)]mod tests {use super::*;use crate::podcast::test_support::*;
  #[test]fn listening_records_are_idempotent_and_do_not_create_progress_or_music_statistics(){let dir=test_directory("listening-stats");let state=PodcastState::initialize_at(&dir).unwrap();let parsed=parsed_fixture_with_episode_count(1);let id=parsed.episodes[0].id.clone();store_subscription(&state.db_path,parsed).unwrap();record(&state.db_path,&id,&hash_identifier("batch",&["one"]),20.0).unwrap();record(&state.db_path,&id,&hash_identifier("batch",&["one"]),20.0).unwrap();record(&state.db_path,&id,&hash_identifier("batch",&["two"]),15.0).unwrap();let stats=statistics(&state.db_path).unwrap();assert_eq!(stats.total_seconds,35.0);assert_eq!(stats.episode_count,1);assert_eq!(stats.days.len(),1);let count:i64=open_database(&state.db_path).unwrap().query_row("SELECT COUNT(*) FROM podcast_progress",[],|r|r.get(0)).unwrap();assert_eq!(count,0);assert!(record(&state.db_path,&id,&hash_identifier("batch",&["bad"]),61.0).is_err());fs::remove_dir_all(dir).unwrap();}
}
