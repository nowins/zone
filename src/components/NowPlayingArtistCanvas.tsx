import { useEffect, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { NOW_PLAYING_MOTION } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";
import type { Track } from "../types";
import {
  advanceArtistPhotoOpacity,
  advanceArtistPhotoScene,
  artistPhotoSceneBlend,
  artistPhotoTransform,
  createArtistPhotoScene,
  nowPlayingArtistIdentity,
  selectNowPlayingArtistPhotos,
  setArtistPhotoOpacityTarget,
  type ArtistPhotoMotion,
  type ArtistPhotoOpacity,
} from "../utils/nowPlayingArtist";
import { isDocumentVisible, WINDOW_VISIBILITY_EVENT } from "../utils/visualizerBus";

const MAX_DECODED_PHOTO_EDGE = 1600;

export function NowPlayingArtistCanvas({ tracks, activeTrack, isPlaying, onOpaqueChange }: {
  tracks: Track[];
  activeTrack: Track | null;
  isPlaying: boolean;
  onOpaqueChange?: (opaque: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = useReducedMotion();
  const artist = nowPlayingArtistIdentity(activeTrack);
  const paths = useMemo(() => selectNowPlayingArtistPhotos(tracks, activeTrack), [tracks, activeTrack]);
  const poolKey = paths.join("\0");
  const artistRef = useRef<string | null>(null);
  const sceneRef = useRef(createArtistPhotoScene());
  const imagesRef = useRef(new Map<string, HTMLCanvasElement>());
  const decodingRef = useRef(false);
  const retiredRef = useRef<HTMLCanvasElement | null>(null);
  const opacityRef = useRef<ArtistPhotoOpacity>({ value: 0, from: 0, target: 0, elapsedMs: 0 });
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const latestRef = useRef({ isPlaying, reduced });
  latestRef.current = { isPlaying, reduced };
  const invalidateRef = useRef<() => void>(() => {});
  const resetClockRef = useRef<() => void>(() => {});
  const opaqueRef = useRef(false);
  const opaqueChangeRef = useRef(onOpaqueChange);
  opaqueChangeRef.current = onOpaqueChange;

  function notifyOpaque(value: boolean) {
    if (opaqueRef.current === value) return;
    opaqueRef.current = value;
    opaqueChangeRef.current?.(value);
  }

  function retireScene() {
    notifyOpaque(false);
    const canvas = canvasRef.current;
    // Capture the current composite, including an interrupted photo dissolve.
    // Rapid identity changes then continue fading the same visible pixels.
    if (canvas && opacityRef.current.value > 0 && canvas.width > 0 && canvas.height > 0) {
      const snapshot = document.createElement("canvas");
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      snapshot.getContext("2d")?.drawImage(canvas, 0, 0);
      retiredRef.current = snapshot;
    }
    sceneRef.current = createArtistPhotoScene();
    setArtistPhotoOpacityTarget(opacityRef.current, 0);
    imagesRef.current.clear();
  }

  useEffect(() => {
    const changedArtist = artistRef.current !== artist;
    if (changedArtist) {
      retireScene();
      artistRef.current = artist;
    }
    const controller = new AbortController();
    const previousImages = imagesRef.current;
    const wantedPaths = paths;
    if (wantedPaths.length < 2) {
      decodingRef.current = false;
      retireScene();
      invalidateRef.current();
      return () => controller.abort();
    }
    decodingRef.current = true;
    invalidateRef.current();
    void Promise.all(wantedPaths.map(async path => ({ path,
      image: previousImages.get(path) ?? await loadArtistPhoto(path, controller.signal) }))).then(results => {
      if (controller.signal.aborted || artistRef.current !== artist) return;
      decodingRef.current = false;
      const ready = results.filter((result): result is { path: string; image: HTMLCanvasElement } => Boolean(result.image));
      const nextImages = new Map(ready.map(result => [result.path, result.image]));
      const scene = sceneRef.current;
      if (ready.length < 2 || (scene.current && !nextImages.has(scene.current))) retireScene();
      else if (scene.previous) {
        const previous = previousImages.get(scene.previous);
        if (previous) nextImages.set(scene.previous, previous);
      }
      imagesRef.current = nextImages;
      sceneRef.current.paths = ready.length >= 2 ? ready.map(result => result.path) : [];
      invalidateRef.current();
    });
    return () => { controller.abort(); decodingRef.current = false; };
  }, [artist, poolKey]);

  useEffect(() => {
    resetClockRef.current();
    invalidateRef.current();
  }, [isPlaying, reduced]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let request: number | null = null;
    let lastTime: number | null = null;

    const draw = (time: number) => {
      request = null;
      if (!isDocumentVisible()) { lastTime = null; return; }
      const delta = lastTime === null ? 0 : Math.min(80, Math.max(0, time - lastTime));
      lastTime = time;
      const { isPlaying: playing, reduced: motionReduced } = latestRef.current;
      const scene = sceneRef.current;
      advanceArtistPhotoScene(scene, delta, playing, motionReduced);
      setArtistPhotoOpacityTarget(opacityRef.current, scene.current ? 1 : 0);
      advanceArtistPhotoOpacity(opacityRef.current, delta, motionReduced);
      const { width, height, dpr } = sizeRef.current;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.globalAlpha = 1;
      const current = scene.current ? imagesRef.current.get(scene.current) : null;
      if (current) {
        const previous = scene.previous ? imagesRef.current.get(scene.previous) : null;
        if (previous) drawArtistPhoto(context, previous, scene.previousMotion, scene.previousElapsedMs, width, height);
        context.globalAlpha = previous ? artistPhotoSceneBlend(scene) : 1;
        drawArtistPhoto(context, current, scene.motion, scene.elapsedMs, width, height);
      } else if (retiredRef.current && opacityRef.current.value > 0) {
        context.drawImage(retiredRef.current, 0, 0, width, height);
      }
      context.globalAlpha = 1;
      canvas.style.opacity = String(opacityRef.current.value);
      notifyOpaque(opacityRef.current.value === 1 && Boolean(current));
      if (opacityRef.current.value === 0) retiredRef.current = null;
      // A completed transition releases removed pool images without blanking
      // a photograph still referenced by the scene being drawn.
      for (const path of imagesRef.current.keys()) {
        if (!scene.paths.includes(path) && path !== scene.current && path !== scene.previous) imagesRef.current.delete(path);
      }
      const sceneRunning = playing && !motionReduced && (Boolean(scene.current)
        || ((decodingRef.current || scene.paths.length >= 2) && scene.waitMs < NOW_PLAYING_MOTION.artistGridDelay));
      if (sceneRunning || scene.previous || opacityRef.current.value !== opacityRef.current.target) {
        request = window.requestAnimationFrame(draw);
      } else lastTime = null;
    };
    const invalidate = () => {
      if (!isDocumentVisible()) {
        if (request !== null) window.cancelAnimationFrame(request);
        request = null;
        lastTime = null;
        return;
      }
      if (request === null) request = window.requestAnimationFrame(draw);
    };
    const visibility = () => { lastTime = null; invalidate(); };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
      if (sizeRef.current.width === width && sizeRef.current.height === height && sizeRef.current.dpr === dpr) return;
      sizeRef.current = { width, height, dpr };
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      invalidate();
    };
    invalidateRef.current = invalidate;
    resetClockRef.current = () => { lastTime = null; };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener(WINDOW_VISIBILITY_EVENT, visibility);
    invalidate();
    return () => {
      invalidateRef.current = () => {};
      resetClockRef.current = () => {};
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener(WINDOW_VISIBILITY_EVENT, visibility);
      if (request !== null) window.cancelAnimationFrame(request);
      notifyOpaque(false);
    };
  }, []);

  return <canvas ref={canvasRef} className="now-artist-canvas" aria-hidden="true" />;
}

function drawArtistPhoto(context: CanvasRenderingContext2D, image: HTMLCanvasElement,
  motion: ArtistPhotoMotion, elapsedMs: number, width: number, height: number) {
  if (width <= 1 || height <= 1) return;
  const transform = artistPhotoTransform(motion, elapsedMs, width);
  const coverScale = Math.max(width / image.width, height / image.height) * transform.scale;
  const drawnWidth = image.width * coverScale;
  const drawnHeight = image.height * coverScale;
  context.drawImage(image, (width - drawnWidth) / 2 + transform.offsetX, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}

function loadArtistPhoto(path: string, signal: AbortSignal): Promise<HTMLCanvasElement | null> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(null); return; }
    const image = new Image();
    let settled = false;
    let timeout: number | undefined;
    const finish = (surface: HTMLCanvasElement | null) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
      signal.removeEventListener("abort", failed);
      image.src = "";
      resolve(surface);
    };
    const failed = () => finish(null);
    const rasterize = () => {
      if (settled) return;
      if (signal.aborted || image.naturalWidth <= 0 || image.naturalHeight <= 0) { finish(null); return; }
      try {
        const scale = Math.min(1, MAX_DECODED_PHOTO_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
        const surface = document.createElement("canvas");
        surface.width = Math.max(1, Math.round(image.naturalWidth * scale));
        surface.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = surface.getContext("2d");
        if (!context) { finish(null); return; }
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, surface.width, surface.height);
        finish(surface);
      } catch { finish(null); }
    };
    const loaded = () => {
      if (settled) return;
      if (typeof image.decode === "function") void image.decode().then(rasterize, failed);
      else rasterize();
    };
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.addEventListener("load", loaded, { once: true });
    image.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", failed, { once: true });
    timeout = window.setTimeout(failed, NOW_PLAYING_MOTION.artistDecodeTimeout);
    image.src = convertFileSrc(path);
    if (image.complete) {
      if (image.naturalWidth > 0) loaded();
      else failed();
    }
  });
}
