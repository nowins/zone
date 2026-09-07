export type MusicFolder = {
  path: string;
  name: string;
};

export type TrackLocalMetadata = {
  title: string;
  artist: string;
  album: string;
  album_artist?: string;
  track_number?: number | null;
  disc_number?: number | null;
  year?: number | null;
  genres?: string[];
  cover_path?: string | null;
};

export type MetadataFieldSource = {
  field: string;
  providerId: string;
  providerName: string;
  sourcePath: string;
  confidence: number;
  updatedAt: number;
};

export type TrackMetadataEnrichment = {
  sources: MetadataFieldSource[];
};

export type MetadataImageAsset = {
  path: string;
  providerId: string;
  providerName: string;
  sourcePath: string;
  confidence: number;
  updatedAt: number;
};

export type Track = {
  id: string;
  path: string;
  file_name: string;
  title: string;
  artist: string;
  album: string;
  album_artist?: string;
  track_number?: number | null;
  disc_number?: number | null;
  year?: number | null;
  genres?: string[];
  duration_seconds?: number | null;
  added_at?: number | null;
  extension: string;
  cover_path?: string | null;
  artist_image_path?: string | null;
  artist_images?: MetadataImageAsset[];
  artist_biography?: string | null;
  local_metadata?: TrackLocalMetadata;
  metadata_enrichment?: TrackMetadataEnrichment;
};

export type MetadataEntityKind = "track" | "album" | "artist";

export type MetadataTrackInput = {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  trackNumber?: number | null;
  discNumber?: number | null;
  year?: number | null;
  genres?: string[];
  durationSeconds?: number | null;
};

export type MetadataCandidateField = {
  key: string;
  label: string;
  value: string;
};

export type MetadataManualField = {
  key: string;
  value: string | number | string[];
};

export type MetadataCandidate = {
  id: string;
  kind: MetadataEntityKind;
  providerId: string;
  providerName: string;
  title: string;
  subtitle: string;
  sourcePath: string;
  confidence: number;
  fields: MetadataCandidateField[];
};

export type MetadataProviderDescriptor = {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  available: boolean;
  enabled: boolean;
  experimental: boolean;
};

export type MetadataTrackOverlay = {
  trackId: string;
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  trackNumber?: number;
  discNumber?: number;
  year?: number;
  genres?: string[];
  coverPath?: string;
  artistImagePath?: string;
  artistImages: MetadataImageAsset[];
  artistBiography?: string;
  sources: MetadataFieldSource[];
};

export type MetadataContextRecord = {
  entityId: string;
  kind: MetadataEntityKind;
  providerId: string;
  providerName: string;
  sourcePath: string;
  confidence: number;
  updatedAt: number;
  fields: MetadataCandidateField[];
  sources: MetadataFieldSource[];
};

export type AlbumGroup = {
  key: string;
  artist: string;
  album: string;
  tracks: Track[];
  coverPath?: string | null;
};

export type ArtistGroup = {
  artist: string;
  tracks: Track[];
};

export type ManualPlaylist = {
  id: string;
  name: string;
  description: string;
  kind?: "manual";
  trackIds: string[];
};

export type SmartRuleField =
  | "artist"
  | "album"
  | "genre"
  | "year"
  | "favorite"
  | "playCount"
  | "lastPlayed"
  | "dateAdded"
  | "skipRate";

export type SmartRuleOperator =
  | "contains"
  | "equals"
  | "notContains"
  | "between"
  | "atLeast"
  | "atMost"
  | "is"
  | "never"
  | "olderThanDays"
  | "withinDays";

export type SmartRule = {
  id: string;
  field: SmartRuleField;
  operator: SmartRuleOperator;
  value?: string | number | boolean;
  valueTo?: number;
};

export type SmartPlaylistConfig = {
  match: "all" | "any";
  rules: SmartRule[];
  order: "smart" | "leastPlayed" | "oldestPlayed" | "recentlyAdded" | "title";
  limitKind: "tracks" | "minutes";
  limitValue: number;
  maxPerArtist: number;
  maxPerAlbum: number;
  preferFavorites: boolean;
  avoidSkipped: boolean;
  rotateDaily: boolean;
  rotationSeed: number;
};

export type SmartPlaylist = {
  id: string;
  name: string;
  description: string;
  kind: "smart";
  smart: SmartPlaylistConfig;
  excludedTrackIds: string[];
};

export type Playlist = ManualPlaylist | SmartPlaylist;

export type TrackActivity = {
  addedAt: number;
  playCount: number;
  completedCount: number;
  skipCount: number;
  lastPlayedAt?: number;
  lastSkippedAt?: number;
};

export type TrackActivityMap = Record<string, TrackActivity>;

export type HomePinKind = "track" | "album" | "artist" | "playlist" | "podcastFeed";

/** WP small/medium/wide; large remains supported for existing desktop walls. */
export type HomePinSize = "small" | "medium" | "wide" | "large";
export type HomePinTone = "cover" | "pink" | "teal" | "blue" | "orange" | "purple";
export type HomePinCustomization = { size?: HomePinSize; live?: boolean; tone?: HomePinTone };

export type HomePin = {
  id: string;
  kind: HomePinKind;
  targetId: string;
  createdAt: number;
  /** Explicit tile size picked in quickplay edit mode; absent = kind default. */
  size?: HomePinSize;
  live?: boolean;
  tone?: HomePinTone;
};

export type ContextPayload = {
  kind: "track" | "album" | "artist" | "playlist";
  title: string;
  subtitle: string;
  tracks: Track[];
  playbackTracks?: Track[];
  /** Stable entity id (e.g. the album group key); set at payload creation so
      pins never have to reverse-engineer identity from display strings. */
  targetId?: string;
  playlistId?: string;
  playlistKind?: "manual" | "smart";
};

export type ContextMenuState = {
  x: number;
  y: number;
  payload: ContextPayload;
};

export type ScanResult = {
  folders: string[];
  tracks: Track[];
  skipped: number;
};

export type ViewMode = "songs" | "albums" | "artists" | "playlists";
export type AppPage = "quickplay" | "collection" | "podcasts" | "nowPlaying" | "settings";
export type RepeatMode = "off" | "one" | "all";

export type PodcastSearchResult = {
  id: string;
  title: string;
  author: string;
  feedUrl: string;
  artworkUrl?: string | null;
  episodeCount?: number | null;
  genres: string[];
  latestReleaseAt?: number | null;
};

export type PodcastDiscoveryShow = {
  id: string;
  title: string;
  author: string;
  feedUrl: string;
  artworkUrl?: string | null;
  genres: string[];
  rank: number;
};

export type PodcastFeed = {
  id: string;
  feedUrl: string;
  title: string;
  author?: string | null;
  description?: string | null;
  artworkUrl?: string | null;
  lastFetchedAt: number;
  subscribed: boolean;
  subscribedAt?: number | null;
  lastCheckedAt?: number | null;
  lastRefreshError?: string | null;
  latestEpisodeAt?: number | null;
  unplayedCount: number;
  latestEpisodeTitle?: string | null;
};

export type PodcastDownloadState = "none" | "downloading" | "downloaded" | "failed";

export type PodcastEpisode = {
  id: string;
  feedId: string;
  title: string;
  description?: string | null;
  publishedAt?: number | null;
  durationSeconds?: number | null;
  enclosureUrl: string;
  enclosureType?: string | null;
  artworkUrl?: string | null;
  downloadState: PodcastDownloadState;
  localPath?: string | null;
  downloadedBytes: number;
  totalBytes?: number | null;
  progressSeconds: number;
  completed: boolean;
  saved: boolean;
  feedTitle?: string | null;
  feedArtworkUrl?: string | null;
  firstSeenAt: number;
  webpageUrl?: string | null;
};

export type PodcastSubscribeResult = {
  feed: PodcastFeed;
  episodeCount: number;
  insertedCount: number;
  updatedCount?: number;
};

export type PodcastRefreshReport = {
  checked: number;
  notModified: number;
  inserted: number;
  updated: number;
  failures: Array<{
    feedId: string;
    title: string;
    message: string;
  }>;
};

export type PodcastDownloadResult = {
  episodeId: string;
  localPath: string;
  downloadedBytes: number;
  resumed: boolean;
};

export type PodcastDownloadPage = {
  episodes: PodcastEpisode[];
  totalCount: number;
  totalBytes: number;
  feedCount: number;
  hasMore: boolean;
};

export type PodcastDownloadDeleteResult = {
  requestedCount: number;
  deletedCount: number;
  deletedBytes: number;
  deletedEpisodeIds: string[];
};

export type PodcastHome = {
  continueListening: PodcastEpisode[];
  latestEpisodes: PodcastEpisode[];
  unplayedEpisodes: PodcastEpisode[];
  downloadPriorityEpisodes: PodcastEpisode[];
  downloadedEpisodes: PodcastEpisode[];
  savedEpisodes: PodcastEpisode[];
  recentlyPlayedEpisodes: PodcastEpisode[];
};

export type PodcastEpisodeDetail = {
  episode: PodcastEpisode;
  feed: PodcastFeed;
  expectedBytes?: number | null;
  downloadError?: string | null;
  saved: boolean;
  savedAt?: number | null;
  queuePosition?: number | null;
  hasChapters: boolean;
  transcriptCount: number;
};

export type PodcastChapter = {
  startSeconds: number;
  endSeconds?: number | null;
  title: string;
  href?: string | null;
  imageUrl?: string | null;
};

export type PodcastChapterDocument = {
  episodeId: string;
  sourceKind: "podcast-json" | "psc";
  chapters: PodcastChapter[];
  stale: boolean;
};

export type PodcastQueueItem = {
  episode: PodcastEpisode;
  position: number;
  addedAt: number;
};

export type PodcastPlayback = PodcastEpisode & {
  episodeId: string;
  podcastTitle: string;
  savedProgressSeconds: number;
  playbackLocalPath?: string | null;
};

export type PodcastPlaybackStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "buffering"
  | "error";

export type PodcastAutoQueueMode = "off" | "same-feed" | "random-unplayed";

export type PodcastSleepTimer =
  | { kind: "deadline"; deadlineAt: number }
  | { kind: "episodeEnd"; episodeId: string }
  | null;

export type LyricsWord = {
  text: string;
  start: number;
  end: number;
};

export type LyricsBackgroundLine = {
  id: string;
  start: number;
  end: number;
  text: string;
  translation?: string;
  transliteration?: string;
  words?: LyricsWord[];
};

export type LyricsLine = {
  id: string;
  start: number;
  end: number;
  text: string;
  translation?: string;
  transliteration?: string;
  words?: LyricsWord[];
  background?: LyricsBackgroundLine[];
};

export type LyricsDocument = {
  trackId: string;
  sourceId: string;
  format: "plain" | "line" | "word";
  language?: string;
  lines: LyricsLine[];
};

export type LyricsSource = {
  source_id: string;
  origin: "embedded" | "sidecar" | "manual" | "provider";
  format_hint: "ttml" | "lrc" | "plain";
  label: string;
  content: string;
  path?: string | null;
  modified_at?: number | null;
  is_manual: boolean;
  provider_id?: string;
  reference?: string;
};

export type LocalLyricsSource = LyricsSource & {
  origin: "embedded" | "sidecar" | "manual";
};

export type LyricsProviderCapability = "line" | "word" | "translation" | "transliteration";

export type LyricsQuery = {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
};

export type LyricsSearchMetadata = {
  title: string;
  artist: string;
  album: string;
};

export type LyricsCandidateScore = {
  total: number;
  title: number;
  artist: number;
  album: number | null;
  duration: number | null;
};

export type LyricsCandidate = {
  id: string;
  providerId: string;
  providerName: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  instrumental: boolean;
  formatHint: "lrc" | "ttml" | "plain";
  content: string;
  reference?: string;
  score: LyricsCandidateScore;
};

export type LyricsProviderConfig = {
  id: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
};

export type LyricsProviderDefinition = {
  id: string;
  name: string;
  description: string;
  capabilities: LyricsProviderCapability[];
  defaultEnabled: boolean;
  defaultPriority: number;
  defaultTimeoutMs: number;
  rateLimitMs: number;
  search(query: LyricsQuery, signal: AbortSignal, timeoutMs: number): Promise<LyricsCandidate[]>;
  get(candidate: LyricsCandidate, signal: AbortSignal): Promise<LyricsSource>;
};
