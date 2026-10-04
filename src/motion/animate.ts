import { advanceSpring, createSpring, springSettled } from "./spring.js";
import type { SpringPreset, SpringState } from "./spring.js";

export interface TweenSpec {
  durationMs: number;
  easing: (t: number) => number;
}

export interface AnimateValueOptions {
  from: number;
  to: number;
  spring?: SpringPreset;
  /** Initial spring speed in units per second, for gesture release continuity. */
  velocity?: number;
  tween?: TweenSpec;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
}

export interface AnimationHandle {
  cancel(): void;
  retarget(to: number): void;
}

type AnimationClock = () => number;
type AnimationRaf = (callback: (time: number) => void) => void;

const defaultClock: AnimationClock = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const defaultRaf: AnimationRaf = (callback) => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
    return;
  }
  setTimeout(() => callback(defaultClock()), 16);
};

let activeClock: AnimationClock = defaultClock;
let activeRaf: AnimationRaf = defaultRaf;

// All running animations share this one rAF loop; the loop stops as soon as
// the last animation finishes so an idle app never spins frames.
const activeAnimations = new Set<AnimationEntry>();
let loopScheduled = false;

/** Test hook: swap the time source and scheduler (node has no rAF). */
export function _setAnimationClockForTesting(now: AnimationClock, raf: AnimationRaf): void {
  activeClock = now;
  activeRaf = raf;
  // A swapped-in scheduler knows nothing about ticks queued on the old one.
  loopScheduled = false;
}

export function _resetAnimationClockForTesting(): void {
  activeClock = defaultClock;
  activeRaf = defaultRaf;
  loopScheduled = false;
}

interface AnimationEntry {
  target: number;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
  lastValue: number;
  springPreset: SpringPreset | null;
  springState: SpringState | null;
  lastFrameTime: number;
  tween: TweenSpec | null;
  tweenFrom: number;
  tweenStart: number;
}

function scheduleLoop(): void {
  if (loopScheduled) return;
  loopScheduled = true;
  activeRaf(tick);
}

function tick(frameTime: number): void {
  const now = Number.isFinite(frameTime) ? frameTime : activeClock();
  for (const entry of Array.from(activeAnimations)) {
    stepAnimation(entry, now);
  }
  if (activeAnimations.size > 0) {
    activeRaf(tick);
  } else {
    loopScheduled = false;
  }
}

function stepAnimation(entry: AnimationEntry, now: number): void {
  if (entry.springState && entry.springPreset) {
    const dt = now - entry.lastFrameTime;
    entry.lastFrameTime = now;
    entry.springState = advanceSpring(entry.springState, entry.springPreset, entry.target, dt);
    entry.lastValue = entry.springState.value;
    if (springSettled(entry.springState, entry.target)) {
      activeAnimations.delete(entry);
      entry.onUpdate(entry.target);
      entry.onComplete?.();
      return;
    }
    entry.onUpdate(entry.springState.value);
    return;
  }
  const { tween } = entry;
  if (!tween) return;
  const elapsed = now - entry.tweenStart;
  const progress = tween.durationMs <= 0 ? 1 : Math.min(1, elapsed / tween.durationMs);
  entry.lastValue = entry.tweenFrom + (entry.target - entry.tweenFrom) * tween.easing(progress);
  if (progress >= 1) {
    activeAnimations.delete(entry);
    entry.onUpdate(entry.target);
    entry.onComplete?.();
    return;
  }
  entry.onUpdate(entry.lastValue);
}

/**
 * Animates a scalar towards `to`, driven either by a spring (physical,
 * interruptible) or a tween (fixed duration + easing). Springs take
 * precedence when both are given. `onUpdate` fires synchronously once with
 * `from`, then on every frame; `onComplete` fires once the value settles
 * exactly on `to`. Never fires after `cancel()`.
 */
export function animateValue(options: AnimateValueOptions): AnimationHandle {
  const useSpring = options.spring !== undefined;
  const startedAt = activeClock();
  const entry: AnimationEntry = {
    target: options.to,
    onUpdate: options.onUpdate,
    onComplete: options.onComplete,
    lastValue: options.from,
    springPreset: options.spring ?? null,
    springState: useSpring ? { ...createSpring(options.from), velocity: options.velocity ?? 0 } : null,
    lastFrameTime: startedAt,
    tween: useSpring ? null : options.tween ?? { durationMs: 0, easing: (t) => t },
    tweenFrom: options.from,
    tweenStart: startedAt,
  };
  activeAnimations.add(entry);
  scheduleLoop();
  options.onUpdate(options.from);
  return {
    cancel() {
      activeAnimations.delete(entry);
    },
    retarget(to: number) {
      if (!activeAnimations.has(entry)) return;
      if (entry.springState && entry.springPreset) {
        // Fold the time since the last frame into the spring before changing
        // targets: a burst of retargets between two frames (e.g. wheel ticks)
        // must still integrate the full elapsed time, not discard it with a
        // clock reset. The carried velocity keeps the inertia hand-off.
        const now = activeClock();
        entry.springState = advanceSpring(entry.springState, entry.springPreset, entry.target, now - entry.lastFrameTime);
        entry.lastValue = entry.springState.value;
        entry.lastFrameTime = now;
        entry.target = to;
        return;
      }
      entry.target = to;
      // Tweens cannot carry velocity; restart from the current value.
      entry.tweenFrom = entry.lastValue;
      entry.tweenStart = activeClock();
    },
  };
}
