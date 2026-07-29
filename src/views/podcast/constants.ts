import type { PodcastDiscoverySort } from "../../utils/podcastDiscovery";
import type { PodcastLibrarySort } from "../../utils/podcastLibrary";
import type { PodcastListenFilter } from "../../utils/podcastListening";
import type {
  PodcastAutoQueueMode,
  PodcastDownloadPage,
  PodcastHome,
} from "../../types";
import type { PodcastDiscoveryTopic } from "./types";

export const EMPTY_HOME: PodcastHome = {
  continueListening: [],
  latestEpisodes: [],
  unplayedEpisodes: [],
  downloadPriorityEpisodes: [],
  downloadedEpisodes: [],
  savedEpisodes: [],
  recentlyPlayedEpisodes: [],
};
export const EMPTY_DOWNLOAD_PAGE: PodcastDownloadPage = {
  episodes: [],
  totalCount: 0,
  totalBytes: 0,
  feedCount: 0,
  hasMore: false,
};
export const DISCOVERY_CACHE_TTL_MS = 15 * 60 * 1_000;
export const SEARCH_CACHE_TTL_MS = 15 * 60 * 1_000;
export const PREVIEW_FEED_CACHE_TTL_MS = 30 * 60 * 1_000;
export const CHAPTER_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
export const STALE_CHAPTER_CACHE_TTL_MS = 5 * 60 * 1_000;
export const SEARCH_CACHE_LIMIT = 24;
export const CHAPTER_MEMORY_CACHE_LIMIT = 64;
export const PODCAST_DISCOVERY_STORAGE_KEY = "zone-podcast-discovery-v1";
export const PODCAST_LIBRARY_STORAGE_KEY = "zone-podcast-library-v1";
export const PODCAST_DOWNLOAD_PAGE_SIZE = 60;
export const PODCAST_DOWNLOAD_BATCH_LIMIT = 500;
export const PODCAST_DOWNLOAD_PROGRESS_POLL_MS = 800;
export const PODCAST_QUEUE_BATCH_LIMIT = 500;
export const PODCAST_AUTO_QUEUE_MODES: Array<{
  id: PodcastAutoQueueMode;
  label: string;
}> = [
  { id: "off", label: "停止" },
  { id: "same-feed", label: "同节目下一集" },
  { id: "random-unplayed", label: "随机未听" },
];
export const PODCAST_LISTEN_FILTERS: Array<{
  id: PodcastListenFilter;
  label: string;
}> = [
  { id: "recent", label: "最近更新" },
  { id: "unplayed", label: "未收听" },
  { id: "download-first", label: "下载优先" },
];
export const PODCAST_LIBRARY_SORTS: Array<{
  id: PodcastLibrarySort;
  label: string;
}> = [
  { id: "recent", label: "最近更新" },
  { id: "name", label: "名称" },
  { id: "custom", label: "手动排序" },
];
export const PODCAST_DISCOVERY_TOPICS: Array<{
  id: PodcastDiscoveryTopic;
  label: string;
  query?: string;
}> = [
  { id: "popular", label: "热门" },
  { id: "business", label: "商业", query: "商业" },
  { id: "technology", label: "科技", query: "科技" },
  { id: "humanities", label: "人文", query: "人文" },
  { id: "english", label: "英语", query: "英语" },
];
export const PODCAST_DISCOVERY_SORTS: Array<{
  id: PodcastDiscoverySort;
  label: string;
}> = [
  { id: "relevance", label: "相关性" },
  { id: "recent", label: "最近更新" },
  { id: "episodes", label: "单集数量" },
];
