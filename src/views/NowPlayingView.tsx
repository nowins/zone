import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, AudioLines, Heart, ListMusic, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { AudioGlowCanvas } from "../components/AudioGlowCanvas";
import { Cover } from "../components/Cover";
import { NowPlayingMosaicCanvas } from "../components/NowPlayingMosaicCanvas";
import { formatTime } from "../utils/music";
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
  beatPulse,
  beatPhase,
  onsetStrength,
  beatConfidence,
  isFavorite,
  volume,
  onBack,
  onPlay,
  onPlayPause,
  onToggleFavorite,
  onPrevious,
  onNext,
  onSeek,
  onShuffle,
  onRepeat,
  onVolume,
  onSaveQueueAsPlaylist,
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
  beatPulse: number;
  beatPhase: number;
  onsetStrength: number;
  beatConfidence: number;
  isFavorite: boolean;
  volume: number;
  onBack: () => void;
  onPlay: (track: Track, sourceTracks?: Track[]) => void;
  onPlayPause: () => void;
  onToggleFavorite: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (value: number) => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onVolume: (value: number) => void;
  onSaveQueueAsPlaylist: (name: string) => void;
}) {
  const [chromeMode, setChromeMode] = useState<"active" | "idle" | "immersive">("active");
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [playlistNameDraft, setPlaylistNameDraft] = useState("now playing");
  const idleTimer = useRef<number | null>(null);
  const immersiveTimer = useRef<number | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const activeQueueIndex = useMemo(() => queue.findIndex((item) => item.id === track?.id), [queue, track?.id]);
  const upcomingQueue = useMemo(() => {
    const limit = queueExpanded ? 8 : 0;
    if (queue.length === 0) return [];
    if (activeQueueIndex >= 0) return queue.slice(activeQueueIndex + 1, activeQueueIndex + 1 + limit);
    return queue.filter((item) => item.id !== track?.id).slice(0, limit);
  }, [activeQueueIndex, queue, queueExpanded, track?.id]);
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

  function scheduleChromeFade() {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    if (immersiveTimer.current) window.clearTimeout(immersiveTimer.current);
    idleTimer.current = window.setTimeout(() => setChromeMode("idle"), 15000);
    immersiveTimer.current = window.setTimeout(() => setChromeMode("immersive"), 32000);
  }

  function wakeChrome() {
    setChromeMode("active");
    scheduleChromeFade();
  }

  function openSaveDialog() {
    if (queue.length === 0) return;
    setPlaylistNameDraft("now playing");
    setSaveDialogOpen(true);
    setChromeMode("active");
  }

  function closeSaveDialog() {
    setSaveDialogOpen(false);
  }

  function submitSaveDialog(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = playlistNameDraft.trim();
    if (!cleanName) return;
    onSaveQueueAsPlaylist(cleanName);
    setSaveDialogOpen(false);
  }

  useEffect(() => {
    wakeChrome();
    setTextFading(true);
    const fadeInTimer = window.setTimeout(() => {
      setTextFading(false);
    }, 600);
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      if (immersiveTimer.current) window.clearTimeout(immersiveTimer.current);
      window.clearTimeout(fadeInTimer);
    };
  }, [track?.id]);

  useEffect(() => {
    if (!saveDialogOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeSaveDialog();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveDialogOpen]);

  return (
    <section
      className={`now-playing-stage chrome-${chromeMode} ${
        isPlaying ? "wall-playing" : "wall-paused"
      }`}
      onMouseMove={wakeChrome}
      onMouseDown={wakeChrome}
      onMouseEnter={wakeChrome}
      onKeyDown={wakeChrome}
    >
      <NowPlayingMosaicCanvas
        tracks={tracks}
        activeTrack={track}
        energy={visualizerEnergy}
        beatPulse={beatPulse}
        beatPhase={beatPhase}
        beatConfidence={beatConfidence}
        isPlaying={isPlaying}
      />
      <div className="now-canvas-grade" />
      <button className="now-back" onClick={onBack} title="Back to collection">
        <ArrowLeft size={40} strokeWidth={2.55} />
      </button>

      <aside className={`now-side-panel ${queueExpanded ? "queue-expanded" : ""}`}>
        <div className="now-panel-tracks">
          {track ? (
            <button className="now-panel-current" onClick={() => onPlay(track, queue)} disabled={!track}>
              <div className="queue-row">
                <AudioLines size={16} />
                <strong>{track.title}</strong>
              </div>
              <span>{track.artist}</span>
            </button>
          ) : (
            <div className="now-panel-empty">
              <strong>nothing playing</strong>
              <span>choose a song</span>
            </div>
          )}

          <div className="now-panel-upcoming">
            {upcomingQueue.map((item) => (
              <button key={item.id} onClick={() => onPlay(item, queue)}>
                <strong>{item.title}</strong>
                <span>{item.artist}</span>
              </button>
            ))}
          </div>
        </div>

        <button className="save-queue" onClick={openSaveDialog} disabled={queue.length === 0}>
          save as playlist
        </button>

        <div className="now-panel-footer">
          <div className="now-panel-controls">
            <button
              className={queueExpanded ? "active" : ""}
              onClick={() => setQueueExpanded((value) => !value)}
              title={queueExpanded ? "Collapse queue" : "Expand queue"}
              disabled={queue.length <= 5}
            >
              <ListMusic size={17} />
            </button>
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

          <label className="now-volume">
            <Volume2 className="now-volume-icon" size={15} aria-hidden="true" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => onVolume(Number(event.target.value))}
            />
            <span>{`volume ${Math.round(volume * 100)}`}</span>
          </label>
        </div>
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

      <AudioGlowCanvas
        samples={visualizerSamples}
        energy={visualizerEnergy}
        beatPulse={beatPulse}
        beatPhase={beatPhase}
        onsetStrength={onsetStrength}
        beatConfidence={beatConfidence}
        isPlaying={isPlaying}
        volume={volume}
      />

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

      </div>

      {saveDialogOpen && (
        <div className="save-playlist-overlay" role="presentation">
          <form
            className="save-playlist-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Save playlist"
            onSubmit={submitSaveDialog}
          >
            <div className="dialog-accent" aria-hidden="true" />
            <label>
              <span>playlist</span>
              <input
                autoFocus
                value={playlistNameDraft}
                onChange={(event) => setPlaylistNameDraft(event.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <button type="submit" disabled={!playlistNameDraft.trim()}>
                OK
              </button>
              <button type="button" onClick={closeSaveDialog}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
