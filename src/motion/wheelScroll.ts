import { animateValue, type AnimationHandle } from "./animate.js";
import { SCROLL_MOTION, SPRING_PRESETS } from "./tokens.js";
import { clamp } from "./math.js";

type WheelSignal = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">;

/** Signal heuristic, not device detection: fine/fractional gestures stay native. */
export function isCoarseVerticalWheel(signal: WheelSignal): boolean {
  return signal.deltaX === 0 && signal.deltaY !== 0 && (signal.deltaMode !== 0
    || (Number.isInteger(signal.deltaY) && Math.abs(signal.deltaY) >= SCROLL_MOTION.coarseDelta));
}

/** Delegated vertical scrolling, sharing the panorama's interruptible spring. */
export function attachWheelScroll(root: HTMLElement, selector: string): () => void {
  const document = root.ownerDocument, window = document.defaultView;
  if (!window) return () => {};
  const motions = new Map<HTMLElement, { handle: AnimationHandle | null; target: number; written: number }>();
  const stop = (area: HTMLElement) => { motions.get(area)?.handle?.cancel(); motions.delete(area); };
  const stopAll = () => { for (const area of motions.keys()) stop(area); };
  const wheel = (event: WheelEvent) => {
    if (event.defaultPrevented || document.hidden) return;
    const area = event.target instanceof window.Element ? (event.target as Element).closest<HTMLElement>(selector) : null;
    if (!area || !root.contains(area)) return;
    if (event.ctrlKey || event.shiftKey || !isCoarseVerticalWheel(event)) { stop(area); return; }
    const max = Math.max(0, area.scrollHeight - area.clientHeight);
    if (max <= 1) return;
    const unit = event.deltaMode === 1 ? SCROLL_MOTION.linePixels : event.deltaMode === 2 ? area.clientHeight : 1;
    const running = motions.get(area);
    const target = clamp((running?.target ?? area.scrollTop) + event.deltaY * unit, 0, max);
    // Keep nested list ownership even at a boundary, without starting idle frames.
    event.preventDefault();
    if (running) { running.target = target; running.handle?.retarget(target); return; }
    if (target === area.scrollTop) return;
    const motion = { target, written: area.scrollTop, handle: null as AnimationHandle | null };
    const handle = animateValue({ from: area.scrollTop, to: target, spring: SPRING_PRESETS.snappy,
      onUpdate: value => {
        area.scrollTop = clamp(value, 0, Math.max(0, area.scrollHeight - area.clientHeight));
        motion.written = area.scrollTop;
      },
      onComplete: () => motions.delete(area),
    });
    motion.handle = handle;
    motions.set(area, motion);
  };
  const scroll = (event: Event) => {
    const area = event.target as HTMLElement, motion = motions.get(area);
    // Native scrolling, scrollbar dragging and history restoration take control.
    if (motion && Math.abs(area.scrollTop - motion.written) > 0.01) stop(area);
  };
  const hidden = () => { if (document.hidden) stopAll(); };
  root.addEventListener("wheel", wheel, { passive: false });
  root.addEventListener("scroll", scroll, true);
  root.addEventListener("pointerdown", stopAll, true);
  root.addEventListener("keydown", stopAll, true);
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("blur", stopAll);
  window.addEventListener("resize", stopAll);
  return () => {
    stopAll();
    root.removeEventListener("wheel", wheel);
    root.removeEventListener("scroll", scroll, true);
    root.removeEventListener("pointerdown", stopAll, true);
    root.removeEventListener("keydown", stopAll, true);
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("blur", stopAll);
    window.removeEventListener("resize", stopAll);
  };
}
