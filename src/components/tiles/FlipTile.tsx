import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { animateValue } from "../../motion/animate";
import { useReducedMotion } from "../../motion/useReducedMotion";
import { Tile } from "./Tile";
import type { TileSize } from "./Tile";

const FLIP_HALF_MS = 200;
const MIN_INTERVAL_MS = 6_000;
const MAX_INTERVAL_MS = 14_000;

function nextDelay(): number {
  return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

/**
 * WP7 flip tile: a front and back face that periodically trade places with a
 * restrained half-flip, signalling "content updated" rather than decorating.
 * Each instance picks its own jittered cadence so a wall of tiles drifts out
 * of phase instead of flipping in lockstep.
 *
 * Under reduced motion the faces cross-fade (opacity only), never rotate.
 */
export function FlipTile({
  size = "medium",
  className = "",
  glass = false,
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
  glass?: boolean;
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

  useEffect(() => {
    if (paused) return undefined;
    let timer: number | undefined;
    let cancelled = false;

    const schedule = () => {
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
      animateValue({
        from: 0,
        to: 90,
        tween: { durationMs: FLIP_HALF_MS, easing: easeInOut },
        onUpdate: (value) => {
          surface.style.setProperty("--tile-flip", `${value.toFixed(2)}deg`);
        },
        onComplete: () => {
          setShowBack((value) => !value);
          animateValue({
            from: 90,
            to: 0,
            tween: { durationMs: FLIP_HALF_MS, easing: easeInOut },
            onUpdate: (value) => {
              surface.style.setProperty("--tile-flip", `${value.toFixed(2)}deg`);
            },
            onComplete: () => {
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
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [paused, reducedMotion]);

  return (
    <Tile
      size={size}
      className={`tile-flip ${showBack ? "is-back" : "is-front"} ${className}`.trim()}
      glass={glass}
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

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
