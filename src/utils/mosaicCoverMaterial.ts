export const MOSAIC_COVER_MATERIAL = {
  weights: [0.15, 0.55, 0.30] as const,
  contrast: 0.85,
  // Native D3DCOLOR quantizes the Graphic's .35 alpha to 0x59.
  opacity: 89 / 255,
};

/** Iris packs the fully inherited animated alpha into D3DCOLOR before draw. */
export function mosaicCoverVertexAlpha(amount = 1, inheritedAlpha = 1) {
  return Math.floor(Math.max(0, Math.min(1, 0.35 * amount * inheritedAlpha)) * 255 + 1e-7) / 255;
}

/** Flatten the captured Iris cover shader over its opaque black cell backing. */
export function applyMosaicCoverMaterial(pixels: Uint8ClampedArray) {
  const { weights, contrast, opacity } = MOSAIC_COVER_MATERIAL;
  for (let index = 0; index < pixels.length; index += 4) {
    const gray = pixels[index] * weights[0] + pixels[index + 1] * weights[1] + pixels[index + 2] * weights[2];
    const color = ((gray - 127.5) * contrast + 127.5) * pixels[index + 3] / 255 * opacity;
    pixels[index] = pixels[index + 1] = pixels[index + 2] = color;
    pixels[index + 3] = 255;
  }
}
