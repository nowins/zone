import type {
  PodcastAutoQueueMode,
  PodcastPlayback,
  PodcastPlaybackStatus,
  PodcastSleepTimer,
} from "../types";

/** Resume position applied after media metadata is ready. */
export type PodcastPendingResume = {
  episodeId: string;
  position: number;
  explicit?: boolean;
};

/**
 * Narrow bridge that `usePlaybackControls` may touch.
 * Queue CRUD and other product actions stay on the public podcast API.
 */
export type PodcastTransportBridge = {
  activePodcastEpisode: PodcastPlayback | null;
  podcastAudioEpisodeRef: React.MutableRefObject<string | null>;
  podcastPlaybackStartedEpisodeRef: React.MutableRefObject<string | null>;
  podcastAutoQueueModeRef: React.MutableRefObject<PodcastAutoQueueMode>;
  podcastPlaybackRate: number;
  podcastSessionHydrated: boolean;
  podcastSleepTimer: PodcastSleepTimer;

  setPodcastPlaybackStatus: (status: PodcastPlaybackStatus) => void;
  setPodcastSleepTimer: React.Dispatch<React.SetStateAction<PodcastSleepTimer>>;
  cancelPodcastSessionRestore: () => void;
  clearActivePodcast: () => void;
  markEpisodeCompletedOnEnd: (endedDuration: number) => void;
  bumpLibraryRevision: () => void;
  resumePodcastProgressWrites: (episodeId: string) => void;
  persistPodcastProgress: (
    currentTime: number,
    trackDuration: number,
    force?: boolean,
  ) => Promise<void>;
  flushPodcastProgress: () => Promise<void>;
  consumePendingPodcastQueueEpisode: (episodeId: string) => void;
  cancelPendingQueueConsume: () => void;
  playNextPodcastEpisode: (showEmptyNotice?: boolean) => boolean;
  autofillPodcastQueueAfter: (endedEpisodeId: string) => void;
};
