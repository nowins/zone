import type {
  MetadataTrackInput,
  MetadataTrackOverlay,
  Track,
  TrackLocalMetadata,
} from "../types.js";

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
      if (!track.local_metadata && !track.metadata_enrichment && !track.artist_image_path) return track;
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
      local_metadata: local,
      metadata_enrichment: {
        sources: overlay.sources,
      },
    };
  });
}
