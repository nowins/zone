import type { CSSProperties } from "react";
import { ListMusic, MicVocal, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward, Volume2 } from "lucide-react";
import type { RepeatMode } from "../types";

export function TransportControls({
  trackAvailable,
  isPlaying,
  shuffle,
  repeat,
  queueActive = false,
  queueDisabled = false,
  lyricsActive = false,
  lyricsDisabled = false,
  onQueue,
  onLyrics,
  onRepeat,
  onShuffle,
  onPrevious,
  onPlayPause,
  onNext,
}: {
  trackAvailable: boolean;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  queueActive?: boolean;
  queueDisabled?: boolean;
  lyricsActive?: boolean;
  lyricsDisabled?: boolean;
  onQueue: () => void;
  onLyrics?: () => void;
  onRepeat: () => void;
  onShuffle: () => void;
  onPrevious: () => void;
  onPlayPause: () => void;
  onNext: () => void;
}) {
  const repeatTitle = repeat === "one" ? "单曲循环" : repeat === "all" ? "列表循环" : "关闭循环";

  return (
    <div className="zune-controls">
      <button
        className={queueActive ? "active" : ""}
        onClick={onQueue}
        title={queueActive ? "折叠正在播放列表" : "展开正在播放列表"}
        aria-pressed={queueActive}
        disabled={queueDisabled}
      >
        <ListMusic size={15} />
      </button>
      {onLyrics ? (
        <button
          className={lyricsActive ? "active" : ""}
          onClick={onLyrics}
          title={lyricsActive ? "隐藏歌词" : "显示歌词"}
          aria-pressed={lyricsActive}
          disabled={lyricsDisabled}
        >
          <MicVocal size={15} />
        </button>
      ) : null}
      <button className={repeat !== "off" ? "active" : ""} onClick={onRepeat} title={repeatTitle}>
        <Repeat size={14} />
      </button>
      <button className={shuffle ? "active" : ""} onClick={onShuffle} title="随机播放">
        <Shuffle size={14} />
      </button>
      <button onClick={onPrevious} title="上一首" disabled={!trackAvailable}>
        <SkipBack size={16} />
      </button>
      <button className="zune-play" onClick={onPlayPause} title={isPlaying ? "暂停" : "播放"} disabled={!trackAvailable}>
        {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <button onClick={onNext} title="下一首" disabled={!trackAvailable}>
        <SkipForward size={16} />
      </button>
    </div>
  );
}

export function VolumeControl({ volume, onVolume }: { volume: number; onVolume: (value: number) => void }) {
  return (
    <label className="zune-volume">
      <Volume2 className="zune-volume-icon" size={13} aria-hidden="true" />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(event) => onVolume(Number(event.target.value))}
        aria-label="音量"
        style={{ "--range-progress": `${volume * 100}%` } as CSSProperties}
      />
      <span>{`音量 ${Math.round(volume * 100)}`}</span>
    </label>
  );
}
