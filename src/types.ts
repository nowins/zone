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

export type Playlist = {
  id: string;
  name: string;
  description: string;
  trackIds: string[];
};

export type ContextPayload = {
  kind: "track" | "album" | "artist" | "playlist";
  title: string;
  subtitle: string;
  tracks: Track[];
  playbackTracks?: Track[];
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
