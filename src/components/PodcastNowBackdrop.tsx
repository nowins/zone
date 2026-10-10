import { useEffect, useRef } from "react";
import { useReducedMotion } from "../motion/useReducedMotion";
import { extractMosaicColorPalette } from "../utils/nowPlayingCanvas";
import type { RgbColor } from "../utils/nowPlayingCanvas";
import { getVisualizerFrame } from "../utils/visualizerBus";

// Ambient cadence lives here as JS constants (like CycleTile's interval): the
// breathing pan runs on incommensurate periods so it never reads as a loop,
// and the ember follows the shared visualizer bus with heavy smoothing —
// speech should warm the floor, not pump it.
const DRIFT_PERIOD_A_S = 41;
const DRIFT_PERIOD_B_S = 53;
const EMBER_FLOOR = 0.1;
const EMBER_RANGE = 0.3;
const EMBER_EASE = 0.06;

/**
 * Podcast now-playing ambience: the show's artwork blurred large with a slow
 * breathing pan, a two-color wash derived from the artwork's palette, and an
 * ember glow along the bottom edge driven by the live audio energy. Purely
 * presentational — everything is aria-hidden and pointer-free.
 */
export function PodcastNowBackdrop({ artworkSrc }: { artworkSrc: string | null }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const artRef = useRef<HTMLImageElement | null>(null);
  const emberRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion();

  // Tint the stage with the show's own palette. The artwork proxy sends CORS
  // headers, so canvas readback is allowed; fallbacks in CSS keep the stage
  // readable when a show has no artwork or sampling fails.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !artworkSrc) return undefined;
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      if (cancelled) return;
      const wash = sampleWashColors(image);
      if (!wash) return;
      root.style.setProperty("--podcast-now-wash-a", wash[0]);
      root.style.setProperty("--podcast-now-wash-b", wash[1]);
    };
    image.src = artworkSrc;
    return () => {
      cancelled = true;
      root.style.removeProperty("--podcast-now-wash-a");
      root.style.removeProperty("--podcast-now-wash-b");
    };
  }, [artworkSrc]);

  // One rAF owns both ambient layers and writes straight to the DOM: the slow
  // breathing pan on the artwork plus the ember's response to playback energy.
  // Reduced motion keeps both layers in their static CSS state.
  useEffect(() => {
    if (reducedMotion) return undefined;
    const ember = emberRef.current;
    if (!ember) return undefined;
    let raf = 0;
    let emberLevel = EMBER_FLOOR;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const t = (now - startedAt) / 1000;
      // Artwork can mount later or be replaced without restarting ambience.
      const art = artRef.current;
      if (art) {
        const driftX = Math.sin((t / DRIFT_PERIOD_A_S) * Math.PI * 2) * 1.4;
        const driftY = Math.cos((t / DRIFT_PERIOD_B_S) * Math.PI * 2) * 1.1;
        const scale = 1.18 + Math.sin((t / DRIFT_PERIOD_B_S) * Math.PI * 2 + 1.3) * 0.025;
        art.style.transform = `translate(${driftX.toFixed(2)}%, ${driftY.toFixed(2)}%) scale(${scale.toFixed(3)})`;
      }
      if (ember) {
        const energy = Math.min(1, Math.max(0, getVisualizerFrame().energy));
        const target = EMBER_FLOOR + energy * EMBER_RANGE;
        emberLevel += (target - emberLevel) * EMBER_EASE;
        ember.style.opacity = emberLevel.toFixed(3);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      artRef.current?.style.removeProperty("transform");
      ember?.style.removeProperty("opacity");
    };
  }, [reducedMotion]);

  return (
    <div ref={rootRef} className="podcast-now-backdrop" aria-hidden="true">
      {artworkSrc ? (
        <img ref={artRef} src={artworkSrc} alt="" draggable={false} />
      ) : null}
      <div className="podcast-now-wash" />
      <div ref={emberRef} className="podcast-now-ember" />
    </div>
  );
}

function sampleWashColors(image: HTMLImageElement): [string, string] | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const palette = extractMosaicColorPalette(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
    );
    const first = palette[0];
    const second = palette[2] ?? palette[1];
    if (!first || !second) return null;
    return [rgbaCss(first, 0.34), rgbaCss(second, 0.26)];
  } catch {
    return null;
  }
}

function rgbaCss(color: RgbColor, alpha: number) {
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${alpha})`;
}
