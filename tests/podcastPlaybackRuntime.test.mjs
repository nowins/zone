import assert from "node:assert/strict";
import test from "node:test";
import { deferred, mountPodcastPlayback, podcastEpisode, podcastPlayback, podcastDetail, step } from "./helpers/podcastRuntime.mjs";

test("native current episode overrides an older WebView setting and restores paused", async () => {
  const requested = []; const saved = [];
  const harness = await mountPodcastPlayback(async (command, args) => {
    if (command === "podcast_list_queue") return [];
    if (command === "podcast_get_episode_detail") { requested.push(args.episodeId); return podcastDetail(podcastEpisode(args.episodeId, { progressSeconds: 123 })); }
    throw Error(command);
  }, { activeEpisodeId: "old", playbackRate: 1.5 }, { load: async () => ({ activeEpisodeId: "new" }), save: async id => saved.push(id) });
  try {
    assert.deepEqual(requested, ["new"]);
    assert.equal(harness.api.activePodcastEpisode.savedProgressSeconds, 123);
    assert.equal(harness.api.podcastPlaybackStatus, "paused");
    assert.equal(harness.api.podcastPlaybackRate, 1.5);
    assert.equal(harness.armed.length, 0);
    assert.deepEqual(saved, ["new"]);
    assert.equal(JSON.parse(localStorage.getItem("zone-podcast-playback-v1")).activeEpisodeId, "new");
  } finally { await harness.close(); }
});

test("an explicit native clear overrides a stale browser episode", async () => {
  const saved = [];
  const harness = await mountPodcastPlayback(async command => {
    if (command === "podcast_list_queue") return [];
    throw Error(command);
  }, { activeEpisodeId: "old" }, { load: async () => ({ activeEpisodeId: null }), save: async id => saved.push(id) });
  try {
    assert.equal(harness.api.activePodcastEpisode, null);
    assert.equal(harness.api.podcastSessionHydrated, true);
    assert.deepEqual(saved, [null]);
    assert.equal(JSON.parse(localStorage.getItem("zone-podcast-playback-v1")).activeEpisodeId, null);
  } finally { await harness.close(); }
});

test("failed native session recovery retains browser fallback and pauses native automatic writes", async () => {
  const saved = [];
  const harness = await mountPodcastPlayback(async (command, args) => {
    if (command === "podcast_list_queue") return [];
    if (command === "podcast_get_episode_detail") return podcastDetail(podcastEpisode(args.episodeId));
    if (command === "podcast_save_progress") return;
    throw Error(command);
  }, { activeEpisodeId: "old" }, { load: async () => { throw Error("corrupt native record"); }, save: async id => saved.push(id) });
  try {
    assert.equal(harness.api.activePodcastEpisode.episodeId, "old");
    await step(() => harness.api.playPodcastEpisode(podcastPlayback(podcastEpisode("new"))));
    await step(() => harness.api.transport.persistPodcastProgress(42, 1000, true));
    assert.deepEqual(saved, []);
  } finally { await harness.close(); }
});

test("failed episode detail recovery cannot clear a successfully read native current episode", async () => {
  const saved = [];
  const harness = await mountPodcastPlayback(async command => {
    if (command === "podcast_list_queue") return [];
    throw Error("database temporarily unavailable");
  }, {}, { load: async () => ({ activeEpisodeId: "a" }), save: async id => saved.push(id) });
  try {
    assert.equal(harness.api.podcastSessionHydrated, true);
    assert.equal(harness.api.activePodcastEpisode, null);
    assert.deepEqual(saved, []);
  } finally { await harness.close(); }
});

test("manual selection while native session restore is pending wins and becomes the durable current episode", async () => {
  const pending = deferred(); const saved = [];
  const harness = await mountPodcastPlayback(async command => {
    if (command === "podcast_list_queue") return [];
    if (command === "podcast_save_progress") return;
    throw Error(command);
  }, {}, { load: () => pending.promise, save: async id => saved.push(id) });
  try {
    await step(() => harness.api.playPodcastEpisode(podcastPlayback(podcastEpisode("new"))));
    await step(() => pending.resolve({ activeEpisodeId: "old" }));
    assert.equal(harness.api.activePodcastEpisode.episodeId, "new");
    assert.deepEqual(saved, ["new"]);
    assert.equal(harness.armed.length, 1);
  } finally { await harness.close(); }
});

test("current episode writes serialize and discard superseded queued selections", async () => {
  const pending = deferred(); const saved = [];
  const harness = await mountPodcastPlayback(async command => {
    if (command === "podcast_list_queue") return [];
    if (command === "podcast_save_progress") return;
    throw Error(command);
  }, {}, { save: async id => { saved.push(id); if (id === "a") await pending.promise; } });
  try {
    saved.length = 0;
    await step(() => harness.api.playPodcastEpisode(podcastPlayback(podcastEpisode("a"))));
    await step(() => harness.api.playPodcastEpisode(podcastPlayback(podcastEpisode("b"))));
    await step(() => harness.api.transport.clearActivePodcast());
    assert.deepEqual(saved, ["a"]);
    await step(() => pending.resolve());
    assert.deepEqual(saved, ["a", null]);
  } finally { await harness.close(); }
});

test("a failed current episode write retries after progress persistence recovers", async () => {
  const saved = []; let fail = true;
  const harness = await mountPodcastPlayback(async command => {
    if (command === "podcast_list_queue") return [];
    if (command === "podcast_save_progress") return;
    throw Error(command);
  }, {}, { save: async id => { if (id) { saved.push(id); if (fail) throw Error("disk full"); } } });
  try {
    await step(() => harness.api.playPodcastEpisode(podcastPlayback(podcastEpisode("a"))));
    assert.deepEqual(saved, ["a"]);
    assert.deepEqual(harness.notices, ["当前单集保存失败，将自动重试"]);
    fail = false;
    await step(() => harness.api.transport.persistPodcastProgress(42, 1000, true));
    assert.deepEqual(saved, ["a", "a"]);
    assert.equal(harness.notices.length, 1);
  } finally { await harness.close(); }
});

test("failed clear retries without a live podcast and stops its retry timer on unmount", async () => {
  const saved = []; let failClear = false;
  let closed = false;
  const timers = new Map(); let nextTimer = 0;
  const harness = await mountPodcastPlayback(async command => {
    if (command === "podcast_list_queue") return [];
    if (command === "podcast_save_progress") return;
    throw Error(command);
  }, {}, { save: async id => { saved.push(id); if (!id && failClear) throw Error("disk full"); } });
  window.setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
  window.clearTimeout = id => timers.delete(id);
  try {
    await step(() => harness.api.playPodcastEpisode(podcastPlayback(podcastEpisode("a"))));
    failClear = true;
    await step(() => harness.api.transport.clearActivePodcast());
    assert.equal(timers.size, 1);
    failClear = false;
    await step(() => { const [id, retry] = timers.entries().next().value; timers.delete(id); retry(); });
    assert.deepEqual(saved.slice(-2), [null, null]);
    assert.equal(timers.size, 0);
    failClear = true;
    await step(() => harness.api.playPodcastEpisode(podcastPlayback(podcastEpisode("a"))));
    await step(() => harness.api.transport.clearActivePodcast());
    assert.equal(timers.size, 1);
    await harness.close();
    closed = true;
    assert.equal(timers.size, 0);
  } finally { if (!closed) await harness.close(); }
});

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
