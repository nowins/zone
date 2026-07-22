import { invoke } from "@tauri-apps/api/core";
import type {
  LyricsCandidate,
  LyricsProviderConfig,
  LyricsProviderDefinition,
  LyricsQuery,
  LyricsSource,
} from "../types";
import {
  combineTranslatedLrc,
  compareLyricsCandidates,
  DEFAULT_LYRICS_MATCH_THRESHOLD,
  pickBestLyricsCandidate,
  scoreLyricsCandidate,
} from "../utils/lyricsProviders";
import { parseAmllTtmlIndex, type AmllTtmlIndexEntry } from "../utils/amllTtml";

type NeteaseArtist = {
  name?: string;
};

type NeteaseAlbum = {
  name?: string;
};

type NeteaseSong = {
  id?: number;
  name?: string;
  duration?: number;
  dt?: number;
  artists?: NeteaseArtist[];
  ar?: NeteaseArtist[];
  album?: NeteaseAlbum;
  al?: NeteaseAlbum;
};

type NeteaseSearchResponse = {
  code?: number;
  result?: {
    songs?: NeteaseSong[];
  };
};

type NeteaseLyricsResponse = {
  code?: number;
  nolyric?: boolean;
  uncollected?: boolean;
  lrc?: { lyric?: string };
  tlyric?: { lyric?: string };
};

type LrcLibResult = {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

export type LyricsProviderSearchResult = {
  candidates: LyricsCandidate[];
  errors: Array<{ providerId: string; providerName: string; message: string }>;
};

const lastRequestAt = new Map<string, number>();
const AMLL_INDEX_URL = "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/metadata/raw-lyrics-index.jsonl";
const AMLL_RAW_URL = "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/raw-lyrics";
const AMLL_MANUAL_MATCH_THRESHOLD = 55;
let amllIndexCache: AmllTtmlIndexEntry[] | null = null;
let amllIndexRequest: Promise<AmllTtmlIndexEntry[]> | null = null;

const amllTtmlProvider: LyricsProviderDefinition = {
  id: "amll-ttml-db",
  name: "AMLL TTML DB",
  description: "开源逐词 TTML 资料库；有高质量时间轴时优先使用。",
  capabilities: ["word", "translation", "transliteration"],
  defaultEnabled: true,
  defaultPriority: 5,
  defaultTimeoutMs: 15_000,
  rateLimitMs: 1_500,
  async search(query, signal, timeoutMs) {
    await enforceRateLimit("amll-ttml-db", 1_500, signal);
    const index = await loadAmllIndex(signal, timeoutMs);
    const seen = new Set<string>();
    const matches = [...index]
      .sort((left, right) => right.rawLyricFile.localeCompare(left.rawLyricFile))
      .map((entry): LyricsCandidate | null => {
        const identity = [entry.title, entry.artist, entry.album ?? "", entry.neteaseId ?? ""].join("\u0000");
        if (seen.has(identity)) return null;
        seen.add(identity);
        const candidateBase = {
          id: `amll-ttml-db:${entry.rawLyricFile}`,
          providerId: "amll-ttml-db",
          providerName: "AMLL TTML DB",
          title: entry.title,
          artist: entry.artist,
          album: entry.album,
          duration: undefined,
          instrumental: false,
          formatHint: "ttml" as const,
          content: "",
          reference: `https://github.com/amll-dev/amll-ttml-db/blob/main/raw-lyrics/${entry.rawLyricFile}`,
        };
        return {
          ...candidateBase,
          score: scoreLyricsCandidate(query, candidateBase),
        };
      })
      .filter((candidate): candidate is LyricsCandidate => candidate !== null)
      .sort((left, right) => right.score.total - left.score.total || right.id.localeCompare(left.id))
      .filter((candidate) => candidate.score.total >= AMLL_MANUAL_MATCH_THRESHOLD)
      .slice(0, 4);

    const lyricTargets = (matches[0]?.score.total ?? 0) >= DEFAULT_LYRICS_MATCH_THRESHOLD
      ? matches.slice(0, 1)
      : matches;
    const settled = await Promise.allSettled(lyricTargets.map(async (candidate) => {
      const rawLyricFile = candidate.id.slice("amll-ttml-db:".length);
      const content = (await requestProviderText(
        "amll-ttml-db",
        `${AMLL_RAW_URL}/${encodeURIComponent(rawLyricFile)}`,
        timeoutMs,
        signal,
      )).trim();
      if (!/<(?:[\w-]+:)?tt\b/i.test(content) || !/<(?:[\w-]+:)?p\b/i.test(content)) {
        throw new Error("AMLL TTML DB 返回了无法识别的歌词数据");
      }
      return { ...candidate, content };
    }));

    const candidates: LyricsCandidate[] = [];
    let firstError: unknown;
    for (const result of settled) {
      if (result.status === "fulfilled") {
        candidates.push(result.value);
      } else if (firstError === undefined) {
        firstError = result.reason;
      }
    }
    if (signal.aborted) throw abortError();
    if (candidates.length === 0 && firstError !== undefined) throw firstError;
    if (import.meta.env.DEV) {
      console.info("[lyrics] provider response", { provider: "amll-ttml-db", results: candidates.length });
    }
    return candidates.sort(compareLyricsCandidates);
  },
  async get(candidate, signal) {
    if (signal.aborted) throw abortError();
    return candidateToSource(candidate);
  },
};

const neteaseProvider: LyricsProviderDefinition = {
  id: "netease",
  name: "网易云音乐",
  description: "覆盖较广的同步歌词来源；高置信命中后不再等待后续来源。",
  capabilities: ["line", "translation"],
  defaultEnabled: true,
  defaultPriority: 10,
  defaultTimeoutMs: 8_000,
  rateLimitMs: 800,
  async search(query, signal, timeoutMs) {
    await enforceRateLimit("netease", 800, signal);
    const params = new URLSearchParams({
      csrf_token: "",
      s: [query.title, query.artist].filter((value) => value.trim()).join(" "),
      type: "1",
      limit: "8",
      offset: "0",
      total: "true",
    });
    const response = await requestProviderJson<NeteaseSearchResponse>(
      "netease",
      `https://music.163.com/api/search/get/web?${params.toString()}`,
      timeoutMs,
      signal,
    );
    if (response.code !== 200 || !response.result) {
      throw new Error("网易云音乐返回了无法识别的搜索结果");
    }

    const matches = (response.result.songs ?? [])
      .slice(0, 20)
      .map((song): LyricsCandidate | null => {
        if (!validNumber(song.id) || typeof song.name !== "string") return null;
        const artists = song.artists ?? song.ar ?? [];
        const durationMs = validNumber(song.duration) ? song.duration : song.dt;
        const candidateBase = {
          id: `netease:${song.id}`,
          providerId: "netease",
          providerName: "网易云音乐",
          title: song.name,
          artist: artists.map((artist) => artist.name?.trim()).filter(Boolean).join(" / ") || "未知艺术家",
          album: song.album?.name?.trim() || song.al?.name?.trim() || undefined,
          duration: validNumber(durationMs) ? durationMs / 1_000 : undefined,
          instrumental: false,
          formatHint: "lrc" as const,
          content: "",
          reference: `https://music.163.com/#/song?id=${song.id}`,
        };
        return {
          ...candidateBase,
          score: scoreLyricsCandidate(query, candidateBase),
        };
      })
      .filter((candidate): candidate is LyricsCandidate => candidate !== null)
      .sort(compareLyricsCandidates)
      .slice(0, 4);

    const lyricTargets = (matches[0]?.score.total ?? 0) >= DEFAULT_LYRICS_MATCH_THRESHOLD
      ? matches.slice(0, 1)
      : matches;

    const settled = await Promise.allSettled(lyricTargets.map(async (candidate) => {
      const id = candidate.id.slice("netease:".length);
      const lyricParams = new URLSearchParams({
        id,
        lv: "-1",
        tv: "-1",
        rv: "-1",
        kv: "-1",
      });
      const lyrics = await requestProviderJson<NeteaseLyricsResponse>(
        "netease",
        `https://music.163.com/api/song/lyric?${lyricParams.toString()}`,
        timeoutMs,
        signal,
      );
      if (lyrics.code !== 200) throw new Error("网易云音乐返回了无法识别的歌词数据");
      if (lyrics.nolyric || lyrics.uncollected) return null;
      const primary = typeof lyrics.lrc?.lyric === "string" ? lyrics.lrc.lyric : "";
      const translation = typeof lyrics.tlyric?.lyric === "string" ? lyrics.tlyric.lyric : "";
      const content = combineTranslatedLrc(primary, translation);
      if (!content) return null;
      return {
        ...candidate,
        content,
        formatHint: hasLrcTimestamps(primary) ? "lrc" as const : "plain" as const,
      };
    }));

    const candidates: LyricsCandidate[] = [];
    let firstError: unknown;
    for (const result of settled) {
      if (result.status === "fulfilled") {
        if (result.value) candidates.push(result.value);
      } else if (firstError === undefined) {
        firstError = result.reason;
      }
    }
    if (signal.aborted) throw abortError();
    if (candidates.length === 0 && firstError !== undefined) throw firstError;
    if (import.meta.env.DEV) {
      console.info("[lyrics] provider response", { provider: "netease", results: candidates.length });
    }
    return candidates.sort(compareLyricsCandidates);
  },
  async get(candidate, signal) {
    if (signal.aborted) throw abortError();
    return candidateToSource(candidate);
  },
};

const lrclibProvider: LyricsProviderDefinition = {
  id: "lrclib",
  name: "LRCLIB",
  description: "开放歌词资料库；本地无歌词时按歌曲信息检索。",
  capabilities: ["line"],
  defaultEnabled: true,
  defaultPriority: 20,
  defaultTimeoutMs: 15_000,
  rateLimitMs: 1_200,
  async search(query, signal, timeoutMs) {
    await enforceRateLimit("lrclib", 1_200, signal);
    const params = new URLSearchParams({ track_name: query.title });
    if (query.artist.trim()) params.set("artist_name", query.artist);
    if (query.album?.trim()) params.set("album_name", query.album);
    const url = `https://lrclib.net/api/search?${params.toString()}`;
    const response = await requestProviderJson<unknown>("lrclib", url, timeoutMs, signal);
    if (!Array.isArray(response)) throw new Error("LRCLIB 返回了无法识别的数据");
    if (import.meta.env.DEV) {
      console.info("[lyrics] provider response", { provider: "lrclib", results: response.length });
    }

    return response
      .slice(0, 30)
      .map((item): LyricsCandidate | null => {
        const value = item as LrcLibResult;
        if (typeof value.id !== "number" || typeof value.trackName !== "string") return null;
        const synced = typeof value.syncedLyrics === "string" ? value.syncedLyrics.trim() : "";
        const plain = typeof value.plainLyrics === "string" ? value.plainLyrics.trim() : "";
        const content = synced || plain;
        const candidateBase = {
          id: `lrclib:${value.id}`,
          providerId: "lrclib",
          providerName: "LRCLIB",
          title: value.trackName,
          artist: value.artistName?.trim() || "未知艺术家",
          album: value.albumName?.trim() || undefined,
          duration: validNumber(value.duration) ? value.duration : undefined,
          instrumental: Boolean(value.instrumental),
          formatHint: synced ? "lrc" as const : "plain" as const,
          content,
          reference: `https://lrclib.net/api/get/${value.id}`,
        };
        return {
          ...candidateBase,
          score: scoreLyricsCandidate(query, candidateBase),
        };
      })
      .filter((candidate): candidate is LyricsCandidate => (
        candidate !== null && Boolean(candidate.content) && !candidate.instrumental
      ))
      .sort(compareLyricsCandidates);
  },
  async get(candidate, signal) {
    if (signal.aborted) throw abortError();
    return candidateToSource(candidate);
  },
};

export const LYRICS_PROVIDERS: LyricsProviderDefinition[] = [
  amllTtmlProvider,
  neteaseProvider,
  lrclibProvider,
];

export async function searchLyricsProviders(
  query: LyricsQuery,
  configs: LyricsProviderConfig[],
  signal: AbortSignal,
): Promise<LyricsProviderSearchResult> {
  const configById = new Map(configs.map((config) => [config.id, config]));
  const enabled = LYRICS_PROVIDERS
    .map((provider) => ({ provider, config: configById.get(provider.id) }))
    .filter((entry): entry is { provider: LyricsProviderDefinition; config: LyricsProviderConfig } => (
      Boolean(entry.config?.enabled)
    ))
    .sort((left, right) => left.config.priority - right.config.priority);
  const candidates: LyricsCandidate[] = [];
  const errors: LyricsProviderSearchResult["errors"] = [];
  for (const { provider, config } of enabled) {
    if (signal.aborted) throw abortError();
    try {
      const providerCandidates = await provider.search(query, signal, config.timeoutMs);
      candidates.push(...providerCandidates);
      if (pickBestLyricsCandidate(providerCandidates)) break;
    } catch (error) {
      if (signal.aborted) throw error;
      errors.push({
        providerId: provider.id,
        providerName: provider.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    candidates: candidates.sort((left, right) => {
      const scoreOrder = compareLyricsCandidates(left, right);
      if (scoreOrder !== 0) return scoreOrder;
      return (configById.get(left.providerId)?.priority ?? 999)
        - (configById.get(right.providerId)?.priority ?? 999);
    }),
    errors,
  };
}

export async function getLyricsCandidateSource(candidate: LyricsCandidate, signal: AbortSignal) {
  const provider = LYRICS_PROVIDERS.find((item) => item.id === candidate.providerId);
  if (!provider) throw new Error("歌词来源已不可用");
  return provider.get(candidate, signal);
}

function candidateToSource(candidate: LyricsCandidate): LyricsSource {
  return {
    source_id: `provider:${candidate.id}`,
    origin: "provider",
    format_hint: candidate.formatHint,
    label: `${candidate.providerName} · ${candidate.title}`,
    content: candidate.content,
    modified_at: null,
    is_manual: false,
    provider_id: candidate.providerId,
    reference: candidate.reference,
  };
}

async function requestProviderJson<T>(
  providerId: string,
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const raw = await requestProviderText(providerId, url, timeoutMs, signal);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("在线歌词来源返回了无法识别的数据");
  }
}

async function requestProviderText(
  providerId: string,
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  return raceWithAbort(invokeProviderText(providerId, url, timeoutMs), signal);
}

function invokeProviderText(providerId: string, url: string, timeoutMs: number) {
  if (import.meta.env.DEV) {
    console.info("[lyrics] provider request", { provider: providerId, timeoutMs });
  }
  return invoke<string>("request_lyrics_provider", { providerId, url, timeoutMs });
}

async function loadAmllIndex(signal: AbortSignal, timeoutMs: number) {
  if (amllIndexCache) return amllIndexCache;
  if (!amllIndexRequest) {
    amllIndexRequest = invokeProviderText("amll-ttml-db", AMLL_INDEX_URL, timeoutMs)
      .then((content) => {
        const entries = parseAmllTtmlIndex(content);
        if (entries.length === 0) throw new Error("AMLL TTML DB 索引无法解析");
        amllIndexCache = entries;
        if (import.meta.env.DEV) {
          console.info("[lyrics] provider index ready", {
            provider: "amll-ttml-db",
            entries: entries.length,
          });
        }
        return entries;
      })
      .catch((error) => {
        amllIndexRequest = null;
        throw error;
      });
  }
  return raceWithAbort(amllIndexRequest, signal);
}

async function enforceRateLimit(providerId: string, intervalMs: number, signal: AbortSignal) {
  const wait = Math.max(0, (lastRequestAt.get(providerId) ?? 0) + intervalMs - Date.now());
  if (wait > 0) await abortableDelay(wait, signal);
  if (signal.aborted) throw abortError();
  lastRequestAt.set(providerId, Date.now());
}

function abortableDelay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, duration);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject<T>(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError() {
  return new DOMException("Lyrics request aborted", "AbortError");
}

function validNumber(value?: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasLrcTimestamps(value: string) {
  return /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(value);
}
