import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useReducedMotion } from "../../motion/useReducedMotion";
import { Tile } from "./Tile";
import type { TileSize } from "./Tile";

const CYCLE_INTERVAL_MS = 5_000;
const MAX_CYCLE_IMAGES = 9;
// How long the outgoing frame keeps its is-leaving drift class before it
// settles back to the base (parked) state — slightly past the CSS transition.
const LEAVING_CLEAR_MS = 900;

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
      <CycleFrames images={images} />
      {overlay ? <div className="tile-cycle-overlay">{overlay}</div> : null}
    </Tile>
  );
}

/**
 * Presentation-only rotating frames (no Tile chrome), so a cycle can live
 * inside another tile's face — e.g. a playlist FlipTile front that slowly
 * rotates its tracks' covers. Cycles automatically once given 2+ images.
 */
export function CycleFrames({ images }: { images: ReactNode[] }) {
  const frames = images.slice(0, MAX_CYCLE_IMAGES);
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState<number | null>(null);
  const reducedMotion = useReducedMotion();
  const timerRef = useRef<number | undefined>(undefined);
  const leavingTimerRef = useRef<number | undefined>(undefined);
  // Mirror the index so the timer tick always reads the current frame, not a
  // stale closure value.
  const indexRef = useRef(0);
  indexRef.current = index;

  useEffect(() => {
    if (frames.length <= 1) return undefined;
    let cancelled = false;
    const jitter = Math.random() * 1200;
    const tick = () => {
      if (cancelled) return;
      const current = indexRef.current;
      // The outgoing frame keeps drifting upward while it fades (is-leaving),
      // so both frames travel in the same direction like a conveyor.
      setLeaving(current);
      if (leavingTimerRef.current !== undefined) window.clearTimeout(leavingTimerRef.current);
      leavingTimerRef.current = window.setTimeout(() => {
        if (!cancelled) setLeaving(null);
      }, LEAVING_CLEAR_MS);
      setIndex((current + 1) % frames.length);
      timerRef.current = window.setTimeout(tick, CYCLE_INTERVAL_MS);
    };
    timerRef.current = window.setTimeout(tick, CYCLE_INTERVAL_MS + jitter);
    return () => {
      cancelled = true;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      if (leavingTimerRef.current !== undefined) window.clearTimeout(leavingTimerRef.current);
    };
  }, [frames.length]);

  return (
    <div className="tile-cycle-frames" data-reduced={reducedMotion || undefined}>
      {frames.map((frame, frameIndex) => (
        <div
          key={frameIndex}
          className={`tile-cycle-frame ${frameIndex === index ? "is-active" : ""} ${
            frameIndex === leaving && frameIndex !== index ? "is-leaving" : ""
          }`}
          aria-hidden={frameIndex !== index}
        >
          {frame}
        </div>
      ))}
    </div>
  );
}
