import { invoke } from "@tauri-apps/api/core";
import type {
  HomePin,
  MusicFolder,
  Playlist,
  RepeatMode,
  Track,
  TrackActivityMap,
} from "../types";

export type MusicPlaybackSnapshot = {
  activeTrackId: string | null;
  queue: string[];
  playHistory: string[];
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  selectedPlaylistId: string | null;
};

export type MusicLibrarySnapshot = {
  folders: MusicFolder[];
  tracks: Track[];
  playlists: Playlist[];
  homePins: HomePin[];
  trackActivity: TrackActivityMap;
  playback: MusicPlaybackSnapshot;
  libraryRevision: number;
  hasLibrary: boolean;
};

export type MusicScanWriteResult = {
  folders: string[];
  tracks: Track[];
  skipped: number;
  libraryRevision: number;
};

export type LegacyPlayerStateV1 = {
  librarySchemaVersion?: number;
  folders?: MusicFolder[];
  tracks?: Track[];
  activeTrackId?: string | null;
  queue?: string[];
  playHistory?: string[];
  trackActivity?: TrackActivityMap;
  volume?: number;
  shuffle?: boolean;
  repeat?: RepeatMode;
  playlists?: Playlist[];
  selectedPlaylistId?: string | null;
  homePins?: HomePin[];
};

export type MusicPlaybackStateInput = {
  activeTrackId?: string | null;
  queue?: string[];
  playHistory?: string[];
  volume?: number;
  shuffle?: boolean;
  repeat?: RepeatMode;
  selectedPlaylistId?: string | null;
};

export async function musicGetLibrarySnapshot() {
  return invoke<MusicLibrarySnapshot>("music_get_library_snapshot");
}

export async function musicImportLegacyPlayerState(legacy: LegacyPlayerStateV1) {
  return invoke<MusicLibrarySnapshot>("music_import_legacy_player_state", { legacy });
}

export async function musicScanLibrary(folders: MusicFolder[]) {
  return invoke<MusicScanWriteResult>("music_scan_library", { folders });
}

export async function musicSavePlaylists(playlists: Playlist[]) {
  return invoke<void>("music_save_playlists", { playlists });
}

export async function musicSaveHomePins(pins: HomePin[]) {
  return invoke<void>("music_save_home_pins", { pins });
}

export async function musicSaveTrackActivity(activity: TrackActivityMap) {
  return invoke<void>("music_save_track_activity", { activity });
}

export async function musicSavePlaybackState(playback: MusicPlaybackStateInput) {
  return invoke<void>("music_save_playback_state", { playback });
}

export async function musicClearLibrary() {
  return invoke<void>("music_clear_library");
}

export type MusicPlaySessionStartInput = {
  sessionId: string;
  trackId: string;
  startPositionMs?: number;
  durationMs?: number;
  source?: string;
};

export type MusicPlaySessionEndInput = {
  sessionId: string;
  trackId: string;
  startPositionMs?: number;
  endPositionMs?: number;
  durationMs?: number;
  listenedMs?: number;
  outcome: "playing" | "completed" | "skipped" | "replaced" | "stopped" | "error";
  source?: string;
  maxProgressMs?: number;
};

export type MusicPlaySessionEndResult = {
  trackId: string;
  activity: import("../types").TrackActivity;
  outcome: string;
  countedPlay: boolean;
  countedComplete: boolean;
  countedSkip: boolean;
};

export async function musicSessionStart(session: MusicPlaySessionStartInput) {
  return invoke<void>("music_session_start", { session });
}

export async function musicSessionEnd(session: MusicPlaySessionEndInput) {
  return invoke<MusicPlaySessionEndResult>("music_session_end", { session });
}

