/** Clamp `value` into the inclusive [min, max] range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamp `Math.floor(value)` into the inclusive [min, max] range. */
export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Linear interpolation between `from` and `to`; `t` is left unclamped. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Hermite smoothstep between two edges; the output is clamped to [0, 1]. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp((value - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

/** Cubic ease-out: fast start, gentle landing. `t` is clamped to [0, 1]. */
export function easeOutCubic(t: number): number {
  const remaining = 1 - clamp(t, 0, 1);
  return 1 - remaining * remaining * remaining;
}

/** Cubic ease-in: slow start, accelerating. `t` is clamped to [0, 1]. */
export function easeInCubic(t: number): number {
  const clamped = clamp(t, 0, 1);
  return clamped * clamped * clamped;
}
