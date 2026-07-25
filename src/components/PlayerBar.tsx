import { useLayoutEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Disc3,
  LibraryBig,
  ListMusic,
} from "lucide-react";
import { Cover } from "./Cover";
import { PlaybackProgress } from "./PlaybackProgress";
import { TransportControls, VolumeControl } from "./TransportControls";
import { playCoverFlip } from "../motion/coverFlip";
import { registerFlipElement, takeFlipSource } from "../motion/flip";
import type { FlipRect } from "../motion/flip";
import { useReducedMotion } from "../motion/useReducedMotion";
import type { RepeatMode, Track, ViewMode } from "../types";

export function PlayerBar({
  track,
  isPlaying,
  progress,
  duration,
  volume,
  shuffle,
  repeat,
  isFavorite,
  onPlayPause,
  onPrevious,
  onNext,
  onSeek,
  onVolume,
  onShuffle,
  onRepeat,
  onToggleFavorite,
  onOpenNowPlaying,
  onNavigateCollection,
}: {
  track: Track | null;
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  isFavorite: boolean;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (value: number) => void;
  onVolume: (value: number) => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onToggleFavorite: () => void;
  onOpenNowPlaying: () => void;
  onNavigateCollection: (view: ViewMode) => void;
}) {
  const coverButtonRef = useRef<HTMLButtonElement | null>(null);
  const reducedMotion = useReducedMotion();
  // StrictMode re-runs mount effects; keep the consumed source on the
  // instance so the second run replays the flight instead of missing.
  const flipSourceRef = useRef<FlipRect | null>(null);
  const flipConsumedRef = useRef(false);

  // Registering side of the push into now playing: remember where the cover
  // was so the track card can fly a clone from here.
  function handleOpenNowPlaying() {
    if (!reducedMotion && track?.cover_path && coverButtonRef.current) {
      registerFlipElement(`cover:${track.id}`, coverButtonRef.current);
    }
    onOpenNowPlaying();
  }

  // Consuming side of the pop back from now playing: the track card
  // registered its rect on the way out; fly it home and hand off as soon as
  // it lands (no dock — the bar cover is already in place). Mount-only: the
  // bar persists across peer pages, so this runs on app start (registry
  // empty, no-op) and whenever now playing closes.
  useLayoutEffect(() => {
    if (!flipConsumedRef.current) {
      flipConsumedRef.current = true;
      const coverPath = track?.cover_path;
      flipSourceRef.current =
        reducedMotion || !track || !coverPath ? null : takeFlipSource(`cover:${track.id}`);
    }
    const source = flipSourceRef.current;
    const coverPath = track?.cover_path;
    if (!source || !coverPath) return;
    const button = coverButtonRef.current;
    const target = button?.querySelector<HTMLElement>(".mini-cover") ?? button;
    if (!target) return;
    const flip = playCoverFlip({ source, target, imageSrc: convertFileSrc(coverPath) });
    return () => flip.cancel();
  }, []);

  return (
    <footer className="player">
      <nav className="player-shortcuts" aria-label="收藏快捷方式">
        <button onClick={() => onNavigateCollection("albums")} title="专辑">
          <LibraryBig size={18} />
        </button>
        <button onClick={() => onNavigateCollection("artists")} title="艺术家">
          <Disc3 size={20} />
        </button>
        <button onClick={() => onNavigateCollection("playlists")} title="播放列表">
          <ListMusic size={19} />
        </button>
      </nav>

      <div className="player-primary">
        <button ref={coverButtonRef} className="player-cover" onClick={handleOpenNowPlaying} disabled={!track} title="打开正在播放">
          <Cover artPath={track?.cover_path} label={track?.album ?? ""} size="mini" />
        </button>
        <PlaybackProgress
          label={track?.title ?? "暂无播放"}
          progress={progress}
          duration={duration}
          disabled={!track}
          isFavorite={isFavorite}
          onLabelClick={handleOpenNowPlaying}
          onSeek={onSeek}
          onToggleFavorite={onToggleFavorite}
        />
      </div>

      <div className="player-transport">
        <TransportControls
          trackAvailable={Boolean(track)}
          isPlaying={isPlaying}
          shuffle={shuffle}
          repeat={repeat}
          queueDisabled={!track}
          onQueue={handleOpenNowPlaying}
          onRepeat={onRepeat}
          onShuffle={onShuffle}
          onPrevious={onPrevious}
          onPlayPause={onPlayPause}
          onNext={onNext}
        />
        <VolumeControl volume={volume} onVolume={onVolume} />
      </div>
    </footer>
  );
}
