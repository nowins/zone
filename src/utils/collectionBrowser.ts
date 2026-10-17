import type { AlbumGroup, Track } from "../types";
import { resolveCollectionEntity, type CollectionEntityRef, type CollectionIndex } from "./collectionEntities.js";
import { compareTracksForAlbum } from "./music.js";

export type CollectionBrowseView = "artists" | "albums" | "genres";
export type CollectionTrackSortField = "title" | "artist" | "album" | "genre" | "duration" | "favorite" | "position";
export type CollectionTrackSort = { field: CollectionTrackSortField; direction: "ascending" | "descending" };
export type CollectionBrowseSongSort = "auto" | "title" | "album" | "favorite";
export type CollectionAlbumSort = "auto" | "title" | "year" | "added";
type ArtistRef = Extract<CollectionEntityRef, { kind: "artist" }>;
type AlbumRef = Extract<CollectionEntityRef, { kind: "album" }>;
export type CollectionBrowserState = {
  artist: ArtistRef | null;
  genre: string | null;
  albums: Record<CollectionBrowseView, AlbumRef | null>;
  songSort: CollectionTrackSort;
  showGenre: boolean;
  browseSongSort: Record<CollectionBrowseView, CollectionBrowseSongSort>;
  albumSort: Record<CollectionBrowseView, CollectionAlbumSort>;
  playlistSort: Record<string, CollectionTrackSort>;
};
export const initialCollectionBrowser = (): CollectionBrowserState => ({
  artist: null, genre: null, albums: { artists: null, albums: null, genres: null },
  songSort: { field: "title", direction: "ascending" }, showGenre: false,
  browseSongSort: { artists: "auto", albums: "auto", genres: "auto" },
  albumSort: { artists: "auto", albums: "auto", genres: "auto" }, playlistSort: {},
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
export function sortCollectionTracks(tracks: Track[], sort: CollectionTrackSort, favorites?: ReadonlySet<string>): Track[] {
  const value = (track: Track, ordinal: number): string | number | null => {
    if (sort.field === "position") return ordinal;
    if (sort.field === "favorite") return favorites?.has(track.id) ? 1 : 0;
    if (sort.field === "duration") {
      const duration = track.duration_seconds;
      return duration && Number.isFinite(duration) && duration > 0 ? duration : null;
    }
    const text = sort.field === "genre" ? collectionGenreNames(track).join(" / ") : track[sort.field];
    return text?.trim() || null;
  };
  return tracks.map((track, ordinal) => ({ track, ordinal, value: value(track, ordinal) })).sort((a, b) => {
    // Unknown values remain last in both directions.
    if (a.value === null || b.value === null) return a.value === b.value ? a.ordinal - b.ordinal : a.value === null ? 1 : -1;
    const compared = typeof a.value === "number" && typeof b.value === "number" ? a.value - b.value
      : collator.compare(String(a.value), String(b.value));
    return compared ? compared * (sort.direction === "ascending" ? 1 : -1) : a.ordinal - b.ordinal;
  }).map(item => item.track);
}
export function nextCollectionTrackSort(current: CollectionTrackSort, field: CollectionTrackSortField): CollectionTrackSort {
  return { field, direction: current.field === field ? current.direction === "ascending" ? "descending" : "ascending"
    : field === "favorite" ? "descending" : "ascending" };
}

export function collectionAlbumYear(album: AlbumGroup): number | null {
  return album.tracks.find(track => Number.isInteger(track.year) && (track.year || 0) > 0)?.year ?? null;
}

function sortAlbums(albums: AlbumGroup[], field: Exclude<CollectionAlbumSort, "auto">): AlbumGroup[] {
  const value = (album: AlbumGroup) => field === "year" ? collectionAlbumYear(album)
    : album.tracks.reduce((latest, track) => Number.isFinite(track.added_at) ? Math.max(latest, track.added_at || 0) : latest, 0) || null;
  return [...albums].sort((a, b) => {
    if (field !== "title") {
      const av = value(a), bv = value(b);
      if (av === null || bv === null) { if (av !== bv) return av === null ? 1 : -1; }
      else if (av !== bv) return bv - av;
    }
    return collator.compare(a.album, b.album) || collator.compare(a.artist, b.artist);
  });
}

/** Album ordering retains the source's disc/track order; likes are a stable projection. */
function sortBrowseSongs(tracks: Track[], index: CollectionIndex, field: Exclude<CollectionBrowseSongSort, "auto">, favorites?: ReadonlySet<string>): Track[] {
  if (field !== "album") return sortCollectionTracks(tracks,
    { field: field === "favorite" ? "favorite" : "title", direction: field === "favorite" ? "descending" : "ascending" }, favorites);
  return [...tracks].sort((a, b) => {
    const aa = index.albumByTrackId.get(a.id)!, ba = index.albumByTrackId.get(b.id)!;
    return collator.compare(aa.artist, ba.artist) || collator.compare(aa.album, ba.album) || compareTracksForAlbum(a, b);
  });
}

export function resolveCollectionBrowser(index: CollectionIndex, view: CollectionBrowseView, state: CollectionBrowserState,
  genres = buildCollectionGenres(index.tracks), favorites?: ReadonlySet<string>) {
  const resolvedArtist = state.artist && resolveCollectionEntity(index, state.artist);
  const artist = resolvedArtist?.kind === "artist" ? resolvedArtist.artist : null;
  const genre = genres.find(item => item.key === state.genre) || null;
  const primaryMissing = view === "artists" ? Boolean(state.artist && !artist) : view === "genres" ? Boolean(state.genre && !genre) : false;
  const scopeTracks = primaryMissing ? [] : view === "artists" && artist ? artist.tracks
    : view === "genres" && genre ? genre.tracks : index.tracks;
  const scopeIds = new Set(scopeTracks.map(track => track.id));
  const albumSort = state.albumSort[view] === "auto" ? view === "artists" ? artist ? "year" : "added" : view === "genres" ? "year" : "title" : state.albumSort[view];
  const albums = sortAlbums(index.albums.filter(album => album.tracks.some(track => scopeIds.has(track.id))), albumSort);
  const reference = state.albums[view];
  const resolvedAlbum = reference && resolveCollectionEntity(index, reference);
  const album = resolvedAlbum?.kind === "album" && albums.some(item => item.key === resolvedAlbum.album.key) ? resolvedAlbum.album : null;
  const albumMissing = Boolean(reference && !album);
  const songSort = state.browseSongSort[view] === "auto" ? album ? "album" : "title" : state.browseSongSort[view];
  const tracks = albumMissing ? [] : sortBrowseSongs(album ? album.tracks.filter(track => scopeIds.has(track.id)) : scopeTracks, index, songSort, favorites);
  const byArtist = new Map<string, AlbumGroup[]>();
  for (const item of albums) {
    const group = byArtist.get(item.artist);
    if (group) group.push(item); else byArtist.set(item.artist, [item]);
  }
  const albumGroups = [...byArtist].sort(([a], [b]) => collator.compare(a, b)).map(([name, items]) => ({ name, albums: items }));
  return { artist, genre, albums, album, tracks, albumGroups, primaryMissing, albumMissing, albumSort, songSort };
}
