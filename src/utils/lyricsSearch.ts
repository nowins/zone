import type { LyricsQuery, LyricsSearchMetadata, Track } from "../types.js";

export function defaultLyricsSearchMetadata(track: Track): LyricsSearchMetadata {
  return {
    title: track.title.trim(),
    artist: track.artist.trim(),
    album: track.album.trim(),
  };
}

export function normalizeLyricsSearchMetadata(
  value: LyricsSearchMetadata,
): LyricsSearchMetadata | null {
  const metadata = {
    title: value.title.trim(),
    artist: value.artist.trim(),
    album: value.album.trim(),
  };
  return metadata.title ? metadata : null;
}

export function isDefaultLyricsSearchMetadata(track: Track, value: LyricsSearchMetadata) {
  const normalized = normalizeLyricsSearchMetadata(value);
  if (!normalized) return false;
  const defaults = defaultLyricsSearchMetadata(track);
  return normalized.title === defaults.title
    && normalized.artist === defaults.artist
    && normalized.album === defaults.album;
}

export function lyricsQueryForTrack(
  track: Track,
  duration: number,
  override?: LyricsSearchMetadata,
): LyricsQuery {
  const metadata = override ? normalizeLyricsSearchMetadata(override) : null;
  const resolved = metadata ?? defaultLyricsSearchMetadata(track);
  return {
    title: resolved.title,
    artist: resolved.artist,
    album: resolved.album || undefined,
    duration: duration > 0 ? duration : undefined,
  };
}

export function lyricsQueryKey(query: LyricsQuery) {
  return [query.title, query.artist, query.album ?? "", Math.round(query.duration ?? 0)]
    .map((value) => String(value).trim().toLocaleLowerCase())
    .join("\u0000");
}
