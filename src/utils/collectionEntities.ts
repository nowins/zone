import { albumKey, bestAlbumArtist, compareTracksForAlbum } from "./music.js";
import type { AlbumGroup, ArtistGroup, ContextPayload, Track } from "../types";

export type CollectionArtist = ArtistGroup & {
  albums: AlbumGroup[];
  appearances: AlbumGroup[];
  performedTracks: Track[];
  imagePath?: string | null;
  biography?: string | null;
};
export type CollectionEntityRef =
  | { kind: "track"; id: string }
  | { kind: "album"; key: string; anchorTrackId: string }
  | { kind: "artist"; name: string; anchorTrackId: string; role: "artist" | "album_artist" }
  | { kind: "playlist"; id: string };

/** One read-only index for every collection entry point; never split raw artist credits. */
export function buildCollectionIndex(tracks: Track[]) {
  const trackById = new Map(tracks.map(track => [track.id, track]));
  const grouped = new Map<string, Track[]>();
  const artistsByName = new Map<string, CollectionArtist>();
  const artist = (name: string) => {
    let value = artistsByName.get(name);
    if (!value) {
      value = { artist: name, tracks: [], performedTracks: [], albums: [], appearances: [] };
      artistsByName.set(name, value);
    }
    return value;
  };
  for (const track of tracks) {
    const key = albumKey(track.album, track.album_artist || track.artist);
    const group = grouped.get(key);
    if (group) group.push(track); else grouped.set(key, [track]);
    artist(track.artist).performedTracks.push(track);
  }
  const albums: AlbumGroup[] = [...grouped].map(([key, items]) => {
    const sorted = [...items].sort(compareTracksForAlbum);
    return { key, album: sorted[0].album, artist: bestAlbumArtist(sorted), tracks: sorted,
      coverPath: sorted.find(track => track.cover_path)?.cover_path,
      biography: sorted.find(track => track.album_description)?.album_description };
  }).sort((a, b) => a.album.localeCompare(b.album));
  const albumByKey = new Map(albums.map(album => [album.key, album]));
  const albumByTrackId = new Map<string, AlbumGroup>();
  for (const album of albums) {
    artist(album.artist).albums.push(album);
    for (const name of new Set(album.tracks.map(track => track.artist))) {
      if (name !== album.artist) artist(name).appearances.push(album);
    }
    for (const track of album.tracks) albumByTrackId.set(track.id, album);
  }
  const artists = [...artistsByName.values()].sort((a, b) => a.artist.localeCompare(b.artist));
  for (const value of artists) {
    value.tracks = [...new Map([...value.performedTracks, ...value.albums.flatMap(album => album.tracks)]
      .map(track => [track.id, track])).values()];
    // Keep a single adopted profile's fields together; album artists do not inherit performers' portraits.
    const profile = [...value.performedTracks].sort((a, b) => a.id.localeCompare(b.id))
      .find(track => track.artist_image_path || track.artist_images?.length || track.artist_biography);
    value.imagePath = profile?.artist_image_path || profile?.artist_images?.[0]?.path;
    value.biography = profile?.artist_biography;
  }
  return { tracks, trackById, albums, albumByKey, albumByTrackId, artists, artistsByName };
}
export type CollectionIndex = ReturnType<typeof buildCollectionIndex>;

export function albumReference(album: AlbumGroup): Extract<CollectionEntityRef, { kind: "album" }> {
  return { kind: "album", key: album.key, anchorTrackId: album.tracks[0].id };
}
export function artistReference(artist: CollectionArtist): Extract<CollectionEntityRef, { kind: "artist" }> {
  const performed = artist.performedTracks[0];
  return { kind: "artist", name: artist.artist, anchorTrackId: (performed || artist.tracks[0]).id,
    role: performed ? "artist" : "album_artist" };
}
export function resolveCollectionEntity(index: CollectionIndex, ref: CollectionEntityRef) {
  if (ref.kind === "track") {
    const track = index.trackById.get(ref.id);
    return track ? { kind: "track" as const, track } : null;
  }
  if (ref.kind === "album") {
    const album = index.albumByTrackId.get(ref.anchorTrackId);
    return album ? { kind: "album" as const, album } : null;
  }
  if (ref.kind === "artist") {
    const anchor = index.trackById.get(ref.anchorTrackId);
    if (!anchor) return null;
    const name = ref.role === "artist" ? anchor.artist : anchor.album_artist || anchor.artist;
    const artist = index.artistsByName.get(name);
    return artist ? { kind: "artist" as const, artist } : null;
  }
  return { kind: "playlist" as const, id: ref.id };
}
export function referenceForPayload(index: CollectionIndex, payload: ContextPayload): CollectionEntityRef | null {
  if (payload.kind === "playlist") return payload.playlistId ? { kind: "playlist", id: payload.playlistId } : null;
  const track = index.trackById.get(payload.tracks[0]?.id);
  if (payload.kind === "track") return track ? { kind: "track", id: track.id } : null;
  if (payload.kind === "album") {
    const album = payload.targetId ? index.albumByKey.get(payload.targetId) : track && index.albumByTrackId.get(track.id);
    return album ? albumReference(album) : null;
  }
  const artist = index.artistsByName.get(payload.targetId || payload.title);
  return artist ? artistReference(artist) : null;
}
export function collectionEntityKey(ref: CollectionEntityRef): string {
  return ref.kind === "album" ? `album:${ref.anchorTrackId}`
    : ref.kind === "artist" ? `artist:${ref.role}:${ref.anchorTrackId}` : `${ref.kind}:${ref.id}`;
}
/** Compare resolved identities: links can use different tracks as anchors. */
export function sameCollectionEntity(index: CollectionIndex, left: CollectionEntityRef | null, right: CollectionEntityRef | null): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  const a = resolveCollectionEntity(index, left), b = resolveCollectionEntity(index, right);
  if (!a || !b) return false;
  if (a.kind === "artist" && b.kind === "artist") return a.artist.artist === b.artist.artist;
  if (a.kind === "album" && b.kind === "album") return a.album.key === b.album.key;
  if (a.kind === "track" && b.kind === "track") return a.track.id === b.track.id;
  return left.kind === "playlist" && right.kind === "playlist" && left.id === right.id;
}
export function knownDuration(tracks: Track[]): number | null {
  return tracks.length && tracks.every(track => Number.isFinite(track.duration_seconds) && (track.duration_seconds ?? 0) > 0)
    ? tracks.reduce((sum, track) => sum + track.duration_seconds!, 0) : null;
}
