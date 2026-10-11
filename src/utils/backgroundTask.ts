// Let the first committed frame paint before doing optional startup work.
export function scheduleBackgroundTask(task: () => void): () => void {
  let cancelled = false;
  let frame = 0;
  let timer: number | undefined;
  let idle: number | undefined;
  const run = () => { if (!cancelled) task(); };
  frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(() => {
      if (typeof window.requestIdleCallback === "function") {
        idle = window.requestIdleCallback(run, { timeout: 2_000 });
      } else {
        timer = window.setTimeout(run, 0);
      }
    });
  });
  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
    if (timer !== undefined) window.clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
}
