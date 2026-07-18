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
