import { MAX_HOME_PINS } from "../constants.js";
import type { ContextPayload, HomePin, HomePinCustomization, HomePinKind, HomePinSize, Playlist, Track } from "../types";
import { albumKey } from "./music.js";

const HOME_PIN_KINDS = new Set<HomePinKind>([
  "track",
  "album",
  "artist",
  "playlist",
  "podcastFeed",
]);

export function homePinId(kind: HomePinKind, targetId: string) {
  return `${kind}:${targetId}`;
}

/** Size ladder for quickplay tiles, smallest to largest. */
export const HOME_PIN_SIZES = ["small", "medium", "wide", "large"] as const satisfies readonly HomePinSize[];
export const HOME_PIN_TONES = {
  cover: { label: "封面", color: "transparent" },
  pink: { label: "洋红", color: "#a40058" },
  teal: { label: "青绿", color: "#007b73" },
  blue: { label: "钴蓝", color: "#2458a8" },
  orange: { label: "橙色", color: "#b74800" },
  purple: { label: "紫色", color: "#713b9b" },
} as const;

export function customizeHomePin(pins: HomePin[], pinId: string, patch: HomePinCustomization): HomePin[] {
  return normalizeHomePins(pins.map(pin => pin.id === pinId ? { ...pin, ...patch } : pin));
}

// Artists and playlists have always been wide; keep that as their default so
// existing walls look unchanged until the user resizes a pin explicitly.
export function defaultHomePinSize(kind: HomePinKind): HomePinSize {
  return kind === "artist" || kind === "playlist" ? "wide" : "medium";
}

export function homePinSize(pin: HomePin): HomePinSize {
  return pin.size ?? defaultHomePinSize(pin.kind);
}

/** Wrap-around cycle for the edit-mode resize button. */
export function nextHomePinSize(size: HomePinSize): HomePinSize {
  const index = HOME_PIN_SIZES.indexOf(size);
  return HOME_PIN_SIZES[(index + 1) % HOME_PIN_SIZES.length];
}

/** Clamped step for keyboard resizing (Alt+Up/Down never wraps). */
export function stepHomePinSize(size: HomePinSize, direction: -1 | 1): HomePinSize {
  const index = HOME_PIN_SIZES.indexOf(size);
  const next = Math.max(0, Math.min(HOME_PIN_SIZES.length - 1, index + direction));
  return HOME_PIN_SIZES[next];
}

export function setHomePinSize(pins: HomePin[], pinId: string, size: HomePinSize): HomePin[] {
  if (!HOME_PIN_SIZES.includes(size)) return pins;
  if (!pins.some((pin) => pin.id === pinId)) return pins;
  return pins.map((pin) => (pin.id === pinId ? { ...pin, size } : pin));
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
    // Sizes written by older/newer builds that no longer match the ladder are
    // dropped back to the kind default instead of breaking the grid.
    const size = (HOME_PIN_SIZES as readonly string[]).includes(candidate.size as string)
      ? (candidate.size as HomePinSize)
      : undefined;
    result.push({
      id,
      kind,
      targetId,
      createdAt: Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : 0,
      ...(size !== undefined ? { size } : {}),
      ...(typeof candidate.live === "boolean" ? { live: candidate.live } : {}),
      ...(candidate.tone && Object.prototype.hasOwnProperty.call(HOME_PIN_TONES, candidate.tone) ? { tone: candidate.tone } : {}),
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
    // Podcast feeds live in SQLite, not in the music library snapshot; their
    // existence is reconciled by the podcast-aware loader in App.
    if (pin.kind === "podcastFeed") return true;
    return playlistIds.has(pin.targetId);
  });
}

export function moveHomePin(pins: HomePin[], sourceId: string, targetId: string, placeAfter = false) {
  const sourceIndex = pins.findIndex((pin) => pin.id === sourceId);
  const targetIndex = pins.findIndex((pin) => pin.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return pins;
  const next = [...pins];
  const [source] = next.splice(sourceIndex, 1);
  // Recompute the target index after removing the source. The board decides
  // whether the pointer is on the before or after half of the target.
  const insertAt = next.findIndex((pin) => pin.id === targetId) + (placeAfter ? 1 : 0);
  next.splice(insertAt, 0, source);
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

export type HomePinToggleAction = "pinned" | "unpinned" | "capped" | "ignored";

// Decide pin/unpin from the latest array. Callers must run this inside
// setHomePins so two rapid clicks cannot both append.
export function applyHomePinToggle(
  pins: HomePin[],
  payload: ContextPayload,
  now = Date.now(),
): { pins: HomePin[]; action: HomePinToggleAction } {
  const pin = homePinForPayload(payload, now);
  if (!pin) return { pins, action: "ignored" };
  return applyHomePinToggleForPin(pins, pin);
}

// Podcast feeds are pinned from the podcast show screen, where no music
// ContextPayload exists; the toggle works on the pin identity directly.
export function applyHomePinToggleForPin(
  pins: HomePin[],
  pin: HomePin,
): { pins: HomePin[]; action: HomePinToggleAction } {
  if (pins.some((item) => item.id === pin.id)) {
    return { pins: pins.filter((item) => item.id !== pin.id), action: "unpinned" };
  }
  if (pins.length >= MAX_HOME_PINS) return { pins, action: "capped" };
  return { pins: [...pins, pin], action: "pinned" };
}

function targetIdForPayload(payload: ContextPayload) {
  if (payload.kind === "track") return payload.tracks[0]?.id ?? null;
  // Album identity comes from the group key captured at payload creation;
  // reverse-engineering it from title/subtitle breaks whenever the display
  // artist (bestAlbumArtist) differs from the grouping key (album_artist ??
  // artist, where an empty album_artist collapses the key to the album name).
  if (payload.kind === "album") return payload.targetId ?? albumKey(payload.title, payload.subtitle);
  // Artist identity is the raw track.artist string used for grouping,
  // reconcileHomePins and ArtistBrowser selection. Trimming here would produce
  // a pin id that no longer matches the library and silently drops on restore.
  if (payload.kind === "artist") return payload.title || null;
  if (!payload.playlistId || payload.playlistId === "now") return null;
  return payload.playlistId;
}
