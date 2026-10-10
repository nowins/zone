import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { animateValue } from "../../motion/animate";
import type { AnimationHandle } from "../../motion/animate";
import { easeInCubic, easeOutCubic } from "../../motion/math";
import { TILE_MOTION } from "../../motion/tokens";
import { scheduleTileUpdate } from "../../motion/tileScheduler";
import { useTileActivity } from "./useTileActivity";
import { useReducedMotion } from "../../motion/useReducedMotion";

// Layout is sized to the covers we actually have. Empty transparent slots
// read as "missing pieces", so we never reserve cells we cannot fill.
// 2 -> pair, 3 -> big + two, 4 -> 2x2, 5 -> Win8 feature, 6/7 -> 3x2,
// 8+ -> full 4x2 People-hub grid.
type MosaicLayout = "pair" | "trio" | "quad" | "feature" | "grid-3" | "grid";

function layoutForPool(poolSize: number): { layout: MosaicLayout; cells: number } {
  if (poolSize <= 2) return { layout: "pair", cells: 2 };
  if (poolSize === 3) return { layout: "trio", cells: 3 };
  if (poolSize === 4) return { layout: "quad", cells: 4 };
  if (poolSize === 5) return { layout: "feature", cells: 5 };
  // 7 covers still use a full 3x2 so one slot is never left blank; the spare
  // cover stays in the unused pool and rotates in later.
  if (poolSize <= 7) return { layout: "grid-3", cells: 6 };
  return { layout: "grid", cells: 8 };
}

function randomDelay(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

function initialCells(poolSize: number, cellCount: number): number[] {
  return Array.from({ length: cellCount }, (_, i) => i % Math.max(poolSize, 1));
}

/**
 * WP7 People-hub mosaic: a grid of square cells — covers keep their aspect,
 * never cropped into strips — where a single cell card-flips to reveal a
 * cover that is not currently on the board.
 *
 * Layout capacity never exceeds the pool, so the tile stays fully filled.
 * When every cover is already shown the mosaic rests; it never forces a
 * paired exchange of two cells. Editing, reduced motion and hidden tiles suspend the scheduler.
 */
export function MosaicFrames({ pool, paused = false }: { pool: ReactNode[]; paused?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { active } = useTileActivity(hostRef);
  const images = pool.slice(0, 9);
  const { layout, cells: cellCount } = layoutForPool(images.length);
  const [cells, setCells] = useState<number[]>(() => initialCells(images.length, cellCount));
  const reducedMotion = useReducedMotion();
  const innerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const flipsRef = useRef<(AnimationHandle | null)[]>([]);
  const hasUpdatedRef = useRef(false);
  // Mirror cells so the scheduler always reads the current assignment, not a
  // stale closure value.
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  // Re-baseline the grid if the pool size changes (e.g. library rescan).
  useEffect(() => {
    setCells(initialCells(images.length, cellCount));
  }, [images.length, cellCount]);

  useEffect(() => {
    // Need spare covers to rotate; a fully-shown pool stays still.
    if (images.length <= cellCount || paused || !active || reducedMotion) return undefined;
    let cancelled = false;
    let cancelSchedule: (() => void) | undefined;

    const setAngle = (cellIndex: number, value: number) => {
      innerRefs.current[cellIndex]?.style.setProperty("--cell-flip", `${value.toFixed(2)}deg`);
    };

    const applyTarget = (cellIndex: number, poolIndex: number) => {
      setCells((prev) => {
        if (prev[cellIndex] === poolIndex) return prev;
        const next = [...prev];
        next[cellIndex] = poolIndex;
        return next;
      });
    };

    // Single-cell card flip: edge-on, swap content at the apex, continue from
    // the opposite edge so the motion reads as one continuous turn.
    const flipCell = (cellIndex: number, poolIndex: number, done: () => void) => {
      const inner = innerRefs.current[cellIndex];
      if (!inner || flipsRef.current[cellIndex]) { done(); return; }
      // Promote the cell only for the flip's duration — a permanent
      // will-change on every cell keeps dozens of idle layers alive.
      inner.style.willChange = "transform";

      const firstHalf = animateValue({
        from: 0,
        to: -90,
        tween: { durationMs: TILE_MOTION.cellHalf, easing: easeInCubic },
        onUpdate: (value) => setAngle(cellIndex, value),
        onComplete: () => {
          if (cancelled) return;
          applyTarget(cellIndex, poolIndex);
          setAngle(cellIndex, 90);
          const secondHalf = animateValue({
            from: 90,
            to: 0,
            tween: { durationMs: TILE_MOTION.cellHalf, easing: easeOutCubic },
            onUpdate: (value) => setAngle(cellIndex, value),
            onComplete: () => {
              flipsRef.current[cellIndex] = null;
              inner.style.willChange = "";
              done();
            },
          });
          flipsRef.current[cellIndex] = secondHalf;
        },
      });
      flipsRef.current[cellIndex] = firstHalf;
    };

    // Only bring in an unshown cover. Never exchange two cells (that looked
    // like the whole mosaic flashing together).
    const chooseMove = (): { cellIndex: number; poolIndex: number } | null => {
      const current = cellsRef.current;
      const shown = new Set(current);
      const unused = images.map((_, i) => i).filter((i) => !shown.has(i));
      if (unused.length === 0) return null;

      // Prefer a cell that is not already mid-flip.
      const idle = current
        .map((_, cellIndex) => cellIndex)
        .filter((cellIndex) => !flipsRef.current[cellIndex]);
      if (idle.length === 0) return null;

      const cellIndex = idle[Math.floor(Math.random() * idle.length)];
      const poolIndex = unused[Math.floor(Math.random() * unused.length)];
      return { cellIndex, poolIndex };
    };

    const schedule = (first = false) => {
      cancelSchedule = scheduleTileUpdate(randomDelay(
        first ? TILE_MOTION.firstMin : TILE_MOTION.cellMin,
        first ? TILE_MOTION.firstMax : TILE_MOTION.cellMax,
      ), tick);
    };
    const tick = (done: () => void) => {
      if (cancelled) return;
      const move = chooseMove();
      const finish = () => { done(); if (!cancelled) schedule(); };
      if (move) {
        hasUpdatedRef.current = true;
        flipCell(move.cellIndex, move.poolIndex, finish);
      } else finish();
    };

    schedule(!hasUpdatedRef.current);
    return () => {
      cancelled = true;
      cancelSchedule?.();
      for (const handle of flipsRef.current) handle?.cancel();
      flipsRef.current = [];
      for (const inner of innerRefs.current) {
        if (!inner) continue;
        inner.style.setProperty("--cell-flip", "0deg");
        inner.style.willChange = "";
      }
    };
  }, [images.length, cellCount, paused, active, reducedMotion]);

  return (
    <div ref={hostRef} className={`tile-mosaic layout-${layout}`}>
      {cells.map((poolIndex, cellIndex) => (
        <div className="tile-mosaic-cell" key={cellIndex}>
          <div
            className="tile-mosaic-cell-inner"
            ref={(element) => {
              innerRefs.current[cellIndex] = element;
            }}
          >
            {images[poolIndex]}
          </div>
        </div>
      ))}
    </div>
  );
}
