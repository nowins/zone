import type {
  AlbumGroup,
  ArtistGroup,
  Playlist,
  Track,
  TrackActivityMap,
} from "../types";
import { resolvePlaylistTracks } from "./smartPlaylist.js";

export type LibrarySearchPlaylist = {
  playlist: Playlist;
  tracks: Track[];
};

export type LibrarySearchResults = {
  artists: ArtistGroup[];
  albums: AlbumGroup[];
  tracks: Track[];
  playlists: LibrarySearchPlaylist[];
  total: number;
};

export type LibrarySearchInput = {
  query: string;
  tracks: Track[];
  albums: AlbumGroup[];
  artists: ArtistGroup[];
  playlists: Playlist[];
  favoriteTrackIds: ReadonlySet<string>;
  activity: TrackActivityMap;
};

type Ranked<T> = {
  item: T;
  score: number;
  label: string;
};

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function scoreText(value: string | undefined, needle: string): number | null {
  if (!value) return null;
  const normalized = normalizeSearchText(value);
  if (!normalized) return null;
  if (normalized === needle) return 0;
  if (normalized.startsWith(needle)) return 1;

  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.some((token) => token.startsWith(needle))) return 2;

  const position = normalized.indexOf(needle);
  return position >= 0 ? 3 + Math.min(position, 30) / 100 : null;
}

function bestScore(fields: Array<[string | undefined, number]>, needle: string): number | null {
  let best: number | null = null;
  for (const [value, weight] of fields) {
    const score = scoreText(value, needle);
    if (score === null) continue;
    const weighted = score + weight;
    if (best === null || weighted < best) best = weighted;
  }
  return best;
}

function trackScore(track: Track, needle: string): number | null {
  return bestScore([
    [track.title, 0],
    [track.artist, 4],
    [track.album, 6],
    [track.album_artist, 7],
    [track.file_name, 9],
  ], needle);
}

function sortRanked<T>(items: Ranked<T>[]): T[] {
  return items
    .sort((left, right) =>
      left.score - right.score
      || left.label.localeCompare(right.label, "zh-CN", { numeric: true }),
    )
    .map(({ item }) => item);
}

export function searchLibrary({
  query,
  tracks,
  albums,
  artists,
  playlists,
  favoriteTrackIds,
  activity,
}: LibrarySearchInput): LibrarySearchResults {
  const needle = normalizeSearchText(query);
  if (!needle) {
    return { artists: [], albums: [], tracks: [], playlists: [], total: 0 };
  }

  const rankedArtists: Ranked<ArtistGroup>[] = [];
  for (const artist of artists) {
    const score = scoreText(artist.artist, needle);
    if (score !== null) rankedArtists.push({ item: artist, score, label: artist.artist });
  }

  const rankedAlbums: Ranked<AlbumGroup>[] = [];
  for (const album of albums) {
    const score = bestScore([
      [album.album, 0],
      [album.artist, 4],
    ], needle);
    if (score !== null) rankedAlbums.push({ item: album, score, label: album.album });
  }

  const rankedTracks: Ranked<Track>[] = [];
  for (const track of tracks) {
    const score = trackScore(track, needle);
    if (score !== null) rankedTracks.push({ item: track, score, label: track.title });
  }

  const rankedPlaylists: Ranked<LibrarySearchPlaylist>[] = [];
  for (const playlist of playlists) {
    const resolved = resolvePlaylistTracks(playlist, tracks, { favoriteTrackIds, activity }).tracks;
    const directScore = bestScore([
      [playlist.name, 0],
      [playlist.description, 4],
    ], needle);
    const contentScore = resolved.reduce<number | null>((best, track) => {
      const score = trackScore(track, needle);
      if (score === null) return best;
      const weighted = score + 10;
      return best === null || weighted < best ? weighted : best;
    }, null);
    const score = directScore === null
      ? contentScore
      : contentScore === null
        ? directScore
        : Math.min(directScore, contentScore);
    if (score !== null) {
      rankedPlaylists.push({
        item: { playlist, tracks: resolved },
        score,
        label: playlist.name,
      });
    }
  }

  const results = {
    artists: sortRanked(rankedArtists),
    albums: sortRanked(rankedAlbums),
    tracks: sortRanked(rankedTracks),
    playlists: sortRanked(rankedPlaylists),
  };

  return {
    ...results,
    total: results.artists.length
      + results.albums.length
      + results.tracks.length
      + results.playlists.length,
  };
}
