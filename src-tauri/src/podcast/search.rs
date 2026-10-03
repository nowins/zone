use super::*;
use rusqlite::params;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct PodcastEpisodeSearchPage {pub episodes:Vec<PodcastEpisode>,pub total:usize,pub has_more:bool}

pub(crate) fn search_episodes(path:&Path,downloads:&Path,feed:Option<&str>,query:&str,filter:&str,sort:&str,offset:usize,limit:usize)->Result<PodcastEpisodeSearchPage,String> {
  search_episodes_scoped(path,downloads,feed,query,filter,sort,offset,limit,false)
}
fn search_episodes_scoped(path:&Path,downloads:&Path,feed:Option<&str>,query:&str,filter:&str,sort:&str,offset:usize,limit:usize,followed_only:bool)->Result<PodcastEpisodeSearchPage,String> {
  if let Some(id)=feed {validate_identifier(id)?;}
  if query.chars().count()>200 {return Err("搜索文字过长".into());}
  let condition=match filter {"all"=>"1=1","unplayed"=>"COALESCE(p.completed,0)=0","in-progress"=>"p.position_seconds>0 AND p.completed=0","unstarted"=>"COALESCE(p.position_seconds,0)=0 AND COALESCE(p.completed,0)=0","played"=>"COALESCE(p.completed,0)=1","downloaded"=>"d.state='downloaded'","saved"=>"s.episode_id IS NOT NULL",_=>return Err("单集筛选无效".into())};
  let order=match sort {"newest"=>"e.published_at IS NULL,e.published_at DESC,e.id","oldest"=>"e.published_at IS NULL,e.published_at ASC,e.id","title"=>"e.title COLLATE NOCASE,e.id","listened"=>"p.updated_at IS NULL,p.updated_at DESC,e.id",_=>return Err("单集排序无效".into())};
  let pattern=format!("%{}%",query.trim().replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_"));
  let from=format!("FROM podcast_episodes e JOIN podcast_feeds f ON f.id=e.feed_id
    LEFT JOIN podcast_downloads d ON d.episode_id=e.id LEFT JOIN podcast_progress p ON p.episode_id=e.id
    LEFT JOIN podcast_saved_episodes s ON s.episode_id=e.id
    WHERE (?1 IS NULL OR e.feed_id=?1) AND {condition} AND {} AND
    (e.title LIKE ?2 ESCAPE '\\' OR COALESCE(e.description,'') LIKE ?2 ESCAPE '\\'
    OR f.title LIKE ?2 ESCAPE '\\' OR COALESCE(f.author,'') LIKE ?2 ESCAPE '\\')",if followed_only{"f.subscribed=1"}else{"1=1"});
  let db=open_database(path)?;
  let total=db.query_row(&format!("SELECT COUNT(*) {from}"),params![feed,pattern],|r|r.get::<_,i64>(0)).map_err(|e|e.to_string())?.max(0) as usize;
  let sql=format!("SELECT e.id,e.feed_id,e.title,e.description,e.published_at,
    COALESCE(NULLIF(p.duration_seconds,0),e.duration_seconds),e.enclosure_url,e.enclosure_type,e.artwork_url,
    COALESCE(d.state,'none'),d.local_path,COALESCE(d.downloaded_bytes,0),d.total_bytes,
    COALESCE(p.position_seconds,0),COALESCE(p.completed,0),f.title,f.artwork_url,
    CASE WHEN s.episode_id IS NULL THEN 0 ELSE 1 END,e.first_seen_at,e.webpage_url,p.updated_at AS last_listened_at {from} ORDER BY {order} LIMIT ?3 OFFSET ?4");
  let mut statement=db.prepare(&sql).map_err(|e|e.to_string())?;
  let episodes=statement.query_map(params![feed,pattern,limit.clamp(1,100) as i64,offset.min(200_000) as i64],|r|query::podcast_episode_from_row(r,downloads))
    .map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
  let has_more=offset.saturating_add(episodes.len())<total;Ok(PodcastEpisodeSearchPage{episodes,total,has_more})
}

#[tauri::command]
pub async fn podcast_search_episodes(state:State<'_,PodcastState>,feed_id:Option<String>,query:String,filter:String,sort:String,offset:usize,limit:usize,followed_only:Option<bool>)->Result<PodcastEpisodeSearchPage,String> {
  state.ensure_ready()?;let path=state.db_path.clone();let downloads=state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move||if followed_only.unwrap_or(false){search_episodes_scoped(&path,&downloads,feed_id.as_deref(),&query,&filter,&sort,offset,limit,true)}else{search_episodes(&path,&downloads,feed_id.as_deref(),&query,&filter,&sort,offset,limit)}).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;use crate::podcast::test_support::*;
  #[test]
  fn local_search_pages_the_entire_archive_and_escapes_wildcards() {
    let dir=test_directory("search");let state=PodcastState::initialize_at(&dir).unwrap();let mut parsed=parsed_fixture_with_episode_count(250);
    parsed.episodes[230].title="中文 100%_ 专题".into();let found=parsed.episodes[230].id.clone();let feed=parsed.feed.id.clone();store_subscription(&state.db_path,parsed).unwrap();
    let page=search_episodes(&state.db_path,&state.downloads_dir,Some(&feed),"100%_","all","newest",0,50).unwrap();assert_eq!(page.total,1);assert_eq!(page.episodes[0].id,found);
    let page=search_episodes(&state.db_path,&state.downloads_dir,None,"","unplayed","oldest",200,30).unwrap();assert_eq!(page.total,250);assert_eq!(page.episodes.len(),30);assert!(page.has_more);
    open_database(&state.db_path).unwrap().execute("INSERT INTO podcast_progress(episode_id,position_seconds,duration_seconds,completed,updated_at) VALUES(?1,1,1,1,1)",[found]).unwrap();
    assert_eq!(search_episodes(&state.db_path,&state.downloads_dir,None,"100%_","played","newest",0,50).unwrap().total,1);
    assert!(search_episodes(&state.db_path,&state.downloads_dir,None,"","all","newest; DROP TABLE podcast_feeds",0,10).is_err());
  }
  #[test]
  fn complete_listening_search_scopes_followed_shows_and_reports_last_progress_time(){
    let dir=test_directory("listening-search");let state=PodcastState::initialize_at(&dir).unwrap();let parsed=parsed_fixture("https://example.com/a.mp3");let id=parsed.episodes[0].id.clone();let feed=parsed.feed.id.clone();store_subscription(&state.db_path,parsed).unwrap();
    open_database(&state.db_path).unwrap().execute("INSERT INTO podcast_progress VALUES(?1,10,300,0,42)",[&id]).unwrap();let page=search_episodes_scoped(&state.db_path,&state.downloads_dir,None,"","in-progress","listened",0,50,false).unwrap();assert_eq!(page.total,1);assert_eq!(page.episodes[0].last_listened_at,Some(42));set_following(&state.db_path,&feed,false).unwrap();assert_eq!(search_episodes_scoped(&state.db_path,&state.downloads_dir,None,"","all","newest",0,50,true).unwrap().total,0);assert_eq!(search_episodes_scoped(&state.db_path,&state.downloads_dir,None,"","in-progress","listened",0,50,false).unwrap().total,1);
  }
}
