import type { PointerEvent } from "react";
import { clamp } from "../motion/math.js";

// Metro-style tile tilt: press tips the tile in 3D toward the pressed point.
// 10 degrees matches the Lumia calibration in MangoTile (maxTiltDegrees) — the
// signature Metro touch response; anything subtler reads as no feedback.
const TILT_DEGREES = 10;

function tiltTarget(event: PointerEvent<HTMLElement>, selector?: string): HTMLElement | null {
  const element = selector ? event.currentTarget.closest(selector) : event.currentTarget;
  return element instanceof HTMLElement ? element : null;
}

export function tiltPressDown(event: PointerEvent<HTMLElement>, selector?: string) {
  if (event.button !== 0) return;
  const tile = tiltTarget(event, selector);
  if (!tile) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const percentX = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
  const percentY = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
  tile.style.setProperty("--tilt-rx", `${(percentY * TILT_DEGREES).toFixed(2)}deg`);
  tile.style.setProperty("--tilt-ry", `${(-percentX * TILT_DEGREES).toFixed(2)}deg`);
  tile.classList.add("tilt-pressed");
}

export function tiltPressClear(event: PointerEvent<HTMLElement>, selector?: string) {
  const tile = tiltTarget(event, selector);
  if (!tile) return;
  tile.classList.remove("tilt-pressed");
  tile.style.removeProperty("--tilt-rx");
  tile.style.removeProperty("--tilt-ry");
}
