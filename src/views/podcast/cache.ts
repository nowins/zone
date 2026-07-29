import type {
  PodcastChapterDocument,
  PodcastDiscoveryShow,
  PodcastFeed,
  PodcastSearchResult,
} from "../../types";
import type { PodcastSessionSnapshot } from "./types";

export let discoveryCache: {
  shows: PodcastDiscoveryShow[];
  fetchedAt: number;
} | null = null;
export const searchCache = new Map<
  string,
  { results: PodcastSearchResult[]; fetchedAt: number }
>();
export const previewFeedCache = new Map<
  string,
  { value: PodcastFeed; fetchedAt: number }
>();
export const chapterDocumentCache = new Map<
  string,
  { value: PodcastChapterDocument; fetchedAt: number }
>();
export let podcastSessionSnapshot: PodcastSessionSnapshot | null = null;

export function setDiscoveryCache(
  next: { shows: PodcastDiscoveryShow[]; fetchedAt: number } | null,
) {
  discoveryCache = next;
}

export function setPodcastSessionSnapshot(
  next: PodcastSessionSnapshot | null,
) {
  podcastSessionSnapshot = next;
}

export function rememberBoundedCacheEntry<Key, Value>(
  cache: Map<Key, Value>,
  key: Key,
  value: Value,
  limit: number,
) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function cacheEntryIsFresh(
  entry: { fetchedAt: number } | undefined,
  ttlMs: number,
  now = Date.now(),
) {
  return Boolean(entry && now - entry.fetchedAt < ttlMs);
}
