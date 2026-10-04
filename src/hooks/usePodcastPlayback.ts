import { recordDiagnostic } from "../utils/diagnostics";
import { createPodcastListeningMeter } from "../utils/podcastListeningStats.js";
import { recordEpisodeBookmark, downloadPodcastEpisode, getPodcastPreferences, setPodcastPreferences } from "../views/podcast/api";
import { formatTime } from "../utils/music";
import { DEFAULT_PODCAST_PREFERENCES, effectivePodcastPreferences, podcastIntroPosition, podcastOutroReached, type PodcastPreferences } from "../utils/podcastPreferences.js";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { movePodcastQueueItem, podcastPlaybackForEpisode } from "../utils/podcastPlayback";
import { shouldConsumePendingQueueEpisode } from "../utils/playbackTransport";
import { createPodcastProgressWriteGate } from "../utils/podcastProgress";
import {
  PODCAST_AUTO_QUEUE_MODES,
  PODCAST_PROGRESS_SAVE_INTERVAL_MS,
  patchPodcastPlaybackSettings,
  readPodcastActiveEpisodeId,
  readPodcastAutoQueueMode,
  readPodcastPlaybackRate,
} from "../app/podcastPlaybackSettings";
import type { PodcastTransportBridge } from "./podcastTransport";
import type { PlaybackControlsHandle, PlaybackSession } from "./usePlaybackControls";
import type {
  AppPage,
  PodcastAutoQueueMode,
  PodcastEpisode,
  PodcastEpisodeDetail,
  PodcastPlayback,
  PodcastPlaybackStatus,
  PodcastQueueItem,
  PodcastSleepTimer,
} from "../types";

type UsePodcastPlaybackParams = {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  showActionNotice: (message: string) => void;
  requestNavigation: (next: AppPage) => void;
  playbackControlsRef: React.MutableRefObject<PlaybackControlsHandle | null>;
  playbackSessionRef: React.MutableRefObject<PlaybackSession | null>;
};

export function usePodcastPlayback({
  audioRef,
  showActionNotice,
  requestNavigation,
  playbackControlsRef,
  playbackSessionRef,
}: UsePodcastPlaybackParams) {
  const activePodcastEpisodeRef = useRef<PodcastPlayback | null>(null);
  const podcastQueueRef = useRef<PodcastQueueItem[]>([]);
  const podcastQueueRevisionRef = useRef(0);
  const podcastQueueMutationRef = useRef<Promise<void>>(Promise.resolve());
  const pendingPodcastQueueConsumeRef = useRef<string | null>(null);
  // A failed consume is remembered for the current queue revision. The failure
  // path reloads the queue, which arrives as a fresh array and would otherwise
  // re-arm the consume immediately, looping on a persistently failing IPC.
  const podcastQueueConsumeFailureRef = useRef<{
    episodeId: string;
    revision: number;
  } | null>(null);
  const podcastProgressSaveRef = useRef<{
    episodeId: string;
    savedAt: number;
    position: number;
    duration: number;
  } | null>(null);
  const podcastProgressMutationRef = useRef<Promise<void>>(Promise.resolve());
  const podcastProgressSaveFailedRef = useRef(false);
  const podcastProgressWriteGateRef = useRef(createPodcastProgressWriteGate());
  const podcastProgressStartedRef = useRef(new Set<string>());
  const podcastSessionProgressRef = useRef(new Map<string, Pick<
    PodcastEpisode, "progressSeconds" | "durationSeconds" | "completed"
  >>());
  const podcastAutoQueueAttemptRef = useRef(0);
  const podcastSessionHydratedRef = useRef(false);
  const podcastSessionRestoreCancelledRef = useRef(false);
  const podcastActiveSessionMutationRef = useRef<Promise<void>>(Promise.resolve());
  const podcastActiveSessionRevisionRef = useRef(0);
  const podcastActiveSessionSaveFailedRef = useRef(false);
  const podcastActiveSessionRetryRef = useRef<number | null>(null);
  const podcastActiveSessionMountedRef = useRef(false);
  const podcastSleepTimerRef = useRef<number | null>(null);
  const [activePodcastEpisode, setActivePodcastEpisode] = useState<PodcastPlayback | null>(null);
  const [queueUndo, setQueueUndo]=useState<{ids:string[];expected:string[];active:string|null;expires:number;kind:"remove"|"replace"}|null>(null);
  const queueUndoRef=useRef(queueUndo);queueUndoRef.current=queueUndo;
  useEffect(()=>{if(!queueUndo)return;const timer=window.setTimeout(()=>setQueueUndo(null),Math.max(0,queueUndo.expires-Date.now()));return()=>window.clearTimeout(timer);},[queueUndo]);
  const [podcastQueue, setPodcastQueue] = useState<PodcastQueueItem[]>([]);
  const [podcastLibraryRevision, setPodcastLibraryRevision] = useState(0);
  const [podcastEpisodeRequest, setPodcastEpisodeRequest] = useState<{
    episodeId: string;
    nonce: number;
    returnToNowPlaying?: boolean;
  } | null>(null);
  const [podcastPlaybackRate, applyPodcastPlaybackRate] = useState(readPodcastPlaybackRate);
  const defaultPlaybackRateRef=useRef(podcastPlaybackRate);
  const preferencesMutationRef=useRef<Promise<void>>(Promise.resolve());
  const manualRatePendingRef=useRef(0);
  const [preferencesRevision,setPreferencesRevision]=useState(0);
  const [episodePreferences,setEpisodePreferences]=useState<{episodeId:string;value:PodcastPreferences;custom:boolean}|null>(null);
  const episodePreferencesRef=useRef(episodePreferences);episodePreferencesRef.current=episodePreferences;
  const completedBoundaryRef=useRef<string|null>(null);
  const [podcastAutoQueueMode, setPodcastAutoQueueMode] =
    useState<PodcastAutoQueueMode>(readPodcastAutoQueueMode);
  const podcastAutoQueueModeRef = useRef(podcastAutoQueueMode);
  const [podcastSleepTimer, setPodcastSleepTimer] = useState<PodcastSleepTimer>(null);
  const sleepStateRef = useRef(podcastSleepTimer); sleepStateRef.current = podcastSleepTimer;
  const [podcastPlaybackStatus, setPodcastPlaybackStatus] = useState<PodcastPlaybackStatus>("idle");
  const [podcastSessionHydrated, setPodcastSessionHydrated] = useState(false);
  const [podcastActiveSessionReady, setPodcastActiveSessionReady] = useState(false);
  activePodcastEpisodeRef.current = activePodcastEpisode;
  podcastQueueRef.current = podcastQueue;
  podcastAutoQueueModeRef.current = podcastAutoQueueMode;

  useEffect(()=>{
    const element=audioRef.current;if(!element)return;const audio:HTMLAudioElement=element;
    const meter=createPodcastListeningMeter();
    const pending:Array<{episodeId:string;seconds:number;batchId:string}>=[];
    let writing=false,failed=false,lastFlush=performance.now(),disposed=false;
    async function write(){
      if(writing||!pending.length)return;writing=true;
      try{while(pending.length){const batch=pending[0];await invoke("podcast_record_listening",batch);pending.shift();}failed=false;}
      catch{if(!failed){recordDiagnostic({domain:"podcast",event:"listening_save",outcome:"error"});showActionNotice("收听统计暂未保存，将自动重试");}failed=true;}
      finally{writing=false;}
    }
    function flush(){
      if(pending.length>=100){meter.reset();lastFlush=performance.now();void write();return;}
      for(const batch of meter.drain()) {if(batch.seconds>0&&pending.length<100)pending.push({...batch,batchId:crypto.randomUUID().replace(/-/g,"")+crypto.randomUUID().replace(/-/g,"")});}
      lastFlush=performance.now();void write();
    }
    function sample(){
      if(disposed)return;
      if(pending.length>=100){meter.reset();void write();return;}
      meter.sample({episodeId:activePodcastEpisodeRef.current?.episodeId??null,clockMs:performance.now(),position:audio.currentTime,rate:audio.playbackRate,playing:!audio.paused&&!audio.ended&&audio.readyState>=2&&!audio.error,seeking:audio.seeking});
      if(audio.paused||performance.now()-lastFlush>=15000)flush();
    }
    const events=["timeupdate","play","pause","seeking","seeked","emptied","ended","ratechange"];
    events.forEach(event=>audio.addEventListener(event,sample));
    window.addEventListener("pagehide",flush);
    return()=>{disposed=true;events.forEach(event=>audio.removeEventListener(event,sample));window.removeEventListener("pagehide",flush);flush();};
  },[audioRef]);

  useEffect(()=>{
    const episode=activePodcastEpisode;if(!episode)return;
    let disposed=false;
    void Promise.all([getPodcastPreferences(),getPodcastPreferences(episode.feedId)]).then(([global,feed])=>{
      if(disposed)return;
      const value=effectivePodcastPreferences(global,feed);
      if(!manualRatePendingRef.current && global?.playbackRate)defaultPlaybackRateRef.current=global.playbackRate;
      setEpisodePreferences({episodeId:episode.episodeId,value,custom:feed?.inheritPlayback===false});
      if(!manualRatePendingRef.current)applyPodcastPlaybackRate(value.playbackRate ?? defaultPlaybackRateRef.current);
    }).catch(()=>{
      if(disposed)return;
      setEpisodePreferences({episodeId:episode.episodeId,value:DEFAULT_PODCAST_PREFERENCES,custom:false});
      applyPodcastPlaybackRate(defaultPlaybackRateRef.current);
      showActionNotice("播放设置读取失败，使用默认播放设置");
    });
    return()=>{disposed=true;};
  },[activePodcastEpisode?.episodeId,preferencesRevision]);

  useEffect(()=>{
    let disposed=false;let stop:(()=>void)|undefined;
    void listen<string|null>("podcast-preferences-changed",event=>{
      if(!event.payload || event.payload===activePodcastEpisodeRef.current?.feedId)setPreferencesRevision(value=>value+1);
    }).then(unlisten=>{if(disposed)unlisten();else stop=unlisten;}).catch(()=>{});
    return()=>{disposed=true;stop?.();};
  },[]);

  function setPodcastPlaybackRate(rate:number) {
    if(!Number.isFinite(rate)||rate<0.5||rate>3)return;
    const current=activePodcastEpisodeRef.current;
    if (current && episodePreferencesRef.current?.episodeId !== current.episodeId) { showActionNotice("正在读取节目设置，请稍后再试"); return; }
    applyPodcastPlaybackRate(rate);
    const custom=episodePreferencesRef.current?.episodeId===current?.episodeId && episodePreferencesRef.current?.custom;
    const feedId=custom?current?.feedId:undefined;
    if(!custom){defaultPlaybackRateRef.current=rate;patchPodcastPlaybackSettings({playbackRate:rate});}
    manualRatePendingRef.current++;
    preferencesMutationRef.current=preferencesMutationRef.current.then(async()=>{
      const previous=await getPodcastPreferences(feedId);
      await setPodcastPreferences({...DEFAULT_PODCAST_PREFERENCES,...previous,playbackRate:rate},feedId);
    }).catch(()=>showActionNotice("倍速已应用，本次设置未能保存")).finally(()=>{manualRatePendingRef.current--;});
  }

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("podcast-library-changed", event => {
      setPodcastLibraryRevision(value => value + 1);
      if (event.payload === true) void reloadPodcastQueue(podcastQueueRevisionRef.current);
    })
      .then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => {});
    return () => { disposed = true; stop?.(); };
  }, []);

  useEffect(() => {
    podcastActiveSessionMountedRef.current = true;
    return () => {
      podcastActiveSessionMountedRef.current = false;
      if (podcastActiveSessionRetryRef.current !== null) window.clearTimeout(podcastActiveSessionRetryRef.current);
      podcastActiveSessionRetryRef.current = null;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const revision = podcastQueueRevisionRef.current;
    void invoke<PodcastQueueItem[]>("podcast_list_queue")
      .then((items) => {
        if (!disposed && podcastQueueRevisionRef.current === revision) {
          applyPodcastQueue(items);
        }
      })
      .catch((reason) => {
        if (import.meta.env.DEV) console.warn("[podcast] queue restore failed", reason);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const loadEpisode = async () => {
      let episodeId = readPodcastActiveEpisodeId();
      try {
        const session = await invoke<{ activeEpisodeId: string | null } | null>("podcast_load_active_episode");
        if (disposed) return null;
        setPodcastActiveSessionReady(true);
        if (session) episodeId = session.activeEpisodeId;
      } catch {
        if (disposed) return null;
        // Preserve the native record and disable automatic writes on failed recovery.
        recordDiagnostic({ domain: "podcast", event: "session_restore", outcome: "error" });
      }
      if (disposed || podcastSessionRestoreCancelledRef.current || activePodcastEpisodeRef.current) return null;
      return episodeId ? invoke<PodcastEpisodeDetail>("podcast_get_episode_detail", { episodeId }) : null;
    };
    void loadEpisode()
      .then((detail) => {
        if (disposed) return;
        podcastSessionHydratedRef.current = true;
        if (podcastSessionRestoreCancelledRef.current || activePodcastEpisodeRef.current) {
          setPodcastSessionHydrated(true);
          patchPodcastPlaybackSettings({
            activeEpisodeId: activePodcastEpisodeRef.current?.episodeId ?? null,
          });
          return;
        }
        // Restore paused: transport intent defaults false; do not arm play.
        if (detail) {
          setActivePodcastEpisode(podcastPlaybackForEpisode(detail.episode));
          setPodcastPlaybackStatus("paused");
        }
        setPodcastSessionHydrated(true);
      })
      .catch((reason) => {
        if (disposed) return;
        podcastSessionHydratedRef.current = true;
        setPodcastSessionHydrated(true);
        if (podcastSessionRestoreCancelledRef.current || activePodcastEpisodeRef.current) {
          patchPodcastPlaybackSettings({
            activeEpisodeId: activePodcastEpisodeRef.current?.episodeId ?? null,
          });
          return;
        }
        setPodcastActiveSessionReady(false);
        patchPodcastPlaybackSettings({ activeEpisodeId: null });
        if (import.meta.env.DEV) {
          console.warn("[podcast] playback session restore failed", reason);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!podcastSessionHydratedRef.current) return;
    patchPodcastPlaybackSettings({
      playbackRate: defaultPlaybackRateRef.current,
      activeEpisodeId: activePodcastEpisode?.episodeId ?? null,
      autoQueueMode: podcastAutoQueueMode,
    });
    if (activePodcastEpisode && audioRef.current) {
      audioRef.current.playbackRate = podcastPlaybackRate;
    }
  }, [
    activePodcastEpisode?.episodeId,
    podcastAutoQueueMode,
    podcastPlaybackRate,
    podcastSessionHydrated,
  ]);

  useEffect(() => {
    if (podcastActiveSessionReady && podcastSessionHydrated) {
      persistPodcastActiveSession(activePodcastEpisode?.episodeId ?? null);
    }
  }, [activePodcastEpisode?.episodeId, podcastActiveSessionReady, podcastSessionHydrated]);

  function persistPodcastActiveSession(episodeId: string | null) {
    const revision = ++podcastActiveSessionRevisionRef.current;
    podcastActiveSessionMutationRef.current = podcastActiveSessionMutationRef.current.then(async () => {
      if (revision !== podcastActiveSessionRevisionRef.current) return;
      await invoke("podcast_save_active_episode", { episodeId });
      podcastActiveSessionSaveFailedRef.current = false;
      if (podcastActiveSessionRetryRef.current !== null) window.clearTimeout(podcastActiveSessionRetryRef.current);
      podcastActiveSessionRetryRef.current = null;
    }).catch(() => {
      recordDiagnostic({ domain: "podcast", event: "session_save", outcome: "error" });
      if (!podcastActiveSessionMountedRef.current) return;
      if (!podcastActiveSessionSaveFailedRef.current) showActionNotice("当前单集保存失败，将自动重试");
      podcastActiveSessionSaveFailedRef.current = true;
      if (podcastActiveSessionRetryRef.current === null) {
        podcastActiveSessionRetryRef.current = window.setTimeout(() => {
          podcastActiveSessionRetryRef.current = null;
          if (podcastActiveSessionMountedRef.current && podcastActiveSessionSaveFailedRef.current) {
            persistPodcastActiveSession(activePodcastEpisodeRef.current?.episodeId ?? null);
          }
        }, PODCAST_PROGRESS_SAVE_INTERVAL_MS);
      }
    });
  }

  useEffect(() => {
    const episodeId = activePodcastEpisode?.episodeId;
    if (
      episodeId
      && podcastQueue.some((item) => item.episode.id === episodeId)
      && pendingPodcastQueueConsumeRef.current === null
      && !hasPodcastQueueConsumeFailure(episodeId)
    ) {
      pendingPodcastQueueConsumeRef.current = episodeId;
      if (playbackControlsRef.current?.hasEpisodeStartedOnDevice(episodeId)) {
        consumePendingPodcastQueueEpisode(episodeId, episodeId);
      }
    }
  }, [activePodcastEpisode?.episodeId, podcastQueue]);

  useEffect(() => {
    if (!podcastSleepTimer) return;
    if (
      !activePodcastEpisode
      || (
        podcastSleepTimer.kind === "episodeEnd"
        && podcastSleepTimer.episodeId !== activePodcastEpisode.episodeId
      )
    ) {
      setPodcastSleepTimer(null);
    }
  }, [activePodcastEpisode, podcastSleepTimer]);

  useEffect(() => () => {
    cancelPendingPodcastAutofill();
    if (podcastSleepTimerRef.current !== null) window.clearTimeout(podcastSleepTimerRef.current);
  }, []);

  useEffect(() => {
    if (podcastSleepTimerRef.current !== null) {
      window.clearTimeout(podcastSleepTimerRef.current);
      podcastSleepTimerRef.current = null;
    }
    if (!activePodcastEpisode || podcastSleepTimer?.kind !== "deadline") return;
    const remaining = Math.max(0, podcastSleepTimer.deadlineAt - Date.now());
    podcastSleepTimerRef.current = window.setTimeout(() => {
      podcastSleepTimerRef.current = null;
      expireSleepTimer();
    }, remaining);
    return () => {
      if (podcastSleepTimerRef.current !== null) {
        window.clearTimeout(podcastSleepTimerRef.current);
        podcastSleepTimerRef.current = null;
      }
    };
  }, [activePodcastEpisode?.episodeId, podcastSleepTimer]);

  function expireSleepTimer() {
    const timer = sleepStateRef.current;
    if (!activePodcastEpisodeRef.current || timer?.kind !== "deadline" || Date.now() < timer.deadlineAt) return false;
    sleepStateRef.current = null;
    cancelPendingPodcastAutofill();
    void flushPodcastProgress();
    playbackControlsRef.current?.clearPlaybackIntent();
    audioRef.current?.pause();
    setPodcastSleepTimer(null); setPodcastPlaybackStatus("paused");
    showActionNotice("睡眠定时已暂停播放"); return true;
  }

  function cancelPodcastSessionRestore() {
    if (podcastSessionHydratedRef.current) return;
    podcastSessionRestoreCancelledRef.current = true;
    podcastSessionHydratedRef.current = true;
    setPodcastSessionHydrated(true);
  }

  function clearActivePodcast() {
    cancelPendingPodcastAutofill();
    setActivePodcastEpisode(null);
  }

  function cancelPendingPodcastAutofill() {
    podcastAutoQueueAttemptRef.current += 1;
  }

  function markEpisodeCompletedOnEnd(endedDuration: number) {
    setActivePodcastEpisode((current) => current
      ? {
          ...current,
          completed: true,
          progressSeconds: endedDuration || current.durationSeconds || current.progressSeconds,
        }
      : current
    );
  }

  function bumpLibraryRevision() {
    setPodcastLibraryRevision((current) => current + 1);
  }

  function suppressPodcastProgressWrites(episodeId: string) {
    podcastProgressWriteGateRef.current.suppress(episodeId);
    if (podcastProgressSaveRef.current?.episodeId === episodeId) {
      podcastProgressSaveRef.current = null;
    }
    podcastProgressStartedRef.current.delete(episodeId);
  }

  function resumePodcastProgressWrites(episodeId: string) {
    if (!podcastProgressWriteGateRef.current.resume(episodeId)) return;
    podcastProgressSaveRef.current = null;
  }

  function playPodcastEpisode(
    episode: PodcastPlayback,
    positionSeconds?: number,
  ) {
    completedBoundaryRef.current=null;
    cancelPodcastSessionRestore();
    podcastAutoQueueAttemptRef.current += 1;
    const requestedPosition = Number.isFinite(positionSeconds)
      ? Math.max(0, positionSeconds ?? 0)
      : null;
    const current = activePodcastEpisode;
    if (
      current?.episodeId === episode.episodeId
      && (current.playbackLocalPath ?? null) === (episode.playbackLocalPath ?? null)
    ) {
      playbackControlsRef.current?.clearPendingPodcastStart();
      if (requestedPosition !== null) {
        playbackControlsRef.current?.seek(requestedPosition);
        if (audioRef.current?.paused) playbackControlsRef.current?.togglePlay();
      } else {
        playbackControlsRef.current?.togglePlay();
      }
      return;
    }

    flushPodcastProgress();
    resumePodcastProgressWrites(episode.episodeId);
    playbackSessionRef.current = null;
    setPodcastPlaybackStatus("loading");
    pendingPodcastQueueConsumeRef.current = podcastQueueRef.current.some(
      (item) => item.episode.id === episode.id,
    )
      ? episode.id
      : null;
    // Arm transport before the episode state change so the source effect sees intent.
    playbackControlsRef.current?.armPodcastPlay({
      episodeId: episode.episodeId,
      positionSeconds: requestedPosition,
    });
    const latestProgress = podcastSessionProgressRef.current.get(episode.episodeId);
    setActivePodcastEpisode(latestProgress
      ? { ...episode, ...latestProgress, savedProgressSeconds: latestProgress.progressSeconds }
      : episode
    );
  }

  function applyPodcastQueue(items: PodcastQueueItem[]) {
    podcastQueueRef.current = items;
    setPodcastQueue(items);
  }

  function beginPodcastQueueMutation(items: PodcastQueueItem[]) {
    setQueueUndo(null);queueUndoRef.current=null;
    const revision = podcastQueueRevisionRef.current + 1;
    podcastQueueRevisionRef.current = revision;
    applyPodcastQueue(items);
    return revision;
  }

  function applyPodcastQueueResult(items: PodcastQueueItem[], revision: number) {
    if (podcastQueueRevisionRef.current === revision) {
      applyPodcastQueue(items);
    }
  }

  function serializePodcastQueueMutation<T>(operation: () => Promise<T>) {
    const next = podcastQueueMutationRef.current.then(operation, operation);
    podcastQueueMutationRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function reloadPodcastQueue(revision: number) {
    return invoke<PodcastQueueItem[]>("podcast_list_queue")
      .then((items) => applyPodcastQueueResult(items, revision))
      .catch(() => undefined);
  }

  async function playPodcastPlaylist(id: string, startPlayback = true) {
    const snapshot = podcastQueueRef.current;
    const active = activePodcastEpisodeRef.current?.episodeId ?? null;
    const attempt = ++podcastAutoQueueAttemptRef.current;
    cancelPendingQueueConsume();
    const revision = beginPodcastQueueMutation(podcastQueueRef.current);
    await serializePodcastQueueMutation(async () => {
      if (attempt !== podcastAutoQueueAttemptRef.current) return;
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_activate_playlist", { id, startPlayback });
        applyPodcastQueueResult(items, revision);
        if (!startPlayback && revision === podcastQueueRevisionRef.current && active === (activePodcastEpisodeRef.current?.episodeId ?? null)) {
          const ids = snapshot.map(item => item.episode.id).filter(id => id !== active);
          const expected = items.map(item => item.episode.id);
          if (ids.join("|") !== expected.join("|")) setQueueUndo({ ids, expected, active, expires: Date.now() + 30000, kind: "replace" });
        }
        if (startPlayback && attempt === podcastAutoQueueAttemptRef.current && revision === podcastQueueRevisionRef.current && items[0]) {
          playPodcastEpisode(podcastPlaybackForEpisode(items[0].episode));
        }
      } catch (error) {
        await reloadPodcastQueue(revision);
        throw error;
      }
    });
  }

  function cancelPendingQueueConsume() {
    pendingPodcastQueueConsumeRef.current = null;
  }

  function hasPodcastQueueConsumeFailure(episodeId: string) {
    const failure = podcastQueueConsumeFailureRef.current;
    return (
      failure?.episodeId === episodeId
      && failure.revision === podcastQueueRevisionRef.current
    );
  }

  function consumePendingPodcastQueueEpisode(episodeId: string, audioEpisodeId: string | null) {
    if (
      !shouldConsumePendingQueueEpisode(
        pendingPodcastQueueConsumeRef.current,
        activePodcastEpisodeRef.current?.episodeId ?? null,
        audioEpisodeId,
        episodeId,
      )
    ) {
      return;
    }
    pendingPodcastQueueConsumeRef.current = null;
    const revision = beginPodcastQueueMutation(podcastQueueRef.current
      .filter((item) => item.episode.id !== episodeId)
      .map((item, position) => ({ ...item, position }))
    );
    void serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_queue_remove", { episodeId });
        podcastQueueConsumeFailureRef.current = null;
        applyPodcastQueueResult(items, revision);
      } catch (reason) {
        podcastQueueConsumeFailureRef.current = { episodeId, revision };
        await reloadPodcastQueue(revision);
        showActionNotice("无法同步待播队列");
        if (import.meta.env.DEV) console.warn("[podcast] queue consume failed", reason);
      }
    });
  }

  function queuePodcastEpisode(episode: PodcastEpisode, playNext: boolean) {
    if (activePodcastEpisodeRef.current?.episodeId === episode.id) {
      showActionNotice("本集正在播放");
      return false;
    }
    const current = podcastQueueRef.current;
    const existing = current.find((item) => item.episode.id === episode.id);
    const remaining = current.filter((item) => item.episode.id !== episode.id);
    const queueItem = existing ?? {
      episode,
      position: remaining.length,
      addedAt: Date.now(),
    };
    const optimistic = (playNext
      ? [queueItem, ...remaining]
      : existing
        ? current
        : [...remaining, queueItem]
    ).map((item, position) => ({ ...item, position }));
    const revision = beginPodcastQueueMutation(optimistic);
    return serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_queue_add", {
          episodeId: episode.id,
          playNext,
        });
        applyPodcastQueueResult(items, revision);
        showActionNotice(playNext ? "将在当前单集之后播放" : "已加入待播队列");
        return true;
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法更新待播队列");
        if (import.meta.env.DEV) console.warn("[podcast] queue add failed", reason);
        return false;
      }
    });
  }

  function rememberQueueRemoval(snapshot:PodcastQueueItem[], expected:PodcastQueueItem[], revision:number, active:string|null) {
    if (revision!==podcastQueueRevisionRef.current || active!==(activePodcastEpisodeRef.current?.episodeId ?? null)) return;
    const ids=snapshot.map(item=>item.episode.id).filter(id=>id!==active);
    if(ids.length<=expected.length)return;
    setQueueUndo({ids,expected:expected.map(item=>item.episode.id),active,expires:Date.now()+30000,kind:"remove"});
  }
  function undoPodcastQueueRemoval() {
    const undo=queueUndoRef.current;if(!undo || Date.now()>undo.expires)return Promise.resolve();
    const revision=beginPodcastQueueMutation(podcastQueueRef.current);
    return serializePodcastQueueMutation(async()=>{try{const items=await invoke<PodcastQueueItem[]>("podcast_queue_restore",{episodeIds:undo.ids,expectedIds:undo.expected,expectedActive:undo.active});applyPodcastQueueResult(items,revision);showActionNotice(undo.kind === "replace" ? "已恢复替换前的待播" : "已撤销待播移除");}catch{await reloadPodcastQueue(revision);showActionNotice("待播或当前单集已变化，无法撤销");}});
  }
  function removePodcastQueueEpisode(episodeId: string) {
    const snapshot=podcastQueueRef.current;const active=activePodcastEpisodeRef.current?.episodeId ?? null;
    const optimistic = podcastQueueRef.current
      .filter((item) => item.episode.id !== episodeId)
      .map((item, position) => ({ ...item, position }));
    const revision = beginPodcastQueueMutation(optimistic);
    return serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_queue_remove", { episodeId });
        applyPodcastQueueResult(items, revision);
        rememberQueueRemoval(snapshot,items,revision,active);
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法移除待播单集");
        if (import.meta.env.DEV) console.warn("[podcast] queue remove failed", reason);
      }
    });
  }

  function removePodcastQueueEpisodes(episodeIds: string[]) {
    const snapshot=podcastQueueRef.current;const active=activePodcastEpisodeRef.current?.episodeId ?? null;
    const selected = new Set(episodeIds);
    if (selected.size === 0) return Promise.resolve();
    const optimistic = podcastQueueRef.current
      .filter((item) => !selected.has(item.episode.id))
      .map((item, position) => ({ ...item, position }));
    const revision = beginPodcastQueueMutation(optimistic);
    return serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>(
          "podcast_queue_remove_many",
          { episodeIds: [...selected] },
        );
        applyPodcastQueueResult(items, revision);
        rememberQueueRemoval(snapshot,items,revision,active);
      } catch (reason) {
        await reloadPodcastQueue(revision);
        if (import.meta.env.DEV) {
          console.warn("[podcast] queue batch remove failed", reason);
        }
        throw reason;
      }
    });
  }

  function clearPodcastQueue() {
    const snapshot=podcastQueueRef.current;const active=activePodcastEpisodeRef.current?.episodeId ?? null;
    const revision = beginPodcastQueueMutation([]);
    return serializePodcastQueueMutation(async () => {
      try {
        await invoke("podcast_queue_clear");
        applyPodcastQueueResult([], revision);
        rememberQueueRemoval(snapshot,[],revision,active);
        showActionNotice("已清空待播队列");
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法清空待播队列");
        if (import.meta.env.DEV) console.warn("[podcast] queue clear failed", reason);
      }
    });
  }

  function movePodcastQueueEpisode(episodeId: string, direction: -1 | 1) {
    const next = movePodcastQueueItem(
      podcastQueueRef.current,
      episodeId,
      direction,
      activePodcastEpisodeRef.current?.episodeId,
    );
    if (next === podcastQueueRef.current) return false;
    const revision = beginPodcastQueueMutation(next);
    return serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_queue_reorder", {
          episodeIds: next.map((item) => item.episode.id),
        });
        applyPodcastQueueResult(items, revision);
        return podcastQueueRevisionRef.current === revision;
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法调整待播顺序");
        if (import.meta.env.DEV) console.warn("[podcast] queue reorder failed", reason);
        return false;
      }
    });
  }

  function reorderPodcastQueueEpisode(
    episodeId: string,
    targetEpisodeId: string,
    placement: "before" | "after",
  ) {
    const current = podcastQueueRef.current;
    const sourceIndex = current.findIndex((item) => item.episode.id === episodeId);
    const targetIndex = current.findIndex((item) => item.episode.id === targetEpisodeId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    const next = [...current];
    const [moved] = next.splice(sourceIndex, 1);
    if (!moved) return;
    const remainingTargetIndex = next.findIndex(
      (item) => item.episode.id === targetEpisodeId,
    );
    const insertionIndex = remainingTargetIndex + (placement === "after" ? 1 : 0);
    next.splice(insertionIndex, 0, moved);
    const reordered = next.map((item, position) => ({ ...item, position }));
    if (reordered.every((item, index) => item.episode.id === current[index]?.episode.id)) {
      return;
    }
    const revision = beginPodcastQueueMutation(reordered);
    return serializePodcastQueueMutation(async () => {
      try {
        const items = await invoke<PodcastQueueItem[]>("podcast_queue_reorder", {
          episodeIds: reordered.map((item) => item.episode.id),
        });
        applyPodcastQueueResult(items, revision);
      } catch (reason) {
        await reloadPodcastQueue(revision);
        showActionNotice("无法调整待播顺序");
        if (import.meta.env.DEV) console.warn("[podcast] queue drag reorder failed", reason);
      }
    });
  }

  function updatePodcastEpisodes(episodes: PodcastEpisode[]) {
    if (episodes.length === 0) return;
    const updates = new Map(episodes.map((episode) => [episode.id, episode]));
    for (const episode of episodes) {
      if (!episode.completed && episode.progressSeconds <= 0) {
        podcastProgressStartedRef.current.delete(episode.id);
      }
    }
    applyPodcastQueue(podcastQueueRef.current.map((item) =>
      updates.has(item.episode.id)
        ? { ...item, episode: updates.get(item.episode.id)! }
        : item
    ));
    setActivePodcastEpisode((current) => {
      if (!current) return current;
      const episode = updates.get(current.id);
      if (!episode) return current;
      const next = podcastPlaybackForEpisode(episode);
      const audio = audioRef.current;
      if ((current.playbackLocalPath && !episode.localPath) || (audio?.paused && episode.localPath && current.playbackLocalPath!==episode.localPath)) {
        return {
          ...next,
          savedProgressSeconds: audio?.currentTime ?? current.savedProgressSeconds,
          playbackLocalPath: episode.localPath,
        };
      }
      return {
        ...next,
        playbackLocalPath: current.playbackLocalPath,
        savedProgressSeconds: current.savedProgressSeconds,
      };
    });
    bumpLibraryRevision();
  }

  useEffect(()=>{
    const audio=audioRef.current;if(!audio || typeof audio.addEventListener!=="function")return;
    const preferDownloaded=()=>{const active=activePodcastEpisodeRef.current;
      if(!active?.localPath || active.playbackLocalPath || !playbackControlsRef.current?.hasEpisodeStartedOnDevice(active.episodeId))return;
      const position=Number.isFinite(audio.currentTime)?audio.currentTime:active.savedProgressSeconds;
      setActivePodcastEpisode(current=>current?.episodeId===active.episodeId && current.localPath && !current.playbackLocalPath?{...current,playbackLocalPath:current.localPath,savedProgressSeconds:position}:current);
    };
    audio.addEventListener("pause",preferDownloaded);return()=>audio.removeEventListener("pause",preferDownloaded);
  },[audioRef,playbackControlsRef]);

  function updatePodcastEpisode(episode: PodcastEpisode) {
    updatePodcastEpisodes([episode]);
  }

  async function reconcileDeletedPodcastDownloads(episodeIds: string[]) {
    if (episodeIds.length === 0) return;
    const deleted = new Set(episodeIds);
    const queueRefresh = podcastQueueRef.current.some((item) =>
      deleted.has(item.episode.id)
    )
      ? reloadPodcastQueue(podcastQueueRevisionRef.current)
      : Promise.resolve();
    const activeEpisode = activePodcastEpisodeRef.current;
    const activeEpisodeId = activeEpisode?.episodeId;
    if (activeEpisode && deleted.has(activeEpisode.episodeId)) {
      updatePodcastEpisode({
        ...activeEpisode,
        downloadState: "none",
        localPath: null,
        downloadedBytes: 0,
        totalBytes: null,
      });
    }
    const activeRefresh = activeEpisodeId && deleted.has(activeEpisodeId)
      ? invoke<PodcastEpisodeDetail>("podcast_get_episode_detail", {
        episodeId: activeEpisodeId,
      }).then((detail) => {
        if (activePodcastEpisodeRef.current?.episodeId === activeEpisodeId) {
          updatePodcastEpisode(detail.episode);
        }
      }).catch((reason) => {
        if (import.meta.env.DEV) {
          console.warn("[podcast] deleted download refresh failed", reason);
        }
      })
      : Promise.resolve();
    await Promise.all([queueRefresh, activeRefresh]);
  }

  async function toggleActivePodcastSaved() {
    const episode = activePodcastEpisodeRef.current;
    if (!episode) return;
    try {
      const detail = await invoke<PodcastEpisodeDetail>("podcast_set_episode_saved", {
        episodeId: episode.episodeId,
        saved: !episode.saved,
      });
      updatePodcastEpisode(detail.episode);
      showActionNotice(detail.saved ? "已加入稍后听" : "已从稍后听移除");
    } catch (reason) {
      showActionNotice("无法更新稍后听");
      if (import.meta.env.DEV) console.warn("[podcast] save episode failed", reason);
    }
  }

  function resumePodcastProgressWritesIfActivelyPlaying(episodeId: string) {
    const stillActive =
      activePodcastEpisodeRef.current?.episodeId === episodeId;
    const stillPlaying = Boolean(
      stillActive && audioRef.current && !audioRef.current.paused,
    );
    // Keep writes suppressed while paused so a settled "mark unplayed" cannot be
    // resurrected by a later flush of the paused clock. Resume only when the
    // episode is still actively playing so continued listening / onEnded can
    // record progress under a fresh gate epoch.
    if (stillPlaying) resumePodcastProgressWrites(episodeId);
  }

  function setPodcastEpisodePlayed(episodeId: string, played: boolean) {
    const suppressActiveProgress =
      activePodcastEpisodeRef.current?.episodeId === episodeId;
    if (suppressActiveProgress) suppressPodcastProgressWrites(episodeId);
    const operation = podcastProgressMutationRef.current.then(async () => {
      const detail = await invoke<PodcastEpisodeDetail>("podcast_set_episode_played", {
        episodeId,
        played,
      });
      rememberPodcastEpisodeProgress(detail.episode);
      updatePodcastEpisode(detail.episode);
      return detail;
    });
    podcastProgressMutationRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.then((detail) => {
      if (suppressActiveProgress) {
        resumePodcastProgressWritesIfActivelyPlaying(episodeId);
      }
      return detail;
    }).catch((reason) => {
      if (suppressActiveProgress) resumePodcastProgressWrites(episodeId);
      throw reason;
    });
  }

  function setPodcastQueueEpisodesPlayed(
    episodeIds: string[],
    played: boolean,
  ) {
    const uniqueEpisodeIds = [...new Set(episodeIds)];
    if (uniqueEpisodeIds.length === 0) return Promise.resolve();
    const activeEpisodeId = activePodcastEpisodeRef.current?.episodeId;
    const suppressActiveProgress = Boolean(
      activeEpisodeId && uniqueEpisodeIds.includes(activeEpisodeId),
    );
    if (suppressActiveProgress && activeEpisodeId) {
      suppressPodcastProgressWrites(activeEpisodeId);
    }
    const operation = podcastProgressMutationRef.current.then(async () => {
      const details = await invoke<PodcastEpisodeDetail[]>(
        "podcast_set_episodes_played",
        { episodeIds: uniqueEpisodeIds, played },
      );
      details.forEach((detail) => rememberPodcastEpisodeProgress(detail.episode));
      updatePodcastEpisodes(details.map((detail) => detail.episode));
    });
    podcastProgressMutationRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.then(() => {
      if (suppressActiveProgress && activeEpisodeId) {
        resumePodcastProgressWritesIfActivelyPlaying(activeEpisodeId);
      }
    }).catch((reason) => {
      if (suppressActiveProgress && activeEpisodeId) {
        resumePodcastProgressWrites(activeEpisodeId);
      }
      throw reason;
    });
  }

  async function downloadPodcastQueueEpisodes(episodes: PodcastEpisode[]) {
    const uniqueEpisodes = [...new Map(
      episodes.map((episode) => [episode.id, episode]),
    ).values()];
    let downloadedCount = 0;
    let failedCount = 0;
    let canceled = false;
    const refreshedEpisodes: PodcastEpisode[] = [];
    for (const episode of uniqueEpisodes) {
      if (episode.localPath) continue;
      try {
        await downloadPodcastEpisode(episode.id);
        downloadedCount += 1;
      } catch (reason) {
        canceled = String(reason).includes("已取消播客网络请求");
        if (!canceled) failedCount += 1;
        if (import.meta.env.DEV) {
          console.warn("[podcast] queue batch download failed", episode.id, reason);
        }
      }
      try {
        const detail = await invoke<PodcastEpisodeDetail>(
          "podcast_get_episode_detail",
          { episodeId: episode.id },
        );
        refreshedEpisodes.push(detail.episode);
      } catch (reason) {
        if (import.meta.env.DEV) {
          console.warn(
            "[podcast] queue batch download refresh failed",
            episode.id,
            reason,
          );
        }
      }
      if (canceled) break;
    }
    updatePodcastEpisodes(refreshedEpisodes);
    return { downloadedCount, failedCount, canceled };
  }

  function openActivePodcastEpisode() {
    const episode = activePodcastEpisodeRef.current;
    if (!episode) return;
    setPodcastEpisodeRequest({
      episodeId: episode.episodeId,
      nonce: Date.now(),
      returnToNowPlaying: true,
    });
    requestNavigation("podcasts");
  }
  async function recordPodcastMoment() {
    const episode = activePodcastEpisodeRef.current;
    if (!episode) return;
    const position = playbackControlsRef.current?.hasEpisodeStartedOnDevice(episode.episodeId)
      ? audioRef.current?.currentTime ?? 0 : episode.savedProgressSeconds ?? episode.progressSeconds ?? 0;
    try {
      const existing = await invoke<Array<{positionSeconds:number}>>("podcast_list_bookmarks", { episodeId: episode.episodeId });
      if (existing.some(item => Math.round(item.positionSeconds * 1000) === Math.round(position * 1000))) { showActionNotice("此刻已有书签"); return; }
      await recordEpisodeBookmark(episode.episodeId, Math.max(0, position));
      if (activePodcastEpisodeRef.current?.episodeId === episode.episodeId) showActionNotice(`已记录 ${formatTime(position)} · 单集书签`);
    } catch { showActionNotice("书签未能保存，请重试"); }
  }

  function playPodcastQueueItem(item: PodcastQueueItem) {
    playPodcastEpisode(podcastPlaybackForEpisode(item.episode));
  }

  function playPodcastQueueEpisodeById(episodeId: string) {
    const item = podcastQueueRef.current.find(
      (candidate) => candidate.episode.id === episodeId,
    );
    if (item) playPodcastQueueItem(item);
  }

  function markPodcastPlaying() {
    const audio=audioRef.current;
    if(audio && audio.currentTime < audio.duration-1)completedBoundaryRef.current=null;
    if (activePodcastEpisodeRef.current) setPodcastPlaybackStatus("playing");
  }

  function resolvePodcastEpisodeRequest(nonce: number) {
    setPodcastEpisodeRequest((current) =>
      current?.nonce === nonce ? null : current
    );
  }

  function playNextPodcastEpisode(showEmptyNotice = true) {
    const activeEpisodeId = activePodcastEpisodeRef.current?.episodeId ?? null;
    if (
      activeEpisodeId
      && podcastQueueRef.current.some((item) => item.episode.id === activeEpisodeId)
    ) {
      void removePodcastQueueEpisode(activeEpisodeId);
    }
    const next = podcastQueueRef.current.find(
      (item) => item.episode.id !== activeEpisodeId,
    );
    if (!next) {
      if (showEmptyNotice) showActionNotice("待播队列为空");
      return false;
    }
    playPodcastQueueItem(next);
    return true;
  }

  function handleEpisodeEnded(audioDuration: number) {
    const endedEpisodeId = activePodcastEpisodeRef.current?.episodeId;
    if (!endedEpisodeId) return;
    if(completedBoundaryRef.current===endedEpisodeId)return;
    completedBoundaryRef.current=endedEpisodeId;
    const progressSaved = persistPodcastProgress(audioDuration, audioDuration, true);
    markEpisodeCompletedOnEnd(audioDuration || 0);
    void progressSaved.finally(() => {
      bumpLibraryRevision();
    });
    if (
      podcastSleepTimer?.kind === "episodeEnd"
      && podcastSleepTimer.episodeId === endedEpisodeId
    ) {
      playbackControlsRef.current?.setPlaybackIntent(false);
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
    playbackControlsRef.current?.setPlaybackIntent(false);
    setPodcastPlaybackStatus("paused");
  }

  function changePodcastAutoQueueMode(mode: PodcastAutoQueueMode) {
    if (!PODCAST_AUTO_QUEUE_MODES.includes(mode)) return;
    podcastAutoQueueAttemptRef.current += 1;
    podcastAutoQueueModeRef.current = mode;
    setPodcastAutoQueueMode(mode);
    patchPodcastPlaybackSettings({ autoQueueMode: mode });
    if (audioRef.current?.ended) {
      playbackControlsRef.current?.setPlaybackIntent(false);
      setPodcastPlaybackStatus("paused");
    }
  }

  function autofillPodcastQueueAfter(endedEpisodeId: string) {
    const mode = podcastAutoQueueModeRef.current;
    if (mode === "off") return;
    const attempt = podcastAutoQueueAttemptRef.current + 1;
    podcastAutoQueueAttemptRef.current = attempt;
    const isCurrentAttempt = () =>
      podcastAutoQueueAttemptRef.current === attempt
      && podcastAutoQueueModeRef.current === mode
      && activePodcastEpisodeRef.current?.episodeId === endedEpisodeId;
    const revision = beginPodcastQueueMutation(podcastQueueRef.current);
    setPodcastPlaybackStatus("loading");
    void serializePodcastQueueMutation(async () => {
      try {
        if (!isCurrentAttempt()) return;
        const items = await invoke<PodcastQueueItem[]>(
          "podcast_queue_autofill",
          { currentEpisodeId: endedEpisodeId, mode },
        );
        const ownsRevision = podcastQueueRevisionRef.current === revision;
        if (ownsRevision) applyPodcastQueueResult(items, revision);
        if (!isCurrentAttempt()) return;
        const next = (ownsRevision ? items : podcastQueueRef.current).find(
          (item) => item.episode.id !== endedEpisodeId,
        );
        if (next) {
          playPodcastQueueItem(next);
          return;
        }
        playbackControlsRef.current?.setPlaybackIntent(false);
        setPodcastPlaybackStatus("paused");
        showActionNotice(
          mode === "same-feed"
            ? "这个节目没有更多可续播的单集"
            : "没有可随机续播的未听单集",
        );
      } catch (reason) {
        await reloadPodcastQueue(revision);
        if (
          podcastAutoQueueAttemptRef.current === attempt
          && activePodcastEpisodeRef.current?.episodeId === endedEpisodeId
        ) {
          playbackControlsRef.current?.setPlaybackIntent(false);
          setPodcastPlaybackStatus("paused");
        }
        if (import.meta.env.DEV) {
          console.warn("[podcast] queue autofill failed", reason);
        }
      }
    });
  }

  function rememberPodcastEpisodeProgress(episode: PodcastEpisode) {
    podcastSessionProgressRef.current.set(episode.id, {
      progressSeconds: episode.progressSeconds,
      durationSeconds: episode.durationSeconds,
      completed: episode.completed,
    });
  }

  function persistPodcastProgress(currentTime: number, trackDuration: number, force = false) {
    const episode = activePodcastEpisodeRef.current;
    if (!episode) return Promise.resolve();
    if (podcastProgressWriteGateRef.current.isSuppressed(episode.episodeId)) {
      return podcastProgressMutationRef.current;
    }
    const positionSeconds = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
    const durationSeconds = Number.isFinite(trackDuration) ? Math.max(0, trackDuration) : 0;
    if(force && durationSeconds>0 && positionSeconds<durationSeconds-1)completedBoundaryRef.current=null;
    // Keep every clock update, including throttled writes, independent of the
    // view's older list snapshots. Explicit rewinds and played markers supersede it.
    const lastSessionProgress = podcastSessionProgressRef.current.get(episode.episodeId);
    const clampedPosition = durationSeconds > 0
      ? Math.min(positionSeconds, durationSeconds)
      : positionSeconds;
    podcastSessionProgressRef.current.set(episode.episodeId, {
      progressSeconds: !force && lastSessionProgress
        ? Math.max(lastSessionProgress.progressSeconds, clampedPosition)
        : clampedPosition,
      durationSeconds: durationSeconds || lastSessionProgress?.durationSeconds || episode.durationSeconds,
      completed: episode.completed || Boolean(lastSessionProgress?.completed)
        || (durationSeconds > 0 && clampedPosition / durationSeconds >= 0.95),
    });
    const now = Date.now();
    const previous = podcastProgressSaveRef.current;
    if (
      !force
      && previous?.episodeId === episode.episodeId
      && now - previous.savedAt < PODCAST_PROGRESS_SAVE_INTERVAL_MS
    ) {
      return podcastProgressMutationRef.current;
    }
    if (
      force
      && !podcastProgressSaveFailedRef.current
      && previous?.episodeId === episode.episodeId
      && Math.abs(previous.position - positionSeconds) < 0.25
      && Math.abs(previous.duration - durationSeconds) < 0.25
    ) {
      return podcastProgressMutationRef.current;
    }

    const writeEpoch = podcastProgressWriteGateRef.current.capture(episode.episodeId);
    podcastProgressSaveRef.current = {
      episodeId: episode.episodeId,
      savedAt: now,
      position: positionSeconds,
      duration: durationSeconds,
    };
    const save = podcastProgressMutationRef.current.then(async () => {
      if (!podcastProgressWriteGateRef.current.allows(
        episode.episodeId,
        writeEpoch,
      )) {
        return;
      }
      await invoke("podcast_save_progress", {
        episodeId: episode.episodeId,
        positionSeconds,
        durationSeconds,
        force,
      });
      if (podcastActiveSessionReady && podcastActiveSessionSaveFailedRef.current) {
        persistPodcastActiveSession(activePodcastEpisodeRef.current?.episodeId ?? null);
      }
      if (
        positionSeconds > 0
        && episode.progressSeconds <= 0
        && !podcastProgressStartedRef.current.has(episode.episodeId)
      ) {
        podcastProgressStartedRef.current.add(episode.episodeId);
        bumpLibraryRevision();
      }
    });
    podcastProgressMutationRef.current = save.then(
      () => { podcastProgressSaveFailedRef.current = false; },
      (reason) => {
        recordDiagnostic({ domain: "podcast", event: "progress_save", outcome: "error" });
        if (!podcastProgressSaveFailedRef.current) showActionNotice("收听进度保存失败，将自动重试");
        podcastProgressSaveFailedRef.current = true;
        if (import.meta.env.DEV) console.warn("[podcast] progress save failed", reason);
      },
    );
    return podcastProgressMutationRef.current;
  }

  function flushPodcastProgress() {
    const audio = audioRef.current;
    if (!audio) return Promise.resolve();
    const episode = activePodcastEpisodeRef.current;
    // Transport owns pending resume; mirror the previous local-pending shape so
    // flush still prefers the hydrated resume position over a zero media clock.
    const pendingPosition = playbackControlsRef.current?.peekPendingResumePosition(
      episode?.episodeId ?? null,
    ) ?? null;
    const pending = pendingPosition === null
      ? null
      : { position: pendingPosition };
    const resumePending = Boolean(episode && pending);
    const currentTime = resumePending ? pending!.position : audio.currentTime;
    const trackDuration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : episode?.durationSeconds ?? 0;
    return persistPodcastProgress(currentTime, trackDuration, true);
  }

  const transport: PodcastTransportBridge = {
    activePodcastEpisode,
    podcastPlaybackRate,
    podcastSessionHydrated,
    setPodcastPlaybackStatus,
    cancelPodcastSessionRestore,
    clearActivePodcast,
    resumePodcastProgressWrites,
    persistPodcastProgress,
    flushPodcastProgress,
    consumePendingPodcastQueueEpisode,
    cancelPendingQueueConsume,
    cancelPendingPodcastAutofill,
    handleEpisodeEnded,
    expireSleepTimer,
    podcastPreferencesReady: !activePodcastEpisode || episodePreferences?.episodeId===activePodcastEpisode.episodeId,
    resolvePodcastIntro: (position,duration,explicit)=>{
      const preferences=episodePreferencesRef.current?.value ?? DEFAULT_PODCAST_PREFERENCES;
      return podcastIntroPosition(position,duration,preferences.introSeconds,preferences.outroSeconds,explicit);
    },
    handlePodcastClock: (position,duration)=>{
      const preferences=episodePreferencesRef.current?.value ?? DEFAULT_PODCAST_PREFERENCES;
      if(audioRef.current?.paused || !podcastOutroReached(position,duration,preferences.introSeconds,preferences.outroSeconds))return false;
      audioRef.current?.pause();if(audioRef.current)audioRef.current.currentTime=duration;handleEpisodeEnded(duration);return true;
    },
  };

  return {
    transport,
    activePodcastEpisode,
    podcastQueue,
    podcastLibraryRevision,
    podcastEpisodeRequest,
    podcastPlaybackRate,
    podcastPreferences: episodePreferences?.value ?? DEFAULT_PODCAST_PREFERENCES,
    podcastPlaybackRateScope: episodePreferences?.custom ? "show" as const : "default" as const,
    setPodcastPlaybackRate,
    podcastAutoQueueMode,
    podcastSleepTimer,
    setPodcastSleepTimer,
    podcastPlaybackStatus,
    podcastSessionHydrated,
    playPodcastEpisode,
    playPodcastPlaylist,
    queuePodcastEpisode,
    removePodcastQueueEpisode,
    removePodcastQueueEpisodes,
    clearPodcastQueue,
    queueUndoKind: queueUndo?.kind,
    queueUndoAvailable: Boolean(queueUndo && queueUndo.active===(activePodcastEpisode?.episodeId ?? null) && queueUndo.expected.join("|")===podcastQueue.map(item=>item.episode.id).join("|")),
    undoPodcastQueueRemoval,
    movePodcastQueueEpisode,
    reorderPodcastQueueEpisode,
    updatePodcastEpisode,
    reconcileDeletedPodcastDownloads,
    toggleActivePodcastSaved,
    setPodcastEpisodePlayed,
    setPodcastQueueEpisodesPlayed,
    downloadPodcastQueueEpisodes,
    openActivePodcastEpisode,
    recordPodcastMoment,
    playPodcastQueueItem,
    playPodcastQueueEpisodeById,
    markPodcastPlaying,
    resolvePodcastEpisodeRequest,
    playNextPodcastEpisode,
    changePodcastAutoQueueMode,
    flushPodcastProgress,
  };
}

export type PodcastPlaybackApi = ReturnType<typeof usePodcastPlayback>;
