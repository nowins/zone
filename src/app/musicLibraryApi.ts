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



export type FeatureJobStatus = {
  pending: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  totalTracks: number;
  analyzerVersion: number;
};

export type SimilarTrackMatch = {
  trackId: string;
  score: number;
  distance: number;
};

export async function musicAnalyzeFeatures(limit = 64) {
  return invoke<FeatureJobStatus>("music_analyze_features", { limit });
}

export async function musicFeatureStatus() {
  return invoke<FeatureJobStatus>("music_feature_status");
}

export async function musicListSimilarTracks(trackId: string, limit = 24) {
  return invoke<SimilarTrackMatch[]>("music_list_similar_tracks", { trackId, limit });
}

export async function musicListTrackFeatures(trackIds?: string[]) {
  return invoke<Record<string, number[]>>("music_list_track_features", { trackIds });
}


export type RadioSeedRecord = {
  kind: "track" | "album" | "artist" | "playlist" | "mixed" | string;
  id: string;
  label: string;
  trackIds: string[];
};

export type RadioSessionRecord = {
  id: string;
  kind: string;
  seed: RadioSeedRecord;
  status: "idle" | "playing" | "exhausted" | "stopped" | string;
  playedIds: string[];
  bannedIds: string[];
  queuedIds: string[];
  skippedIds: string[];
  constraints: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
};

export type RadioSessionUpsertInput = {
  id: string;
  kind?: string;
  seed: RadioSeedRecord;
  status: string;
  playedIds?: string[];
  bannedIds?: string[];
  queuedIds?: string[];
  skippedIds?: string[];
  constraints?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  lastActiveAt?: number;
};

export async function musicUpsertRadioSession(session: RadioSessionUpsertInput) {
  return invoke<RadioSessionRecord>("music_upsert_radio_session", { session });
}

export async function musicGetRadioSession(sessionId?: string | null) {
  return invoke<RadioSessionRecord | null>("music_get_radio_session", {
    sessionId: sessionId ?? null,
  });
}

export async function musicStopRadioSession(sessionId?: string | null) {
  return invoke<void>("music_stop_radio_session", {
    sessionId: sessionId ?? null,
  });
}
