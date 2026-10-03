type Timer = ReturnType<typeof setTimeout>;
export type PodcastRecoveryOptions = {
  audio: Pick<HTMLAudioElement, "currentTime" | "paused" | "error">;
  hasIntent: () => boolean;
  isRemote: () => boolean;
  online: () => boolean;
  expireSleep: () => boolean;
  retry: () => void;
  resumeGraph: () => void;
  generation?: () => number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

/** One source owns a finite reconnect budget; progress, not play promises, resets it. */
export function createPodcastRecovery(options: PodcastRecoveryOptions) {
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let timer: Timer | null = null;
  let attempts = 0;
  let waiting = false;
  let position = options.audio.currentTime;
  let disposed = false;
  function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
  function allowed() { return !disposed && options.hasIntent() && options.isRemote() && !options.expireSleep(); }
  function schedule(ms: number) {
    if (!allowed() || attempts >= 3 || timer !== null || !options.online()) return;
    const generation = options.generation?.();
    timer = setTimer(() => {
      timer = null;
      if (generation !== options.generation?.()) { waiting = false; return; }
      if (!allowed() || !options.online() || !waiting) return;
      if (options.audio.currentTime >= position + 2 && !options.audio.paused) { healthy(); return; }
      attempts++; position = options.audio.currentTime;
      options.retry();
    }, ms);
  }
  function healthy() {
    if (!waiting || options.audio.paused || options.audio.currentTime < position + 2) return;
    attempts = 0; waiting = false; cancelTimer();
  }
  function stalled(failure = false) {
    if (!allowed()) return;
    // Decode failures are content errors and must remain available for explicit retry.
    if (options.audio.error?.code === 3) { waiting = false; cancelTimer(); return; }
    if (!waiting) position = options.audio.currentTime;
    waiting = true;
    schedule(failure ? [1000, 3000, 8000][attempts] ?? 8000 : 15000);
  }
  function returned() {
    if (disposed || options.expireSleep() || !options.hasIntent()) { cancelTimer(); return; }
    if (!options.audio.paused) options.resumeGraph();
    if (waiting && options.online()) { cancelTimer(); schedule(500); }
  }
  return {
    stalled, healthy, returned,
    offline() { if (allowed()) { waiting = true; position = options.audio.currentTime; cancelTimer(); } },
    cancel: cancelTimer,
    dispose() { disposed = true; cancelTimer(); },
  };
}
