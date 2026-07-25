import { animateValue } from "./animate.js";
import type { AnimationHandle } from "./animate.js";
import { computeFlipDelta } from "./flip.js";
import type { FlipRect } from "./flip.js";
import { SPRING_PRESETS } from "./tokens.js";

/**
 * Shared-element cover flight between the player bar / quickplay feature
 * cover and the now-playing track card (the WP7 continuity gesture). The
 * outgoing view registers the cover's viewport rect under `cover:{trackId}`
 * (see `flip.ts`); the incoming view takes that rect and calls
 * `playCoverFlip`, which hides the real cover, flies a fixed-position clone
 * from the registered spot, optionally docks it through the target's own
 * entrance choreography, then hands back. All DOM work lives here; the views
 * only register, take, and invoke.
 */

export interface CoverFlipOptions {
  /** Where the cover was last seen, in viewport coordinates. */
  source: FlipRect;
  /** Real cover element in the incoming view; hidden while the clone flies. */
  target: HTMLElement;
  /** Ready-to-render cover URL (already passed through `convertFileSrc`). */
  imageSrc: string;
  /**
   * Optional dock period after landing: the clone stays parked on the target
   * and follows it (the now-playing card still drifts during its delayed
   * entrance) until this promise resolves. Must be bounded by the caller.
   */
  holdUntil?: () => Promise<void>;
  /**
   * Optional early reveal: once this promise resolves, the real cover becomes
   * visible again underneath the parked clone, so its outline/shadow fade in
   * with the owning surface instead of popping at the hand-off.
   */
  revealTargetWhen?: () => Promise<void>;
  /**
   * Called once when the spring has fully settled on the target. Lets the
   * caller hold the target's own entrance until the cover truly rests, so
   * the outline/text never appear around a still-moving cover.
   */
  onDocked?: () => void;
}

export interface CoverFlipHandle {
  /** Stops the flight, removes the clone, restores the real cover. Idempotent. */
  cancel(): void;
}

// Above the context menu (40) and the action toast (55) so the flight never
// slips under transient chrome.
const CLONE_Z_INDEX = "60";

function viewportRect(element: HTMLElement): FlipRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Flies a cover clone from `source` onto `target` with a snappy spring
 * (restrained overshoot on landing). Returns a handle whose `cancel()` is
 * idempotent and also runs automatically once the flight — and the optional
 * dock period — has finished.
 */
export function playCoverFlip(options: CoverFlipOptions): CoverFlipHandle {
  const { source, target, imageSrc } = options;
  const flightTarget = viewportRect(target);
  if (
    source.width <= 0 || source.height <= 0 ||
    flightTarget.width <= 0 || flightTarget.height <= 0
  ) {
    return { cancel() {} };
  }

  const previousVisibility = target.style.visibility;
  target.style.visibility = "hidden";

  const clone = document.createElement("img");
  clone.src = imageSrc;
  clone.alt = "";
  clone.draggable = false;
  clone.setAttribute("aria-hidden", "true");
  const { style } = clone;
  style.position = "fixed";
  style.left = `${source.x}px`;
  style.top = `${source.y}px`;
  style.width = `${source.width}px`;
  style.height = `${source.height}px`;
  style.margin = "0";
  style.objectFit = "cover";
  style.pointerEvents = "none";
  style.zIndex = CLONE_Z_INDEX;
  style.transformOrigin = "center";
  style.willChange = "transform, filter";
  style.borderRadius = getComputedStyle(target).borderRadius;
  document.body.appendChild(clone);

  // The clone is laid out at the source rect, so the transform that carries
  // it onto the target is computeFlipDelta(dock, source); progress t
  // interpolates from identity, and the spring may overshoot past 1 for a
  // restrained landing. The dock rect is re-measured on every write instead
  // of frozen at call time: a first-frame layout transient (the just-mounted
  // view can report a stale rect) would otherwise bake into the flight and
  // snap visibly when the dock loop later re-glued to the live rect. Early
  // frames weight the correction by a tiny t, so the path simply bends.
  function writeTransform(t: number, dock: FlipRect) {
    const delta = computeFlipDelta(dock, source);
    const scaleX = 1 + (delta.scaleX - 1) * t;
    const scaleY = 1 + (delta.scaleY - 1) * t;
    style.transform = `translate3d(${delta.dx * t}px, ${delta.dy * t}px, 0) scale(${scaleX}, ${scaleY})`;
    writeMotionBlur(delta, t);
  }

  // Cheap motion blur: the spring's peak stride is tens of px per frame at
  // 60Hz, which reads as stepping; a velocity-proportional blur smears those
  // steps and decays to nothing as the cover settles. Computed from the
  // frame-to-frame center displacement so it also covers the dock follow.
  let lastCenter: { x: number; y: number; at: number } | null = null;
  let lastBlur = 0;

  function writeMotionBlur(delta: { dx: number; dy: number }, t: number) {
    const now = performance.now();
    const cx = source.x + source.width / 2 + delta.dx * t;
    const cy = source.y + source.height / 2 + delta.dy * t;
    if (lastCenter && now > lastCenter.at) {
      const speed = Math.hypot(cx - lastCenter.x, cy - lastCenter.y) / (now - lastCenter.at);
      const target = Math.min(12, speed * 4);
      // Asymmetric decay keeps the release from popping to sharpness.
      lastBlur = Math.max(target, lastBlur * 0.82);
      style.filter = lastBlur > 0.4 ? `blur(${lastBlur.toFixed(1)}px)` : "";
    }
    lastCenter = { x: cx, y: cy, at: now };
  }

  let cancelled = false;
  let followRaf = 0;
  let animation: AnimationHandle | null = null;

  function restoreTarget() {
    target.style.visibility = previousVisibility;
  }

  function finish() {
    if (cancelled) return;
    cancelled = true;
    animation?.cancel();
    if (followRaf) window.cancelAnimationFrame(followRaf);
    clone.remove();
    restoreTarget();
  }

  function startDock() {
    if (cancelled) return;
    options.onDocked?.();
    if (!options.holdUntil) {
      finish();
      return;
    }
    // The target can keep moving after the landing (the card's delayed
    // entrance rise), so re-measure every frame to keep the clone glued on.
    const follow = () => {
      if (cancelled) return;
      writeTransform(1, viewportRect(target));
      followRaf = window.requestAnimationFrame(follow);
    };
    followRaf = window.requestAnimationFrame(follow);
  }

  // Don't fly a blank frame: on a cold cache (first app launch) the clone
  // image can take hundreds of ms to decode, which would render the whole
  // flight invisible. Hold the spring until the image is ready, bounded by a
  // timeout so a broken image can never stall the entrance.
  const flightReady = Promise.race([
    clone.decode().catch(() => undefined),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, 400);
    }),
  ]);
  void flightReady.then(() => {
    if (cancelled) return;
    animation = animateValue({
      from: 0,
      to: 1,
      spring: SPRING_PRESETS.snappy,
      onUpdate: (t) => writeTransform(t, viewportRect(target)),
      onComplete: startDock,
    });
  });

  if (options.revealTargetWhen) {
    Promise.resolve()
      .then(options.revealTargetWhen)
      .then(() => {
        if (!cancelled) restoreTarget();
      });
  }
  if (options.holdUntil) {
    Promise.resolve().then(options.holdUntil).then(finish, finish);
  }

  return { cancel: finish };
}
