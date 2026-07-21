import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LocalLyricsSource, LyricsDocument, Track } from "../types";
import { createDemoLyrics } from "../utils/demoLyrics";
import { parseLyricsSource } from "../utils/lyrics";

const LYRICS_STORAGE_KEY = "zone-local-lyrics-v1";
const MAX_CACHE_ENTRIES = 80;

type CacheEntry = {
  sourceId: string;
  modifiedAt: number | null;
  duration: number;
  document: LyricsDocument;
  updatedAt: number;
};

type LyricsStore = {
  bindings: Record<string, string>;
  cache: Record<string, CacheEntry>;
};

export type LyricsState = {
  status: "idle" | "loading" | "ready" | "missing" | "error";
  document: LyricsDocument | null;
  sourceLabel?: string;
  isManual: boolean;
  isDemo: boolean;
  error?: string;
};

const EMPTY_STORE: LyricsStore = { bindings: {}, cache: {} };

export function useLyrics(track: Track | null, duration: number) {
  const [store, setStore] = useState<LyricsStore>(readLyricsStore);
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<LyricsState>({
    status: track ? "loading" : "idle",
    document: null,
    isManual: false,
    isDemo: false,
  });
  const manualPath = track ? store.bindings[track.id] : undefined;
  const resolvedDuration = duration > 0 ? duration : track?.duration_seconds ?? 0;

  useEffect(() => {
    if (!track) {
      setState({ status: "idle", document: null, isManual: false, isDemo: false });
      return;
    }

    let stale = false;
    setState((current) => ({ ...current, status: "loading", document: null, error: undefined }));
    void invoke<LocalLyricsSource | null>("load_local_lyrics", {
      trackPath: track.path,
      manualPath: manualPath ?? null,
    })
      .then((source) => {
        if (stale) return;
        if (!source) {
          if (import.meta.env.DEV) {
            setState({
              status: "ready",
              document: createDemoLyrics(track, resolvedDuration),
              sourceLabel: "动效预览",
              isManual: false,
              isDemo: true,
            });
          } else {
            setState({ status: "missing", document: null, isManual: false, isDemo: false });
          }
          return;
        }

        const cached = store.cache[track.id];
        const modifiedAt = source.modified_at ?? null;
        const document = cached?.sourceId === source.source_id
          && cached.modifiedAt === modifiedAt
          && Math.abs((cached.duration ?? -1) - resolvedDuration) < 0.02
          ? cached.document
          : parseLyricsSource(track.id, source, resolvedDuration);
        if (!document) {
          setState({
            status: "error",
            document: null,
            sourceLabel: source.label,
            isManual: source.is_manual,
            isDemo: false,
            error: "歌词内容无法解析",
          });
          return;
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
          isManual: source.is_manual,
          isDemo: false,
        });
      })
      .catch((error: unknown) => {
        if (stale) return;
        setState({
          status: "error",
          document: null,
          sourceLabel: manualPath ? fileName(manualPath) : undefined,
          isManual: Boolean(manualPath),
          isDemo: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      stale = true;
    };
  }, [manualPath, reloadToken, resolvedDuration, track?.id, track?.path]);

  const selectFile = useCallback(async () => {
    if (!track) return;
    const path = await invoke<string | null>("select_lyrics_file");
    if (!path) return;
    setStore((current) => persistLyricsStore({
      ...current,
      bindings: { ...current.bindings, [track.id]: path },
    }));
  }, [track]);

  const clearManualBinding = useCallback(() => {
    if (!track) return;
    setStore((current) => {
      const bindings = { ...current.bindings };
      delete bindings[track.id];
      return persistLyricsStore({ ...current, bindings });
    });
  }, [track]);

  const retry = useCallback(() => setReloadToken((value) => value + 1), []);
  return { ...state, selectFile, clearManualBinding, retry };
}

function cacheDocument(
  store: LyricsStore,
  trackId: string,
  source: LocalLyricsSource,
  document: LyricsDocument,
  duration: number,
): LyricsStore {
  const entries = Object.entries({
    ...store.cache,
    [trackId]: {
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

function readLyricsStore(): LyricsStore {
  try {
    const raw = localStorage.getItem(LYRICS_STORAGE_KEY);
    if (!raw) return EMPTY_STORE;
    const parsed = JSON.parse(raw) as Partial<LyricsStore>;
    return {
      bindings: parsed.bindings && typeof parsed.bindings === "object" ? parsed.bindings : {},
      cache: parsed.cache && typeof parsed.cache === "object" ? parsed.cache : {},
    };
  } catch {
    return EMPTY_STORE;
  }
}

function persistLyricsStore(store: LyricsStore) {
  localStorage.setItem(LYRICS_STORAGE_KEY, JSON.stringify(store));
  return store;
}

function fileName(path: string) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
