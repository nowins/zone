use super::*;
use rusqlite::{params,params_from_iter,types::Value as SqlValue,Connection,TransactionBehavior};
use serde::{Deserialize,Serialize};
use serde_json::Value;
use sha2::{Digest,Sha256};
use std::{collections::BTreeMap,io::{Read,Write}};
use tauri::{Emitter,State};

const MANIFEST_LIMIT:u64=64*1024*1024;
#[derive(Debug,Serialize,Deserialize)]
struct TableSnapshot {columns:Vec<String>,rows:Vec<Vec<Value>>}
#[derive(Debug,Serialize,Deserialize)]
struct MediaSnapshot {name:String,bytes:u64,sha256:String}
#[derive(Debug,Serialize,Deserialize)]
struct PodcastBackup {format:String,version:u32,tables:BTreeMap<String,TableSnapshot>,settings:TableSnapshot,frontend:BTreeMap<String,String>,media_directory:Option<String>,media:BTreeMap<String,MediaSnapshot>}

fn tables(db:&Connection)->Result<Vec<String>,String> {
  let mut q=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'podcast_%' ORDER BY name").map_err(|e|e.to_string())?;
  let result=q.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string());result
}
fn snapshot(db:&Connection,query:&str)->Result<TableSnapshot,String> {
  let mut q=db.prepare(query).map_err(|e|e.to_string())?;
  let columns=q.column_names().iter().map(|s|s.to_string()).collect::<Vec<_>>();
  let mut rows=Vec::new();let mut cursor=q.query([]).map_err(|e|e.to_string())?;
  while let Some(row)=cursor.next().map_err(|e|e.to_string())? {
    if rows.len()>=200_000 {return Err("播客资料过多，无法备份".into());}
    let mut values=Vec::new();
    for i in 0..columns.len() {values.push(match row.get::<_,SqlValue>(i).map_err(|e|e.to_string())? {
      SqlValue::Null=>Value::Null,SqlValue::Integer(n)=>Value::from(n),SqlValue::Real(n)=>Value::from(n),SqlValue::Text(s)=>Value::from(s),SqlValue::Blob(_)=>return Err("不支持的播客资料类型".into())
    });} rows.push(values);
  } Ok(TableSnapshot{columns,rows})
}
fn hash_file(path:&Path)->Result<(u64,String),String> {
  let size=fs::metadata(path).map_err(|e|e.to_string())?.len();
  if size>PODCAST_AUDIO_RESPONSE_LIMIT {return Err("备份音频过大".into());}
  let mut file=fs::File::open(path).map_err(|e|e.to_string())?;let mut hash=Sha256::new();let mut buffer=[0u8;64*1024];let mut bytes=0;
  loop {let n=file.read(&mut buffer).map_err(|e|e.to_string())?;if n==0 {break;}bytes+=n as u64;if bytes>PODCAST_AUDIO_RESPONSE_LIMIT {return Err("备份音频过大".into());}hash.update(&buffer[..n]);}
  Ok((bytes,format!("{:x}",hash.finalize())))
}
fn validate_frontend(frontend:&BTreeMap<String,String>)->Result<(),String> {
  if frontend.len()>32 || frontend.iter().any(|(k,v)|!k.starts_with("zone-podcast-")||k.len()>100||v.len()>512*1024) {return Err("播客界面设置无效".into());}Ok(())
}

struct CopiedFiles {files:Vec<PathBuf>,directories:Vec<PathBuf>,committed:bool}
impl Drop for CopiedFiles {fn drop(&mut self){if !self.committed {for path in &self.files {let _=fs::remove_file(path);}for path in self.directories.iter().rev(){let _=fs::remove_dir(path);}}}}
impl CopiedFiles {
  fn discard(&mut self,path:&Path)->Result<(),String>{if self.files.iter().any(|file|file==path){fs::remove_file(path).map_err(|e|e.to_string())?;self.files.retain(|file|file!=path);}Ok(())}
}
fn copy_verified(source:&Path,destination:&Path,bytes:u64,hash:&str,copied:&mut CopiedFiles)->Result<(),String> {
  let input=fs::File::open(source).map_err(|e|e.to_string())?;
  let mut output=fs::OpenOptions::new().create_new(true).write(true).open(destination).map_err(|e|e.to_string())?;
  copied.files.push(destination.to_path_buf());
  let copied=std::io::copy(&mut input.take(bytes.saturating_add(1)),&mut output).map_err(|e|e.to_string())?;
  output.sync_all().map_err(|e|e.to_string())?;drop(output);
  if copied!=bytes||hash_file(destination)?!=(bytes,hash.to_string()){return Err("备份音频校验失败".into());}Ok(())
}

pub(crate) fn export_backup(state:&PodcastState,path:&Path,frontend:BTreeMap<String,String>,include_audio:bool)->Result<(),String> {
  validate_frontend(&frontend)?;
  let mut copied=CopiedFiles{files:vec![],directories:vec![],committed:false};
  let mut db=open_database(&state.db_path)?;let tx=db.transaction().map_err(|e|e.to_string())?;
  let mut saved=BTreeMap::new();for table in tables(&tx)? {saved.insert(table.clone(),snapshot(&tx,&format!("SELECT * FROM \"{table}\""))?);}
  let settings=snapshot(&tx,"SELECT * FROM app_settings WHERE key LIKE 'podcast.%'")?;
  let mut backup=PodcastBackup{format:"ZonePodcastBackup".into(),version:1,tables:saved,settings,frontend,media_directory:None,media:BTreeMap::new()};
  let mut sources=Vec::new();
  if let Some(downloads)=backup.tables.get_mut("podcast_downloads") {
    let id=downloads.columns.iter().position(|s|s=="episode_id").ok_or("下载表无效")?;
    let local=downloads.columns.iter().position(|s|s=="local_path").ok_or("下载表无效")?;
    let status=downloads.columns.iter().position(|s|s=="state").ok_or("下载表无效")?;
    let resume=downloads.columns.iter().position(|s|s=="resume_metadata");
    for row in &mut downloads.rows {
      let episode=row[id].as_str().ok_or("单集标识无效")?.to_string();validate_identifier(&episode)?;
      if include_audio && row[status]=="downloaded" {if let Some(local)=row[local].as_str() {
        let source=PathBuf::from(local);
        if !is_managed_download_path(&state.downloads_dir,&episode,&source) {return Err("下载文件不在受控目录".into());}
        sources.push((episode,source));
      }}
      row[local]=Value::Null;row[status]=Value::from("failed");if let Some(i)=resume {row[i]=Value::Null;}
    }
  }
  let ids=sources.iter().map(|(id,_)|id.clone()).collect::<Vec<_>>();let _guards=EpisodeFileGuard::acquire_many(&state.active_downloads,&ids)?;
  if !sources.is_empty() {
    let name=format!("zone-podcast-media-{}",unix_time_millis());let media=path.parent().ok_or("备份目录无效")?.join(&name);
    fs::create_dir(&media).map_err(|e|e.to_string())?;copied.directories.push(media.clone());backup.media_directory=Some(name);
    for (id,source) in sources {
      let name=source.file_name().and_then(|n|n.to_str()).ok_or("下载文件名无效")?.to_string();
      let (bytes,sha256)=hash_file(&source)?;copy_verified(&source,&media.join(&name),bytes,&sha256,&mut copied)?;
      backup.media.insert(id,MediaSnapshot{name,bytes,sha256});
    }
  }
  let json=serde_json::to_vec(&backup).map_err(|e|e.to_string())?;if json.len() as u64>MANIFEST_LIMIT {return Err("备份资料过大".into());}
  let temporary=path.with_extension(format!("partial-{}",unix_time_millis()));
  let mut file=fs::OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|e|e.to_string())?;
  copied.files.push(temporary.clone());
  file.write_all(&json).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;drop(file);
  fs::rename(&temporary,path).map_err(|e|format!("无法保存备份：{e}"))?;copied.committed=true;Ok(())
}

fn sql_value(value:&Value)->Result<SqlValue,String> {
  match value {Value::Null=>Ok(SqlValue::Null),Value::String(s)=>Ok(SqlValue::Text(s.clone())),Value::Number(n)=>{
    if let Some(n)=n.as_i64() {Ok(SqlValue::Integer(n))} else {n.as_f64().filter(|n|n.is_finite()).map(SqlValue::Real).ok_or_else(||"备份数字无效".into())}
  },_=>Err("备份字段类型无效".into())}
}
fn import_table(db:&Connection,name:&str,data:&TableSnapshot)->Result<(),String> {
  let expected=snapshot(db,&format!("SELECT * FROM \"{name}\" LIMIT 0"))?.columns;
  if data.columns.is_empty()||data.columns.len()>expected.len()||data.rows.len()>200_000||data.columns.iter().any(|c|!expected.contains(c))||data.columns.iter().collect::<HashSet<_>>().len()!=data.columns.len() {return Err("备份表结构不兼容".into());}
  let quoted=data.columns.iter().map(|c|format!("\"{c}\"")).collect::<Vec<_>>().join(",");let placeholders=vec!["?";data.columns.len()].join(",");
  let suffix=if name=="podcast_progress" {" ON CONFLICT(episode_id) DO UPDATE SET position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,completed=excluded.completed,updated_at=excluded.updated_at WHERE excluded.updated_at>podcast_progress.updated_at"}else if name=="app_settings" {" ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at WHERE excluded.updated_at>app_settings.updated_at"}else{" ON CONFLICT DO NOTHING"};
  let mut q=db.prepare(&format!("INSERT INTO \"{name}\" ({quoted}) VALUES ({placeholders}){suffix}")).map_err(|e|e.to_string())?;
  for row in &data.rows {
    if row.len()!=data.columns.len() {return Err("备份行结构无效".into());}
    for (column,value) in data.columns.iter().zip(row) {
      if name=="app_settings" && column=="key" && !value.as_str().is_some_and(|key|key.starts_with("podcast.")) {return Err("备份包含其他类别设置".into());}
      if name.starts_with("podcast_") && (column=="id" || ["episode_id","feed_id","playlist_id","group_id","resource_id"].contains(&column.as_str())) {validate_identifier(value.as_str().ok_or("备份标识无效")?)?;}
      if ["podcast_playlists","podcast_show_groups"].contains(&name)&&column=="name"{super::lists::collection_name(value.as_str().ok_or("备份名称无效")?)?;}
      if name=="podcast_playlists"&&column=="rules_json"{let rules:super::lists::PlaylistRules=serde_json::from_str(value.as_str().ok_or("备份条件无效")?).map_err(|_|"备份条件无效")?;super::lists::validate_rules(&rules)?;}
      if name=="podcast_bookmarks"&&column=="position_ms"&& !value.as_i64().is_some_and(|n|(0..=604800000).contains(&n)){return Err("备份书签时间无效".into());}
      if name=="podcast_bookmarks"&&column=="label"&& !value.as_str().is_some_and(|s|s.chars().count()<=200&&!s.chars().any(char::is_control)){return Err("备份书签备注无效".into());}
      if ["feed_url","enclosure_url"].contains(&column.as_str()) {validate_public_url_shape(value.as_str().ok_or("备份地址无效")?)?;}
    }
    let values=row.iter().map(sql_value).collect::<Result<Vec<_>,_>>()?;q.execute(params_from_iter(values)).map_err(|e|format!("无法恢复播客资料：{e}"))?;
  }Ok(())
}

fn validate_restored_collections(db:&Connection)->Result<(),String>{
  for (table,limit) in [("podcast_playlists",100),("podcast_show_groups",100),("podcast_bookmarks",10000)]{let count:i64=db.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get(0)).map_err(|e|e.to_string())?;if count>limit{return Err("恢复后的播客集合超过上限".into());}}
  for (table,key,limit) in [("podcast_playlist_items","playlist_id",500),("podcast_show_group_members","group_id",500),("podcast_bookmarks","episode_id",100)]{let exceeds:bool=db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} GROUP BY {key} HAVING COUNT(*)>?1)"),[limit],|r|r.get(0)).map_err(|e|e.to_string())?;if exceeds{return Err("恢复后的集合成员超过上限".into());}}
  let mut q=db.prepare("SELECT value_json FROM app_settings WHERE key LIKE 'podcast.preferences.%'").map_err(|e|e.to_string())?;
  let values=q.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
  for value in values{let preferences:PodcastPreferences=serde_json::from_str(&value.map_err(|e|e.to_string())?).map_err(|_|"备份播放偏好无效")?;validate_preferences(&preferences)?;}
  Ok(())
}

pub(crate) fn restore_backup(state:&PodcastState,path:&Path)->Result<BTreeMap<String,String>,String> {
  if fs::metadata(path).map_err(|e|e.to_string())?.len()>MANIFEST_LIMIT {return Err("备份文件过大".into());}
  let mut backup:PodcastBackup=serde_json::from_slice(&fs::read(path).map_err(|e|e.to_string())?).map_err(|_|"备份格式无效")?;
  if backup.format!="ZonePodcastBackup"||backup.version!=1 {return Err("备份版本不支持".into());}validate_frontend(&backup.frontend)?;
  let mut db=open_database(&state.db_path)?;let allowed=tables(&db)?;
  if backup.tables.keys().any(|name|!allowed.contains(name)) {return Err("备份包含不支持的资料表".into());}
  let ids=backup.media.keys().cloned().collect::<Vec<_>>();for id in &ids {validate_identifier(id)?;}
  let _guards=EpisodeFileGuard::acquire_many(&state.active_downloads,&ids)?;
  let mut copied=CopiedFiles{files:Vec::new(),directories:vec![],committed:false};let mut restored_media=BTreeMap::new();
  if let Some(name)=&backup.media_directory {
    if !name.starts_with("zone-podcast-media-")||name.contains(['/', '\\'])||name.contains("..") {return Err("备份音频目录无效".into());}
    let parent=path.parent().ok_or("备份目录无效")?.canonicalize().map_err(|e|e.to_string())?;
    let media=parent.join(name).canonicalize().map_err(|e|e.to_string())?;if !media.starts_with(&parent) {return Err("备份音频越过目录边界".into());}
    for (id,item) in &backup.media {
      let destination=state.downloads_dir.join(&item.name);
      if !is_managed_download_path(&state.downloads_dir,id,&destination)||item.sha256.len()!=64 {return Err("备份音频标识无效".into());}
      let source=media.join(&item.name).canonicalize().map_err(|e|e.to_string())?;if !source.starts_with(&media) {return Err("备份音频越过目录边界".into());}
      let (bytes,hash)=hash_file(&source)?;if bytes!=item.bytes||hash!=item.sha256 {return Err("备份音频校验失败".into());}
      if !destination.exists() {copy_verified(&source,&destination,bytes,&hash,&mut copied)?;restored_media.insert(id.clone(),destination);}
      else if hash_file(&destination)?==(bytes,hash) {restored_media.insert(id.clone(),destination);}
    }
  } else if !backup.media.is_empty() {return Err("备份音频目录缺失".into());}
  // Imported paths and interrupted requests can never grant file/network access.
  if let Some(downloads)=backup.tables.get_mut("podcast_downloads") {
    for row in &mut downloads.rows {
      for field in ["local_path","resume_metadata"] {if let Some(i)=downloads.columns.iter().position(|c|c==field) {if let Some(value)=row.get_mut(i){*value=Value::Null;}}}
      if let Some(i)=downloads.columns.iter().position(|c|c=="state") {if let Some(value)=row.get_mut(i){*value=Value::from("failed");}}
    }
  }
  if let Some(jobs)=backup.tables.get_mut("podcast_download_jobs") {
    for row in &mut jobs.rows {for (i,c) in jobs.columns.iter().enumerate(){if let Some(value)=row.get_mut(i){if c=="request_id" {*value=Value::Null;}if c=="state"&&*value!="complete" {*value=Value::from("paused");}}}}
  }
  let result=(||{
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    tx.execute_batch("PRAGMA defer_foreign_keys=ON").map_err(|e|e.to_string())?;
    for (name,table) in &backup.tables {import_table(&tx,name,table)?;}
    import_table(&tx,"app_settings",&backup.settings)?;
    validate_restored_collections(&tx)?;
    for (id,path) in restored_media {
      let original=backup.tables.get("podcast_episodes").and_then(|t| {
        let id_col=t.columns.iter().position(|c|c=="id")?;let url_col=t.columns.iter().position(|c|c=="enclosure_url")?;
        t.rows.iter().find(|row|row.get(id_col).and_then(Value::as_str)==Some(&id)).and_then(|row|row.get(url_col)).and_then(Value::as_str)
      });
      let current:String=tx.query_row("SELECT enclosure_url FROM podcast_episodes WHERE id=?1",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
      if original!=Some(current.as_str()) {copied.discard(&path)?;continue;}
      let bytes=fs::metadata(&path).map_err(|e|e.to_string())?.len() as i64;
      tx.execute("UPDATE podcast_downloads SET local_path=?2,state='downloaded',downloaded_bytes=?3,total_bytes=?3,error_message=NULL,resume_metadata=NULL WHERE episode_id=?1 AND (state<>'downloaded' OR local_path=?2)",params![id,path.to_string_lossy(),bytes]).map_err(|e|e.to_string())?;
      let referenced:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM podcast_downloads WHERE episode_id=?1 AND local_path=?2 AND state='downloaded')",params![id,path.to_string_lossy()],|r|r.get(0)).map_err(|e|e.to_string())?;if !referenced{copied.discard(&path)?;}
    }
    let mut q=tx.prepare("SELECT episode_id FROM podcast_queue ORDER BY position,added_at,episode_id").map_err(|e|e.to_string())?;
    let queue=q.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;drop(q);
    if queue.len()>PODCAST_QUEUE_LIMIT {return Err("恢复后的待播队列过大".into());}
    for (position,id) in queue.iter().enumerate() {tx.execute("UPDATE podcast_queue SET position=?2 WHERE episode_id=?1",params![id,position as i64]).map_err(|e|e.to_string())?;}
    tx.commit().map_err(|e|e.to_string())?;Ok::<_,String>(())
  })();
  result?;copied.committed=true;
  Ok(backup.frontend)
}

#[tauri::command]
pub async fn podcast_export_backup(state:State<'_,PodcastState>,frontend_settings:BTreeMap<String,String>,include_audio:bool)->Result<bool,String> {
  state.ensure_ready()?;let state=state.inner().clone();
  tauri::async_runtime::spawn_blocking(move||{
    let Some(path)=rfd::FileDialog::new().set_title("备份播客资料").set_file_name("Zone播客备份.zonepodcast").add_filter("Zone 播客备份",&["zonepodcast"]).save_file() else {return Ok(false);};
    export_backup(&state,&path,frontend_settings,include_audio)?;Ok(true)
  }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn podcast_restore_backup(app:tauri::AppHandle,state:State<'_,PodcastState>)->Result<Option<BTreeMap<String,String>>,String> {
  state.ensure_ready()?;let state=state.inner().clone();
  let restored=tauri::async_runtime::spawn_blocking(move||{
    let Some(path)=rfd::FileDialog::new().set_title("恢复播客资料").add_filter("Zone 播客备份",&["zonepodcast"]).pick_file() else {return Ok(None);};
    restore_backup(&state,&path).map(Some)
  }).await.map_err(|e|e.to_string())??;
  if restored.is_some(){let _=app.emit("podcast-library-changed",true);}Ok(restored)
}

#[cfg(test)]
mod tests {
  use super::*;use crate::podcast::test_support::*;
  #[test]
  fn backup_restores_progress_queue_preferences_and_offline_audio_without_music_changes() {
    let dir=test_directory("backup-source");let source=PodcastState::initialize_at(&dir).unwrap();let parsed=parsed_fixture("https://example.com/a.mp3");let id=parsed.episodes[0].id.clone();store_subscription(&source.db_path,parsed).unwrap();
    let audio=source.downloads_dir.join(format!("{id}.mp3"));fs::write(&audio,b"ID3 audio").unwrap();mark_download_complete(&source.db_path,&id,&audio.to_string_lossy(),9,Some(9)).unwrap();
    open_database(&source.db_path).unwrap().execute("INSERT INTO podcast_progress VALUES (?1,90,300,0,50)",[&id]).unwrap();
    open_database(&source.db_path).unwrap().execute("INSERT INTO podcast_queue VALUES (?1,0,1)",[&id]).unwrap();
    write_preferences(&source.db_path,None,&PodcastPreferences{storage_limit_mb:1024,..Default::default()}).unwrap();
    super::super::bookmarks::add_bookmark(&source.db_path,&id,30.0,"备份书签").unwrap();
    super::super::groups::save_show_group(&source.db_path,None,"备份分组",&[get_episode_detail(&source.db_path,&source.downloads_dir,&id).unwrap().feed.id],None).unwrap();
    super::super::lists::save_playlist(&source.db_path,None,"备份智能列表","smart",super::super::lists::PlaylistRules::default(),None).unwrap();
    let path=dir.join("backup.zonepodcast");export_backup(&source,&path,BTreeMap::new(),true).unwrap();
    let other=test_directory("backup-target");let target=PodcastState::initialize_at(&other).unwrap();open_database(&target.db_path).unwrap().execute("INSERT INTO app_settings VALUES ('music.fixture','42',1)",[]).unwrap();
    restore_backup(&target,&path).unwrap();let detail=get_episode_detail(&target.db_path,&target.downloads_dir,&id).unwrap();assert_eq!(detail.episode.progress_seconds,90.0);assert_eq!(detail.episode.download_state,"downloaded");assert_eq!(list_download_jobs(&target.db_path).unwrap().len(),0);
    assert_eq!(read_preferences(&target.db_path,None).unwrap().storage_limit_mb,1024);
    assert_eq!(super::super::bookmarks::list_bookmarks(&target.db_path,&id).unwrap()[0].label,"备份书签");
    assert_eq!(super::super::groups::show_groups(&target.db_path).unwrap()[0].name,"备份分组");
    let music:String=open_database(&target.db_path).unwrap().query_row("SELECT value_json FROM app_settings WHERE key='music.fixture'",[],|r|r.get(0)).unwrap();assert_eq!(music,"42");
  }
  #[test]
  fn corrupt_or_foreign_backup_rolls_back_and_preserves_original_progress() {
    let dir=test_directory("backup-corrupt");let state=PodcastState::initialize_at(&dir).unwrap();let parsed=parsed_fixture("https://example.com/a.mp3");let id=parsed.episodes[0].id.clone();store_subscription(&state.db_path,parsed).unwrap();
    let path=dir.join("backup.zonepodcast");export_backup(&state,&path,BTreeMap::new(),false).unwrap();let mut data:PodcastBackup=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    data.settings.rows.push(vec![Value::from("music.foreign"),Value::from("42"),Value::from(1)]);fs::write(&path,serde_json::to_vec(&data).unwrap()).unwrap();
    assert!(restore_backup(&state,&path).is_err());assert!(get_episode_detail(&state.db_path,&state.downloads_dir,&id).is_ok());
    data.settings.rows.clear();data.media_directory=Some("../../outside".into());fs::write(&path,serde_json::to_vec(&data).unwrap()).unwrap();assert!(restore_backup(&state,&path).is_err());
  }
  #[test]
  fn media_is_removed_on_restore_failure_or_source_mismatch_and_export_failure() {
    let dir=test_directory("backup-media-rollback");let source=PodcastState::initialize_at(&dir).unwrap();let parsed=parsed_fixture("https://example.com/a.mp3");let id=parsed.episodes[0].id.clone();store_subscription(&source.db_path,parsed.clone()).unwrap();
    let audio=source.downloads_dir.join(format!("{id}.mp3"));fs::write(&audio,b"ID3 audio").unwrap();mark_download_complete(&source.db_path,&id,&audio.to_string_lossy(),9,Some(9)).unwrap();
    let path=dir.join("backup.zonepodcast");export_backup(&source,&path,BTreeMap::new(),true).unwrap();let good=fs::read(&path).unwrap();let mut backup:PodcastBackup=serde_json::from_slice(&good).unwrap();
    let other=test_directory("backup-media-target");let target=PodcastState::initialize_at(&other).unwrap();
    backup.settings.rows.push(vec![Value::from("music.foreign"),Value::from("42"),Value::from(1)]);fs::write(&path,serde_json::to_vec(&backup).unwrap()).unwrap();
    assert!(restore_backup(&target,&path).is_err());assert_eq!(fs::read_dir(&target.downloads_dir).unwrap().count(),0);assert!(list_feeds(&target.db_path).unwrap().is_empty());
    fs::write(&path,&good).unwrap();let mut changed=parsed;changed.episodes[0].enclosure_url="https://example.com/b.mp3".into();store_subscription(&target.db_path,changed).unwrap();restore_backup(&target,&path).unwrap();assert_eq!(fs::read_dir(&target.downloads_dir).unwrap().count(),0);
    // A user-selected destination that is a directory makes rename fail after copying.
    let destination=dir.join("blocked.zonepodcast");fs::create_dir(&destination).unwrap();let before=fs::read_dir(&dir).unwrap().count();assert!(export_backup(&source,&destination,BTreeMap::new(),true).is_err());assert_eq!(fs::read_dir(&dir).unwrap().count(),before);
    let backup:PodcastBackup=serde_json::from_slice(&good).unwrap();fs::write(dir.join(backup.media_directory.unwrap()).join(format!("{id}.mp3")),b"damaged").unwrap();assert!(restore_backup(&target,&path).is_err());assert_eq!(fs::read_dir(&target.downloads_dir).unwrap().count(),0);
  }
  #[test]
  fn malformed_playlist_rules_roll_back_the_complete_restore() {
    let dir=test_directory("backup-invalid-list");let source=PodcastState::initialize_at(&dir).unwrap();store_subscription(&source.db_path,parsed_fixture("https://example.com/a.mp3")).unwrap();super::super::lists::save_playlist(&source.db_path,None,"条件","smart",super::super::lists::PlaylistRules::default(),None).unwrap();
    let path=dir.join("backup.zonepodcast");export_backup(&source,&path,BTreeMap::new(),false).unwrap();let mut backup:PodcastBackup=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();let lists=backup.tables.get_mut("podcast_playlists").unwrap();let column=lists.columns.iter().position(|name|name=="rules_json").unwrap();lists.rows[0][column]=Value::from(r#"{"filter":"injected","sort":"newest"}"#);fs::write(&path,serde_json::to_vec(&backup).unwrap()).unwrap();
    let target_dir=test_directory("backup-invalid-list-target");let target=PodcastState::initialize_at(&target_dir).unwrap();assert!(restore_backup(&target,&path).is_err());assert!(list_feeds(&target.db_path).unwrap().is_empty());
  }
}
