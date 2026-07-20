import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Track } from "../types";

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
  track: Track | null;
  isPlaying: boolean;
  canPrevious: boolean;
  canNext: boolean;
  duration: number;
  position: number;
  isFavorite: boolean;
};

export function useSystemMedia({
  track,
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
        track: track
          ? {
              id: track.id,
              coverPath: track.cover_path ?? null,
              title: track.title,
              artist: track.artist,
              album: track.album,
            }
          : null,
        isPlaying,
        canPrevious,
        canNext,
        isFavorite,
      },
    }).catch(() => undefined);
  }, [track, isPlaying, canPrevious, canNext, isFavorite]);

  useEffect(() => {
    const now = performance.now();
    const trackChanged = lastTimelineTrackRef.current !== (track?.id ?? null);
    if (!trackChanged && now - lastTimelineUpdateRef.current < 1_000) return;
    lastTimelineTrackRef.current = track?.id ?? null;
    lastTimelineUpdateRef.current = now;
    if (!track || !Number.isFinite(duration) || duration <= 0) return;
    void invoke("update_system_media_timeline", {
      durationSeconds: duration,
      positionSeconds: Math.min(duration, Math.max(0, Number.isFinite(position) ? position : 0)),
    }).catch(() => undefined);
  }, [track, duration, position]);
}
