import type { PodcastEpisode } from "../../types";
import type { RootPodcastScreen } from "./types";

export function rootScreenLabel(screen: RootPodcastScreen) {
  if (screen === "listen") return "收听";
  if (screen === "discover") return "发现";
  if (screen === "library") return "资料库";
  return "播放列表";
}

export function upsertEpisode(
  episodes: PodcastEpisode[],
  nextEpisode: PodcastEpisode,
) {
  const found = episodes.some((episode) => episode.id === nextEpisode.id);
  return found
    ? episodes.map((episode) =>
      episode.id === nextEpisode.id ? nextEpisode : episode)
    : [nextEpisode, ...episodes];
}

export function promoteEpisode(
  episodes: PodcastEpisode[],
  nextEpisode: PodcastEpisode,
) {
  return [
    nextEpisode,
    ...episodes.filter((episode) => episode.id !== nextEpisode.id),
  ];
}

export function deduplicateEpisodes(episodes: PodcastEpisode[]) {
  const seen = new Set<string>();
  return episodes.filter((episode) => {
    if (seen.has(episode.id)) return false;
    seen.add(episode.id);
    return true;
  });
}

export function clearPodcastEpisodeDownload(
  episode: PodcastEpisode,
): PodcastEpisode {
  return {
    ...episode,
    downloadState: "none",
    localPath: null,
    downloadedBytes: 0,
    totalBytes: null,
  };
}
