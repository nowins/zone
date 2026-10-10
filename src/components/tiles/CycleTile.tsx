import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Tile } from "./Tile";
import type { TileSize } from "./Tile";
import { useTileActivity } from "./useTileActivity";
import { useReducedMotion } from "../../motion/useReducedMotion";
import { MOTION_DURATIONS, TILE_MOTION } from "../../motion/tokens";
import { scheduleTileUpdate } from "../../motion/tileScheduler";
import { frameReady, tileFrames, type TileFrame } from "./tileFrames";

const MAX_CYCLE_IMAGES = 9;

/**
 * WP8 cycle tile: rotates slowly through up to nine images with a gentle
 * cross-fade, staying restrained and content-driven. The cycle stops under
 * reduced motion, offscreen or during interaction. Updates
 * use the same sparse, serial schedule as the other live tiles.
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
  const hostRef = useRef<HTMLDivElement>(null);
  const { active, visible } = useTileActivity(hostRef);
  const reducedMotion = useReducedMotion();
  const frames = useMemo(() => tileFrames(images, MAX_CYCLE_IMAGES), [images]);
  const poolRef = useRef(frames);
  poolRef.current = frames;
  const [current, setCurrent] = useState<TileFrame | null>(() => frames[0] ?? null);
  const [leaving, setLeaving] = useState<TileFrame | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;
  const nodesRef = useRef(new Map<string, HTMLDivElement>());
  const activeRef = useRef(active);
  activeRef.current = active;
  const activityChangeRef = useRef<(() => void) | null>(null);
  const hasUpdatedRef = useRef(false);
  useLayoutEffect(() => {
    if (!frames.length) { setCurrent(null); setLeaving(null); }
    else if (!currentRef.current) setCurrent(frames[0]);
  }, [frames]);

  useEffect(() => {
    if (!visible || reducedMotion) return undefined;
    let cancelled = false;
    let cancelSchedule: (() => void) | undefined;
    let leavingTimer: number | undefined;
    const schedule = () => {
      if (cancelled || !activeRef.current || cancelSchedule) return;
      if (!poolRef.current.some(frame => frame.id !== currentRef.current?.id)) return;
      const min = hasUpdatedRef.current ? TILE_MOTION.intervalMin : TILE_MOTION.firstMin;
      const max = hasUpdatedRef.current ? TILE_MOTION.intervalMax : TILE_MOTION.firstMax;
      cancelSchedule = scheduleTileUpdate(min + Math.random() * (max - min), tick);
    };
    const tick = (done: () => void) => {
      const pool = poolRef.current;
      const index = pool.findIndex(frame => frame.id === currentRef.current?.id);
      const next = pool[(index + 1) % Math.max(1, pool.length)];
      if (cancelled || !activeRef.current || !next || !frameReady(nodesRef.current.get(next.id))) {
        cancelSchedule = undefined; done(); schedule(); return;
      }
      hasUpdatedRef.current = true;
      // Store the two actual nodes, rather than indexes into a mutable pool.
      setLeaving(currentRef.current);
      currentRef.current = next;
      setCurrent(next);
      leavingTimer = window.setTimeout(() => {
        leavingTimer = undefined;
        if (cancelled) return;
        setLeaving(null);
        cancelSchedule = undefined;
        done(); schedule();
      }, MOTION_DURATIONS.cycle + MOTION_DURATIONS.instant);
    };
    const updateActivity = () => {
      if (activeRef.current) schedule();
      else if (leavingTimer === undefined) { cancelSchedule?.(); cancelSchedule = undefined; }
    };
    activityChangeRef.current = updateActivity;
    schedule();
    return () => {
      cancelled = true;
      activityChangeRef.current = null;
      cancelSchedule?.();
      if (leavingTimer !== undefined) window.clearTimeout(leavingTimer);
      setLeaving(null);
    };
  }, [visible, reducedMotion]);
  useEffect(() => { activityChangeRef.current?.(); }, [active, frames]);

  const displayed = [current, leaving].filter((frame): frame is TileFrame => frame !== null);
  const rendered = [...displayed, ...frames.filter(frame => !displayed.some(item => item.id === frame.id))];
  return (
    <div ref={hostRef} className="tile-cycle-frames">
      {rendered.map(frame => (
        <div
          key={frame.id}
          ref={element => { if (element) nodesRef.current.set(frame.id, element); else nodesRef.current.delete(frame.id); }}
          className={`tile-cycle-frame ${frame.id === current?.id ? "is-active" : ""} ${
            frame.id === leaving?.id && frame.id !== current?.id ? "is-leaving" : ""
          }`}
          aria-hidden={frame.id !== current?.id}
        >
          {frame.content}
        </div>
      ))}
    </div>
  );
}
