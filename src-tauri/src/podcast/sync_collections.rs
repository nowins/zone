use super::*;
use rusqlite::{Connection,params,OptionalExtension};
use serde::{Serialize,Deserialize};
use serde_json::Value;
use std::collections::BTreeMap;
use sha2::{Digest,Sha256};

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct SyncedEntity {pub kind:String,pub id:String,pub version:i64,pub deleted:bool,pub tables:BTreeMap<String,super::backup::TableSnapshot>}

pub(crate) fn ensure_collection_sync_schema(db:&Connection)->Result<(),String> {
  db.execute_batch("CREATE TABLE IF NOT EXISTS podcast_sync_control(id INTEGER PRIMARY KEY CHECK(id=1),importing INTEGER NOT NULL DEFAULT 0);INSERT OR IGNORE INTO podcast_sync_control VALUES(1,0);
    CREATE TABLE IF NOT EXISTS podcast_sync_versions(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id));").map_err(|e|e.to_string())?;
  for (kind,table,column) in [("saved","podcast_saved_episodes","episode_id"),("bookmark","podcast_bookmarks","id"),("playlist","podcast_playlists","id"),("group","podcast_show_groups","id"),("preferences","app_settings","key")] {
    for (action,row,deleted) in [("INSERT","NEW",0),("UPDATE","NEW",0),("DELETE","OLD",1)] {
      let scope=if kind=="preferences"{format!(" AND ({row}.key='podcast.preferences.global.v1' OR {row}.key LIKE 'podcast.preferences.feed.%')")}else{String::new()};
      db.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS podcast_sync_{kind}_{action} AFTER {action} ON {table} WHEN (SELECT importing FROM podcast_sync_control WHERE id=1)=0{scope} BEGIN
        INSERT INTO podcast_sync_versions(kind,id,version,deleted) VALUES('{kind}',{row}.{column},CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),{deleted})
        ON CONFLICT(kind,id) DO UPDATE SET version=MAX(excluded.version,podcast_sync_versions.version+1),deleted=excluded.deleted;END;")).map_err(|e|e.to_string())?;
    }
  }
  for (kind,table,column,parent) in [("playlist","podcast_playlist_items","playlist_id","podcast_playlists"),("group","podcast_show_group_members","group_id","podcast_show_groups")] {
    for (action,row) in [("INSERT","NEW"),("UPDATE","NEW"),("DELETE","OLD")] {
      db.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS podcast_sync_{kind}_members_{action} AFTER {action} ON {table} WHEN (SELECT importing FROM podcast_sync_control WHERE id=1)=0 AND EXISTS(SELECT 1 FROM {parent} WHERE id={row}.{column}) BEGIN
        INSERT INTO podcast_sync_versions(kind,id,version,deleted) VALUES('{kind}',{row}.{column},CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0)
        ON CONFLICT(kind,id) DO UPDATE SET version=MAX(excluded.version,podcast_sync_versions.version+1),deleted=0;END;")).map_err(|e|e.to_string())?;
    }
  }
  Ok(())
}

pub(crate) fn bootstrap_collection_versions(db:&Connection)->Result<(),String> {
  for (kind,table,column,version,scope) in [("saved","podcast_saved_episodes","episode_id","saved_at","1"),("bookmark","podcast_bookmarks","id","updated_at","1"),("playlist","podcast_playlists","id","updated_at","1"),("group","podcast_show_groups","id","updated_at","1"),("preferences","app_settings","key","updated_at","key='podcast.preferences.global.v1' OR key LIKE 'podcast.preferences.feed.%'")] {
    db.execute_batch(&format!("INSERT OR IGNORE INTO podcast_sync_versions(kind,id,version,deleted) SELECT '{kind}',{column},{version},0 FROM {table} WHERE {scope};")).map_err(|e|e.to_string())?;
  }
  Ok(())
}

fn entity_tables(db:&Connection,kind:&str,id:&str,version:i64,deleted:bool)->Result<BTreeMap<String,super::backup::TableSnapshot>,String> {
  let mut result=BTreeMap::new();if deleted {return Ok(result);}
  let (table,column)=match kind {"saved"=>("podcast_saved_episodes","episode_id"),"bookmark"=>("podcast_bookmarks","id"),"playlist"=>("podcast_playlists","id"),"group"=>("podcast_show_groups","id"),"preferences"=>("app_settings","key"),_=>return Err("同步资料类别无效".into())};
  let mut data=super::backup::snapshot_parameter(db,&format!("SELECT * FROM {table} WHERE {column}=?1"),id)?;
  if let Some(index)=data.columns.iter().position(|c|c=="updated_at") {for row in &mut data.rows {row[index]=Value::from(version);}}
  if kind=="preferences" {
    let index=data.columns.iter().position(|c|c=="value_json").ok_or("同步偏好无效")?;
    for row in &mut data.rows {
      let value:PodcastPreferences=serde_json::from_str(row[index].as_str().ok_or("同步偏好无效")?).map_err(|_|"同步偏好无效")?;
      let mut json=serde_json::to_value(value).map_err(|e|e.to_string())?;
      for key in ["autoDownloadCount","cleanupPlayed","storageLimitMb","notifyNewEpisodes"] {json.as_object_mut().unwrap().remove(key);}
      row[index]=Value::from(json.to_string());
    }
  }
  result.insert(table.into(),data);
  if kind=="playlist" {result.insert("podcast_playlist_items".into(),super::backup::snapshot_parameter(db,"SELECT * FROM podcast_playlist_items WHERE playlist_id=?1 ORDER BY position,episode_id",id)?);}
  if kind=="group" {result.insert("podcast_show_group_members".into(),super::backup::snapshot_parameter(db,"SELECT * FROM podcast_show_group_members WHERE group_id=?1 ORDER BY feed_id",id)?);}
  Ok(result)
}

pub(crate) fn collection_sync_snapshot(db:&Connection)->Result<Vec<SyncedEntity>,String> {
  let mut q=db.prepare("SELECT kind,id,version,deleted FROM podcast_sync_versions ORDER BY kind,id LIMIT 25001").map_err(|e|e.to_string())?;
  let versions=q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,bool>(3)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
  if versions.len()>25000 {return Err("播客同步资料过多".into());}
  versions.into_iter().map(|(kind,id,version,deleted)|Ok(SyncedEntity{tables:entity_tables(db,&kind,&id,version,deleted)?,kind,id,version,deleted})).collect()
}

fn digest(tables:&BTreeMap<String,super::backup::TableSnapshot>,deleted:bool)->Result<String,String>{Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&(deleted,tables)).map_err(|e|e.to_string())?)))}

pub(crate) fn merge_collection_entities(db:&Connection,entities:&[SyncedEntity])->Result<(),String> {
  if entities.len()>25000 {return Err("同步资料过多".into());}
  let mut seen=HashSet::new();
  for entity in entities {
    if !seen.insert((&entity.kind,&entity.id)) || !(0..=253402300799000).contains(&entity.version) {return Err("同步资料标识或版本无效".into());}
    let (table,column,children)=match entity.kind.as_str(){"saved"=>("podcast_saved_episodes","episode_id",None),"bookmark"=>("podcast_bookmarks","id",None),"playlist"=>("podcast_playlists","id",Some(("podcast_playlist_items","playlist_id"))),"group"=>("podcast_show_groups","id",Some(("podcast_show_group_members","group_id"))),"preferences"=>("app_settings","key",None),_=>return Err("同步资料类别无效".into())};
    if entity.kind=="preferences" {if entity.id!="podcast.preferences.global.v1" {let id=entity.id.strip_prefix("podcast.preferences.feed.").ok_or("同步偏好范围无效")?;validate_identifier(id)?;}}else{validate_identifier(&entity.id)?;}
    if entity.deleted&&!entity.tables.is_empty() {return Err("同步删除记录包含资料".into());}
    if !entity.deleted {
      let allowed=if let Some((child,_))=children{vec![table,child]}else{vec![table]};
      if entity.tables.len()!=allowed.len()||entity.tables.keys().any(|t|!allowed.contains(&t.as_str())) {return Err("同步资料表范围无效".into());}
      for (name,data) in &entity.tables {
        let expected=super::backup::snapshot_parameter(db,&format!("SELECT * FROM {name} WHERE ?1 IS NULL AND 0"),&entity.id)?;
        if data.columns.is_empty()||data.columns.iter().collect::<HashSet<_>>().len()!=data.columns.len()||data.columns.iter().any(|c|!expected.columns.contains(c))||data.rows.iter().any(|row|row.len()!=data.columns.len()){return Err("同步资料行结构无效".into());}
        let key=if name==table {column}else{children.unwrap().1};let index=data.columns.iter().position(|c|c==key).ok_or("同步资料字段缺失")?;
        if (name==table&&data.rows.len()!=1)||data.rows.len()>5000||data.rows.iter().any(|row|row.get(index).and_then(Value::as_str)!=Some(&entity.id)) {return Err("同步资料引用无效".into());}
      }
    }
    let current:Option<(i64,bool)>=db.query_row("SELECT version,deleted FROM podcast_sync_versions WHERE kind=?1 AND id=?2",params![entity.kind,entity.id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
    if let Some((version,deleted))=current {
      if entity.version<version {continue;}
      if entity.version==version {
        // Deletion wins equal-time conflicts; otherwise canonical payload hash
        // gives all devices the same deterministic tie breaker.
        if deleted&&!entity.deleted {continue;}
        if entity.deleted==deleted&&digest(&entity.tables,entity.deleted)?<=digest(&entity_tables(db,&entity.kind,&entity.id,version,deleted)?,deleted)? {continue;}
      }
    }
    if entity.kind=="bookmark"&&!entity.deleted {
      let data=entity.tables.get("podcast_bookmarks").unwrap();let row=&data.rows[0];
      let episode=row[data.columns.iter().position(|c|c=="episode_id").ok_or("同步书签字段缺失")?].as_str().ok_or("同步书签单集无效")?;
      let position=row[data.columns.iter().position(|c|c=="position_ms").ok_or("同步书签字段缺失")?].as_i64().ok_or("同步书签时间无效")?;
      let duplicate:Option<(String,i64)>=db.query_row("SELECT b.id,COALESCE(v.version,b.updated_at) FROM podcast_bookmarks b LEFT JOIN podcast_sync_versions v ON v.kind='bookmark' AND v.id=b.id WHERE b.episode_id=?1 AND b.position_ms=?2 AND b.id<>?3",params![episode,position,entity.id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
      if let Some((other,version))=duplicate {
        let incoming_wins=(entity.version,entity.id.as_str())>(version,other.as_str());
        let loser=if incoming_wins{&other}else{&entity.id};let winning_version=version.max(entity.version);
        db.execute("INSERT INTO podcast_sync_versions(kind,id,version,deleted) VALUES('bookmark',?1,?2,1) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,deleted=1",params![loser,winning_version]).map_err(|e|e.to_string())?;
        if !incoming_wins {continue;}
        db.execute("DELETE FROM podcast_bookmarks WHERE id=?1",[other]).map_err(|e|e.to_string())?;
      }
    }
    if entity.kind=="preferences" {
      let incoming:PodcastPreferences=if entity.deleted {PodcastPreferences::default()}else{
        let data=entity.tables.get("app_settings").unwrap();let json=data.columns.iter().position(|c|c=="value_json").ok_or("同步偏好字段缺失")?;
        serde_json::from_str(data.rows[0][json].as_str().ok_or("同步偏好无效")?).map_err(|_|"同步偏好无效")?
      };validate_preferences(&incoming)?;
      let feed=entity.id.strip_prefix("podcast.preferences.feed.");let local=read_preferences_in(db,feed)?;
      let merged=PodcastPreferences{auto_download_count:local.auto_download_count,cleanup_played:local.cleanup_played,storage_limit_mb:local.storage_limit_mb,notify_new_episodes:local.notify_new_episodes,..incoming};
      db.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",params![entity.id,serde_json::to_string(&merged).map_err(|e|e.to_string())?,entity.version]).map_err(|e|e.to_string())?;
    } else {
      db.execute(&format!("DELETE FROM {table} WHERE {column}=?1"),[&entity.id]).map_err(|e|e.to_string())?;
      for (name,data) in &entity.tables {super::backup::import_table(db,name,data)?;}
    }
    db.execute("INSERT INTO podcast_sync_versions(kind,id,version,deleted) VALUES(?1,?2,?3,?4) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,deleted=excluded.deleted",params![entity.kind,entity.id,entity.version,entity.deleted]).map_err(|e|e.to_string())?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;use crate::podcast::test_support::*;
  #[test]
  fn collections_membership_preferences_and_deletions_sync_without_resurrection(){
    let dir=test_directory("sync-collections");let a=PodcastState::initialize_at(&dir.join("a")).unwrap();let b=PodcastState::initialize_at(&dir.join("b")).unwrap();
    let parsed=parsed_fixture_with_episode_count(2);let feed=parsed.feed.id.clone();let episode=parsed.episodes[1].id.clone();store_subscription(&a.db_path,parsed).unwrap();
    write_preferences(&b.db_path,None,&PodcastPreferences{storage_limit_mb:1024,notify_new_episodes:Some(false),..Default::default()}).unwrap();
    let db=open_database(&a.db_path).unwrap();db.execute("INSERT INTO podcast_saved_episodes VALUES(?1,100)",[&episode]).unwrap();
    super::super::bookmarks::add_bookmark(&a.db_path,&episode,12.0,"同步备注").unwrap();let bookmark=super::super::bookmarks::list_bookmarks(&a.db_path,&episode).unwrap()[0].id.clone();
    let group=super::super::groups::save_show_group(&a.db_path,None,"同步分组",&[feed],None).unwrap();
    let playlist=super::super::lists::save_playlist(&a.db_path,None,"同步列表","manual",super::super::lists::PlaylistRules::default(),None).unwrap();
    db.execute("INSERT INTO podcast_playlist_items VALUES(?1,?2,0,100)",params![playlist.id,episode]).unwrap();
    write_preferences(&a.db_path,None,&PodcastPreferences{playback_rate:Some(1.25),intro_seconds:10,storage_limit_mb:512,notify_new_episodes:Some(true),..Default::default()}).unwrap();
    db.execute("UPDATE podcast_sync_versions SET version=200 WHERE kind='preferences'",[]).unwrap();open_database(&b.db_path).unwrap().execute("UPDATE podcast_sync_versions SET version=100 WHERE kind='preferences'",[]).unwrap();
    let old=dir.join("old.zonepodcast");super::super::backup::export_sync_backup(&a,&old).unwrap();assert!(super::super::backup::restore_sync_backup(&b,&old).unwrap());
    assert!(get_episode_detail(&b.db_path,&b.downloads_dir,&episode).unwrap().episode.saved);
    assert_eq!(super::super::bookmarks::list_bookmarks(&b.db_path,&episode).unwrap()[0].label,"同步备注");
    assert_eq!(super::super::groups::show_groups(&b.db_path).unwrap()[0].id,group.id);
    assert_eq!(open_database(&b.db_path).unwrap().query_row("SELECT id FROM podcast_playlists",[],|r|r.get::<_,String>(0)).unwrap(),playlist.id);
    let prefs=read_preferences(&b.db_path,None).unwrap();assert_eq!(prefs.playback_rate,Some(1.25));assert_eq!(prefs.intro_seconds,10);assert_eq!(prefs.storage_limit_mb,1024);assert_eq!(prefs.notify_new_episodes,Some(false));
    assert!(!super::super::backup::restore_sync_backup(&b,&old).unwrap(),"unchanged collections must not be applied again");
    let peer=open_database(&b.db_path).unwrap();peer.execute("DELETE FROM podcast_saved_episodes WHERE episode_id=?1",[&episode]).unwrap();peer.execute("DELETE FROM podcast_bookmarks WHERE id=?1",[bookmark]).unwrap();peer.execute("DELETE FROM podcast_playlists WHERE id=?1",[playlist.id]).unwrap();peer.execute("DELETE FROM podcast_show_groups WHERE id=?1",[group.id]).unwrap();
    let newer=dir.join("new.zonepodcast");super::super::backup::export_sync_backup(&b,&newer).unwrap();super::super::backup::restore_sync_backup(&a,&newer).unwrap();
    for state in [&a,&b] {super::super::backup::restore_sync_backup(state,&old).unwrap();assert!(!get_episode_detail(&state.db_path,&state.downloads_dir,&episode).unwrap().episode.saved);assert!(super::super::bookmarks::list_bookmarks(&state.db_path,&episode).unwrap().is_empty());assert_eq!(open_database(&state.db_path).unwrap().query_row("SELECT COUNT(*) FROM podcast_playlists",[],|r|r.get::<_,i64>(0)).unwrap(),0);assert!(super::super::groups::show_groups(&state.db_path).unwrap().is_empty());}
    assert!(list_queue(&b.db_path,&b.downloads_dir).unwrap().is_empty());assert!(fs::read_dir(&b.downloads_dir).unwrap().next().is_none());
  }

  #[test]
  fn equal_timestamp_edits_converge_and_invalid_entities_roll_back_the_transaction(){
    let dir=test_directory("sync-conflicts");let a=PodcastState::initialize_at(&dir.join("a")).unwrap();let b=PodcastState::initialize_at(&dir.join("b")).unwrap();store_subscription(&a.db_path,parsed_fixture("https://example.com/a.mp3")).unwrap();
    let group=super::super::groups::save_show_group(&a.db_path,None,"原名称",&[],None).unwrap();let seed=dir.join("seed.zonepodcast");super::super::backup::export_sync_backup(&a,&seed).unwrap();super::super::backup::restore_sync_backup(&b,&seed).unwrap();
    for (state,name) in [(&a,"名称甲"),(&b,"名称乙")] {let db=open_database(&state.db_path).unwrap();db.execute("UPDATE podcast_show_groups SET name=?2,updated_at=500 WHERE id=?1",params![group.id,name]).unwrap();db.execute("UPDATE podcast_sync_versions SET version=500 WHERE kind='group'",[]).unwrap();}
    let left=dir.join("left.zonepodcast");let right=dir.join("right.zonepodcast");super::super::backup::export_sync_backup(&a,&left).unwrap();super::super::backup::export_sync_backup(&b,&right).unwrap();super::super::backup::restore_sync_backup(&a,&right).unwrap();super::super::backup::restore_sync_backup(&b,&left).unwrap();
    assert_eq!(super::super::groups::show_groups(&a.db_path).unwrap()[0].name,super::super::groups::show_groups(&b.db_path).unwrap()[0].name);
    let before=super::super::groups::show_groups(&b.db_path).unwrap()[0].name.clone();let mut hostile:Value=serde_json::from_slice(&fs::read(&left).unwrap()).unwrap();
    hostile["sync_entities"][0]["version"]=Value::from(1000);hostile["sync_entities"][0]["tables"]["music_tracks"]=serde_json::json!({"columns":["id"],"rows":[["foreign"]]});fs::write(&left,serde_json::to_vec(&hostile).unwrap()).unwrap();
    assert!(super::super::backup::restore_sync_backup(&b,&left).is_err());assert_eq!(super::super::groups::show_groups(&b.db_path).unwrap()[0].name,before);assert_eq!(open_database(&b.db_path).unwrap().query_row("SELECT importing FROM podcast_sync_control",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    hostile["sync_entities"][0]["tables"].as_object_mut().unwrap().remove("music_tracks");hostile["sync_entities"][0]["tables"]["podcast_show_groups"]["rows"][0]=serde_json::json!([group.id]);fs::write(&left,serde_json::to_vec(&hostile).unwrap()).unwrap();
    assert!(super::super::backup::restore_sync_backup(&b,&left).is_err(),"truncated collection rows are rejected without panicking");assert_eq!(super::super::groups::show_groups(&b.db_path).unwrap()[0].name,before);
  }
  #[test]
  fn independent_bookmarks_at_the_same_time_converge_to_one_stable_record(){
    let dir=test_directory("sync-bookmark-collision");let a=PodcastState::initialize_at(&dir.join("a")).unwrap();let b=PodcastState::initialize_at(&dir.join("b")).unwrap();let parsed=parsed_fixture("https://example.com/a.mp3");let episode=parsed.episodes[0].id.clone();store_subscription(&a.db_path,parsed.clone()).unwrap();store_subscription(&b.db_path,parsed).unwrap();
    for (state,note) in [(&a,"甲备注"),(&b,"乙备注")] {super::super::bookmarks::add_bookmark(&state.db_path,&episode,10.0,note).unwrap();open_database(&state.db_path).unwrap().execute("UPDATE podcast_sync_versions SET version=500 WHERE kind='bookmark'",[]).unwrap();}
    let left=dir.join("left.zonepodcast");let right=dir.join("right.zonepodcast");super::super::backup::export_sync_backup(&a,&left).unwrap();super::super::backup::export_sync_backup(&b,&right).unwrap();super::super::backup::restore_sync_backup(&a,&right).unwrap();super::super::backup::restore_sync_backup(&b,&left).unwrap();
    let x=super::super::bookmarks::list_bookmarks(&a.db_path,&episode).unwrap();let y=super::super::bookmarks::list_bookmarks(&b.db_path,&episode).unwrap();assert_eq!(x.len(),1);assert_eq!(y.len(),1);assert_eq!(x[0].id,y[0].id);assert_eq!(x[0].label,y[0].label);
    super::super::backup::export_sync_backup(&a,&left).unwrap();assert!(!super::super::backup::restore_sync_backup(&b,&left).unwrap());
  }
}
