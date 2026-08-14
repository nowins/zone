import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { animateValue } from "../../motion/animate";
import type { AnimationHandle } from "../../motion/animate";
import { easeInCubic, easeOutCubic } from "../../motion/math";
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

// People-hub cadence: sparse, staggered single-cell flips. 2–6s felt like a
// screensaver; real hub tiles change on the order of many seconds.
const MIN_CELL_FLIP_MS = 8_000;
const MAX_CELL_FLIP_MS = 18_000;
const FIRST_FLIP_MIN_MS = 4_000;
const FIRST_FLIP_MAX_MS = 10_000;
// Half-flip was 160ms and read as a hard snap; longer ease gives the card
// weight without feeling sluggish.
const CELL_FLIP_HALF_MS = 280;

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
 * paired exchange of two cells. Under reduced motion a cell simply swaps.
 */
export function MosaicFrames({ pool }: { pool: ReactNode[] }) {
  const images = pool.slice(0, 9);
  const { layout, cells: cellCount } = layoutForPool(images.length);
  const [cells, setCells] = useState<number[]>(() => initialCells(images.length, cellCount));
  const reducedMotion = useReducedMotion();
  const innerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const flipsRef = useRef<(AnimationHandle | null)[]>([]);
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
    if (images.length <= cellCount) return undefined;
    let cancelled = false;
    let timer: number | undefined;

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
    const flipCell = (cellIndex: number, poolIndex: number) => {
      if (reducedMotion) {
        applyTarget(cellIndex, poolIndex);
        return;
      }
      if (!innerRefs.current[cellIndex] || flipsRef.current[cellIndex]) return;

      const firstHalf = animateValue({
        from: 0,
        to: -90,
        tween: { durationMs: CELL_FLIP_HALF_MS, easing: easeInCubic },
        onUpdate: (value) => setAngle(cellIndex, value),
        onComplete: () => {
          if (cancelled) return;
          applyTarget(cellIndex, poolIndex);
          setAngle(cellIndex, 90);
          const secondHalf = animateValue({
            from: 90,
            to: 0,
            tween: { durationMs: CELL_FLIP_HALF_MS, easing: easeOutCubic },
            onUpdate: (value) => setAngle(cellIndex, value),
            onComplete: () => {
              flipsRef.current[cellIndex] = null;
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

    const tick = () => {
      if (cancelled) return;
      const move = chooseMove();
      if (move) flipCell(move.cellIndex, move.poolIndex);
      timer = window.setTimeout(tick, randomDelay(MIN_CELL_FLIP_MS, MAX_CELL_FLIP_MS));
    };

    timer = window.setTimeout(tick, randomDelay(FIRST_FLIP_MIN_MS, FIRST_FLIP_MAX_MS));
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      for (const handle of flipsRef.current) handle?.cancel();
      flipsRef.current = [];
      for (const inner of innerRefs.current) {
        inner?.style.setProperty("--cell-flip", "0deg");
      }
    };
  }, [images.length, cellCount, reducedMotion]);

  return (
    <div className={`tile-mosaic layout-${layout}`}>
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
