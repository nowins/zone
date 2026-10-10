import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useReducedMotion } from "../motion/useReducedMotion";
import { MOTION_DURATIONS } from "../motion/tokens";
import {
  buildCollectionBackdropLayout,
  collectionParallaxOffset,
  type CollectionBackdropScene,
} from "../utils/collectionBackdrop";

const ARTWORK_PRELOAD_TIMEOUT_MS = 1_200;
const IMAGE_CACHE_LIMIT = 32;
const imageCache = new Map<string, HTMLImageElement>();
type PreparedScene = { scene: NonNullable<CollectionBackdropScene>; images: Map<string, HTMLImageElement> };

export function CollectionArtworkBackdrop({
  scene,
  surfaceKey,
  parallaxEnabled = true,
}: {
  scene: CollectionBackdropScene;
  surfaceKey: string;
  parallaxEnabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([null, null]);
  const canvasScenesRef = useRef<Array<PreparedScene | null>>([null, null]);
  const visibleCanvasRef = useRef(0);
  const fadeUntilRef = useRef(0);
  const parallaxOffsetRef = useRef(0);
  const redrawFrameRef = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const sceneSignature = scene
    ? `${scene.sceneKey}\u0000${scene.assetKey}`
    : "";

  useEffect(() => {
    parallaxOffsetRef.current = 0;
    redrawBackdropCanvases(canvasRefs.current, canvasScenesRef.current, 0);
  }, [surfaceKey]);

  useEffect(() => {
    const collection = rootRef.current?.parentElement;
    if (!collection) return;

    const scheduleRedraw = () => {
      if (redrawFrameRef.current !== null) return;
      redrawFrameRef.current = window.requestAnimationFrame(() => {
        redrawFrameRef.current = null;
        redrawBackdropCanvases(
          canvasRefs.current,
          canvasScenesRef.current,
          parallaxOffsetRef.current,
        );
      });
    };

    const handleScroll = (event: Event) => {
      if (!parallaxEnabled || reducedMotion) {
        parallaxOffsetRef.current = 0;
        scheduleRedraw();
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      parallaxOffsetRef.current = collectionParallaxOffset(target.scrollTop);
      scheduleRedraw();
    };

    collection.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => {
      collection.removeEventListener("scroll", handleScroll, true);
      if (redrawFrameRef.current !== null) {
        window.cancelAnimationFrame(redrawFrameRef.current);
        redrawFrameRef.current = null;
      }
    };
  }, [parallaxEnabled, reducedMotion]);

  useEffect(() => {
    if (!parallaxEnabled || reducedMotion) {
      parallaxOffsetRef.current = 0;
      redrawBackdropCanvases(canvasRefs.current, canvasScenesRef.current, 0);
    }
  }, [parallaxEnabled, reducedMotion]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let frame: number | undefined;
    const canvases = canvasRefs.current;
    if (!scene) {
      canvases.forEach((canvas) => canvas?.classList.remove("is-visible"));
      fadeUntilRef.current = performance.now() + (reducedMotion ? 0 : MOTION_DURATIONS.content);
      return;
    }

    const prepare = async () => {
      const prepared = await preloadSceneImages(scene);
      if (cancelled || prepared.images.size === 0) return;
      // Both canvases remain visible during a crossfade. Never repaint the
      // outgoing one with a third scene until its opacity has reached zero.
      const wait = reducedMotion ? 0 : Math.max(0, fadeUntilRef.current - performance.now());
      if (wait > 0) timer = window.setTimeout(() => commit(prepared), wait);
      else commit(prepared);
    };
    const commit = (prepared: PreparedScene) => {
      if (cancelled) return;
      const nextIndex = visibleCanvasRef.current === 0 ? 1 : 0;
      const nextCanvas = canvasRefs.current[nextIndex];
      const previousCanvas = canvasRefs.current[visibleCanvasRef.current];
      if (!nextCanvas) return;

      canvasScenesRef.current[nextIndex] = prepared;
      drawCollectionBackdrop(nextCanvas, prepared, parallaxOffsetRef.current);
      frame = window.requestAnimationFrame(() => {
        if (cancelled) return;
        nextCanvas.classList.add("is-visible");
        previousCanvas?.classList.remove("is-visible");
        visibleCanvasRef.current = nextIndex;
        fadeUntilRef.current = performance.now() + (reducedMotion ? 0 : MOTION_DURATIONS.content);
      });
    };

    void prepare();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [sceneSignature, reducedMotion]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const redraw = () => {
      canvasScenesRef.current.forEach((currentScene, index) => {
        const canvas = canvasRefs.current[index];
        if (currentScene && canvas) {
          drawCollectionBackdrop(canvas, currentScene, parallaxOffsetRef.current);
        }
      });
    };
    const observer = new ResizeObserver(redraw);
    observer.observe(root);
    redraw();
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="collection-artwork-backdrop" aria-hidden="true">
      {[0, 1].map((index) => (
        <canvas
          key={index}
          ref={(node) => {
            canvasRefs.current[index] = node;
          }}
          className="collection-artwork-canvas"
        />
      ))}
    </div>
  );
}

function drawCollectionBackdrop(
  canvas: HTMLCanvasElement,
  prepared: PreparedScene,
  parallaxOffset = 0,
) {
  const { scene, images } = prepared;
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(bounds.width));
  const height = Math.max(1, Math.floor(bounds.height));
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 1.5));
  const pixelWidth = Math.floor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const placements = buildCollectionBackdropLayout(
    width,
    height,
    scene.assets,
    scene.seed,
    parallaxOffset,
  );
  for (const placement of placements) {
    const asset = scene.assets[placement.assetIndex];
    const image = asset ? images.get(asset.path) : null;
    if (!image?.complete || image.naturalWidth <= 0) continue;

    const centerX = placement.x + placement.width / 2;
    const centerY = placement.y + placement.height / 2;
    context.save();
    context.translate(centerX, centerY);
    context.rotate(placement.rotation);
    context.translate(-centerX, -centerY);
    context.beginPath();
    context.rect(placement.x, placement.y, placement.width, placement.height);
    context.clip();
    context.globalAlpha = placement.opacity;
    context.filter = asset.role === "artist"
      ? "grayscale(0.72) saturate(0.42) brightness(0.66) contrast(1.08)"
      : "grayscale(0.78) saturate(0.48) brightness(0.62) contrast(1.08)";
    drawImageCover(
      context,
      image,
      placement.x,
      placement.y,
      placement.width,
      placement.height,
      placement.cropX,
      placement.cropY,
    );
    context.filter = "none";
    context.globalAlpha = 1;
    context.strokeStyle = "rgba(247, 242, 246, 0.05)";
    context.lineWidth = 1;
    context.strokeRect(
      placement.x + 0.5,
      placement.y + 0.5,
      placement.width - 1,
      placement.height - 1,
    );
    context.restore();
  }

  const colorWash = context.createLinearGradient(0, 0, width, height);
  colorWash.addColorStop(0, "rgba(88, 10, 50, 0.11)");
  colorWash.addColorStop(0.52, "rgba(34, 10, 28, 0.05)");
  colorWash.addColorStop(1, "rgba(112, 18, 62, 0.13)");
  context.fillStyle = colorWash;
  context.fillRect(0, 0, width, height);
}

function redrawBackdropCanvases(
  canvases: Array<HTMLCanvasElement | null>,
  scenes: Array<PreparedScene | null>,
  parallaxOffset: number,
) {
  scenes.forEach((scene, index) => {
    const canvas = canvases[index];
    if (scene && canvas) drawCollectionBackdrop(canvas, scene, parallaxOffset);
  });
}

function drawImageCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  focalX: number,
  focalY: number,
) {
  const sourceRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = width / height;
  let sourceWidth = image.naturalWidth;
  let sourceHeight = image.naturalHeight;

  if (sourceRatio > targetRatio) {
    sourceWidth = image.naturalHeight * targetRatio;
  } else {
    sourceHeight = image.naturalWidth / targetRatio;
  }

  const sourceX = (image.naturalWidth - sourceWidth) * clamp01(focalX);
  const sourceY = (image.naturalHeight - sourceHeight) * clamp01(focalY);
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    x,
    y,
    width,
    height,
  );
}

async function preloadSceneImages(scene: NonNullable<CollectionBackdropScene>): Promise<PreparedScene> {
  // These references belong to the painted scene, independently of cache LRU.
  const images = new Map(scene.assets.map(asset => [asset.path, getCachedImage(asset.path)]));
  await Promise.all([...images.values()].map(waitForImage));
  for (const [path, image] of images) {
    if (!image.complete || image.naturalWidth <= 0) images.delete(path);
  }
  return { scene, images };
}

function waitForImage(image: HTMLImageElement) {
  if (image.complete) {
    if (image.naturalWidth <= 0 || typeof image.decode !== "function") return Promise.resolve();
    return image.decode().catch(() => undefined);
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    let timeoutId: number | undefined;
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
    timeoutId = window.setTimeout(finish, ARTWORK_PRELOAD_TIMEOUT_MS);
  });
}

function getCachedImage(path: string) {
  const url = convertFileSrc(path);
  const cached = imageCache.get(url);
  if (cached) {
    imageCache.delete(url);
    imageCache.set(url, cached);
    return cached;
  }

  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.src = url;
  imageCache.set(url, image);
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    if (typeof oldest !== "string") break;
    imageCache.delete(oldest);
  }
  return image;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
