use super::*;
use rusqlite::{params,OptionalExtension};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::{collections::BTreeMap,io::Read};
use tauri::{Emitter,State};

const KEY:&str="podcast.sync.local.v1";
static SYNC_LOCK:Mutex<()>=Mutex::new(());
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase")]
struct SyncConfig {folder:Option<PathBuf>,device:String,last_synced:Option<i64>,error:Option<String>,seen:BTreeMap<String,String>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct PodcastSyncStatus {folder:Option<String>,last_synced:Option<i64>,error:Option<String>}
fn config(path:&Path)->Result<SyncConfig,String>{
  let json:Option<String>=open_database(path)?.query_row("SELECT value_json FROM app_settings WHERE key=?1",[KEY],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
  let config:SyncConfig=match json{Some(json)=>serde_json::from_str(&json).map_err(|_|"同步配置损坏，已暂停自动同步")?,None=>SyncConfig{folder:None,device:super::lists::new_collection_id("sync-device",""),last_synced:None,error:None,seen:BTreeMap::new()}};
  validate_identifier(&config.device)?;if config.folder.as_ref().is_some_and(|path|!path.is_absolute())||config.seen.len()>32{return Err("同步配置无效，已暂停自动同步".into());}Ok(config)
}
fn save_config(state:&PodcastState,value:&SyncConfig)->Result<(),String>{open_database(&state.db_path)?.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",params![KEY,serde_json::to_string(value).map_err(|e|e.to_string())?,unix_time_millis()]).map(|_|()).map_err(|e|e.to_string())}
fn status(value:SyncConfig)->PodcastSyncStatus{PodcastSyncStatus{folder:value.folder.map(|path|path.to_string_lossy().into()),last_synced:value.last_synced,error:value.error}}
fn configure(state:&PodcastState,folder:&Path)->Result<(),String>{let folder=folder.canonicalize().map_err(|e|format!("同步目录不可用：{e}"))?;if !folder.is_dir(){return Err("请选择一个同步目录".into());}let mut value=config(&state.db_path)?;value.folder=Some(folder);value.last_synced=None;value.error=None;value.seen.clear();save_config(state,&value)}
fn fingerprint(path:&Path)->Result<String,String>{let mut bytes=Vec::new();fs::File::open(path).map_err(|e|e.to_string())?.take(64*1024*1024+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;if bytes.len()>64*1024*1024{return Err("同步快照过大".into());}Ok(format!("{:x}",Sha256::digest(bytes)))}
pub(crate) fn sync_once(state:&PodcastState)->Result<bool,String>{
  let _lock=SYNC_LOCK.lock().map_err(|_|"同步任务锁无效")?;let mut value=config(&state.db_path)?;let Some(folder)=value.folder.clone()else{return Ok(false);};
  let operation=(||{
    let resolved=folder.canonicalize().map_err(|_|"同步目录暂不可用，请检查网盘或共享盘")?;if resolved!=folder||!resolved.is_dir(){return Err("同步目录位置改变，请重新选择".into());}
    let own_name=format!("zone-podcast-sync-{}.zonepodcast",value.device);let mut changed=false;let mut errors=Vec::new();let mut seen=BTreeMap::new();let mut peers=0;
    for (index,entry)in fs::read_dir(&folder).map_err(|e|e.to_string())?.enumerate(){if index>=512{return Err("同步目录文件过多，请选择专用目录".into());}let entry=entry.map_err(|e|e.to_string())?;let name=entry.file_name().to_string_lossy().into_owned();if name==own_name{continue;}let Some(id)=name.strip_prefix("zone-podcast-sync-").and_then(|name|name.strip_suffix(".zonepodcast"))else{continue;};if validate_identifier(id).is_err(){continue;}peers+=1;if peers>32{return Err("同步设备超过 32 台".into());}
      let imported=(||{let path=entry.path();let metadata=fs::symlink_metadata(&path).map_err(|e|e.to_string())?;if !metadata.file_type().is_file()||path.canonicalize().map_err(|e|e.to_string())?.parent()!=Some(folder.as_path()){return Err("同步快照不是受控普通文件".into());}let hash=fingerprint(&path)?;if value.seen.get(&name)!=Some(&hash){changed|=super::backup::restore_sync_backup(state,&path)?;}seen.insert(name.clone(),hash);Ok::<_,String>(())})();if let Err(error)=imported{errors.push(error);}
    }
    super::backup::export_sync_backup(state,&folder.join(own_name))?;value.seen=seen;
    value.error=if errors.is_empty(){None}else{Some(format!("部分设备暂未合并：{}",errors.into_iter().take(3).collect::<Vec<_>>().join("；")))};Ok::<_,String>(changed)
  })();
  match &operation{Ok(_)=>{value.last_synced=Some(unix_time_millis());},Err(error)=>value.error=Some(error.clone())}save_config(state,&value)?;operation
}
pub fn start_podcast_sync(app:tauri::AppHandle,state:PodcastState){if state.ensure_ready().is_err(){return;}tauri::async_runtime::spawn(async move{loop{let owned=state.clone();if let Ok(Ok(changed))=tauri::async_runtime::spawn_blocking(move||sync_once(&owned)).await{if changed{let _=app.emit("podcast-library-changed",());}}tokio::time::sleep(Duration::from_secs(60)).await;}});}
#[tauri::command]
pub async fn podcast_sync_status(state:State<'_,PodcastState>)->Result<PodcastSyncStatus,String>{state.ensure_ready()?;Ok(status(config(&state.db_path)?))}
#[tauri::command]
pub async fn podcast_choose_sync_folder(state:State<'_,PodcastState>)->Result<PodcastSyncStatus,String>{state.ensure_ready()?;let owned=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{if let Some(folder)=rfd::FileDialog::new().set_title("选择播客共享同步目录").pick_folder(){let _lock=SYNC_LOCK.lock().map_err(|_|"同步任务锁无效")?;configure(&owned,&folder)?;}Ok(status(config(&owned.db_path)?))}).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn podcast_stop_sync(state:State<'_,PodcastState>)->Result<PodcastSyncStatus,String>{state.ensure_ready()?;let owned=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{let _lock=SYNC_LOCK.lock().map_err(|_|"同步任务锁无效")?;let mut value=config(&owned.db_path)?;value.folder=None;value.error=None;save_config(&owned,&value)?;Ok(status(value))}).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn podcast_sync_now(app:tauri::AppHandle,state:State<'_,PodcastState>)->Result<PodcastSyncStatus,String>{state.ensure_ready()?;let owned=state.inner().clone();let result=tauri::async_runtime::spawn_blocking(move||{let changed=sync_once(&owned)?;Ok::<_,String>((changed,status(config(&owned.db_path)?)))}).await.map_err(|e|e.to_string())??;if result.0{let _=app.emit("podcast-library-changed",());}Ok(result.1)}

#[cfg(test)]
mod tests{
  use super::*;use super::super::test_support::*;
  #[test]
  fn two_devices_merge_progress_and_unfollow_without_local_transport_or_downloads(){
    let dir=test_directory("sync-two-devices");let a=PodcastState::initialize_at(&dir.join("a")).unwrap();let b=PodcastState::initialize_at(&dir.join("b")).unwrap();let folder=dir.join("shared");fs::create_dir(&folder).unwrap();configure(&a,&folder).unwrap();configure(&b,&folder).unwrap();let parsed=parsed_fixture("https://example.com/audio.mp3");let feed=parsed.feed.id.clone();let episode=parsed.episodes[0].id.clone();store_subscription(&a.db_path,parsed).unwrap();
    open_database(&a.db_path).unwrap().execute("INSERT INTO podcast_progress VALUES(?1,60,300,0,100)",[&episode]).unwrap();sync_once(&a).unwrap();assert!(sync_once(&b).unwrap());assert_eq!(get_episode_detail(&b.db_path,&b.downloads_dir,&episode).unwrap().episode.progress_seconds,60.0);assert!(!sync_once(&b).unwrap());
    open_database(&b.db_path).unwrap().execute("UPDATE podcast_progress SET position_seconds=10,updated_at=200 WHERE episode_id=?1",[&episode]).unwrap();set_following(&b.db_path,&feed,false).unwrap();sync_once(&b).unwrap();assert!(sync_once(&a).unwrap());assert_eq!(get_episode_detail(&a.db_path,&a.downloads_dir,&episode).unwrap().episode.progress_seconds,10.0);let subscribed:i64=open_database(&a.db_path).unwrap().query_row("SELECT subscribed FROM podcast_feeds WHERE id=?1",[&feed],|r|r.get(0)).unwrap();assert_eq!(subscribed,0);assert!(list_queue(&a.db_path,&a.downloads_dir).unwrap().is_empty());assert!(fs::read_dir(&b.downloads_dir).unwrap().next().is_none());
    let snapshot=folder.join(format!("zone-podcast-sync-{}.zonepodcast",config(&a.db_path).unwrap().device));let json:serde_json::Value=serde_json::from_slice(&fs::read(snapshot).unwrap()).unwrap();assert!(json["settings"]["rows"].as_array().unwrap().is_empty());assert!(json["media"].as_object().unwrap().is_empty());
  }
  #[test]
  fn folder_failures_and_hostile_snapshots_preserve_local_data_and_pause_status(){
    let dir=test_directory("sync-hostile");let state=PodcastState::initialize_at(&dir.join("local")).unwrap();let folder=dir.join("shared");fs::create_dir(&folder).unwrap();configure(&state,&folder).unwrap();store_subscription(&state.db_path,parsed_fixture("https://example.com/audio.mp3")).unwrap();let peer=folder.join(format!("zone-podcast-sync-{}.zonepodcast","a".repeat(64)));fs::write(&peer,b"broken").unwrap();assert!(!sync_once(&state).unwrap());assert_eq!(list_feeds(&state.db_path).unwrap().len(),1);assert!(config(&state.db_path).unwrap().error.is_some());fs::remove_file(peer).unwrap();sync_once(&state).unwrap();assert!(config(&state.db_path).unwrap().error.is_none());fs::rename(&folder,dir.join("unavailable")).unwrap();assert!(sync_once(&state).is_err());assert_eq!(list_feeds(&state.db_path).unwrap().len(),1);
  }
}
