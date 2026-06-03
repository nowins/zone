import type { AlbumGroup, Track } from "../types";

export type WallTilePattern = {
  columns: number;
  rows: number;
};

export const NOW_PLAYING_WALL_TILE_COUNT = 96;

export const WALL_TILE_PATTERN: WallTilePattern[] = [
  { columns: 3, rows: 2 },
  { columns: 2, rows: 1 },
  { columns: 1, rows: 1 },
  { columns: 2, rows: 3 },
  { columns: 1, rows: 2 },
  { columns: 4, rows: 3 },
  { columns: 3, rows: 2 },
  { columns: 1, rows: 1 },
  { columns: 2, rows: 2 },
  { columns: 3, rows: 1 },
  { columns: 2, rows: 3 },
  { columns: 1, rows: 1 },
  { columns: 1, rows: 2 },
  { columns: 2, rows: 1 },
  { columns: 3, rows: 2 },
  { columns: 1, rows: 1 },
  { columns: 4, rows: 2 },
  { columns: 2, rows: 2 },
];

export function wallTilePatternForIndex(index: number) {
  return WALL_TILE_PATTERN[index % WALL_TILE_PATTERN.length];
}

export function buildNowPlayingWall(tracks: Track[], active: Track | null) {
  const albumMap = new Map<string, AlbumGroup>();
  for (const item of tracks) {
    const key = albumKey(item.album);
    if (!albumMap.has(key)) {
      albumMap.set(key, {
        key,
        album: item.album,
        artist: item.artist,
        tracks: [item],
        coverPath: item.cover_path,
      });
      continue;
    }

    const album = albumMap.get(key)!;
    album.tracks.push(item);
    if (!album.coverPath && item.cover_path) album.coverPath = item.cover_path;
  }

  const activeArtist = active?.artist.trim().toLocaleLowerCase();
  const albums = Array.from(albumMap.values()).filter((album) => album.coverPath);
  const artistAlbums = activeArtist
    ? albums.filter((album) => album.artist.trim().toLocaleLowerCase() === activeArtist)
    : [];
  const otherAlbums = activeArtist
    ? albums.filter((album) => album.artist.trim().toLocaleLowerCase() !== activeArtist)
    : albums;

  const weightedAlbums = [
    ...artistAlbums,
    ...artistAlbums,
    ...otherAlbums,
  ];

  if (active) {
    const activeAlbum = {
      key: albumKey(active.album),
      album: active.album,
      artist: active.artist,
      tracks: [active],
      coverPath: active.cover_path,
    };
    weightedAlbums.unshift(activeAlbum, activeAlbum);
  }

  const source = weightedAlbums.length > 0
    ? weightedAlbums
    : [{ key: "zone", album: "Zone", artist: "Zone", tracks: [], coverPath: null }];
  return Array.from(
    { length: NOW_PLAYING_WALL_TILE_COUNT },
    (_, index) => source[(index * 7 + Math.floor(index / 5)) % source.length],
  );
}

function albumKey(album: string) {
  return album.trim().toLocaleLowerCase() || "unknown album";
}
