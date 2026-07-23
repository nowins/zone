import type { LyricsCandidate, LyricsCandidateScore, LyricsQuery } from "../types";

const TITLE_WEIGHT = 0.46;
const ARTIST_WEIGHT = 0.29;
const ALBUM_WEIGHT = 0.1;
const DURATION_WEIGHT = 0.15;

export const DEFAULT_LYRICS_MATCH_THRESHOLD = 72;

export function scoreLyricsCandidate(
  query: LyricsQuery,
  candidate: Pick<LyricsCandidate, "title" | "artist" | "album" | "duration">,
): LyricsCandidateScore {
  const title = textSimilarity(query.title, candidate.title);
  const artist = textSimilarity(query.artist, candidate.artist);
  const album = query.album && candidate.album ? textSimilarity(query.album, candidate.album) : null;
  const duration = validDuration(query.duration) && validDuration(candidate.duration)
    ? durationSimilarity(query.duration!, candidate.duration!)
    : null;
  const weighted = [
    { value: title, weight: TITLE_WEIGHT },
    { value: artist, weight: ARTIST_WEIGHT },
    ...(album === null ? [] : [{ value: album, weight: ALBUM_WEIGHT }]),
    ...(duration === null ? [] : [{ value: duration, weight: DURATION_WEIGHT }]),
  ];
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  const total = totalWeight > 0
    ? weighted.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight
    : 0;

  return {
    total: Math.round(total * 100),
    title: Math.round(title * 100),
    artist: Math.round(artist * 100),
    album: album === null ? null : Math.round(album * 100),
    duration: duration === null ? null : Math.round(duration * 100),
  };
}

export function pickBestLyricsCandidate(
  candidates: LyricsCandidate[],
  threshold = DEFAULT_LYRICS_MATCH_THRESHOLD,
) {
  return [...candidates]
    .filter((candidate) => candidate.content.trim() && !candidate.instrumental && candidate.score.total >= threshold)
    .sort(compareLyricsCandidates)[0] ?? null;
}

export function selectDiverseLyricsCandidates(candidates: LyricsCandidate[], limit: number) {
  if (limit <= 0 || candidates.length === 0) return [];

  const selectedKeys = new Set<string>();
  const representedProviders = new Set<string>();
  for (const candidate of candidates) {
    if (representedProviders.has(candidate.providerId)) continue;
    representedProviders.add(candidate.providerId);
    selectedKeys.add(candidateKey(candidate));
    if (selectedKeys.size >= limit) break;
  }
  for (const candidate of candidates) {
    if (selectedKeys.size >= limit) break;
    selectedKeys.add(candidateKey(candidate));
  }

  const emittedKeys = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidateKey(candidate);
    if (!selectedKeys.has(key) || emittedKeys.has(key)) return false;
    emittedKeys.add(key);
    return true;
  });
}

function candidateKey(candidate: LyricsCandidate) {
  return `${candidate.providerId}:${candidate.id}`;
}

export function combineTranslatedLrc(primary: string, translation?: string | null) {
  const normalizedPrimary = primary.trim();
  const normalizedTranslation = translation?.trim() ?? "";
  if (!normalizedPrimary) return "";
  return normalizedTranslation
    ? `${normalizedPrimary}\n${normalizedTranslation}`
    : normalizedPrimary;
}

export function compareLyricsCandidates(left: LyricsCandidate, right: LyricsCandidate) {
  return right.score.total - left.score.total
    || formatRank(right.formatHint) - formatRank(left.formatHint)
    || left.id.localeCompare(right.id);
}

export function textSimilarity(left: string, right: string) {
  const normalizedLeft = normalizeMetadata(left);
  const normalizedRight = normalizeMetadata(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return Math.min(normalizedLeft.length, normalizedRight.length)
      / Math.max(normalizedLeft.length, normalizedRight.length) * 0.96;
  }
  const distance = levenshtein(normalizedLeft, normalizedRight);
  return Math.max(0, 1 - distance / Math.max(normalizedLeft.length, normalizedRight.length));
}

export function normalizeMetadata(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[（(\[].*?(?:remaster(?:ed)?|live|version|edit|mix|feat\.?|ft\.?).*?[）)\]]/gi, " ")
    .replace(/\b(?:feat\.?|ft\.?)\s+.+$/gi, " ")
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function durationSimilarity(left: number, right: number) {
  const difference = Math.abs(left - right);
  if (difference <= 1.5) return 1;
  if (difference >= 18) return 0;
  return 1 - (difference - 1.5) / 16.5;
}

function validDuration(value?: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function formatRank(format: LyricsCandidate["formatHint"]) {
  if (format === "ttml") return 3;
  if (format === "lrc") return 2;
  return 1;
}

function levenshtein(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}
