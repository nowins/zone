import type { AlbumGroup, Track } from "../types";
import { albumKey } from "./music.js";

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
    const key = albumKey(item.album, item.album_artist ?? item.artist);
    if (!albumMap.has(key)) {
      albumMap.set(key, {
        key,
        album: item.album,
        artist: item.album_artist ?? item.artist,
        tracks: [item],
        coverPath: item.cover_path,
      });
      continue;
    }

    const album = albumMap.get(key)!;
    album.tracks.push(item);
    if (!album.coverPath && item.cover_path) album.coverPath = item.cover_path;
  }

  const activeArtist = (active?.album_artist ?? active?.artist)?.trim().toLocaleLowerCase();
  const albums = Array.from(albumMap.values()).filter((album) => album.coverPath);
  const artistAlbums = activeArtist
    ? albums.filter((album) => album.artist.trim().toLocaleLowerCase() === activeArtist)
    : [];
  const otherAlbums = activeArtist
    ? albums.filter((album) => album.artist.trim().toLocaleLowerCase() !== activeArtist)
    : albums;

  // Enriched artist photos join the collage next to album covers; the active
  // track's own images lead, then other tracks credited to the same artist.
  const artistImagePaths: string[] = [];
  const seenArtistImages = new Set<string>();
  if (activeArtist) {
    const relatedFirst = active
      ? [active, ...tracks.filter((track) => track.id !== active.id)]
      : tracks;
    for (const track of relatedFirst) {
      const credited = [track.artist, track.album_artist]
        .some((name) => name?.trim().toLocaleLowerCase() === activeArtist);
      if (!credited) continue;
      const paths = [
        track.artist_image_path,
        ...(track.artist_images?.map((image) => image.path) ?? []),
      ];
      for (const path of paths) {
        const clean = path?.trim();
        if (!clean || seenArtistImages.has(clean)) continue;
        seenArtistImages.add(clean);
        artistImagePaths.push(clean);
        if (artistImagePaths.length >= 4) break;
      }
      if (artistImagePaths.length >= 4) break;
    }
  }
  const artistName = (active?.album_artist ?? active?.artist)?.trim() || "艺术家";
  const artistEntries: AlbumGroup[] = artistImagePaths.map((path, index) => ({
    key: `artist-image:${activeArtist ?? "unknown"}:${index}`,
    album: artistName,
    artist: artistName,
    tracks: [],
    coverPath: path,
  }));

  // Prefer active artist covers and photos, then fill with other albums that
  // actually have art. Photos carry a quadruple weight (double the artist
  // albums') so they stay visible in large libraries instead of drowning out.
  const coveredOthers = otherAlbums.filter((album) => Boolean(album.coverPath));
  const weightedAlbums = [
    ...artistAlbums,
    ...artistAlbums,
    ...artistEntries,
    ...artistEntries,
    ...artistEntries,
    ...artistEntries,
    ...coveredOthers,
  ];

  if (active?.cover_path) {
    const activeAlbum = {
      key: albumKey(active.album, active.album_artist ?? active.artist),
      album: active.album,
      artist: active.album_artist ?? active.artist,
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


export function pickCoverCandidates(tracks: Track[], limit: number, preferredArtist?: string | null) {
  const preferred = (preferredArtist ?? "").trim().toLocaleLowerCase();
  const seen = new Set<string>();
  const preferredPaths: string[] = [];
  const otherPaths: string[] = [];
  for (const track of tracks) {
    if (!track.cover_path || seen.has(track.cover_path)) continue;
    seen.add(track.cover_path);
    const artist = (track.album_artist ?? track.artist).trim().toLocaleLowerCase();
    if (preferred && artist === preferred) preferredPaths.push(track.cover_path);
    else otherPaths.push(track.cover_path);
    if (preferredPaths.length + otherPaths.length >= limit * 2) break;
  }
  return [...preferredPaths, ...otherPaths].slice(0, limit);
}
