use std::{fs::{self,OpenOptions},io::Write,path::PathBuf,sync::{Arc,Mutex},time::Duration};
use tauri::Manager;

fn directory() -> PathBuf { PathBuf::from(std::env::var("ZONE_PODCAST_CLIENT_REPORT").expect("client report directory")) }

pub fn initialize(app: &tauri::AppHandle) -> Result<(),String> {
  let data=app.path().app_data_dir().map_err(|e|e.to_string())?;
  let db=crate::db::initialize_zone_database(&data)?;
  if crate::podcast::list_feeds(&db)?.is_empty() {
    let xml=r#"<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>客户端验证节目</title><description>用于完整客户端验收的节目，验证订阅、播放、下载、进度与键盘操作。</description><itunes:author>Zone 验收</itunes:author><item><guid>client-online</guid><title>在线单集：真实网络与完整客户端播放流程</title><description>节目简介与 00:30 时间码，访问 https://example.com 查看相关资料。</description><itunes:duration>300</itunes:duration><enclosure url="https://traffic.libsyn.com/secure/atp/atp600.mp3" type="audio/mpeg" /></item><item><guid>client-offline</guid><title>离线单集：长标题与小窗口的功能完整性验证</title><description>离线音频与暂停恢复。</description><itunes:duration>300</itunes:duration><enclosure url="https://example.com/client.wav" type="audio/wav" /></item></channel></rss>"#;
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
  if value["kind"]=="result" {fs::write(directory().join("result.json"),json).map_err(|e|e.to_string())?;app.exit(if value["ok"]==true {0}else{1});}
  Ok(())
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
