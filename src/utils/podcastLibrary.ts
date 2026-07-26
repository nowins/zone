import type { PodcastEpisode, PodcastFeed } from "../types.js";

export type PodcastLibrarySort = "recent" | "name" | "custom";

export type PodcastDownloadGroup = {
  feedId: string;
  feedTitle: string;
  artworkUrl: string | null;
  episodes: PodcastEpisode[];
  downloadedBytes: number;
};

function timestamp(value: number | null | undefined): number {
  return Number.isFinite(value) ? value! : Number.NEGATIVE_INFINITY;
}

function compareFeedNames(left: PodcastFeed, right: PodcastFeed): number {
  const titleComparison = left.title.localeCompare(right.title, "zh-Hans-CN", {
    sensitivity: "base",
    numeric: true,
  });
  return titleComparison || left.id.localeCompare(right.id);
}

export function normalizePodcastFeedOrder(
  feedIds: readonly string[],
  feeds: readonly PodcastFeed[],
): string[] {
  const known = new Set(feeds.map((feed) => feed.id));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const feedId of feedIds) {
    if (!known.has(feedId) || seen.has(feedId)) continue;
    seen.add(feedId);
    result.push(feedId);
  }
  for (const feed of feeds) {
    if (seen.has(feed.id)) continue;
    seen.add(feed.id);
    result.push(feed.id);
  }
  return result;
}

export function movePodcastFeedOrder(
  feedIds: readonly string[],
  movedId: string,
  targetId: string,
): string[] {
  if (movedId === targetId) return [...feedIds];
  const sourceIndex = feedIds.indexOf(movedId);
  const targetIndex = feedIds.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return [...feedIds];
  const result = [...feedIds];
  const [moved] = result.splice(sourceIndex, 1);
  result.splice(targetIndex, 0, moved);
  return result;
}

export function sortPodcastFeeds(
  feeds: readonly PodcastFeed[],
  sort: PodcastLibrarySort,
  customOrder: readonly string[] = [],
): PodcastFeed[] {
  const order = new Map(
    normalizePodcastFeedOrder(customOrder, feeds).map((feedId, index) => [
      feedId,
      index,
    ]),
  );
  return [...feeds].sort((left, right) => {
    if (sort === "custom") {
      const orderDifference = order.get(left.id)! - order.get(right.id)!;
      if (orderDifference !== 0) return orderDifference;
    }
    if (sort === "recent") {
      const leftTimestamp = timestamp(left.latestEpisodeAt);
      const rightTimestamp = timestamp(right.latestEpisodeAt);
      if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp > leftTimestamp ? 1 : -1;
      }
    }
    return compareFeedNames(left, right);
  });
}

export function groupPodcastDownloads(
  episodes: readonly PodcastEpisode[],
): PodcastDownloadGroup[] {
  const groups = new Map<string, PodcastDownloadGroup>();
  for (const episode of episodes) {
    const existing = groups.get(episode.feedId);
    if (existing) {
      existing.episodes.push(episode);
      existing.downloadedBytes += Math.max(0, episode.downloadedBytes);
      existing.artworkUrl ??=
        episode.feedArtworkUrl ?? episode.artworkUrl ?? null;
      continue;
    }
    groups.set(episode.feedId, {
      feedId: episode.feedId,
      feedTitle: episode.feedTitle || "未知节目",
      artworkUrl: episode.feedArtworkUrl ?? episode.artworkUrl ?? null,
      episodes: [episode],
      downloadedBytes: Math.max(0, episode.downloadedBytes),
    });
  }
  return [...groups.values()];
}

export function podcastDownloadedBytes(
  episodes: readonly Pick<PodcastEpisode, "downloadedBytes">[],
): number {
  return episodes.reduce(
    (total, episode) => total + Math.max(0, episode.downloadedBytes),
    0,
  );
}
