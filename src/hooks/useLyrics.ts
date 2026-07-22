import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  LocalLyricsSource,
  LyricsCandidate,
  LyricsDocument,
  LyricsQuery,
  LyricsSearchMetadata,
  LyricsSource,
  Track,
} from "../types";
import { createDemoLyrics } from "../utils/demoLyrics";
import { parseLyricsSource } from "../utils/lyrics";
import { clampLyricsTimingOffset } from "../utils/lyricsTiming";
import {
  defaultLyricsSearchMetadata,
  isDefaultLyricsSearchMetadata,
  lyricsQueryForTrack,
  lyricsQueryKey,
  normalizeLyricsSearchMetadata,
} from "../utils/lyricsSearch";
import { pickBestLyricsCandidate } from "../utils/lyricsProviders";
import { getLyricsCandidateSource, searchLyricsProviders } from "../lyrics/providers";
import { useLyricsProviderSettings } from "./useLyricsProviderSettings";

const LYRICS_STORAGE_KEY = "zone-local-lyrics-v1";
const LYRICS_TIMING_STORAGE_KEY = "zone-lyrics-timing-v1";
const LYRICS_PARSER_VERSION = 2;
const MAX_CACHE_ENTRIES = 80;
const MAX_REMOTE_CACHE_ENTRIES = 24;
const MAX_REMOTE_CANDIDATES = 8;
const MAX_TIMING_ENTRIES = 160;
const MAX_QUERY_OVERRIDE_ENTRIES = 160;

type CacheEntry = {
  parserVersion?: number;
  sourceId: string;
  modifiedAt: number | null;
  duration: number;
  document: LyricsDocument;
  updatedAt: number;
};

type RemoteCacheEntry = {
  queryKey: string;
  providerKey: string;
  candidates: LyricsCandidate[];
  autoSourceId?: string;
  updatedAt: number;
};

type LyricsStore = {
  bindings: Record<string, string>;
  providerBindings: Record<string, string>;
  cache: Record<string, CacheEntry>;
  remoteCache: Record<string, RemoteCacheEntry>;
  queryOverrides: Record<string, LyricsSearchOverride>;
};

type LyricsSearchOverride = LyricsSearchMetadata & {
  updatedAt: number;
};

type LyricsTimingEntry = {
  offsetMs: number;
  updatedAt: number;
};

type LyricsTimingStore = Record<string, LyricsTimingEntry>;

export type LyricsState = {
  status: "idle" | "loading" | "ready" | "missing" | "error";
  document: LyricsDocument | null;
  sourceLabel?: string;
  sourceProviderId?: string;
  isManual: boolean;
  isDemo: boolean;
  error?: string;
};

export type LyricsOnlineSearchState = {
  status: "idle" | "loading" | "ready" | "error";
  candidates: LyricsCandidate[];
  errors: string[];
  attempt: number;
};

const EMPTY_STORE: LyricsStore = {
  bindings: {},
  providerBindings: {},
  cache: {},
  remoteCache: {},
  queryOverrides: {},
};

export function useLyrics(track: Track | null, duration: number) {
  const { configs: providerConfigs } = useLyricsProviderSettings();
  const [store, setStore] = useState<LyricsStore>(readLyricsStore);
  const [timingStore, setTimingStore] = useState<LyricsTimingStore>(readLyricsTimingStore);
  const [reloadToken, setReloadToken] = useState(0);
  const forceRemoteTrackRef = useRef<string | null>(null);
  const manualSearchControllerRef = useRef<AbortController | null>(null);
  const queryRef = useRef<LyricsQuery | null>(null);
  const suppressQueryReloadKeyRef = useRef<string | null>(null);
  const activeTrackIdRef = useRef(track?.id);
  const [state, setState] = useState<LyricsState>({
    status: track ? "loading" : "idle",
    document: null,
    isManual: false,
    isDemo: false,
  });
  const [onlineSearch, setOnlineSearch] = useState<LyricsOnlineSearchState>({
    status: "idle",
    candidates: [],
    errors: [],
    attempt: 0,
  });
  const manualPath = track ? store.bindings[track.id] : undefined;
  const providerBindingId = track ? store.providerBindings[track.id] : undefined;
  const queryOverride = track ? store.queryOverrides[track.id] : undefined;
  const resolvedDuration = duration > 0 ? duration : track?.duration_seconds ?? 0;
  const searchMetadata = track
    ? queryOverride ?? defaultLyricsSearchMetadata(track)
    : null;
  const query = useMemo(() => track ? lyricsQueryForTrack(track, resolvedDuration, searchMetadata ?? undefined) : null, [
    resolvedDuration,
    track?.id,
    searchMetadata?.album,
    searchMetadata?.artist,
    searchMetadata?.title,
  ]);
  queryRef.current = query;
  const providerConfigKey = providerConfigs
    .map((config) => `${config.id}:${config.enabled}:${config.priority}:${config.timeoutMs}`)
    .join("|");
  const hasOnlineProviders = providerConfigs.some((config) => config.enabled);
  const timingKey = track && state.document
    ? lyricsTimingKey(track.id, state.document.sourceId)
    : null;
  const timingOffsetMs = timingKey ? timingStore[timingKey]?.offsetMs ?? 0 : 0;
  activeTrackIdRef.current = track?.id;

  useEffect(() => {
    if (!track || !query) {
      setState({ status: "idle", document: null, isManual: false, isDemo: false });
      setOnlineSearch({ status: "idle", candidates: [], errors: [], attempt: 0 });
      return;
    }
    const activeQueryKey = trackLyricsQueryKey(track.id, query);
    if (suppressQueryReloadKeyRef.current === activeQueryKey) {
      suppressQueryReloadKeyRef.current = null;
      return;
    }

    const controller = new AbortController();
    let stale = false;
    const remoteEntry = store.remoteCache[track.id];
    const remoteCacheMatchesQuery = remoteEntry?.queryKey === lyricsQueryKey(query)
      && remoteEntry?.providerKey === providerConfigKey;
    const forceRemote = forceRemoteTrackRef.current === track.id;
    if (forceRemote) forceRemoteTrackRef.current = null;
    setState((current) => ({ ...current, status: "loading", document: null, error: undefined }));
    setOnlineSearch(remoteCacheMatchesQuery && remoteEntry?.candidates.length
      ? { status: "ready", candidates: remoteEntry.candidates, errors: [], attempt: 0 }
      : { status: "idle", candidates: [], errors: [], attempt: 0 });

    const presentSource = (source: LyricsSource, manualOverride = false) => {
      if (stale) return false;
      const cached = store.cache[track.id];
      const modifiedAt = source.modified_at ?? null;
      const document = cached?.parserVersion === LYRICS_PARSER_VERSION
        && cached.sourceId === source.source_id
        && cached.modifiedAt === modifiedAt
        && Math.abs((cached.duration ?? -1) - resolvedDuration) < 0.02
        ? cached.document
        : parseLyricsSource(track.id, source, resolvedDuration);
      if (!document) {
        setState({
          status: "error",
          document: null,
          sourceLabel: source.label,
          sourceProviderId: source.provider_id,
          isManual: manualOverride || source.is_manual,
          isDemo: false,
          error: "歌词内容无法解析",
        });
        return false;
      }

      if (document !== cached?.document) {
        setStore((current) => persistLyricsStore(cacheDocument(
          current,
          track.id,
          source,
          document,
          resolvedDuration,
        )));
      }
      setState({
        status: "ready",
        document,
        sourceLabel: source.label,
        sourceProviderId: source.provider_id,
        isManual: manualOverride || source.is_manual,
        isDemo: false,
      });
      return true;
    };

    const showFallback = (error?: string) => {
      if (stale) return;
      if (import.meta.env.DEV) {
        setState({
          status: "ready",
          document: createDemoLyrics(track, resolvedDuration),
          sourceLabel: "动效预览",
          isManual: false,
          isDemo: true,
          error,
        });
      } else {
        setState({
          status: error ? "error" : "missing",
          document: null,
          isManual: false,
          isDemo: false,
          error,
        });
      }
    };

    void (async () => {
      try {
        if (providerBindingId) {
          const bound = remoteEntry?.candidates.find((candidate) => sourceId(candidate) === providerBindingId);
          if (bound) {
            const source = await getLyricsCandidateSource(bound, controller.signal);
            presentSource({ ...source, is_manual: true }, true);
            return;
          }
          setStore((current) => persistLyricsStore(removeProviderBinding(current, track.id)));
        }

        const localSource = await invoke<LocalLyricsSource | null>("load_local_lyrics", {
          trackPath: track.path,
          manualPath: manualPath ?? null,
        });
        if (stale) return;
        if (localSource) {
          presentSource(localSource);
          return;
        }

        const cachedAuto = !forceRemote && remoteCacheMatchesQuery && remoteEntry?.candidates.find(
          (candidate) => sourceId(candidate) === remoteEntry.autoSourceId
            && providerConfigs.some((config) => config.id === candidate.providerId && config.enabled),
        );
        if (cachedAuto) {
          const source = await getLyricsCandidateSource(cachedAuto, controller.signal);
          presentSource(source);
          return;
        }
        if (!forceRemote && remoteCacheMatchesQuery && remoteEntry) {
          showFallback();
          return;
        }

        if (!hasOnlineProviders) {
          showFallback();
          return;
        }

        setOnlineSearch({ status: "loading", candidates: remoteEntry?.candidates ?? [], errors: [], attempt: 1 });
        const result = await searchLyricsProviders(query, providerConfigs, controller.signal);
        if (stale) return;
        const candidates = result.candidates.slice(0, MAX_REMOTE_CANDIDATES);
        const best = pickBestLyricsCandidate(candidates);
        const errors = result.errors.map((item) => `${item.providerName}：${item.message}`);
        setOnlineSearch({
          status: errors.length > 0 && candidates.length === 0 ? "error" : "ready",
          candidates,
          errors,
          attempt: 1,
        });
        setStore((current) => persistLyricsStore(cacheRemoteCandidates(
          current,
          track.id,
          query,
          providerConfigKey,
          candidates,
          best ? sourceId(best) : undefined,
        )));
        if (!best) {
          showFallback(errors.length > 0 ? errors.join("；") : undefined);
          return;
        }
        const source = await getLyricsCandidateSource(best, controller.signal);
        presentSource(source);
      } catch (error) {
        if (stale || controller.signal.aborted) return;
        setState({
          status: "error",
          document: null,
          sourceLabel: manualPath ? fileName(manualPath) : undefined,
          isManual: Boolean(manualPath || providerBindingId),
          isDemo: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      stale = true;
      controller.abort();
    };
  }, [
    manualPath,
    providerBindingId,
    providerConfigKey,
    query,
    reloadToken,
    resolvedDuration,
    track?.id,
    track?.path,
  ]);

  useEffect(() => {
    manualSearchControllerRef.current?.abort();
    manualSearchControllerRef.current = null;
  }, [track?.id]);

  useEffect(() => () => manualSearchControllerRef.current?.abort(), []);

  const selectFile = useCallback(async () => {
    if (!track) return;
    const path = await invoke<string | null>("select_lyrics_file");
    if (!path) return;
    setStore((current) => {
      const providerBindings = { ...current.providerBindings };
      delete providerBindings[track.id];
      return persistLyricsStore({
        ...current,
        providerBindings,
        bindings: { ...current.bindings, [track.id]: path },
      });
    });
  }, [track]);

  const clearManualBinding = useCallback(() => {
    if (!track) return;
    setStore((current) => {
      const bindings = { ...current.bindings };
      const providerBindings = { ...current.providerBindings };
      delete bindings[track.id];
      delete providerBindings[track.id];
      return persistLyricsStore({ ...current, bindings, providerBindings });
    });
  }, [track]);

  const searchOnline = useCallback(async () => {
    const activeQuery = queryRef.current;
    if (!track || !activeQuery || !hasOnlineProviders) return;
    manualSearchControllerRef.current?.abort();
    const controller = new AbortController();
    manualSearchControllerRef.current = controller;
    setOnlineSearch((current) => ({
      ...current,
      status: "loading",
      errors: [],
      attempt: current.attempt + 1,
    }));
    if (import.meta.env.DEV) {
      console.info("[lyrics] manual search triggered", {
        providers: providerConfigs.filter((config) => config.enabled).map((config) => config.id),
      });
    }
    try {
      const result = await searchLyricsProviders(activeQuery, providerConfigs, controller.signal);
      if (controller.signal.aborted) return;
      const candidates = result.candidates.slice(0, MAX_REMOTE_CANDIDATES);
      const errors = result.errors.map((item) => `${item.providerName}：${item.message}`);
      setOnlineSearch((current) => ({
        status: errors.length > 0 && candidates.length === 0 ? "error" : "ready",
        candidates,
        errors,
        attempt: current.attempt,
      }));
      setStore((current) => persistLyricsStore(cacheRemoteCandidates(
        current,
        track.id,
        activeQuery,
        providerConfigKey,
        candidates,
        cachedAutoSourceId(current, track.id, activeQuery),
      )));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (import.meta.env.DEV) console.warn("[lyrics] manual search failed", error);
      setOnlineSearch((current) => ({
        status: "error",
        candidates: [],
        errors: [error instanceof Error ? error.message : String(error)],
        attempt: current.attempt,
      }));
    }
  }, [hasOnlineProviders, providerConfigKey, providerConfigs, track?.id]);

  const selectRemoteCandidate = useCallback(async (candidate: LyricsCandidate) => {
    if (!track) return;
    const expectedTrackId = track.id;
    const controller = new AbortController();
    const source = await getLyricsCandidateSource(candidate, controller.signal);
    if (activeTrackIdRef.current !== expectedTrackId || !parseLyricsSource(track.id, source, resolvedDuration)) return;
    setStore((current) => {
      const bindings = { ...current.bindings };
      delete bindings[track.id];
      const withCandidates = cacheRemoteCandidates(
        current,
        track.id,
        query ?? lyricsQueryForTrack(track, resolvedDuration),
        providerConfigKey,
        mergeCandidate(current.remoteCache[track.id]?.candidates ?? [], candidate),
        cachedAutoSourceId(current, track.id, query ?? lyricsQueryForTrack(track, resolvedDuration)),
      );
      return persistLyricsStore({
        ...withCandidates,
        bindings,
        providerBindings: { ...withCandidates.providerBindings, [track.id]: source.source_id },
      });
    });
  }, [providerConfigKey, query, resolvedDuration, track]);

  const retry = useCallback(() => {
    forceRemoteTrackRef.current = track?.id ?? null;
    setReloadToken((value) => value + 1);
  }, [track?.id]);

  const updateSearchMetadata = useCallback((metadata: LyricsSearchMetadata) => {
    if (!track) return false;
    const normalized = normalizeLyricsSearchMetadata(metadata);
    if (!normalized) return false;
    manualSearchControllerRef.current?.abort();
    const nextQuery = lyricsQueryForTrack(track, resolvedDuration, normalized);
    const queryChanged = !sameLyricsQuery(queryRef.current, nextQuery);
    queryRef.current = nextQuery;
    suppressQueryReloadKeyRef.current = queryChanged ? trackLyricsQueryKey(track.id, nextQuery) : null;
    setStore((current) => persistLyricsStore(setLyricsSearchOverride(current, track, normalized)));
    return true;
  }, [resolvedDuration, track]);

  const resetSearchMetadata = useCallback(() => {
    if (!track) return;
    manualSearchControllerRef.current?.abort();
    const nextQuery = lyricsQueryForTrack(track, resolvedDuration);
    const queryChanged = !sameLyricsQuery(queryRef.current, nextQuery);
    queryRef.current = nextQuery;
    suppressQueryReloadKeyRef.current = queryChanged ? trackLyricsQueryKey(track.id, nextQuery) : null;
    setStore((current) => persistLyricsStore(setLyricsSearchOverride(current, track)));
  }, [resolvedDuration, track]);

  const adjustTimingOffset = useCallback((deltaMs: number) => {
    if (!timingKey) return;
    setTimingStore((current) => {
      const offsetMs = clampLyricsTimingOffset((current[timingKey]?.offsetMs ?? 0) + deltaMs);
      if (offsetMs === 0) {
        const next = { ...current };
        delete next[timingKey];
        return persistLyricsTimingStore(next);
      }
      return persistLyricsTimingStore({
        ...current,
        [timingKey]: { offsetMs, updatedAt: Date.now() },
      });
    });
  }, [timingKey]);

  const resetTimingOffset = useCallback(() => {
    if (!timingKey) return;
    setTimingStore((current) => {
      if (!current[timingKey]) return current;
      const next = { ...current };
      delete next[timingKey];
      return persistLyricsTimingStore(next);
    });
  }, [timingKey]);

  return {
    ...state,
    onlineSearch,
    hasOnlineProviders,
    searchMetadata,
    hasSearchMetadataOverride: Boolean(queryOverride),
    timingOffsetMs,
    selectFile,
    clearManualBinding,
    searchOnline,
    selectRemoteCandidate,
    retry,
    updateSearchMetadata,
    resetSearchMetadata,
    adjustTimingOffset,
    resetTimingOffset,
  };
}

function cacheDocument(
  store: LyricsStore,
  trackId: string,
  source: LyricsSource,
  document: LyricsDocument,
  duration: number,
): LyricsStore {
  const entries = Object.entries({
    ...store.cache,
    [trackId]: {
      parserVersion: LYRICS_PARSER_VERSION,
      sourceId: source.source_id,
      modifiedAt: source.modified_at ?? null,
      duration,
      document,
      updatedAt: Date.now(),
    },
  })
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_CACHE_ENTRIES);
  return { ...store, cache: Object.fromEntries(entries) };
}

function cacheRemoteCandidates(
  store: LyricsStore,
  trackId: string,
  query: LyricsQuery,
  providerKey: string,
  candidates: LyricsCandidate[],
  autoSourceId?: string,
): LyricsStore {
  const nextQueryKey = lyricsQueryKey(query);
  const previousEntry = store.remoteCache[trackId];
  const previousCandidates = previousEntry?.queryKey === nextQueryKey
    ? previousEntry.candidates
    : [];
  const boundSourceId = store.providerBindings[trackId];
  const boundCandidate = previousCandidates.find((candidate) => sourceId(candidate) === boundSourceId);
  const nextCandidates = boundCandidate && !candidates.some((candidate) => candidate.id === boundCandidate.id)
    ? [...candidates.slice(0, MAX_REMOTE_CANDIDATES - 1), boundCandidate]
    : candidates.slice(0, MAX_REMOTE_CANDIDATES);
  const entries = Object.entries({
    ...store.remoteCache,
    [trackId]: {
      queryKey: nextQueryKey,
      providerKey,
      candidates: nextCandidates,
      autoSourceId,
      updatedAt: Date.now(),
    },
  })
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_REMOTE_CACHE_ENTRIES);
  return { ...store, remoteCache: Object.fromEntries(entries) };
}

function cachedAutoSourceId(store: LyricsStore, trackId: string, query: LyricsQuery) {
  const entry = store.remoteCache[trackId];
  return entry?.queryKey === lyricsQueryKey(query) ? entry.autoSourceId : undefined;
}

function removeProviderBinding(store: LyricsStore, trackId: string): LyricsStore {
  const providerBindings = { ...store.providerBindings };
  delete providerBindings[trackId];
  return { ...store, providerBindings };
}

function setLyricsSearchOverride(
  store: LyricsStore,
  track: Track,
  metadata?: LyricsSearchMetadata,
): LyricsStore {
  const queryOverrides = { ...store.queryOverrides };
  if (!metadata || isDefaultLyricsSearchMetadata(track, metadata)) {
    delete queryOverrides[track.id];
  } else {
    queryOverrides[track.id] = { ...metadata, updatedAt: Date.now() };
  }
  const compactOverrides = Object.fromEntries(
    Object.entries(queryOverrides)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_QUERY_OVERRIDE_ENTRIES),
  );
  return { ...store, queryOverrides: compactOverrides };
}

function readLyricsStore(): LyricsStore {
  try {
    const raw = localStorage.getItem(LYRICS_STORAGE_KEY);
    if (!raw) return EMPTY_STORE;
    const parsed = JSON.parse(raw) as Partial<LyricsStore>;
    return {
      bindings: record(parsed.bindings),
      providerBindings: record(parsed.providerBindings),
      cache: record(parsed.cache),
      remoteCache: record(parsed.remoteCache),
      queryOverrides: readLyricsSearchOverrides(parsed.queryOverrides),
    };
  } catch {
    return EMPTY_STORE;
  }
}

function persistLyricsStore(store: LyricsStore) {
  try {
    localStorage.setItem(LYRICS_STORAGE_KEY, JSON.stringify(store));
    return store;
  } catch {
    const compact = {
      ...store,
      cache: recentEntries(store.cache, 40),
      remoteCache: recentEntries(store.remoteCache, 8),
      queryOverrides: recentEntries(store.queryOverrides, MAX_QUERY_OVERRIDE_ENTRIES),
    };
    try {
      localStorage.setItem(LYRICS_STORAGE_KEY, JSON.stringify(compact));
      return compact;
    } catch {
      return store;
    }
  }
}

function readLyricsTimingStore(): LyricsTimingStore {
  try {
    const raw = localStorage.getItem(LYRICS_TIMING_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Partial<LyricsTimingEntry>;
      const offsetMs = clampLyricsTimingOffset(candidate.offsetMs ?? 0);
      if (offsetMs === 0) return [];
      return [[key, {
        offsetMs,
        updatedAt: typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
          ? candidate.updatedAt
          : 0,
      }]];
    }));
  } catch {
    return {};
  }
}

function persistLyricsTimingStore(store: LyricsTimingStore) {
  const compact = Object.fromEntries(
    Object.entries(store)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_TIMING_ENTRIES),
  );
  try {
    localStorage.setItem(LYRICS_TIMING_STORAGE_KEY, JSON.stringify(compact));
  } catch {
    // Keep the in-memory calibration available when storage is unavailable.
  }
  return compact;
}

function readLyricsSearchOverrides(value: unknown): Record<string, LyricsSearchOverride> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([trackId, item]) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<LyricsSearchOverride>;
    if (
      typeof candidate.title !== "string"
      || typeof candidate.artist !== "string"
      || typeof candidate.album !== "string"
    ) return [];
    const metadata = normalizeLyricsSearchMetadata({
      title: candidate.title,
      artist: candidate.artist,
      album: candidate.album,
    });
    if (!metadata) return [];
    return [[trackId, {
      ...metadata,
      updatedAt: typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : 0,
    }]];
  }));
}

function record<T>(value: T | undefined): T extends Record<string, unknown> ? T : Record<string, never> {
  return (value && typeof value === "object" ? value : {}) as T extends Record<string, unknown> ? T : Record<string, never>;
}

function sourceId(candidate: LyricsCandidate) {
  return `provider:${candidate.id}`;
}

function sameLyricsQuery(left: LyricsQuery | null, right: LyricsQuery) {
  if (!left) return false;
  return left.title === right.title
    && left.artist === right.artist
    && left.album === right.album
    && left.duration === right.duration;
}

function trackLyricsQueryKey(trackId: string, query: LyricsQuery) {
  return `${trackId}\u0000${lyricsQueryKey(query)}`;
}

function lyricsTimingKey(trackId: string, sourceId: string) {
  return `${trackId}\u0000${sourceId}`;
}

function mergeCandidate(candidates: LyricsCandidate[], candidate: LyricsCandidate) {
  return [candidate, ...candidates.filter((item) => item.id !== candidate.id)].slice(0, MAX_REMOTE_CANDIDATES);
}

function recentEntries<T extends { updatedAt: number }>(entries: Record<string, T>, limit: number) {
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, limit),
  );
}

function fileName(path: string) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
