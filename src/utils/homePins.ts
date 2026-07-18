import { MAX_HOME_PINS } from "../constants.js";
import type { ContextPayload, HomePin, HomePinKind, Playlist, Track } from "../types";
import { albumKey } from "./music.js";

const HOME_PIN_KINDS = new Set<HomePinKind>(["track", "album", "artist", "playlist"]);

export function homePinId(kind: HomePinKind, targetId: string) {
  return `${kind}:${targetId}`;
}

export function homePinForPayload(payload: ContextPayload, now = Date.now()): HomePin | null {
  const targetId = targetIdForPayload(payload);
  if (!targetId) return null;
  return {
    id: homePinId(payload.kind, targetId),
    kind: payload.kind,
    targetId,
    createdAt: now,
  };
}

export function homePinStateForPayload(pins: HomePin[], payload: ContextPayload) {
  const pin = homePinForPayload(payload);
  if (!pin) return null;
  return pins.some((item) => item.id === pin.id) ? "pinned" as const : "unpinned" as const;
}

export function normalizeHomePins(value: unknown): HomePin[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: HomePin[] = [];

  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Partial<HomePin>;
    if (!HOME_PIN_KINDS.has(candidate.kind as HomePinKind)) continue;
    if (typeof candidate.targetId !== "string" || !candidate.targetId.trim()) continue;
    const kind = candidate.kind as HomePinKind;
    const targetId = candidate.targetId;
    const id = homePinId(kind, targetId);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      kind,
      targetId,
      createdAt: Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : 0,
    });
    if (result.length === MAX_HOME_PINS) break;
  }

  return result;
}

export function reconcileHomePins(pins: HomePin[], tracks: Track[], playlists: Playlist[]) {
  const trackIds = new Set(tracks.map((track) => track.id));
  const albumIds = new Set(tracks.map((track) => albumKey(track.album, track.album_artist ?? track.artist)));
  const artists = new Set(tracks.map((track) => track.artist));
  const playlistIds = new Set(playlists.map((playlist) => playlist.id));

  return normalizeHomePins(pins).filter((pin) => {
    if (pin.kind === "track") return trackIds.has(pin.targetId);
    if (pin.kind === "album") return albumIds.has(pin.targetId);
    if (pin.kind === "artist") return artists.has(pin.targetId);
    return playlistIds.has(pin.targetId);
  });
}

export function moveHomePin(pins: HomePin[], sourceId: string, targetId: string) {
  const sourceIndex = pins.findIndex((pin) => pin.id === sourceId);
  const targetIndex = pins.findIndex((pin) => pin.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return pins;
  const next = [...pins];
  const [source] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, source);
  return next;
}

export function shiftHomePin(pins: HomePin[], pinId: string, direction: -1 | 1) {
  const sourceIndex = pins.findIndex((pin) => pin.id === pinId);
  if (sourceIndex < 0) return pins;
  const targetIndex = Math.max(0, Math.min(pins.length - 1, sourceIndex + direction));
  if (targetIndex === sourceIndex) return pins;
  const next = [...pins];
  const [source] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, source);
  return next;
}

function targetIdForPayload(payload: ContextPayload) {
  if (payload.kind === "track") return payload.tracks[0]?.id ?? null;
  if (payload.kind === "album") return albumKey(payload.title, payload.subtitle);
  if (payload.kind === "artist") return payload.title.trim() || null;
  if (!payload.playlistId || payload.playlistId === "now") return null;
  return payload.playlistId;
}
