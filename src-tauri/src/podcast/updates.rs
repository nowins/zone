use super::*;
use rusqlite::{params, Connection};
use tauri::{Emitter, Manager, State};

pub(crate) fn record_episode_update(db: &Connection, episode: &ParsedPodcastEpisode, now: i64) -> Result<(), String> {
  db.execute("INSERT OR IGNORE INTO podcast_episode_updates(episode_id,created_at) VALUES(?1,?2)",params![episode.id,now]).map_err(|e|e.to_string())?;
  Ok(())
}

pub(crate) fn acknowledge_updates(db: &Connection, feed_id: &str) -> Result<(),String> {
  db.execute("DELETE FROM podcast_episode_updates WHERE episode_id IN (SELECT id FROM podcast_episodes WHERE feed_id=?1)",[feed_id]).map_err(|e|e.to_string())?;
  Ok(())
}

#[tauri::command]
pub fn podcast_acknowledge_updates(app: tauri::AppHandle, state: State<'_,PodcastState>, feed_id: String) -> Result<(),String> {
  state.ensure_ready()?; validate_identifier(&feed_id)?;
  acknowledge_updates(&open_database(&state.db_path)?,&feed_id)?;
  app.emit("podcast-library-changed",()).map_err(|e|e.to_string())
}

// Delivery is independent from the unread tile marker. A disabled OS setting
// consumes delivery only, so enabling it later never floods historical updates.
pub(crate) fn deliver_episode_updates(app: &tauri::AppHandle, path: &Path) -> Result<(),String> {
  let db=open_database(path)?;
  let global=read_preferences_in(&db,None)?;
  for feed in list_feeds(path)? {
    let own=read_preferences_in(&db,Some(&feed.id))?;
    let enabled=own.notify_new_episodes.or(global.notify_new_episodes).unwrap_or(false);
    if !enabled {
      db.execute("UPDATE podcast_episode_updates SET delivered=1 WHERE episode_id IN (SELECT id FROM podcast_episodes WHERE feed_id=?1)",[&feed.id]).map_err(|e|e.to_string())?;
      continue;
    }
    let pending: (i64,i64)=db.query_row("SELECT COUNT(*),COALESCE(MAX(u.created_at),0) FROM podcast_episode_updates u JOIN podcast_episodes e ON e.id=u.episode_id WHERE e.feed_id=?1 AND u.delivered=0",[&feed.id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    if pending.0==0 {continue;}
    let title: String=db.query_row("SELECT e.title FROM podcast_episode_updates u JOIN podcast_episodes e ON e.id=u.episode_id WHERE e.feed_id=?1 AND u.delivered=0 ORDER BY COALESCE(e.published_at,u.created_at) DESC,e.id LIMIT 1",[&feed.id],|r|r.get(0)).map_err(|e|e.to_string())?;
    show_update_notification(app,&feed.id,&feed.title,&format!("{} 集更新 · {}",pending.0,title))?;
    db.execute("UPDATE podcast_episode_updates SET delivered=1 WHERE created_at<=?2 AND episode_id IN (SELECT id FROM podcast_episodes WHERE feed_id=?1)",params![feed.id,pending.1]).map_err(|e|e.to_string())?;
  }
  Ok(())
}

#[tauri::command]
pub fn podcast_test_notification(app: tauri::AppHandle,state:State<'_,PodcastState>) -> Result<(),String> {
  state.ensure_ready()?;
  show_update_notification(&app,"test","播客更新提醒","新单集会在这里提醒，也会显示在已固定的首页磁贴上。")
}

#[cfg(target_os="windows")]
fn show_update_notification(app:&tauri::AppHandle,feed_id:&str,title:&str,body:&str)->Result<(),String> {
  use windows::core::HSTRING;
  use windows::Data::Xml::Dom::XmlDocument;
  use windows::Foundation::TypedEventHandler;
  use windows::UI::Notifications::{ToastNotification,ToastNotificationManager};
  let phase=std::cell::Cell::new("identity");
  let send=||->windows::core::Result<()> {
    // The parameterless overload is not supported for desktop apps. Use the
    // installed package's actual AUMID, or the registered desktop identity.
    let identity=notification_identity(&app.config().identifier)?;
    phase.set("notifier");let notifier=ToastNotificationManager::CreateToastNotifierWithId(&identity)?;
    phase.set("setting");
    check_notification_setting(notifier.Setting())?;
    phase.set("xml");
    let document=XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><audio silent=\"true\"/></toast>",xml_escape(title),xml_escape(body))))?;
    phase.set("toast");let toast=ToastNotification::CreateToastNotification(&document)?;
    toast.SetTag(&HSTRING::from(&hash_identifier("update",&[feed_id])[..16]))?;
    toast.SetGroup(&HSTRING::from("podcast-updates"))?;
    let app=app.clone();let id=feed_id.to_owned();
    toast.Activated(&TypedEventHandler::new(move |_,_| {
      if let Some(window)=app.get_webview_window("main") {let _=window.show();let _=window.unminimize();let _=window.set_focus();}
      if id!="test" {let _=app.emit("podcast-update-open",&id);}
      Ok(())
    }))?;
    phase.set("show");notifier.Show(&toast)
  };
  send().map_err(|error|{eprintln!("[podcast] Windows notification failed at {}: HRESULT {:08x}",phase.get(),error.code().0 as u32);"Windows 未能发送提醒，请检查 Zone 的通知权限或免打扰设置。磁贴更新提示仍会保留。".into()})
}
#[cfg(target_os="windows")]
fn check_notification_setting(setting:windows::core::Result<windows::UI::Notifications::NotificationSetting>)->windows::core::Result<()> {
  use windows::{core::{Error,HRESULT},UI::Notifications::NotificationSetting};
  match setting {
    Ok(NotificationSetting::Enabled)=>Ok(()),
    Ok(_)=>Err(Error::from_hresult(HRESULT(0x80070005u32 as i32))),
    // A newly registered desktop identity can have no stored notification
    // setting yet. Let Show initialize it and enforce the OS policy itself.
    Err(error) if error.code().0 as u32==0x80070490=>Ok(()),
    Err(error)=>Err(error),
  }
}
#[cfg(target_os="windows")]
fn notification_identity(desktop:&str)->windows::core::Result<windows::core::HSTRING>{
  use windows::core::{HSTRING,PWSTR};
  use windows::Win32::Foundation::{APPMODEL_ERROR_NO_APPLICATION,ERROR_INSUFFICIENT_BUFFER,ERROR_SUCCESS};
  use windows::Win32::Storage::Packaging::Appx::GetCurrentApplicationUserModelId;
  let mut length=0;let status=unsafe{GetCurrentApplicationUserModelId(&mut length,None)};
  if status==APPMODEL_ERROR_NO_APPLICATION {return Ok(HSTRING::from(desktop));}
  if status!=ERROR_INSUFFICIENT_BUFFER||length==0||length>512 {return Err(windows::core::Error::from_hresult(status.to_hresult()));}
  let mut buffer=vec![0u16;length as usize];let status=unsafe{GetCurrentApplicationUserModelId(&mut length,Some(PWSTR(buffer.as_mut_ptr())))};
  if status!=ERROR_SUCCESS{return Err(windows::core::Error::from_hresult(status.to_hresult()));}
  Ok(HSTRING::from_wide(&buffer[..length.saturating_sub(1) as usize]))
}
#[cfg(not(target_os="windows"))]
fn show_update_notification(_app:&tauri::AppHandle,_feed_id:&str,_title:&str,_body:&str)->Result<(),String> {Err("此平台暂不支持系统提醒，首页磁贴仍会显示更新。".into())}

fn xml_escape(text:&str)->String {text.chars().filter(|c|!c.is_control()||matches!(c,'\n'|'\t')).take(500).flat_map(|c|match c {'&'=>"&amp;".chars().collect::<Vec<_>>(),'<'=>"&lt;".chars().collect(),'>'=>"&gt;".chars().collect(),'"'=>"&quot;".chars().collect(),_=>vec![c]}).collect()}

#[cfg(test)]
mod tests {
  use super::*;use crate::podcast::test_support::*;
  #[test]
  fn updates_skip_initial_archives_repeat_refreshes_and_keep_progress_independent() {
    let dir=test_directory("update-markers");let state=PodcastState::initialize_at(&dir).unwrap();let path=state.db_path;
    let first=parsed_fixture_with_episode_count(3);let feed=first.feed.id.clone();store_subscription(&path,first.clone()).unwrap();
    assert_eq!(list_feeds(&path).unwrap()[0].new_episode_count,0);
    let mut next=parsed_fixture_with_episode_count(4);next.episodes[3].published_at=first.episodes[0].published_at;store_subscription(&path,next.clone()).unwrap();
    assert_eq!(list_feeds(&path).unwrap()[0].new_episode_count,1);
    store_subscription(&path,next).unwrap();assert_eq!(list_feeds(&path).unwrap()[0].new_episode_count,1);
    store_subscription(&path,parsed_fixture_with_episode_count(5)).unwrap();assert_eq!(list_feeds(&path).unwrap()[0].new_episode_count,1,"older archive additions are not new releases");
    let db=open_database(&path).unwrap();acknowledge_updates(&db,&feed).unwrap();
    assert_eq!(list_feeds(&path).unwrap()[0].new_episode_count,0);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM podcast_progress",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    drop(db);fs::remove_dir_all(dir).unwrap();
  }
  #[test]fn notification_text_is_xml_safe_and_bounded(){assert_eq!(xml_escape("A<&\"\u{0}"),"A&lt;&amp;&quot;");assert_eq!(xml_escape(&"字".repeat(1000)).chars().count(),500);}
  #[cfg(target_os="windows")]
  #[test]fn notification_setting_preserves_blocks_and_allows_first_desktop_delivery(){
    use windows::{core::{Error,HRESULT},UI::Notifications::NotificationSetting};
    assert!(check_notification_setting(Ok(NotificationSetting::Enabled)).is_ok());
    for blocked in [NotificationSetting::DisabledForApplication,NotificationSetting::DisabledForUser,NotificationSetting::DisabledByGroupPolicy,NotificationSetting::DisabledByManifest]{assert!(check_notification_setting(Ok(blocked)).is_err());}
    assert!(check_notification_setting(Err(Error::from_hresult(HRESULT(0x80070490u32 as i32)))).is_ok());
    assert_eq!(check_notification_setting(Err(Error::from_hresult(HRESULT(0x80070005u32 as i32)))).unwrap_err().code().0 as u32,0x80070005);
  }
}
