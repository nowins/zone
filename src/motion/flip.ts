export interface FlipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A decoded image may travel with its rect across an unmounted view. */
export interface FlipSource extends FlipRect {
  image?: HTMLImageElement | HTMLCanvasElement;
}

export interface FlipDelta {
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
}

interface FlipEntry {
  rect: FlipSource;
  capturedAt: number;
}

// Shared-element hand-off registry: the outgoing view records where a visual
// element was, the incoming view takes it and animates from there.
const flipSources = new Map<string, FlipEntry>();

export function registerFlipSource(id: string, rect: FlipSource, now: number = Date.now()): void {
  flipSources.set(id, { rect, capturedAt: now });
}

/** Removes and returns the registered rect, or null when missing or expired. */
export function takeFlipSource(
  id: string,
  now: number = Date.now(),
  maxAgeMs = 1000,
): FlipSource | null {
  const entry = flipSources.get(id);
  if (!entry) return null;
  flipSources.delete(id);
  if (now - entry.capturedAt > maxAgeMs) return null;
  return entry.rect;
}

/**
 * Computes the transform that makes an element already laid out at `target`
 * appear at `source`: translate its center back, then scale to the old size.
 * Apply as `translate(dx, dy) scale(scaleX, scaleY)` with
 * `transform-origin: center`, then animate to identity.
 */
export function computeFlipDelta(source: FlipRect, target: FlipRect): FlipDelta {
  return {
    dx: source.x + source.width / 2 - (target.x + target.width / 2),
    dy: source.y + source.height / 2 - (target.y + target.height / 2),
    scaleX: target.width > 0 ? source.width / target.width : 1,
    scaleY: target.height > 0 ? source.height / target.height : 1,
  };
}

/** DOM convenience wrapper around {@link registerFlipSource}. */
export function registerFlipElement(
  id: string,
  element: HTMLElement,
  now: number = Date.now(),
): void {
  const rect = element.getBoundingClientRect();
  registerFlipSource(
    id,
    { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    now,
  );
}
