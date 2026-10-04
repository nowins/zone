use super::*;
use std::sync::OnceLock;
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
  pub token: String, pub file_name: String, pub created_at: Option<i64>,
  pub feeds: usize, pub episodes: usize, pub progress: usize, pub lists: usize,
  pub groups: usize, pub bookmarks: usize, pub audio_count: usize, pub audio_bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportResult { pub location_token: String, pub file_name: String, pub audio_count: usize }
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreCounts { pub merged_records: usize, pub retained_records: usize, pub audio_count: usize }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreResult { pub frontend: BTreeMap<String,String>, pub counts: BackupRestoreCounts }
struct PendingBackup { token: String, db: PathBuf, path: PathBuf, hash: String, expires: i64 }
struct BackupLocation { token: String, db: PathBuf, folder: PathBuf }
#[derive(Default)]
struct BackupChoices { pending: Vec<PendingBackup>, location: Option<BackupLocation> }
static CHOICES: OnceLock<Mutex<BackupChoices>> = OnceLock::new();
fn choices() -> &'static Mutex<BackupChoices> { CHOICES.get_or_init(||Mutex::new(BackupChoices::default())) }

fn verify_media(state:&PodcastState,path:&Path,backup:&PodcastBackup)->Result<u64,String> {
  let Some(name)=&backup.media_directory else { return if backup.media.is_empty(){Ok(0)}else{Err("备份音频目录缺失".into())}; };
  if !name.starts_with("zone-podcast-media-")||name.contains(['/', '\\'])||name.contains("..") {return Err("备份音频目录无效".into());}
  let parent=path.parent().ok_or("备份目录无效")?.canonicalize().map_err(|_|"备份目录不可访问")?;
  let media=parent.join(name).canonicalize().map_err(|_|"音频目录缺失，请与备份文件放在一起")?;
  if !media.starts_with(&parent){return Err("备份音频越过目录边界".into());}
  let mut total=0u64;
  for (id,item) in &backup.media {
    validate_identifier(id)?;
    if !is_managed_download_path(&state.downloads_dir,id,&state.downloads_dir.join(&item.name))||item.sha256.len()!=64 {return Err("备份音频标识无效".into());}
    let source=media.join(&item.name).canonicalize().map_err(|_|"备份音频缺失")?;
    if !source.starts_with(&media)||hash_file(&source)?!=(item.bytes,item.sha256.clone()){return Err("备份音频校验失败".into());}
    total=total.checked_add(item.bytes).ok_or("备份音频容量无效")?;
  }
  Ok(total)
}

pub(crate) fn create_backup_preview(state:&PodcastState,path:&Path)->Result<BackupPreview,String> {
  let path=path.canonicalize().map_err(|_|"备份文件不可访问")?;
  let (mut backup,hash)=read_backup_with_hash(&path)?;
  if backup.format!="ZonePodcastBackup"||backup.version!=1 {return Err("备份版本不支持".into());}
  validate_frontend(&backup.frontend)?;
  let audio_bytes=verify_media(state,&path,&backup)?;
  let rows=|table:&str|backup.tables.get(table).map_or(0,|data|data.rows.len());
  let token=super::super::lists::new_collection_id("backup-preview",&path.to_string_lossy());
  let preview=BackupPreview { token:token.clone(),file_name:path.file_name().unwrap_or_default().to_string_lossy().into(),created_at:backup.created_at,
    feeds:rows("podcast_feeds"),episodes:rows("podcast_episodes"),progress:rows("podcast_progress"),lists:rows("podcast_playlists"),groups:rows("podcast_show_groups"),bookmarks:rows("podcast_bookmarks"),audio_count:backup.media.len(),audio_bytes };
  // Validate in memory; preview must not write the user's database or audio files.
  let mut memory=Connection::open_in_memory().map_err(|e|e.to_string())?;
  crate::db::ensure_schema(&memory)?;
  memory.execute_batch("PRAGMA foreign_keys=ON").map_err(|e|e.to_string())?;
  let allowed=tables(&memory)?;
  if backup.tables.keys().any(|name|!allowed.contains(name)){return Err("备份包含不支持的资料表".into());}
  sanitize_download_records(&mut backup);
  let tx=memory.transaction().map_err(|e|e.to_string())?;
  tx.execute_batch("PRAGMA defer_foreign_keys=ON").map_err(|e|e.to_string())?;
  for (name,data) in &backup.tables {import_table(&tx,name,data)?;}
  import_table(&tx,"app_settings",&backup.settings)?;validate_restored_collections(&tx)?;
  let foreign:i64=tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check",[],|r|r.get(0)).map_err(|e|e.to_string())?;
  let queue:i64=tx.query_row("SELECT COUNT(*) FROM podcast_queue",[],|r|r.get(0)).map_err(|e|e.to_string())?;
  if foreign>0||queue>PODCAST_QUEUE_LIMIT as i64 {return Err("备份资料引用或待播数量无效".into());}
  tx.rollback().map_err(|e|e.to_string())?;
  let mut cache=choices().lock().map_err(|_|"无法保留备份预览")?;
  cache.pending.retain(|entry|entry.expires>unix_time_millis());
  if cache.pending.len()>=4 {cache.pending.remove(0);}
  cache.pending.push(PendingBackup{token,db:state.db_path.clone(),path,hash,expires:unix_time_millis()+600_000});
  Ok(preview)
}
pub(crate) fn confirm_backup_preview(state:&PodcastState,token:&str)->Result<BackupRestoreResult,String> {
  let (path,hash)={let cache=choices().lock().map_err(|_|"无法读取备份预览")?;
    let entry=cache.pending.iter().find(|entry|entry.token==token&&entry.db==state.db_path&&entry.expires>unix_time_millis()).ok_or("备份预览已过期，请重新选择")?;
    (entry.path.clone(),entry.hash.clone())};
  let (backup,current)=read_backup_with_hash(&path)?;
  if current!=hash {return Err("备份文件已变化，请重新选择后确认".into());}
  let (frontend,_,counts)=restore_backup_data(state,&path,backup,false)?;
  if let Ok(mut cache)=choices().lock(){cache.pending.retain(|entry|entry.token!=token);}
  Ok(BackupRestoreResult{frontend,counts})
}
pub(super) fn remember_backup_location(state:&PodcastState,path:&Path,audio_count:usize)->Result<BackupExportResult,String> {
  let folder=path.parent().ok_or("备份目录无效")?.canonicalize().map_err(|_|"备份目录不可访问")?;
  let token=super::super::lists::new_collection_id("backup-location",&folder.to_string_lossy());
  choices().lock().map_err(|_|"无法保留备份位置")?.location=Some(BackupLocation{token:token.clone(),db:state.db_path.clone(),folder});
  Ok(BackupExportResult{location_token:token,file_name:path.file_name().unwrap_or_default().to_string_lossy().into(),audio_count})
}
#[tauri::command]
pub async fn podcast_choose_restore_backup(state:State<'_,PodcastState>)->Result<Option<BackupPreview>,String> {
  state.ensure_ready()?;let state=state.inner().clone();
  tauri::async_runtime::spawn_blocking(move||{
    let folder=super::managed::managed_backup_directory(&state,true)?;
    let Some(path)=rfd::FileDialog::new().set_title("选择播客备份").set_directory(folder).add_filter("Zone 播客备份",&["zonepodcast"]).pick_file() else{return Ok(None);};
    create_backup_preview(&state,&path).map(Some)
  }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn podcast_confirm_restore_backup(app:tauri::AppHandle,state:State<'_,PodcastState>,token:String)->Result<BackupRestoreResult,String> {
  state.ensure_ready()?;let state=state.inner().clone();
  let result=tauri::async_runtime::spawn_blocking(move||confirm_backup_preview(&state,&token)).await.map_err(|e|e.to_string())??;
  let _=app.emit("podcast-library-changed",true);Ok(result)
}
#[tauri::command]
pub fn podcast_open_backup_folder(app:tauri::AppHandle,state:State<'_,PodcastState>,token:String)->Result<(),String> {
  state.ensure_ready()?;
  let folder={let cache=choices().lock().map_err(|_|"无法读取备份位置")?;let location=cache.location.as_ref().filter(|location|location.token==token&&location.db==state.db_path).ok_or("备份位置已失效，请重新备份")?;location.folder.clone()};
  if folder.canonicalize().map_err(|_|"备份目录不可访问")?!=folder{return Err("备份位置已变化".into());}
  app.opener().open_path(folder.to_string_lossy().into_owned(),None::<&str>).map_err(|_|"无法打开备份目录".into())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  #[test]
  fn preview_is_read_only_scoped_and_rejects_changed_files_before_confirming() {
    let dir=test_directory("backup-preview");let source=PodcastState::initialize_at(&dir.join("source")).unwrap();let target=PodcastState::initialize_at(&dir.join("target")).unwrap();
    let parsed=parsed_fixture("https://example.com/a.mp3");let id=parsed.episodes[0].id.clone();store_subscription(&source.db_path,parsed).unwrap();
    save_progress(&source.db_path,&id,30.0,100.0).unwrap();
    crate::podcast::bookmarks::add_bookmark(&source.db_path,&id,30.0,"预览书签").unwrap();
    let audio=source.downloads_dir.join(format!("{id}.mp3"));fs::write(&audio,b"audio").unwrap();mark_download_complete(&source.db_path,&id,&audio.to_string_lossy(),5,Some(5)).unwrap();
    let path=dir.join("snapshot.zonepodcast");export_backup(&source,&path,BTreeMap::new(),true).unwrap();let original=fs::read(&path).unwrap();
    let preview=create_backup_preview(&target,&path).unwrap();assert_eq!(preview.feeds,1);assert_eq!(preview.bookmarks,1);assert_eq!(preview.audio_count,1);assert_eq!(preview.audio_bytes,5);assert!(preview.created_at.is_some());
    assert!(list_feeds(&target.db_path).unwrap().is_empty());assert!(!target.downloads_dir.join(format!("{id}.mp3")).exists());
    assert!(confirm_backup_preview(&source,&preview.token).is_err());
    fs::write(&path,[original.as_slice(),b"\n"].concat()).unwrap();assert!(confirm_backup_preview(&target,&preview.token).is_err());assert!(list_feeds(&target.db_path).unwrap().is_empty());
    fs::write(&path,&original).unwrap();let result=confirm_backup_preview(&target,&preview.token).unwrap();assert!(result.counts.merged_records>0);assert_eq!(result.counts.audio_count,1);
    assert_eq!(fs::read(target.downloads_dir.join(format!("{id}.mp3"))).unwrap(),b"audio");assert!(confirm_backup_preview(&target,&preview.token).is_err());
  }
  #[test]
  fn legacy_preview_reports_unknown_date_and_rejects_unsafe_rows_without_mutation() {
    let dir=test_directory("legacy-backup-preview");let state=PodcastState::initialize_at(&dir.join("source")).unwrap();let parsed=parsed_fixture("https://example.com/a.mp3");store_subscription(&state.db_path,parsed).unwrap();
    let path=dir.join("snapshot.zonepodcast");export_backup(&state,&path,BTreeMap::new(),false).unwrap();let mut value:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();value.as_object_mut().unwrap().remove("created_at");fs::write(&path,serde_json::to_vec(&value).unwrap()).unwrap();
    let preview=create_backup_preview(&state,&path).unwrap();assert_eq!(preview.created_at,None);
    let table=&mut value["tables"]["podcast_feeds"];let column=table["columns"].as_array().unwrap().iter().position(|column|column=="feed_url").unwrap();table["rows"][0][column]=Value::from("http://127.0.0.1/rss");fs::write(&path,serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(create_backup_preview(&state,&path).is_err());assert_eq!(list_feeds(&state.db_path).unwrap().len(),1);
  }
}
