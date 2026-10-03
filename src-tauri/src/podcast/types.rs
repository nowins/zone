use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastSearchResult {
  pub(crate) id: String,
  pub(crate) title: String,
  pub(crate) author: String,
  pub(crate) feed_url: String,
  pub(crate) artwork_url: Option<String>,
  pub(crate) episode_count: Option<u32>,
  pub(crate) genres: Vec<String>,
  pub(crate) latest_release_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDiscoveryShow {
  pub(crate) id: String,
  pub(crate) title: String,
  pub(crate) author: String,
  pub(crate) feed_url: String,
  pub(crate) artwork_url: Option<String>,
  pub(crate) genres: Vec<String>,
  pub(crate) rank: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PodcastDiscoverySource { Xyzrank, Apple }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDiscoveryPage {
  pub(crate) shows: Vec<PodcastDiscoveryShow>,
  pub(crate) source: PodcastDiscoverySource,
  pub(crate) fetched_at: i64,
  pub(crate) stale: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastFeed {
  pub(crate) id: String,
  pub(crate) feed_url: String,
  pub(crate) title: String,
  pub(crate) author: Option<String>,
  pub(crate) description: Option<String>,
  pub(crate) artwork_url: Option<String>,
  pub(crate) last_fetched_at: i64,
  pub(crate) subscribed: bool,
  pub(crate) subscribed_at: Option<i64>,
  pub(crate) last_checked_at: Option<i64>,
  pub(crate) last_refresh_error: Option<String>,
  pub(crate) latest_episode_at: Option<i64>,
  pub(crate) unplayed_count: u64,
  /// Title of the newest episode, resolved alongside the other feed stats so
  /// surfaces like quickplay pins can show a live headline per show.
  pub(crate) latest_episode_title: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastEpisode {
  pub(crate) id: String,
  pub(crate) feed_id: String,
  pub(crate) title: String,
  pub(crate) description: Option<String>,
  pub(crate) published_at: Option<i64>,
  pub(crate) duration_seconds: Option<f64>,
  pub(crate) enclosure_url: String,
  pub(crate) enclosure_type: Option<String>,
  pub(crate) artwork_url: Option<String>,
  pub(crate) download_state: String,
  pub(crate) local_path: Option<String>,
  pub(crate) downloaded_bytes: u64,
  pub(crate) total_bytes: Option<u64>,
  pub(crate) progress_seconds: f64,
  pub(crate) last_listened_at: Option<i64>,
  pub(crate) completed: bool,
  pub(crate) feed_title: Option<String>,
  pub(crate) feed_artwork_url: Option<String>,
  pub(crate) saved: bool,
  pub(crate) first_seen_at: i64,
  pub(crate) webpage_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastEpisodeDetail {
  pub(crate) episode: PodcastEpisode,
  pub(crate) feed: PodcastFeed,
  pub(crate) expected_bytes: Option<u64>,
  pub(crate) download_error: Option<String>,
  pub(crate) saved: bool,
  pub(crate) saved_at: Option<i64>,
  pub(crate) queue_position: Option<u32>,
  pub(crate) has_chapters: bool,
  pub(crate) transcript_count: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastChapter {
  pub(crate) start_seconds: f64,
  pub(crate) end_seconds: Option<f64>,
  pub(crate) title: String,
  pub(crate) href: Option<String>,
  pub(crate) image_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastChapterDocument {
  pub(crate) episode_id: String,
  pub(crate) source_kind: String,
  pub(crate) chapters: Vec<PodcastChapter>,
  pub(crate) stale: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastQueueItem {
  pub(crate) episode: PodcastEpisode,
  pub(crate) position: u32,
  pub(crate) added_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastHome {
  pub(crate) continue_listening: Vec<PodcastEpisode>,
  pub(crate) latest_episodes: Vec<PodcastEpisode>,
  pub(crate) unplayed_episodes: Vec<PodcastEpisode>,
  pub(crate) download_priority_episodes: Vec<PodcastEpisode>,
  pub(crate) downloaded_episodes: Vec<PodcastEpisode>,
  pub(crate) saved_episodes: Vec<PodcastEpisode>,
  pub(crate) recently_played_episodes: Vec<PodcastEpisode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDownloadPage {
  pub(crate) episodes: Vec<PodcastEpisode>,
  pub(crate) total_count: u64,
  pub(crate) total_bytes: u64,
  pub(crate) feed_count: u64,
  pub(crate) has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastSubscribeResult {
  pub(crate) feed: PodcastFeed,
  pub(crate) episode_count: usize,
  pub(crate) inserted_count: usize,
  pub(crate) updated_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastRefreshFailure {
  pub(crate) feed_id: String,
  pub(crate) title: String,
  pub(crate) message: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastRefreshReport {
  pub(crate) checked: usize,
  pub(crate) not_modified: usize,
  pub(crate) inserted: usize,
  pub(crate) updated: usize,
  pub(crate) failures: Vec<PodcastRefreshFailure>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDownloadResult {
  pub(crate) episode_id: String,
  pub(crate) local_path: String,
  pub(crate) downloaded_bytes: u64,
  pub(crate) resumed: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDownloadDeleteResult {
  pub(crate) requested_count: usize,
  pub(crate) deleted_count: usize,
  pub(crate) deleted_bytes: u64,
  pub(crate) deleted_episode_ids: Vec<String>,
}
