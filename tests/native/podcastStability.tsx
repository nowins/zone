import "../../src/styles.css";
import { PodcastView } from "../../src/views/PodcastView";
import { applyMotionTokens } from "../../src/motion/tokens";
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { usePodcastPlayback } from "../../src/hooks/usePodcastPlayback";
import { usePlaybackControls } from "../../src/hooks/usePlaybackControls";
import { useAudioEngine } from "../../src/hooks/useAudioEngine";
import { podcastPlaybackForEpisode } from "../../src/utils/podcastPlayback";
import type { AudioEngineHandle } from "../../src/hooks/useAudioEngine";
import type { PlaybackControlsHandle, PlaybackSession } from "../../src/hooks/usePlaybackControls";
import type { PodcastEpisodeDetail, PodcastPlayback, PodcastDownloadResult, Track, TrackActivityMap } from "../../src/types";
import type { PodcastDiscoveryPage } from "../../src/types";
import { setDiscoveryCache } from "../../src/views/podcast/cache";

type FixtureConfig = { phase: string; durationMs: number; cycles: number; crashDelayMs?: number; switchRounds?: number };
let api: { domain: ReturnType<typeof usePodcastPlayback>; controls: ReturnType<typeof usePlaybackControls>; audioRef: React.RefObject<HTMLAudioElement> };
const notices: string[] = [];
let contextsCreated = 0;
let contextsClosed = 0;
const NativeAudioContext = window.AudioContext;
window.AudioContext = class extends NativeAudioContext {
  constructor(options?: AudioContextOptions) { super(options); contextsCreated++; }
  close() { contextsClosed++; return super.close(); }
};
let setFixtureView: (show: boolean) => void;
const episodeRequest = { episodeId: "__STREAM_ID__", nonce: 1 };
let discoveryFixture = false;
function Harness() {
  const [showView, setShowView] = useState(false);
  setFixtureView = setShowView;
  const audioRef = useRef<HTMLAudioElement>(null);
  const playbackControlsRef = useRef<PlaybackControlsHandle | null>(null);
  const audioEngineRef = useRef<AudioEngineHandle | null>(null);
  const playbackSessionRef = useRef<PlaybackSession | null>(null);
  const [tracks] = useState<Track[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [, setActivity] = useState<TrackActivityMap>({});
  const showActionNotice = (message: string) => notices.push(message);
  const domain = usePodcastPlayback({ audioRef, playbackControlsRef, playbackSessionRef, showActionNotice, requestNavigation() {} });
  const controls = usePlaybackControls({ audioRef, audioEngineRef, playbackSessionRef, showActionNotice,
    tracks, queue, setQueue, playHistory: history, setPlayHistory: setHistory, activeTrackId, setActiveTrackId,
    setTrackActivity: setActivity, restored: true, podcast: domain.transport });
  playbackControlsRef.current = controls;
  audioEngineRef.current = useAudioEngine({ audioRef, volume: 0, progress: controls.progress,
    isPlaying: controls.isPlaying, activePlayback: controls.activePlayback, activePlaybackSourceKey: controls.activePlaybackSourceKey,
    activeTrackId, visualizerVisible: false });
  api = { domain, controls, audioRef };
  return <>
    {showView ? <PodcastView queue={domain.podcastQueue} autoQueueMode={domain.podcastAutoQueueMode}
      activeEpisode={domain.activePodcastEpisode} activeEpisodeId={domain.activePodcastEpisode?.episodeId ?? null}
      activeProgress={controls.progress} activeDuration={controls.duration} libraryRevision={domain.podcastLibraryRevision}
      episodeRequest={discoveryFixture ? null : episodeRequest} onEpisodeRequestHandled={() => {}} feedRequest={null} onFeedRequestHandled={() => {}}
      pinnedPodcastFeedIds={new Set()} onTogglePodcastPin={() => {}} onReturnToNowPlaying={() => {}} isPlaying={controls.isPlaying}
      onPlayEpisode={domain.playPodcastEpisode} onPlayEpisodeAt={domain.playPodcastEpisode}
      onQueueEpisode={domain.queuePodcastEpisode} onRemoveQueueEpisode={domain.removePodcastQueueEpisode}
      onMoveQueueEpisode={domain.movePodcastQueueEpisode} onReorderQueueEpisode={domain.reorderPodcastQueueEpisode}
      onRemoveQueueEpisodes={domain.removePodcastQueueEpisodes} onSetQueueEpisodesPlayed={domain.setPodcastQueueEpisodesPlayed}
      onDownloadQueueEpisodes={domain.downloadPodcastQueueEpisodes} onClearQueue={domain.clearPodcastQueue}
      onAutoQueueMode={domain.changePodcastAutoQueueMode} onEpisodeUpdated={domain.updatePodcastEpisode}
      onSetEpisodePlayed={domain.setPodcastEpisodePlayed} onDownloadsDeleted={domain.reconcileDeletedPodcastDownloads} /> : null}
    <audio ref={audioRef} crossOrigin="anonymous"
    onTimeUpdate={event => controls.handleTimeUpdate(event.currentTarget.currentTime, event.currentTarget.duration)}
    onLoadedMetadata={event => controls.handleLoadedMetadata(event.currentTarget)}
    onLoadStart={controls.handleAudioLoadStart} onCanPlay={controls.handleAudioCanPlay}
    onWaiting={controls.handleAudioWaiting} onStalled={controls.handleAudioWaiting}
    onPause={controls.handleAudioPause} onError={controls.handleAudioError} onEnded={controls.onEnded}
    onPlay={() => { controls.setIsPlaying(true); domain.markPodcastPlaying(); }} />
  </>;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function audio() {
  const element = api.audioRef.current;
  if (!element) throw Error("fixture audio has not mounted");
  return element;
}
async function until(test: () => boolean, label: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!test()) { if (Date.now() > deadline) throw Error(`${label}: timeout, ${JSON.stringify(notices.slice(-4))}`); await delay(25); }
}
const streamId = "__STREAM_ID__";
const localId = "__LOCAL_ID__";
async function detail(episodeId: string) { return invoke<PodcastEpisodeDetail>("podcast_get_episode_detail", { episodeId }); }
function assert(condition: unknown, label: string) { if (!condition) throw Error(label); }
async function record(kind: string, value: Record<string, unknown> = {}) {
  return invoke("stability_record", { value: { kind, at: new Date().toISOString(), ...value } });
}
async function play(episode: PodcastPlayback, position?: number) {
  api.domain.playPodcastEpisode(episode, position);
  await until(() => api.domain.activePodcastEpisode?.episodeId === episode.episodeId
    && api.controls.hasEpisodeStartedOnDevice(episode.episodeId) && !audio().paused, "play");
}
async function stop() { api.controls.clearPlaybackIntent(); audio().pause(); await api.domain.flushPodcastProgress(); }

document.addEventListener("DOMContentLoaded", async () => {
  const checks: string[] = [];
  let phase = "";
  try {
    let options: FixtureConfig = await invoke("stability_config");
    phase = options.phase;
    discoveryFixture = phase === "discovery";
    await record("startup", { phase: options.phase, storage: localStorage.getItem("zone-podcast-playback-v1"), origin: location.origin });
    if (!options.phase.startsWith("restore")) localStorage.removeItem("zone-podcast-playback-v1");
    const node = document.createElement("div"); node.style.height = "100vh"; document.body.append(node);
    const root = createRoot(node); root.render(<Harness />);
    await until(() => api?.domain.podcastSessionHydrated, "hydrate");
    const a = podcastPlaybackForEpisode((await detail(streamId)).episode);
    const b = podcastPlaybackForEpisode((await detail(localId)).episode);
    if (options.phase === "discovery") {
      const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(element => element.textContent?.trim() === text);
      const label = () => document.querySelector(".podcast-discovery-source span")?.textContent;
      setFixtureView(true);
      await until(() => Boolean(button("发现")), "discovery navigation"); button("发现")!.click();
      await until(() => label() === "XYZRank 中文榜", "XYZRank native discovery");
      const initial = await invoke<PodcastDiscoveryPage>("podcast_load_discovery_cache");
      assert(initial.source === "xyzrank" && initial.shows.length === 1, "successful discovery was not persisted");
      const reducedStyle = document.createElement("style");
      reducedStyle.textContent = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules))
        .filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion: reduce"))
        .flatMap(rule => Array.from(rule.cssRules).map(item => item.cssText)).join("\n");
      for (const [width, height] of [[1180, 760], [920, 620]]) {
        await invoke("stability_window_size", { width, height }); await delay(250);
        const refresh = button("刷新榜单")!; refresh.focus();
        const bounds = document.querySelector(".podcast-discovery-source")!.getBoundingClientRect();
        assert(document.activeElement === refresh && bounds.left >= 0 && bounds.right <= innerWidth + 1, "discovery source or keyboard focus is outside the native window");
        await invoke("stability_capture", { name: width === 1180 ? "discovery-1180" : "discovery-920" });
      }
      document.head.append(reducedStyle);
      assert(getComputedStyle(button("刷新榜单")!).transitionDuration.split(",").every(value => parseFloat(value) <= 0.001), "discovery controls ignore reduced motion");
      reducedStyle.remove();
      document.querySelector<HTMLButtonElement>(".podcast-show-card")!.click();
      await until(() => Boolean(document.querySelector(".podcast-episode-open")), "RSS preview list");
      document.querySelector<HTMLButtonElement>(".podcast-episode-open")!.click();
      await until(() => Boolean(button("播放")), "RSS preview episode"); button("播放")!.click();
      await until(() => Boolean(api.domain.activePodcastEpisode) && !audio().paused && audio().currentTime > 1, "discovery RSS audio playback");
      assert(api.domain.activePodcastEpisode!.title === "中文榜单集", "directory preview did not play the RSS episode");
      await stop();
      await until(() => Boolean(button("下载")), "discovery download action"); button("下载")!.click();
      await until(() => Boolean(button("删除下载")), "discovery episode offline download");
      checks.push("XYZRank catalogue opens a guarded RSS preview, plays through the shared audio element and downloads offline");
      checks.push("discovery source, refresh keyboard focus and reduced motion fit 1180x760 and 920x620 native windows");
      button("返回节目")!.click();
      await until(() => Boolean(button("返回发现")), "return to discovery"); button("返回发现")!.click();
      setFixtureView(false); await delay(250); setDiscoveryCache(null);
      await invoke("stability_discovery_mode", { mode: 2 }); setFixtureView(true);
      await until(() => Boolean(button("发现")), "discovery remount navigation"); button("发现")!.click();
      await until(() => label() === "XYZRank 中文榜", "persistent discovery cache after remount");
      button("刷新榜单")!.click();
      await until(() => label() === "XYZRank 中文榜 · 缓存", "both providers failed cached fallback");
      await invoke("stability_capture", { name: "discovery-cache" });
      assert((await invoke<PodcastDiscoveryPage>("podcast_load_discovery_cache")).fetchedAt === initial.fetchedAt, "failure rewrote cache freshness");
      await invoke("stability_discovery_mode", { mode: 1 }); button("刷新榜单")!.click();
      await until(() => label() === "Apple 中国区 · 备用来源", "native Apple fallback label");
      await invoke("stability_capture", { name: "discovery-apple" });
      assert(document.body.textContent?.includes("Apple 备用节目"), "Apple fallback shows were not displayed");
      await invoke("stability_discovery_mode", { mode: 0 }); button("刷新榜单")!.click();
      await until(() => label() === "XYZRank 中文榜", "primary provider recovery");
      checks.push("persistent cache restores immediately, both-provider failure preserves freshness, Apple fallback is labelled and primary recovers");
      await record("result", { ok: true, checks, contextsCreated, contextsClosed }); return;
    }
    if (options.phase === "short" || options.phase === "network") {
      if (options.phase === "short") {
      await play(b, 1); await delay(30000);
      await record("resource-stage", { stage: "baseline" });
      for (let round = 0; round < (options.switchRounds ?? 1); round++) {
      for (let index = 0; index < options.cycles; index++) {
        await play(index % 2 ? a : b, 10 + index % 40);
        if (index % 10 === 0) {
          api.controls.togglePlay(); await until(() => audio().paused, "pause");
          api.controls.togglePlay(); await until(() => !audio().paused, "resume");
          await record("switch", { round, iteration: index, contextsCreated, contextsClosed });
        }
      }
      assert(contextsCreated === 1, "source switches must reuse one AudioContext");
      await stop(); await delay(30000);
      await record("resource-stage", { stage: `round-${round + 1}-after-cooldown` });
      }
      checks.push(`${options.cycles * (options.switchRounds ?? 1)} source switches and pause/resume reuse one graph`);
      for (let index = 0; index < 10; index++) {
        await stop(); await play(b, 1);
        await invoke("stability_network", { mode: index % 2 ? 4 : 1 });
        api.domain.playPodcastEpisode(a, 100 + index);
        await until(() => api.domain.podcastPlaybackStatus === "error", "offline failure");
        assert(api.domain.activePodcastEpisode?.episodeId === a.episodeId, "offline error retains episode");
        await invoke("stability_network", { mode: 0 });
        api.controls.retryPodcastPlayback();
        await until(() => api.controls.hasEpisodeStartedOnDevice(a.episodeId) && !audio().paused && audio().currentTime >= 100 + index, "network retry");
      }
      checks.push("10 HTTP 503/connection-drop recovery cycles retain requested position");
      }
      await stop();
      await invoke("stability_network", { mode: 3 });
      setFixtureView(true);
      const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(element => element.textContent?.trim() === text);
      await until(() => Boolean(button("下载")), "native episode download action");
      button("下载")!.click();
      await until(() => Boolean(button("取消下载")), "native cancel action");
      await delay(400);
      const reducedStyle = document.createElement("style");
      reducedStyle.textContent = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules))
        .filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion: reduce"))
        .flatMap(rule => Array.from(rule.cssRules).map(item => item.cssText)).join("\n");
      assert(reducedStyle.textContent.length > 0, "production reduced-motion rules missing");
      for (const reduced of [false, true]) {
      if (reduced) document.head.append(reducedStyle);
      for (const [width, height] of [[1180, 760], [920, 620]]) {
        await invoke("stability_window_size", { width, height }); await delay(200);
        const cancel = button("取消下载")!;
        cancel.focus(); assert(document.activeElement === cancel, "cancel action lost keyboard focus");
        const bounds = cancel.getBoundingClientRect();
        assert(bounds.width > 30 && bounds.height >= 24 && bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight, `cancel action overflowed native window: ${JSON.stringify({ bounds: bounds.toJSON(), viewport: [innerWidth, innerHeight], button: getComputedStyle(cancel).cssText, parent: cancel.parentElement?.getBoundingClientRect().toJSON() })}`);
      }
      }
      reducedStyle.remove();
      const cancelStarted = performance.now();
      button("取消下载")!.click();
      await until(() => !button("取消下载"), "native cancellation settles UI");
      assert(performance.now() - cancelStarted < 1500, "download cancellation was not prompt");
      assert((await detail(streamId)).episode.downloadedBytes > 0, "cancellation lost the partial download");
      checks.push("real podcast view cancels a native throttled download at both window sizes and retains keyboard focus and its versioned partial file");
      const bulk = api.domain.downloadPodcastQueueEpisodes([a, { ...b, localPath: null }]);
      await until(() => Boolean(button("取消下载")), "bulk cancel action");
      await delay(300); button("取消下载")!.click();
      const bulkResult = await bulk;
      assert(bulkResult.canceled && bulkResult.downloadedCount === 0 && bulkResult.failedCount === 0, "bulk cancellation started remaining episodes or reported a network failure");
      checks.push("canceling a bulk download stops the remaining episodes");
      setFixtureView(false); await delay(200);
      await invoke("stability_network", { mode: 2 });
      let failed = false;
      try { await invoke("stability_download", { episodeId: streamId }); } catch { failed = true; }
      assert(failed, "truncated download must fail");
      assert((await detail(streamId)).episode.downloadState !== "downloaded", "partial download must remain incomplete");
      await invoke("stability_network", { mode: 0 });
      const resumed = await invoke<PodcastDownloadResult>("stability_download", { episodeId: streamId });
      assert(resumed.resumed, "retry must resume the partial file");
      checks.push("interrupted download resumes to completion");
      await record("result", { ok: true, checks, contextsCreated, contextsClosed });
      return;
    }
    if (options.phase === "soak") {
      await play(a, 0);
      const started = performance.now(); let lastMedia = audio().currentTime;
      await record("soak-start", { durationMs: options.durationMs, contextsCreated });
      while (performance.now() - started < options.durationMs) {
        await delay(30000);
        const elapsed = performance.now() - started;
        const media = audio().currentTime;
        assert(!audio().paused && media > lastMedia + 5, "playback stalled during soak");
        assert(Math.abs(media - elapsed / 1000) < 8, "media clock diverged from elapsed playback");
        assert(contextsCreated === 1, "soak created extra audio contexts");
        const saved = (await detail(a.episodeId)).episode.progressSeconds;
        assert(saved > 0 && Math.abs(saved - media) < 8, "durable progress lagged behind media clock");
        await record("heartbeat", { elapsedMs: elapsed, mediaSeconds: media, savedSeconds: saved, contextsCreated, contextsClosed });
        lastMedia = media;
        options = await invoke("stability_config");
      }
      await stop();
      await record("result", { ok: true, checks: ["continuous native playback with real media and durable clocks"], contextsCreated, elapsedMs: performance.now() - started });
      return;
    }
    if (options.phase === "crash-playback") {
      await play(a, 123); await delay(options.crashDelayMs ?? 10000);
      const saved = (await detail(a.episodeId)).episode.progressSeconds;
      await record("checkpoint", { mediaSeconds: audio().currentTime, savedSeconds: saved, episodeId: a.episodeId, storage: localStorage.getItem("zone-podcast-playback-v1") });
      await delay(120000); throw Error("runner did not force terminate crash fixture");
    }
    if (options.phase === "restore-playback") {
      await until(() => audio().readyState >= 1, "paused restore metadata");
      assert(api.domain.activePodcastEpisode?.episodeId === a.episodeId, "active episode lost after termination");
      assert(audio().paused && !api.controls.isPlaying, "restart unexpectedly resumed playback");
      const saved = (await detail(a.episodeId)).episode.progressSeconds;
      assert(saved >= 123 && Math.abs(audio().currentTime - saved) < 1, "saved position lost after termination");
      await record("result", { ok: true, checks: ["forced termination restores durable progress in paused state"], restoredSeconds: audio().currentTime });
      return;
    }
    if (options.phase === "crash-download") {
      await invoke("stability_network", { mode: 3 });
      void invoke("stability_download", { episodeId: streamId }).catch(() => {});
      await delay(700); await record("checkpoint", { episodeId: streamId });
      await delay(120000); throw Error("runner did not force terminate download fixture");
    }
    if (options.phase === "restore-download") {
      const resumed = await invoke<PodcastDownloadResult>("stability_download", { episodeId: streamId });
      assert(resumed.resumed, "forced termination lost download resume state");
      assert((await detail(streamId)).episode.downloadState === "downloaded", "download recovery did not complete");
      await record("result", { ok: true, checks: ["forced termination preserves partial download and resumes"], downloadedBytes: resumed.downloadedBytes }); return;
    }
    if (options.phase === "full-disk") {
      await play(a, 10);
      await api.domain.flushPodcastProgress();
      const beforeFailure = (await detail(streamId)).episode.progressSeconds;
      await invoke("stability_disk", { fill: true });
      let databaseFailure = "";
      try { await invoke("podcast_save_progress", { episodeId: streamId, positionSeconds: 42, durationSeconds: 300, force: true }); } catch (error) { databaseFailure = String(error); }
      assert(databaseFailure.length > 0, "full volume did not reject database write");
      api.controls.seek(14);
      await api.domain.flushPodcastProgress();
      await api.domain.flushPodcastProgress();
      assert(notices.filter(message => message === "收听进度保存失败，将自动重试").length === 1, "progress failure must show one notice while writes keep failing");
      api.domain.transport.clearActivePodcast();
      await until(() => notices.includes("当前单集保存失败，将自动重试"), "failed clear of current episode");
      await invoke("stability_release_reserve");
      assert((await detail(streamId)).episode.progressSeconds === beforeFailure, "failed database write changed durable progress");
      let failure = "";
      try { await invoke("stability_download", { episodeId: streamId }); } catch (error) { failure = String(error); }
      assert(failure.includes("写入") || failure.includes("空间") || failure.includes("磁盘"), "disk full did not produce a write failure");
      assert((await detail(streamId)).episode.downloadState !== "downloaded", "disk full falsely completed a download");
      await invoke("stability_disk", { fill: false });
      await delay(5500);
      const cleared = await invoke<{ activeEpisodeId: string | null }>("podcast_load_active_episode");
      assert(cleared.activeEpisodeId === null, "current episode clear did not retry without live podcast progress");
      await invoke("podcast_save_progress", { episodeId: streamId, positionSeconds: 42, durationSeconds: 300, force: true });
      assert((await detail(streamId)).episode.progressSeconds === 42, "progress did not recover after freeing space");
      await play(a, 65);
      await api.domain.flushPodcastProgress();
      assert((await detail(streamId)).episode.progressSeconds >= 65, "playback hook did not recover progress writes");
      await stop();
      const resumed = await invoke<PodcastDownloadResult>("stability_download", { episodeId: streamId });
      assert(resumed.resumed && (await detail(streamId)).episode.downloadState === "downloaded", "space recovery failed to resume download");
      await record("result", { ok: true, checks: ["real disposable volume full rejects progress and download writes; both recover"], databaseFailure, failure }); return;
    }
    if (options.phase === "suspend") {
      await play(a, 80);
      api.domain.setPodcastSleepTimer({ kind: "deadline", deadlineAt: Date.now() + 15000 });
      await record("checkpoint", { deadlineAt: Date.now() + 15000, mediaSeconds: audio().currentTime });
      await until(() => api.domain.podcastSleepTimer === null && audio().paused, "deadline after VM resume", 180000);
      api.controls.togglePlay(); await until(() => !audio().paused, "resume transport");
      const before = audio().currentTime; await delay(1200);
      assert(audio().currentTime > before + 0.3, "media clock stopped after VM resume");
      await stop(); await record("result", { ok: true, checks: ["VM save/restore expires deadline and playback can resume"] }); return;
    }
    throw Error(`unknown phase ${options.phase}`);
  } catch (error) {
    if (phase === "full-disk") {
      await invoke("stability_release_reserve").catch(() => {});
      await invoke("stability_disk", { fill: false }).catch(() => {});
    }
    await record("result", { ok: false, error: String(error), checks, notices: notices.slice(-8), contextsCreated, contextsClosed,
      status: api?.domain.podcastPlaybackStatus, mediaError: api?.audioRef.current?.error?.code, paused: api?.audioRef.current?.paused });
  }
});
