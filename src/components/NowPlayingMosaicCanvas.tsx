import { useEffect, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AlbumGroup, Track } from "../types";
import { buildNowPlayingWall } from "../utils/nowPlayingWall";
import {
  averageImageColor,
  buildCanvasMosaicTiles,
  colorCss,
  colorToZuneTint,
  createMosaicColorSweep,
  createMosaicFlipState,
  createMosaicMotion,
  createSlowTint,
  lerpColor,
  updateMosaicFlipState,
  type MosaicFlipState,
  type MosaicTile,
  type RgbColor,
} from "../utils/nowPlayingCanvas";

const imageCache = new Map<string, HTMLImageElement>();
const FALLBACK_TINT: RgbColor = { r: 56, g: 68, b: 22 };
const WALL_PRELOAD_TIMEOUT_MS = 1_600;

export function NowPlayingMosaicCanvas({
  tracks,
  activeTrack,
  beatPulse,
  beatPhase,
  beatConfidence,
  isPlaying,
}: {
  tracks: Track[];
  activeTrack: Track | null;
  energy: number;
  beatPulse: number;
  beatPhase: number;
  beatConfidence: number;
  isPlaying: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const tilesRef = useRef<MosaicTile[]>([]);
  const albumsRef = useRef<AlbumGroup[]>([]);
  const beatPulseRef = useRef(beatPulse);
  const beatPhaseRef = useRef(beatPhase);
  const beatConfidenceRef = useRef(beatConfidence);
  const isPlayingRef = useRef(isPlaying);
  const tintRef = useRef<RgbColor>(FALLBACK_TINT);
  const targetTintRef = useRef<RgbColor>(FALLBACK_TINT);
  const flipRef = useRef<MosaicFlipState>(createMosaicFlipState());
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const sceneTimeRef = useRef(0);
  const wallRevealRef = useRef(0);
  const wallRevealTargetRef = useRef(0);
  const motionEnabledRef = useRef(true);
  const wallAlbums = useMemo(() => buildNowPlayingWall(tracks, activeTrack), [tracks, activeTrack]);

  useEffect(() => {
    beatPulseRef.current = beatPulse;
  }, [beatPulse]);

  useEffect(() => {
    beatPhaseRef.current = beatPhase;
  }, [beatPhase]);

  useEffect(() => {
    beatConfidenceRef.current = beatConfidence;
  }, [beatConfidence]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    let cancelled = false;
    const prepareWall = async () => {
      await preloadWallImages(wallAlbums);
      if (cancelled) return;

      const isFirstWall = albumsRef.current.length === 0;
      if (isFirstWall) wallRevealRef.current = 0;
      albumsRef.current = wallAlbums;
      flipRef.current = createMosaicFlipState();
      const { width, height } = sizeRef.current;
      tilesRef.current = width > 0 && height > 0
        ? buildCanvasMosaicTiles(width, height, wallAlbums)
        : [];
      wallRevealTargetRef.current = 1;
    };

    void prepareWall();
    return () => {
      cancelled = true;
    };
  }, [wallAlbums]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      motionEnabledRef.current = !query.matches;
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!activeTrack?.cover_path) {
      targetTintRef.current = FALLBACK_TINT;
      return;
    }

    const image = getCachedImage(activeTrack.cover_path);
    const extract = () => {
      const color = extractAverageColor(image);
      if (color) targetTintRef.current = colorToZuneTint(color);
    };

    if (image.complete && image.naturalWidth > 0) {
      extract();
      return;
    }

    image.addEventListener("load", extract, { once: true });
    image.addEventListener("error", () => {
      targetTintRef.current = FALLBACK_TINT;
    }, { once: true });
    return () => image.removeEventListener("load", extract);
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
      const previousTime = lastTimeRef.current ?? time;
      const deltaSeconds = Math.min(0.08, Math.max(0.001, (time - previousTime) / 1000));
      lastTimeRef.current = time;
      const motionEnabled = motionEnabledRef.current;
      sceneTimeRef.current += deltaSeconds * (motionEnabled ? (isPlayingRef.current ? 1 : 0.1) : 0);
      wallRevealRef.current += (wallRevealTargetRef.current - wallRevealRef.current)
        * (1 - Math.exp(-deltaSeconds / 0.24));
      tintRef.current = lerpColor(tintRef.current, targetTintRef.current, 1 - Math.exp(-deltaSeconds / 11));
      drawMosaic(
        context,
        sizeRef.current,
        tilesRef.current,
        albumsRef.current,
        tintRef.current,
        beatPulseRef.current,
        beatPhaseRef.current,
        beatConfidenceRef.current,
        isPlayingRef.current,
        flipRef.current,
        time,
        sceneTimeRef.current,
        wallRevealRef.current,
        motionEnabled,
      );
      frameRef.current = window.requestAnimationFrame(draw);
    };

    frameRef.current = window.requestAnimationFrame(draw);
    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
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
  baseTint: RgbColor,
  beatPulse: number,
  beatPhase: number,
  beatConfidence: number,
  isPlaying: boolean,
  flipState: MosaicFlipState,
  time: number,
  sceneSeconds: number,
  wallOpacity: number,
  motionEnabled: boolean,
) {
  const { width, height, dpr } = size;
  if (width <= 1 || height <= 1) return;

  const tint = createSlowTint(baseTint, sceneSeconds);
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
  context.fillStyle = "#020602";
  context.fillRect(0, 0, width, height);

  const motion = createMosaicMotion(motionEnabled ? sceneSeconds : 0);

  context.save();
  context.globalAlpha = Math.max(0, Math.min(1, wallOpacity));
  context.translate(width / 2, height / 2);
  context.scale(motion.scale, motion.scale);
  context.translate(-width / 2 + motion.driftX, -height / 2 + motion.driftY);

  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    const flip = flipState.tileIndex === index
      ? {
          progress: (time - flipState.startedAt) / flipState.duration,
          fromAlbumIndex: flipState.fromAlbumIndex,
          toAlbumIndex: flipState.toAlbumIndex,
          direction: flipState.direction,
        }
      : null;
    drawTile(context, tile, albums, tint, flip);
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);

  context.globalCompositeOperation = "source-over";
  const sweepState = createMosaicColorSweep({ baseTint: tint, timeSeconds: sceneSeconds, isPlaying });
  const sweep = context.createLinearGradient(
    width * (sweepState.center - sweepState.width),
    height * 0.05,
    width * (sweepState.center + sweepState.width),
    height * 0.92,
  );
  sweep.addColorStop(0, colorCss(sweepState.shadow, 0));
  sweep.addColorStop(0.28, colorCss(sweepState.shadow, sweepState.alpha * 0.36));
  sweep.addColorStop(0.52, colorCss(sweepState.color, sweepState.alpha));
  sweep.addColorStop(0.78, colorCss(sweepState.shadow, sweepState.alpha * 0.3));
  sweep.addColorStop(1, colorCss(sweepState.shadow, 0));
  context.globalCompositeOperation = "screen";
  context.fillStyle = sweep;
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = "source-over";

  const wash = context.createLinearGradient(0, 0, width, height);
  wash.addColorStop(0, colorCss(tint, 0.1));
  wash.addColorStop(0.54, colorCss({ r: tint.r * 0.48, g: tint.g * 0.68, b: tint.b * 0.62 }, 0.13));
  wash.addColorStop(1, "rgba(2, 7, 4, 0.26)");
  context.fillStyle = wash;
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

function drawTile(
  context: CanvasRenderingContext2D,
  tile: MosaicTile,
  albums: AlbumGroup[],
  tint: RgbColor,
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
  const image = album?.coverPath ? getCachedImage(album.coverPath) : null;
  const flipScale = isFlipping ? Math.max(0.025, Math.abs(Math.cos(easedFlip * Math.PI))) : 1;
  const flipShade = isFlipping ? 0.12 + Math.sin(easedFlip * Math.PI) * 0.5 : 0;
  const centerX = tile.x + tile.width / 2;
  const centerY = tile.y + tile.height / 2;
  const perspectiveOffset = isFlipping
    ? flip.direction * Math.sin(easedFlip * Math.PI) * tile.height * 0.028
    : 0;

  context.save();
  context.translate(centerX, centerY + perspectiveOffset);
  context.scale(1, flipScale);
  context.translate(-centerX, -centerY);
  context.beginPath();
  context.rect(tile.x, tile.y, tile.width - 1, tile.height - 1);
  context.clip();
  context.fillStyle = colorCss({ r: tint.r * 0.38, g: tint.g * 0.42, b: tint.b * 0.34 }, 1);
  context.fillRect(tile.x, tile.y, tile.width, tile.height);

  if (image?.complete && image.naturalWidth > 0) {
    const inheritedAlpha = context.globalAlpha;
    context.globalAlpha = inheritedAlpha * 0.86;
    context.filter = "grayscale(0.82) sepia(0.66) hue-rotate(18deg) saturate(1.2) brightness(0.56) contrast(1.09)";
    drawImageCover(context, image, tile.x, tile.y, tile.width, tile.height);
    context.filter = "none";
    context.globalAlpha = inheritedAlpha;
  }

  context.globalCompositeOperation = "source-over";
  context.fillStyle = colorCss(tint, 0.4);
  context.fillRect(tile.x, tile.y, tile.width, tile.height);
  context.fillStyle = `rgba(0, 0, 0, ${0.18 + flipShade})`;
  context.fillRect(tile.x, tile.y, tile.width, tile.height);
  if (isFlipping) {
    const highlight = context.createLinearGradient(tile.x, tile.y, tile.x, tile.y + tile.height);
    highlight.addColorStop(0.42, "rgba(255, 255, 255, 0)");
    highlight.addColorStop(0.5, `rgba(255, 255, 255, ${0.12 + flipShade * 0.32})`);
    highlight.addColorStop(0.58, "rgba(255, 255, 255, 0)");
    context.fillStyle = highlight;
    context.fillRect(tile.x, tile.y, tile.width, tile.height);
  }
  context.strokeStyle = "rgba(0, 0, 0, 0.82)";
  context.lineWidth = 1;
  context.strokeRect(tile.x + 0.5, tile.y + 0.5, tile.width - 1, tile.height - 1);
  context.restore();
}

function drawImageCover(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const sourceRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = width / height;
  let sourceWidth = image.naturalWidth;
  let sourceHeight = image.naturalHeight;
  let sourceX = 0;
  let sourceY = 0;

  if (sourceRatio > targetRatio) {
    sourceWidth = image.naturalHeight * targetRatio;
    sourceX = (image.naturalWidth - sourceWidth) / 2;
  } else {
    sourceHeight = image.naturalWidth / targetRatio;
    sourceY = (image.naturalHeight - sourceHeight) / 2;
  }

  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

async function preloadWallImages(albums: AlbumGroup[]) {
  const coverPaths = [...new Set(albums.map((album) => album.coverPath).filter((path): path is string => Boolean(path)))];
  await Promise.all(coverPaths.map((path) => waitForImage(getCachedImage(path))));
}

function waitForImage(image: HTMLImageElement) {
  if (image.complete) {
    if (image.naturalWidth <= 0 || typeof image.decode !== "function") return Promise.resolve();
    return image.decode().catch(() => undefined);
  }

  return new Promise<void>((resolve) => {
    let timeoutId: number | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      image.removeEventListener("load", handleLoad);
      image.removeEventListener("error", finish);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      resolve();
    };
    const handleLoad = () => {
      if (typeof image.decode !== "function") {
        finish();
        return;
      }
      void image.decode().catch(() => undefined).then(finish);
    };

    image.addEventListener("load", handleLoad, { once: true });
    image.addEventListener("error", finish, { once: true });
    timeoutId = window.setTimeout(finish, WALL_PRELOAD_TIMEOUT_MS);
  });
}

function getCachedImage(path: string) {
  const url = convertFileSrc(path);
  const cached = imageCache.get(url);
  if (cached) return cached;

  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.src = url;
  imageCache.set(url, image);
  return image;
}

function extractAverageColor(image: HTMLImageElement) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return averageImageColor(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch {
    return null;
  }
}

function easeInOutCubic(value: number) {
  const amount = Math.max(0, Math.min(1, value));
  return amount < 0.5 ? 4 * amount * amount * amount : 1 - (-2 * amount + 2) ** 3 / 2;
}
