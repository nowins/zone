import type {
  AlbumGroup,
  Playlist,
  Track,
  TrackActivityMap,
} from "../types.js";
import { albumKey } from "./music.js";
import { isSmartPlaylist, resolvePlaylistTracks } from "./smartPlaylist.js";

export type QuickplayBlockId =
  | "continue"
  | "recentAdded"
  | "history"
  | "mostPlayed"
  | "forgottenFavorites";

export type QuickplayBlockItem =
  | {
      kind: "track";
      id: string;
      title: string;
      subtitle: string;
      tracks: Track[];
      artPath?: string | null;
    }
  | {
      kind: "album";
      id: string;
      title: string;
      subtitle: string;
      tracks: Track[];
      artPath?: string | null;
    };

export type QuickplayBlock = {
  id: QuickplayBlockId;
  title: string;
  items: QuickplayBlockItem[];
};

export type QuickplayBlocksInput = {
  tracks: Track[];
  albums: AlbumGroup[];
  playlists: Playlist[];
  activity: TrackActivityMap;
  favoriteTrackIds: ReadonlySet<string>;
  historyIds: string[];
  activeTrack: Track | null;
  now?: number;
};

const DAY_MS = 86_400_000;

function albumForTrack(albums: AlbumGroup[], track: Track | null) {
  if (!track) return albums[0] ?? null;
  return albums.find((album) => album.tracks.some((item) => item.id === track.id)) ?? albums[0] ?? null;
}

function albumAddedAt(album: AlbumGroup, activity: TrackActivityMap) {
  return album.tracks.reduce(
    (latest, track) => Math.max(latest, activity[track.id]?.addedAt ?? track.added_at ?? 0),
    0,
  );
}

function trackItem(track: Track, playbackTracks?: Track[]): QuickplayBlockItem {
  return {
    kind: "track",
    id: track.id,
    title: track.title,
    subtitle: track.artist,
    tracks: playbackTracks && playbackTracks.length > 0 ? playbackTracks : [track],
    artPath: track.cover_path,
  };
}

function albumItem(album: AlbumGroup): QuickplayBlockItem {
  return {
    kind: "album",
    id: album.key,
    title: album.album,
    subtitle: album.artist,
    tracks: album.tracks,
    artPath: album.coverPath ?? album.tracks.find((track) => track.cover_path)?.cover_path ?? null,
  };
}

export function buildContinueBlock(input: QuickplayBlocksInput): QuickplayBlock | null {
  const continueAlbum = albumForTrack(input.albums, input.activeTrack);
  if (!continueAlbum && !input.activeTrack) return null;
  if (input.activeTrack) {
    return {
      id: "continue",
      title: "继续播放",
      items: [trackItem(input.activeTrack, continueAlbum?.tracks ?? [input.activeTrack])],
    };
  }
  return {
    id: "continue",
    title: "继续播放",
    items: [albumItem(continueAlbum!)],
  };
}

export function buildRecentAddedBlock(input: QuickplayBlocksInput, limit = 6): QuickplayBlock {
  const items = [...input.albums]
    .sort((a, b) => albumAddedAt(b, input.activity) - albumAddedAt(a, input.activity) || a.album.localeCompare(b.album))
    .slice(0, limit)
    .map(albumItem);
  return {
    id: "recentAdded",
    title: "最近添加",
    items,
  };
}

export function buildHistoryBlock(input: QuickplayBlocksInput, limit = 4): QuickplayBlock {
  const trackMap = new Map(input.tracks.map((track) => [track.id, track]));
  const candidates = [
    ...input.historyIds.map((id) => trackMap.get(id)).filter((track): track is Track => Boolean(track)),
    ...input.tracks,
  ];
  const seenAlbums = new Set<string>();
  const result: Track[] = [];
  for (const track of candidates) {
    if (track.album === input.activeTrack?.album || seenAlbums.has(track.album)) continue;
    seenAlbums.add(track.album);
    result.push(track);
    if (result.length === limit) break;
  }
  return {
    id: "history",
    title: "播放历史",
    items: result.map((track) => trackItem(track, input.tracks)),
  };
}

export function buildMostPlayedBlock(input: QuickplayBlocksInput, limit = 6): QuickplayBlock {
  const ranked = [...input.tracks]
    .map((track) => ({
      track,
      playCount: input.activity[track.id]?.playCount ?? 0,
      lastPlayedAt: input.activity[track.id]?.lastPlayedAt ?? 0,
    }))
    .filter((item) => item.playCount > 0)
    .sort((a, b) => b.playCount - a.playCount || b.lastPlayedAt - a.lastPlayedAt || a.track.title.localeCompare(b.track.title))
    .slice(0, limit)
    .map((item) => trackItem(item.track, input.tracks));

  return {
    id: "mostPlayed",
    title: "最常播放",
    items: ranked,
  };
}

export function buildForgottenFavoritesBlock(
  input: QuickplayBlocksInput,
  options?: { limit?: number; olderThanDays?: number },
): QuickplayBlock {
  const limit = options?.limit ?? 6;
  const olderThanDays = options?.olderThanDays ?? 30;
  const now = input.now ?? Date.now();
  const threshold = now - olderThanDays * DAY_MS;

  const favoritesPlaylist = input.playlists.find((playlist) => playlist.id === "favorites");
  const favoriteTracks = favoritesPlaylist
    ? resolvePlaylistTracks(favoritesPlaylist, input.tracks, {
        favoriteTrackIds: input.favoriteTrackIds,
        activity: input.activity,
        now,
      }).tracks
    : input.tracks.filter((track) => input.favoriteTrackIds.has(track.id));

  const ranked = favoriteTracks
    .map((track) => {
      const activity = input.activity[track.id];
      const lastPlayedAt = activity?.lastPlayedAt ?? 0;
      return { track, lastPlayedAt, playCount: activity?.playCount ?? 0 };
    })
    .filter((item) => item.lastPlayedAt === 0 || item.lastPlayedAt <= threshold)
    .sort((a, b) => a.lastPlayedAt - b.lastPlayedAt || b.playCount - a.playCount || a.track.title.localeCompare(b.track.title))
    .slice(0, limit)
    .map((item) => trackItem(item.track, input.tracks));

  return {
    id: "forgottenFavorites",
    title: "久违收藏",
    items: ranked,
  };
}

export function buildQuickplayBlocks(input: QuickplayBlocksInput): QuickplayBlock[] {
  const blocks: QuickplayBlock[] = [];
  const continueBlock = buildContinueBlock(input);
  if (continueBlock) blocks.push(continueBlock);

  const mostPlayed = buildMostPlayedBlock(input);
  if (mostPlayed.items.length > 0) blocks.push(mostPlayed);

  const forgotten = buildForgottenFavoritesBlock(input);
  if (forgotten.items.length > 0) blocks.push(forgotten);

  const recent = buildRecentAddedBlock(input);
  if (recent.items.length > 0) blocks.push(recent);

  const history = buildHistoryBlock(input);
  if (history.items.length > 0) blocks.push(history);

  return blocks;
}

export function blockAlbumKey(track: Track) {
  return albumKey(track.album, track.album_artist ?? track.artist);
}

export function isPlaylistSmart(playlist: Playlist) {
  return isSmartPlaylist(playlist);
}
