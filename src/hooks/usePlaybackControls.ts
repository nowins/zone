import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { uniqueIds } from "../utils/music";
import { createIdleBeatFrame } from "../utils/beatAnalysis";
import {
  createShuffleOrder,
  haveSameQueueItems,
  playbackSourceKey,
  reconcileActiveTrack,
  reconcileQueueWithLibrary,
  resolveQueueMove,
  type QueueMoveResult,
} from "../utils/playback";
import {
  isCurrentPlayAttempt,
  podcastStatusForCanPlay,
  podcastStatusForPause,
  podcastStatusForWaiting,
  resolvePodcastResumePosition,
  resolvePodcastStartPosition,
} from "../utils/playbackTransport";
import { createTrackActivity } from "../utils/smartPlaylist";
import { musicSessionEnd, musicSessionStart } from "../app/musicLibraryApi";
import type { AudioEngineHandle } from "./useAudioEngine";
import type {
  PodcastPendingResume,
  PodcastTransportBridge,
} from "./podcastTransport";
import type {
  PodcastPlayback,
  RepeatMode,
  Track,
  TrackActivityMap,
} from "../types";

export type PlaybackSession = {
  sessionId: string;
  trackId: string;
  startedAt: number;
  startPosition: number;
  maxProgress: number;
  listenedMs: number;
  lastTickAt: number | null;
  source: string;
  durationHint: number | null;
  countedPlay: boolean;
  countedComplete: boolean;
  finalized: boolean;
};

/** Late-bound surface for podcast domain → transport (seek / arm / intent). */
export type PlaybackControlsHandle = {
  seek: (value: number) => void;
  togglePlay: () => void;
  /** Arm autoplay before `activePodcastEpisode` changes to a new source. */
  armPodcastPlay: (options: {
    episodeId: string;
    positionSeconds?: number | null;
  }) => void;
  /** Intent false + invalidate in-flight play (music takeover, sleep deadline). */
  clearPlaybackIntent: () => void;
  /** Intent only (episode end / autofill idle without invalidating source). */
  setPlaybackIntent: (value: boolean) => void;
  clearPendingPodcastStart: () => void;
  /** Pending resume position while media hydrates (for progress flush). */
  peekPendingResumePosition: (episodeId: string | null) => number | null;
  /** Whether this episode is both bound to audio.src and actually started. */
  hasEpisodeStartedOnDevice: (episodeId: string) => boolean;
};

export type ActivePlayback =
  | { kind: "podcast"; episode: PodcastPlayback }
  | { kind: "music"; track: Track }
  | null;

type UsePlaybackControlsParams = {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  showActionNotice: (message: string) => void;
  audioEngineRef: React.MutableRefObject<AudioEngineHandle | null>;
  playbackSessionRef: React.MutableRefObject<PlaybackSession | null>;
  tracks: Track[];
  restored: boolean;
  setTrackActivity: React.Dispatch<React.SetStateAction<TrackActivityMap>>;
  activeTrackId: string | null;
  setActiveTrackId: React.Dispatch<React.SetStateAction<string | null>>;
  queue: string[];
  setQueue: React.Dispatch<React.SetStateAction<string[]>>;
  playHistory: string[];
  setPlayHistory: React.Dispatch<React.SetStateAction<string[]>>;
  podcast: PodcastTransportBridge;
};

export function usePlaybackControls({
  audioRef,
  showActionNotice,
  audioEngineRef,
  playbackSessionRef,
  tracks,
  restored,
  setTrackActivity,
  activeTrackId,
  setActiveTrackId,
  queue,
  setQueue,
  playHistory,
  setPlayHistory,
  podcast,
}: UsePlaybackControlsParams) {
  const {
    activePodcastEpisode,
    cancelPendingQueueConsume,
    setPodcastPlaybackStatus,
    podcastPlaybackRate,
    podcastSessionHydrated,
    cancelPodcastSessionRestore,
    clearActivePodcast,
    flushPodcastProgress,
    persistPodcastProgress,
    resumePodcastProgressWrites,
    consumePendingPodcastQueueEpisode,
    handleEpisodeEnded,
  } = podcast;

  // Local mirror of the active podcast episode; all mutations flow through state.
  const activePodcastEpisodeRef = useRef(podcast.activePodcastEpisode);
  activePodcastEpisodeRef.current = podcast.activePodcastEpisode;

  // Transport owns which episode is bound to audio.src and which actually started.
  const podcastAudioEpisodeRef = useRef<string | null>(null);
  const podcastPlaybackStartedEpisodeRef = useRef<string | null>(null);

  // Transport owns play-attempt generation, autoplay intent, and resume bookkeeping.
  const audioPlayAttemptRef = useRef(0);
  const podcastPlaybackIntentRef = useRef(false);
  const pendingPodcastStartRef = useRef<{ episodeId: string; position: number } | null>(null);
  const pendingPodcastResumeRef = useRef<PodcastPendingResume | null>(null);
  const activeAudioSourceKeyRef = useRef<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [shuffle, setShuffle] = useState(false);
  const [shuffleOrder, setShuffleOrder] = useState<string[]>([]);
  const [repeat, setRepeat] = useState<RepeatMode>("off");

  useEffect(() => {
    if (!activeTrackId) return;
    setPlayHistory((current) => [activeTrackId, ...current.filter((id) => id !== activeTrackId)].slice(0, 24));
  }, [activeTrackId]);

  useEffect(() => {
    const previous = playbackSessionRef.current;
    if (previous && !previous.finalized) {
      finalizeSession(previous, "replaced");
    }

    if (!activePodcastEpisode && activeTrackId) {
      const sessionId = `music-${activeTrackId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = Date.now();
      playbackSessionRef.current = {
        sessionId,
        trackId: activeTrackId,
        startedAt,
        startPosition: 0,
        maxProgress: 0,
        listenedMs: 0,
        lastTickAt: null,
        source: "queue",
        durationHint: null,
        countedPlay: false,
        countedComplete: false,
        finalized: false,
      };
      void musicSessionStart({
        sessionId,
        trackId: activeTrackId,
        startPositionMs: 0,
        source: "queue",
      }).catch((error) => {
        if (import.meta.env.DEV) console.warn("[stats] session start failed", error);
      });
    } else {
      playbackSessionRef.current = null;
    }
  }, [activePodcastEpisode?.episodeId, activeTrackId]);

  const activeTrack = useMemo(
    () => tracks.find((track) => track.id === activeTrackId) ?? null,
    [tracks, activeTrackId],
  );
  const activePlayback: ActivePlayback = useMemo(() => {
    if (!podcastSessionHydrated) return null;
    if (activePodcastEpisode) return { kind: "podcast" as const, episode: activePodcastEpisode };
    if (activeTrack) return { kind: "music" as const, track: activeTrack };
    return null;
  }, [activePodcastEpisode, activeTrack, podcastSessionHydrated]);
  const activePlaybackSourceKey = activePlayback?.kind === "podcast"
    ? `podcast\0${activePlayback.episode.episodeId}\0${activePlayback.episode.playbackLocalPath ?? "stream"}`
    : activePlayback
      ? `music\0${playbackSourceKey(activePlayback.track)}`
      : null;

  const baseQueueIds = useMemo(
    () => (queue.length > 0 ? queue : tracks.map((track) => track.id)),
    [queue, tracks],
  );

  const playbackQueueIds = useMemo(
    () => shuffle && haveSameQueueItems(shuffleOrder, baseQueueIds) ? shuffleOrder : baseQueueIds,
    [baseQueueIds, shuffle, shuffleOrder],
  );

  const activePlaybackIndex = playbackQueueIds.indexOf(activeTrackId ?? "");
  const canMovePrevious = !activePodcastEpisode && Boolean(activeTrack) && (
    repeat === "all" ? playbackQueueIds.length > 1 : activePlaybackIndex > 0
  );
  const canMoveNext = !activePodcastEpisode && Boolean(activeTrack) && (
    repeat === "all"
      ? playbackQueueIds.length > 1
      : activePlaybackIndex >= 0 && activePlaybackIndex < playbackQueueIds.length - 1
  );

  useEffect(() => {
    if (!restored) return;
    const libraryIds = tracks.map((track) => track.id);

    setQueue((current) => reconcileQueueWithLibrary(current, libraryIds));
    setPlayHistory((current) => {
      const validIds = new Set(libraryIds);
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
    setActiveTrackId((current) => reconcileActiveTrack(current, queue, libraryIds));
  }, [restored, tracks]);

  useEffect(() => {
    if (!shuffle) {
      setShuffleOrder([]);
      return;
    }

    setShuffleOrder(createShuffleOrder(baseQueueIds, activeTrackId));
  }, [baseQueueIds, shuffle]);

  function beginPlayAttempt() {
    const playAttempt = audioPlayAttemptRef.current + 1;
    audioPlayAttemptRef.current = playAttempt;
    return playAttempt;
  }

  function setPlaybackIntent(value: boolean) {
    podcastPlaybackIntentRef.current = value;
  }

  function clearPlaybackIntent() {
    podcastPlaybackIntentRef.current = false;
    beginPlayAttempt();
  }

  function clearPendingPodcastStart() {
    pendingPodcastStartRef.current = null;
  }

  function armPodcastPlay(options: {
    episodeId: string;
    positionSeconds?: number | null;
  }) {
    const requested = options.positionSeconds;
    pendingPodcastStartRef.current =
      requested === null || requested === undefined || !Number.isFinite(requested)
        ? null
        : { episodeId: options.episodeId, position: Math.max(0, requested) };
    podcastPlaybackIntentRef.current = true;
    beginPlayAttempt();
    audioRef.current?.pause();
  }

  function peekPendingResumePosition(episodeId: string | null) {
    const pending = pendingPodcastResumeRef.current;
    if (!episodeId || !pending || pending.episodeId !== episodeId) return null;
    return pending.position;
  }

  function hasEpisodeStartedOnDevice(episodeId: string) {
    return (
      podcastAudioEpisodeRef.current === episodeId
      && podcastPlaybackStartedEpisodeRef.current === episodeId
    );
  }

  /**
   * Single success/failure gate for audio.play().
   * Callers that already bumped `audioPlayAttemptRef` pass `playAttempt`.
   */
  function runPlayAttempt(options: {
    sourceKey: string | null;
    podcastEpisodeId: string | null;
    playAttempt?: number;
    resumeGraph?: () => void | Promise<void>;
  }) {
    const audio = audioRef.current;
    if (!audio) return;
    const playAttempt = options.playAttempt ?? beginPlayAttempt();
    const { sourceKey, podcastEpisodeId } = options;
    const resumeGraph = options.resumeGraph
      ?? (() => audioEngineRef.current?.resumeAudioGraph());

    void audio
      .play()
      .then(() => {
        if (
          !isCurrentPlayAttempt(
            { sourceKey, attempt: playAttempt },
            audioPlayAttemptRef.current,
            activeAudioSourceKeyRef.current,
          )
        ) return;
        setIsPlaying(true);
        if (podcastEpisodeId) {
          podcastPlaybackStartedEpisodeRef.current = podcastEpisodeId;
          setPodcastPlaybackStatus("playing");
          consumePendingPodcastQueueEpisode(podcastEpisodeId, podcastAudioEpisodeRef.current);
        }
        void resumeGraph();
      })
      .catch(() => {
        if (
          !isCurrentPlayAttempt(
            { sourceKey, attempt: playAttempt },
            audioPlayAttemptRef.current,
            activeAudioSourceKeyRef.current,
          )
        ) return;
        setIsPlaying(false);
        if (podcastEpisodeId && activePodcastEpisodeRef.current) {
          setPodcastPlaybackStatus("error");
        }
      });
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const {
      visualizerUnavailableRef,
      realtimeBeatRef,
      offlineBeatGridRef,
      beatGridCacheRef,
      beatFrameRef,
      beatAnalysisRequestRef,
      resumeAudioGraph,
      preAnalyzeBeatGrid,
      publishIdleBeatFrame,
      publishPodcastVisualizerReset,
    } = audioEngineRef.current!;
    const sourceKey = activePlaybackSourceKey;
    const playAttempt = audioPlayAttemptRef.current + 1;
    audioPlayAttemptRef.current = playAttempt;
    activeAudioSourceKeyRef.current = sourceKey;
    if (!activePlayback) {
      podcastAudioEpisodeRef.current = null;
      podcastPlaybackStartedEpisodeRef.current = null;
      pendingPodcastStartRef.current = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setProgress(0);
      setDuration(0);
      setIsPlaying(false);
      setPodcastPlaybackStatus("idle");
      return;
    }

    const podcastEpisodeId = activePlayback.kind === "podcast"
      ? activePlayback.episode.episodeId
      : null;
    podcastAudioEpisodeRef.current = podcastEpisodeId;
    const sourceUrl = activePlayback.kind === "podcast"
      ? activePlayback.episode.playbackLocalPath
        ? convertFileSrc(activePlayback.episode.playbackLocalPath, "zone-audio")
        : convertFileSrc(activePlayback.episode.episodeId, "zone-podcast")
      : convertFileSrc(activePlayback.track.path, "zone-audio");
    visualizerUnavailableRef.current = false;
    realtimeBeatRef.current = null;
    offlineBeatGridRef.current = activePlayback.kind === "music"
      ? beatGridCacheRef.current.get(activePlayback.track.id) ?? null
      : null;
    beatFrameRef.current = createIdleBeatFrame();
    if (activePlayback.kind === "music") {
      podcastPlaybackStartedEpisodeRef.current = null;
      publishIdleBeatFrame();
      pendingPodcastResumeRef.current = null;
      pendingPodcastStartRef.current = null;
      setPodcastPlaybackStatus("idle");
      void preAnalyzeBeatGrid(activePlayback.track);
    } else {
      if (podcastPlaybackStartedEpisodeRef.current !== podcastEpisodeId) {
        podcastPlaybackStartedEpisodeRef.current = null;
      }
      beatAnalysisRequestRef.current += 1;
      publishPodcastVisualizerReset();
      setPodcastPlaybackStatus("loading");
      const { position: startPosition, explicit: explicitStart } =
        resolvePodcastStartPosition(
          pendingPodcastStartRef.current,
          activePlayback.episode.episodeId,
          activePlayback.episode.savedProgressSeconds,
        );
      if (explicitStart) {
        pendingPodcastStartRef.current = null;
      }
      pendingPodcastResumeRef.current = {
        episodeId: activePlayback.episode.episodeId,
        position: startPosition,
        explicit: explicitStart,
      };
      setProgress(Math.max(0, startPosition));
    }
    if (activePlayback.kind === "music") setProgress(0);
    setDuration(
      activePlayback.kind === "podcast"
        ? Math.max(0, activePlayback.episode.durationSeconds ?? 0)
        : 0,
    );
    audio.crossOrigin = "anonymous";
    audio.src = sourceUrl;
    audio.playbackRate = activePlayback.kind === "podcast" ? podcastPlaybackRate : 1;
    audio.load();

    const shouldAutoplay = activePlayback.kind === "music" || podcastPlaybackIntentRef.current;
    if (!shouldAutoplay) {
      setIsPlaying(false);
      if (activePlayback.kind === "podcast") setPodcastPlaybackStatus("paused");
      return;
    }

    runPlayAttempt({
      sourceKey,
      podcastEpisodeId,
      playAttempt,
      resumeGraph: resumeAudioGraph,
    });
  }, [activePlaybackSourceKey]);

  function stopPodcastForMusic() {
    flushPodcastProgress();
    podcastPlaybackIntentRef.current = false;
    beginPlayAttempt();
    audioRef.current?.pause();
    cancelPendingQueueConsume();
    clearActivePodcast();
  }

  function playTrack(track: Track, sourceTracks = tracks) {
    cancelPodcastSessionRestore();
    setQueue(sourceTracks.map((item) => item.id));
    if (activePodcastEpisode) {
      stopPodcastForMusic();
      setActiveTrackId(track.id);
      return;
    }
    if (track.id === activeTrackId) {
      recordSkipIfEligible();
      restartCurrentPlayback();
    }
    else {
      recordSkipIfEligible();
      beginPlayAttempt();
      setActiveTrackId(track.id);
    }
  }

  function playTracks(targetTracks: Track[]) {
    if (targetTracks.length === 0) return;
    cancelPodcastSessionRestore();
    setQueue(targetTracks.map((track) => track.id));
    if (activePodcastEpisode) {
      stopPodcastForMusic();
      setActiveTrackId(targetTracks[0].id);
      return;
    }
    if (targetTracks[0].id === activeTrackId) {
      recordSkipIfEligible();
      restartCurrentPlayback();
    }
    else {
      recordSkipIfEligible();
      beginPlayAttempt();
      setActiveTrackId(targetTracks[0].id);
    }
  }

  function appendToQueue(targetTracks: Track[]) {
    if (targetTracks.length === 0) return;
    setQueue((current) => uniqueIds([...current, ...targetTracks.map((track) => track.id)]));
    showActionNotice(`已添加 ${targetTracks.length} 首歌曲到正在播放`);
  }

  function applyActivityFromServer(trackId: string, activity: ReturnType<typeof createTrackActivity>) {
    setTrackActivity((current) => ({
      ...current,
      [trackId]: createTrackActivity(activity),
    }));
  }

  function finalizeSession(
    session: PlaybackSession,
    outcome: "completed" | "skipped" | "replaced" | "stopped" | "error",
  ) {
    if (session.finalized) return;
    session.finalized = true;
    if (session.lastTickAt != null && isPlaying) {
      session.listenedMs += Math.max(0, Date.now() - session.lastTickAt);
      session.lastTickAt = null;
    }
    const durationMs = Math.round((session.durationHint ?? duration ?? 0) * 1000);
    void musicSessionEnd({
      sessionId: session.sessionId,
      trackId: session.trackId,
      startPositionMs: Math.round(session.startPosition * 1000),
      endPositionMs: Math.round(session.maxProgress * 1000),
      durationMs: durationMs > 0 ? durationMs : undefined,
      listenedMs: Math.round(session.listenedMs),
      outcome,
      source: session.source,
      maxProgressMs: Math.round(session.maxProgress * 1000),
    }).then((result) => {
      applyActivityFromServer(result.trackId, {
        addedAt: result.activity.addedAt,
        playCount: result.activity.playCount,
        completedCount: result.activity.completedCount,
        skipCount: result.activity.skipCount,
        lastPlayedAt: result.activity.lastPlayedAt,
        lastSkippedAt: result.activity.lastSkippedAt,
      });
      if (playbackSessionRef.current?.sessionId === session.sessionId) {
        playbackSessionRef.current.countedPlay = result.countedPlay;
        playbackSessionRef.current.countedComplete = result.countedComplete;
      }
    }).catch((error) => {
      if (import.meta.env.DEV) console.warn("[stats] session end failed", error);
    });
  }

  function updateTrackActivity(trackId: string, update: (current: ReturnType<typeof createTrackActivity>) => ReturnType<typeof createTrackActivity>) {
    setTrackActivity((current) => ({
      ...current,
      [trackId]: update(createTrackActivity(current[trackId])),
    }));
  }

  function markEffectivePlay() {
    // Play counting is finalized by Rust play_sessions aggregation.
    const session = playbackSessionRef.current;
    if (!session || session.countedPlay) return;
    // Optimistic local marker only; authoritative counters come from session end.
    session.countedPlay = true;
  }

  function markCompletedPlayback() {
    const session = playbackSessionRef.current;
    if (!session || session.finalized) return;
    finalizeSession(session, "completed");
  }

  function recordSkipIfEligible() {
    const session = playbackSessionRef.current;
    if (!session || session.finalized) return;
    if (session.maxProgress < 3) {
      finalizeSession(session, "replaced");
      return;
    }
    const trackDuration = audioRef.current?.duration || duration;
    if (trackDuration > 0 && session.maxProgress / trackDuration >= 0.5) {
      finalizeSession(session, "replaced");
      return;
    }
    finalizeSession(session, "skipped");
  }

  function handleTimeUpdate(currentTime: number, trackDuration: number) {
    const podcastEpisode = activePodcastEpisodeRef.current;
    if (podcastEpisode) {
      const pending = pendingPodcastResumeRef.current;
      if (pending?.episodeId === podcastEpisode.episodeId) {
        setProgress(Math.max(0, pending.position));
        return;
      }
      setProgress(currentTime);
      persistPodcastProgress(currentTime, trackDuration);
      return;
    }
    setProgress(currentTime);
    const session = playbackSessionRef.current;
    if (!session || session.trackId !== activeTrackId || session.finalized) return;
    session.maxProgress = Math.max(session.maxProgress, currentTime);
    session.durationHint = trackDuration > 0 ? trackDuration : session.durationHint;
    if (isPlaying) {
      const now = Date.now();
      if (session.lastTickAt != null) {
        session.listenedMs += Math.max(0, now - session.lastTickAt);
      }
      session.lastTickAt = now;
    }
    const threshold = trackDuration > 0
      ? Math.min(240, Math.max(30, trackDuration * 0.5))
      : 30;
    if (currentTime >= threshold) markEffectivePlay();
  }

  function move(delta: 1 | -1, reason: "user" | "ended" = "user"): QueueMoveResult {
    cancelPodcastSessionRestore();
    if (activePodcastEpisode) return { kind: "boundary" };
    if (baseQueueIds.length === 0) return { kind: "empty" };
    if (delta === 1 && reason === "user") recordSkipIfEligible();

    let playbackOrder = playbackQueueIds;
    if (shuffle && !haveSameQueueItems(shuffleOrder, baseQueueIds)) {
      playbackOrder = createShuffleOrder(baseQueueIds, activeTrackId);
      setShuffleOrder(playbackOrder);
    }
    const activeIndex = playbackOrder.indexOf(activeTrackId ?? "");
    if (shuffle && repeat === "all" && delta === 1 && activeIndex === playbackOrder.length - 1 && playbackOrder.length > 1) {
      playbackOrder = createShuffleOrder(baseQueueIds, activeTrackId);
      setShuffleOrder(playbackOrder);
    }

    const result = resolveQueueMove(playbackOrder, activeTrackId, delta, repeat);
    if (result.kind === "restart") restartCurrentPlayback();
    if (result.kind === "move") setActiveTrackId(result.trackId);
    return result;
  }

  function onEnded() {
    if (activePodcastEpisodeRef.current) {
      setIsPlaying(false);
      handleEpisodeEnded(audioRef.current?.duration ?? 0);
      return;
    }
    markCompletedPlayback();
    if (repeat === "one" && audioRef.current) {
      restartCurrentPlayback();
      return;
    }

    const result = move(1, "ended");
    if (result.kind === "boundary" || result.kind === "empty") {
      setIsPlaying(false);
    }
  }

  function seek(value: number) {
    if (!audioRef.current) return;
    const podcastEpisode = activePodcastEpisodeRef.current;
    if (podcastEpisode) resumePodcastProgressWrites(podcastEpisode.episodeId);
    if (pendingPodcastResumeRef.current?.episodeId === podcastEpisode?.episodeId) {
      pendingPodcastResumeRef.current = null;
    }
    audioRef.current.currentTime = value;
    setProgress(value);
    if (activePodcastEpisodeRef.current) {
      persistPodcastProgress(value, audioRef.current.duration, true);
    }
  }

  function handleLoadedMetadata(audio: HTMLAudioElement) {
    const nextDuration = Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : 0;
    setDuration(nextDuration);
    const pending = pendingPodcastResumeRef.current;
    const episode = activePodcastEpisodeRef.current;
    if (!pending || !episode || pending.episodeId !== episode.episodeId) return;
    pendingPodcastResumeRef.current = null;
    const resumePosition = resolvePodcastResumePosition(pending, episode, nextDuration);
    if (resumePosition > 0) audio.currentTime = resumePosition;
    setProgress(resumePosition);
  }

  function handleAudioPause() {
    setIsPlaying(false);
    if (activePodcastEpisodeRef.current) {
      setPodcastPlaybackStatus(
        podcastStatusForPause(podcastPlaybackIntentRef.current),
      );
    }
  }

  function handleAudioError() {
    setIsPlaying(false);
    if (activePodcastEpisodeRef.current) {
      setPodcastPlaybackStatus("error");
      showActionNotice("播放失败，请检查网络或重新下载");
    }
  }

  function handleAudioLoadStart() {
    if (activePodcastEpisodeRef.current) setPodcastPlaybackStatus("loading");
  }

  function handleAudioWaiting() {
    if (activePodcastEpisodeRef.current) {
      setPodcastPlaybackStatus(
        podcastStatusForWaiting(podcastPlaybackIntentRef.current),
      );
    }
  }

  function handleAudioCanPlay() {
    if (!activePodcastEpisodeRef.current) return;
    setPodcastPlaybackStatus(
      podcastStatusForCanPlay(
        podcastPlaybackIntentRef.current,
        Boolean(audioRef.current?.paused),
      ),
    );
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !activePlayback) return;

    if (audio.paused) {
      if (activePodcastEpisodeRef.current) {
        resumePodcastProgressWrites(activePodcastEpisodeRef.current.episodeId);
      }
      const musicSession = playbackSessionRef.current;
      if (musicSession && !musicSession.finalized) {
        musicSession.lastTickAt = Date.now();
      }
      const sourceKey = activeAudioSourceKeyRef.current;
      const playAttempt = audioPlayAttemptRef.current + 1;
      audioPlayAttemptRef.current = playAttempt;
      const podcastEpisodeId = activePodcastEpisodeRef.current?.episodeId ?? null;
      if (podcastEpisodeId) podcastPlaybackIntentRef.current = true;
      runPlayAttempt({ sourceKey, podcastEpisodeId, playAttempt });
    } else {
      flushPodcastProgress();
      if (activePodcastEpisodeRef.current) podcastPlaybackIntentRef.current = false;
      const musicSession = playbackSessionRef.current;
      if (musicSession && !musicSession.finalized && musicSession.lastTickAt != null) {
        musicSession.listenedMs += Math.max(0, Date.now() - musicSession.lastTickAt);
        musicSession.lastTickAt = null;
      }
      beginPlayAttempt();
      audio.pause();
      setIsPlaying(false);
    }
  }

  function retryPodcastPlayback() {
    const audio = audioRef.current;
    const episode = activePodcastEpisodeRef.current;
    if (!audio || !episode) return;
    resumePodcastProgressWrites(episode.episodeId);
    const currentPosition = Number.isFinite(audio.currentTime)
      ? Math.max(0, audio.currentTime)
      : 0;
    const resumePosition = currentPosition > 0 ? currentPosition : progress;
    const sourceKey = activeAudioSourceKeyRef.current;
    const playAttempt = audioPlayAttemptRef.current + 1;
    audioPlayAttemptRef.current = playAttempt;
    persistPodcastProgress(resumePosition, audio.duration, true);
    pendingPodcastResumeRef.current = {
      episodeId: episode.episodeId,
      position: resumePosition,
    };
    podcastPlaybackIntentRef.current = true;
    setPodcastPlaybackStatus("loading");
    audio.load();
    runPlayAttempt({
      sourceKey,
      podcastEpisodeId: episode.episodeId,
      playAttempt,
    });
  }

  function restartCurrentPlayback() {
    const audio = audioRef.current;
    if (!audio || activePodcastEpisode || !activeTrack) return;
    audio.currentTime = 0;
    setProgress(0);
    const previous = playbackSessionRef.current;
    if (previous && !previous.finalized) finalizeSession(previous, "replaced");
    const sessionId = `music-${activeTrack.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    playbackSessionRef.current = {
      sessionId,
      trackId: activeTrack.id,
      startedAt: Date.now(),
      startPosition: 0,
      maxProgress: 0,
      listenedMs: 0,
      lastTickAt: null,
      source: "restart",
      durationHint: duration || null,
      countedPlay: false,
      countedComplete: false,
      finalized: false,
    };
    void musicSessionStart({
      sessionId,
      trackId: activeTrack.id,
      startPositionMs: 0,
      durationMs: duration > 0 ? Math.round(duration * 1000) : undefined,
      source: "restart",
    }).catch((error) => {
      if (import.meta.env.DEV) console.warn("[stats] session start failed", error);
    });
    const sourceKey = activeAudioSourceKeyRef.current;
    const playAttempt = audioPlayAttemptRef.current + 1;
    audioPlayAttemptRef.current = playAttempt;
    runPlayAttempt({
      sourceKey,
      podcastEpisodeId: null,
      playAttempt,
    });
  }

  return {
    isPlaying,
    setIsPlaying,
    progress,
    setProgress,
    duration,
    setDuration,
    volume,
    setVolume,
    shuffle,
    setShuffle,
    repeat,
    setRepeat,
    activeTrack,
    activePlayback,
    activePlaybackSourceKey,
    playbackQueueIds,
    canMovePrevious,
    canMoveNext,
    playTrack,
    playTracks,
    appendToQueue,
    handleTimeUpdate,
    move,
    onEnded,
    seek,
    handleLoadedMetadata,
    handleAudioPause,
    handleAudioError,
    handleAudioLoadStart,
    handleAudioWaiting,
    handleAudioCanPlay,
    togglePlay,
    retryPodcastPlayback,
    armPodcastPlay,
    clearPlaybackIntent,
    setPlaybackIntent,
    clearPendingPodcastStart,
    peekPendingResumePosition,
    hasEpisodeStartedOnDevice,
  };
}
