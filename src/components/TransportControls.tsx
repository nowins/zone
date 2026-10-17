import { useEffect, useRef, type CSSProperties, type PointerEvent } from "react";
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
      data-now-playing-trigger="queue"
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
  const scrub = useRef<{ id: number; x: number; y: number; volume: number; moved: boolean } | null>(null);
  const touchedText = useRef(false);
  const openedByTouch = useRef(false);
  const latest = useRef({ volume, onVolume });
  latest.current = { volume, onVolume };
  function updateVolume(value: number) {
    const next = clamp(value, 0, 1);
    latest.current.volume = next;
    latest.current.onVolume(next);
  }
  function endScrub() {
    const gesture = scrub.current;
    scrub.current = null;
    const element = elementRef.current;
    if (gesture && element?.hasPointerCapture?.(gesture.id)) element.releasePointerCapture(gesture.id);
  }
  function pointerDown(event: PointerEvent<HTMLLabelElement>) {
    if (event.pointerType !== "touch") { touchedText.current = false; return; }
    if (!event.isPrimary) { endScrub(); return; }
    if (event.button !== 0 || event.target === event.currentTarget.querySelector("input")) return;
    touchedText.current = true;
    scrub.current = { id: event.pointerId, x: event.clientX, y: event.clientY, volume: latest.current.volume, moved: false };
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLLabelElement>) {
    const gesture = scrub.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (Math.hypot(dx, dy) < 8 && !gesture.moved) return;
    if (!gesture.moved && Math.abs(dy) > Math.abs(dx)) { endScrub(); return; }
    gesture.moved = true;
    // Keep vertical movements from unexpectedly changing volume.
    if (Math.abs(dy) > Math.abs(dx)) return;
    updateVolume(gesture.volume + dx / 160);
  }
  function pointerUp(event: PointerEvent<HTMLLabelElement>) {
    const gesture = scrub.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    pointerMove(event);
    if (scrub.current !== gesture) return;
    endScrub();
    const input = event.currentTarget.querySelector("input");
    if (!gesture.moved && input && getComputedStyle(input).display !== "none") {
      openedByTouch.current = true;
      input.focus({ preventScroll: true });
    }
  }
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
    function touchStart(event: TouchEvent) {
      if (event.touches.length > 1) { endScrub(); return; }
      // Only the existing volume text owns scrubbing; ranges keep native input.
      if (event.target !== element?.querySelector("input")) event.preventDefault();
    }
    function outside(event: Event) {
      const pointer = event as globalThis.PointerEvent;
      if (pointer.pointerType === "touch" && !pointer.isPrimary) endScrub();
      if (openedByTouch.current && event.target instanceof Node && !element?.contains(event.target)) {
        openedByTouch.current = false;
        element?.querySelector("input")?.blur();
      }
    }
    function cancel() { endScrub(); }
    function visibility() { if (document.hidden) cancel(); }
    element.addEventListener("touchstart", touchStart, { passive: false });
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      endScrub();
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchstart", touchStart);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return (
    <label ref={elementRef} className="zune-volume" title="音量（滚轮或左右滑动调节）"
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
      onPointerCancel={endScrub} onLostPointerCapture={endScrub}
      onClick={event => { if (touchedText.current && event.target !== event.currentTarget.querySelector("input")) event.preventDefault(); }}
      onKeyDown={event => {
        touchedText.current = false;
        if (event.key === "Escape" && openedByTouch.current) {
          event.preventDefault(); event.stopPropagation(); openedByTouch.current = false;
          event.currentTarget.querySelector("input")?.blur();
        }
      }}>
      <Volume2 className="zune-volume-icon" size={13} aria-hidden="true" />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(event) => updateVolume(Number(event.target.value))}
        aria-label="音量"
        style={{ "--range-progress": `${volume * 100}%` } as CSSProperties}
      />
      <span>{`音量 ${Math.round(volume * 100)}`}</span>
    </label>
  );
}
