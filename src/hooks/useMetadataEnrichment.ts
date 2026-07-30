import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { applyMetadataOverlays, metadataTrackInput } from "../utils/metadata";
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

export type MetadataEnrichmentApi = {
  providers: MetadataProviderDescriptor[];
  setProviderEnabled: (providerId: string, enabled: boolean) => void;
  getContext: (payload: ContextPayload) => Promise<MetadataContextRecord | null>;
  search: (payload: ContextPayload, query?: string) => Promise<MetadataCandidate[]>;
  apply: (payload: ContextPayload, candidate: MetadataCandidate) => Promise<MetadataContextRecord | null>;
  edit: (payload: ContextPayload, fields: MetadataManualField[]) => Promise<MetadataContextRecord | null>;
  clear: (payload: ContextPayload) => Promise<void>;
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
  const [providerDescriptors, setProviderDescriptors] = useState<MetadataProviderDescriptor[]>([]);
  const [providerPreferences, setProviderPreferences] = useState(readProviderPreferences);
  const [revision, setRevision] = useState(0);
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

  const search = useCallback(async (payload: ContextPayload, query?: string) => {
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
    if (enabled.has(NETEASE_MUSIC_PROVIDER_ID)) {
      requests.push(
        invoke<MetadataCandidate[]>("metadata_search_netease_music", { kind, tracks }),
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
    await invoke("metadata_clear_context", {
      kind: metadataKind(payload),
      trackIds: payload.tracks.map((track) => track.id),
    });
    setRevision((current) => current + 1);
  }, []);

  return useMemo(() => ({
    providers,
    setProviderEnabled,
    getContext,
    search,
    apply,
    edit,
    clear,
  }), [apply, clear, edit, getContext, providers, search, setProviderEnabled]);
}
