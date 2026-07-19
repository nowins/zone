import {
  Disc3,
  LibraryBig,
  ListMusic,
} from "lucide-react";
import { Cover } from "./Cover";
import { PlaybackProgress } from "./PlaybackProgress";
import { TransportControls, VolumeControl } from "./TransportControls";
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
        <button className="player-cover" onClick={onOpenNowPlaying} disabled={!track} title="打开正在播放">
          <Cover artPath={track?.cover_path} label={track?.album ?? ""} size="mini" />
        </button>
        <PlaybackProgress
          label={track?.title ?? "暂无播放"}
          progress={progress}
          duration={duration}
          disabled={!track}
          isFavorite={isFavorite}
          onLabelClick={onOpenNowPlaying}
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
          onQueue={onOpenNowPlaying}
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
