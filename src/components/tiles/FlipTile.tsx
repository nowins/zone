import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { animateValue } from "../../motion/animate";
import type { AnimationHandle } from "../../motion/animate";
import { TILE_MOTION } from "../../motion/tokens";
import { scheduleTileUpdate } from "../../motion/tileScheduler";
import { cubicBezier } from "../../motion/tween";
import { easeInCubic as accelerate, easeOutCubic as decelerate } from "../../motion/math";
import { useTileActivity } from "./useTileActivity";
import { useReducedMotion } from "../../motion/useReducedMotion";
import { Tile } from "./Tile";
import type { TileSize } from "./Tile";

/** How a live tile reveals its back layer. */
export type TileRevealVariant = "peek" | "flip";

const metroSlideIn = cubicBezier(...TILE_MOTION.peekEasing);
const nextDelay = (first = false) => {
  const min = first ? TILE_MOTION.firstMin : TILE_MOTION.intervalMin;
  const max = first ? TILE_MOTION.firstMax : TILE_MOTION.intervalMax;
  return min + Math.random() * (max - min);
};

/** Live information reveals, dwells, then returns; each tile has its own cadence. */
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
  /** Edit-mode pins render as a div so the article can own pointer dragging. */
  asButton?: boolean;
}) {
  const [showBack, setShowBack] = useState(false);
  const reducedMotion = useReducedMotion();
  const backRef = useRef<HTMLDivElement | null>(null);
  const frontRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const { active, visible } = useTileActivity(surfaceRef, asButton);
  const activeRef = useRef(active);
  activeRef.current = active;
  const activityChangeRef = useRef<(() => void) | null>(null);
  const revealingRef = useRef(false);
  const animationRef = useRef<AnimationHandle | null>(null);
  const hasUpdatedRef = useRef(false);

  useEffect(() => {
    if (paused || !live || !visible || reducedMotion) {
      setShowBack(false);
      return undefined;
    }
    let cancelSchedule: (() => void) | undefined;
    let holdTimer: number | undefined;
    let holdRemaining: number = TILE_MOTION.hold;
    let holdDeadline = 0;
    let phase: "waiting" | "revealing" | "holding" | "returning" = "waiting";
    let cancelled = false;
    // Direction state lives in the closure, not React state: flipping state
    // used to re-run this effect and the cleanup parked the back layer
    // mid-cycle, which is why the live info never stayed visible.
    let showingBack = false;

    // Peek carries the outgoing and incoming panels along a shared progress.
    const setProgress = (value: number) => {
      backRef.current?.style.setProperty("--tile-peek", `${((1 - value) * 100).toFixed(2)}%`);
      frontRef.current?.style.setProperty("--tile-peek-front", `${(-value * 100).toFixed(2)}%`);
    };
    // Flip driver: rotation angle of the whole surface around the X axis.
    const setAngle = (value: number) => {
      surfaceRef.current?.style.setProperty("--tile-flip", `${value.toFixed(2)}deg`);
    };

    const schedule = (first = false) => {
      if (cancelled) return;
      if (!activeRef.current || cancelSchedule) return;
      cancelSchedule = scheduleTileUpdate(nextDelay(first), runCycle);
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
          tween: { durationMs: TILE_MOTION.flipHalf, easing: accelerate },
          onUpdate: setAngle,
          onComplete: () => {
            if (cancelled) return;
            showingBack = to === 180;
            setShowBack(showingBack);
            animationRef.current = animateValue({
              from: apex,
              to,
              tween: { durationMs: TILE_MOTION.flipHalf, easing: decelerate },
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
        tween: { durationMs: TILE_MOTION.peek, easing: metroSlideIn },
        onUpdate: setProgress,
        onComplete: () => {
          if (cancelled) return;
          finishTo(to === 1, onDone);
        },
      });
    };

    let finishCycle: (() => void) | undefined;
    const armHold = () => {
      if (cancelled || !activeRef.current || phase !== "holding" || holdTimer !== undefined) return;
      holdDeadline = window.performance.now() + holdRemaining;
      holdTimer = window.setTimeout(() => {
        holdTimer = undefined;
        if (cancelled) return;
        phase = "returning";
        revealTo(0, () => {
          phase = "waiting";
          revealingRef.current = false;
          cancelSchedule = undefined;
          finishCycle?.();
          finishCycle = undefined;
          schedule();
        });
      }, holdRemaining);
    };

    // Interaction preserves the displayed face; visibility/editing still reset it.
    // A turn already in flight settles before waiting, avoiding an edge-on freeze.
    const updateActivity = () => {
      if (activeRef.current) {
        if (phase === "waiting") schedule(!hasUpdatedRef.current);
        else armHold();
        return;
      }
      if (phase === "waiting") {
        cancelSchedule?.();
        cancelSchedule = undefined;
      } else if (phase === "holding" && holdTimer !== undefined) {
        holdRemaining = Math.max(0, holdDeadline - window.performance.now());
        window.clearTimeout(holdTimer);
        holdTimer = undefined;
      }
    };
    activityChangeRef.current = updateActivity;

    const runCycle = (done: () => void) => {
      if (cancelled || !activeRef.current || revealingRef.current) {
        done();
        cancelSchedule = undefined;
        schedule();
        return;
      }
      finishCycle = done;
      revealingRef.current = true;
      hasUpdatedRef.current = true;
      phase = "revealing";
      // One full cycle: slide up, hold so the live line is readable, slide
      // away, then schedule the next cycle.
      revealTo(variant === "flip" ? 180 : 1, () => {
        phase = "holding";
        holdRemaining = TILE_MOTION.hold;
        armHold();
      });
    };

    schedule(!hasUpdatedRef.current);
    return () => {
      cancelled = true;
      activityChangeRef.current = null;
      revealingRef.current = false;
      cancelSchedule?.();
      if (holdTimer !== undefined) window.clearTimeout(holdTimer);
      animationRef.current?.cancel();
      animationRef.current = null;
      setProgress(0);
      setAngle(0);
      setShowBack(false);
    };
  }, [paused, live, visible, reducedMotion, variant]);

  useEffect(() => { activityChangeRef.current?.(); }, [active]);

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
        <div ref={frontRef} className="tile-face tile-face-front" aria-hidden={showBack}>
          {front}
        </div>
        <div ref={backRef} className="tile-face tile-face-back" aria-hidden={!showBack}>
          {back}
        </div>
      </div>
    </Tile>
  );
}
