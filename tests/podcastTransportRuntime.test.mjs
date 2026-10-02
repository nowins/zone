import assert from "node:assert/strict";
import test from "node:test";
import { mountPodcastHook, runtime, podcastEpisode, podcastPlayback, step } from "./helpers/podcastRuntime.mjs";

test("late media pause, waiting and canplay events retain a failed podcast until explicit retry", async () => {
  const statuses = [];
  const audio = { currentTime: 0, duration: 1000, paused: true, error: null,
    pause() { this.paused = true; }, removeAttribute() {}, load() { this.error = null; },
    play() { this.paused = false; return Promise.resolve(); } };
  const noop = () => {};
  const props = { audioRef: { current: audio }, showActionNotice: noop,
    audioEngineRef: { current: { visualizerUnavailableRef: {}, realtimeBeatRef: {}, offlineBeatGridRef: {}, beatFrameRef: {},
      cancelBeatAnalysis: noop, resumeAudioGraph: noop, preAnalyzeBeatGrid: noop,
      publishIdleBeatFrame: noop, publishPodcastVisualizerReset: noop } },
    playbackSessionRef: {}, tracks: [], restored: true, setTrackActivity: noop,
    activeTrackId: null, setActiveTrackId: noop, queue: [], setQueue: noop, playHistory: [], setPlayHistory: noop,
    podcast: { activePodcastEpisode: podcastPlayback(podcastEpisode("a")), podcastSessionHydrated: true, podcastPlaybackRate: 1,
      setPodcastPlaybackStatus: status => statuses.push(status), cancelPendingQueueConsume: noop,
      cancelPodcastSessionRestore: noop, clearActivePodcast: noop, flushPodcastProgress: noop,
      persistPodcastProgress: noop, resumePodcastProgressWrites: noop, consumePendingPodcastQueueEpisode: noop,
      handleEpisodeEnded: noop, cancelPendingPodcastAutofill: noop } };
  const harness = await mountPodcastHook(runtime.usePlaybackControls, props, async () => {});
  try {
    await step(() => harness.api.armPodcastPlay({ episodeId: "a", positionSeconds: 12 }));
    audio.error = { code: 2 };
    await step(() => harness.api.handleAudioError());
    for (const callback of ["handleAudioPause", "handleAudioWaiting", "handleAudioCanPlay", "handleAudioLoadStart"]) {
      await step(() => harness.api[callback]());
      assert.equal(statuses.at(-1), "error", `${callback} must not hide the retry state`);
      assert.equal(harness.api.isPlaying, false);
    }
    await step(() => harness.api.retryPodcastPlayback());
    assert.equal(audio.error, null);
    assert.equal(statuses.at(-1), "playing");
  } finally { await harness.close(); }
});
