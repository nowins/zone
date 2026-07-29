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
import { createTrackActivity } from "../utils/smartPlaylist";
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
  trackId: string;
  maxProgress: number;
  countedPlay: boolean;
  countedComplete: boolean;
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
    activePodcastEpisodeRef,
    podcastAudioEpisodeRef,
    podcastPlaybackStartedEpisodeRef,
    pendingPodcastQueueConsumeRef,
    podcastAutoQueueModeRef,
    podcastSleepTimer,
    setPodcastSleepTimer,
    setPodcastPlaybackStatus,
    podcastPlaybackRate,
    podcastSessionHydrated,
    cancelPodcastSessionRestore,
    clearActivePodcast,
    markEpisodeCompletedOnEnd,
    bumpLibraryRevision,
    flushPodcastProgress,
    persistPodcastProgress,
    resumePodcastProgressWrites,
    consumePendingPodcastQueueEpisode,
    playNextPodcastEpisode,
    autofillPodcastQueueAfter,
  } = podcast;

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
    playbackSessionRef.current = !activePodcastEpisode && activeTrackId
      ? { trackId: activeTrackId, maxProgress: 0, countedPlay: false, countedComplete: false }
      : null;
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
    audioPlayAttemptRef.current += 1;
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
    audioPlayAttemptRef.current += 1;
    audioRef.current?.pause();
  }

  function peekPendingResumePosition(episodeId: string | null) {
    const pending = pendingPodcastResumeRef.current;
    if (!episodeId || !pending || pending.episodeId !== episodeId) return null;
    return pending.position;
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
          activeAudioSourceKeyRef.current !== sourceKey
          || audioPlayAttemptRef.current !== playAttempt
        ) return;
        setIsPlaying(true);
        if (podcastEpisodeId) {
          podcastPlaybackStartedEpisodeRef.current = podcastEpisodeId;
          setPodcastPlaybackStatus("playing");
          consumePendingPodcastQueueEpisode(podcastEpisodeId);
        }
        void resumeGraph();
      })
      .catch(() => {
        if (
          activeAudioSourceKeyRef.current !== sourceKey
          || audioPlayAttemptRef.current !== playAttempt
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
      const requestedStart = pendingPodcastStartRef.current;
      const explicitStart =
        requestedStart?.episodeId === activePlayback.episode.episodeId;
      const startPosition = explicitStart
        ? requestedStart!.position
        : activePlayback.episode.savedProgressSeconds;
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
    audioPlayAttemptRef.current += 1;
    audioRef.current?.pause();
    pendingPodcastQueueConsumeRef.current = null;
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
      audioPlayAttemptRef.current += 1;
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
      audioPlayAttemptRef.current += 1;
      setActiveTrackId(targetTracks[0].id);
    }
  }

  function appendToQueue(targetTracks: Track[]) {
    if (targetTracks.length === 0) return;
    setQueue((current) => uniqueIds([...current, ...targetTracks.map((track) => track.id)]));
    showActionNotice(`已添加 ${targetTracks.length} 首歌曲到正在播放`);
  }

  function updateTrackActivity(trackId: string, update: (current: ReturnType<typeof createTrackActivity>) => ReturnType<typeof createTrackActivity>) {
    setTrackActivity((current) => ({
      ...current,
      [trackId]: update(createTrackActivity(current[trackId])),
    }));
  }

  function markEffectivePlay() {
    const session = playbackSessionRef.current;
    if (!session || session.countedPlay) return;
    session.countedPlay = true;
    updateTrackActivity(session.trackId, (current) => ({
      ...current,
      playCount: current.playCount + 1,
      lastPlayedAt: Date.now(),
    }));
  }

  function markCompletedPlayback() {
    const session = playbackSessionRef.current;
    if (!session || session.countedComplete) return;
    if (!session.countedPlay) markEffectivePlay();
    session.countedComplete = true;
    updateTrackActivity(session.trackId, (current) => ({
      ...current,
      completedCount: current.completedCount + 1,
      lastPlayedAt: Date.now(),
    }));
  }

  function recordSkipIfEligible() {
    const session = playbackSessionRef.current;
    if (!session || session.countedPlay || session.maxProgress < 3) return;
    const trackDuration = audioRef.current?.duration || duration;
    if (trackDuration > 0 && session.maxProgress / trackDuration >= 0.5) return;
    session.countedPlay = true;
    updateTrackActivity(session.trackId, (current) => ({
      ...current,
      skipCount: current.skipCount + 1,
      lastSkippedAt: Date.now(),
    }));
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
    if (!session || session.trackId !== activeTrackId) return;
    session.maxProgress = Math.max(session.maxProgress, currentTime);
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
      const endedEpisodeId = activePodcastEpisodeRef.current.episodeId;
      const audio = audioRef.current;
      const progressSaved = audio
        ? persistPodcastProgress(audio.duration, audio.duration, true)
        : Promise.resolve();
      markEpisodeCompletedOnEnd(audio?.duration || 0);
      void progressSaved.finally(() => {
        bumpLibraryRevision();
      });
      setIsPlaying(false);
      if (
        podcastSleepTimer?.kind === "episodeEnd"
        && podcastSleepTimer.episodeId === endedEpisodeId
      ) {
        podcastPlaybackIntentRef.current = false;
        setPodcastSleepTimer(null);
        setPodcastPlaybackStatus("paused");
        showActionNotice("已在本集结束后暂停");
        return;
      }
      if (playNextPodcastEpisode(false)) return;
      if (podcastAutoQueueModeRef.current !== "off") {
        autofillPodcastQueueAfter(endedEpisodeId);
        return;
      }
      podcastPlaybackIntentRef.current = false;
      setPodcastPlaybackStatus("paused");
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
    const resumePosition = pending.explicit
      ? Math.min(pending.position, nextDuration || pending.position)
      : !episode.completed && pending.position > 0 && (
          nextDuration <= 0 || pending.position < Math.max(0, nextDuration - 5)
        )
        ? Math.min(pending.position, nextDuration || pending.position)
        : 0;
    if (resumePosition > 0) audio.currentTime = resumePosition;
    setProgress(resumePosition);
  }

  function handleAudioPause() {
    setIsPlaying(false);
    if (activePodcastEpisodeRef.current) {
      setPodcastPlaybackStatus(
        podcastPlaybackIntentRef.current ? "loading" : "paused",
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
        podcastPlaybackIntentRef.current ? "buffering" : "paused",
      );
    }
  }

  function handleAudioCanPlay() {
    if (!activePodcastEpisodeRef.current) return;
    if (!podcastPlaybackIntentRef.current) {
      setPodcastPlaybackStatus("paused");
      return;
    }
    setPodcastPlaybackStatus(audioRef.current?.paused ? "loading" : "playing");
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !activePlayback) return;

    if (audio.paused) {
      if (activePodcastEpisodeRef.current) {
        resumePodcastProgressWrites(activePodcastEpisodeRef.current.episodeId);
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
      audioPlayAttemptRef.current += 1;
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
    playbackSessionRef.current = {
      trackId: activeTrack.id,
      maxProgress: 0,
      countedPlay: false,
      countedComplete: false,
    };
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
  };
}
