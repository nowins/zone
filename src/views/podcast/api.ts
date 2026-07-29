import { invoke } from "@tauri-apps/api/core";
import type {
  PodcastChapterDocument,
  PodcastDiscoveryShow,
  PodcastDownloadDeleteResult,
  PodcastDownloadPage,
  PodcastDownloadResult,
  PodcastEpisode,
  PodcastEpisodeDetail,
  PodcastFeed,
  PodcastHome,
  PodcastRefreshReport,
  PodcastSearchResult,
  PodcastSubscribeResult,
} from "../../types";

export function listPodcastFeeds() {
  return invoke<PodcastFeed[]>("podcast_list_feeds");
}

export function listPodcastHome() {
  return invoke<PodcastHome>("podcast_list_home");
}

export function listSavedEpisodes() {
  return invoke<PodcastEpisodeDetail[]>("podcast_list_saved_episodes");
}

export function listPodcastDownloads(offset: number, limit: number) {
  return invoke<PodcastDownloadPage>("podcast_list_downloads", {
    offset,
    limit,
  });
}

export function browseApplePodcasts(limit: number) {
  return invoke<PodcastDiscoveryShow[]>("podcast_browse_apple", { limit });
}

export function listPodcastEpisodes(feedId: string) {
  return invoke<PodcastEpisode[]>("podcast_list_episodes", { feedId });
}

export function refreshPodcastFeeds(options: {
  force?: boolean;
  feedId?: string;
}) {
  return invoke<PodcastRefreshReport>("podcast_refresh_feeds", options);
}

export function listRelatedEpisodes(episodeId: string, limit: number) {
  return invoke<PodcastEpisode[]>("podcast_list_related_episodes", {
    episodeId,
    limit,
  });
}

export function getEpisodeChapters(episodeId: string) {
  return invoke<PodcastChapterDocument>("podcast_get_episode_chapters", {
    episodeId,
  });
}

export function getEpisodeDetail(episodeId: string) {
  return invoke<PodcastEpisodeDetail>("podcast_get_episode_detail", {
    episodeId,
  });
}

export function deleteEpisodeDownloads(episodeIds: string[]) {
  return invoke<PodcastDownloadDeleteResult>(
    "podcast_delete_episode_downloads",
    { episodeIds },
  );
}

export function clearCompletedDownloads() {
  return invoke<PodcastDownloadDeleteResult>(
    "podcast_clear_completed_downloads",
  );
}

export function searchApplePodcasts(query: string, limit: number) {
  return invoke<PodcastSearchResult[]>("podcast_search_apple", {
    query,
    limit,
  });
}

export function previewPodcastFeed(feedUrl: string) {
  return invoke<PodcastSubscribeResult>("podcast_preview_feed", { feedUrl });
}

export function subscribePodcastFeed(feedUrl: string) {
  return invoke<PodcastSubscribeResult>("podcast_subscribe", { feedUrl });
}

export function setFeedFollowing(feedId: string, following: boolean) {
  return invoke("podcast_set_following", { feedId, following });
}

export function downloadPodcastEpisode(episodeId: string) {
  return invoke<PodcastDownloadResult>("podcast_download_episode", {
    episodeId,
  });
}

export function deleteEpisodeDownload(episodeId: string) {
  return invoke<PodcastEpisodeDetail>("podcast_delete_episode_download", {
    episodeId,
  });
}

export function setEpisodeSaved(episodeId: string, saved: boolean) {
  return invoke<PodcastEpisodeDetail>("podcast_set_episode_saved", {
    episodeId,
    saved,
  });
}
