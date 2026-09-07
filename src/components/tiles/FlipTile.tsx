import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { animateValue } from "../../motion/animate";
import type { AnimationHandle } from "../../motion/animate";
import { TILE_MOTION } from "../../motion/tokens";
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
  /** Edit-mode pins render as a div so the article can own HTML5 drag. */
  asButton?: boolean;
}) {
  const [showBack, setShowBack] = useState(false);
  const reducedMotion = useReducedMotion();
  const backRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const active = useTileActivity(surfaceRef, asButton);
  const revealingRef = useRef(false);
  const animationRef = useRef<AnimationHandle | null>(null);

  useEffect(() => {
    if (paused || !live || !active || reducedMotion) {
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

    const schedule = (first = false) => {
      if (cancelled) return;
      timer = window.setTimeout(runCycle, nextDelay(first));
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

    const runCycle = () => {
      if (cancelled || revealingRef.current) {
        schedule();
        return;
      }
      revealingRef.current = true;
      // One full cycle: slide up, hold so the live line is readable, slide
      // away, then schedule the next cycle.
      revealTo(variant === "flip" ? 180 : 1, () => {
        holdTimer = window.setTimeout(() => {
          if (cancelled) return;
          revealTo(0, () => {
            revealingRef.current = false;
            schedule();
          });
        }, TILE_MOTION.hold);
      });
    };

    schedule(true);
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
  }, [paused, live, active, reducedMotion, variant]);

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
