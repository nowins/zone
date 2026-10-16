import { useLayoutEffect, useRef } from "react";
import {
  Disc3,
  LibraryBig,
  ListMusic,
} from "lucide-react";
import { Cover } from "./Cover";
import { PlaybackProgress } from "./PlaybackProgress";
import { TransportControls, VolumeControl } from "./TransportControls";
import { attachCoverReturn, playCoverFlip, registerCoverFlipSource, rememberCoverReturnTarget } from "../motion/coverFlip";
import { takeFlipSource } from "../motion/flip";
import type { FlipSource } from "../motion/flip";
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
  const flipSourceRef = useRef<FlipSource | null>(null);
  const flipConsumedRef = useRef(false);

  // Registering side of the push into now playing: remember where the cover
  // was so the track card can fly a clone from here.
  function handleOpenNowPlaying() {
    if (!reducedMotion && track?.cover_path && coverButtonRef.current) {
      registerCoverFlipSource(`cover:${track.id}`, coverButtonRef.current);
    }
    onOpenNowPlaying();
  }

  // The return already moves during the page exit. Bind its endpoint to
  // this mounted cover without replaying it, including StrictMode remounts.
  useLayoutEffect(() => {
    const target = coverButtonRef.current?.querySelector<HTMLElement>(".mini-cover");
    if (!target) return;
    const remember = () => rememberCoverReturnTarget(target);
    remember();
    window.addEventListener("resize", remember);
    if (!flipConsumedRef.current) {
      flipConsumedRef.current = true;
      const coverPath = track?.cover_path;
      flipSourceRef.current =
        reducedMotion || !track || !coverPath ? null : takeFlipSource(`cover:${track.id}`);
    }
    const source = flipSourceRef.current;
    const attached = track ? attachCoverReturn(`cover:${track.id}`, target) : false;
    const flip = !attached && source && track
      ? playCoverFlip({ id: `cover:${track.id}`, source, target, direction: "exit" }) : null;
    return () => { window.removeEventListener("resize", remember); flip?.cancel(); };
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
        <button ref={coverButtonRef} className="player-cover" data-now-playing-trigger="cover" onClick={handleOpenNowPlaying} disabled={!track} title="打开正在播放">
          <Cover artPath={track?.cover_path} label={track?.album ?? ""} size="mini" />
        </button>
        <PlaybackProgress
          mediaKey={track?.id}
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
