import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  appliedAlbumCoverProviderIds,
  applyMetadataOverlays,
  appliedArtistProviderIds,
  artistNeedsAutomaticEnrichment,
  automaticArtistTrackScope,
  metadataTrackInput,
  normalizeArtistIdentity,
  selectAlbumsForAutomaticBackfill,
  selectArtistsForAutomaticBackfill,
  selectAutomaticAlbumCandidate,
  selectAutomaticArtistCandidate,
} from "../utils/metadata";
import type {
  ContextPayload,
  MetadataCandidate,
  MetadataContextRecord,
  MetadataEntityKind,
  MetadataManualField,
  MetadataProviderDescriptor,
  MetadataTrackOverlay,
  Track,
} from "../types";

type SetTracks = React.Dispatch<React.SetStateAction<Track[]>>;

const METADATA_PROVIDER_STORAGE_KEY = "zone-metadata-providers-v1";
const NETEASE_MUSIC_PROVIDER_ID = "netease-music";
const LEGACY_NETEASE_ARTIST_PROVIDER_ID = "netease-artist";
const AUTO_ARTIST_RETRY_MS = 30 * 60 * 1_000;
const ARTIST_BACKFILL_START_DELAY_MS = 12_000;
const ARTIST_BACKFILL_ARTIST_DELAY_MS = 2_000;

export type MetadataEnrichmentApi = {
  providers: MetadataProviderDescriptor[];
  setProviderEnabled: (providerId: string, enabled: boolean) => void;
  getContext: (payload: ContextPayload) => Promise<MetadataContextRecord | null>;
  search: (payload: ContextPayload, query?: string) => Promise<MetadataCandidate[]>;
  apply: (payload: ContextPayload, candidate: MetadataCandidate) => Promise<MetadataContextRecord | null>;
  edit: (payload: ContextPayload, fields: MetadataManualField[]) => Promise<MetadataContextRecord | null>;
  clear: (payload: ContextPayload) => Promise<void>;
  enrichArtistForPlayback: (track: Track) => Promise<boolean>;
};

function metadataKind(payload: ContextPayload): MetadataEntityKind {
  if (payload.kind === "playlist") {
    throw new Error("播放列表暂不支持补充信息");
  }
  return payload.kind;
}

function metadataInputs(payload: ContextPayload) {
  return payload.tracks.map(metadataTrackInput);
}

function readProviderPreferences(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(METADATA_PROVIDER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const preferences = Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => (
        typeof entry[1] === "boolean"
      )),
    );
    if (
      preferences[NETEASE_MUSIC_PROVIDER_ID] === undefined
      && preferences[LEGACY_NETEASE_ARTIST_PROVIDER_ID] !== undefined
    ) {
      preferences[NETEASE_MUSIC_PROVIDER_ID] =
        preferences[LEGACY_NETEASE_ARTIST_PROVIDER_ID];
    }
    return preferences;
  } catch {
    return {};
  }
}

export function useMetadataEnrichment({
  tracks,
  setTracks,
  restored,
}: {
  tracks: Track[];
  setTracks: SetTracks;
  restored: boolean;
}): MetadataEnrichmentApi {
  const writableRef = useRef(restored);
  writableRef.current = restored;
  const [providerDescriptors, setProviderDescriptors] = useState<MetadataProviderDescriptor[]>([]);
  const [providerPreferences, setProviderPreferences] = useState(readProviderPreferences);
  const [revision, setRevision] = useState(0);
  const automaticArtistAttemptsRef = useRef(new Map<string, number>());
  const providers = useMemo(() => providerDescriptors.map((provider) => ({
    ...provider,
    enabled: provider.available && (providerPreferences[provider.id] ?? provider.enabled),
  })), [providerDescriptors, providerPreferences]);
  const trackIdsKey = useMemo(() => tracks.map((track) => track.id).join("\u0000"), [tracks]);
  const trackOverlayStateKey = useMemo(() => tracks.map((track) => (
    `${track.id}:${track.local_metadata ? "enriched" : "local"}`
  )).join("\u0000"), [tracks]);

  useEffect(() => {
    let cancelled = false;
    void invoke<MetadataProviderDescriptor[]>("metadata_list_providers")
      .then((result) => {
        if (!cancelled) setProviderDescriptors(result);
      })
      .catch((error) => {
        if (import.meta.env.DEV) console.warn("[metadata] provider list failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setProviderEnabled = useCallback((providerId: string, enabled: boolean) => {
    setProviderPreferences((current) => {
      const next = { ...current, [providerId]: enabled };
      try {
        localStorage.setItem(METADATA_PROVIDER_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // The current session still uses the preference when storage is unavailable.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!restored) return;
    if (!trackIdsKey) {
      setTracks((current) => applyMetadataOverlays(current, []));
      return;
    }

    let cancelled = false;
    const trackIds = trackIdsKey.split("\u0000");
    void invoke<MetadataTrackOverlay[]>("metadata_get_track_overlays", { trackIds })
      .then((overlays) => {
        if (!cancelled) setTracks((current) => applyMetadataOverlays(current, overlays));
      })
      .catch((error) => {
        if (import.meta.env.DEV) console.warn("[metadata] overlay load failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [restored, revision, setTracks, trackIdsKey, trackOverlayStateKey]);

  const getContext = useCallback(async (payload: ContextPayload) => {
    if (payload.kind === "playlist") return null;
    return invoke<MetadataContextRecord | null>("metadata_get_context", {
      kind: metadataKind(payload),
      trackIds: payload.tracks.map((track) => track.id),
    });
  }, []);

  const providerRetryAtRef = useRef(new Map<string, number>());
  const search = useCallback(async (payload: ContextPayload, query?: string, automatic = false) => {
    const kind = metadataKind(payload);
    const cleanQuery = query?.trim();
    const tracks = metadataInputs(payload).map((track) => {
      if (!cleanQuery) return track;
      if (kind === "track") return { ...track, title: cleanQuery };
      if (kind === "album") return { ...track, album: cleanQuery };
      return { ...track, artist: cleanQuery };
    });
    const enabled = new Set(
      providers.filter((provider) => provider.enabled).map((provider) => provider.id),
    );
    const requests: Promise<MetadataCandidate[]>[] = [];
    if (enabled.has("local-sidecar")) {
      requests.push(
        invoke<MetadataCandidate[]>("metadata_search_sidecars", { kind, tracks }),
      );
    }
    if (kind !== "artist" && enabled.has("apple-music-cn")) {
      requests.push(
        invoke<MetadataCandidate[]>("metadata_search_apple_music", { kind, tracks }),
      );
    }
    if (enabled.has(NETEASE_MUSIC_PROVIDER_ID) && (!automatic || Date.now() >= (providerRetryAtRef.current.get(NETEASE_MUSIC_PROVIDER_ID) ?? 0))) {
      requests.push(
        invoke<MetadataCandidate[]>("metadata_search_netease_music", { kind, tracks }).catch(error => {
          if (/暂不可用|响应超时|无法连接|返回错误/.test(String(error))) providerRetryAtRef.current.set(NETEASE_MUSIC_PROVIDER_ID, Date.now() + 5 * 60 * 1000);
          throw error;
        }),
      );
    }
    if (requests.length === 0) {
      throw new Error("没有启用支持此类信息的补充来源");
    }
    const results = await Promise.allSettled(requests);
    const candidates = results
      .filter((result): result is PromiseFulfilledResult<MetadataCandidate[]> => (
        result.status === "fulfilled"
      ))
      .flatMap((result) => result.value)
      .sort((left, right) => right.confidence - left.confidence);
    if (candidates.length === 0) {
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => String(result.reason));
      if (errors.length > 0) throw new Error(errors.join("；"));
    }
    return candidates;
  }, [providers]);

  const apply = useCallback(async (payload: ContextPayload, candidate: MetadataCandidate) => {
    if (!writableRef.current) throw new Error("资料库尚未恢复，补充资料保存已暂停");
    const kind = metadataKind(payload);
    const command = candidate.providerId === "local-sidecar"
      ? "metadata_apply_sidecar"
      : candidate.providerId === "apple-music-cn"
        ? "metadata_apply_apple_music"
        : candidate.providerId === NETEASE_MUSIC_PROVIDER_ID
          ? "metadata_apply_netease_music"
          : null;
    if (!command) {
      throw new Error("这个补充来源暂不支持采用");
    }
    await invoke(command, {
      candidateId: candidate.id,
      kind,
      tracks: metadataInputs(payload),
    });
    setRevision((current) => current + 1);
    return invoke<MetadataContextRecord | null>("metadata_get_context", {
      kind,
      trackIds: payload.tracks.map((track) => track.id),
    });
  }, []);

  const edit = useCallback(async (payload: ContextPayload, fields: MetadataManualField[]) => {
    if (!writableRef.current) throw new Error("资料库尚未恢复，补充资料保存已暂停");
    const kind = metadataKind(payload);
    await invoke("metadata_apply_manual", {
      kind,
      tracks: metadataInputs(payload),
      fields,
    });
    setRevision((current) => current + 1);
    return invoke<MetadataContextRecord | null>("metadata_get_context", {
      kind,
      trackIds: payload.tracks.map((track) => track.id),
    });
  }, []);

  const clear = useCallback(async (payload: ContextPayload) => {
    if (!writableRef.current) throw new Error("资料库尚未恢复，补充资料保存已暂停");
    await invoke("metadata_clear_context", {
      kind: metadataKind(payload),
      trackIds: payload.tracks.map((track) => track.id),
    });
    setRevision((current) => current + 1);
  }, []);

  const enrichArtistForPlayback = useCallback(async (track: Track) => {
    if (!artistNeedsAutomaticEnrichment(track)) return false;
    const scope = automaticArtistTrackScope(tracks, track);
    if (scope.length === 0) return false;
    const automaticProviders = providers
      .filter((provider) => (
        provider.enabled
        && (provider.id === "local-sidecar" || provider.id === NETEASE_MUSIC_PROVIDER_ID)
      ))
      .map((provider) => provider.id)
      .sort();
    if (automaticProviders.length === 0) return false;

    const appliedProviderIds = appliedArtistProviderIds(track);
    const appliedProvidersKey = [...appliedProviderIds].sort().join(",");
    const attemptKey = `${normalizeArtistIdentity(track.artist)}\u0000${automaticProviders.join(",")}\u0000${appliedProvidersKey}`;
    const now = Date.now();
    const previousAttempt = automaticArtistAttemptsRef.current.get(attemptKey) ?? 0;
    if (now - previousAttempt < AUTO_ARTIST_RETRY_MS) return false;
    automaticArtistAttemptsRef.current.set(attemptKey, now);

    const payload: ContextPayload = {
      kind: "artist",
      title: track.artist,
      subtitle: `${scope.length} 首歌曲`,
      tracks: scope,
    };
    try {
      const candidate = selectAutomaticArtistCandidate(
        await search(payload, undefined, true),
        appliedProviderIds,
      );
      if (!candidate) return false;
      await apply(payload, candidate);
      return true;
    } catch (error) {
      if (import.meta.env.DEV) console.warn("[metadata] automatic artist enrichment failed", error);
      return false;
    }
  }, [apply, providers, search, tracks]);

  const tracksRef = useRef(tracks);
  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  // Library backfill: once per restored library snapshot, walk every performer
  // artist that still lacks imagery/biography and try one exact-match lookup
  // each — sequential, throttled and silent. Shares the attempt log with
  // playback enrichment so neither path duplicates the other's network work.
  useEffect(() => {
    if (!restored || !trackIdsKey) return;
    const automaticProviders = providers
      .filter((provider) => (
        provider.enabled
        && (provider.id === "local-sidecar" || provider.id === NETEASE_MUSIC_PROVIDER_ID)
      ))
      .map((provider) => provider.id)
      .sort();
    if (automaticProviders.length === 0) return;
    let cancelled = false;
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    void (async () => {
      await sleep(ARTIST_BACKFILL_START_DELAY_MS);
      const targets = selectArtistsForAutomaticBackfill(tracksRef.current, automaticProviders);
      for (const target of targets) {
        if (cancelled) return;
        const appliedProviderIds = appliedArtistProviderIds(target.profile);
        const attemptKey = `${normalizeArtistIdentity(target.name)}\u0000${automaticProviders.join(",")}\u0000${[...appliedProviderIds].sort().join(",")}`;
        const now = Date.now();
        const previousAttempt = automaticArtistAttemptsRef.current.get(attemptKey) ?? 0;
        if (now - previousAttempt < AUTO_ARTIST_RETRY_MS) continue;
        automaticArtistAttemptsRef.current.set(attemptKey, now);
        const payload: ContextPayload = {
          kind: "artist",
          title: target.name,
          subtitle: `${target.tracks.length} 首歌曲`,
          tracks: target.tracks,
        };
        try {
          const candidate = selectAutomaticArtistCandidate(
            await search(payload, undefined, true),
            appliedProviderIds,
          );
          if (candidate) await apply(payload, candidate);
        } catch (error) {
          if (import.meta.env.DEV) console.warn("[metadata] artist backfill failed", error);
        }
        await sleep(ARTIST_BACKFILL_ARTIST_DELAY_MS);
      }

      // Album covers follow the same pass: album-capable providers, one exact
      // artwork candidate per album, same throttle and shared attempt log.
      const albumProviders = providers
        .filter((provider) => (
          provider.enabled
          && (provider.id === "local-sidecar"
            || provider.id === NETEASE_MUSIC_PROVIDER_ID
            || provider.id === "apple-music-cn")
        ))
        .map((provider) => provider.id)
        .sort();
      if (albumProviders.length === 0) return;
      const albums = selectAlbumsForAutomaticBackfill(tracksRef.current, albumProviders);
      for (const target of albums) {
        if (cancelled) return;
        const appliedProviderIds = new Set(
          target.tracks.flatMap((track) => [...appliedAlbumCoverProviderIds(track)]),
        );
        const attemptKey = `album ${normalizeArtistIdentity(target.artist)}:${normalizeArtistIdentity(target.name)} ${albumProviders.join(",")} ${[...appliedProviderIds].sort().join(",")}`;
        const now = Date.now();
        const previousAttempt = automaticArtistAttemptsRef.current.get(attemptKey) ?? 0;
        if (now - previousAttempt < AUTO_ARTIST_RETRY_MS) continue;
        automaticArtistAttemptsRef.current.set(attemptKey, now);
        const payload: ContextPayload = {
          kind: "album",
          title: target.name,
          subtitle: target.artist,
          tracks: target.tracks,
        };
        try {
          const candidate = selectAutomaticAlbumCandidate(
            await search(payload, undefined, true),
            appliedProviderIds,
          );
          if (candidate) await apply(payload, candidate);
        } catch (error) {
          if (import.meta.env.DEV) console.warn("[metadata] album backfill failed", error);
        }
        await sleep(ARTIST_BACKFILL_ARTIST_DELAY_MS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply, providers, restored, search, trackIdsKey]);

  return useMemo(() => ({
    providers,
    setProviderEnabled,
    getContext,
    search,
    apply,
    edit,
    clear,
    enrichArtistForPlayback,
  }), [
    apply,
    clear,
    edit,
    enrichArtistForPlayback,
    getContext,
    providers,
    search,
    setProviderEnabled,
  ]);
}
