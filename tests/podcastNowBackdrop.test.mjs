import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const backdropSource = readFileSync("src/components/PodcastNowBackdrop.tsx", "utf8");
const nowPlayingSource = readFileSync("src/views/PodcastNowPlayingView.tsx", "utf8");
const podcastNowCss = readFileSync("src/styles/podcast-now-playing.css", "utf8");
const motionCss = readFileSync("src/styles/motion.css", "utf8");

function includes(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

test("the podcast now-playing stage renders the layered ambience component", () => {
  includes(
    nowPlayingSource,
    /<PodcastNowBackdrop artworkSrc=/,
    "the view must delegate its backdrop to the layered ambience component",
  );
  includes(
    backdropSource,
    /className="podcast-now-backdrop"[\s\S]*podcast-now-wash[\s\S]*podcast-now-ember/,
    "the backdrop must stack artwork, palette wash and ember layers",
  );
});

test("the wash palette is sampled from the show artwork with CORS readback", () => {
  includes(
    backdropSource,
    /crossOrigin = "anonymous"/,
    "artwork sampling must request anonymous CORS so the canvas stays readable",
  );
  includes(
    backdropSource,
    /extractMosaicColorPalette\([\s\S]*getImageData/,
    "the wash colors must come from the shared mosaic palette extractor",
  );
  includes(
    podcastNowCss,
    /\.podcast-now-wash\s*\{[^}]*var\(--podcast-now-wash-a,[^)]*\)/s,
    "the wash must consume the palette CSS variables with dark fallbacks",
  );
});

test("the ember follows the visualizer bus and ambient motion is reduced-motion gated", () => {
  includes(
    backdropSource,
    /getVisualizerFrame\(\)\.energy/,
    "the ember must read playback energy from the shared visualizer bus",
  );
  includes(
    backdropSource,
    /useReducedMotion\(\)/,
    "the ambient drift and ember loop must be gated by reduced motion",
  );
  includes(
    podcastNowCss,
    /\.podcast-now-ember\s*\{[^}]*opacity:\s*0\.12/s,
    "the ember keeps a dim resting opacity as its reduced-motion and idle state",
  );
  includes(
    motionCss,
    /\.podcast-now-backdrop img/,
    "the shared reduced-motion list must keep pinning the backdrop artwork transform",
  );
});
