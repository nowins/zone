import assert from "node:assert/strict";
import test from "node:test";
import { deferred, mountPodcastPlayback, podcastEpisode, podcastPlayback, podcastDetail, step } from "./helpers/podcastRuntime.mjs";

test("returning through an old list snapshot restores the latest clock including throttled progress and rewinds", async () => {
  const writes = [];
  const a = podcastPlayback(podcastEpisode("a"));
  const b = podcastPlayback(podcastEpisode("b"));
  const harness = await mountPodcastPlayback(async (command, args) => {
    if (command === "podcast_list_queue") return [];
    if (command === "podcast_save_progress") { writes.push(args); return; }
    if (command === "podcast_set_episode_played") return podcastDetail(podcastEpisode(args.episodeId));
    throw new Error(command);
  });
  try {
    await step(() => harness.api.playPodcastEpisode(a));
    harness.audioRef.current.currentTime = 1;
    await step(() => harness.api.transport.persistPodcastProgress(1, 1000));
    harness.audioRef.current.currentTime = 300;
    await step(() => harness.api.transport.persistPodcastProgress(300, 1000));
    assert.equal(writes.length, 1, "the second update is throttled only on disk");
    await step(() => harness.api.playPodcastEpisode(b));
    assert.equal(writes.findLast(write => write.episodeId === "a").positionSeconds, 300);
    harness.audioRef.current.currentTime = 0;
    await step(() => harness.api.playPodcastEpisode(a));
    assert.equal(harness.api.activePodcastEpisode.savedProgressSeconds, 300);
    assert.equal(harness.api.activePodcastEpisode.durationSeconds, 1000);

    harness.audioRef.current.currentTime = 20;
    await step(() => harness.api.transport.persistPodcastProgress(20, 1000, true));
    await step(() => harness.api.playPodcastEpisode(b));
    harness.audioRef.current.currentTime = 0;
    await step(() => harness.api.playPodcastEpisode(a));
    assert.equal(harness.api.activePodcastEpisode.savedProgressSeconds, 20);

    await step(() => harness.api.setPodcastEpisodePlayed("a", false));
    await step(() => harness.api.playPodcastEpisode(b));
    harness.audioRef.current.currentTime = 0;
    await step(() => harness.api.playPodcastEpisode(a));
    assert.equal(harness.api.activePodcastEpisode.savedProgressSeconds, 0);
    assert.equal(harness.api.activePodcastEpisode.completed, false);

    await step(() => harness.api.playPodcastEpisode(b));
    await step(() => harness.api.playPodcastEpisode(a, 42));
    assert.equal(harness.armed.at(-1).positionSeconds, 42, "chapter starts keep explicit intent");
  } finally { await harness.close(); }
});

test("a sleep deadline cancels delayed autofill playback while retaining its committed queue", async () => {
  const result = deferred();
  const a = podcastPlayback(podcastEpisode("a"));
  const queued = [{ episode: podcastEpisode("b"), position: 0, queuedAt: 1 }];
  let requested = false;
  const harness = await mountPodcastPlayback(async (command) => {
    if (command === "podcast_list_queue") return [];
    if (command === "podcast_save_progress") return;
    if (command === "podcast_queue_autofill") { requested = true; return result.promise; }
    throw Error(command);
  }, { autoQueueMode: "same-feed" });
  try {
    await step(() => harness.api.playPodcastEpisode(a));
    await step(() => harness.api.transport.handleEpisodeEnded(1000));
    assert.equal(requested, true);
    await step(() => harness.api.setPodcastSleepTimer({ kind: "deadline", deadlineAt: Date.now() }));
    await step(() => new Promise(resolve => setTimeout(resolve, 30)));
    assert.equal(harness.api.podcastPlaybackStatus, "paused");
    assert.equal(harness.intent, false);
    assert.equal(harness.api.podcastSleepTimer, null);
    await step(() => result.resolve(queued));
    assert.equal(harness.api.activePodcastEpisode.episodeId, "a");
    assert.equal(harness.armed.length, 1, "late autofill must never arm another source");
    assert.deepEqual(harness.api.podcastQueue.map(item => item.episode.id), ["b"]);
    assert.equal(harness.api.podcastPlaybackStatus, "paused");
  } finally { await harness.close(); }
});

test("explicit transport cancellation and music takeover invalidate pending continuation", async () => {
  for (const cancel of [api => api.transport.cancelPendingPodcastAutofill(), api => api.transport.clearActivePodcast()]) {
    const result = deferred();
    const a = podcastPlayback(podcastEpisode("a"));
    const harness = await mountPodcastPlayback(async (command) => {
      if (command === "podcast_list_queue") return [];
      if (command === "podcast_save_progress") return;
      if (command === "podcast_queue_autofill") return result.promise;
      throw Error(command);
    }, { autoQueueMode: "same-feed" });
    try {
      await step(() => harness.api.playPodcastEpisode(a));
      await step(() => harness.api.transport.handleEpisodeEnded(1000));
      await step(() => cancel(harness.api));
      await step(() => result.resolve([{ episode: podcastEpisode("b"), position: 0, queuedAt: 1 }]));
      assert.equal(harness.armed.length, 1);
      assert.deepEqual(harness.api.podcastQueue.map(item => item.episode.id), ["b"]);
    } finally { await harness.close(); }
  }
});
