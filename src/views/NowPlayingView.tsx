import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioLines, Heart, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward } from "lucide-react";
import { Cover } from "../components/Cover";
import { formatTime, initials } from "../utils/music";
import { buildNowPlayingWall, wallTilePatternForIndex } from "../utils/nowPlayingWall";
import type { RepeatMode, Track } from "../types";

export function NowPlayingView({
  track,
  tracks,
  queue,
  isPlaying,
  progress,
  duration,
  shuffle,
  repeat,
  visualizerSamples,
  visualizerEnergy,
  isFavorite,
  onBack,
  onPlay,
  onPlayPause,
  onToggleFavorite,
  onPrevious,
  onNext,
  onSeek,
  onShuffle,
  onRepeat,
}: {
  track: Track | null;
  tracks: Track[];
  queue: Track[];
  isPlaying: boolean;
  progress: number;
  duration: number;
  shuffle: boolean;
  repeat: RepeatMode;
  visualizerSamples: number[];
  visualizerEnergy: number;
  isFavorite: boolean;
  onBack: () => void;
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onPlayPause: () => void;
  onToggleFavorite: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (value: number) => void;
  onShuffle: () => void;
  onRepeat: () => void;
}) {
  const [chromeVisible, setChromeVisible] = useState(true);
  const [flippingTiles, setFlippingTiles] = useState<Set<number>>(() => new Set());
  const hideTimer = useRef<number | null>(null);
  const flipTimer = useRef<number | null>(null);
  const flipClearTimer = useRef<number | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const wallAlbums = useMemo(() => buildNowPlayingWall(tracks, track), [tracks, track]);
  const visualizerHorizon = useMemo(() => buildHorizonPaths(visualizerSamples), [visualizerSamples]);
  const visualizerDisplayEnergy = Math.min(1, Math.max(0.12, visualizerEnergy * 1.25 + 0.08));
  const visualizerPeak = useMemo(() => getVisualizerPeak(visualizerSamples), [visualizerSamples]);
  const activeQueueIndex = useMemo(() => queue.findIndex((item) => item.id === track?.id), [queue, track?.id]);
  const [tintColor, setTintColor] = useState("rgb(200, 80, 40)");
  const [wallFading, setWallFading] = useState(false);
  const [textFading, setTextFading] = useState(false);

  function handleProgressInteraction(clientX: number) {
    if (!progressBarRef.current || !duration) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  }

  function handleProgressMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (!duration || !track) return;
    isDraggingRef.current = true;
    handleProgressInteraction(event.clientX);

    function handleMouseMove(moveEvent: MouseEvent) {
      if (!isDraggingRef.current) return;
      handleProgressInteraction(moveEvent.clientX);
    }

    function handleMouseUp() {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  function scheduleChromeHide(delay = 5000) {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChromeVisible(false), delay);
  }

  function wakeChrome() {
    setChromeVisible(true);
    scheduleChromeHide();
  }

  useEffect(() => {
    wakeChrome();
    setWallFading(true);
    setTextFading(true);
    const fadeInTimer = window.setTimeout(() => {
      setWallFading(false);
      setTextFading(false);
    }, 600);
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      window.clearTimeout(fadeInTimer);
    };
  }, [track?.id]);

  useEffect(() => {
    if (flipTimer.current) window.clearTimeout(flipTimer.current);
    if (flipClearTimer.current) window.clearTimeout(flipClearTimer.current);
    setFlippingTiles(new Set());

    if (!isPlaying || wallAlbums.length === 0) return;

    const flipDuration = 6200;

    function scheduleNextFlip(delay = 3500 + Math.random() * 3000) {
      flipTimer.current = window.setTimeout(() => {
        const flipCount = Math.min(wallAlbums.length, Math.random() > 0.88 ? 2 : 1);
        const next = new Set<number>();
        while (next.size < flipCount) next.add(Math.floor(Math.random() * wallAlbums.length));
        setFlippingTiles(next);
        flipClearTimer.current = window.setTimeout(() => {
          setFlippingTiles((current) => {
            const updated = new Set(current);
            for (const index of next) updated.delete(index);
            return updated;
          });
        }, flipDuration);
        scheduleNextFlip(10000 + Math.random() * 8000);
      }, delay);
    }

    scheduleNextFlip();

    return () => {
      if (flipTimer.current) window.clearTimeout(flipTimer.current);
      if (flipClearTimer.current) window.clearTimeout(flipClearTimer.current);
    };
  }, [isPlaying, wallAlbums.length]);

  useEffect(() => {
    if (!track?.cover_path) return;
    const img = new Image();
    img.src = convertFileSrc(track.cover_path);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, 64, 64);
      const data = ctx.getImageData(0, 0, 64, 64).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 16) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count += 1;
      }
      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);
      const warmR = Math.min(255, Math.round(r * 1.15));
      const warmG = Math.min(255, Math.round(g * 0.85));
      const warmB = Math.min(255, Math.round(b * 0.55));
      setTintColor(`rgb(${warmR}, ${warmG}, ${warmB})`);
    };
  }, [track?.cover_path]);

  return (
    <section
      className={`now-playing-stage ${chromeVisible ? "chrome-visible" : "chrome-idle"} ${
        isPlaying ? "wall-playing" : "wall-paused"
      }`}
      style={{ "--cover-tint": tintColor } as CSSProperties}
      onMouseMove={wakeChrome}
      onMouseDown={wakeChrome}
      onMouseEnter={wakeChrome}
      onMouseLeave={() => scheduleChromeHide()}
    >
      <div className="now-gradient" />
      <div className={`now-type-ghost ${textFading ? "text-fading" : ""}`} aria-hidden="true">
        <strong>{track?.artist ?? "zone"}</strong>
        <span>{track?.title ?? "now playing"}</span>
      </div>
      <div className={`album-wall ${wallFading ? "wall-fading" : ""}`} aria-hidden="true">
        {wallAlbums.map((item, index) => {
          const pattern = wallTilePatternForIndex(index);
          return (
            <div
              key={`${item.key}-${index}`}
              className={`wall-tile ${flippingTiles.has(index) ? "flipping" : ""}`}
              style={{
                "--drift": `${(index % 7) * 0.35}s`,
                gridColumn: `span ${pattern.columns}`,
                gridRow: `span ${pattern.rows}`,
              } as CSSProperties}
            >
              {item.coverPath ? (
                <img src={convertFileSrc(item.coverPath)} alt="" draggable={false} />
              ) : (
                <span>{initials(item.album)}</span>
              )}
            </div>
          );
        })}
      </div>

      <button className="now-back" onClick={onBack} title="Back to collection">
        <span>‹</span>
      </button>

      <aside className="floating-queue">
        {queue.slice(0, 10).map((item, index) => (
          <button
            key={item.id}
            className={`${item.id === track?.id ? "playing" : ""} ${
              activeQueueIndex >= 0 && index === activeQueueIndex + 1 ? "queue-next" : ""
            }`}
            onClick={() => onPlay(item, queue)}
          >
            <div className="queue-row">
              {item.id === track?.id && <AudioLines size={16} />}
              <strong>{item.title}</strong>
            </div>
            <span>{item.artist}</span>
          </button>
        ))}
      </aside>

      <section className={`now-track-card ${textFading ? "card-fading" : ""}`}>
        <Cover artPath={track?.cover_path} label={track?.album ?? "now"} size="mini" />
        <div className="now-track-copy">
          <strong>{track?.artist ?? "Zone"}</strong>
          <span>{track?.album ?? "choose a song from collection"}</span>
          <em>{track?.title ?? "nothing playing"}</em>
          <button
            className={`now-favorite ${isFavorite ? "favorite-active" : ""}`}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            onClick={onToggleFavorite}
            disabled={!track}
          >
            <Heart size={18} fill={isFavorite ? "currentColor" : "none"} />
          </button>
        </div>
      </section>

      <div
        className="visualizer"
        style={{
          "--energy": visualizerDisplayEnergy.toFixed(3),
          "--peak": Math.min(1, visualizerPeak).toFixed(3),
        } as CSSProperties}
        aria-hidden="true"
      >
        <svg className="visualizer-wave-svg" viewBox="0 0 1000 96" preserveAspectRatio="none">
          <defs>
            <linearGradient id="visualizer-haze-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(255, 197, 214, 0.08)" />
              <stop offset="58%" stopColor="rgba(218, 54, 88, 0.18)" />
              <stop offset="100%" stopColor="rgba(112, 0, 30, 0.42)" />
            </linearGradient>
            <linearGradient id="visualizer-body-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(255, 176, 204, 0.22)" />
              <stop offset="46%" stopColor="rgba(234, 70, 102, 0.3)" />
              <stop offset="100%" stopColor="rgba(154, 8, 42, 0.52)" />
            </linearGradient>
          </defs>
          <path className="visualizer-haze" d={visualizerHorizon.haze} />
          <path className="visualizer-body" d={visualizerHorizon.body} />
          <path className="visualizer-line" d={visualizerHorizon.line} />
        </svg>
      </div>

      <div className="now-transport">
        <div className="now-progress">
          <span className="now-progress-track">{track?.artist ?? "Zone"}</span>
          <span className="now-progress-time-start">{formatTime(progress)}</span>
          <div
            ref={progressBarRef}
            className="now-progress-bar"
            onMouseDown={handleProgressMouseDown}
          >
            <div
              className="now-progress-fill"
              style={{ width: `${duration > 0 ? (progress / duration) * 100 : 0}%` }}
            />
          </div>
          <span className="now-progress-time-end">{duration > 0 ? `-${formatTime(Math.max(duration - progress, 0))}` : "0:00"}</span>
        </div>

        <div className="now-buttons">
          <button className={repeat !== "off" ? "active" : ""} onClick={onRepeat} title={`Repeat ${repeat}`}>
            <Repeat size={16} />
          </button>
          <button className={shuffle ? "active" : ""} onClick={onShuffle} title="Shuffle">
            <Shuffle size={16} />
          </button>
          <button onClick={onPrevious} title="Previous" disabled={!track}>
            <SkipBack size={18} />
          </button>
          <button className="now-play" onClick={onPlayPause} title={isPlaying ? "Pause" : "Play"} disabled={!track}>
            {isPlaying ? <Pause size={24} /> : <Play size={24} />}
          </button>
          <button onClick={onNext} title="Next" disabled={!track}>
            <SkipForward size={18} />
          </button>
        </div>
      </div>
    </section>
  );
}

function buildHorizonPaths(samples: number[]) {
  const width = 1000;
  const baseline = 92;
  const sampled = samples.length > 0 ? samples : [0.025, 0.04, 0.035, 0.045, 0.03];
  const bucketCount = 92;
  const points = Array.from({ length: bucketCount }, (_, index) => {
    const ratio = index / Math.max(bucketCount - 1, 1);
    const sourceIndex = ratio * (sampled.length - 1);
    const left = Math.floor(sourceIndex);
    const right = Math.min(sampled.length - 1, left + 1);
    const amount = sourceIndex - left;
    const level = sampled[left] * (1 - amount) + sampled[right] * amount;
    const previous = sampled[Math.max(0, left - 2)] ?? level;
    const next = sampled[Math.min(sampled.length - 1, right + 2)] ?? level;
    const smoothed = level * 0.5 + previous * 0.24 + next * 0.26;
    const centerGain = 0.74 + Math.pow(Math.sin(Math.PI * ratio), 2.2) * 0.22;
    const edgeFade = smoothstep(ratio / 0.08) * smoothstep((1 - ratio) / 0.08);
    const softened = Math.pow(Math.max(0, smoothed - 0.008), 0.96) * centerGain * edgeFade;
    return {
      x: ratio * width,
      bodyY: baseline - (softened * 44 + 2),
      hazeY: baseline - (softened * 72 + 7),
      lineY: baseline - (softened * 34 + 6),
    };
  });

  const line = (key: "bodyY" | "hazeY" | "lineY") =>
    points
      .map((point, index) => {
        if (index === 0) return `M ${point.x.toFixed(2)} ${point[key].toFixed(2)}`;
        const previous = points[index - 1];
        const cx = (previous.x + point.x) / 2;
        return `Q ${cx.toFixed(2)} ${previous[key].toFixed(2)} ${point.x.toFixed(2)} ${point[key].toFixed(2)}`;
      })
      .join(" ");

  const area = (key: "bodyY" | "hazeY") => `${line(key)} L ${width} ${baseline} L 0 ${baseline} Z`;

  return {
    haze: area("hazeY"),
    body: area("bodyY"),
    line: line("lineY"),
  };
}

function getVisualizerPeak(samples: number[]) {
  if (samples.length === 0) return 0.04;
  const sorted = [...samples].sort((left, right) => left - right);
  return Math.max(0.04, sorted[Math.floor(sorted.length * 0.88)] ?? 0.04);
}

function smoothstep(value: number) {
  const amount = Math.min(1, Math.max(0, value));
  return amount * amount * (3 - 2 * amount);
}
