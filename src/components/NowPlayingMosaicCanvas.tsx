import { NOW_PLAYING_MOTION } from "../motion/tokens";
import { useEffect, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AlbumGroup, Track } from "../types";
import { useReducedMotion } from "../motion/useReducedMotion";
import { buildNowPlayingWall } from "../utils/nowPlayingWall";
import { isDocumentVisible, WINDOW_VISIBILITY_EVENT } from "../utils/visualizerBus";
import {
  buildCanvasMosaicTiles,
  advanceMosaicArtwork,
  createMosaicColorPalette,
  createMosaicColorFieldSampler,
  createMosaicFlipState,
  createMosaicMotion,
  extractMosaicColorPalette,
  interpolateMosaicColorPalette,
  mosaicTileRevealAmount,
  mosaicFlipFrame,
  updateMosaicFlipState,
  type MosaicColorPalette,
  type MosaicFlipState,
  type MosaicTile,
  type MosaicArtworkState,
  type RgbColor,
} from "../utils/nowPlayingCanvas";

const imageReadyListeners = new Set<() => void>();
const imageCache = new Map<string, HTMLCanvasElement>();
const pendingImageLoads = new Map<string, Promise<HTMLCanvasElement | null>>();
const MAX_IMAGE_CACHE = 96;
const MAX_WALL_IMAGE_EDGE = 384;
const WALL_IMAGE_LOAD_CONCURRENCY = 4;
const EMPTY_QUEUE: Track[] = [];
const imageLoadWaiters: Array<() => void> = [];
let activeImageLoadCount = 0;
const FALLBACK_TINT: RgbColor = { r: 62, g: 50, b: 44 };
const FALLBACK_PALETTE = createMosaicColorPalette(FALLBACK_TINT);
const WALL_PRELOAD_TIMEOUT_MS = 1_600;
const COLOR_FIELD_WIDTH = 112;
const COLOR_FIELD_FRAME_INTERVAL_MS = 42;

type MosaicColorFieldRenderer = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  imageData: ImageData;
  aspectRatio: number;
  lastUpdateAt: number;
};

type MosaicFlipArtwork = {
  tileIndex: number;
  startedAt: number;
  front: HTMLCanvasElement;
  back: HTMLCanvasElement;
};

export function NowPlayingMosaicCanvas({
  tracks,
  queue = EMPTY_QUEUE,
  activeTrack,
  isPlaying,
  onInitialRevealStart,
}: {
  tracks: Track[];
  queue?: Track[];
  activeTrack: Track | null;
  isPlaying: boolean;
  onInitialRevealStart?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const tilesRef = useRef<MosaicTile[]>([]);
  const artworkRef = useRef<Array<MosaicArtworkState<HTMLCanvasElement>>>([]);
  const albumsRef = useRef<AlbumGroup[]>([]);
  const pendingAlbumsRef = useRef<AlbumGroup[] | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const paletteRef = useRef<MosaicColorPalette>(clonePalette(FALLBACK_PALETTE));
  const targetPaletteRef = useRef<MosaicColorPalette>(clonePalette(FALLBACK_PALETTE));
  const colorFieldRendererRef = useRef<MosaicColorFieldRenderer | null>(null);
  const flipRef = useRef<MosaicFlipState>(createMosaicFlipState());
  const flipArtworkRef = useRef<MosaicFlipArtwork | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const invalidateRef = useRef<() => void>(() => {});
  const settleUntilRef = useRef(0);
  const sceneTimeRef = useRef(0);
  const wallRevealStartedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const motionEnabledRef = useRef(true);
  const reducedMotion = useReducedMotion();
  const wallAlbums = useMemo(() => buildNowPlayingWall(tracks, activeTrack, queue), [tracks, activeTrack, queue]);
  const wallKey = wallAlbums.map(album => album.coverPath ?? "").join("\0");

  useEffect(() => {
    isPlayingRef.current = isPlaying;
    invalidateRef.current();
  }, [isPlaying]);

  useEffect(() => {
    const isFirstWall = albumsRef.current.length === 0;
    // Keep the pool's index identities stable until the visible turn lands.
    if (flipRef.current.tileIndex >= 0) pendingAlbumsRef.current = wallAlbums;
    else {
      albumsRef.current = wallAlbums;
      pendingAlbumsRef.current = null;
      flipRef.current = createMosaicFlipState();
    }
    const { width, height } = sizeRef.current;
    if (tilesRef.current.length === 0 && width > 0 && height > 0) {
      tilesRef.current = buildCanvasMosaicTiles(width, height, wallAlbums);
    }
    wallRevealStartedAtRef.current = isFirstWall ? performance.now() : Number.NEGATIVE_INFINITY;
    if (isFirstWall) onInitialRevealStart?.();
    invalidateRef.current();

    return preloadWallImagesProgressively(wallAlbums);
  }, [onInitialRevealStart, wallKey]);

  useEffect(() => {
    motionEnabledRef.current = !reducedMotion;
    invalidateRef.current();
  }, [reducedMotion]);

  useEffect(() => {
    if (!activeTrack?.cover_path) {
      targetPaletteRef.current = clonePalette(FALLBACK_PALETTE);
      invalidateRef.current();
      return;
    }

    let cancelled = false;
    const extract = (image: CanvasImageSource | null) => {
      if (cancelled) return;
      const palette = extractColorPalette(image);
      targetPaletteRef.current = palette ?? clonePalette(FALLBACK_PALETTE);
      invalidateRef.current();
    };

    const cached = imageCache.get(activeTrack.cover_path);
    if (cached) extract(cached);
    else void loadWallImage(activeTrack.cover_path).then(extract);
    return () => {
      cancelled = true;
    };
  }, [activeTrack?.cover_path]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      if (sizeRef.current.width === width && sizeRef.current.height === height && sizeRef.current.dpr === dpr) return;
      sizeRef.current = { width, height, dpr };
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      invalidateRef.current();
      const previousTiles = tilesRef.current;
      const previousById = new Map(previousTiles.map((tile, index) => [tile.id, { tile, artwork: artworkRef.current[index] }]));
      const turningId = previousTiles[flipRef.current.tileIndex]?.id;
      const lastTurningId = previousTiles[flipRef.current.lastTileIndex]?.id;
      tilesRef.current = albumsRef.current.length > 0
        ? buildCanvasMosaicTiles(width, height, albumsRef.current)
        : [];
      artworkRef.current = tilesRef.current.map(tile => {
        const previous = previousById.get(tile.id);
        if (previous) tile.albumIndex = previous.tile.albumIndex;
        return previous?.artwork ?? { image: null, previous: null, startedAt: 0 };
      });
      const turningIndex = tilesRef.current.findIndex(tile => tile.id === turningId);
      flipRef.current.lastTileIndex = tilesRef.current.findIndex(tile => tile.id === lastTurningId);
      if (turningId && turningIndex < 0) {
        flipRef.current = createMosaicFlipState();
        flipArtworkRef.current = null;
      } else if (turningId) {
        flipRef.current.tileIndex = turningIndex;
        if (flipArtworkRef.current) flipArtworkRef.current.tileIndex = turningIndex;
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const draw = (time: number) => {
      try {
        const previousTime = lastTimeRef.current ?? time;
        const deltaSeconds = Math.min(0.08, Math.max(0.001, (time - previousTime) / 1000));
        lastTimeRef.current = time;
        const motionEnabled = motionEnabledRef.current;
        sceneTimeRef.current += deltaSeconds * (motionEnabled ? (isPlayingRef.current ? 1 : 0) : 0);
        paletteRef.current = interpolateMosaicColorPalette(
          paletteRef.current,
          targetPaletteRef.current,
          1 - Math.exp(-deltaSeconds / 1.2),
        );
        drawMosaic(
          context,
          sizeRef.current,
          tilesRef.current,
          albumsRef.current,
          paletteRef.current,
          isPlayingRef.current && pendingAlbumsRef.current === null,
          flipRef.current,
          time,
          sceneTimeRef.current,
          wallRevealStartedAtRef.current,
          motionEnabled,
          colorFieldRendererRef,
          artworkRef.current,
          flipArtworkRef,
        );
        if (flipRef.current.tileIndex < 0 && pendingAlbumsRef.current) {
          albumsRef.current = pendingAlbumsRef.current;
          pendingAlbumsRef.current = null;
          flipRef.current = createMosaicFlipState();
          // A queued pool can land after playback has paused and the previous
          // settle window expired. Its first draw and dissolves still need time.
          settleUntilRef.current = time + NOW_PLAYING_MOTION.canvasSettle;
        }
      } catch (error) {
        if (import.meta.env.DEV) console.error("[now-playing:mosaic] draw failed", error);
        frameRef.current = null;
        return;
      }
      if (isDocumentVisible() && ((isPlayingRef.current && motionEnabledRef.current) || flipRef.current.tileIndex >= 0
        || time < settleUntilRef.current || artworkRef.current.some(state => state.previous))) {
        frameRef.current = window.requestAnimationFrame(draw);
      } else {
        frameRef.current = null;
      }
    };

    const sync = () => {
      if (!isDocumentVisible()) {
        if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        return;
      }
      if (!frameRef.current) {
        frameRef.current = window.requestAnimationFrame(draw);
      }
    };
    const invalidate = () => {
      settleUntilRef.current = performance.now() + NOW_PLAYING_MOTION.canvasSettle;
      sync();
    };
    invalidateRef.current = invalidate;
    // React StrictMode runs mount effects twice in development. The first
    // cleanup cancels its pending frame; never let that cancelled request id
    // make the second setup believe a loop is still alive.
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    imageReadyListeners.add(invalidate);
    invalidate();
    document.addEventListener("visibilitychange", invalidate);
    document.addEventListener(WINDOW_VISIBILITY_EVENT, invalidate);
    return () => {
      document.removeEventListener("visibilitychange", invalidate);
      document.removeEventListener(WINDOW_VISIBILITY_EVENT, invalidate);
      invalidateRef.current = () => {};
      imageReadyListeners.delete(invalidate);
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastTimeRef.current = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="now-mosaic-canvas" aria-hidden="true" />;
}

function drawMosaic(
  context: CanvasRenderingContext2D,
  size: { width: number; height: number; dpr: number },
  tiles: MosaicTile[],
  albums: AlbumGroup[],
  palette: MosaicColorPalette,
  isPlaying: boolean,
  flipState: MosaicFlipState,
  time: number,
  sceneSeconds: number,
  wallRevealStartedAt: number,
  motionEnabled: boolean,
  colorFieldRendererRef: { current: MosaicColorFieldRenderer | null },
  artwork: Array<MosaicArtworkState<HTMLCanvasElement>>,
  flipArtworkRef: { current: MosaicFlipArtwork | null },
) {
  const { width, height, dpr } = size;
  if (width <= 1 || height <= 1) return;

  const readyAlbums = albums.filter(album => album.coverPath && imageCache.has(album.coverPath));
  const fallbackImages = readyAlbums.map(album => imageCache.get(album.coverPath!)!);
  updateMosaicFlipState(flipState, tiles, {
    isPlaying: isPlaying && motionEnabled,
    albums,
    time: motionEnabled ? time : Math.max(time, flipState.startedAt + flipState.duration + 1),
    canFlipTile: (tile, index) => {
      const path = albums[tile.albumIndex]?.coverPath;
      const state = artwork[index];
      return Boolean(path && state?.image === imageCache.get(path) && !state.previous
        && mosaicTileRevealAmount(tile.seed, time - wallRevealStartedAt, motionEnabled) === 1);
    },
    canUseAlbum: index => Boolean(albums[index]?.coverPath && imageCache.has(albums[index].coverPath!)),
  });
  if (flipArtworkRef.current && (flipState.tileIndex !== flipArtworkRef.current.tileIndex
    || flipState.startedAt !== flipArtworkRef.current.startedAt)) {
    const completed = flipArtworkRef.current;
    const state = artwork[completed.tileIndex];
    if (state) {
      state.image = completed.back;
      state.previous = null;
    }
    flipArtworkRef.current = null;
  }
  if (flipState.tileIndex >= 0 && !flipArtworkRef.current) {
    const front = artwork[flipState.tileIndex]?.image;
    const path = albums[flipState.toAlbumIndex]?.coverPath;
    const back = path ? imageCache.get(path) : null;
    if (front && back) flipArtworkRef.current = { tileIndex: flipState.tileIndex, startedAt: flipState.startedAt, front, back };
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#030303";
  context.fillRect(0, 0, width, height);

  const motion = createMosaicMotion(motionEnabled ? sceneSeconds : 0);
  const revealElapsed = time - wallRevealStartedAt;
  const wallReveal = motionEnabled
    ? Math.max(0, Math.min(1, revealElapsed / NOW_PLAYING_MOTION.nowStage))
    : 1;

  context.save();
  context.translate(width / 2, height / 2);
  context.scale(motion.scale, motion.scale);
  context.translate(-width / 2 + motion.driftX, -height / 2 + motion.driftY);

  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    const tileReveal = mosaicTileRevealAmount(tile.seed, revealElapsed, motionEnabled);
    if (tileReveal <= 0) continue;
    const flip = flipState.tileIndex === index && flipArtworkRef.current
      ? {
          progress: (time - flipState.startedAt) / flipState.duration,
          direction: flipState.direction,
          artwork: flipArtworkRef.current,
        }
      : null;
    context.save();
    context.globalAlpha *= tileReveal;
    const revealScale = 0.8 + tileReveal * 0.2;
    context.translate(tile.x + tile.width / 2, tile.y + tile.height / 2);
    context.scale(revealScale, revealScale);
    context.translate(-tile.x - tile.width / 2, -tile.y - tile.height / 2);
    const state = artwork[index] ??= { image: null, previous: null, startedAt: 0 };
    drawTile(context, tile, albums, flip, state, fallbackImages[index % Math.max(1, fallbackImages.length)] ?? null, time, motionEnabled);
    context.restore();
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);

  context.globalAlpha = wallReveal;
  drawMosaicColorField(
    context,
    colorFieldRendererRef,
    palette,
    width,
    height,
    sceneSeconds,
    time,
  );
  const edgeGrade = context.createLinearGradient(0, 0, width, height);
  edgeGrade.addColorStop(0, "rgba(0, 0, 0, 0.06)");
  edgeGrade.addColorStop(0.5, "rgba(0, 0, 0, 0)");
  edgeGrade.addColorStop(1, "rgba(0, 0, 0, 0.18)");
  context.globalCompositeOperation = "source-over";
  context.fillStyle = edgeGrade;
  context.fillRect(0, 0, width, height);
  context.restore();

  const vignette = context.createRadialGradient(width * 0.5, height * 0.47, width * 0.12, width * 0.5, height * 0.5, width * 0.72);
  vignette.addColorStop(0, "rgba(0, 0, 0, 0.02)");
  vignette.addColorStop(0.52, "rgba(0, 0, 0, 0.16)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.56)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);

  const bottom = context.createLinearGradient(0, height * 0.58, 0, height);
  bottom.addColorStop(0, "rgba(0, 0, 0, 0)");
  bottom.addColorStop(0.72, "rgba(0, 0, 0, 0.3)");
  bottom.addColorStop(1, "rgba(0, 0, 0, 0.58)");
  context.fillStyle = bottom;
  context.fillRect(0, height * 0.52, width, height * 0.48);
}

function drawMosaicColorField(
  context: CanvasRenderingContext2D,
  rendererRef: { current: MosaicColorFieldRenderer | null },
  palette: MosaicColorPalette,
  width: number,
  height: number,
  sceneSeconds: number,
  frameTime: number,
) {
  const aspectRatio = width / Math.max(1, height);
  if (!rendererRef.current || Math.abs(rendererRef.current.aspectRatio - aspectRatio) > 0.04) {
    rendererRef.current = createColorFieldRenderer(aspectRatio);
  }
  const renderer = rendererRef.current;
  if (!renderer) return;

  if (frameTime - renderer.lastUpdateAt >= COLOR_FIELD_FRAME_INTERVAL_MS) {
    // The field is intentionally low resolution: bilinear upscaling turns the
    // sampled warp into broad gradients and keeps per-frame work bounded.
    const { data } = renderer.imageData;
    const fieldWidth = renderer.canvas.width;
    const fieldHeight = renderer.canvas.height;
    const sampleColor = createMosaicColorFieldSampler(palette, sceneSeconds);
    for (let row = 0; row < fieldHeight; row += 1) {
      const y = (row + 0.5) / fieldHeight;
      for (let column = 0; column < fieldWidth; column += 1) {
        const x = (column + 0.5) / fieldWidth;
        const color = sampleColor(x, y);
        const index = (row * fieldWidth + column) * 4;
        data[index] = color.r;
        data[index + 1] = color.g;
        data[index + 2] = color.b;
        data[index + 3] = 255;
      }
    }
    renderer.context.putImageData(renderer.imageData, 0, 0);
    renderer.lastUpdateAt = frameTime;
  }

  context.save();
  // Color blending preserves the cover wall's luminance. Motion therefore
  // reads as migrating color, not as a spotlight getting brighter and dimmer.
  context.globalCompositeOperation = "color";
  context.globalAlpha *= 0.92;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(renderer.canvas, 0, 0, width, height);
  context.restore();
}

function createColorFieldRenderer(aspectRatio: number): MosaicColorFieldRenderer | null {
  const canvas = document.createElement("canvas");
  canvas.width = COLOR_FIELD_WIDTH;
  canvas.height = Math.max(52, Math.min(88, Math.round(COLOR_FIELD_WIDTH / Math.max(0.8, aspectRatio))));
  const context = canvas.getContext("2d");
  if (!context) return null;
  return {
    canvas,
    context,
    imageData: context.createImageData(canvas.width, canvas.height),
    aspectRatio,
    lastUpdateAt: Number.NEGATIVE_INFINITY,
  };
}

function drawTile(
  context: CanvasRenderingContext2D,
  tile: MosaicTile,
  albums: AlbumGroup[],
  flip: {
    progress: number;
    direction: -1 | 1;
    artwork: MosaicFlipArtwork;
  } | null,
  artwork: MosaicArtworkState<HTMLCanvasElement>,
  fallback: HTMLCanvasElement | null,
  time: number,
  motionEnabled: boolean,
) {
  const isFlipping = flip !== null && flip.progress >= 0 && flip.progress <= 1;
  const turn = mosaicFlipFrame(isFlipping ? flip.progress * NOW_PLAYING_MOTION.mosaicTurnFade : 0);
  const easedFlip = isFlipping ? turn.rotation : 0;
  const album = albums[tile.albumIndex];
  const candidate = album?.coverPath ? imageCache.get(album.coverPath) ?? null : null;
  // A turn owns two decoded surfaces. Pool replacement dissolves belong to
  // stationary tiles; running one at the apex would outlast the turn.
  const mix = isFlipping ? 1 : advanceMosaicArtwork(artwork, candidate, fallback, time,
    motionEnabled ? NOW_PLAYING_MOTION.mosaicReplace : 0,
    motionEnabled ? tile.seed * NOW_PLAYING_MOTION.mosaicReplaceStagger : 0);
  const image = isFlipping ? (turn.back ? flip.artwork.back : flip.artwork.front) : artwork.image;
  const flipScale = isFlipping ? turn.scaleX : 1;
  const flipForeshorten = isFlipping ? 1 - Math.sin(easedFlip * Math.PI) * 0.07 : 1;
  const flipShade = isFlipping ? Math.sin(easedFlip * Math.PI) * 0.5 : 0;
  const centerX = tile.x + tile.width / 2;
  const centerY = tile.y + tile.height / 2;
  const perspectiveOffset = isFlipping
    ? flip.direction * Math.sin(easedFlip * Math.PI) * tile.height * 0.028
    : 0;

  context.save();
  context.translate(centerX + perspectiveOffset, centerY);
  context.scale(flipScale, flipForeshorten);
  context.translate(-centerX, -centerY);
  context.beginPath();
  context.rect(tile.x, tile.y, tile.width - 1, tile.height - 1);
  context.clip();
  context.fillStyle = "#171717";
  context.fillRect(tile.x, tile.y, tile.width, tile.height);

  if (image) {
    const inheritedAlpha = context.globalAlpha;
    context.filter = "grayscale(0.92) saturate(0.38) brightness(0.5) contrast(1.1)";
    // Keep the old cover opaque underneath, avoiding a dark gap halfway.
    if (!isFlipping && artwork.previous) drawImageCover(context, artwork.previous, tile.x, tile.y, tile.width, tile.height);
    context.globalAlpha *= isFlipping ? turn.alpha : mix;
    drawImageCover(context, image, tile.x, tile.y, tile.width, tile.height);
    context.filter = "none";
    context.globalAlpha = inheritedAlpha;
  }

  context.globalCompositeOperation = "source-over";
  context.fillStyle = `rgba(0, 0, 0, ${0.12 + flipShade})`;
  context.fillRect(tile.x, tile.y, tile.width, tile.height);
  if (isFlipping) {
    const sweepX = tile.x + tile.width * (0.08 + easedFlip * 0.84);
    const highlight = context.createLinearGradient(sweepX - tile.width * 0.1, 0, sweepX + tile.width * 0.1, 0);
    highlight.addColorStop(0, "rgba(255, 255, 255, 0)");
    highlight.addColorStop(0.5, `rgba(255, 255, 255, ${0.08 + flipShade * 0.3})`);
    highlight.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = highlight;
    context.fillRect(tile.x, tile.y, tile.width, tile.height);
  }
  context.strokeStyle = "rgba(0, 0, 0, 0.82)";
  context.lineWidth = 1;
  context.strokeRect(tile.x + 0.5, tile.y + 0.5, tile.width - 1, tile.height - 1);
  context.restore();
}

function drawImageCover(context: CanvasRenderingContext2D, image: HTMLCanvasElement, x: number, y: number, width: number, height: number) {
  const sourceRatio = image.width / image.height;
  const targetRatio = width / height;
  let sourceWidth = image.width;
  let sourceHeight = image.height;
  let sourceX = 0;
  let sourceY = 0;

  if (sourceRatio > targetRatio) {
    sourceWidth = image.height * targetRatio;
    sourceX = (image.width - sourceWidth) / 2;
  } else {
    sourceHeight = image.width / targetRatio;
    sourceY = (image.height - sourceHeight) / 2;
  }

  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function preloadWallImagesProgressively(albums: AlbumGroup[]) {
  const coverPaths = [...new Set(albums.map((album) => album.coverPath).filter((path): path is string => Boolean(path)))];
  let cancelled = false;
  let nextIndex = 0;

  const worker = async () => {
    while (!cancelled && nextIndex < coverPaths.length) {
      const path = coverPaths[nextIndex];
      nextIndex += 1;
      await loadWallImage(path);
    }
  };

  const workerCount = Math.min(WALL_IMAGE_LOAD_CONCURRENCY, coverPaths.length);
  void Promise.allSettled(Array.from({ length: workerCount }, worker));
  return () => {
    cancelled = true;
  };
}

function waitForImage(image: HTMLImageElement) {
  return new Promise<boolean>((resolve) => {
    let timeoutId: number | undefined;
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      image.removeEventListener("load", handleLoad);
      image.removeEventListener("error", handleError);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      resolve(ready);
    };
    const handleLoad = () => {
      if (typeof image.decode !== "function") {
        finish(image.naturalWidth > 0);
        return;
      }
      void image.decode().then(
        () => finish(image.naturalWidth > 0),
        () => finish(false),
      );
    };
    const handleError = () => finish(false);

    timeoutId = window.setTimeout(() => finish(false), WALL_PRELOAD_TIMEOUT_MS);
    if (image.complete) {
      if (image.naturalWidth > 0) handleLoad();
      else finish(false);
      return;
    }

    image.addEventListener("load", handleLoad, { once: true });
    image.addEventListener("error", handleError, { once: true });
  });
}

function loadWallImage(path: string) {
  const cached = imageCache.get(path);
  if (cached) return Promise.resolve(cached);
  const pending = pendingImageLoads.get(path);
  if (pending) return pending;

  const load = withImageLoadSlot(() => loadAndResizeWallImage(path)).then((image) => {
    if (!image) return null;
    if (imageCache.size >= MAX_IMAGE_CACHE) {
      const oldestPath = imageCache.keys().next().value;
      if (oldestPath) {
        imageCache.delete(oldestPath);
        // A visible tile may still hold this decoded surface during a dissolve.
        // Let GC reclaim it after the final tile releases it; never blank it.
      }
    }
    imageCache.set(path, image);
    imageReadyListeners.forEach(listener => listener());
    return image;
  }).finally(() => {
    pendingImageLoads.delete(path);
  });
  pendingImageLoads.set(path, load);
  return load;
}

async function withImageLoadSlot<T>(load: () => Promise<T>) {
  if (activeImageLoadCount >= WALL_IMAGE_LOAD_CONCURRENCY) {
    await new Promise<void>((resolve) => imageLoadWaiters.push(resolve));
  } else {
    activeImageLoadCount += 1;
  }

  try {
    return await load();
  } finally {
    const next = imageLoadWaiters.shift();
    if (next) next();
    else activeImageLoadCount -= 1;
  }
}

async function loadAndResizeWallImage(path: string) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.src = convertFileSrc(path);
  const ready = await waitForImage(image);
  if (!ready || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    image.src = "";
    return null;
  }

  try {
    const scale = Math.min(1, MAX_WALL_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.src = "";
    return canvas;
  } catch {
    image.src = "";
    return null;
  }
}

function extractColorPalette(image: CanvasImageSource | null) {
  if (!image) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return extractMosaicColorPalette(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch {
    return null;
  }
}

function clonePalette(palette: MosaicColorPalette): MosaicColorPalette {
  return palette.map((color) => ({ ...color })) as MosaicColorPalette;
}
