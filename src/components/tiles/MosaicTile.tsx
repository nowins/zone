import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { animateValue } from "../../motion/animate";
import type { AnimationHandle } from "../../motion/animate";
import { easeInOutCubic } from "../../motion/math";
import { TILE_MOTION } from "../../motion/tokens";
import { scheduleTileUpdate } from "../../motion/tileScheduler";
import { useTileActivity } from "./useTileActivity";
import { useReducedMotion } from "../../motion/useReducedMotion";
import { frameReady, tileFrames } from "./tileFrames";

type MosaicLayout = "pair" | "trio" | "quad" | "feature" | "grid-3" | "grid";
function layoutForPool(size: number): { layout: MosaicLayout; count: number } {
  if (size <= 2) return { layout: "pair", count: size };
  if (size === 3) return { layout: "trio", count: 3 };
  if (size === 4) return { layout: "quad", count: 4 };
  if (size === 5) return { layout: "feature", count: 5 };
  if (size <= 7) return { layout: "grid-3", count: 6 };
  return { layout: "grid", count: 8 };
}

/** A cell owns its displayed media; refreshed pools only supply future turns. */
export function MosaicFrames({ pool, paused = false }: { pool: ReactNode[]; paused?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { active, visible } = useTileActivity(hostRef);
  const reducedMotion = useReducedMotion();
  const images = useMemo(() => tileFrames(pool, 9), [pool]);
  const poolRef = useRef(images);
  poolRef.current = images;
  const initial = layoutForPool(images.length);
  const [grid, setGrid] = useState(() => ({ layout: initial.layout, cells: images.slice(0, initial.count) }));
  const cellsRef = useRef(grid.cells);
  cellsRef.current = grid.cells;
  const innerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const preloadRefs = useRef(new Map<string, HTMLDivElement>());
  const animationRef = useRef<AnimationHandle | null>(null);
  const runningRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const hasUpdatedRef = useRef(false);
  const activityChangeRef = useRef<(() => void) | null>(null);

  const reconcile = () => {
    const incoming = poolRef.current;
    const { layout, count } = layoutForPool(incoming.length);
    setGrid(current => {
      const cells = current.cells.slice(0, count);
      const shown = new Set(cells.map(frame => frame.id));
      for (const frame of incoming) {
        if (cells.length >= count) break;
        if (!shown.has(frame.id)) { cells.push(frame); shown.add(frame.id); }
      }
      if (layout === current.layout && cells.length === current.cells.length
        && cells.every((frame, index) => frame === current.cells[index])) return current;
      return { layout, cells };
    });
  };
  useLayoutEffect(() => { if (!runningRef.current) reconcile(); }, [images]);

  useEffect(() => {
    if (paused || !visible || reducedMotion) return undefined;
    let cancelled = false;
    let cancelSchedule: (() => void) | undefined;
    const setAngle = (index: number, value: number) => {
      innerRefs.current[index]?.style.setProperty("--cell-flip", `${value.toFixed(2)}deg`);
    };
    const schedule = () => {
      if (cancelled || !activeRef.current || runningRef.current || cancelSchedule) return;
      const min = hasUpdatedRef.current ? TILE_MOTION.cellMin : TILE_MOTION.firstMin;
      const max = hasUpdatedRef.current ? TILE_MOTION.cellMax : TILE_MOTION.firstMax;
      const shown = new Set(cellsRef.current.map(frame => frame.id));
      if (!poolRef.current.some(frame => !shown.has(frame.id))) return;
      cancelSchedule = scheduleTileUpdate(min + Math.random() * (max - min), tick);
    };
    const tick = (done: () => void) => {
      cancelSchedule = undefined;
      if (cancelled || !activeRef.current) { done(); schedule(); return; }
      const cells = cellsRef.current;
      const shown = new Set(cells.map(frame => frame.id));
      const unused = poolRef.current.filter(frame => !shown.has(frame.id) && frameReady(preloadRefs.current.get(frame.id)));
      if (unused.length === 0 || cells.length === 0) { done(); schedule(); return; }
      const removed = cells.map((frame, index) => poolRef.current.some(item => item.id === frame.id) ? -1 : index).filter(index => index >= 0);
      const index = removed[0] ?? Math.floor(Math.random() * cells.length);
      const target = unused[Math.floor(Math.random() * unused.length)];
      const inner = innerRefs.current[index];
      if (!inner) { done(); return; }
      runningRef.current = true;
      hasUpdatedRef.current = true;
      inner.style.willChange = "transform";
      let crossed = false;
      animationRef.current = animateValue({ from: 0, to: 1,
        tween: { durationMs: TILE_MOTION.cellHalf * 2, easing: easeInOutCubic },
        onUpdate: value => {
          if (!crossed && value >= 0.5) {
            crossed = true;
            // Commit at the hidden edge before revealing the captured cover.
            setAngle(index, 90);
            flushSync(() => setGrid(current => ({ ...current, cells: current.cells.map((frame, cell) => cell === index ? target : frame) })));
          }
          setAngle(index, crossed ? 180 * (1 - value) : -180 * value);
        },
        onComplete: () => {
          if (cancelled) return;
          animationRef.current = null;
          runningRef.current = false;
          inner.style.willChange = "";
          reconcile();
          cancelSchedule = undefined;
          done(); schedule();
        },
      });
      // Keep ownership until the captured back face has landed.
      cancelSchedule = () => { done(); };
    };
    const updateActivity = () => {
      if (activeRef.current) schedule();
      else if (!runningRef.current) { cancelSchedule?.(); cancelSchedule = undefined; }
    };
    activityChangeRef.current = updateActivity;
    schedule();
    return () => {
      cancelled = true;
      activityChangeRef.current = null;
      cancelSchedule?.();
      animationRef.current?.cancel();
      animationRef.current = null;
      runningRef.current = false;
      innerRefs.current.forEach(inner => {
        inner?.style.setProperty("--cell-flip", "0deg");
        if (inner) inner.style.willChange = "";
      });
      reconcile();
    };
  }, [paused, visible, reducedMotion]);
  useEffect(() => { activityChangeRef.current?.(); }, [active, images]);

  const shown = new Set(grid.cells.map(frame => frame.id));
  return <div ref={hostRef} className={`tile-mosaic layout-${grid.layout}`}>
    {grid.cells.map((frame, index) => <div className="tile-mosaic-cell" key={index}>
      <div className="tile-mosaic-cell-inner" ref={element => { innerRefs.current[index] = element; }}>{frame.content}</div>
    </div>)}
    <div hidden aria-hidden="true">
      {images.filter(frame => !shown.has(frame.id)).map(frame => <div key={frame.id}
        ref={element => { if (element) preloadRefs.current.set(frame.id, element); else preloadRefs.current.delete(frame.id); }}>{frame.content}</div>)}
    </div>
  </div>;
}
