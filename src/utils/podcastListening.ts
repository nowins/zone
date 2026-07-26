import type { PodcastEpisode } from "../types.js";

export type PodcastListenFilter = "recent" | "unplayed" | "download-first";

const PODCAST_NEW_WINDOW_MS = 24 * 60 * 60 * 1000;

function episodeRecency(episode: PodcastEpisode): number {
  const timestamp = episode.publishedAt ?? episode.firstSeenAt;
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function comparePodcastRecency(
  left: PodcastEpisode,
  right: PodcastEpisode,
): number {
  return episodeRecency(right) - episodeRecency(left);
}

function isAvailableOffline(episode: PodcastEpisode): boolean {
  return episode.downloadState === "downloaded" && Boolean(episode.localPath);
}

export function filterPodcastListeningEpisodes(
  episodes: readonly PodcastEpisode[],
  filter: PodcastListenFilter,
): PodcastEpisode[] {
  const candidates =
    filter === "unplayed"
      ? episodes.filter(
          (episode) => !episode.completed && episode.progressSeconds <= 0,
        )
      : [...episodes];

  return candidates.sort((left, right) => {
    if (filter === "download-first") {
      const offlineDifference =
        Number(isAvailableOffline(right)) - Number(isAvailableOffline(left));
      if (offlineDifference !== 0) return offlineDifference;
    }
    return comparePodcastRecency(left, right);
  });
}

export function isPodcastEpisodeNew(
  episode: PodcastEpisode,
  subscribedAt: number | null | undefined,
  now = Date.now(),
): boolean {
  if (episode.completed) return false;
  if (!Number.isFinite(subscribedAt) || !Number.isFinite(now)) return false;
  if (!Number.isFinite(episode.firstSeenAt)) return false;

  const subscriptionTime = subscribedAt as number;
  if (
    episode.firstSeenAt <= subscriptionTime ||
    episode.firstSeenAt > now
  ) {
    return false;
  }

  const releaseTime = episode.publishedAt ?? episode.firstSeenAt;
  if (!Number.isFinite(releaseTime) || releaseTime > now) return false;

  return now - releaseTime <= PODCAST_NEW_WINDOW_MS;
}

export function podcastEpisodePlayedPercent(
  episode: Pick<
    PodcastEpisode,
    "completed" | "durationSeconds" | "progressSeconds"
  >,
): number | null {
  if (episode.completed) return 100;

  const duration = episode.durationSeconds;
  const progress = episode.progressSeconds;
  if (
    !Number.isFinite(duration) ||
    !Number.isFinite(progress) ||
    (duration ?? 0) <= 0 ||
    progress <= 0
  ) {
    return null;
  }

  return Math.min(99, Math.max(1, Math.round((progress / duration!) * 100)));
}
