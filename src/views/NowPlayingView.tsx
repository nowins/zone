import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, AudioLines, ChevronDown, Heart } from "lucide-react";
import { AudioGlowCanvas } from "../components/AudioGlowCanvas";
import { Cover } from "../components/Cover";
import { LyricsStage } from "../components/LyricsStage";
import { NowPlayingMosaicCanvas } from "../components/NowPlayingMosaicCanvas";
import { PlaybackProgress } from "../components/PlaybackProgress";
import { TransportControls, VolumeControl } from "../components/TransportControls";
import { useLyrics } from "../hooks/useLyrics";
import { playCoverFlip } from "../motion/coverFlip";
import { registerFlipElement, takeFlipSource } from "../motion/flip";
import type { FlipRect } from "../motion/flip";
import { Presence, useLastNonNull } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";
import { queueAfterCurrent } from "../utils/playback";
import type { RepeatMode, Track } from "../types";

const COLLAPSED_UPCOMING_COUNT = 2;
const IDLE_CHROME_DELAY = 5_000;
const COVER_FLIP_CARD_ANIMATIONS = ["now-track-info-enter", "now-track-card-fade"];
const COVER_FLIP_WAIT_TIMEOUT_MS = 2_500;
// Total stage-entrance budget: the wall reveal plus the track card's delayed
// entrance must settle before `stage-entering` clears (see
// animations-responsive.css for the paired keyframes).
const STAGE_ENTRANCE_MS = 1_250;

/**
 * Resolves once the track card's entrance animation reaches the given phase
 * (`animationstart` / `animationend`), or after a fallback timeout so a
 * missing entrance can never strand the shared-element clone.
 */
function waitForCardAnimation(card: HTMLElement, phase: "start" | "end"): Promise<void> {
  const type = phase === "start" ? "animationstart" : "animationend";
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, COVER_FLIP_WAIT_TIMEOUT_MS);
    function onAnimation(event: AnimationEvent) {
      if (event.target !== card || !COVER_FLIP_CARD_ANIMATIONS.includes(event.animationName)) return;
      done();
    }
    function done() {
      window.clearTimeout(timer);
      card.removeEventListener(type, onAnimation as EventListener);
      resolve();
    }
    card.addEventListener(type, onAnimation as EventListener);
  });
}

export function NowPlayingView({
  track,
  tracks,
  queue,
  isPlaying,
  playbackClock,
  progress,
  duration,
  shuffle,
  repeat,
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
  playbackClock: () => number;
  progress: number;
  duration: number;
  shuffle: boolean;
  repeat: RepeatMode;
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
  const [chromeMode, setChromeMode] = useState<"active" | "immersive">("active");
  const [surfaceMode, setSurfaceMode] = useState<"ambient" | "lyrics">("ambient");
  const [keyboardSurfaceChange, setKeyboardSurfaceChange] = useState(false);
  const [isEntering, setIsEntering] = useState(true);
  const [wallRevealStarted, setWallRevealStarted] = useState(false);
  const [flipCoverActive, setFlipCoverActive] = useState(false);
  const [flipDocked, setFlipDocked] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(true);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [playlistNameDraft, setPlaylistNameDraft] = useState("正在播放");
  const idleTimer = useRef<number | null>(null);
  const entranceTimer = useRef<number | null>(null);
  const sidePanelRef = useRef<HTMLElement | null>(null);
  const previousTrackIdRef = useRef(track?.id ?? null);
  const orderedQueue = useMemo(() => queueAfterCurrent(queue, track?.id ?? null), [queue, track?.id]);
  const hasExpandableQueue = orderedQueue.length > COLLAPSED_UPCOMING_COUNT;
  const lyricsOpen = surfaceMode === "lyrics" && Boolean(track);
  const queueOpen = !lyricsOpen && queueExpanded && hasExpandableQueue;
  const lyrics = useLyrics(track, duration);
  const upcomingQueue = useMemo(() => {
    return queueOpen ? orderedQueue : orderedQueue.slice(0, COLLAPSED_UPCOMING_COUNT);
  }, [orderedQueue, queueOpen]);
  const hiddenQueueCount = Math.max(0, orderedQueue.length - COLLAPSED_UPCOMING_COUNT);
  const [textFading, setTextFading] = useState(false);
  const reducedMotion = useReducedMotion();
  const trackCardRef = useRef<HTMLElement | null>(null);
  // StrictMode re-runs mount effects; keep the consumed source on the
  // instance so the second run replays the flight instead of missing.
  const flipSourceRef = useRef<FlipRect | null>(null);
  const flipConsumedRef = useRef(false);

  function scheduleChromeFade() {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setChromeMode("immersive"), IDLE_CHROME_DELAY);
  }

  function wakeChrome() {
    setChromeMode("active");
    scheduleChromeFade();
  }

  function toggleLyrics() {
    if (!track) return;
    setSurfaceMode((current) => {
      const next = current === "lyrics" ? "ambient" : "lyrics";
      if (next === "lyrics") setQueueExpanded(false);
      return next;
    });
    wakeChrome();
  }

  function toggleQueue() {
    setSurfaceMode("ambient");
    setQueueExpanded((value) => !value);
    wakeChrome();
  }

  const handleInitialWallRevealStart = useCallback(() => {
    setWallRevealStarted(true);
    if (entranceTimer.current) window.clearTimeout(entranceTimer.current);
    entranceTimer.current = window.setTimeout(() => setIsEntering(false), STAGE_ENTRANCE_MS);
  }, []);

  function openSaveDialog() {
    if (queue.length === 0) return;
    setPlaylistNameDraft("正在播放");
    setSaveDialogOpen(true);
    wakeChrome();
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
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      if (entranceTimer.current) window.clearTimeout(entranceTimer.current);
    };
  }, []);

  // Shared-element cover hand-off (push in): the player bar or the quickplay
  // feature cover registered where this track's art was; fly a clone from
  // there, dock it through the card's delayed entrance, then hand off to the
  // real cover. Mount-only — track changes inside now playing must not fly.
  // While a flight is live the flight IS the cover's entrance: flipCoverActive
  // keeps the card at its rest position (no 12px press) so the clone docks on
  // the final spot, and the card only fades in instead of rising afterwards.
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
    const card = trackCardRef.current;
    const target = card?.querySelector<HTMLElement>(".mini-cover");
    if (!card || !target) return;
    // Sync re-render before paint: the card switches to its at-rest flip
    // choreography (see .flip-cover-active) before the clone is measured.
    setFlipCoverActive(true);
    // The card's own entrance (outline + track info) is docked-driven: it
    // starts only once the clone truly rests (.flip-docked), so the outline
    // never frames a cover that is still settling. The fallback keeps the
    // card from being stranded if the spring completion is ever missed; it
    // must outlast the clone image decode gate plus the flight itself.
    const dockFallback = window.setTimeout(() => setFlipDocked(true), 1_500);
    const flip = playCoverFlip({
      source,
      target,
      imageSrc: convertFileSrc(coverPath),
      holdUntil: () => waitForCardAnimation(card, "end"),
      revealTargetWhen: () => waitForCardAnimation(card, "start"),
      onDocked: () => {
        window.clearTimeout(dockFallback);
        setFlipDocked(true);
      },
    });
    return () => {
      window.clearTimeout(dockFallback);
      flip.cancel();
    };
  }, []);

  // Registering side of the pop back out: remember the card cover's spot so
  // the player bar can fly a clone from here when it remounts.
  function handleBack() {
    if (!reducedMotion && track?.cover_path) {
      const target = trackCardRef.current?.querySelector<HTMLElement>(".mini-cover");
      if (target) registerFlipElement(`cover:${track.id}`, target);
    }
    onBack();
  }

  useEffect(() => {
    if (track?.id === previousTrackIdRef.current) return;
    previousTrackIdRef.current = track?.id ?? null;
    wakeChrome();
    setTextFading(true);
    const fadeInTimer = window.setTimeout(() => {
      setTextFading(false);
    }, MOTION_DURATIONS.content);
    return () => window.clearTimeout(fadeInTimer);
  }, [track?.id]);

  useEffect(() => {
    if (track) return;
    setSurfaceMode("ambient");
  }, [track]);

  useEffect(() => {
    const sidePanel = sidePanelRef.current;
    if (!sidePanel) return;
    if (lyricsOpen) sidePanel.setAttribute("inert", "");
    else sidePanel.removeAttribute("inert");
  }, [lyricsOpen]);

  useEffect(() => {
    if (!lyricsOpen) return;
    function handleLyricsKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setKeyboardSurfaceChange(true);
      setSurfaceMode("ambient");
      window.requestAnimationFrame(() => setKeyboardSurfaceChange(false));
    }
    window.addEventListener("keydown", handleLyricsKeyDown);
    return () => window.removeEventListener("keydown", handleLyricsKeyDown);
  }, [lyricsOpen]);

  useEffect(() => {
    if (!saveDialogOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeSaveDialog();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveDialogOpen]);

  const saveDialogElement = saveDialogOpen ? (
    <div className="save-playlist-overlay" role="presentation">
      <form
        className="save-playlist-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="保存播放列表"
        onSubmit={submitSaveDialog}
      >
        <div className="dialog-accent" aria-hidden="true" />
        <label>
          <span>播放列表</span>
          <input
            autoFocus
            value={playlistNameDraft}
            onChange={(event) => setPlaylistNameDraft(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="submit" disabled={!playlistNameDraft.trim()}>
            确定
          </button>
          <button type="button" onClick={closeSaveDialog}>
            取消
          </button>
        </div>
      </form>
    </div>
  ) : null;
  const lastSaveDialogElement = useLastNonNull(saveDialogElement);

  return (
    <section
      className={`now-playing-stage chrome-${chromeMode} ${isEntering ? "stage-entering" : ""} ${
        wallRevealStarted ? "wall-reveal-started" : ""
      } ${
        isPlaying ? "wall-playing" : "wall-paused"
      } ${lyricsOpen ? "lyrics-mode" : "ambient-mode"} ${keyboardSurfaceChange ? "keyboard-surface-change" : ""} ${
        flipCoverActive ? "flip-cover-active" : ""
      } ${flipDocked ? "flip-docked" : ""}`}
      onMouseMove={wakeChrome}
      onMouseDown={wakeChrome}
      onMouseEnter={wakeChrome}
      onKeyDown={wakeChrome}
    >
      <NowPlayingMosaicCanvas
        tracks={tracks}
        activeTrack={track}
        isPlaying={isPlaying}
        onInitialRevealStart={handleInitialWallRevealStart}
      />
      <div className="now-canvas-grade" />
      <LyricsStage
        document={lyrics.document}
        status={lyrics.status}
        sourceLabel={lyrics.sourceLabel}
        isManualSource={lyrics.isManual}
        isDemoSource={lyrics.isDemo}
        onlineSearch={lyrics.onlineSearch}
        hasOnlineProviders={lyrics.hasOnlineProviders}
        searchMetadata={lyrics.searchMetadata}
        hasSearchMetadataOverride={lyrics.hasSearchMetadataOverride}
        error={lyrics.error}
        progress={progress}
        isPlaying={isPlaying}
        playbackClock={playbackClock}
        duration={duration}
        timingOffsetMs={lyrics.timingOffsetMs}
        visible={lyricsOpen}
        onSeek={onSeek}
        onSelectSource={lyrics.selectFile}
        onSearchOnline={lyrics.searchOnline}
        onUpdateSearchMetadata={lyrics.updateSearchMetadata}
        onResetSearchMetadata={lyrics.resetSearchMetadata}
        onExportLyrics={lyrics.exportLyrics}
        onSelectOnlineSource={lyrics.selectRemoteCandidate}
        onClearManualSource={lyrics.clearManualBinding}
        onRetry={lyrics.retry}
        onAdjustTimingOffset={lyrics.adjustTimingOffset}
        onResetTimingOffset={lyrics.resetTimingOffset}
        onInteraction={wakeChrome}
      />
      <button className="now-back" onClick={handleBack} title="返回收藏">
        <ArrowLeft size={40} strokeWidth={2.55} />
      </button>

      <aside
        ref={sidePanelRef}
        className={`now-side-panel ${queueOpen ? "queue-expanded" : ""}`}
        aria-hidden={lyricsOpen}
      >
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
              <strong>暂无播放</strong>
              <span>请选择一首歌曲</span>
            </div>
          )}

          <div className="now-panel-upcoming">
            {upcomingQueue.map((item, index) => (
              <button key={`${item.id}-${index}`} onClick={() => onPlay(item, queue)}>
                <strong>{item.title}</strong>
                <span>{item.artist}</span>
              </button>
            ))}
          </div>
        </div>

        {!queueOpen && hiddenQueueCount > 0 ? (
          <button className="queue-disclosure" onClick={() => setQueueExpanded(true)}>
            <span>{`展开其余 ${hiddenQueueCount} 首`}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        ) : null}

        <button className="save-queue" onClick={openSaveDialog} disabled={queue.length === 0}>
          另存为播放列表
        </button>

      </aside>

      <section ref={trackCardRef} className={`now-track-card ${textFading ? "card-fading" : ""}`}>
        <Cover artPath={track?.cover_path} label={track?.album ?? "正在播放"} size="mini" />
        <div className="now-track-copy">
          <strong>{track?.artist ?? "Zone"}</strong>
          <span>{track?.album ?? "请从收藏中选择歌曲"}</span>
          <em>{track?.title ?? "暂无播放"}</em>
          <button
            className={`now-favorite ${isFavorite ? "favorite-active" : ""}`}
            title={isFavorite ? "取消收藏" : "添加到收藏"}
            onClick={onToggleFavorite}
            disabled={!track}
          >
            <Heart size={18} fill={isFavorite ? "currentColor" : "none"} />
          </button>
        </div>
      </section>

      <AudioGlowCanvas
        isPlaying={isPlaying}
        volume={volume}
      />

      <div className="now-transport">
        <PlaybackProgress
          label={track?.title ?? "Zone"}
          progress={progress}
          duration={duration}
          disabled={!track}
          onSeek={onSeek}
        />
        <div className="now-transport-controls">
          <TransportControls
            trackAvailable={Boolean(track)}
            isPlaying={isPlaying}
            shuffle={shuffle}
            repeat={repeat}
            queueActive={queueOpen}
            queueDisabled={!hasExpandableQueue}
            lyricsActive={lyricsOpen}
            lyricsDisabled={!track}
            onQueue={toggleQueue}
            onLyrics={toggleLyrics}
            onRepeat={onRepeat}
            onShuffle={onShuffle}
            onPrevious={onPrevious}
            onPlayPause={onPlayPause}
            onNext={onNext}
          />
          <VolumeControl volume={volume} onVolume={onVolume} />
        </div>
      </div>

      <Presence show={saveDialogElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {saveDialogElement ?? lastSaveDialogElement ?? <span style={{ display: "none" }} />}
      </Presence>
    </section>
  );
}
