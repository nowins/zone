const DEFAULT_PODCAST_SEARCH_HISTORY_LIMIT = 6;

function normalizeHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_PODCAST_SEARCH_HISTORY_LIMIT;
  return Math.max(0, Math.floor(limit));
}

function searchHistoryKey(term: string): string {
  return term.toLocaleLowerCase();
}

export function normalizePodcastSearchHistory(
  input: unknown,
  limit = DEFAULT_PODCAST_SEARCH_HISTORY_LIMIT,
): string[] {
  if (!Array.isArray(input)) return [];

  const normalizedLimit = normalizeHistoryLimit(limit);
  if (normalizedLimit === 0) return [];

  const seen = new Set<string>();
  const history: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") continue;
    const term = value.trim();
    if (!term) continue;

    const key = searchHistoryKey(term);
    if (seen.has(key)) continue;
    seen.add(key);
    history.push(term);
    if (history.length >= normalizedLimit) break;
  }
  return history;
}

export function addPodcastSearchHistory(
  history: unknown,
  term: unknown,
  limit = DEFAULT_PODCAST_SEARCH_HISTORY_LIMIT,
): string[] {
  const values = Array.isArray(history) ? history : [];
  return normalizePodcastSearchHistory([term, ...values], limit);
}
