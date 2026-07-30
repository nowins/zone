import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { applyMetadataOverlays, metadataTrackInput } from "../utils/metadata";
import type {
  ContextPayload,
  MetadataCandidate,
  MetadataContextRecord,
  MetadataEntityKind,
  MetadataProviderDescriptor,
  MetadataTrackOverlay,
  Track,
} from "../types";

type SetTracks = React.Dispatch<React.SetStateAction<Track[]>>;

export type MetadataEnrichmentApi = {
  providers: MetadataProviderDescriptor[];
  getContext: (payload: ContextPayload) => Promise<MetadataContextRecord | null>;
  search: (payload: ContextPayload) => Promise<MetadataCandidate[]>;
  apply: (payload: ContextPayload, candidate: MetadataCandidate) => Promise<MetadataContextRecord | null>;
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

export function useMetadataEnrichment({
  tracks,
  setTracks,
  restored,
}: {
  tracks: Track[];
  setTracks: SetTracks;
  restored: boolean;
}): MetadataEnrichmentApi {
  const [providers, setProviders] = useState<MetadataProviderDescriptor[]>([]);
  const [revision, setRevision] = useState(0);
  const trackIdsKey = useMemo(() => tracks.map((track) => track.id).join("\u0000"), [tracks]);
  const trackOverlayStateKey = useMemo(() => tracks.map((track) => (
    `${track.id}:${track.local_metadata ? "enriched" : "local"}`
  )).join("\u0000"), [tracks]);

  useEffect(() => {
    let cancelled = false;
    void invoke<MetadataProviderDescriptor[]>("metadata_list_providers")
      .then((result) => {
        if (!cancelled) setProviders(result);
      })
      .catch((error) => {
        if (import.meta.env.DEV) console.warn("[metadata] provider list failed", error);
      });
    return () => {
      cancelled = true;
    };
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

  const search = useCallback(async (payload: ContextPayload) => {
    const kind = metadataKind(payload);
    const tracks = metadataInputs(payload);
    const requests = [
      invoke<MetadataCandidate[]>("metadata_search_sidecars", { kind, tracks }),
    ];
    if (kind !== "artist") {
      requests.push(
        invoke<MetadataCandidate[]>("metadata_search_apple_music", { kind, tracks }),
      );
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
  }, []);

  const apply = useCallback(async (payload: ContextPayload, candidate: MetadataCandidate) => {
    const kind = metadataKind(payload);
    const command = candidate.providerId === "local-sidecar"
      ? "metadata_apply_sidecar"
      : candidate.providerId === "apple-music-cn"
        ? "metadata_apply_apple_music"
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

  const clear = useCallback(async (payload: ContextPayload) => {
    await invoke("metadata_clear_context", {
      kind: metadataKind(payload),
      trackIds: payload.tracks.map((track) => track.id),
    });
    setRevision((current) => current + 1);
  }, []);

  return useMemo(() => ({
    providers,
    getContext,
    search,
    apply,
    clear,
  }), [apply, clear, getContext, providers, search]);
}
