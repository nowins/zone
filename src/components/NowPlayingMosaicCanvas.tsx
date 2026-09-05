import { useEffect, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AlbumGroup, Track } from "../types";
import { useReducedMotion } from "../motion/useReducedMotion";
import { buildNowPlayingWall } from "../utils/nowPlayingWall";
import { getVisualizerFrame, isDocumentVisible } from "../utils/visualizerBus";
import {
  buildCanvasMosaicTiles,
  createMosaicColorPalette,
  createMosaicColorFieldSampler,
  createMosaicFlipState,
  createMosaicMotion,
  extractMosaicColorPalette,
  interpolateMosaicColorPalette,
  mosaicTileRevealAmount,
  updateMosaicFlipState,
  type MosaicColorPalette,
  type MosaicFlipState,
  type MosaicTile,
  type RgbColor,
} from "../utils/nowPlayingCanvas";

const imageCache = new Map<string, HTMLCanvasElement>();
const pendingImageLoads = new Map<string, Promise<HTMLCanvasElement | null>>();
const MAX_IMAGE_CACHE = 96;
const MAX_WALL_IMAGE_EDGE = 384;
const WALL_IMAGE_LOAD_CONCURRENCY = 4;
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

export function NowPlayingMosaicCanvas({
  tracks,
  activeTrack,
  isPlaying,
  onInitialRevealStart,
}: {
  tracks: Track[];
  activeTrack: Track | null;
  isPlaying: boolean;
  onInitialRevealStart?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const tilesRef = useRef<MosaicTile[]>([]);
  const albumsRef = useRef<AlbumGroup[]>([]);
  const isPlayingRef = useRef(isPlaying);
  const paletteRef = useRef<MosaicColorPalette>(clonePalette(FALLBACK_PALETTE));
  const targetPaletteRef = useRef<MosaicColorPalette>(clonePalette(FALLBACK_PALETTE));
  const colorFieldRendererRef = useRef<MosaicColorFieldRenderer | null>(null);
  const flipRef = useRef<MosaicFlipState>(createMosaicFlipState());
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const sceneTimeRef = useRef(0);
  const wallRevealStartedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const motionEnabledRef = useRef(true);
  const reducedMotion = useReducedMotion();
  const wallAlbums = useMemo(() => buildNowPlayingWall(tracks, activeTrack), [tracks, activeTrack]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    const isFirstWall = albumsRef.current.length === 0;
    albumsRef.current = wallAlbums;
    flipRef.current = createMosaicFlipState();
    const { width, height } = sizeRef.current;
    tilesRef.current = width > 0 && height > 0
      ? buildCanvasMosaicTiles(width, height, wallAlbums)
      : [];
    wallRevealStartedAtRef.current = isFirstWall ? performance.now() : Number.NEGATIVE_INFINITY;
    if (isFirstWall) onInitialRevealStart?.();

    return preloadWallImagesProgressively(wallAlbums);
  }, [onInitialRevealStart, wallAlbums]);

  useEffect(() => {
    motionEnabledRef.current = !reducedMotion;
  }, [reducedMotion]);

  useEffect(() => {
    if (!activeTrack?.cover_path) {
      targetPaletteRef.current = clonePalette(FALLBACK_PALETTE);
      return;
    }

    let cancelled = false;
    const extract = (image: CanvasImageSource | null) => {
      if (cancelled) return;
      const palette = extractColorPalette(image);
      targetPaletteRef.current = palette ?? clonePalette(FALLBACK_PALETTE);
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
      sizeRef.current = { width, height, dpr };
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      tilesRef.current = albumsRef.current.length > 0
        ? buildCanvasMosaicTiles(width, height, albumsRef.current)
        : [];
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
        const frame = getVisualizerFrame();
        sceneTimeRef.current += deltaSeconds * (motionEnabled ? (isPlayingRef.current ? 1 : 0.1) : 0);
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
          frame.beatPulse,
          frame.beatPhase,
          frame.beatConfidence,
          isPlayingRef.current,
          flipRef.current,
          time,
          sceneTimeRef.current,
          wallRevealStartedAtRef.current,
          motionEnabled,
          colorFieldRendererRef,
        );
      } catch (error) {
        if (import.meta.env.DEV) console.error("[now-playing:mosaic] draw failed", error);
        frameRef.current = null;
        return;
      }
      if (isDocumentVisible()) {
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
    // React StrictMode runs mount effects twice in development. The first
    // cleanup cancels its pending frame; never let that cancelled request id
    // make the second setup believe a loop is still alive.
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
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
  beatPulse: number,
  beatPhase: number,
  beatConfidence: number,
  isPlaying: boolean,
  flipState: MosaicFlipState,
  time: number,
  sceneSeconds: number,
  wallRevealStartedAt: number,
  motionEnabled: boolean,
  colorFieldRendererRef: { current: MosaicColorFieldRenderer | null },
) {
  const { width, height, dpr } = size;
  if (width <= 1 || height <= 1) return;

  updateMosaicFlipState(flipState, tiles, {
    isPlaying: isPlaying && motionEnabled,
    beatPulse,
    beatPhase,
    beatConfidence,
    albums,
    time,
  });
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#030303";
  context.fillRect(0, 0, width, height);

  const motion = createMosaicMotion(motionEnabled ? sceneSeconds : 0);
  const revealElapsed = time - wallRevealStartedAt;
  const wallReveal = motionEnabled
    ? Math.max(0, Math.min(1, revealElapsed / 950))
    : 1;

  context.save();
  context.translate(width / 2, height / 2);
  context.scale(motion.scale, motion.scale);
  context.translate(-width / 2 + motion.driftX, -height / 2 + motion.driftY);

  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    const tileReveal = mosaicTileRevealAmount(tile.seed, revealElapsed, motionEnabled);
    if (tileReveal <= 0) continue;
    const flip = flipState.tileIndex === index
      ? {
          progress: (time - flipState.startedAt) / flipState.duration,
          fromAlbumIndex: flipState.fromAlbumIndex,
          toAlbumIndex: flipState.toAlbumIndex,
          direction: flipState.direction,
        }
      : null;
    context.save();
    context.globalAlpha *= tileReveal;
    drawTile(context, tile, albums, flip);
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
    fromAlbumIndex: number;
    toAlbumIndex: number;
    direction: -1 | 1;
  } | null,
) {
  const isFlipping = flip !== null && flip.progress >= 0 && flip.progress <= 1;
  const easedFlip = isFlipping ? easeInOutCubic(flip.progress) : 0;
  const albumIndex = isFlipping
    ? (easedFlip < 0.5 ? flip.fromAlbumIndex : flip.toAlbumIndex)
    : tile.albumIndex;
  const album = albums[albumIndex];
  const image = album?.coverPath ? imageCache.get(album.coverPath) : null;
  const flipScale = isFlipping ? Math.max(0.02, Math.abs(Math.cos(easedFlip * Math.PI))) : 1;
  const flipForeshorten = isFlipping ? 1 - Math.sin(easedFlip * Math.PI) * 0.07 : 1;
  const flipShade = isFlipping ? Math.sin(easedFlip * Math.PI) * 0.5 : 0;
  const centerX = tile.x + tile.width / 2;
  const centerY = tile.y + tile.height / 2;
  const perspectiveOffset = isFlipping
    ? flip.direction * Math.sin(easedFlip * Math.PI) * tile.height * 0.028
    : 0;

  context.save();
  context.translate(centerX, centerY + perspectiveOffset);
  context.scale(flipForeshorten, flipScale);
  context.translate(-centerX, -centerY);
  context.beginPath();
  context.rect(tile.x, tile.y, tile.width - 1, tile.height - 1);
  context.clip();
  context.fillStyle = "#171717";
  context.fillRect(tile.x, tile.y, tile.width, tile.height);

  if (image && image.width > 0 && image.height > 0) {
    const inheritedAlpha = context.globalAlpha;
    context.globalAlpha = inheritedAlpha * 0.86;
    context.filter = "grayscale(0.92) saturate(0.38) brightness(0.58) contrast(1.1)";
    drawImageCover(context, image, tile.x, tile.y, tile.width, tile.height);
    context.filter = "none";
    context.globalAlpha = inheritedAlpha;
  }

  context.globalCompositeOperation = "source-over";
  context.fillStyle = `rgba(0, 0, 0, ${0.12 + flipShade})`;
  context.fillRect(tile.x, tile.y, tile.width, tile.height);
  if (isFlipping) {
    const sweepY = tile.y + tile.height * (0.08 + easedFlip * 0.84);
    const highlight = context.createLinearGradient(0, sweepY - tile.height * 0.1, 0, sweepY + tile.height * 0.1);
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
        const oldestImage = imageCache.get(oldestPath);
        imageCache.delete(oldestPath);
        if (oldestImage) {
          oldestImage.width = 0;
          oldestImage.height = 0;
        }
      }
    }
    imageCache.set(path, image);
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

function easeInOutCubic(value: number) {
  const amount = Math.max(0, Math.min(1, value));
  return amount < 0.5 ? 4 * amount * amount * amount : 1 - (-2 * amount + 2) ** 3 / 2;
}
