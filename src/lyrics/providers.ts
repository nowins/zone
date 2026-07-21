import { invoke } from "@tauri-apps/api/core";
import type {
  LyricsCandidate,
  LyricsProviderConfig,
  LyricsProviderDefinition,
  LyricsQuery,
  LyricsSource,
} from "../types";
import { compareLyricsCandidates, scoreLyricsCandidate } from "../utils/lyricsProviders";

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

const lrclibProvider: LyricsProviderDefinition = {
  id: "lrclib",
  name: "LRCLIB",
  description: "开放歌词资料库；本地无歌词时按歌曲信息检索。",
  capabilities: ["line"],
  defaultEnabled: true,
  defaultPriority: 10,
  defaultTimeoutMs: 15_000,
  rateLimitMs: 1_200,
  async search(query, signal, timeoutMs) {
    await enforceRateLimit("lrclib", 1_200, signal);
    const params = new URLSearchParams({ track_name: query.title });
    if (query.artist.trim()) params.set("artist_name", query.artist);
    if (query.album?.trim()) params.set("album_name", query.album);
    const url = `https://lrclib.net/api/search?${params.toString()}`;
    if (import.meta.env.DEV) {
      console.info("[lyrics] provider request", { provider: "lrclib", timeoutMs });
    }
    const raw = await raceWithAbort(
      invoke<string>("request_lyrics_provider", {
        providerId: "lrclib",
        url,
        timeoutMs,
      }),
      signal,
    );
    const response = JSON.parse(raw) as unknown;
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
          artist: value.artistName?.trim() || "Unknown artist",
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

export const LYRICS_PROVIDERS: LyricsProviderDefinition[] = [lrclibProvider];

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
  const settled = await Promise.all(enabled.map(async ({ provider, config }) => {
    try {
      const candidates = await provider.search(query, signal, config.timeoutMs);
      return { candidates, error: null };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        candidates: [] as LyricsCandidate[],
        error: {
          providerId: provider.id,
          providerName: provider.name,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }));

  return {
    candidates: settled.flatMap((result) => result.candidates).sort((left, right) => {
      const scoreOrder = compareLyricsCandidates(left, right);
      if (scoreOrder !== 0) return scoreOrder;
      return (configById.get(left.providerId)?.priority ?? 999)
        - (configById.get(right.providerId)?.priority ?? 999);
    }),
    errors: settled.flatMap((result) => result.error ? [result.error] : []),
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
