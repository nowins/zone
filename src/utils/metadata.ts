import type {
  MetadataCandidate,
  MetadataTrackInput,
  MetadataTrackOverlay,
  Track,
  TrackLocalMetadata,
} from "../types.js";

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
