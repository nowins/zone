import { useEffect, useRef, type CSSProperties } from "react";
import { ListMusic, Maximize, Minimize, MicVocal, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { clamp } from "../motion/math";
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
  fullscreen = false,
  fullscreenPending = false,
  onFullscreen,
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
  fullscreen?: boolean;
  fullscreenPending?: boolean;
  onFullscreen?: () => void;
}) {
  const repeatTitle = repeat === "one" ? "单曲循环" : repeat === "all" ? "列表循环" : "关闭循环";

  const queueButton = (
    <button
      className={queueActive ? "active" : ""}
      onClick={onQueue}
      title={queueActive ? "隐藏正在播放列表" : "显示正在播放列表"}
      aria-pressed={queueActive}
      disabled={queueDisabled}
    >
      <ListMusic size={15} />
    </button>
  );
  const lyricsButton = onLyrics ? (
    <button
      className={lyricsActive ? "active" : ""}
      onClick={onLyrics}
      title={lyricsActive ? "隐藏歌词" : "显示歌词"}
      aria-pressed={lyricsActive}
      disabled={lyricsDisabled}
    >
      <MicVocal size={15} />
    </button>
  ) : null;
  const repeatButton = (
    <button className={repeat !== "off" ? "active" : ""} onClick={onRepeat} title={repeatTitle} aria-pressed={repeat !== "off"}>
      {repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}
    </button>
  );
  const shuffleButton = (
    <button className={shuffle ? "active" : ""} onClick={onShuffle} title="随机播放" aria-pressed={shuffle}>
      <Shuffle size={14} />
    </button>
  );
  const playbackButtons = (
    <>
      <button onClick={onPrevious} title="上一首" disabled={!trackAvailable}>
        <SkipBack size={16} />
      </button>
      <button className="zune-play" onClick={onPlayPause} title={isPlaying ? "暂停" : "播放"} disabled={!trackAvailable}>
        {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <button onClick={onNext} title="下一首" disabled={!trackAvailable}>
        <SkipForward size={16} />
      </button>
    </>
  );

  return (
    <div className={`zune-controls${onFullscreen ? " zune-controls-balanced" : ""}`}>
      {onFullscreen ? (
        <>
          <div className="zune-control-wing">
            {queueButton}{lyricsButton}
            <button
              onClick={onFullscreen}
              title={fullscreen ? "退出全屏（Esc）" : "进入全屏"}
              aria-pressed={fullscreen}
              disabled={fullscreenPending}
            >
              {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
            </button>
          </div>
          <div className="zune-control-playback">{playbackButtons}</div>
          <div className="zune-control-wing">{repeatButton}{shuffleButton}</div>
        </>
      ) : <>{queueButton}{lyricsButton}{repeatButton}{shuffleButton}{playbackButtons}</>}
    </div>
  );
}

export function VolumeControl({ volume, onVolume }: { volume: number; onVolume: (value: number) => void }) {
  const elementRef = useRef<HTMLLabelElement>(null);
  const latest = useRef({ volume, onVolume });
  latest.current = { volume, onVolume };
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    function onWheel(event: WheelEvent) {
      if (event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      // One mouse-wheel notch is five points; trackpads retain fine control.
      const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 100 : event.deltaY;
      const next = clamp(latest.current.volume - clamp(delta / 100, -1, 1) * 0.05, 0, 1);
      latest.current.volume = next;
      latest.current.onVolume(next);
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <label ref={elementRef} className="zune-volume" title="音量（滚轮调节）">
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
