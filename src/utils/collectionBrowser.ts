import type { AlbumGroup, Track } from "../types";
import { resolveCollectionEntity, type CollectionEntityRef, type CollectionIndex } from "./collectionEntities.js";

export type CollectionBrowseView = "artists" | "albums" | "genres";
export type CollectionTrackSortField = "title" | "artist" | "album" | "genre" | "duration";
export type CollectionTrackSort = { field: CollectionTrackSortField; direction: "ascending" | "descending" };
type ArtistRef = Extract<CollectionEntityRef, { kind: "artist" }>;
type AlbumRef = Extract<CollectionEntityRef, { kind: "album" }>;
export type CollectionBrowserState = {
  artist: ArtistRef | null;
  genre: string | null;
  albums: Record<CollectionBrowseView, AlbumRef | null>;
  songSort: CollectionTrackSort;
  showGenre: boolean;
};
export const initialCollectionBrowser = (): CollectionBrowserState => ({
  artist: null, genre: null, albums: { artists: null, albums: null, genres: null },
  songSort: { field: "title", direction: "ascending" }, showGenre: false,
});
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
export const collectionGenreNames = (track: Track): string[] =>
  [...new Set((track.genres || []).map(name => name.trim()).filter(Boolean))];
const genreKey = (name: string) => "tag:" + name.normalize("NFKC").toLocaleLowerCase("zh-CN");
export type CollectionGenre = { key: string; name: string; tracks: Track[] };

/** Preserve raw credits and distinct tags; only normalize case, width and outer whitespace. */
export function buildCollectionGenres(tracks: Track[]): CollectionGenre[] {
  const groups = new Map<string, CollectionGenre>();
  for (const track of tracks) {
    const names = collectionGenreNames(track);
    const tags = names.length ? names.map(name => ({ key: genreKey(name), name })) : [{ key: "missing", name: "未知流派" }];
    for (const { key, name } of new Map(tags.map(tag => [tag.key, tag])).values()) {
      let group = groups.get(key);
      if (!group) { group = { key, name, tracks: [] }; groups.set(key, group); }
      group.tracks.push(track);
    }
  }
  return [...groups.values()].sort((a, b) => a.key === "missing" ? 1 : b.key === "missing" ? -1 : collator.compare(a.name, b.name));
}

/** Sorting is a display projection: it never mutates the library or an active queue. */
export function sortCollectionTracks(tracks: Track[], sort: CollectionTrackSort): Track[] {
  const value = (track: Track): string | number | null => {
    if (sort.field === "duration") {
      const duration = track.duration_seconds;
      return duration && Number.isFinite(duration) && duration > 0 ? duration : null;
    }
    const text = sort.field === "genre" ? collectionGenreNames(track).join(" / ") : track[sort.field];
    return text?.trim() || null;
  };
  return tracks.map((track, ordinal) => ({ track, ordinal, value: value(track) })).sort((a, b) => {
    // Unknown values remain last in both directions.
    if (a.value === null || b.value === null) return a.value === b.value ? a.ordinal - b.ordinal : a.value === null ? 1 : -1;
    const compared = typeof a.value === "number" && typeof b.value === "number" ? a.value - b.value
      : collator.compare(String(a.value), String(b.value));
    return compared ? compared * (sort.direction === "ascending" ? 1 : -1) : a.ordinal - b.ordinal;
  }).map(item => item.track);
}
export function nextCollectionTrackSort(current: CollectionTrackSort, field: CollectionTrackSortField): CollectionTrackSort {
  return { field, direction: current.field === field && current.direction === "ascending" ? "descending" : "ascending" };
}

export function resolveCollectionBrowser(index: CollectionIndex, view: CollectionBrowseView, state: CollectionBrowserState,
  genres = buildCollectionGenres(index.tracks)) {
  const resolvedArtist = state.artist && resolveCollectionEntity(index, state.artist);
  const artist = resolvedArtist?.kind === "artist" ? resolvedArtist.artist : null;
  const genre = genres.find(item => item.key === state.genre) || null;
  const primaryMissing = view === "artists" ? Boolean(state.artist && !artist) : view === "genres" ? Boolean(state.genre && !genre) : false;
  const scopeTracks = primaryMissing ? [] : view === "artists" && artist ? artist.tracks
    : view === "genres" && genre ? genre.tracks : index.tracks;
  const scopeIds = new Set(scopeTracks.map(track => track.id));
  const albums = index.albums.filter(album => album.tracks.some(track => scopeIds.has(track.id)));
  const reference = state.albums[view];
  const resolvedAlbum = reference && resolveCollectionEntity(index, reference);
  const album = resolvedAlbum?.kind === "album" && albums.some(item => item.key === resolvedAlbum.album.key) ? resolvedAlbum.album : null;
  const albumMissing = Boolean(reference && !album);
  const tracks = albumMissing ? [] : album ? album.tracks.filter(track => scopeIds.has(track.id))
    : sortCollectionTracks(scopeTracks, { field: "title", direction: "ascending" });
  const byArtist = new Map<string, AlbumGroup[]>();
  for (const item of albums) {
    const group = byArtist.get(item.artist);
    if (group) group.push(item); else byArtist.set(item.artist, [item]);
  }
  const albumGroups = [...byArtist].sort(([a], [b]) => collator.compare(a, b)).map(([name, items]) => ({ name, albums: items }));
  return { artist, genre, albums, album, tracks, albumGroups, primaryMissing, albumMissing };
}
