export const LYRICS_POSITIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LYRICS_NEGATIVE_CACHE_TTL_MS = 30 * 60 * 1000;

export function isLyricsRemoteCacheFresh(entry: { updatedAt: number; autoSourceId?: string } | undefined, now = Date.now()) {
  if (!entry || !Number.isFinite(entry.updatedAt)) return false;
  const age = now - entry.updatedAt;
  return age >= 0 && age < (entry.autoSourceId ? LYRICS_POSITIVE_CACHE_TTL_MS : LYRICS_NEGATIVE_CACHE_TTL_MS);
}
