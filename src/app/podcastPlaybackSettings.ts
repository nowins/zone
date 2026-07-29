import type { PodcastAutoQueueMode } from "../types";

export const PODCAST_PROGRESS_SAVE_INTERVAL_MS = 5_000;
export const PODCAST_PLAYBACK_SETTINGS_KEY = "zone-podcast-playback-v1";
export const PODCAST_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
export const PODCAST_AUTO_QUEUE_MODES: PodcastAutoQueueMode[] = [
  "off",
  "same-feed",
  "random-unplayed",
];

export type PodcastPlaybackSettings = {
  playbackRate: number;
  activeEpisodeId: string | null;
  autoQueueMode: PodcastAutoQueueMode;
};

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export function readPodcastPlaybackSettings(): PodcastPlaybackSettings {
  const fallback: PodcastPlaybackSettings = {
    playbackRate: 1,
    activeEpisodeId: null,
    autoQueueMode: "off",
  };
  try {
    const stored = JSON.parse(localStorage.getItem(PODCAST_PLAYBACK_SETTINGS_KEY) ?? "{}");
    return {
      playbackRate: PODCAST_PLAYBACK_RATES.includes(stored.playbackRate)
        ? stored.playbackRate
        : fallback.playbackRate,
      activeEpisodeId:
        typeof stored.activeEpisodeId === "string" && stored.activeEpisodeId.trim()
          ? stored.activeEpisodeId
          : null,
      autoQueueMode: PODCAST_AUTO_QUEUE_MODES.includes(stored.autoQueueMode)
        ? stored.autoQueueMode
        : fallback.autoQueueMode,
    };
  } catch {
    return fallback;
  }
}

export function patchPodcastPlaybackSettings(
  patch: Partial<PodcastPlaybackSettings>,
) {
  try {
    localStorage.setItem(
      PODCAST_PLAYBACK_SETTINGS_KEY,
      JSON.stringify({ ...readPodcastPlaybackSettings(), ...patch }),
    );
  } catch {
    // Playback preferences remain usable for this session when storage is blocked.
  }
}

export function readPodcastPlaybackRate(): number {
  return readPodcastPlaybackSettings().playbackRate;
}

export function readPodcastActiveEpisodeId(): string | null {
  return readPodcastPlaybackSettings().activeEpisodeId;
}

export function readPodcastAutoQueueMode(): PodcastAutoQueueMode {
  return readPodcastPlaybackSettings().autoQueueMode;
}
