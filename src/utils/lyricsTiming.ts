export const LYRICS_TIMING_STEP_MS = 250;
export const LYRICS_TIMING_LIMIT_MS = 5_000;

export function clampLyricsTimingOffset(offsetMs: number) {
  if (!Number.isFinite(offsetMs)) return 0;
  const stepped = Math.round(offsetMs / LYRICS_TIMING_STEP_MS) * LYRICS_TIMING_STEP_MS;
  return Math.min(LYRICS_TIMING_LIMIT_MS, Math.max(-LYRICS_TIMING_LIMIT_MS, stepped));
}

/**
 * A positive offset delays the lyrics, so the lyric timeline trails media time.
 */
export function mediaTimeToLyricsTime(mediaTime: number, offsetMs: number) {
  if (!Number.isFinite(mediaTime)) return 0;
  return Math.max(0, mediaTime - clampLyricsTimingOffset(offsetMs) / 1_000);
}

export function lyricsTimeToMediaTime(lyricsTime: number, offsetMs: number, duration = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(lyricsTime)) return 0;
  const upperBound = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.min(upperBound, Math.max(0, lyricsTime + clampLyricsTimingOffset(offsetMs) / 1_000));
}

export function formatLyricsTimingOffset(offsetMs: number) {
  const normalized = clampLyricsTimingOffset(offsetMs);
  if (normalized === 0) return "同步";
  const seconds = Math.abs(normalized) / 1_000;
  const value = Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(2).replace(/0$/, "");
  return `${normalized > 0 ? "延后" : "提前"} ${value} 秒`;
}
