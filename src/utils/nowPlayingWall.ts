import type { AlbumGroup, Track } from "../types";
import { albumKey } from "./music.js";

export const NOW_PLAYING_WALL_TILE_COUNT = 20;

export function buildNowPlayingWall(tracks: Track[], active: Track | null, queue: Track[] = []) {
  const albumMap = new Map<string, AlbumGroup>();
  const addedTrackIds = new Set<string>();
  const queueWindow = queue.slice(0, NOW_PLAYING_WALL_TILE_COUNT);
  for (const item of [...tracks, ...queueWindow, ...(active ? [active] : [])]) {
    const key = albumKey(item.album, item.album_artist ?? item.artist);
    if (!albumMap.has(key)) {
      albumMap.set(key, {
        key,
        album: item.album,
        artist: item.album_artist ?? item.artist,
        tracks: [item],
        coverPath: item.cover_path,
      });
      addedTrackIds.add(item.id);
      continue;
    }

    const album = albumMap.get(key)!;
    if (!addedTrackIds.has(item.id)) {
      album.tracks.push(item);
      addedTrackIds.add(item.id);
    }
    if (!album.coverPath && item.cover_path) album.coverPath = item.cover_path;
  }

  const activeArtist = (active?.album_artist ?? active?.artist)?.trim().toLocaleLowerCase();
  const albums = Array.from(albumMap.values()).filter((album) => album.coverPath);
  const activeAlbumKey = active ? albumKey(active.album, active.album_artist ?? active.artist) : null;
  // An album's canonical library order owns photo selection, so changing songs
  // within that album does not remap the wall's decoded surfaces.
  const artistImagePaths: string[] = [];
  const seenArtistImages = new Set<string>();
  if (activeArtist) {
    const relatedFirst = [
      ...(activeAlbumKey ? albumMap.get(activeAlbumKey)?.tracks ?? [] : []),
      ...tracks,
      ...(active ? [active] : []),
    ];
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
  const artistEntries: AlbumGroup[] = artistImagePaths.sort().map(path => ({
    key: `artist-image:${activeArtist ?? "unknown"}:${path}`,
    album: artistName,
    artist: artistName,
    tracks: [],
    coverPath: path,
  }));

  // Zune fills a bounded pool from the queue before library albums. Reserve
  // at most four slots for Zone's existing artist-photo enrichment.
  const selected: AlbumGroup[] = [];
  const selectedKeys = new Set<string>();
  const albumLimit = NOW_PLAYING_WALL_TILE_COUNT - artistEntries.length;
  const addAlbum = (key: string | null) => {
    if (!key || selected.length >= albumLimit || selectedKeys.has(key)) return;
    const album = albumMap.get(key);
    if (!album?.coverPath) return;
    selectedKeys.add(key);
    selected.push(album);
  };
  addAlbum(activeAlbumKey);
  for (const item of queueWindow) addAlbum(albumKey(item.album, item.album_artist ?? item.artist));
  for (const album of albums) addAlbum(album.key);
  selected.push(...artistEntries);

  const source = selected.length > 0
    ? selected
    : [{ key: "zone", album: "Zone", artist: "Zone", tracks: [], coverPath: null }];
  const pool = Array.from(
    { length: NOW_PLAYING_WALL_TILE_COUNT },
    (_, index) => source[index % source.length],
  );
  return shuffleWallPool(pool);
}

function shuffleWallPool(pool: AlbumGroup[]) {
  // A deterministic Fisher-Yates shuffle keeps playback progress and same-album
  // song changes from rebuilding the wall while avoiding queue-order rows.
  let seed = 2166136261;
  for (const entry of pool) {
    const identity = `${entry.key}\0${entry.coverPath ?? ""}\0`;
    for (let index = 0; index < identity.length; index += 1) {
      seed = Math.imul(seed ^ identity.charCodeAt(index), 16777619) >>> 0;
    }
  }
  for (let index = pool.length - 1; index > 0; index -= 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const target = (seed >>> 0) % (index + 1);
    [pool[index], pool[target]] = [pool[target], pool[index]];
  }
  return pool;
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
