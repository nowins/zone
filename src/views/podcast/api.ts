import { invoke } from "@tauri-apps/api/core";
import { cancelPodcastNetworkRequest, newPodcastNetworkRequestId } from "../../utils/podcastNetwork.js";
export type { PodcastPreferences } from "../../utils/podcastPreferences.js";
import type { PodcastPreferences } from "../../utils/podcastPreferences.js";
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

export type PodcastDownloadJob = {
  episodeId: string; title: string; state: "queued" | "running" | "paused" | "failed";
  attempts: number; error: string | null; downloadedBytes: number; totalBytes: number | null;
};
export const getPodcastPreferences = (feedId?: string) => invoke<PodcastPreferences>("podcast_get_preferences", { feedId });
export const setPodcastPreferences = (preferences: PodcastPreferences, feedId?: string) => invoke<void>("podcast_set_preferences", { feedId, preferences });
export const listDownloadJobs = () => invoke<PodcastDownloadJob[]>("podcast_list_download_jobs");
export const enqueueDownload = (episodeId: string) => invoke<void>("podcast_enqueue_download", { episodeId });
export const pauseDownloadJob = (episodeId: string) => invoke<void>("podcast_pause_download_job", { episodeId });
export const clearDownloadPartial = (episodeId: string) => invoke<void>("podcast_clear_download_partial", { episodeId });

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

export type EpisodeSearchPage = { episodes: PodcastEpisode[]; total: number; hasMore: boolean };
export const searchLocalEpisodes = (options: { feedId?: string; query: string; filter: string; sort: string; offset: number; limit: number }) =>
  invoke<EpisodeSearchPage>("podcast_search_episodes", options);

export async function searchCatalogPodcasts(query: string): Promise<PodcastSearchResult[]> {
  const feeds = await listPodcastFeeds().catch(() => []);
  const cached = await loadPodcastDiscoveryCache().catch(() => null);
  const catalog = cached ?? await browsePodcastDiscovery().catch(() => null);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/);
  const candidates: PodcastSearchResult[] = [...feeds.map(feed => ({ ...feed, author: feed.author ?? "", genres: [] })), ...(catalog?.shows ?? [])];
  const seen = new Set<string>();
  return candidates.filter(show => {
    const matches = terms.every(term => `${show.title} ${show.author ?? ""} ${show.genres.join(" ")}`.toLocaleLowerCase().includes(term));
    if (!matches || seen.has(show.feedUrl)) return false;
    seen.add(show.feedUrl); return true;
  }).map(show => ({ ...show, author: show.author ?? "" }));
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

export type TranscriptCue = {startSeconds:number|null;endSeconds:number|null;text:string;speaker:string|null};
export type TranscriptDocument = {episodeId:string;language:string|null;cues:TranscriptCue[];stale:boolean};
export const getTranscript = (episodeId:string) => invokeNetwork<TranscriptDocument>("transcript","podcast_get_transcript",{episodeId});
export const openPodcastLink = (url:string) => invoke<void>("podcast_open_link",{url});

export type PodcastPlaylistRules = { filter: string; sort: string; feedIds: string[]; maxAgeDays: number | null };
export type PodcastPlaylist = { id: string; name: string; kind: "manual" | "smart"; rules: PodcastPlaylistRules; updatedAt: number };
export const listPodcastPlaylists = () => invoke<PodcastPlaylist[]>("podcast_list_playlists");
export const savePodcastPlaylist = (list: {id?: string; name: string; kind: string; rules: PodcastPlaylistRules; expectedUpdatedAt?: number}) => invoke<PodcastPlaylist>("podcast_save_playlist", list);
export const deletePodcastPlaylist = (id: string) => invoke<void>("podcast_delete_playlist", { id });
export const podcastPlaylistPage = (id: string, offset: number, limit = 50) => invoke<EpisodeSearchPage>("podcast_playlist_page", { id, offset, limit });
export const updatePlaylistItem = (id: string, episodeId: string, add: boolean) => invoke<void>("podcast_update_playlist_item", { id, episodeId, add });
export const reorderPodcastPlaylist = (id: string, episodeIds: string[]) => invoke<void>("podcast_reorder_playlist", { id, episodeIds });
export type PodcastShowGroup = { id: string; name: string; feedIds: string[]; updatedAt: number };
export const listShowGroups = () => invoke<PodcastShowGroup[]>("podcast_list_show_groups");
export const saveShowGroup = (group: {id?: string; name: string; feedIds: string[]; expectedUpdatedAt?: number}) => invoke<PodcastShowGroup>("podcast_save_show_group", group);
export const deleteShowGroup = (id: string) => invoke<void>("podcast_delete_show_group", {id});

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

export type PodcastBookmark = { id: string; positionSeconds: number; label: string };
export const listEpisodeBookmarks = (episodeId: string) => invoke<PodcastBookmark[]>("podcast_list_bookmarks", { episodeId });
export const addEpisodeBookmark = (episodeId: string, positionSeconds: number, label: string) => invoke<PodcastBookmark[]>("podcast_add_bookmark", { episodeId, positionSeconds, label });
export const removeEpisodeBookmark = (episodeId: string, bookmarkId: string) => invoke<PodcastBookmark[]>("podcast_remove_bookmark", { episodeId, bookmarkId });
