import { DEFAULT_PLAYLIST_ID } from "../constants.js";
import type { Playlist, Track } from "../types";
import { isSmartPlaylist, normalizeSmartPlaylistConfig } from "./smartPlaylist.js";

export function defaultPlaylists(): Playlist[] {
  return [
    {
      id: DEFAULT_PLAYLIST_ID,
      name: "收藏",
      description: "收藏的歌曲",
      trackIds: [],
    },
  ];
}

export function normalizePlaylists(playlists: Playlist[] | undefined | null): Playlist[] {
  const defaults = defaultPlaylists();
  const items = (playlists?.length ? playlists : []).map((playlist) => {
    if (isSmartPlaylist(playlist)) {
      return {
        ...playlist,
        description: playlist.description || "自动更新的智能播放列表",
        smart: normalizeSmartPlaylistConfig(playlist.smart),
        excludedTrackIds: Array.isArray(playlist.excludedTrackIds) ? playlist.excludedTrackIds : [],
      };
    }

    return {
      ...playlist,
      kind: "manual" as const,
      name: playlist.id === DEFAULT_PLAYLIST_ID ? "收藏" : playlist.name,
      description: playlist.id === DEFAULT_PLAYLIST_ID ? "收藏的歌曲" : playlist.description,
      trackIds: Array.isArray(playlist.trackIds) ? playlist.trackIds : [],
    };
  });
  const hasDefault = items.some((playlist) => playlist.id === DEFAULT_PLAYLIST_ID);
  return hasDefault ? items : [...defaults, ...items];
}

export function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids));
}

export function albumKey(album: string, albumArtist?: string) {
  const albumPart = album.trim().toLocaleLowerCase() || "unknown album";
  const artistPart = albumArtist?.trim().toLocaleLowerCase();
  return artistPart ? `${albumPart}\u0000${artistPart}` : albumPart;
}

export function compareTracksForAlbum(a: Track, b: Track) {
  return (a.disc_number ?? 1) - (b.disc_number ?? 1)
    || trackNumber(a) - trackNumber(b)
    || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
}

function trackNumber(track: Track) {
  return track.track_number ?? leadingTrackNumber(track.file_name);
}

function leadingTrackNumber(value: string) {
  const match = value.match(/^\D*(\d{1,3})\D/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function bestAlbumArtist(tracks: Track[]) {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    const artist = track.album_artist?.trim() || track.artist.trim() || "未知艺术家";
    counts.set(artist, (counts.get(artist) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || qualityScore(b[0]) - qualityScore(a[0]))[0]?.[0] ?? "未知艺术家";
}

function qualityScore(value: string) {
  let score = 0;
  for (const character of value) {
    if (/[\u4e00-\u9fff]/u.test(character)) score += 2;
    if (/[a-z0-9]/iu.test(character)) score += 1;
    if ("ÃÕÄÐÂÒ".includes(character)) score -= 2;
  }
  return score;
}

export function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
