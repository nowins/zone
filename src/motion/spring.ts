export interface SpringState {
  value: number;
  velocity: number;
}

export interface SpringPreset {
  stiffness: number;
  damping: number;
  mass: number;
}

// Frames longer than this are treated as a hitch (tab switch, breakpoint) and
// simulated as a single 64ms step so the spring can never explode.
const MAX_FRAME_MS = 64;
// Semi-implicit Euler stays stable while dt < 2 / sqrt(stiffness / mass).
// 8ms substeps keep even the snappiest presets far inside that bound.
const MAX_STEP_MS = 8;

export function createSpring(from: number): SpringState {
  return { value: from, velocity: 0 };
}

/**
 * Advances the spring by `dtMs` (clamped to 64ms, integrated in <=8ms
 * substeps) and returns a fresh state. To retarget mid-flight, keep passing
 * the returned state back in with a new target: the carried velocity gives
 * the motion its inertia hand-off instead of restarting from rest.
 */
export function advanceSpring(
  state: SpringState,
  preset: SpringPreset,
  target: number,
  dtMs: number,
): SpringState {
  let remaining = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
  let { value, velocity } = state;
  while (remaining > 0) {
    const stepMs = Math.min(remaining, MAX_STEP_MS);
    const dt = stepMs / 1000;
    const springForce = -preset.stiffness * (value - target);
    const dampingForce = -preset.damping * velocity;
    velocity += ((springForce + dampingForce) / preset.mass) * dt;
    value += velocity * dt;
    remaining -= stepMs;
  }
  return { value, velocity };
}

/** True once both the distance to target and the velocity are negligible. */
export function springSettled(state: SpringState, target: number, epsilon = 0.001): boolean {
  return Math.abs(state.value - target) < epsilon && Math.abs(state.velocity) < epsilon;
}
