import { clamp, lerp, smoothstep } from "../motion/math.js";
import { NOW_PLAYING_MOTION } from "../motion/tokens.js";
import type { Track } from "../types";

export const MAX_NOW_PLAYING_ARTIST_PHOTOS = 4;

export function nowPlayingArtistIdentity(track: Track | null) {
  return (track?.album_artist ?? track?.artist)?.trim().toLocaleLowerCase() || null;
}

export function selectNowPlayingArtistPhotos(tracks: Track[], active: Track | null) {
  const artist = nowPlayingArtistIdentity(active);
  if (!artist) return [];
  const paths = new Set<string>();
  // Library order owns the pool rather than the currently playing song.
  // Same-artist skips therefore keep the same scene and decoded photographs.
  for (const track of [...tracks, ...(active ? [active] : [])]) {
    if (nowPlayingArtistIdentity(track) !== artist) continue;
    for (const path of [track.artist_image_path, ...(track.artist_images?.map(image => image.path) ?? [])]) {
      const clean = path?.trim();
      if (clean) paths.add(clean);
      if (paths.size >= MAX_NOW_PLAYING_ARTIST_PHOTOS) return [...paths].sort();
    }
  }
  return [...paths].sort();
}

export type ArtistPhotoMotion = "slide" | "zoom";

export type ArtistPhotoScene = {
  paths: string[];
  waitMs: number;
  current: string | null;
  previous: string | null;
  motion: ArtistPhotoMotion;
  previousMotion: ArtistPhotoMotion;
  elapsedMs: number;
  previousElapsedMs: number;
  transitionMs: number;
};

export function createArtistPhotoScene(): ArtistPhotoScene {
  return { paths: [], waitMs: 0, current: null, previous: null, motion: "slide", previousMotion: "slide",
    elapsedMs: 0, previousElapsedMs: 0, transitionMs: NOW_PLAYING_MOTION.artistTransition };
}

/** Advance only visible playback time; an active dissolve may finish on pause. */
export function advanceArtistPhotoScene(scene: ArtistPhotoScene, deltaMs: number, playing: boolean, reduced: boolean) {
  const delta = Math.max(0, deltaMs);
  if (scene.previous) {
    scene.transitionMs = reduced ? NOW_PLAYING_MOTION.artistTransition : scene.transitionMs + delta;
    if (scene.transitionMs >= NOW_PLAYING_MOTION.artistTransition) scene.previous = null;
  }
  if (!playing || reduced) return;
  if (!scene.current) {
    scene.waitMs = Math.min(NOW_PLAYING_MOTION.artistGridDelay, scene.waitMs + delta);
    if (scene.waitMs >= NOW_PLAYING_MOTION.artistGridDelay && scene.paths.length >= 2) {
      scene.current = scene.paths[0];
      scene.elapsedMs = 0;
    }
    return;
  }
  scene.elapsedMs += delta;
  if (scene.elapsedMs < NOW_PLAYING_MOTION.artistScene || scene.paths.length < 2) return;
  scene.previous = scene.current;
  scene.previousMotion = scene.motion;
  scene.previousElapsedMs = NOW_PLAYING_MOTION.artistScene;
  const index = scene.paths.indexOf(scene.current);
  scene.current = scene.paths[(index + 1) % scene.paths.length];
  scene.motion = scene.motion === "slide" ? "zoom" : "slide";
  scene.elapsedMs %= NOW_PLAYING_MOTION.artistScene;
  scene.transitionMs = 0;
}

export function artistPhotoSceneBlend(scene: ArtistPhotoScene) {
  return scene.previous ? smoothstep(0, NOW_PLAYING_MOTION.artistTransition, scene.transitionMs) : 1;
}

/** The native slide's 400px travel is adapted from its 1012px photo reference. */
export function artistPhotoTransform(motion: ArtistPhotoMotion, elapsedMs: number, width: number) {
  const progress = clamp(elapsedMs / NOW_PLAYING_MOTION.artistScene, 0, 1);
  if (motion === "zoom") return { scale: lerp(1, 1.2, progress), offsetX: 0 };
  const travel = Math.max(0, width) * 400 / 1012;
  return { scale: 1 + travel / Math.max(1, width), offsetX: lerp(travel / 2, -travel / 2, progress) };
}

export type ArtistPhotoOpacity = { value: number; from: number; target: number; elapsedMs: number };

export function setArtistPhotoOpacityTarget(opacity: ArtistPhotoOpacity, target: number) {
  if (opacity.target === target) return;
  opacity.from = opacity.value;
  opacity.target = target;
  opacity.elapsedMs = 0;
}

export function advanceArtistPhotoOpacity(opacity: ArtistPhotoOpacity, deltaMs: number, reduced: boolean) {
  opacity.elapsedMs += Math.max(0, deltaMs);
  const progress = reduced ? 1 : smoothstep(0, NOW_PLAYING_MOTION.artistTransition, opacity.elapsedMs);
  opacity.value = lerp(opacity.from, opacity.target, progress);
}
