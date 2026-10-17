import { useEffect, useRef } from "react";
import { NOW_PLAYING_MOTION } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";
import { getVisualizerFrame, isDocumentVisible, WINDOW_VISIBILITY_EVENT } from "../utils/visualizerBus";
import { createZuneGlowTexture, EMPTY_GLOW_BANDS, ZuneGlowAnimator, zuneGlowSprites } from "../utils/zuneSpectrumGlow";

export function AudioGlowCanvas({ isPlaying, volume }: { isPlaying: boolean; volume: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audible = isPlaying && volume > 0;
  const playingRef = useRef(audible);
  const reducedMotion = useReducedMotion();
  const reducedRef = useRef(reducedMotion);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const frameRef = useRef<number | null>(null);
  const invalidateRef = useRef<() => void>(() => {});

  useEffect(() => { playingRef.current = audible; invalidateRef.current(); }, [audible]);
  useEffect(() => { reducedRef.current = reducedMotion; invalidateRef.current(); }, [reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const size = { width: Math.max(1, Math.floor(rect.width)), height: Math.max(1, Math.floor(rect.height)),
        dpr: Math.max(1, Math.min(window.devicePixelRatio || 1, 2)) };
      if (Object.keys(size).every(key => size[key as keyof typeof size] === sizeRef.current[key as keyof typeof size])) return;
      sizeRef.current = size;
      canvas.width = Math.floor(size.width * size.dpr); canvas.height = Math.floor(size.height * size.dpr);
      invalidateRef.current();
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const orange = new ZuneGlowAnimator("orange"), pink = new ZuneGlowAnimator("pink");
    let textures: (HTMLCanvasElement | null)[] | null = null;
    let sourceKey: string | null | undefined;
    let settleUntil = 0;
    const draw = (time: number) => {
      frameRef.current = null;
      const frame = getVisualizerFrame();
      if (sourceKey !== frame.sourceKey) { orange.reset(); pink.reset(); sourceKey = frame.sourceKey; }
      const active = playingRef.current && !reducedRef.current;
      const input = active ? frame.glowBands ?? EMPTY_GLOW_BANDS : EMPTY_GLOW_BANDS;
      const levels = [orange.update(time, input), pink.update(time, input)];
      const { width, height, dpr } = sizeRef.current;
      if (width > 1 && height > 1) {
        context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
        if (orange.active || pink.active) {
          textures ??= [createZuneGlowTexture("orange"), createZuneGlowTexture("pink")];
          // Source-over plus the shared CSS screen layer is a Zone adaptation.
          context.globalCompositeOperation = "source-over";
          context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
          for (let layer = 0; layer < levels.length; layer++) {
            const texture = textures[layer];
            if (!texture) continue;
            for (const sprite of zuneGlowSprites(levels[layer], width)) {
              if (sprite.alpha <= 0 || sprite.height <= 0) continue;
              context.globalAlpha = sprite.alpha;
              context.drawImage(texture, sprite.x, height - sprite.height, sprite.width, sprite.height);
            }
          }
          context.globalAlpha = 1;
        }
      }
      if (isDocumentVisible() && (active || ((orange.active || pink.active) && time < settleUntil))) {
        frameRef.current = window.requestAnimationFrame(draw);
      }
    };
    const invalidate = () => {
      if (!isDocumentVisible()) {
        if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null; orange.reset(); pink.reset();
        return;
      }
      settleUntil = performance.now() + NOW_PLAYING_MOTION.canvasSettle;
      if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(draw);
    };
    invalidateRef.current = invalidate;
    // StrictMode replay must not retain the cancelled frame from the first setup.
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    invalidate();
    document.addEventListener("visibilitychange", invalidate);
    document.addEventListener(WINDOW_VISIBILITY_EVENT, invalidate);
    return () => {
      document.removeEventListener("visibilitychange", invalidate);
      document.removeEventListener(WINDOW_VISIBILITY_EVENT, invalidate);
      invalidateRef.current = () => {};
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="audio-glow-canvas" aria-hidden="true" />;
}
