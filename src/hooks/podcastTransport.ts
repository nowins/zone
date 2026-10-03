import type {
  PodcastPlayback,
  PodcastPlaybackStatus,
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
  podcastPlaybackRate: number;
  podcastSessionHydrated: boolean;
  podcastPreferencesReady?: boolean;
  resolvePodcastIntro?: (position:number,duration:number,explicit:boolean)=>number;
  handlePodcastClock?: (position:number,duration:number)=>boolean;
  expireSleepTimer?: () => boolean;

  setPodcastPlaybackStatus: (status: PodcastPlaybackStatus) => void;
  cancelPodcastSessionRestore: () => void;
  clearActivePodcast: () => void;
  resumePodcastProgressWrites: (episodeId: string) => void;
  persistPodcastProgress: (
    currentTime: number,
    trackDuration: number,
    force?: boolean,
  ) => Promise<void>;
  flushPodcastProgress: () => Promise<void>;
  consumePendingPodcastQueueEpisode: (
    episodeId: string,
    audioEpisodeId: string | null,
  ) => void;
  cancelPendingQueueConsume: () => void;
  /** Invalidate deferred continuation without discarding committed queue items. */
  cancelPendingPodcastAutofill: () => void;
  handleEpisodeEnded: (audioDuration: number) => void;
};
