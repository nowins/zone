import { NOW_PLAYING_MOTION } from "../motion/tokens";
import { useEffect, useRef } from "react";
import {
  createZuneMountainFrame,
  type ZuneMountainFrame,
  type ZuneMountainPoint,
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

      drawGlow(
        context,
        sizeRef.current,
        glowFrame,
        playing,
        volumeRef.current,
        frame.beatConfidence,
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

function drawGlow(
  context: CanvasRenderingContext2D,
  size: { width: number; height: number; dpr: number },
  frame: ZuneMountainFrame,
  isPlaying: boolean,
  volume: number,
  beatConfidence: number,
) {
  const { width, height, dpr } = size;
  if (width <= 1 || height <= 1) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!isPlaying || !frame.active || frame.centerIntensity < 0.018) return;

  const mutedGain = volume <= 0.01 ? 0.38 : 1;
  const confidenceGain = 0.92 + beatConfidence * 0.08;
  const gain = mutedGain * confidenceGain * 1.25;
  const centerX = width * frame.bodyCenterX;
  const baseY = height * 1.04;
  const bodyY = height * (0.96 - frame.bodyLift);
  const bodyRadiusX = width * frame.bodyWidth * 0.5;
  const bodyRadiusY = height * frame.bodyHeight * 0.88;

  context.save();
  context.globalCompositeOperation = "source-over";
  drawMountainBody(context, frame.ridgePoints, width, height, {
    alpha: 0.48 * gain,
    blur: 5,
    heightScale: height * 0.76,
    bottom: height + 6,
    stops: [
      [0, "rgba(132, 18, 8, 0.34)"],
      [0.5, "rgba(104, 9, 5, 0.3)"],
      [1, "rgba(48, 2, 2, 0.18)"],
    ],
  });
  drawGlowEllipse(context, centerX, baseY, bodyRadiusX * 1.16, height * 0.24, frame.baseAlpha * 0.42 * gain, [
    [0, "rgba(112, 12, 4, 0.48)"],
    [0.5, "rgba(74, 5, 3, 0.22)"],
    [1, "rgba(0, 0, 0, 0)"],
  ], 18);
  context.globalCompositeOperation = "screen";
  drawMountainBody(context, frame.ridgePoints, width, height, {
    alpha: (0.42 + frame.crestAlpha * 0.7) * gain,
    blur: 16,
    heightScale: height * 0.98,
    bottom: height + 10,
    stops: [
      [0, "rgba(255, 74, 30, 0.28)"],
      [0.48, "rgba(190, 22, 10, 0.28)"],
      [1, "rgba(70, 3, 3, 0.12)"],
    ],
  });
  drawMountainBody(context, frame.ridgePoints, width, height, {
    alpha: (0.5 + frame.bodyAlpha * 0.34) * gain,
    blur: 6,
    heightScale: height * 0.84,
    bottom: height + 4,
    stops: [
      [0, "rgba(255, 112, 50, 0.44)"],
      [0.44, "rgba(224, 42, 16, 0.42)"],
      [1, "rgba(92, 5, 4, 0.18)"],
    ],
  });
  drawGlowEllipse(context, centerX, baseY, bodyRadiusX * 1.18, height * 0.26, frame.baseAlpha * 1.05 * gain, [
    [0, "rgba(150, 18, 5, 0.48)"],
    [0.48, "rgba(96, 7, 3, 0.24)"],
    [1, "rgba(0, 0, 0, 0)"],
  ], 16);
  drawGlowEllipse(context, centerX, bodyY, bodyRadiusX, bodyRadiusY, frame.bodyAlpha * 0.18 * gain, [
    [0, "rgba(255, 92, 30, 0.68)"],
    [0.38, "rgba(218, 36, 12, 0.42)"],
    [0.76, "rgba(110, 8, 5, 0.22)"],
    [1, "rgba(0, 0, 0, 0)"],
  ], 20);
  drawGlowEllipse(context, centerX, bodyY + height * 0.04, bodyRadiusX * 0.58, bodyRadiusY * 0.52, frame.bodyAlpha * 0.1 * gain, [
    [0, "rgba(255, 156, 76, 0.52)"],
    [0.44, "rgba(255, 82, 28, 0.26)"],
    [1, "rgba(0, 0, 0, 0)"],
  ], 10);
  drawMountainCrest(context, frame.ridgePoints, width, height, gain);
  drawHotspots(context, frame, width, height, gain);
  context.restore();

  clearTopSafety(context, width, height);
}

function drawMountainBody(
  context: CanvasRenderingContext2D,
  points: ZuneMountainPoint[],
  width: number,
  height: number,
  options: {
    alpha: number;
    blur: number;
    heightScale: number;
    bottom: number;
    stops: Array<[number, string]>;
  },
) {
  if (points.length < 2 || options.alpha <= 0) return;
  context.save();
  context.globalAlpha = options.alpha;
  context.filter = options.blur > 0 ? `blur(${options.blur}px)` : "none";
  const gradient = context.createLinearGradient(0, height * 0.42, 0, options.bottom);
  for (const [offset, color] of options.stops) gradient.addColorStop(offset, color);
  context.fillStyle = gradient;
  buildMountainPath(context, points, width, options.bottom, options.heightScale);
  context.fill();
  context.restore();
}

function drawMountainCrest(
  context: CanvasRenderingContext2D,
  points: ZuneMountainPoint[],
  width: number,
  height: number,
  gain: number,
) {
  if (points.length < 2) return;
  const crest = context.createLinearGradient(0, 0, width, 0);
  for (let index = 0; index < points.length; index += 4) {
    const point = points[index];
    crest.addColorStop(point.x, `rgba(255, ${Math.round(58 + point.heat * 92)}, 42, ${0.12 + point.heat * 0.5})`);
  }

  context.save();
  context.globalAlpha = 0.36 * gain;
  context.filter = "blur(4px)";
  context.strokeStyle = crest;
  context.lineWidth = 4;
  context.beginPath();
  buildMountainCrestPath(context, points, width, height * 0.88, height + 4);
  context.stroke();
  context.restore();
}

function buildMountainPath(
  context: CanvasRenderingContext2D,
  points: ZuneMountainPoint[],
  width: number,
  bottom: number,
  heightScale: number,
) {
  context.beginPath();
  context.moveTo(0, bottom);
  buildMountainCrestPath(context, points, width, heightScale, bottom);
  context.lineTo(width, bottom);
  context.closePath();
}

function buildMountainCrestPath(
  context: CanvasRenderingContext2D,
  points: ZuneMountainPoint[],
  width: number,
  heightScale: number,
  bottom: number,
) {
  const first = points[0];
  context.lineTo(first.x * width, bottom - first.height * heightScale);
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    const pointX = point.x * width;
    const pointY = bottom - point.height * heightScale;
    const midpointX = ((point.x + next.x) / 2) * width;
    const midpointY = bottom - ((point.height + next.height) / 2) * heightScale;
    context.quadraticCurveTo(pointX, pointY, midpointX, midpointY);
  }
  const last = points[points.length - 1];
  context.lineTo(last.x * width, bottom - last.height * heightScale);
}

function drawHotspots(context: CanvasRenderingContext2D, frame: ZuneMountainFrame, width: number, height: number, gain: number) {
  if (frame.hotspots.length === 0) return;
  for (const hotspot of frame.hotspots) {
    drawGlowEllipse(context, width * hotspot.x, height * hotspot.y, width * hotspot.radius, height * hotspot.radius * 1.4, hotspot.alpha * gain, [
      [0, "rgba(255, 186, 116, 0.54)"],
      [0.36, "rgba(255, 86, 36, 0.18)"],
      [1, "rgba(0, 0, 0, 0)"],
    ], 3);
  }
}

function drawGlowEllipse(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  alpha: number,
  stops: Array<[number, string]>,
  blur: number,
) {
  if (alpha <= 0 || radiusX <= 0 || radiusY <= 0) return;
  context.save();
  context.translate(x, y);
  context.scale(radiusX, radiusY);
  context.globalAlpha = alpha;
  context.filter = blur > 0 ? `blur(${blur}px)` : "none";
  const gradient = context.createRadialGradient(0, 0, 0.04, 0, 0, 1);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(0, 0, 1, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function clearTopSafety(context: CanvasRenderingContext2D, width: number, height: number) {
  const fade = context.createLinearGradient(0, 0, 0, height);
  fade.addColorStop(0, "rgba(0, 0, 0, 1)");
  fade.addColorStop(0.46, "rgba(0, 0, 0, 1)");
  fade.addColorStop(0.54, "rgba(0, 0, 0, 0.42)");
  fade.addColorStop(0.64, "rgba(0, 0, 0, 0)");
  fade.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.globalCompositeOperation = "destination-out";
  context.fillStyle = fade;
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = "source-over";
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
