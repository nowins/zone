import { TILE_MOTION } from "./tokens.js";

type Clock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (id: number) => void;
};
type Update = { due: number; run: (done: () => void) => void };

/** Serialize ambient tile work, including the dwell and return to the front. */
export function createTileScheduler(clock: Clock) {
  const pending = new Set<Update>();
  let active: Update | null = null;
  let timer: number | null = null;
  let availableAt = 0;

  function finish(update: Update) {
    if (active !== update) return;
    active = null;
    availableAt = clock.now() + TILE_MOTION.ambientGap;
    pump();
  }

  function pump() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (active || pending.size === 0) return;
    const next = [...pending].reduce((a, b) => a.due <= b.due ? a : b);
    timer = clock.setTimeout(() => {
      timer = null;
      pending.delete(next);
      active = next;
      try { next.run(() => finish(next)); }
      catch (error) { finish(next); throw error; }
    }, Math.max(0, Math.max(next.due, availableAt) - clock.now()));
  }

  return (delay: number, run: Update["run"]) => {
    const update = { due: clock.now() + delay, run };
    pending.add(update);
    pump();
    return () => {
      pending.delete(update);
      if (active === update) finish(update);
      else pump();
    };
  };
}

// Keep one scheduler per document, without retaining a closed window.
const schedulers = new WeakMap<Window, ReturnType<typeof createTileScheduler>>();
export function scheduleTileUpdate(delay: number, run: Update["run"]) {
  let schedule = schedulers.get(window);
  if (!schedule) {
    schedule = createTileScheduler({
      now: () => window.performance.now(),
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: id => window.clearTimeout(id),
    });
    schedulers.set(window, schedule);
  }
  return schedule(delay, run);
}
