const DEFAULT_PODCAST_SEARCH_HISTORY_LIMIT = 6;
export const PODCAST_SEARCH_HISTORY_MIN_CHARS = 2;
export const PODCAST_SEARCH_COMPOSITION_GRACE_MS = 80;

export type PodcastDiscoverySort = "relevance" | "recent" | "episodes";

export type PodcastSearchMatchSegment = {
  text: string;
  matched: boolean;
};

function normalizeHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_PODCAST_SEARCH_HISTORY_LIMIT;
  return Math.max(0, Math.floor(limit));
}

function searchHistoryKey(term: string): string {
  return term.toLocaleLowerCase();
}

export function podcastSearchTermCharCount(term: string): number {
  return Array.from(term).length;
}

export function isRememberedPodcastSearchTerm(term: string): boolean {
  return podcastSearchTermCharCount(term.trim()) >= PODCAST_SEARCH_HISTORY_MIN_CHARS;
}

export function shouldBlockPodcastSearchCommit(input: {
  composing: boolean;
  ignoreSubmit: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return input.composing
    || input.ignoreSubmit
    || Boolean(input.isComposing)
    || input.keyCode === 229;
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
    if (!isRememberedPodcastSearchTerm(term)) continue;

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

export function filterPodcastSearchHistory(
  history: unknown,
  query: unknown,
): string[] {
  const terms = normalizePodcastSearchHistory(history);
  const needle = typeof query === "string" ? query.trim().toLocaleLowerCase() : "";
  if (!needle) return terms;
  return terms.filter((term) => {
    const haystack = term.toLocaleLowerCase();
    return haystack.includes(needle) && haystack !== needle;
  });
}

function validSortNumber(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

function searchResultMetric(
  result: unknown,
  field: "latestReleaseAt" | "episodeCount",
): number | null {
  if (typeof result !== "object" || result === null) return null;
  return validSortNumber(
    (result as Record<"latestReleaseAt" | "episodeCount", unknown>)[field],
  );
}

export function sortPodcastSearchResults<T>(
  results: readonly T[],
  sort: PodcastDiscoverySort,
): T[] {
  if (sort === "relevance") return [...results];

  const field = sort === "recent" ? "latestReleaseAt" : "episodeCount";
  return results
    .map((result, index) => ({
      result,
      index,
      metric: searchResultMetric(result, field),
    }))
    .sort((left, right) => {
      if (left.metric === null) {
        return right.metric === null ? left.index - right.index : 1;
      }
      if (right.metric === null) return -1;
      if (left.metric !== right.metric) return right.metric - left.metric;
      return left.index - right.index;
    })
    .map(({ result }) => result);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appendSearchMatchSegment(
  segments: PodcastSearchMatchSegment[],
  text: string,
  matched: boolean,
) {
  if (!text) return;
  const previous = segments[segments.length - 1];
  if (previous?.matched === matched) {
    previous.text += text;
    return;
  }
  segments.push({ text, matched });
}

export function splitPodcastSearchMatch(
  text: string,
  query: string,
): PodcastSearchMatchSegment[] {
  const keywords = query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (keywords.length === 0 || text.length === 0) {
    return [{ text, matched: false }];
  }

  const matcher = new RegExp(
    keywords.map(escapeRegularExpression).join("|"),
    "giu",
  );
  const segments: PodcastSearchMatchSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? cursor;
    if (index > cursor) {
      appendSearchMatchSegment(
        segments,
        text.slice(cursor, index),
        false,
      );
    }
    appendSearchMatchSegment(segments, match[0], true);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    appendSearchMatchSegment(segments, text.slice(cursor), false);
  }
  return segments.length > 0 ? segments : [{ text, matched: false }];
}
