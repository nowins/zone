import type { PodcastDiscoverySort } from "../../utils/podcastDiscovery";
import type { PodcastListenFilter } from "../../utils/podcastListening";
import type {
  PodcastAutoQueueMode,
  PodcastEpisode,
  PodcastEpisodeDetail,
  PodcastFeed,
  PodcastPlayback,
  PodcastQueueItem,
  PodcastSearchResult,
} from "../../types";

export type RequestState = "idle" | "loading" | "ready" | "error";
export type PodcastScreen =
  | "listen"
  | "discover"
  | "library"
  | "playlist"
  | "show"
  | "episode";
export type RootPodcastScreen = Exclude<PodcastScreen, "show" | "episode">;
export type EpisodeOriginScreen = Exclude<PodcastScreen, "episode">;
export type EpisodeRequest = {
  episodeId: string;
  nonce: number;
  returnToNowPlaying?: boolean;
};
// quickplay 固定磁贴的深链入口：feed 是磁贴按下时已知的节目快照，避免
// 未关注节目在资料库列表之外时无法定位。
export type PodcastFeedRequest = {
  feedId: string;
  feed?: PodcastFeed;
  nonce: number;
};
export type ShowCandidate = Pick<
  PodcastSearchResult,
  "id" | "title" | "author" | "feedUrl" | "artworkUrl"
>;
export type PodcastDownloadCleanupIntent =
  | {
    kind: "selected";
    episodeIds: string[];
    downloadedBytes: number;
  }
  | {
    kind: "completed";
  };
export type PodcastQueueDropPlacement = "before" | "after";
export type PodcastQueueDropTarget = {
  episodeId: string;
  placement: PodcastQueueDropPlacement;
};
export type PodcastQueueRemovalIntent = {
  episodeIds: string[];
};
export type PodcastDiscoveryTopic =
  | "popular"
  | "business"
  | "technology"
  | "humanities"
  | "english";

export type PodcastViewProps = {
  queueRequest?: number;
  onQueueRequestHandled?: (nonce: number) => void;
  queue: PodcastQueueItem[];
  autoQueueMode: PodcastAutoQueueMode;
  activeEpisode: PodcastPlayback | null;
  activeEpisodeId: string | null;
  activeProgress: number;
  activeDuration: number;
  libraryRevision: number;
  episodeRequest: EpisodeRequest | null;
  onEpisodeRequestHandled: (nonce: number) => void;
  feedRequest: PodcastFeedRequest | null;
  onFeedRequestHandled: (nonce: number) => void;
  pinnedPodcastFeedIds: ReadonlySet<string>;
  onTogglePodcastPin: (feed: PodcastFeed) => void;
  onReturnToNowPlaying: () => void;
  isPlaying: boolean;
  onPlayEpisode: (episode: PodcastPlayback) => void;
  onPlayPlaylist?: (id: string) => Promise<void>;
  onPlayEpisodeAt: (episode: PodcastPlayback, positionSeconds: number) => void;
  onQueueEpisode: (
    episode: PodcastEpisode,
    playNext: boolean,
  ) => boolean | Promise<boolean>;
  onRemoveQueueEpisode: (episodeId: string) => void | Promise<void>;
  onMoveQueueEpisode: (
    episodeId: string,
    direction: -1 | 1,
  ) => void | Promise<void>;
  onReorderQueueEpisode: (
    episodeId: string,
    targetEpisodeId: string,
    placement: PodcastQueueDropPlacement,
  ) => void | Promise<void>;
  onRemoveQueueEpisodes: (episodeIds: string[]) => Promise<void>;
  onSetQueueEpisodesPlayed: (
    episodeIds: string[],
    played: boolean,
  ) => Promise<void>;
  onDownloadQueueEpisodes: (
    episodes: PodcastEpisode[],
  ) => Promise<{ downloadedCount: number; failedCount: number; canceled?: boolean }>;
  onClearQueue: () => void | Promise<void>;
  onAutoQueueMode: (mode: PodcastAutoQueueMode) => void;
  onEpisodeUpdated: (episode: PodcastEpisode) => void;
  onSetEpisodePlayed: (
    episodeId: string,
    played: boolean,
  ) => Promise<PodcastEpisodeDetail>;
  onDownloadsDeleted: (episodeIds: string[]) => void | Promise<void>;
};

export type PodcastSessionSnapshot = {
  screen: PodcastScreen;
  returnScreen: RootPodcastScreen;
  query: string;
  listenFilter: PodcastListenFilter;
  discoveryTopic: PodcastDiscoveryTopic | null;
  searchHeading: string;
  searchSort: PodcastDiscoverySort;
  searchHighlightQuery: string;
  searchState: RequestState;
  searchResults: PodcastSearchResult[];
  selectedFeed: PodcastFeed | null;
  episodes: PodcastEpisode[];
  selectedEpisodeId: string | null;
  selectedEpisodeDetail: PodcastEpisodeDetail | null;
  episodeOriginScreen: EpisodeOriginScreen;
  episodeOriginFeed: PodcastFeed | null;
  lastPlayedEpisode: PodcastEpisode | null;
};
