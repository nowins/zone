use super::*;
use rusqlite::params;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct PodcastEpisodeSearchPage {pub episodes:Vec<PodcastEpisode>,pub total:usize,pub has_more:bool,pub matches:Vec<PodcastContentMatch>,pub series:Option<PodcastSeries>}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct PodcastSeries {pub seasons:Vec<i64>,pub types:Vec<String>,pub numbered:bool}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct PodcastContentMatch {pub episode_id:String,pub kind:String,pub position_seconds:Option<f64>,pub text:String}

fn content_excerpt(text:&str,query:&str)->String {
  let lowered=text.to_lowercase();
  let index=lowered.find(&query.to_lowercase()).map(|index|lowered[..index].chars().count()).unwrap_or(0);
  let start=index.saturating_sub(55);
  let excerpt:String=text.chars().skip(start).take(170).collect();
  format!("{}{}{}",if start>0{"…"}else{""},excerpt,if text.chars().count()>start+170{"…"}else{""})
}

#[cfg(test)]
pub(crate) fn search_episodes(path:&Path,downloads:&Path,feed:Option<&str>,query:&str,filter:&str,sort:&str,offset:usize,limit:usize)->Result<PodcastEpisodeSearchPage,String> {
  search_episodes_scoped(path,downloads,feed,query,filter,sort,offset,limit,false)
}
#[cfg(test)]
fn search_episodes_scoped(path:&Path,downloads:&Path,feed:Option<&str>,query:&str,filter:&str,sort:&str,offset:usize,limit:usize,followed_only:bool)->Result<PodcastEpisodeSearchPage,String> {
  search_series_episodes(path,downloads,feed,query,filter,sort,offset,limit,followed_only,None,None)
}
fn search_series_episodes(path:&Path,downloads:&Path,feed:Option<&str>,query:&str,filter:&str,sort:&str,offset:usize,limit:usize,followed_only:bool,season:Option<i64>,episode_type:Option<&str>)->Result<PodcastEpisodeSearchPage,String> {
  if let Some(id)=feed {validate_identifier(id)?;}
  if query.chars().count()>200 {return Err("搜索文字过长".into());}
  if season.is_some_and(|value| !(1..=100_000).contains(&value)) || episode_type.is_some_and(|value| !matches!(value,"full"|"trailer"|"bonus")) {return Err("季集筛选无效".into());}
  let condition=match filter {"all"=>"1=1","unplayed"=>"COALESCE(p.completed,0)=0","in-progress"=>"p.position_seconds>0 AND p.completed=0","unstarted"=>"COALESCE(p.position_seconds,0)=0 AND COALESCE(p.completed,0)=0","played"=>"COALESCE(p.completed,0)=1","downloaded"=>"d.state='downloaded'","saved"=>"s.episode_id IS NOT NULL","history"=>"(p.position_seconds>0 OR p.completed=1)",_=>return Err("单集筛选无效".into())};
  let order=match sort {"newest"=>"e.published_at IS NULL,e.published_at DESC,e.id","oldest"=>"e.published_at IS NULL,e.published_at ASC,e.id","title"=>"e.title COLLATE NOCASE,e.id","listened"=>"p.updated_at IS NULL,p.updated_at DESC,e.id","series"=>"e.season IS NULL,e.season,e.episode_number IS NULL,e.episode_number,e.published_at IS NULL,e.published_at,e.id",_=>return Err("单集排序无效".into())};
  let pattern=format!("%{}%",query.trim().replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_"));
  let from=format!("FROM podcast_episodes e JOIN podcast_feeds f ON f.id=e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id=e.id LEFT JOIN podcast_progress p ON p.episode_id=e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id=e.id
    WHERE (?1 IS NULL OR e.feed_id=?1) AND (?3 IS NULL OR e.season=?3) AND (?4 IS NULL OR e.episode_type=?4) AND {condition} AND {} AND
    (e.title LIKE ?2 ESCAPE '\\' OR COALESCE(e.description,'') LIKE ?2 ESCAPE '\\'
    OR f.title LIKE ?2 ESCAPE '\\' OR COALESCE(f.author,'') LIKE ?2 ESCAPE '\\'
    OR EXISTS(SELECT 1 FROM podcast_bookmarks b WHERE b.episode_id=e.id AND b.label LIKE ?2 ESCAPE '\\')
    OR EXISTS(SELECT 1 FROM podcast_episode_resources r JOIN podcast_transcript_cues c ON c.resource_id=r.id
      WHERE r.episode_id=e.id AND r.kind='transcript' AND c.text LIKE ?2 ESCAPE '\\'))",if followed_only{"f.subscribed=1"}else{"1=1"});
  let db=open_database(path)?;
  let total=db.query_row(&format!("SELECT COUNT(*) {from}"),params![feed,pattern,season,episode_type],|r|r.get::<_,i64>(0)).map_err(|e|e.to_string())?.max(0) as usize;
  let sql=format!("SELECT e.id,e.feed_id,e.title,e.description,e.published_at,
    COALESCE(NULLIF(p.duration_seconds,0),e.duration_seconds),e.enclosure_url,e.enclosure_type,e.artwork_url,
    COALESCE(d.state,'none'),d.local_path,COALESCE(d.downloaded_bytes,0),d.total_bytes,
    COALESCE(p.position_seconds,0),COALESCE(p.completed,0),f.title,f.artwork_url,
    CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,e.first_seen_at,e.webpage_url,p.updated_at AS last_listened_at, e.season, e.episode_number, e.episode_type {from} ORDER BY {order} LIMIT ?5 OFFSET ?6");
  let mut statement=db.prepare(&sql).map_err(|e|e.to_string())?;
  let episodes=statement.query_map(params![feed,pattern,season,episode_type,limit.clamp(1,100) as i64,offset.min(200_000) as i64],|r|query::podcast_episode_from_row(r,downloads))
    .map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
  let mut matches=Vec::new();
  if !query.trim().is_empty() {
    let mut hit_query=db.prepare("SELECT kind,position_ms,text FROM (
      SELECT 'bookmark' AS kind,b.position_ms,b.label AS text FROM podcast_bookmarks b WHERE b.episode_id=?1 AND b.label LIKE ?2 ESCAPE '\\'
      UNION SELECT 'transcript',c.start_ms,c.text FROM podcast_episode_resources r JOIN podcast_transcript_cues c ON c.resource_id=r.id
      WHERE r.episode_id=?1 AND r.kind='transcript' AND c.text LIKE ?2 ESCAPE '\\') ORDER BY kind,position_ms LIMIT 3").map_err(|e|e.to_string())?;
    for episode in &episodes {
      let rows=hit_query.query_map(params![episode.id,pattern],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<i64>>(1)?,row.get::<_,String>(2)?))).map_err(|e|e.to_string())?;
      for row in rows {let (kind,position,text)=row.map_err(|e|e.to_string())?;
        matches.push(PodcastContentMatch{episode_id:episode.id.clone(),kind,position_seconds:position.map(|ms|ms.max(0) as f64/1000.0),text:content_excerpt(&text,query.trim())});
      }
    }
  }
  let series=if let Some(feed)=feed {
    let mut seasons=db.prepare("SELECT DISTINCT season FROM podcast_episodes WHERE feed_id=?1 AND season IS NOT NULL ORDER BY season").map_err(|e|e.to_string())?;
    let seasons=seasons.query_map([feed],|r|r.get(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let mut types=db.prepare("SELECT DISTINCT episode_type FROM podcast_episodes WHERE feed_id=?1 AND episode_type IS NOT NULL ORDER BY episode_type").map_err(|e|e.to_string())?;
    let types=types.query_map([feed],|r|r.get(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let numbered=db.query_row("SELECT EXISTS(SELECT 1 FROM podcast_episodes WHERE feed_id=?1 AND episode_number IS NOT NULL)",[feed],|r|r.get(0)).map_err(|e|e.to_string())?;
    Some(PodcastSeries{seasons,types,numbered})
  } else {None};
  let has_more=offset.saturating_add(episodes.len())<total;Ok(PodcastEpisodeSearchPage{episodes,total,has_more,matches,series})
}

#[tauri::command]
pub async fn podcast_search_episodes(state:State<'_,PodcastState>,feed_id:Option<String>,query:String,filter:String,sort:String,offset:usize,limit:usize,followed_only:Option<bool>,season:Option<i64>,episode_type:Option<String>)->Result<PodcastEpisodeSearchPage,String> {
  state.ensure_ready()?;let path=state.db_path.clone();let downloads=state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move||search_series_episodes(&path,&downloads,feed_id.as_deref(),&query,&filter,&sort,offset,limit,followed_only.unwrap_or(false),season,episode_type.as_deref())).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;use crate::podcast::test_support::*;
  #[test]
  fn series_filters_cover_the_complete_archive_without_inventing_metadata() {
    let dir=test_directory("series-search");let state=PodcastState::initialize_at(&dir).unwrap();
    let mut parsed=parsed_fixture_with_episode_count(260);let feed=parsed.feed.id.clone();
    for (index,episode) in parsed.episodes.iter_mut().enumerate().skip(120) {episode.season=Some(if index<200 {1}else{2});episode.episode_number=Some(index as i64);episode.episode_type=Some(if index%2==0 {"trailer"}else{"full"}.into());}
    store_subscription(&state.db_path,parsed).unwrap();
    let page=search_series_episodes(&state.db_path,&state.downloads_dir,Some(&feed),"","all","series",0,50,false,Some(2),Some("trailer")).unwrap();
    assert_eq!(page.total,30);assert_eq!(page.episodes[0].episode_number,Some(200));assert_eq!(page.series.unwrap().seasons,vec![1,2]);
    assert_eq!(search_series_episodes(&state.db_path,&state.downloads_dir,Some(&feed),"","all","series",50,50,false,None,None).unwrap().total,260);
    assert!(search_series_episodes(&state.db_path,&state.downloads_dir,Some(&feed),"","all","newest",0,50,false,Some(-1),None).is_err());
    let detail=get_episode_detail(&state.db_path,&state.downloads_dir,&search_episodes(&state.db_path,&state.downloads_dir,Some(&feed),"","all","series",0,1).unwrap().episodes[0].id).unwrap();assert_eq!(detail.episode.season,Some(1));
    fs::remove_dir_all(dir).unwrap();
  }
  #[test]
  fn cached_transcripts_and_bookmarks_search_the_archive_with_timed_matches() {
    let dir=test_directory("content-search");let state=PodcastState::initialize_at(&dir).unwrap();
    let parsed=parsed_fixture_with_episode_count(260);let id=parsed.episodes[230].id.clone();let feed=parsed.feed.id.clone();
    store_subscription(&state.db_path,parsed).unwrap();let db=open_database(&state.db_path).unwrap();
    db.execute("INSERT INTO podcast_episode_resources(id,episode_id,kind,source_kind) VALUES('search-cues',?1,'transcript','podcast-transcript')",[&id]).unwrap();
    db.execute("INSERT INTO podcast_transcript_cues(resource_id,ordinal,start_ms,text) VALUES('search-cues',0,42500,'声音记忆 100%_'),('search-cues',1,NULL,'无时间的声音记忆')",[]).unwrap();
    db.execute("INSERT INTO podcast_bookmarks(id,episode_id,position_ms,label,updated_at) VALUES('search-bookmark',?1,62000,'声音记忆备注',1)",[&id]).unwrap();
    let page=search_episodes(&state.db_path,&state.downloads_dir,None,"声音记忆","all","newest",0,50).unwrap();
    assert_eq!(page.total,1);assert_eq!(page.episodes[0].id,id);assert_eq!(page.matches.len(),3);
    assert!(page.matches.iter().any(|hit|hit.kind=="bookmark"&&hit.position_seconds==Some(62.0)));
    assert!(page.matches.iter().any(|hit|hit.kind=="transcript"&&hit.position_seconds==Some(42.5)));
    assert!(page.matches.iter().any(|hit|hit.position_seconds.is_none()));
    assert_eq!(search_episodes(&state.db_path,&state.downloads_dir,None,"100%_","all","newest",0,50).unwrap().total,1);
    assert_eq!(search_episodes(&state.db_path,&state.downloads_dir,None,"100__","all","newest",0,50).unwrap().total,0);
    assert!(search_episodes(&state.db_path,&state.downloads_dir,None,"","all","newest",0,50).unwrap().matches.is_empty());
    set_following(&state.db_path,&feed,false).unwrap();
    assert_eq!(search_episodes_scoped(&state.db_path,&state.downloads_dir,None,"声音记忆","all","newest",0,50,true).unwrap().total,0);
    assert_eq!(search_episodes(&state.db_path,&state.downloads_dir,None,"声音记忆","all","newest",50,50).unwrap().total,1);
    drop(db);
    fs::remove_dir_all(dir).unwrap();
  }
  #[test]
  fn local_search_pages_the_entire_archive_and_escapes_wildcards() {
    let dir=test_directory("search");let state=PodcastState::initialize_at(&dir).unwrap();let mut parsed=parsed_fixture_with_episode_count(250);
    parsed.episodes[230].title="中文 100%_ 专题".into();let found=parsed.episodes[230].id.clone();let feed=parsed.feed.id.clone();store_subscription(&state.db_path,parsed).unwrap();
    let page=search_episodes(&state.db_path,&state.downloads_dir,Some(&feed),"100%_","all","newest",0,50).unwrap();assert_eq!(page.total,1);assert_eq!(page.episodes[0].id,found);
    let page=search_episodes(&state.db_path,&state.downloads_dir,None,"","unplayed","oldest",200,30).unwrap();assert_eq!(page.total,250);assert_eq!(page.episodes.len(),30);assert!(page.has_more);
    open_database(&state.db_path).unwrap().execute("INSERT INTO podcast_progress(episode_id,position_seconds,duration_seconds,completed,updated_at) VALUES(?1,1,1,1,1)",[found]).unwrap();
    assert_eq!(search_episodes(&state.db_path,&state.downloads_dir,None,"100%_","played","newest",0,50).unwrap().total,1);
    assert_eq!(search_episodes(&state.db_path,&state.downloads_dir,None,"","history","listened",0,50).unwrap().total,1);
    assert!(search_episodes(&state.db_path,&state.downloads_dir,None,"","all","newest; DROP TABLE podcast_feeds",0,10).is_err());
  }
  #[test]
  fn complete_listening_search_scopes_followed_shows_and_reports_last_progress_time(){
    let dir=test_directory("listening-search");let state=PodcastState::initialize_at(&dir).unwrap();let parsed=parsed_fixture("https://example.com/a.mp3");let id=parsed.episodes[0].id.clone();let feed=parsed.feed.id.clone();store_subscription(&state.db_path,parsed).unwrap();
    open_database(&state.db_path).unwrap().execute("INSERT INTO podcast_progress VALUES(?1,10,300,0,42)",[&id]).unwrap();let page=search_episodes_scoped(&state.db_path,&state.downloads_dir,None,"","in-progress","listened",0,50,false).unwrap();assert_eq!(page.total,1);assert_eq!(page.episodes[0].last_listened_at,Some(42));set_following(&state.db_path,&feed,false).unwrap();assert_eq!(search_episodes_scoped(&state.db_path,&state.downloads_dir,None,"","all","newest",0,50,true).unwrap().total,0);assert_eq!(search_episodes_scoped(&state.db_path,&state.downloads_dir,None,"","in-progress","listened",0,50,false).unwrap().total,1);
  }
}
