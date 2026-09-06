import { NOW_PLAYING_MOTION } from "../motion/tokens";
import { useEffect, useRef } from "react";
import {
  createZuneMountainFrame,
  type ZuneMountainFrame,
  zuneGlowRadiance,
} from "../utils/audioGlow";
import { createIdleVisualizerFrame } from "../utils/visualizer";
import { getVisualizerFrame, isDocumentVisible } from "../utils/visualizerBus";
import { useReducedMotion } from "../motion/useReducedMotion";
import { VISUALIZER_SAMPLE_COUNT } from "../constants";

// Reduced-motion substitute for the live audio frame: a frozen idle frame at
// t=0, so the glow settles into a static dim flame instead of pulsing.
const REDUCED_GLOW_ENERGY = 0.055;
const REDUCED_GLOW_SAMPLES = createIdleVisualizerFrame(VISUALIZER_SAMPLE_COUNT, 0, 0).samples;

export function AudioGlowCanvas({
  isPlaying,
  volume,
}: {
  isPlaying: boolean;
  volume: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const volumeRef = useRef(volume);
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  const bodyRef = useRef(0);
  const spreadRef = useRef(0);
  const crestRef = useRef(0);
  const hotspotRef = useRef(0);
  const ridgeHeightsRef = useRef<number[]>([]);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const invalidateRef = useRef<() => void>(() => {});
  const settleUntilRef = useRef(0);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
    invalidateRef.current();
  }, [isPlaying]);

  useEffect(() => {
    volumeRef.current = volume;
    invalidateRef.current();
  }, [volume]);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    invalidateRef.current();
  }, [reducedMotion]);

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
      invalidateRef.current();
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

    let field: GlowField | null = null;
    const draw = (time: number) => {
      const previous = lastTimeRef.current ?? time;
      const delta = Math.min(0.08, Math.max(0.001, (time - previous) / 1000));
      lastTimeRef.current = time;

      const frame = getVisualizerFrame();
      const playing = isPlayingRef.current;
      const reduced = reducedMotionRef.current;
      const energyValue = reduced ? (playing ? REDUCED_GLOW_ENERGY : 0) : playing ? Math.max(0, frame.energy) : 0;
      const beatValue = reduced ? 0 : playing ? frame.beatPulse : 0;
      const onsetValue = reduced ? 0 : playing ? frame.onsetStrength : 0;
      const bassValue = reduced || !playing ? 0 : frame.bass;
      const textureValue = reduced || !playing ? 0 : frame.texture;
      const hit = Math.max(beatValue, onsetValue);

      bodyRef.current = smoothTransient(bodyRef.current, playing ? energyValue * 0.6 + bassValue * 0.5 + hit * 0.12 : 0, delta, 0.08, playing ? 0.62 : 0.12);
      spreadRef.current = smoothTransient(spreadRef.current, playing ? bassValue * 0.64 + energyValue * 0.22 + hit * 0.34 : 0, delta, 0.09, playing ? 0.7 : 0.14);
      crestRef.current = smoothTransient(crestRef.current, playing ? hit * 0.82 + textureValue * 0.22 : 0, delta, 0.065, playing ? 0.48 : 0.1);
      hotspotRef.current = smoothTransient(hotspotRef.current, playing ? onsetValue * 0.84 + beatValue * 0.2 : 0, delta, 0.055, playing ? 0.3 : 0.08);

      const targetFrame = createZuneMountainFrame({
        samples: reduced ? REDUCED_GLOW_SAMPLES : frame.samples,
        transients: reduced ? [] : frame.transients,
        energy: energyValue,
        beatPulse: beatValue,
        onsetStrength: onsetValue,
        beatPhase: reduced ? 1 : playing ? frame.beatPhase : 1,
        time: reduced ? 0 : time / 1000,
        bodyLevel: bodyRef.current,
        spreadLevel: spreadRef.current,
        crestLevel: crestRef.current,
        hotspotLevel: hotspotRef.current,
      });
      const glowFrame = smoothMountainFrame(targetFrame, ridgeHeightsRef.current, delta, playing);
      ridgeHeightsRef.current = glowFrame.ridgePoints.map((point) => point.height);

      if (!field && sizeRef.current.width > 1) field = createGlowField();
      drawGlow(
        context,
        sizeRef.current,
        glowFrame,
        playing,
        volumeRef.current,
        field,
      );
      if (isDocumentVisible() && ((isPlayingRef.current && !reducedMotionRef.current) || time < settleUntilRef.current)) {
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
      if (!frameRef.current) frameRef.current = window.requestAnimationFrame(draw);
    };
    const invalidate = () => {
      settleUntilRef.current = performance.now() + NOW_PLAYING_MOTION.canvasSettle;
      sync();
    };
    invalidateRef.current = invalidate;
    // React StrictMode runs mount effects twice in development. Clear the
    // cancelled id before the second setup so the glow loop can restart.
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    invalidate();
    document.addEventListener("visibilitychange", invalidate);
    return () => {
      document.removeEventListener("visibilitychange", invalidate);
      invalidateRef.current = () => {};
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastTimeRef.current = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="audio-glow-canvas" aria-hidden="true" />;
}

type GlowField = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  pixels: ImageData;
};

function createGlowField(): GlowField | null {
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 72;
  const context = canvas.getContext("2d");
  return context ? { canvas, context, pixels: context.createImageData(canvas.width, canvas.height) } : null;
}

function drawGlow(
  context: CanvasRenderingContext2D,
  size: { width: number; height: number; dpr: number },
  frame: ZuneMountainFrame,
  isPlaying: boolean,
  volume: number,
  field: GlowField | null,
) {
  const { width, height, dpr } = size;
  if (width <= 1 || height <= 1) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!isPlaying || !frame.active || !field || frame.ridgePoints.length === 0) return;

  const { canvas, pixels } = field;
  const points = frame.ridgePoints;
  const gain = (volume <= 0.01 ? 0.38 : 1) * (0.68 + frame.bodyAlpha * 0.5);
  for (let column = 0; column < canvas.width; column += 1) {
    const position = column / (canvas.width - 1) * (points.length - 1);
    const index = Math.floor(position);
    const a = points[index], b = points[Math.min(points.length - 1, index + 1)];
    const blend = position - index;
    const reach = a.height + (b.height - a.height) * blend;
    const heat = a.heat + (b.heat - a.heat) * blend;
    for (let row = 0; row < canvas.height; row += 1) {
      const rise = 1 - row / (canvas.height - 1);
      const light = zuneGlowRadiance(reach, heat, rise) * gain;
      const offset = (row * canvas.width + column) * 4;
      pixels.data[offset] = 246;
      pixels.data[offset + 1] = 32 + Math.min(1, light) * 66;
      pixels.data[offset + 2] = 9 + Math.min(1, light) * 15;
      pixels.data[offset + 3] = Math.min(1, light) * 220;
    }
  }
  field.context.putImageData(pixels, 0, 0);
  context.globalCompositeOperation = "source-over";
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(canvas, 0, 0, width, height);
}

function smoothTransient(current: number, target: number, delta: number, attackSeconds: number, decaySeconds: number) {
  const safeTarget = Math.max(0, target);
  const tau = safeTarget > current ? attackSeconds : decaySeconds;
  return current + (safeTarget - current) * (1 - Math.exp(-delta / tau));
}

function smoothMountainFrame(frame: ZuneMountainFrame, previousHeights: number[], delta: number, isPlaying: boolean): ZuneMountainFrame {
  if (!isPlaying || frame.ridgePoints.length === 0) return { ...frame, ridgePoints: [], ridgePeak: 0 };
  const ridgePoints = frame.ridgePoints.map((point, index) => {
    const previous = previousHeights[index] ?? point.height;
    const tau = point.height > previous ? 0.02 : 0.09;
    const height = previous + (point.height - previous) * (1 - Math.exp(-delta / tau));
    return { ...point, height };
  });
  return {
    ...frame,
    ridgePoints,
    ridgePeak: ridgePoints.reduce((peak, point) => Math.max(peak, point.height), 0),
  };
}
