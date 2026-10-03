use super::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PodcastPreferences {
  pub auto_download_count: u32,
  pub cleanup_played: bool,
  pub storage_limit_mb: u32,
  pub playback_rate: Option<f64>,
  pub intro_seconds: u32,
  pub outro_seconds: u32,
  pub backward_seconds: u32,
  pub forward_seconds: u32,
  pub oldest_first: bool,
  pub normalize_voice: bool,
  pub trim_silence: bool,
  pub inherit_playback: bool,
}

impl Default for PodcastPreferences {
  fn default() -> Self {
    Self { auto_download_count: 0, cleanup_played: false, storage_limit_mb: 0,
      playback_rate: None, intro_seconds: 0, outro_seconds: 0, backward_seconds: 15,
      forward_seconds: 30, oldest_first: false, normalize_voice: false, trim_silence: false, inherit_playback: true }
  }
}

fn preferences_key(feed_id: Option<&str>) -> Result<String, String> {
  if let Some(id) = feed_id { validate_identifier(id)?; }
  Ok(feed_id.map(|id| format!("podcast.preferences.feed.{id}")).unwrap_or_else(|| "podcast.preferences.global.v1".into()))
}

pub(crate) fn read_preferences(path: &Path, feed_id: Option<&str>) -> Result<PodcastPreferences, String> {
  let key = preferences_key(feed_id)?;
  let db = open_database(path)?;
  let json: Option<String> = db.query_row("SELECT value_json FROM app_settings WHERE key=?1", [key], |row| row.get(0))
    .optional().map_err(|e| e.to_string())?;
  match json { Some(json) => serde_json::from_str(&json).map_err(|_| "播客设置损坏，已保留原记录".into()), None => Ok(PodcastPreferences::default()) }
}

pub(crate) fn write_preferences(path: &Path, feed_id: Option<&str>, value: &PodcastPreferences) -> Result<(), String> {
  let key = preferences_key(feed_id)?;
  if value.auto_download_count > 50 || value.storage_limit_mb > 1_000_000 || value.intro_seconds > 3600 || value.outro_seconds > 3600
    || !(1..=300).contains(&value.backward_seconds) || !(1..=300).contains(&value.forward_seconds)
    || value.playback_rate.is_some_and(|r| !r.is_finite() || !(0.5..=3.0).contains(&r)) {
    return Err("播客设置超出范围".into());
  }
  let db = open_database(path)?;
  if let Some(id) = feed_id {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM podcast_feeds WHERE id=?1)", [id], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !exists { return Err("节目不存在".into()); }
  }
  db.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    params![key, serde_json::to_string(value).map_err(|e| e.to_string())?, unix_time_millis()]).map_err(|e| e.to_string())?;
  Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDownloadJob {
  episode_id: String, title: String, state: String, attempts: u32,
  error: Option<String>, downloaded_bytes: u64, total_bytes: Option<u64>,
}

pub(crate) fn queue_download_job(path: &Path, id: &str) -> Result<(), String> {
  validate_identifier(id)?;
  let db = open_database(path)?;
  let count: u32 = db.query_row("SELECT COUNT(*) FROM podcast_download_jobs WHERE state IN ('queued','running')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
  if count >= 500 { return Err("下载队列已满".into()); }
  db.execute("INSERT INTO podcast_download_jobs(episode_id,state,attempts,updated_at) VALUES (?1,'queued',0,?2)
    ON CONFLICT(episode_id) DO UPDATE SET state='queued',attempts=0,error=NULL,updated_at=excluded.updated_at WHERE podcast_download_jobs.state<>'running'",
    params![id,unix_time_millis()]).map_err(|e| format!("无法加入下载队列：{e}"))?;
  Ok(())
}

pub(crate) fn begin_download_job(path: &Path, id: &str, request_id: Option<&str>) -> Result<(), String> {
  if request_id.is_some_and(|id| id.starts_with("download-job-")) {
    let changed = open_database(path)?.execute("UPDATE podcast_download_jobs SET state='running',attempts=attempts+1,request_id=?2,error=NULL,updated_at=?3 WHERE episode_id=?1 AND state='queued'",
      params![id,request_id,unix_time_millis()]).map_err(|e| e.to_string())?;
    return if changed == 1 { Ok(()) } else { Err("下载任务已暂停或变化".into()) };
  }
  open_database(path)?.execute("INSERT INTO podcast_download_jobs(episode_id,state,attempts,request_id,updated_at) VALUES (?1,'running',1,?2,?3)
    ON CONFLICT(episode_id) DO UPDATE SET state='running',attempts=attempts+1,request_id=excluded.request_id,error=NULL,updated_at=excluded.updated_at",
    params![id,request_id,unix_time_millis()]).map_err(|e| e.to_string())?;
  Ok(())
}

pub(crate) fn finish_download_job(path: &Path, id: &str, error: Option<&str>) -> Result<(), String> {
  let status = match error { None => "complete", Some(e) if e.contains("已取消播客网络请求") => "paused", Some(_) => "failed" };
  open_database(path)?.execute("UPDATE podcast_download_jobs SET state=?2,error=?3,request_id=NULL,updated_at=?4 WHERE episode_id=?1 AND state<>'paused'",
    params![id,status,error,unix_time_millis()]).map_err(|e| e.to_string())?;
  Ok(())
}

pub(crate) fn list_download_jobs(path: &Path) -> Result<Vec<PodcastDownloadJob>, String> {
  let db = open_database(path)?;
  let mut query = db.prepare("SELECT j.episode_id,e.title,j.state,j.attempts,j.error,COALESCE(d.downloaded_bytes,0),d.total_bytes FROM podcast_download_jobs j
    JOIN podcast_episodes e ON e.id=j.episode_id LEFT JOIN podcast_downloads d ON d.episode_id=e.id WHERE j.state<>'complete' ORDER BY j.updated_at,j.episode_id LIMIT 500").map_err(|e| e.to_string())?;
  let result = query.query_map([], |r| Ok(PodcastDownloadJob { episode_id:r.get(0)?, title:r.get(1)?, state:r.get(2)?, attempts:r.get(3)?, error:r.get(4)?, downloaded_bytes:r.get::<_,i64>(5)?.max(0) as u64, total_bytes:r.get::<_,Option<i64>>(6)?.map(|n|n.max(0) as u64) }))
    .map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string());
  result
}

fn plan_automatic_downloads(state: &PodcastState) -> Result<(), String> {
  for feed in list_feeds(&state.db_path)? {
    let preferences = read_preferences(&state.db_path, Some(&feed.id))?;
    if preferences.auto_download_count == 0 { continue; }
    let db = open_database(&state.db_path)?;
    let mut query = db.prepare("SELECT e.id FROM podcast_episodes e LEFT JOIN podcast_progress p ON p.episode_id=e.id
      LEFT JOIN podcast_downloads d ON d.episode_id=e.id LEFT JOIN podcast_download_jobs j ON j.episode_id=e.id
      WHERE e.id IN (SELECT newest.id FROM podcast_episodes newest WHERE newest.feed_id=?1
        ORDER BY newest.published_at DESC,newest.first_seen_at DESC LIMIT ?2)
      AND COALESCE(p.completed,0)=0 AND COALESCE(d.state,'')<>'downloaded' AND j.episode_id IS NULL ORDER BY e.published_at DESC").map_err(|e| e.to_string())?;
    let ids = query.query_map(params![feed.id,preferences.auto_download_count], |r| r.get::<_,String>(0)).map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    for id in ids { queue_download_job(&state.db_path,&id)?; }
  }
  Ok(())
}

pub(crate) fn cleanup_managed_downloads(state: &PodcastState) -> Result<(), String> {
  let global = read_preferences(&state.db_path,None)?;
  let active = load_active_episode_session(&state.db_path)?.and_then(|s| s.active_episode_id);
  let db = open_database(&state.db_path)?;
  let total: u64 = db.query_row("SELECT COALESCE(SUM(downloaded_bytes),0) FROM podcast_downloads WHERE state='downloaded'",[],|r|Ok(r.get::<_,i64>(0)?.max(0) as u64)).map_err(|e| e.to_string())?;
  let limit = u64::from(global.storage_limit_mb)*1024*1024;
  let mut remaining = total;
  let mut query = db.prepare("SELECT e.id,e.feed_id,d.downloaded_bytes FROM podcast_episodes e JOIN podcast_downloads d ON d.episode_id=e.id
    JOIN podcast_progress p ON p.episode_id=e.id WHERE d.state='downloaded' AND p.completed=1
    AND NOT EXISTS(SELECT 1 FROM podcast_saved_episodes s WHERE s.episode_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM podcast_queue q WHERE q.episode_id=e.id) ORDER BY p.updated_at,e.id").map_err(|e| e.to_string())?;
  let candidates = query.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?.max(0) as u64)))
    .map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
  for (id,feed,bytes) in candidates {
    if active.as_deref()==Some(&id) { continue; }
    if global.cleanup_played || read_preferences(&state.db_path,Some(&feed))?.cleanup_played || (limit>0 && remaining>limit) {
      let result = delete_episode_downloads_guarded(&state.db_path,&state.downloads_dir,&state.active_downloads,vec![id],true)?;
      remaining = remaining.saturating_sub(result.deleted_bytes.min(bytes));
    }
  }
  Ok(())
}

pub(crate) fn check_download_capacity(state: &PodcastState, id: &str) -> Result<(), String> {
  let limit = u64::from(read_preferences(&state.db_path,None)?.storage_limit_mb)*1024*1024;
  if limit==0 { return Ok(()); }
  let db=open_database(&state.db_path)?;
  let (bytes,expected)=db.query_row("SELECT (SELECT COALESCE(SUM(downloaded_bytes),0) FROM podcast_downloads WHERE state='downloaded'),COALESCE(expected_bytes,0) FROM podcast_episodes WHERE id=?1",[id],|r|Ok((r.get::<_,i64>(0)?.max(0) as u64,r.get::<_,i64>(1)?.max(0) as u64))).map_err(|e|e.to_string())?;
  if bytes>=limit || bytes.saturating_add(expected)>limit { Err("下载空间已达上限，请清理下载或调整设置".into()) } else { Ok(()) }
}

pub fn start_podcast_maintenance(app: tauri::AppHandle, state: PodcastState) {
  if state.ensure_ready().is_err() { return; }
  // Only this process owns jobs; paused jobs deliberately survive restart.
  let recovered = open_database(&state.db_path).and_then(|db| db.execute("UPDATE podcast_download_jobs SET state='queued',request_id=NULL WHERE state='running'",[]).map(|_|()).map_err(|e|e.to_string()));
  if recovered.is_err() { return; }
  let refresh_state=state.clone(); let refresh_app=app.clone();
  tauri::async_runtime::spawn(async move {
    loop {
      if let Ok(targets)=list_refresh_targets(&refresh_state.db_path,None,false,unix_time_millis()) {
        for target in targets {
          let _=refresh_feed_target(refresh_state.db_path.clone(),refresh_state.active_refreshes.clone(),refresh_state.refresh_semaphore.clone(),target,false).await;
        }
        let _=refresh_app.emit("podcast-library-changed",());
      }
      tokio::time::sleep(Duration::from_secs(30*60)).await;
    }
  });
  tauri::async_runtime::spawn(async move {
    let mut last_plan=std::time::Instant::now()-Duration::from_secs(60);
    loop {
      if last_plan.elapsed()>=Duration::from_secs(60) {
        last_plan=std::time::Instant::now();
        let planning_state=state.clone();
        let _=tauri::async_runtime::spawn_blocking(move || { cleanup_managed_downloads(&planning_state)?; plan_automatic_downloads(&planning_state) }).await;
      }
      if state.ensure_ready().is_ok() {
        if let Ok(jobs)=list_download_jobs(&state.db_path) {
          for job in jobs.into_iter().filter(|job|job.state=="queued") {
            let request_id=format!("download-job-{}-{}",job.episode_id,unix_time_millis());
            let _=run_download_episode(&state,job.episode_id,Some(request_id)).await;
            let _=app.emit("podcast-library-changed",());
          }
        }
      }
      tokio::time::sleep(Duration::from_secs(5)).await;
    }
  });
}

#[tauri::command]
pub async fn podcast_get_preferences(state: State<'_,PodcastState>,feed_id: Option<String>) -> Result<PodcastPreferences,String> {
  state.ensure_ready()?; read_preferences(&state.db_path,feed_id.as_deref())
}
#[tauri::command]
pub async fn podcast_set_preferences(app:tauri::AppHandle,state: State<'_,PodcastState>,feed_id: Option<String>,preferences: PodcastPreferences) -> Result<(),String> {
  state.ensure_ready()?; write_preferences(&state.db_path,feed_id.as_deref(),&preferences)?;
  let _=app.emit("podcast-preferences-changed",feed_id);Ok(())
}
#[tauri::command]
pub async fn podcast_list_download_jobs(state: State<'_,PodcastState>) -> Result<Vec<PodcastDownloadJob>,String> {
  state.ensure_ready()?; list_download_jobs(&state.db_path)
}
#[tauri::command]
pub async fn podcast_enqueue_download(state: State<'_,PodcastState>,episode_id: String) -> Result<(),String> {
  state.ensure_ready()?; queue_download_job(&state.db_path,&episode_id)
}
#[tauri::command]
pub async fn podcast_pause_download_job(state: State<'_,PodcastState>,episode_id: String) -> Result<(),String> {
  state.ensure_ready()?; validate_identifier(&episode_id)?;
  let db=open_database(&state.db_path)?;
  let request: Option<String>=db.query_row("SELECT request_id FROM podcast_download_jobs WHERE episode_id=?1",[&episode_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?.flatten();
  db.execute("UPDATE podcast_download_jobs SET state='paused',updated_at=?2 WHERE episode_id=?1 AND state<>'complete'",params![episode_id,unix_time_millis()]).map_err(|e|e.to_string())?;
  if let Some(request)=request { cancel_network_task(&request)?; }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*; use crate::podcast::test_support::*;
  #[test]
  fn preferences_validate_and_preserve_corrupt_data() {
    let dir=test_directory("maintenance-settings"); let state=PodcastState::initialize_at(&dir).unwrap();
    let p=PodcastPreferences {storage_limit_mb:2048,..Default::default()};
    write_preferences(&state.db_path,None,&p).unwrap(); assert_eq!(read_preferences(&state.db_path,None).unwrap(),p);
    assert!(write_preferences(&state.db_path,None,&PodcastPreferences {playback_rate:Some(f64::NAN),..p}).is_err());
    open_database(&state.db_path).unwrap().execute("UPDATE app_settings SET value_json='broken' WHERE key='podcast.preferences.global.v1'",[]).unwrap();
    assert!(read_preferences(&state.db_path,None).is_err());
  }
  #[test]
  fn jobs_survive_restart_pause_and_failure_without_losing_resume_data() {
    let dir=test_directory("maintenance-jobs"); let state=PodcastState::initialize_at(&dir).unwrap();
    let parsed=parsed_fixture("https://example.com/a.mp3"); let id=parsed.episodes[0].id.clone(); store_subscription(&state.db_path,parsed).unwrap();
    queue_download_job(&state.db_path,&id).unwrap(); begin_download_job(&state.db_path,&id,Some("request")).unwrap();
    let restart=PodcastState::initialize_at(&dir).unwrap(); assert_eq!(list_download_jobs(&restart.db_path).unwrap()[0].state,"running");
    finish_download_job(&state.db_path,&id,Some("已取消播客网络请求")).unwrap(); assert_eq!(list_download_jobs(&state.db_path).unwrap()[0].state,"paused");
    queue_download_job(&state.db_path,&id).unwrap(); begin_download_job(&state.db_path,&id,None).unwrap();
    finish_download_job(&state.db_path,&id,None).unwrap(); assert!(list_download_jobs(&state.db_path).unwrap().is_empty());
    assert!(queue_download_job(&state.db_path,"invalid").is_err());
  }

  fn many_episodes() -> ParsedPodcast {
    let mut parsed=parsed_fixture("https://example.com/a.mp3");
    let original=parsed.episodes[0].clone();
    parsed.episodes=(1..=4).map(|n| {let mut e=original.clone();e.id=format!("{n:064x}");e.identity_key=format!("episode-{n}");e.published_at=Some(n*1000);e}).collect(); parsed
  }

  #[test]
  fn automatic_download_limit_does_not_drain_older_episodes() {
    let dir=test_directory("maintenance-auto-limit"); let state=PodcastState::initialize_at(&dir).unwrap();
    let parsed=many_episodes(); let feed=parsed.feed.id.clone(); let newest=parsed.episodes[3].id.clone();
    store_subscription(&state.db_path,parsed).unwrap();
    write_preferences(&state.db_path,Some(&feed),&PodcastPreferences{auto_download_count:1,..Default::default()}).unwrap();
    plan_automatic_downloads(&state).unwrap(); let jobs=list_download_jobs(&state.db_path).unwrap(); assert_eq!(jobs.len(),1);assert_eq!(jobs[0].episode_id,newest);
    begin_download_job(&state.db_path,&newest,None).unwrap(); finish_download_job(&state.db_path,&newest,None).unwrap();
    open_database(&state.db_path).unwrap().execute("INSERT INTO podcast_progress VALUES (?1,100,100,1,1)",[&newest]).unwrap();
    plan_automatic_downloads(&state).unwrap(); assert!(list_download_jobs(&state.db_path).unwrap().is_empty());
  }

  #[test]
  fn cleanup_preserves_saved_queued_and_active_audio() {
    let dir=test_directory("maintenance-cleanup"); let state=PodcastState::initialize_at(&dir).unwrap();
    let parsed=many_episodes(); let ids:Vec<_>=parsed.episodes.iter().map(|e|e.id.clone()).collect(); store_subscription(&state.db_path,parsed).unwrap();
    let db=open_database(&state.db_path).unwrap();
    for id in &ids {
      let path=state.downloads_dir.join(format!("{id}.mp3")); fs::write(&path,b"ID3test").unwrap();
      mark_download_complete(&state.db_path,id,&path.to_string_lossy(),7,Some(7)).unwrap();
      db.execute("INSERT INTO podcast_progress VALUES (?1,100,100,1,1)",[id]).unwrap();
    }
    db.execute("INSERT INTO podcast_saved_episodes VALUES (?1,1)",[&ids[0]]).unwrap();
    db.execute("INSERT INTO podcast_queue VALUES (?1,0,1)",[&ids[1]]).unwrap();
    save_active_episode_session(&state.db_path,Some(ids[2].clone())).unwrap();
    write_preferences(&state.db_path,None,&PodcastPreferences{cleanup_played:true,..Default::default()}).unwrap();
    cleanup_managed_downloads(&state).unwrap();
    for id in &ids[..3] {assert!(state.downloads_dir.join(format!("{id}.mp3")).is_file());}
    assert!(!state.downloads_dir.join(format!("{}.mp3",ids[3])).exists());
  }

  #[test]
  fn paused_job_cannot_be_claimed_by_a_stale_background_snapshot() {
    let dir=test_directory("maintenance-claim");let state=PodcastState::initialize_at(&dir).unwrap();let parsed=parsed_fixture("https://example.com/a.mp3");let id=parsed.episodes[0].id.clone();store_subscription(&state.db_path,parsed).unwrap();
    queue_download_job(&state.db_path,&id).unwrap();open_database(&state.db_path).unwrap().execute("UPDATE podcast_download_jobs SET state='paused' WHERE episode_id=?1",[&id]).unwrap();
    assert!(begin_download_job(&state.db_path,&id,Some("download-job-stale")).is_err());assert_eq!(list_download_jobs(&state.db_path).unwrap()[0].state,"paused");
  }
}
