use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

mod apple;
mod artwork_protocol;
mod chapters;
mod commands;
mod downloads;
mod feed_parse;
mod network;
mod proxy;
mod tasks;
mod query;
mod queue;
mod session;
mod store;
mod stream_protocol;
mod types;
mod util;
#[cfg(test)]
pub(crate) mod test_support;

pub use artwork_protocol::serve_podcast_artwork_protocol;
pub(crate) use artwork_protocol::cache_podcast_artwork_file;
pub use commands::*;
pub use session::*;
pub use stream_protocol::serve_podcast_stream_protocol;
pub use types::*;

pub(crate) use apple::*;
pub(crate) use chapters::*;
pub(crate) use downloads::*;
pub(crate) use feed_parse::*;
pub(crate) use network::*;
pub(crate) use tasks::*;
pub(crate) use query::*;
pub(crate) use queue::*;
pub(crate) use store::*;
#[cfg(test)]
pub(crate) use stream_protocol::*;
pub(crate) use util::*;

pub(crate) const APPLE_SEARCH_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
pub(crate) const APPLE_DISCOVERY_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
pub(crate) const APPLE_DISCOVERY_MAX_RESULTS: u8 = 50;
pub(crate) const PODCAST_FEED_RESPONSE_LIMIT: usize = 20 * 1024 * 1024;
pub(crate) const PODCAST_CHAPTER_RESPONSE_LIMIT: usize = 1024 * 1024;
pub(crate) const PODCAST_CHAPTER_MAX_COUNT: usize = 1_000;
pub(crate) const PODCAST_TRANSCRIPT_SOURCE_MAX_COUNT: usize = 16;
pub(crate) const PODCAST_ARTWORK_RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
pub(crate) const PODCAST_ARTWORK_URL_LIMIT: usize = 4 * 1024;
pub(crate) const PODCAST_ARTWORK_TOKEN_LIMIT: usize = 6 * 1024;
pub(crate) const PODCAST_AUDIO_RESPONSE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
pub(crate) const PODCAST_STREAM_CHUNK_SIZE: u64 = 1024 * 1024;
pub(crate) const PODCAST_DOWNLOAD_PROGRESS_BYTE_INTERVAL: u64 = 2 * 1024 * 1024;
pub(crate) const PODCAST_DOWNLOAD_PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(500);
pub(crate) const PODCAST_DOWNLOAD_PROGRESS_MAX_INTERVAL: Duration = Duration::from_secs(2);
pub(crate) const PODCAST_REDIRECT_LIMIT: usize = 5;
pub(crate) const PODCAST_DESCRIPTION_LIMIT: usize = 20_000;
pub(crate) const PODCAST_TITLE_LIMIT: usize = 500;
pub(crate) const PODCAST_STREAM_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const PODCAST_ARTWORK_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const PODCAST_CHAPTER_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const PODCAST_HOME_CONTINUE_LIMIT: usize = 12;
pub(crate) const PODCAST_HOME_LATEST_LIMIT: usize = 40;
pub(crate) const PODCAST_HOME_UNPLAYED_LIMIT: usize = 40;
pub(crate) const PODCAST_HOME_DOWNLOAD_PRIORITY_LIMIT: usize = 40;
pub(crate) const PODCAST_HOME_DOWNLOADED_LIMIT: usize = 40;
pub(crate) const PODCAST_HOME_SAVED_LIMIT: usize = 40;
pub(crate) const PODCAST_HOME_RECENTLY_PLAYED_LIMIT: usize = 40;
pub(crate) const PODCAST_RELATED_EPISODE_DEFAULT_LIMIT: usize = 6;
pub(crate) const PODCAST_RELATED_EPISODE_MAX_LIMIT: usize = 12;
pub(crate) const PODCAST_DOWNLOAD_PAGE_MAX_LIMIT: usize = 100;
pub(crate) const PODCAST_DOWNLOAD_DELETE_LIMIT: usize = 500;
pub(crate) const PODCAST_EPISODE_BATCH_LIMIT: usize = 500;
pub(crate) const PODCAST_QUEUE_LIMIT: usize = 500;
pub(crate) const PODCAST_REFRESH_CONCURRENCY: usize = 3;
pub(crate) const PODCAST_REFRESH_INTERVAL: i64 = 30 * 60 * 1_000;
pub(crate) const PODCAST_CHAPTER_REFRESH_INTERVAL: i64 = 6 * 60 * 60 * 1_000;
pub(crate) const PODCAST_SYNTHETIC_ID_PREFIX: &str = "zone-generated:";
pub(crate) const PODCAST_NAMESPACE_URI: &[u8] = b"https://podcastindex.org/namespace/1.0";
pub(crate) const PODCAST_NAMESPACE_COMPAT_URI: &[u8] =
  b"https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md";
pub(crate) const PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI: &[u8] =
  b"http://podlove.org/simple-chapters";
pub(crate) const USER_AGENT: &str = "Zone/0.1 (local podcast player)";

#[derive(Clone, Debug)]
pub struct PodcastState {
  db_path: PathBuf,
  downloads_dir: PathBuf,
  artwork_cache_dir: PathBuf,
  active_downloads: Arc<Mutex<HashSet<String>>>,
  active_refreshes: Arc<Mutex<HashSet<String>>>,
  refresh_semaphore: Arc<tokio::sync::Semaphore>,
  initialization_error: Option<String>,
}

impl PodcastState {
  pub fn initialize(app: &AppHandle) -> Result<Self, String> {
    let app_data_dir = app
      .path()
      .app_data_dir()
      .map_err(|error| format!("无法定位播客数据目录：{error}"))?;
    let artwork_cache_dir = app
      .path()
      .app_cache_dir()
      .map(|dir| dir.join("podcast-artwork"))
      .unwrap_or_else(|_| app_data_dir.join("podcast-artwork"));
    Self::initialize_at_with_artwork_cache(&app_data_dir, artwork_cache_dir)
  }

  #[cfg(test)]
  pub(crate) fn initialize_at(app_data_dir: &Path) -> Result<Self, String> {
    Self::initialize_at_with_artwork_cache(app_data_dir, app_data_dir.join("podcast-artwork"))
  }

  pub(crate) fn initialize_at_with_artwork_cache(
    app_data_dir: &Path,
    artwork_cache_dir: PathBuf,
  ) -> Result<Self, String> {
    fs::create_dir_all(app_data_dir).map_err(|error| format!("无法创建播客数据目录：{error}"))?;
    let db_path = crate::db::initialize_zone_database(app_data_dir)?;
    let downloads_dir = podcast_downloads_dir_for_db(&db_path);
    fs::create_dir_all(&downloads_dir).map_err(|error| format!("无法创建播客下载目录：{error}"))?;
    fs::create_dir_all(&artwork_cache_dir).map_err(|error| format!("无法创建播客封面缓存目录：{error}"))?;
    let _ = open_database(&db_path)?;
    if let Err(error) = sweep_orphan_download_files(&db_path, &downloads_dir) {
      eprintln!("[podcast] 无法清理播客遗留下载文件：{error}");
    }
    let active_downloads = episode_file_operations(&db_path)?;
    Ok(Self {
      db_path,
      downloads_dir,
      artwork_cache_dir,
      active_downloads,
      active_refreshes: Arc::new(Mutex::new(HashSet::new())),
      refresh_semaphore: Arc::new(tokio::sync::Semaphore::new(PODCAST_REFRESH_CONCURRENCY)),
      initialization_error: None,
    })
  }

  pub fn unavailable(error: String) -> Self {
    Self {
      db_path: PathBuf::new(),
      downloads_dir: PathBuf::new(),
      artwork_cache_dir: PathBuf::new(),
      active_downloads: Arc::new(Mutex::new(HashSet::new())),
      active_refreshes: Arc::new(Mutex::new(HashSet::new())),
      refresh_semaphore: Arc::new(tokio::sync::Semaphore::new(PODCAST_REFRESH_CONCURRENCY)),
      initialization_error: Some(error),
    }
  }

  pub(crate) fn ensure_ready(&self) -> Result<(), String> {
    if let Some(error) = self.initialization_error.as_deref() {
      Err(format!("播客功能初始化失败：{error}"))
    } else {
      Ok(())
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;

  #[test]
  fn refresh_semaphore_caps_work_across_shared_state_clones() {
    let directory = test_directory("refresh-semaphore");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let cloned = state.clone();
    let mut permits = (0..PODCAST_REFRESH_CONCURRENCY)
      .map(|_| {
        state
          .refresh_semaphore
          .clone()
          .try_acquire_owned()
          .expect("acquire refresh permit")
      })
      .collect::<Vec<_>>();
    assert_eq!(cloned.refresh_semaphore.available_permits(), 0);
    assert!(cloned.refresh_semaphore.clone().try_acquire_owned().is_err());
    permits.pop();
    assert_eq!(cloned.refresh_semaphore.available_permits(), 1);
    assert!(cloned.refresh_semaphore.clone().try_acquire_owned().is_ok());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
}

