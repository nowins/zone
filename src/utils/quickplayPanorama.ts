import { PANORAMA_MOTION } from "../motion/tokens.js";
import { clamp } from "../motion/math.js";

export type PanoramaSection = { id: string; label: string };
export type PanoramaMetric = { id: string; left: number; width: number };
export type PanoramaStatus = { activeId: string; previous: boolean; next: boolean; overflow: boolean };
export const clampPanorama = (value: number, max: number) => clamp(value, 0, Math.max(0, max));

export function panoramaDepth(left: number, reduced: boolean) {
  return {
    title: reduced ? 0 : -Math.min(PANORAMA_MOTION.titleTravel, Math.max(0, left) * PANORAMA_MOTION.titleRatio),
    backdrop: reduced ? 0 : -Math.min(PANORAMA_MOTION.backdropTravel, Math.max(0, left) * PANORAMA_MOTION.backdropRatio),
  };
}

export function panoramaStatus(left: number, width: number, max: number, groups: PanoramaMetric[], preferred?: string | null): PanoramaStatus {
  const inset = groups[0]?.left ?? 0;
  const selected = groups.find(group => group.id === preferred && group.left < left + width && group.left + group.width > left);
  const leading = groups.find(group => group.left + group.width > left + inset + 1) ?? groups[groups.length - 1];
  const active = selected ?? (max > 1 && left >= max - 1 ? groups[groups.length - 1] : leading);
  return { activeId: active?.id ?? "", previous: left > 1, next: left < max - 1, overflow: max > 1 };
}

export function panoramaStep(left: number, direction: -1 | 1, max: number, groups: PanoramaMetric[]) {
  const inset = groups[0]?.left ?? 0;
  const stops = groups.map(group => clampPanorama(group.left - inset, max));
  return direction > 0 ? stops.find(stop => stop > left + 2) ?? Math.max(0, max)
    : [...stops].reverse().find(stop => stop < left - 2) ?? 0;
}

/** Vertical lists keep wheel ownership at their edges; Shift pans the hub. */
export function panoramaWheel(input: {
  deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean; ctrlKey: boolean;
  viewportWidth: number; verticalOverflow: boolean;
}) {
  if (input.ctrlKey) return null;
  const vertical = Math.abs(input.deltaY) >= Math.abs(input.deltaX);
  if (vertical && !input.shiftKey && input.verticalOverflow) return null;
  const unit = input.deltaMode === 1 ? 32 : input.deltaMode === 2 ? input.viewportWidth : 1;
  const delta = (vertical ? input.deltaY : input.deltaX) * unit;
  return delta ? { delta, smooth: vertical } : null;
}
