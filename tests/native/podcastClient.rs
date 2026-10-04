use std::{fs::{self,OpenOptions},io::Write,path::PathBuf,sync::{Arc,Mutex},time::Duration};
use tauri::{Manager,Emitter};

fn directory() -> PathBuf { PathBuf::from(std::env::var("ZONE_PODCAST_CLIENT_REPORT").expect("client report directory")) }

pub fn initialize(app: &tauri::AppHandle) -> Result<(),String> {
  let data=app.path().app_data_dir().map_err(|e|e.to_string())?;
  let db=crate::db::initialize_zone_database(&data)?;
  if std::env::var("ZONE_PODCAST_CLIENT_MODE").as_deref()!=Ok("restart") {
  if crate::podcast::list_feeds(&db)?.is_empty() {
    let xml=r#"<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>客户端验证节目</title><description>用于完整客户端验收的节目，验证订阅、播放、下载、进度与键盘操作。</description><itunes:author>Zone 验收</itunes:author><item><guid>client-online</guid><title>在线单集：待播与下载任务状态夹具</title><description>仅验证队列与任务状态；公共网络播放由 network 模式验证。</description><itunes:duration>300</itunes:duration><enclosure url="https://example.com/client-placeholder.mp3" type="audio/mpeg" /></item><item><guid>client-offline</guid><title>离线单集：长标题与小窗口的功能完整性验证</title><description>离线音频与暂停恢复。</description><itunes:duration>300</itunes:duration><enclosure url="https://example.com/client.wav" type="audio/wav" /></item></channel></rss>"#;
    let parsed=crate::podcast::parse_feed_bytes(xml.as_bytes(),"https://example.com/client-podcast.xml",None,None,None,None,None)?;
    let offline=parsed.episodes[1].id.clone();
    crate::podcast::store_subscription(&db,parsed)?;
    let rate=8000u32; let length=rate as usize*2*300; let mut wav=vec![0;length+44];
    wav[..4].copy_from_slice(b"RIFF");wav[4..8].copy_from_slice(&((length+36) as u32).to_le_bytes());wav[8..16].copy_from_slice(b"WAVEfmt ");
    wav[16..20].copy_from_slice(&16u32.to_le_bytes());wav[20..24].copy_from_slice(&[1,0,1,0]);wav[24..28].copy_from_slice(&rate.to_le_bytes());
    wav[28..32].copy_from_slice(&(rate*2).to_le_bytes());wav[32..36].copy_from_slice(&[2,0,16,0]);wav[36..40].copy_from_slice(b"data");wav[40..44].copy_from_slice(&(length as u32).to_le_bytes());
    for (i,v) in wav[44..].chunks_exact_mut(2).enumerate() {let signal=((i as f64*220.0*std::f64::consts::TAU/rate as f64).sin()*500.0) as i16;v.copy_from_slice(&signal.to_le_bytes());}
    let path=data.join("podcast-downloads").join(format!("{offline}.wav"));fs::write(&path,wav).map_err(|e|e.to_string())?;
    crate::podcast::open_database(&db)?.execute("INSERT INTO podcast_downloads(episode_id,local_path,state,downloaded_bytes,total_bytes,updated_at) VALUES (?1,?2,'downloaded',?3,?3,1)",
      rusqlite::params![offline,path.to_string_lossy(),(length+44) as i64]).map_err(|e|e.to_string())?;
  }
  let connection=crate::podcast::open_database(&db)?;
  let pending:String=connection.query_row("SELECT id FROM podcast_episodes WHERE title LIKE '在线单集%' LIMIT 1",[],|r|r.get(0)).map_err(|e|e.to_string())?;
  connection.execute("UPDATE podcast_episodes SET title='在线单集：待播与下载任务状态夹具',enclosure_url='https://example.com/client-placeholder.mp3' WHERE id=?1",[&pending]).map_err(|e|e.to_string())?;
  fs::write(data.join("podcast-downloads").join(format!("{pending}.part")),vec![0;8192]).map_err(|e|e.to_string())?;
  connection.execute("INSERT INTO podcast_downloads(episode_id,state,downloaded_bytes,updated_at) VALUES(?1,'failed',8192,1) ON CONFLICT(episode_id) DO UPDATE SET state='failed',downloaded_bytes=8192,local_path=NULL",[&pending]).map_err(|e|e.to_string())?;
  connection.execute("INSERT INTO podcast_download_jobs(episode_id,state,updated_at) VALUES(?1,'paused',1) ON CONFLICT(episode_id) DO UPDATE SET state='paused',request_id=NULL",[&pending]).map_err(|e|e.to_string())?;
  connection.execute("DELETE FROM podcast_queue WHERE episode_id IN(SELECT id FROM podcast_episodes WHERE title LIKE '在线单集%' OR title LIKE '离线单集%')",[]).map_err(|e|e.to_string())?;
  let offline:String=connection.query_row("SELECT id FROM podcast_episodes WHERE title LIKE '离线单集%' LIMIT 1",[],|r|r.get(0)).map_err(|e|e.to_string())?;
  connection.execute("DELETE FROM podcast_bookmarks WHERE episode_id=?1",[&offline]).map_err(|e|e.to_string())?;
  connection.execute("INSERT INTO podcast_progress(episode_id,position_seconds,duration_seconds,completed,updated_at) VALUES(?1,30,300,0,?2) ON CONFLICT(episode_id) DO UPDATE SET position_seconds=30,duration_seconds=300,completed=0,updated_at=excluded.updated_at",rusqlite::params![offline,crate::podcast::unix_time_millis()]).map_err(|e|e.to_string())?;
  // Regenerate only this fixture's managed audio, with a real silent segment.
  let rate=8000u32;let length=rate as usize*2*300;let mut wav=vec![0;length+44];
  wav[..4].copy_from_slice(b"RIFF");wav[4..8].copy_from_slice(&((length+36) as u32).to_le_bytes());wav[8..16].copy_from_slice(b"WAVEfmt ");
  wav[16..20].copy_from_slice(&16u32.to_le_bytes());wav[20..24].copy_from_slice(&[1,0,1,0]);wav[24..28].copy_from_slice(&rate.to_le_bytes());
  wav[28..32].copy_from_slice(&(rate*2).to_le_bytes());wav[32..36].copy_from_slice(&[2,0,16,0]);wav[36..40].copy_from_slice(b"data");wav[40..44].copy_from_slice(&(length as u32).to_le_bytes());
  for(i,v)in wav[44..].chunks_exact_mut(2).enumerate(){let seconds=i as f64/rate as f64;let level=if(60.0..70.0).contains(&seconds){0.0}else{1000.0};let signal=((seconds*220.0*std::f64::consts::TAU).sin()*level)as i16;v.copy_from_slice(&signal.to_le_bytes());}
  fs::write(data.join("podcast-downloads").join(format!("{offline}.wav")),wav).map_err(|e|e.to_string())?;
  if std::env::var("ZONE_PODCAST_CLIENT_MODE").unwrap_or_else(|_|"core".into())=="core" {
    // The isolated manual audit may add public subscriptions; keep core fixtures deterministic.
    connection.execute("UPDATE podcast_feeds SET subscribed=CASE WHEN feed_url='https://example.com/client-podcast.xml' THEN 1 ELSE 0 END",[]).map_err(|e|e.to_string())?;
    let folder=data.join("client-music");fs::create_dir_all(&folder).map_err(|e|e.to_string())?;
    fs::copy(data.join("podcast-downloads").join(format!("{offline}.wav")),folder.join("Zone-client-music.wav")).map_err(|e|e.to_string())?;
    let music=app.state::<crate::music::MusicState>();
    crate::music::scan_and_store_library_controlled(music.inner(),vec![crate::library::MusicFolder{path:folder.to_string_lossy().into(),name:"客户端音乐验收".into()}],&||false,&|_|{})?;
  }
  connection.execute("UPDATE podcast_feeds SET description='<p>一档关于音乐、生活与声音的播客。</p><p>每集围绕一个主题展开交流，保留嘉宾的不同观点。</p><h3>节目内容</h3><ul><li>音乐与生活</li><li>故事与访谈</li></ul>' WHERE feed_url='https://example.com/client-podcast.xml'",[]).map_err(|e|e.to_string())?;
  let resource="1111111111111111111111111111111111111111111111111111111111111111";
  connection.execute("INSERT OR IGNORE INTO podcast_episode_resources(id,episode_id,kind,source_kind,url,mime_type,language,ordinal,fetched_at) VALUES(?1,?2,'transcript','podcast-transcript','https://example.com/client.vtt','text/vtt','zh-CN',0,?3)",rusqlite::params![resource,offline,crate::podcast::unix_time_millis()]).map_err(|e|e.to_string())?;
  connection.execute("UPDATE podcast_episodes SET description='<p>客户端简介，<strong>重点</strong>与 00:02 时间码。</p><p>资料：<a href=\"https://example.com/notes\">相关链接</a></p>' WHERE id=?1",[&offline]).map_err(|e|e.to_string())?;
  for (ordinal,start,end,text) in [(0,0,10,"开场介绍"),(1,10,30,"中文转写测试：查找关键词"),(2,30,90,"接下来的章节")] {
    connection.execute("INSERT OR IGNORE INTO podcast_transcript_cues(resource_id,ordinal,start_ms,end_ms,text,speaker) VALUES(?1,?2,?3,?4,?5,'Zone')",rusqlite::params![resource,ordinal,start*1000,end*1000,text]).map_err(|e|e.to_string())?;
  }
  let catalogue=serde_json::json!({"source":"xyzrank","stale":false,"fetchedAt":crate::podcast::unix_time_millis(),"shows":[{"id":"client-ranked","title":"客户端验证节目：完整标题和作者信息可读性检查","author":"Zone 验收","feedUrl":"https://example.com/client-podcast.xml","genres":["科技"],"rank":7}]});
  connection.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES('podcast.discovery.xyzrank.v1',?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",rusqlite::params![catalogue.to_string(),crate::podcast::unix_time_millis()]).map_err(|e|e.to_string())?;
  drop(connection);
  }
  fs::write(directory().join("data-directory.txt"),data.to_string_lossy().as_bytes()).map_err(|e|e.to_string())?;
  let handle=app.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(Duration::from_secs(3)).await;
    let _=fs::write(directory().join("bootstrap.txt"),"client setup complete");
    if let Some(window)=handle.get_webview_window("main") {let _=window.eval(include_str!("podcastClient.js"));}
    let result=client_capture(handle,"00-bootstrap".into()).await;
    let _=fs::write(directory().join("capture-status.txt"),format!("{result:?}"));
  });
  Ok(())
}

#[tauri::command]
pub fn client_record(app: tauri::AppHandle,value: serde_json::Value) -> Result<(),String> {
  let json=serde_json::to_string(&value).map_err(|e|e.to_string())?;
  writeln!(OpenOptions::new().create(true).append(true).open(directory().join("events.jsonl")).map_err(|e|e.to_string())?,"{json}").map_err(|e|e.to_string())?;
  if value["kind"]=="snapshot" {fs::write(directory().join("snapshot.json"),&json).map_err(|e|e.to_string())?;}
  if value["kind"]=="result" {fs::write(directory().join("result.json"),json).map_err(|e|e.to_string())?;app.exit(if value["ok"]==true {0}else{1});}
  Ok(())
}

#[tauri::command]
pub fn client_media(app:tauri::AppHandle,action:String,position_seconds:Option<f64>)->Result<(),String> {
  if !matches!(action.as_str(),"pause"|"play"|"seek") {return Err("unsupported client media action".into());}
  app.emit("system-media-command",serde_json::json!({"action":action,"positionSeconds":position_seconds})).map_err(|e|e.to_string())
}

#[tauri::command]
pub fn client_window(app: tauri::AppHandle,small: bool) -> Result<(),String> {
  let window=app.get_webview_window("main").ok_or("missing main window")?;
  window.unmaximize().map_err(|e|e.to_string())?;
  window.set_size(if small {tauri::LogicalSize::new(920.0,620.0)}else{tauri::LogicalSize::new(1180.0,760.0)}).map_err(|e|e.to_string())
}

#[tauri::command]
pub async fn client_capture(app: tauri::AppHandle,name: String) -> Result<(),String> {
  if name.is_empty()||name.len()>64||!name.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-') {return Err("invalid capture name".into());}
  let path=directory().join(format!("{name}.png"));
  let (sender,receiver)=tokio::sync::oneshot::channel();let completed=Arc::new(Mutex::new(Some(sender)));
  app.get_webview_window("main").ok_or("missing main window")?.with_webview(move |webview| {
    let result: windows::core::Result<()>=(|| unsafe {
      use windows::Win32::{System::Com::{IStream,STGM_CREATE,STGM_WRITE},UI::Shell::SHCreateStreamOnFileEx};
      use webview2_com::{CapturePreviewCompletedHandler,Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG};
      let path=windows::core::HSTRING::from(path.to_string_lossy().as_ref());
      let stream:IStream=SHCreateStreamOnFileEx(&path,STGM_CREATE.0|STGM_WRITE.0,0,true,None)?;
      let core=webview.controller().CoreWebView2()?;let finished=completed.clone();let retained=stream.clone();
      let handler=CapturePreviewCompletedHandler::create(Box::new(move |code| {let _retained=&retained;if let Some(sender)=finished.lock().unwrap().take(){let _=sender.send(code.map_err(|e|e.to_string()));}Ok(())}));
      core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,&stream,&handler)?;Ok(())
    })();
    if let Err(error)=result {if let Some(sender)=completed.lock().unwrap().take(){let _=sender.send(Err(error.to_string()));}}
  }).map_err(|e|e.to_string())?;
  tokio::time::timeout(Duration::from_secs(10),receiver).await.map_err(|_|"capture timeout")?.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn client_motion(app:tauri::AppHandle,reduce:bool)->Result<(),String>{
 let(sender,receiver)=tokio::sync::oneshot::channel();let completed=Arc::new(Mutex::new(Some(sender)));
 app.get_webview_window("main").ok_or("missing main window")?.with_webview(move|webview|{
  let result:windows::core::Result<()>=(||unsafe{let core=webview.controller().CoreWebView2()?;let finished=completed.clone();let handler=webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move|code,_|{if let Some(sender)=finished.lock().unwrap().take(){let _=sender.send(code.map_err(|e|e.to_string()));}Ok(())}));let parameters=windows::core::HSTRING::from(serde_json::json!({"features":[{"name":"prefers-reduced-motion","value":if reduce{"reduce"}else{"no-preference"}}]}).to_string());core.CallDevToolsProtocolMethod(windows::core::w!("Emulation.setEmulatedMedia"),&parameters,&handler)?;Ok(())})();if let Err(error)=result{if let Some(sender)=completed.lock().unwrap().take(){let _=sender.send(Err(error.to_string()));}}
 }).map_err(|e|e.to_string())?;tokio::time::timeout(Duration::from_secs(10),receiver).await.map_err(|_|"motion emulation timeout")?.map_err(|e|e.to_string())?
}

#[tauri::command]
pub fn client_context()->serde_json::Value{serde_json::json!({"mode":std::env::var("ZONE_PODCAST_CLIENT_MODE").unwrap_or_else(|_|"core".into()),"report":directory(),"expected":std::env::var("ZONE_PODCAST_CLIENT_EXPECTED").ok().and_then(|v|serde_json::from_str::<serde_json::Value>(&v).ok())})}

#[tauri::command]
pub fn client_add_update(app:tauri::AppHandle)->Result<String,String> {
  let path=crate::db::initialize_zone_database(&app.path().app_data_dir().map_err(|e|e.to_string())?)?;
  let feed=crate::podcast::list_feeds(&path)?.into_iter().find(|f|f.feed_url=="https://example.com/client-podcast.xml").ok_or("fixture missing")?;
  let xml=format!("<rss version=\"2.0\"><channel><title>客户端验证节目</title><item><guid>update-{}</guid><title>刚刚更新的验收单集</title><enclosure url=\"https://example.com/new-episode.mp3\" type=\"audio/mpeg\"/></item></channel></rss>",crate::podcast::unix_time_millis());
  let mut parsed=crate::podcast::parse_feed_bytes(xml.as_bytes(),&feed.feed_url,None,None,None,None,None)?;
  parsed.feed=feed.clone();crate::podcast::store_subscription(&path,parsed)?;
  app.emit("podcast-library-changed",()).map_err(|e|e.to_string())?;Ok(feed.id)
}

#[tauri::command]
pub fn client_backup_tick(app:tauri::AppHandle)->Result<bool,String>{
  let state=app.state::<crate::podcast::PodcastState>();
  crate::podcast::run_scheduled_backup(state.inner(),crate::podcast::unix_time_millis()+8*86_400_000)
}
