import { invoke } from "@tauri-apps/api/core";
import { cancelPodcastNetworkRequest, newPodcastNetworkRequestId } from "../../utils/podcastNetwork.js";
import type {
  PodcastChapterDocument,
  PodcastDiscoveryShow,
  PodcastDiscoveryPage,
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

const networkRequests = new Map<string, string>();
const downloadPromises = new Map<string, Promise<PodcastDownloadResult>>();
const downloadListeners = new Set<() => void>();
function notifyDownloads() { for (const listener of downloadListeners) listener(); }
export function getActivePodcastDownloadId() {
  const key = Array.from(networkRequests.keys()).find(key => key.startsWith("download-"));
  return key?.slice("download-".length) ?? null;
}
export function subscribePodcastDownloads(listener: () => void) {
  downloadListeners.add(listener);
  return () => { downloadListeners.delete(listener); };
}
export function cancelPodcastRequest(key: string) {
  const requestId = networkRequests.get(key);
  if (requestId) {
    return cancelPodcastNetworkRequest(requestId);
  }
  return Promise.resolve();
}
export function cancelPodcastViewRequests() {
  for (const key of networkRequests.keys()) {
    if (!key.startsWith("download-")) void cancelPodcastRequest(key).catch(() => {});
  }
}
function invokeNetwork<T>(key: string, command: string, args: Record<string, unknown>) {
  void cancelPodcastRequest(key).catch(() => {});
  const requestId = newPodcastNetworkRequestId();
  networkRequests.set(key, requestId);
  notifyDownloads();
  return invoke<T>(command, { ...args, requestId }).finally(() => {
    if (networkRequests.get(key) === requestId) {
      networkRequests.delete(key);
      notifyDownloads();
    }
  });
}

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
  return invokeNetwork<PodcastDiscoveryShow[]>("browse", "podcast_browse_apple", { limit });
}

export function browsePodcastDiscovery() {
  return invokeNetwork<PodcastDiscoveryPage>("browse", "podcast_browse_discovery", {});
}

export function loadPodcastDiscoveryCache() {
  return invoke<PodcastDiscoveryPage | null>("podcast_load_discovery_cache");
}

export function listPodcastEpisodes(feedId: string, offset = 0, limit = 100) {
  return invoke<PodcastEpisode[]>("podcast_list_episodes", { feedId, offset, limit });
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
  return invokeNetwork<PodcastChapterDocument>("chapters", "podcast_get_episode_chapters", {
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
  return invokeNetwork<PodcastSearchResult[]>("search", "podcast_search_apple", {
    query,
    limit,
  });
}

export function previewPodcastFeed(feedUrl: string) {
  return invokeNetwork<PodcastSubscribeResult>("preview", "podcast_preview_feed", { feedUrl });
}

export function subscribePodcastFeed(feedUrl: string) {
  return invoke<PodcastSubscribeResult>("podcast_subscribe", { feedUrl });
}

export function setFeedFollowing(feedId: string, following: boolean) {
  return invoke("podcast_set_following", { feedId, following });
}

export function downloadPodcastEpisode(episodeId: string) {
  const existing = downloadPromises.get(episodeId);
  if (existing) return existing;
  const pending = invokeNetwork<PodcastDownloadResult>(`download-${episodeId}`, "podcast_download_episode", {
    episodeId,
  }).finally(() => {
    if (downloadPromises.get(episodeId) === pending) downloadPromises.delete(episodeId);
  });
  downloadPromises.set(episodeId, pending);
  return pending;
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
