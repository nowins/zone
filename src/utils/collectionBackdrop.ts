import type { Track } from "../types";
import { albumKey } from "./music.js";
import { clamp } from "../motion/math.js";

export type CollectionBackdropAssetRole =
  | "artist"
  | "active-album"
  | "related-album";

export type CollectionBackdropAsset = {
  key: string;
  path: string;
  role: CollectionBackdropAssetRole;
  label: string;
};

export type CollectionBackdropScene = {
  sceneKey: string;
  assetKey: string;
  seed: number;
  label: string;
  assets: CollectionBackdropAsset[];
};

export type CollectionBackdropPlacement = {
  assetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  rotation: number;
  cropX: number;
  cropY: number;
};

type BackdropBandSlot = Omit<CollectionBackdropPlacement, "assetIndex" | "x" | "y" | "width" | "height"> & {
  x: number;
  y: number;
  width: number;
  height: number;
  assetOffset: number;
};

const DEFAULT_MAX_ASSETS = 6;
const PARALLAX_RATE = 0.15;
const MIN_BAND_HEIGHT = 340;
const MAX_BAND_HEIGHT = 580;

// The slots form one editorial band. Bands repeat vertically with alternating
// direction, so a long collection reveals new crops instead of translating a
// single viewport-sized wallpaper.
const BACKDROP_BAND_SLOTS: BackdropBandSlot[] = [
  { assetOffset: 0, x: -0.04, y: -0.08, width: 0.32, height: 0.72, opacity: 0.32, rotation: -0.012, cropX: 0.34, cropY: 0.28 },
  { assetOffset: 1, x: 0.22, y: 0.2, width: 0.25, height: 0.72, opacity: 0.28, rotation: 0.008, cropX: 0.58, cropY: 0.52 },
  { assetOffset: 2, x: 0.43, y: -0.12, width: 0.36, height: 0.86, opacity: 0.38, rotation: -0.007, cropX: 0.5, cropY: 0.34 },
  { assetOffset: 3, x: 0.74, y: 0.24, width: 0.31, height: 0.7, opacity: 0.3, rotation: 0.011, cropX: 0.62, cropY: 0.58 },
  { assetOffset: 4, x: 0.08, y: 0.68, width: 0.29, height: 0.48, opacity: 0.22, rotation: -0.006, cropX: 0.44, cropY: 0.68 },
];

export function buildCollectionBackdropScene({
  tracks,
  activeTrack,
  artistImagePath,
  maxAssets = DEFAULT_MAX_ASSETS,
}: {
  tracks: Track[];
  activeTrack: Track | null;
  artistImagePath?: string | null;
  maxAssets?: number;
}): CollectionBackdropScene | null {
  if (!activeTrack) return null;

  const artistLabel = activeTrack.artist.trim() || activeTrack.album_artist?.trim() || "未知艺术家";
  const artistIdentities = new Set([
    normalizeIdentity(activeTrack.artist),
    normalizeIdentity(activeTrack.album_artist),
  ].filter(Boolean));
  const artistIdentity = normalizeIdentity(artistLabel);
  const sceneKey = `artist:${artistIdentity || activeTrack.id}`;
  const assets: CollectionBackdropAsset[] = [];
  const seenPaths = new Set<string>();
  const limit = Math.max(1, Math.min(8, Math.floor(maxAssets)));

  const pushAsset = (
    path: string | null | undefined,
    role: CollectionBackdropAssetRole,
    label: string,
    key: string,
  ) => {
    const cleanPath = path?.trim();
    if (!cleanPath || seenPaths.has(cleanPath) || assets.length >= limit) return;
    seenPaths.add(cleanPath);
    assets.push({ key, path: cleanPath, role, label });
  };

  const relatedTracks = tracks.filter((track) => (
    [normalizeIdentity(track.artist), normalizeIdentity(track.album_artist)]
      .some((identity) => identity && artistIdentities.has(identity))
  ));
  const resolvedArtistImagePath = artistImagePath
    ?? relatedTracks.find((track) => track.artist_image_path)?.artist_image_path;
  pushAsset(resolvedArtistImagePath, "artist", artistLabel, sceneKey);

  const currentAlbumKey = albumKey(
    activeTrack.album,
    activeTrack.album_artist ?? activeTrack.artist,
  );
  pushAsset(
    activeTrack.cover_path,
    "active-album",
    activeTrack.album,
    `album:${currentAlbumKey}`,
  );

  const relatedAlbums = new Map<string, { album: string; coverPath: string }>();
  for (const track of relatedTracks) {
    if (!track.cover_path) continue;
    const key = albumKey(track.album, track.album_artist ?? track.artist);
    if (key === currentAlbumKey || relatedAlbums.has(key)) continue;
    relatedAlbums.set(key, { album: track.album, coverPath: track.cover_path });
  }

  for (const [key, album] of [...relatedAlbums.entries()].sort(([left], [right]) => (
    left.localeCompare(right, "zh-CN")
  ))) {
    pushAsset(album.coverPath, "related-album", album.album, `album:${key}`);
  }

  if (assets.length === 0) return null;
  return {
    sceneKey,
    assetKey: assets.map((asset) => `${asset.role}:${asset.path}`).join("\u0000"),
    seed: stableStringSeed(sceneKey),
    label: artistLabel,
    assets,
  };
}

export function buildCollectionBackdropLayout(
  width: number,
  height: number,
  assets: CollectionBackdropAsset[],
  seed: number,
  scrollOffset = 0,
): CollectionBackdropPlacement[] {
  if (width <= 0 || height <= 0 || assets.length === 0) return [];

  const orderedAssetIndices = assets
    .map((asset, index) => ({ asset, index }))
    .sort((left, right) => assetRolePriority(left.asset.role) - assetRolePriority(right.asset.role))
    .map(({ index }) => index);
  const bandHeight = clamp(height * 0.58, MIN_BAND_HEIGHT, MAX_BAND_HEIGHT);
  const worldTop = Math.max(0, -scrollOffset);
  const firstBand = Math.floor((worldTop - bandHeight) / bandHeight);
  const lastBand = Math.ceil((worldTop + height + bandHeight) / bandHeight);
  const placements: CollectionBackdropPlacement[] = [];

  for (let bandIndex = firstBand; bandIndex <= lastBand; bandIndex += 1) {
    const mirrored = positiveModulo(seed + bandIndex, 2) === 1;
    const direction = mirrored ? -1 : 1;
    const bandSeed = seed + bandIndex * 1_009;

    BACKDROP_BAND_SLOTS.forEach((slot, slotIndex) => {
      const assetIndex = orderedAssetIndices[
        positiveModulo(bandIndex * 3 + slot.assetOffset, orderedAssetIndices.length)
      ];
      const jitter = seededNoise(bandSeed + slotIndex * 97) - 0.5;
      const cropJitter = seededNoise(bandSeed + slotIndex * 173) - 0.5;
      const tileWidth = width * slot.width;
      const tileHeight = bandHeight * slot.height;
      const plannedX = width * (slot.x + jitter * 0.03);

      placements.push({
        assetIndex,
        x: mirrored ? width - plannedX - tileWidth : plannedX,
        y: bandIndex * bandHeight + bandHeight * (slot.y + jitter * 0.028) + scrollOffset,
        width: tileWidth,
        height: tileHeight,
        opacity: slot.opacity,
        rotation: (slot.rotation + jitter * 0.008) * direction,
        cropX: clamp(mirrored ? 1 - slot.cropX - cropJitter * 0.22 : slot.cropX + cropJitter * 0.22, 0.08, 0.92),
        cropY: clamp(slot.cropY - cropJitter * 0.24, 0.08, 0.92),
      });
    });
  }

  return placements;
}

export function collectionParallaxOffset(
  scrollTop: number,
  reducedMotion = false,
): number {
  if (reducedMotion) return 0;
  const offset = Math.max(0, scrollTop) * PARALLAX_RATE;
  return offset > 0 ? -offset : 0;
}

function assetRolePriority(role: CollectionBackdropAssetRole) {
  if (role === "artist") return 0;
  if (role === "active-album") return 1;
  return 2;
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function normalizeIdentity(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function stableStringSeed(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function seededNoise(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453;
  return value - Math.floor(value);
}
