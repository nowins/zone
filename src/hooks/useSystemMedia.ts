import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
type SystemMediaCommand = {
  action: "play" | "pause" | "toggle" | "previous" | "next" | "seek" | "favorite";
  positionSeconds?: number | null;
};

type SystemMediaCallbacks = {
  onPlay: () => void;
  onPause: () => void;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (positionSeconds: number) => void;
  onFavorite: () => void;
};

type SystemMediaOptions = SystemMediaCallbacks & {
  media: {
    id: string;
    title: string;
    artist: string;
    album: string;
    coverPath?: string | null;
  } | null;
  isPlaying: boolean;
  canPrevious: boolean;
  canNext: boolean;
  duration: number;
  position: number;
  isFavorite: boolean;
};

export function useSystemMedia({
  media,
  isPlaying,
  canPrevious,
  canNext,
  duration,
  position,
  isFavorite,
  onPlay,
  onPause,
  onToggle,
  onPrevious,
  onNext,
  onSeek,
  onFavorite,
}: SystemMediaOptions) {
  const callbacksRef = useRef<SystemMediaCallbacks>({
    onPlay,
    onPause,
    onToggle,
    onPrevious,
    onNext,
    onSeek,
    onFavorite,
  });
  const lastTimelineUpdateRef = useRef(0);
  const lastTimelineTrackRef = useRef<string | null>(null);
  const lastCommandAtRef = useRef(0);

  callbacksRef.current = {
    onPlay,
    onPause,
    onToggle,
    onPrevious,
    onNext,
    onSeek,
    onFavorite,
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<SystemMediaCommand>("system-media-command", ({ payload }) => {
      const callbacks = callbacksRef.current;
      // Debounce rapid hardware key repeats so adaptive-previous can observe progress.
      const now = performance.now();
      if (payload.action !== "seek" && now - lastCommandAtRef.current < 120) return;
      lastCommandAtRef.current = now;
      switch (payload.action) {
        case "play":
          callbacks.onPlay();
          break;
        case "pause":
          callbacks.onPause();
          break;
        case "toggle":
          callbacks.onToggle();
          break;
        case "previous":
          callbacks.onPrevious();
          break;
        case "next":
          callbacks.onNext();
          break;
        case "seek":
          if (typeof payload.positionSeconds === "number") callbacks.onSeek(payload.positionSeconds);
          break;
        case "favorite":
          callbacks.onFavorite();
          break;
      }
    })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    void invoke("update_system_media", {
      state: {
        track: media
          ? {
              id: media.id,
              coverPath: media.coverPath ?? null,
              title: media.title,
              artist: media.artist,
              album: media.album,
            }
          : null,
        isPlaying,
        canPrevious,
        canNext,
        isFavorite,
      },
    }).catch(() => undefined);
  }, [media, isPlaying, canPrevious, canNext, isFavorite]);

  useEffect(() => {
    const now = performance.now();
    const trackChanged = lastTimelineTrackRef.current !== (media?.id ?? null);
    if (!trackChanged && now - lastTimelineUpdateRef.current < 1_000) return;
    lastTimelineTrackRef.current = media?.id ?? null;
    lastTimelineUpdateRef.current = now;
    if (!media || !Number.isFinite(duration) || duration <= 0) return;
    void invoke("update_system_media_timeline", {
      durationSeconds: duration,
      positionSeconds: Math.min(duration, Math.max(0, Number.isFinite(position) ? position : 0)),
    }).catch(() => undefined);
  }, [media, duration, position]);
}
