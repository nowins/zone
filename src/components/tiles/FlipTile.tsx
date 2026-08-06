import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { animateValue } from "../../motion/animate";
import type { AnimationHandle } from "../../motion/animate";
import { MOTION_DURATIONS } from "../../motion/tokens";
import { useReducedMotion } from "../../motion/useReducedMotion";
import { Tile } from "./Tile";
import type { TileSize } from "./Tile";

// Total flip is split across the apex; each half stays well inside the
// sub-260ms content tier so the whole reveal lands under the WP budget.
const FLIP_HALF_MS = Math.round(MOTION_DURATIONS.content / 2);
const MIN_INTERVAL_MS = 6_000;
const MAX_INTERVAL_MS = 14_000;

function nextDelay(): number {
  return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

/**
 * WP7 flip tile: a front and back face that periodically trade places with a
 * restrained flip, signalling "content updated" rather than decorating. The
 * surface rotates 0° -> 180°; the front is visible for the first half and the
 * back for the second (each backface-hidden), so neither face is ever culled
 * at rest. Motion is a single physical sweep — accelerating into the apex,
 * easing out as it lands — not two soft halves.
 *
 * Each instance picks its own jittered cadence so a wall drifts out of phase
 * instead of flipping in lockstep. Under reduced motion the faces cross-fade
 * (opacity only), never rotate.
 */
export function FlipTile({
  size = "medium",
  className = "",
  front,
  back,
  onPress,
  onContextMenu,
  onKeyDown,
  title,
  paused = false,
  disabled = false,
}: {
  size?: TileSize;
  className?: string;
  front: ReactNode;
  back: ReactNode;
  onPress?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  title?: string;
  paused?: boolean;
  disabled?: boolean;
}) {
  const [showBack, setShowBack] = useState(false);
  const reducedMotion = useReducedMotion();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const flippingRef = useRef(false);
  const animationRef = useRef<AnimationHandle | null>(null);

  useEffect(() => {
    if (paused) return undefined;
    let timer: number | undefined;
    let cancelled = false;

    const setAngle = (value: number) => {
      surfaceRef.current?.style.setProperty("--tile-flip", `${value.toFixed(2)}deg`);
    };

    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(runFlip, nextDelay());
    };

    const runFlip = () => {
      if (cancelled || flippingRef.current) {
        schedule();
        return;
      }
      flippingRef.current = true;
      const surface = surfaceRef.current;
      if (!surface || reducedMotion) {
        setShowBack((value) => !value);
        flippingRef.current = false;
        schedule();
        return;
      }
      const from = showBack ? 180 : 0;
      const to = showBack ? 0 : 180;
      const apex = (from + to) / 2;
      // Accelerate into the apex, swap faces, then ease out to landing.
      animationRef.current = animateValue({
        from,
        to: apex,
        tween: { durationMs: FLIP_HALF_MS, easing: accelerate },
        onUpdate: setAngle,
        onComplete: () => {
          if (cancelled) return;
          setShowBack((value) => !value);
          animationRef.current = animateValue({
            from: apex,
            to,
            tween: { durationMs: FLIP_HALF_MS, easing: decelerate },
            onUpdate: setAngle,
            onComplete: () => {
              if (cancelled) return;
              flippingRef.current = false;
              schedule();
            },
          });
        },
      });
    };

    schedule();
    return () => {
      cancelled = true;
      flippingRef.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
      animationRef.current?.cancel();
      animationRef.current = null;
      setAngle(0);
    };
  }, [paused, reducedMotion, showBack]);

  return (
    <Tile
      size={size}
      className={`tile-flip ${showBack ? "is-back" : "is-front"} ${className}`.trim()}
      onPress={onPress}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      title={title}
      disabled={disabled}
    >
      <div ref={surfaceRef} className="tile-flip-surface">
        <div className="tile-face tile-face-front" aria-hidden={showBack}>
          {front}
        </div>
        <div className="tile-face tile-face-back" aria-hidden={!showBack}>
          {back}
        </div>
      </div>
    </Tile>
  );
}

// First half: ease in so the edge accelerates toward the viewer.
function accelerate(t: number): number {
  return t * t * t;
}
// Second half: ease out so the new face lands crisply.
function decelerate(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
