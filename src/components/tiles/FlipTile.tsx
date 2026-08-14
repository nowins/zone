import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { animateValue } from "../../motion/animate";
import type { AnimationHandle } from "../../motion/animate";
import { useReducedMotion } from "../../motion/useReducedMotion";
import { Tile } from "./Tile";
import type { TileSize } from "./Tile";

/** How a live tile reveals its back layer. */
export type TileRevealVariant = "peek" | "flip";

// Live tiles flip sparingly and only when there's something to glance at —
// tens of seconds to minutes, like WP, not a constant blink.
const MIN_INTERVAL_MS = 45_000;
const MAX_INTERVAL_MS = 110_000;
// Peek reveal duration and curve, taken from MangoTile's Lumia frame-count
// calibration (MetroSlideInMillis / MetroSlideInEasing): 600ms with a small
// ease-in so the back layer reads as *pushed* into view, not a jump cut.
const PEEK_MS = 600;
// The back layer must actually dwell so the live line can be read; the old
// state machine never held it visible at all.
const PEEK_HOLD_MS = 4_500;
// Flip variant: two physical half-sweeps across the apex, quicker than the
// peek slide — WP7 People-hub squares flip briskly.
const FLIP_HALF_MS = 200;

function nextDelay(): number {
  return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

/**
 * Live tile with a back (live info) layer and two reveal variants:
 * - "peek" (default, wide tiles): the back slides up from the bottom edge to
 *   cover the front — the official WP8 peek-template mechanism.
 * - "flip" (square tiles): the tile card-flips around its horizontal axis to
 *   the back, like WP7 People-hub squares.
 *
 * Both share one state machine: reveal, dwell so the live line is readable,
 * return, then wait a jittered 45-110s before the next cycle. Direction state
 * lives in the effect closure, never in React deps. Under reduced motion the
 * faces cross-fade in place instead.
 *
 * Each instance picks its own jittered cadence so a wall drifts out of phase
 * instead of revealing in lockstep.
 */
export function FlipTile({
  size = "medium",
  className = "",
  variant = "peek",
  front,
  back,
  onPress,
  onContextMenu,
  onKeyDown,
  title,
  paused = false,
  disabled = false,
  live = true,
  asButton = true,
}: {
  size?: TileSize;
  className?: string;
  /** Reveal style: "peek" slides the back up (wide tiles), "flip" card-flips (square tiles). */
  variant?: TileRevealVariant;
  front: ReactNode;
  back: ReactNode;
  onPress?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  title?: string;
  paused?: boolean;
  disabled?: boolean;
  /** When false the tile never flips on its own (nothing live to reveal). */
  live?: boolean;
  /** Edit-mode pins render as a div so the article can own HTML5 drag. */
  asButton?: boolean;
}) {
  const [showBack, setShowBack] = useState(false);
  const reducedMotion = useReducedMotion();
  const backRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const revealingRef = useRef(false);
  const animationRef = useRef<AnimationHandle | null>(null);

  useEffect(() => {
    if (paused || !live) {
      setShowBack(false);
      return undefined;
    }
    let timer: number | undefined;
    let holdTimer: number | undefined;
    let cancelled = false;
    // Direction state lives in the closure, not React state: flipping state
    // used to re-run this effect and the cleanup parked the back layer
    // mid-cycle, which is why the live info never stayed visible.
    let showingBack = false;

    // Peek driver: progress 0..1 -> back layer offset in % of tile height
    // (100% = hidden below the tile, 0% = fully covering the front).
    const setProgress = (value: number) => {
      backRef.current?.style.setProperty("--tile-peek", `${((1 - value) * 100).toFixed(2)}%`);
    };
    // Flip driver: rotation angle of the whole surface around the X axis.
    const setAngle = (value: number) => {
      surfaceRef.current?.style.setProperty("--tile-flip", `${value.toFixed(2)}deg`);
    };

    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(runCycle, nextDelay());
    };

    const finishTo = (shown: boolean, onDone: () => void) => {
      showingBack = shown;
      setShowBack(shown);
      onDone();
    };

    // Peek: slide the back layer to `to` (1 = covering, 0 = parked), starting
    // from the layer's actual current position so no frame ever snaps.
    // Flip: rotate the surface 0<->180, swapping faces at the apex.
    const revealTo = (to: number, onDone: () => void) => {
      if (variant === "flip") {
        const from = showingBack ? 180 : 0;
        const apex = (from + to) / 2;
        animationRef.current = animateValue({
          from,
          to: apex,
          tween: { durationMs: FLIP_HALF_MS, easing: accelerate },
          onUpdate: setAngle,
          onComplete: () => {
            if (cancelled) return;
            showingBack = to === 180;
            setShowBack(showingBack);
            animationRef.current = animateValue({
              from: apex,
              to,
              tween: { durationMs: FLIP_HALF_MS, easing: decelerate },
              onUpdate: setAngle,
              onComplete: () => {
                if (cancelled) return;
                onDone();
              },
            });
          },
        });
        return;
      }
      animationRef.current = animateValue({
        from: showingBack ? 1 : 0,
        to,
        tween: { durationMs: PEEK_MS, easing: metroSlideIn },
        onUpdate: setProgress,
        onComplete: () => {
          if (cancelled) return;
          finishTo(to === 1, onDone);
        },
      });
    };

    const runCycle = () => {
      if (cancelled || revealingRef.current) {
        schedule();
        return;
      }
      revealingRef.current = true;
      // Reduced motion: swap faces in place (CSS cross-fades), same dwell.
      if (reducedMotion) {
        showingBack = true;
        setShowBack(true);
        holdTimer = window.setTimeout(() => {
          if (cancelled) return;
          showingBack = false;
          setShowBack(false);
          revealingRef.current = false;
          schedule();
        }, PEEK_HOLD_MS);
        return;
      }
      // One full cycle: slide up, hold so the live line is readable, slide
      // away, then schedule the next cycle.
      revealTo(variant === "flip" ? 180 : 1, () => {
        holdTimer = window.setTimeout(() => {
          if (cancelled) return;
          revealTo(0, () => {
            revealingRef.current = false;
            schedule();
          });
        }, PEEK_HOLD_MS);
      });
    };

    schedule();
    return () => {
      cancelled = true;
      revealingRef.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
      if (holdTimer !== undefined) window.clearTimeout(holdTimer);
      animationRef.current?.cancel();
      animationRef.current = null;
      setProgress(0);
      setAngle(0);
      setShowBack(false);
    };
  }, [paused, live, reducedMotion, variant]);

  return (
    <Tile
      size={size}
      className={`tile-flip tile-flip-v-${variant} ${showBack ? "is-back" : "is-front"} ${className}`.trim()}
      onPress={onPress}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      title={title}
      disabled={disabled}
      asButton={asButton}
    >
      <div ref={surfaceRef} className="tile-flip-surface">
        <div className="tile-face tile-face-front" aria-hidden={showBack}>
          {front}
        </div>
        <div ref={backRef} className="tile-face tile-face-back" aria-hidden={!showBack}>
          {back}
        </div>
      </div>
    </Tile>
  );
}

// MangoTile MetroSlideInEasing: cubic-bezier(0.22, 0, 0.05, 1).
function metroSlideIn(t: number): number {
  return cubicBezier(0.22, 0, 0.05, 1, t);
}

// Flip first half: ease in so the edge accelerates toward the apex.
function accelerate(t: number): number {
  return t * t * t;
}
// Flip second half: ease out so the new face lands crisply.
function decelerate(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// Evaluate a cubic-bezier easing curve at progress t (x), solving for y.
function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  // Newton-Raphson to find the curve parameter for the given x.
  let u = t;
  for (let i = 0; i < 6; i += 1) {
    const x = sampleX(u) - t;
    if (Math.abs(x) < 1e-5) break;
    const d = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(d) < 1e-5) break;
    u -= x / d;
  }
  return sampleY(u);
}
