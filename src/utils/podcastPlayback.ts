import type { PodcastEpisode, PodcastPlayback, PodcastQueueItem } from "../types";

export function podcastPlaybackForEpisode(episode: PodcastEpisode): PodcastPlayback {
  return {
    ...episode,
    episodeId: episode.id,
    podcastTitle: episode.feedTitle ?? "播客",
    artworkUrl: episode.artworkUrl ?? episode.feedArtworkUrl ?? null,
    savedProgressSeconds: Math.max(0, episode.progressSeconds),
    playbackLocalPath: episode.localPath,
  };
}

export function mergePodcastEpisodePlayback(
  episode: PodcastEpisode,
  activeEpisode: PodcastPlayback | null,
  progress: number,
  duration: number,
): PodcastEpisode {
  if (!activeEpisode || activeEpisode.episodeId !== episode.id) return episode;
  const liveProgress = Number.isFinite(progress)
    ? Math.max(0, progress)
    : Math.max(0, episode.progressSeconds);
  const liveDuration = Number.isFinite(duration) && duration > 0
    ? duration
    : activeEpisode.durationSeconds ?? episode.durationSeconds;
  return {
    ...episode,
    progressSeconds: liveProgress,
    durationSeconds: liveDuration,
    completed: activeEpisode.completed,
    saved: activeEpisode.saved,
    downloadState: activeEpisode.downloadState,
    localPath: activeEpisode.localPath,
    downloadedBytes: activeEpisode.downloadedBytes,
    totalBytes: activeEpisode.totalBytes,
  };
}

export function movePodcastQueueItem(
  queue: PodcastQueueItem[],
  episodeId: string,
  direction: -1 | 1,
  excludedEpisodeId?: string | null,
): PodcastQueueItem[] {
  const movableIndices = queue
    .map((item, index) => ({ id: item.episode.id, index }))
    .filter(({ id }) => id !== excludedEpisodeId);
  const visibleIndex = movableIndices.findIndex(({ id }) => id === episodeId);
  const targetVisibleIndex = visibleIndex + direction;
  if (
    visibleIndex < 0
    || targetVisibleIndex < 0
    || targetVisibleIndex >= movableIndices.length
  ) {
    return queue;
  }
  const index = movableIndices[visibleIndex].index;
  const target = movableIndices[targetVisibleIndex].index;
  const next = [...queue];
  [next[index], next[target]] = [next[target], next[index]];
  return next.map((item, position) => ({ ...item, position }));
}
