use super::*;
use quick_xml::{events::Event,Reader};
use serde::Serialize;
use tauri::{Emitter,State};

const OPML_LIMIT: usize=5*1024*1024;
#[derive(Debug,Default,Serialize)]
#[serde(rename_all="camelCase")]
pub struct PodcastImportReport { pub imported: usize, pub skipped: usize, pub failures: Vec<String>, pub failed_urls: Vec<String> }

pub(crate) fn parse_opml(bytes:&[u8])->Result<Vec<String>,String> {
  if bytes.len()>OPML_LIMIT {return Err("OPML 文件过大".into());}
  let mut reader=Reader::from_reader(bytes);reader.config_mut().check_end_names=true;
  let mut urls=Vec::new();let mut seen=HashSet::new();let mut root=false;let mut depth=0usize;
  loop {
    let event=reader.read_event().map_err(|e|format!("OPML 格式无效：{e}"))?;
    if matches!(event,Event::Start(_)|Event::Empty(_)) && depth==0 {
      let name=match &event {Event::Start(e)|Event::Empty(e)=>e.name(),_=>unreachable!()};
      if root || name.as_ref()!=b"opml" {return Err("OPML 根节点无效".into());}
      root=true;
    }
    if matches!(event,Event::Start(_)) {depth+=1;}
    match event {
      Event::Start(element)|Event::Empty(element)=>{
        if element.name().as_ref()!=b"outline" {continue;}
        for attribute in element.attributes() {
          let attribute=attribute.map_err(|e|e.to_string())?;
          if !attribute.key.as_ref().eq_ignore_ascii_case(b"xmlUrl") {continue;}
          let raw=attribute.decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0,reader.decoder()).map_err(|e|e.to_string())?;
          let url=validate_public_url_shape(raw.trim())?.to_string();
          if seen.insert(url.clone()) {urls.push(url);}
          if urls.len()>500 {return Err("单次最多导入 500 个节目".into());}
        }
      }
      Event::DocType(_)=>return Err("OPML 不支持外部实体或文档类型".into()),
      Event::End(_)=>{depth=depth.checked_sub(1).ok_or("OPML 节点未配对")?;}
      Event::Text(text) if depth==0 && !text.iter().all(u8::is_ascii_whitespace)=>return Err("OPML 根节点之外含有内容".into()),
      Event::Eof=>break,_=>{}
    }
  }
  if depth!=0 {return Err("OPML 文件不完整".into());}
  if !root || urls.is_empty() {return Err("OPML 中没有有效订阅".into());} Ok(urls)
}

pub(crate) fn export_opml(feeds:&[PodcastFeed])->String {
  let mut xml=String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><opml version=\"2.0\"><head><title>Zone 播客订阅</title></head><body>");
  for feed in feeds {
    let title=quick_xml::escape::escape(&feed.title);let url=quick_xml::escape::escape(&feed.feed_url);
    xml.push_str(&format!("<outline type=\"rss\" text=\"{title}\" title=\"{title}\" xmlUrl=\"{url}\"/>\n"));
  }
  xml.push_str("</body></opml>");xml
}

#[tauri::command]
pub async fn podcast_export_opml(state:State<'_,PodcastState>)->Result<bool,String> {
  state.ensure_ready()?; let path=state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move||{
    let feeds=list_feeds(&path)?;
    let Some(destination)=rfd::FileDialog::new().set_title("导出播客订阅").set_file_name("Zone播客订阅.opml").add_filter("OPML",&["opml"]).save_file() else {return Ok(false);};
    fs::write(destination,export_opml(&feeds)).map_err(|e|format!("无法导出订阅：{e}"))?; Ok(true)
  }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn podcast_import_opml(app:tauri::AppHandle,state:State<'_,PodcastState>)->Result<Option<PodcastImportReport>,String> {
  state.ensure_ready()?;
  let urls=tauri::async_runtime::spawn_blocking(||{
    let Some(path)=rfd::FileDialog::new().set_title("导入播客订阅").add_filter("OPML",&["opml","xml"]).pick_file() else {return Ok::<_,String>(None);};
    if fs::metadata(&path).map_err(|e|e.to_string())?.len()>OPML_LIMIT as u64 {return Err("OPML 文件过大".into());}
    Ok(Some(parse_opml(&fs::read(path).map_err(|e|e.to_string())?)?))
  }).await.map_err(|e|e.to_string())??;
  let Some(urls)=urls else {return Ok(None);};
  let report=import_urls(&state,urls).await?;
  let _=app.emit("podcast-library-changed",());Ok(Some(report))
}

fn normalize_import_urls(urls:Vec<String>)->Result<Vec<String>,String>{
  if urls.is_empty()||urls.len()>500{return Err("单次导入须为 1 至 500 个节目".into());}
  let mut seen=HashSet::new();let mut result=Vec::new();
  for url in urls{let normalized=validate_public_url_shape(&url)?.to_string();if seen.insert(normalized.clone()){result.push(normalized);}}
  Ok(result)
}
async fn import_urls(state:&PodcastState,urls:Vec<String>)->Result<PodcastImportReport,String>{
  let urls=normalize_import_urls(urls)?;
  let existing:HashSet<_>=list_feeds(&state.db_path)?.into_iter().filter(|feed|feed.subscribed).map(|feed|feed.feed_url).collect();
  let mut report=PodcastImportReport::default();let mut tasks=tokio::task::JoinSet::new();let mut urls=urls.into_iter();
  loop {
    while tasks.len()<3 {
      let Some(url)=urls.next() else {break;};
      if existing.contains(&url) {report.skipped+=1;continue;}
      let db=state.db_path.clone();
      tasks.spawn(async move {
        let result=async{let parsed=fetch_and_parse_feed(&url,None,None,None).await?;
          tauri::async_runtime::spawn_blocking(move||store_subscription(&db,parsed)).await.map_err(|e|e.to_string())?.map(|_|())
        }.await;
        (url,result)
      });
    }
    let Some(result)=tasks.join_next().await else {break;};
    let (url,result)=result.map_err(|e|e.to_string())?;
    match result {Ok(())=>report.imported+=1,Err(error)=>{report.failures.push(format!("{url}：{error}"));report.failed_urls.push(url);}}
  }
  Ok(report)
}
#[tauri::command]
pub async fn podcast_retry_import(app:tauri::AppHandle,state:State<'_,PodcastState>,urls:Vec<String>)->Result<PodcastImportReport,String>{
  state.ensure_ready()?;let report=import_urls(&state,urls).await?;let _=app.emit("podcast-library-changed",());Ok(report)
}

#[cfg(test)]
mod tests {
  use super::*;use crate::podcast::test_support::*;
  #[test]
  fn import_retry_deduplicates_and_revalidates_public_urls_and_batch_limits() {
    assert_eq!(normalize_import_urls(vec!["https://example.com/rss".into(),"https://example.com/rss".into()]).unwrap().len(),1);
    assert!(normalize_import_urls(vec!["http://127.0.0.1/rss".into()]).is_err());
    assert!(normalize_import_urls(vec!["https://example.com/rss".into();501]).is_err());
    assert!(normalize_import_urls(vec![]).is_err());
  }
  #[test]
  fn opml_round_trip_escapes_titles_and_preserves_only_subscriptions() {
    let mut parsed=parsed_fixture("https://example.com/a.mp3");parsed.feed.title="中文 & \"标题\" <播客>".into();
    let xml=export_opml(&[parsed.feed.clone()]);assert_eq!(parse_opml(xml.as_bytes()).unwrap(),vec![parsed.feed.feed_url]);
    let nested=b"<opml><body><outline text='group'><outline xmlUrl='https://example.com/rss'/><outline xmlUrl='https://example.com/rss'/></outline></body></opml>";
    assert_eq!(parse_opml(nested).unwrap().len(),1);
  }
  #[test]
  fn opml_rejects_entities_unsafe_urls_and_malformed_documents() {
    for xml in ["<!DOCTYPE opml SYSTEM 'file:///secret'><opml/>","<opml><outline xmlUrl='http://127.0.0.1/rss'/></opml>","<opml><outline xmlUrl='file:///secret'/></opml>","<opml></wrong>","<opml><outline xmlUrl='https://example.com/rss'/>","<opml/><opml><outline xmlUrl='https://example.com/rss'/></opml>"] {assert!(parse_opml(xml.as_bytes()).is_err());}
    assert!(parse_opml(&vec![b' ';OPML_LIMIT+1]).is_err());
  }
}
