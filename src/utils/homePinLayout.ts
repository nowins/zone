import type { HomePinSize } from "../types.js";

type LayoutPin = { id: string; size: HomePinSize };
export type PinPlacement = { target: string; after: boolean };
export const HOME_PIN_SPANS: Record<HomePinSize, { columns: number; rows: number }> = {
  small: { columns: 1, rows: 1 },
  medium: { columns: 2, rows: 2 },
  wide: { columns: 4, rows: 2 },
  large: { columns: 4, rows: 4 },
};

/** Match the board's sparse, column-first CSS grid auto-placement. */
export function layoutHomePins(pins: LayoutPin[], rows = 6) {
  const occupied = new Set<string>();
  const positions = new Map<string, { column: number; row: number }>();
  let column = 0, row = 0;
  for (const pin of pins) {
    const span = HOME_PIN_SPANS[pin.size];
    const fits = () => {
      if (row + span.rows > rows) return false;
      for (let x = column; x < column + span.columns; x++) {
        for (let y = row; y < row + span.rows; y++) {
          if (occupied.has(`${x}:${y}`)) return false;
        }
      }
      return true;
    };
    while (!fits()) {
      row++;
      if (row + span.rows > rows) { row = 0; column++; }
    }
    positions.set(pin.id, { column, row });
    for (let x = column; x < column + span.columns; x++) {
      for (let y = row; y < row + span.rows; y++) occupied.add(`${x}:${y}`);
    }
  }
  return positions;
}

/** Pick the reachable insertion nearest the dragged tile's desired origin. */
export function resolveHomePinPlacement(pins: LayoutPin[], sourceId: string, column: number, row: number, rows = 6): PinPlacement | null {
  const sourceIndex = pins.findIndex(pin => pin.id === sourceId);
  if (sourceIndex < 0 || pins.length < 2) return null;
  const source = pins[sourceIndex];
  const others = pins.filter(pin => pin.id !== sourceId);
  let bestIndex = sourceIndex, bestScore = Infinity;
  for (let index = 0; index <= others.length; index++) {
    const order = [...others];
    order.splice(index, 0, source);
    const position = layoutHomePins(order, rows).get(sourceId)!;
    const score = (position.column - column) ** 2 + (position.row - row) ** 2;
    if (score < bestScore || (score === bestScore && Math.abs(index - sourceIndex) < Math.abs(bestIndex - sourceIndex))) {
      bestIndex = index;
      bestScore = score;
    }
  }
  if (bestIndex === sourceIndex) return null;
  return bestIndex === others.length
    ? { target: others[others.length - 1].id, after: true }
    : { target: others[bestIndex].id, after: false };
}
