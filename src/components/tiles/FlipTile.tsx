import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { animateValue } from "../../motion/animate";
import type { AnimationHandle } from "../../motion/animate";
import { TILE_MOTION } from "../../motion/tokens";
import { scheduleTileUpdate } from "../../motion/tileScheduler";
import { cubicBezier } from "../../motion/tween";
import { easeInOutCubic } from "../../motion/math";
import { useTileActivity } from "./useTileActivity";
import { useReducedMotion } from "../../motion/useReducedMotion";
import { Tile } from "./Tile";
import type { TileSize } from "./Tile";
import { frameReady } from "./tileFrames";

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
  const [faces, setFaces] = useState({ front, back });
  const latestFacesRef = useRef({ front, back });
  latestFacesRef.current = { front, back };
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

  useLayoutEffect(() => {
    if (!revealingRef.current) setFaces({ front, back });
  }, [front, back]);

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
    const setProgress = (value: number, returning = false) => {
      backRef.current?.style.setProperty("--tile-peek", `${((returning ? -value : 1 - value) * 100).toFixed(2)}%`);
      frontRef.current?.style.setProperty("--tile-peek-front", `${((returning ? 1 - value : -value) * 100).toFixed(2)}%`);
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

    // Peek keeps moving upward; the hidden front wraps below the back.
    // Flip uses one clock across the edge instead of restarting at 90 degrees.
    const revealTo = (to: number, onDone: () => void) => {
      if (variant === "flip") {
        const from = showingBack ? 180 : 0;
        let crossed = false;
        animationRef.current = animateValue({
          from,
          to,
          tween: { durationMs: TILE_MOTION.flipHalf * 2, easing: easeInOutCubic },
          onUpdate: value => {
            setAngle(value);
            if (!crossed && Math.abs(value - from) >= 90) {
              crossed = true;
              setShowBack(to === 180);
            }
          },
          onComplete: () => { if (!cancelled) finishTo(to === 180, onDone); },
        });
        return;
      }
      const returning = showingBack;
      animationRef.current = animateValue({
        from: 0,
        to: 1,
        tween: { durationMs: TILE_MOTION.peek, easing: metroSlideIn },
        onUpdate: value => setProgress(value, returning),
        onComplete: () => {
          if (cancelled) return;
          if (returning) setProgress(0);
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
        // The front is hidden here. Capture the return target before moving it.
        setFaces(current => ({ ...current, front: latestFacesRef.current.front }));
        revealTo(0, () => {
          phase = "waiting";
          revealingRef.current = false;
          // Prepare the next back only after it is fully hidden.
          setFaces(current => ({ ...current, back: latestFacesRef.current.back }));
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
      if (cancelled || !activeRef.current || revealingRef.current || !frameReady(backRef.current)) {
        done();
        cancelSchedule = undefined;
        schedule();
        return;
      }
      finishCycle = done;
      revealingRef.current = true;
      // Freeze the outgoing panel and capture the incoming content for this turn.
      setFaces(current => ({ ...current, back: latestFacesRef.current.back }));
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
      setFaces(latestFacesRef.current);
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
          {faces.front}
        </div>
        <div ref={backRef} className="tile-face tile-face-back" aria-hidden={!showBack}>
          {faces.back}
        </div>
      </div>
    </Tile>
  );
}
