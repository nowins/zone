import type {
  MetadataCandidate,
  MetadataTrackInput,
  MetadataTrackOverlay,
  Track,
  TrackLocalMetadata,
} from "../types.js";
import { albumKey, bestAlbumArtist } from "./music.js";

const AUTOMATIC_ARTIST_TRACK_LIMIT = 500;
const UNKNOWN_ARTIST_LABELS = new Set(["未知艺术家", "unknownartist", "unknown"]);

function localMetadataForTrack(track: Track): TrackLocalMetadata {
  return track.local_metadata ?? {
    title: track.title,
    artist: track.artist,
    album: track.album,
    album_artist: track.album_artist,
    track_number: track.track_number,
    disc_number: track.disc_number,
    year: track.year,
    genres: track.genres,
    cover_path: track.cover_path,
  };
}

export function metadataTrackInput(track: Track): MetadataTrackInput {
  const local = localMetadataForTrack(track);
  return {
    id: track.id,
    path: track.path,
    title: local.title,
    artist: local.artist,
    album: local.album,
    albumArtist: local.album_artist,
    trackNumber: local.track_number,
    discNumber: local.disc_number,
    year: local.year,
    genres: local.genres,
    durationSeconds: track.duration_seconds,
  };
}

export function applyMetadataOverlays(
  tracks: Track[],
  overlays: MetadataTrackOverlay[],
): Track[] {
  const overlaysByTrack = new Map(overlays.map((overlay) => [overlay.trackId, overlay]));

  return tracks.map((track) => {
    const local = localMetadataForTrack(track);
    const overlay = overlaysByTrack.get(track.id);
    if (!overlay) {
      if (
        !track.local_metadata
        && !track.metadata_enrichment
        && !track.artist_image_path
        && !track.artist_images?.length
        && !track.artist_biography
      ) return track;
      const restored: Track = {
        ...track,
        title: local.title,
        artist: local.artist,
        album: local.album,
        album_artist: local.album_artist,
        track_number: local.track_number,
        disc_number: local.disc_number,
        year: local.year,
        genres: local.genres,
        cover_path: local.cover_path,
      };
      delete restored.artist_image_path;
      delete restored.artist_images;
      delete restored.artist_biography;
      delete restored.local_metadata;
      delete restored.metadata_enrichment;
      return restored;
    }

    return {
      ...track,
      title: overlay.title ?? local.title,
      artist: overlay.artist ?? local.artist,
      album: overlay.album ?? local.album,
      album_artist: overlay.albumArtist ?? local.album_artist,
      track_number: overlay.trackNumber ?? local.track_number,
      disc_number: overlay.discNumber ?? local.disc_number,
      year: overlay.year ?? local.year,
      genres: overlay.genres ?? local.genres,
      cover_path: overlay.coverPath ?? local.cover_path,
      artist_image_path: overlay.artistImagePath ?? null,
      artist_images: overlay.artistImages,
      artist_biography: overlay.artistBiography ?? null,
      local_metadata: local,
      metadata_enrichment: {
        sources: overlay.sources,
      },
    };
  });
}

export function automaticArtistTrackScope(
  tracks: Track[],
  activeTrack: Track,
  limit = AUTOMATIC_ARTIST_TRACK_LIMIT,
): Track[] {
  const identity = normalizeArtistIdentity(activeTrack.artist);
  if (!identity || UNKNOWN_ARTIST_LABELS.has(identity)) return [];
  const safeLimit = Math.max(1, Math.min(AUTOMATIC_ARTIST_TRACK_LIMIT, Math.floor(limit)));
  const related = tracks.filter((track) => (
    track.id !== activeTrack.id && normalizeArtistIdentity(track.artist) === identity
  ));
  return [activeTrack, ...related].slice(0, safeLimit);
}

export function selectAutomaticArtistCandidate(
  candidates: MetadataCandidate[],
  excludedProviderIds: Iterable<string> = [],
): MetadataCandidate | null {
  const excluded = new Set(excludedProviderIds);
  const exact = candidates.filter((candidate) => (
    candidate.kind === "artist" && candidate.confidence === 100
    && !excluded.has(candidate.providerId)
  ));
  const localWithArtistDetails = exact.filter((candidate) => (
    candidate.providerId === "local-sidecar"
    && candidate.fields.some((field) => (
      field.key === "artist_image_path"
      || field.key === "artist_image_paths"
      || field.key === "biography"
    ))
  ));
  if (localWithArtistDetails.length === 1) return localWithArtistDetails[0];
  if (localWithArtistDetails.length > 1) return null;

  const netease = exact.filter((candidate) => candidate.providerId === "netease-music");
  return netease.length === 1 ? netease[0] : null;
}

export function artistNeedsAutomaticEnrichment(track: Track) {
  const imageCount = track.artist_images?.length
    ?? (track.artist_image_path ? 1 : 0);
  return imageCount < 2 || !track.artist_biography?.trim();
}

export function appliedArtistProviderIds(track: Track) {
  return new Set(
    track.metadata_enrichment?.sources
      .filter((source) => (
        source.field === "artist_image_path"
        || source.field === "artist_biography"
      ))
      .map((source) => source.providerId) ?? [],
  );
}

export function normalizeArtistIdentity(value: string | null | undefined) {
  return value
    ?.trim()
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "") ?? "";
}

export type ArtistBackfillTarget = {
  /** Display name taken from the track tag, never the normalized identity. */
  name: string;
  /** Performed tracks capped to the automatic scope limit. */
  tracks: Track[];
  /** Track whose enrichment state speaks for the whole artist. */
  profile: Track;
};

/**
 * Artists worth one automatic online lookup: performer-tagged, still missing
 * imagery or biography, and not yet enriched by every enabled provider.
 * Grouping and profile adoption mirror buildCollectionIndex so the batch pass,
 * playback enrichment and the artist index all agree on identities.
 */
export function selectArtistsForAutomaticBackfill(
  tracks: Track[],
  enabledProviderIds: Iterable<string>,
  limit = AUTOMATIC_ARTIST_TRACK_LIMIT,
): ArtistBackfillTarget[] {
  const providers = new Set(enabledProviderIds);
  if (providers.size === 0) return [];
  const safeLimit = Math.max(1, Math.min(AUTOMATIC_ARTIST_TRACK_LIMIT, Math.floor(limit)));
  const groups = new Map<string, { name: string; tracks: Track[] }>();
  for (const track of tracks) {
    const identity = normalizeArtistIdentity(track.artist);
    if (!identity || UNKNOWN_ARTIST_LABELS.has(identity)) continue;
    let group = groups.get(identity);
    if (!group) {
      group = { name: track.artist.trim(), tracks: [] };
      groups.set(identity, group);
    }
    group.tracks.push(track);
  }
  const targets: ArtistBackfillTarget[] = [];
  for (const group of groups.values()) {
    const sorted = [...group.tracks].sort((a, b) => a.id.localeCompare(b.id));
    const profile = sorted.find((track) => (
      track.artist_image_path || track.artist_images?.length || track.artist_biography
    )) ?? sorted[0];
    if (!artistNeedsAutomaticEnrichment(profile)) continue;
    const applied = appliedArtistProviderIds(profile);
    if ([...providers].every((id) => applied.has(id))) continue;
    targets.push({ name: group.name, tracks: sorted.slice(0, safeLimit), profile });
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

export type AlbumBackfillTarget = {
  /** Album title taken from the track tags. */
  name: string;
  /** Album artist used for matching (album-artist tag or performer fallback). */
  artist: string;
  tracks: Track[];
};

export function appliedAlbumCoverProviderIds(track: Track) {
  return new Set(
    track.metadata_enrichment?.sources
      .filter((source) => source.field === "album_cover_path")
      .map((source) => source.providerId) ?? [],
  );
}

const UNKNOWN_ALBUM_LABELS = new Set(["未知专辑", "unknownalbum", "unknown"]);

/**
 * Albums worth one automatic cover lookup: grouped exactly like the collection
 * index, no track carries any cover yet, and not every enabled provider has
 * already contributed one. Covers are album-level artwork, so a single covered
 * track disqualifies the whole group.
 */
export function selectAlbumsForAutomaticBackfill(
  tracks: Track[],
  enabledProviderIds: Iterable<string>,
): AlbumBackfillTarget[] {
  const providers = new Set(enabledProviderIds);
  if (providers.size === 0) return [];
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const identity = normalizeArtistIdentity(track.album);
    if (!identity || UNKNOWN_ALBUM_LABELS.has(identity)) continue;
    const key = albumKey(track.album, track.album_artist || track.artist);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(track);
  }
  const targets: AlbumBackfillTarget[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
    if (sorted.some((track) => track.cover_path)) continue;
    const applied = new Set(sorted.flatMap((track) => [...appliedAlbumCoverProviderIds(track)]));
    if ([...providers].every((id) => applied.has(id))) continue;
    targets.push({ name: sorted[0].album.trim(), artist: bestAlbumArtist(sorted), tracks: sorted });
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Automatic album adoption is stricter than the manual flow: providers score
 * album+artist exact matches at 95+ (year exact or untagged), the candidate
 * must actually carry artwork, and more than one eligible candidate from the
 * preferred provider means ambiguous editions — skip silently.
 */
export function selectAutomaticAlbumCandidate(
  candidates: MetadataCandidate[],
  excludedProviderIds: Iterable<string> = [],
): MetadataCandidate | null {
  const excluded = new Set(excludedProviderIds);
  const eligible = candidates.filter((candidate) => (
    candidate.kind === "album"
    && candidate.confidence >= 95
    && !excluded.has(candidate.providerId)
    && candidate.fields.some((field) => field.key === "album_cover_path")
  ));
  for (const providerId of ["local-sidecar", "netease-music", "apple-music-cn"]) {
    const fromProvider = eligible.filter((candidate) => candidate.providerId === providerId);
    if (fromProvider.length === 1) return fromProvider[0];
    if (fromProvider.length > 1) return null;
  }
  return null;
}
