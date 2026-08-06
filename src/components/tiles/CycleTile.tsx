import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useReducedMotion } from "../../motion/useReducedMotion";
import { Tile } from "./Tile";
import type { TileSize } from "./Tile";

const CYCLE_INTERVAL_MS = 5_000;
const MAX_CYCLE_IMAGES = 9;

/**
 * WP8 cycle tile: rotates slowly through up to nine images with a gentle
 * cross-fade, staying restrained and content-driven. Under reduced motion the
 * current image simply swaps without a fade. Cadence is jittered per instance
 * so a wall of cycle tiles does not switch in lockstep.
 */
export function CycleTile({
  size = "medium",
  className = "",
  images,
  overlay,
  onPress,
  onContextMenu,
  onKeyDown,
  title,
  disabled = false,
}: {
  size?: TileSize;
  className?: string;
  images: ReactNode[];
  overlay?: ReactNode;
  onPress?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  title?: string;
  disabled?: boolean;
}) {
  const frames = images.slice(0, MAX_CYCLE_IMAGES);
  const [index, setIndex] = useState(0);
  const reducedMotion = useReducedMotion();
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (frames.length <= 1) return undefined;
    let cancelled = false;
    const jitter = Math.random() * 1200;
    const tick = () => {
      if (cancelled) return;
      setIndex((value) => (value + 1) % frames.length);
      timerRef.current = window.setTimeout(tick, CYCLE_INTERVAL_MS);
    };
    timerRef.current = window.setTimeout(tick, CYCLE_INTERVAL_MS + jitter);
    return () => {
      cancelled = true;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, [frames.length]);

  return (
    <Tile
      size={size}
      className={`tile-cycle ${className}`.trim()}
      onPress={onPress}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      title={title}
      disabled={disabled}
    >
      <div className="tile-cycle-frames" data-reduced={reducedMotion || undefined}>
        {frames.map((frame, frameIndex) => (
          <div
            key={frameIndex}
            className={`tile-cycle-frame ${frameIndex === index ? "is-active" : ""}`}
            aria-hidden={frameIndex !== index}
          >
            {frame}
          </div>
        ))}
      </div>
      {overlay ? <div className="tile-cycle-overlay">{overlay}</div> : null}
    </Tile>
  );
}
