export type MusicFolder = {
  path: string;
  name: string;
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

export type HomePinKind = "track" | "album" | "artist" | "playlist";

export type HomePin = {
  id: string;
  kind: HomePinKind;
  targetId: string;
  createdAt: number;
};

export type ContextPayload = {
  kind: "track" | "album" | "artist" | "playlist";
  title: string;
  subtitle: string;
  tracks: Track[];
  playbackTracks?: Track[];
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
export type AppPage = "quickplay" | "collection" | "nowPlaying" | "settings";
export type RepeatMode = "off" | "one" | "all";

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
