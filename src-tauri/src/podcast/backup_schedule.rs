use super::*;
use rusqlite::{params,OptionalExtension};
use std::sync::OnceLock;

const LOCAL_KEY:&str="podcast.backup.local.v1";
static BACKUP_LOCK:OnceLock<Mutex<()>>=OnceLock::new();
pub(super) fn backup_lock()->&'static Mutex<()> {BACKUP_LOCK.get_or_init(||Mutex::new(()))}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",default)]
pub struct BackupSchedule {pub interval_days:u32,pub retain_count:u32}
impl Default for BackupSchedule {fn default()->Self{Self{interval_days:0,retain_count:7}}}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub(super) struct OwnedSnapshot {pub name:String,pub created_at:i64,pub bytes:u64,pub hash:String}
#[derive(Default,Serialize,Deserialize)]
#[serde(rename_all="camelCase",default)]
pub(super) struct BackupLocal {pub schedule:BackupSchedule,pub last_automatic:Option<i64>,pub error:Option<String>,pub automatic:Vec<OwnedSnapshot>,pub frontend:BTreeMap<String,String>}

pub(super) fn read_local(state:&PodcastState)->Result<BackupLocal,String> {
  let json:Option<String>=open_database(&state.db_path)?.query_row("SELECT value_json FROM app_settings WHERE key=?1",[LOCAL_KEY],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
  let value:BackupLocal=match json {Some(json)=>serde_json::from_str(&json).map_err(|_|"自动备份设置损坏，已暂停自动备份")?,None=>BackupLocal::default()};
  validate_schedule(&value.schedule)?;validate_frontend(&value.frontend)?;
  if value.automatic.len()>100 {return Err("自动备份历史无效，已暂停自动备份".into());}Ok(value)
}
fn write_local(state:&PodcastState,value:&BackupLocal)->Result<(),String> {
  open_database(&state.db_path)?.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",params![LOCAL_KEY,serde_json::to_string(value).map_err(|e|e.to_string())?,unix_time_millis()]).map_err(|e|e.to_string())?;Ok(())
}
fn validate_schedule(schedule:&BackupSchedule)->Result<(),String>{if ![0,1,7].contains(&schedule.interval_days)||!(3..=30).contains(&schedule.retain_count){return Err("自动备份间隔或保留数量无效".into());}Ok(())}

// Only unmodified snapshots registered by this installation can be pruned.
// Manual copies, audio folders and unknown files never enter this allowlist.
fn prune(state:&PodcastState,value:&mut BackupLocal)->Result<(),String> {
  let folder=super::managed::managed_backup_directory(state,false)?;
  value.automatic.sort_by(|a,b|b.created_at.cmp(&a.created_at).then_with(||b.name.cmp(&a.name)));
  let old=value.automatic.split_off((value.schedule.retain_count as usize).min(value.automatic.len()));
  for item in old {
    if !super::managed::valid_backup_name(&item.name) {return Err("自动备份文件名无效".into());}
    let path=folder.join(&item.name);
    match fs::symlink_metadata(&path) {
      Ok(metadata) if metadata.is_file()&&!metadata.file_type().is_symlink()&&metadata.len()==item.bytes&&item.bytes<=MANIFEST_LIMIT&&path.canonicalize().ok().as_ref()==Some(&path) => {
        if hash_file(&path)?==(item.bytes,item.hash) {fs::remove_file(&path).map_err(|_|"旧自动备份暂无法清理")?;}
      },
      Ok(_)=>{},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>{},Err(_)=>return Err("旧自动备份不可访问".into())
    }
  }
  Ok(())
}

pub(crate) fn run_scheduled_backup(state:&PodcastState,now:i64)->Result<bool,String> {
  let _lock=backup_lock().lock().map_err(|_|"备份任务锁不可用")?;
  let mut local=read_local(state)?;
  if local.schedule.interval_days==0 || local.last_automatic.is_some_and(|last|now.saturating_sub(last)<i64::from(local.schedule.interval_days)*86_400_000) {return Ok(false);}
  let result=(||{
    let exported=super::managed::create_managed_backup(state,local.frontend.clone(),false)?;
    let path=super::managed::managed_backup_directory(state,false)?.join(&exported.file_name);
    let (bytes,hash)=hash_file(&path)?;
    local.automatic.push(OwnedSnapshot{name:exported.file_name,created_at:now,bytes,hash});
    local.last_automatic=Some(now);local.error=None;
    // Record ownership before any cleanup; a failure never makes unrelated
    // files eligible for a future retention pass.
    write_local(state,&local)?;prune(state,&mut local)?;Ok::<_,String>(())
  })();
  if let Err(error)=&result {local.error=Some(error.clone());}write_local(state,&local)?;result.map(|_|true)
}

#[tauri::command]
pub async fn podcast_set_backup_schedule(state:State<'_,PodcastState>,schedule:BackupSchedule,frontend_settings:BTreeMap<String,String>)->Result<(),String> {
  state.ensure_ready()?;validate_schedule(&schedule)?;validate_frontend(&frontend_settings)?;
  let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{
    let _lock=backup_lock().lock().map_err(|_|"备份任务锁不可用")?;let mut local=read_local(&state)?;
    local.schedule=schedule;local.frontend=frontend_settings;local.error=None;write_local(&state,&local)
  }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn podcast_preview_managed_backup(state:State<'_,PodcastState>,file_name:String)->Result<BackupPreview,String> {
  state.ensure_ready()?;if !super::managed::valid_backup_name(&file_name){return Err("备份文件名无效".into());}
  let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{
    let folder=super::managed::managed_backup_directory(&state,false)?;let path=folder.join(file_name);
    let metadata=fs::symlink_metadata(&path).map_err(|_|"本机备份不可访问")?;
    if !metadata.is_file()||metadata.file_type().is_symlink()||path.canonicalize().map_err(|_|"备份不可访问")?!=path{return Err("本机备份不是受控普通文件".into());}
    super::preview::create_backup_preview(&state,&path)
  }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;use crate::podcast::test_support::*;
  #[test]
  fn schedules_are_disabled_by_default_and_prune_only_unchanged_owned_snapshots(){
    let dir=test_directory("backup-schedule");let state=PodcastState::initialize_at(&dir).unwrap();
    store_subscription(&state.db_path,parsed_fixture("https://example.com/a.mp3")).unwrap();
    assert!(!run_scheduled_backup(&state,100).unwrap());let manual=super::super::managed::create_managed_backup(&state,BTreeMap::new(),false).unwrap();
    let folder=super::super::managed::managed_backup_directory(&state,false).unwrap();let manual_bytes=fs::read(folder.join(&manual.file_name)).unwrap();
    let mut local=read_local(&state).unwrap();local.schedule=BackupSchedule{interval_days:1,retain_count:3};write_local(&state,&local).unwrap();
    assert!(run_scheduled_backup(&state,1000).unwrap());assert!(!run_scheduled_backup(&state,1001).unwrap());
    let first=read_local(&state).unwrap().automatic[0].name.clone();fs::write(folder.join(&first),b"user changed this file").unwrap();
    for day in 1..=5 {assert!(run_scheduled_backup(&state,1000+day*86_400_000).unwrap());}
    assert_eq!(read_local(&state).unwrap().automatic.len(),3);assert_eq!(fs::read(folder.join(first)).unwrap(),b"user changed this file");assert_eq!(fs::read(folder.join(manual.file_name)).unwrap(),manual_bytes);
    assert_eq!(fs::read_dir(folder).unwrap().count(),5,"3 automatic, 1 protected modified copy, 1 manual");
  }
}
