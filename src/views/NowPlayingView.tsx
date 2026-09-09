import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEntranceCompletion } from "../hooks/useEntranceCompletion";
import { useNowPlayingFullscreen } from "../hooks/useNowPlayingFullscreen";
import { ArrowLeft, AudioLines, Heart } from "lucide-react";
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
import { MOTION_DURATIONS, NOW_PLAYING_MOTION } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";
import type { RepeatMode, Track } from "../types";

const IDLE_CHROME_DELAY = 5_000;
const COVER_FLIP_CARD_ANIMATIONS = ["now-track-info-enter", "now-track-card-fade"];
const COVER_FLIP_WAIT_TIMEOUT_MS = 2_500;
// Total stage-entrance budget: the wall reveal plus the track card's delayed
// entrance must settle before `stage-entering` clears (see
// animations-responsive.css for the paired keyframes).
const STAGE_ENTRANCE_MS = NOW_PLAYING_MOTION.nowStage;

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
  onOpenArtist,
  onOpenAlbum,
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
  onOpenArtist?: () => void;
  onOpenAlbum?: () => void;
}) {
  const [chromeMode, setChromeMode] = useState<"active" | "immersive">("active");
  const [surfaceMode, setSurfaceMode] = useState<"ambient" | "lyrics">("ambient");
  const [keyboardSurfaceChange, setKeyboardSurfaceChange] = useState(false);
  const [wallRevealStarted, setWallRevealStarted] = useState(false);
  const isEntering = !useEntranceCompletion(wallRevealStarted, STAGE_ENTRANCE_MS);
  const [flipCoverActive, setFlipCoverActive] = useState(false);
  const [flipDocked, setFlipDocked] = useState(false);
  const [queueVisible, setQueueVisible] = useState(true);
  const fullscreen = useNowPlayingFullscreen();
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [playlistNameDraft, setPlaylistNameDraft] = useState("正在播放");
  const idleTimer = useRef<number | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const queuePanelRef = useRef<HTMLElement | null>(null);
  const pointerHeld = useRef(false);
  const previousTrackIdRef = useRef(track?.id ?? null);
  const displayedQueue = useMemo(() => queue.length ? queue : track ? [track] : [], [queue, track]);
  const lyricsOpen = surfaceMode === "lyrics" && Boolean(track);
  const queueOpen = !lyricsOpen && queueVisible;
  const lyrics = useLyrics(track, duration);
  const [textFading, setTextFading] = useState(false);
  const reducedMotion = useReducedMotion();
  const trackCardRef = useRef<HTMLElement | null>(null);
  // StrictMode re-runs mount effects; keep the consumed source on the
  // instance so the second run replays the flight instead of missing.
  const flipSourceRef = useRef<FlipRect | null>(null);
  const flipConsumedRef = useRef(false);

  function clearChromeFade() {
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = null;
  }

  function scheduleChromeFade() {
    clearChromeFade();
    if (!isPlaying || saveDialogOpen || isEntering || document.hidden || pointerHeld.current) return;
    idleTimer.current = window.setTimeout(() => {
      idleTimer.current = null;
      const focused = document.activeElement;
      // A keyboard user must never lose the control they are reading or using.
      if (stageRef.current?.contains(focused) && focused?.matches(":focus-visible")) return;
      setChromeMode("immersive");
    }, IDLE_CHROME_DELAY);
  }

  function wakeChrome() {
    setChromeMode("active");
    scheduleChromeFade();
  }

  function toggleLyrics() {
    if (!track) return;
    setSurfaceMode((current) => current === "lyrics" ? "ambient" : "lyrics");
    wakeChrome();
  }

  function toggleQueue() {
    setSurfaceMode("ambient");
    setQueueVisible(lyricsOpen || !queueVisible);
    wakeChrome();
  }

  const handleInitialWallRevealStart = useCallback(() => {
    setWallRevealStarted(true);
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
    function wakeFromKeyboard() {
      // Restore tabbability before the browser performs this key's default
      // focus action; a deferred React commit would skip the hidden controls.
      if (stageRef.current?.classList.contains("chrome-immersive")) flushSync(wakeChrome);
      else wakeChrome();
    }
    function releasePointer() { pointerHeld.current = false; wakeChrome(); }
    function suspend() { pointerHeld.current = false; clearChromeFade(); }
    function visibilityChanged() { if (document.hidden) suspend(); else wakeChrome(); }
    // Listen outside the stage as well: hidden controls are inert, so the first
    // Tab or transport shortcut may arrive on the document instead of a child.
    window.addEventListener("keydown", wakeFromKeyboard);
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", releasePointer);
    window.addEventListener("blur", suspend);
    window.addEventListener("focus", wakeChrome);
    document.addEventListener("visibilitychange", visibilityChanged);
    wakeChrome();
    return () => {
      clearChromeFade();
      window.removeEventListener("keydown", wakeFromKeyboard);
      window.removeEventListener("pointerup", releasePointer);
      window.removeEventListener("pointercancel", releasePointer);
      window.removeEventListener("blur", suspend);
      window.removeEventListener("focus", wakeChrome);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [isPlaying, saveDialogOpen, isEntering]);

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

  const attachQueuePanel = useCallback((panel: HTMLElement | null) => {
    queuePanelRef.current = panel;
    if (!panel) return;
    panel.toggleAttribute("inert", !queueOpen || chromeMode === "immersive");
    const list = panel.querySelector<HTMLElement>(".now-panel-tracks");
    const current = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !current || !queueOpen) return;
    const viewport = list.getBoundingClientRect();
    const row = current.getBoundingClientRect();
    // Keep the queue order and scroll position; reveal only an offscreen row.
    if (row.top < viewport.top) list.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  }, [track?.id, queueOpen]);

  useLayoutEffect(() => {
    queuePanelRef.current?.toggleAttribute("inert", !queueOpen || chromeMode === "immersive");
  }, [queueOpen, chromeMode]);

  const attachChrome = useCallback((element: HTMLElement | null) => {
    element?.toggleAttribute("inert", chromeMode === "immersive");
  }, [chromeMode]);

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
      ref={stageRef}
      className={`now-playing-stage chrome-${chromeMode} ${isEntering ? "stage-entering" : ""} ${
        wallRevealStarted ? "wall-reveal-started" : ""
      } ${
        isPlaying ? "wall-playing" : "wall-paused"
      } ${lyricsOpen ? "lyrics-mode" : "ambient-mode"} ${keyboardSurfaceChange ? "keyboard-surface-change" : ""} ${
        flipCoverActive ? "flip-cover-active" : ""
      } ${flipDocked ? "flip-docked" : ""} ${fullscreen.active ? "now-fullscreen" : ""}`}
      onMouseMove={wakeChrome}
      onPointerDownCapture={() => { pointerHeld.current = true; wakeChrome(); }}
      onMouseEnter={wakeChrome}
      onWheelCapture={wakeChrome}
      onKeyDown={wakeChrome}
      onFocusCapture={wakeChrome}
      onBlurCapture={wakeChrome}
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
      <button ref={attachChrome} className="now-back" aria-hidden={chromeMode === "immersive"} onClick={handleBack} title="返回收藏">
        <ArrowLeft size={40} strokeWidth={2.55} />
      </button>

      <Presence show={queueOpen} exitDurationMs={MOTION_DURATIONS.micro}>
        <aside
          ref={attachQueuePanel}
          className="now-side-panel"
          aria-label="正在播放列表"
          aria-hidden={!queueOpen || chromeMode === "immersive"}
        >
          <div className="now-panel-tracks">
            {displayedQueue.length === 0 ? (
              <div className="now-panel-empty">
                <strong>暂无播放</strong>
                <span>请选择一首歌曲</span>
              </div>
            ) : null}

            <div className="now-panel-upcoming">
              {displayedQueue.map((item, index) => (
                <button
                  key={`${item.id}-${index}`}
                  className={item.id === track?.id ? "now-panel-current" : undefined}
                  aria-current={item.id === track?.id ? "true" : undefined}
                  onClick={() => item.id === track?.id ? onPlayPause() : onPlay(item, queue)}
                >
                  <div className="queue-row">
                    <AudioLines size={16} aria-hidden="true" style={{ visibility: item.id === track?.id ? "visible" : "hidden" }} />
                    <strong>{item.title}</strong>
                  </div>
                  <span>{item.artist}</span>
                </button>
              ))}
            </div>
          </div>

          <button className="save-queue" onClick={openSaveDialog} disabled={queue.length === 0}>
            另存为播放列表
          </button>
        </aside>
      </Presence>

      <section ref={trackCardRef} className={`now-track-card ${textFading ? "card-fading" : ""}`}>
        <Cover artPath={track?.cover_path} label={track?.album ?? "正在播放"} size="mini" />
        <div className="now-track-copy">
          <strong>{track && onOpenArtist ? <button className="now-entity-link" data-collection-focus="now-artist" onClick={onOpenArtist}>{track.artist}</button> : track?.artist ?? "Zone"}</strong>
          <span>{track && onOpenAlbum ? <button className="now-entity-link" data-collection-focus="now-album" onClick={onOpenAlbum}>{track.album}</button> : track?.album ?? "请从收藏中选择歌曲"}</span>
          <em>{track?.title ?? "暂无播放"}</em>
          <button
            className={`now-favorite ${isFavorite ? "favorite-active" : ""}`}
            title={isFavorite ? "取消收藏" : "添加到收藏"}
            aria-pressed={isFavorite}
            onClick={onToggleFavorite}
            disabled={!track}
          >
            <Heart size={16} fill={isFavorite ? "currentColor" : "none"} />
          </button>
        </div>
      </section>

      <AudioGlowCanvas
        isPlaying={isPlaying}
        volume={volume}
      />

      <div ref={attachChrome} className="now-transport" aria-hidden={chromeMode === "immersive"}>
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
            lyricsActive={lyricsOpen}
            lyricsDisabled={!track}
            onQueue={toggleQueue}
            onLyrics={toggleLyrics}
            onRepeat={onRepeat}
            onShuffle={onShuffle}
            onPrevious={onPrevious}
            onPlayPause={onPlayPause}
            onNext={onNext}
            fullscreen={fullscreen.active}
            fullscreenPending={fullscreen.pending}
            onFullscreen={() => { fullscreen.toggle(); wakeChrome(); }}
          />
          <VolumeControl volume={volume} onVolume={onVolume} />
          {fullscreen.error ? <span className="now-fullscreen-error" role="status">{fullscreen.error}</span> : null}
        </div>
      </div>

      <Presence show={saveDialogElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {saveDialogElement ?? lastSaveDialogElement ?? <span style={{ display: "none" }} />}
      </Presence>
    </section>
  );
}
