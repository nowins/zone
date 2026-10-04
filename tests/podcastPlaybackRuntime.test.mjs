import assert from "node:assert/strict";
import test from "node:test";
import { deferred, mountPodcastPlayback, podcastEpisode, podcastPlayback, podcastDetail, step } from "./helpers/podcastRuntime.mjs";

test("replacing a named list without playback restores the previous queue with guarded undo", async () => {
  const before = [{ episode: podcastEpisode("before"), position: 0, addedAt: 1 }];
  let queue = before, restored;
  const h = await mountPodcastPlayback(async (command, args) => {
    if (command === "podcast_list_queue") return queue;
    if (command === "podcast_activate_playlist") { queue = [{ episode: podcastEpisode("after"), position: 0, addedAt: 2 }]; return queue; }
    if (command === "podcast_queue_restore") { restored = args; queue = before; return queue; }
  });
  try {
    await step(() => h.api.playPodcastPlaylist("list", false));
    assert.equal(h.armed.length, 0); assert.equal(h.api.queueUndoAvailable, true); assert.equal(h.api.queueUndoKind, "replace");
    await step(() => h.api.undoPodcastQueueRemoval());
    assert.deepEqual(restored.episodeIds, ["before"]); assert.deepEqual(restored.expectedIds, ["after"]); assert.equal(restored.expectedActive, null);
    assert.equal(h.api.podcastQueue[0].episode.id, "before"); assert.equal(h.api.queueUndoAvailable, false);
  } finally { await h.close(); }
});

test("playing a named list uses the shared transport and a later pause prevents delayed autoplay", async () => {
  const pending = deferred();
  const items = [{ episode: podcastEpisode("listed"), position: 0, addedAt: 1 }];
  const h = await mountPodcastPlayback(async command => command === "podcast_activate_playlist" ? pending.promise : command === "podcast_list_queue" ? [] : undefined);
  try {
    let operation;
    await step(() => { operation = h.api.playPodcastPlaylist("list"); });
    await step(() => h.api.transport.cancelPendingPodcastAutofill());
    await step(() => pending.resolve(items)); await operation;
    assert.equal(h.api.podcastQueue[0].episode.id, "listed"); assert.equal(h.armed.length, 0);
    await step(() => h.api.playPodcastPlaylist("list"));
    assert.equal(h.api.activePodcastEpisode.episodeId, "listed"); assert.equal(h.armed.length, 1);
  } finally { await h.close(); }
});

test("record moment uses the bound audio clock and preserves an existing note", async () => {
  let saved;
  const h = await mountPodcastPlayback(async (command, args) => {
    if (command === "podcast_list_bookmarks") return [];
    if (command === "podcast_add_bookmark") { saved = args; return []; }
    return [];
  });
  try {
    await step(() => h.api.playPodcastEpisode(podcastPlayback(podcastEpisode("recorded", { progressSeconds: 17 }))));
    h.audioRef.current.currentTime = 999;
    await step(() => h.api.recordPodcastMoment());
    assert.equal(saved.positionSeconds, 17); assert.equal(saved.preserveExisting, true);
    h.playbackControlsRef.current.hasEpisodeStartedOnDevice = () => true;
    h.audioRef.current.currentTime = 23.5;
    await step(() => h.api.recordPodcastMoment());
    assert.equal(saved.positionSeconds, 23.5); assert.equal(saved.episodeId, "recorded");
  } finally { await h.close(); }
});

test("a return from suspended scheduling expires sleep before reconnect can resume", async () => {
  const h = await mountPodcastPlayback(async () => []);
  try {
    await step(() => h.api.playPodcastEpisode(podcastPlayback(podcastEpisode("sleeping"))));
    h.audioRef.current.paused = false;
    await step(() => h.api.setPodcastSleepTimer({ kind: "deadline", deadlineAt: Date.now() + 60000 }));
    const original = Date.now;
    try {
      Date.now = () => original() + 120000;
      await step(() => { assert.equal(h.api.transport.expireSleepTimer(), true); });
      assert.equal(h.audioRef.current.paused, true); assert.equal(h.intent, false); assert.equal(h.api.podcastSleepTimer, null);
      assert.equal(h.api.transport.expireSleepTimer(), false);
    } finally { Date.now = original; }
  } finally { await h.close(); }
});

test("a queue edit after list playback starts wins over its delayed activation result", async () => {
  const pending = deferred(); let queue = [];
  const h = await mountPodcastPlayback(async command => {
    if (command === "podcast_activate_playlist") { queue = await pending.promise; return queue; }
    if (command === "podcast_queue_clear") { queue = []; return; }
    if (command === "podcast_list_queue") return queue;
  });
  try {
    let activation, clearing;
    await step(() => { activation = h.api.playPodcastPlaylist("list"); });
    await step(() => { clearing = h.api.clearPodcastQueue(); });
    await step(() => pending.resolve([{ episode: podcastEpisode("listed"), position: 0, addedAt: 1 }]));
    await Promise.all([activation, clearing]);
    assert.deepEqual(h.api.podcastQueue, []); assert.equal(h.armed.length, 0);
  } finally { await h.close(); }
});

test("show preferences load before binding, respect a later pause, and preserve the global rate",async()=>{
  const pending=deferred();
  const h=await mountPodcastPlayback(async()=>[],{playbackRate:1.25},{preferences:feed=>feed?pending.promise:{playbackRate:1.25}});
  try{
    await step(()=>h.api.playPodcastEpisode(podcastPlayback(podcastEpisode("custom"))));
    assert.equal(h.api.transport.podcastPreferencesReady,false);
    await step(()=>h.api.setPodcastPlaybackRate(3));
    assert.equal(JSON.parse(localStorage.getItem("zone-podcast-playback-v1")).playbackRate,1.25);
    h.playbackControlsRef.current.setPlaybackIntent(false);
    await step(()=>pending.resolve({inheritPlayback:false,playbackRate:2,introSeconds:10,outroSeconds:20,backwardSeconds:10,forwardSeconds:45}));
    assert.equal(h.api.transport.podcastPreferencesReady,true);assert.equal(h.api.podcastPlaybackRate,2);assert.equal(h.intent,false);assert.equal(h.armed.length,1);
    assert.equal(JSON.parse(localStorage.getItem("zone-podcast-playback-v1")).playbackRate,1.25);
    assert.equal(h.api.transport.resolvePodcastIntro(0,300,false),10);assert.equal(h.api.transport.resolvePodcastIntro(2,300,true),2);
  }finally{await h.close();}
});

test("outro completion happens once and a late preferences response cannot revive another episode",async()=>{
  const pending=deferred();const h=await mountPodcastPlayback(async()=>[],{}, {preferences:feed=>feed?pending.promise:{}});
  try{
    await step(()=>h.api.playPodcastEpisode(podcastPlayback(podcastEpisode("first"))));await step(()=>h.api.transport.clearActivePodcast());
    await step(()=>pending.resolve({inheritPlayback:false,playbackRate:3}));assert.equal(h.api.activePodcastEpisode,null);assert.equal(h.api.podcastPlaybackRate,1);
    await step(()=>h.api.playPodcastEpisode(podcastPlayback(podcastEpisode("second"))));
    await step(()=>h.api.transport.handleEpisodeEnded(1000));await step(()=>h.api.transport.handleEpisodeEnded(1000));
    assert.equal(h.api.activePodcastEpisode.completed,true);
  }finally{await h.close();}
});

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

test("queue removal undo is serialized and new queue actions invalidate the previous snapshot",async()=>{
 const original=[{episode:podcastEpisode("first"),position:0,addedAt:1},{episode:podcastEpisode("second"),position:1,addedAt:2}];let queue=[...original];const restores=[];
 const h=await mountPodcastPlayback(async(command,args)=>{if(command==="podcast_list_queue")return queue;if(command==="podcast_queue_remove"){queue=queue.filter(item=>item.episode.id!==args.episodeId);return queue;}if(command==="podcast_queue_restore"){restores.push(args);queue=[...original];return queue;}if(command==="podcast_queue_clear"){queue=[];return;}if(command==="podcast_queue_add"){queue=[...original];return queue;}});
 try{await step(()=>h.api.removePodcastQueueEpisode("first"));assert.equal(h.api.queueUndoAvailable,true);await step(()=>h.api.undoPodcastQueueRemoval());assert.deepEqual(restores[0].expectedIds,["second"]);assert.deepEqual(h.api.podcastQueue.map(item=>item.episode.id),["first","second"]);await step(()=>h.api.clearPodcastQueue());assert.equal(h.api.queueUndoAvailable,true);await step(()=>h.api.queuePodcastEpisode(podcastEpisode("first"),false));assert.equal(h.api.queueUndoAvailable,false);await step(()=>h.api.undoPodcastQueueRemoval());assert.equal(restores.length,1);}finally{await h.close();}
});

test("queue movement reports success only after persistence and restores order on failure", async () => {
 const pending=deferred();let fail=false;
 let queue=["first","second"].map((id,position)=>({episode:podcastEpisode(id),position,addedAt:1}));
 const h=await mountPodcastPlayback(async(command,args)=>{
   if(command==="podcast_list_queue")return queue;
   if(command==="podcast_queue_reorder"){
     await pending.promise;if(fail)throw Error("write failed");
     queue=args.episodeIds.map((id,position)=>({episode:podcastEpisode(id),position,addedAt:1}));return queue;
   }
 });
 try{
   let operation;await step(()=>{operation=h.api.movePodcastQueueEpisode("first",1);});
   assert.deepEqual(h.api.podcastQueue.map(item=>item.episode.id),["second","first"]);
   await step(()=>pending.resolve());assert.equal(await operation,true);
   fail=true;let failed;await step(async()=>{failed=await h.api.movePodcastQueueEpisode("first",-1);});
   assert.equal(failed,false);assert.deepEqual(h.api.podcastQueue.map(item=>item.episode.id),["second","first"]);
   assert.ok(h.notices.includes("无法调整待播顺序"));
 }finally{await h.close();}
});

test("a paused streaming episode adopts its completed download without autoplay and resumes locally",async()=>{
 const h=await mountPodcastPlayback(async()=>[]);const episode=podcastEpisode("offline-switch",{progressSeconds:60});
 try{await step(()=>h.api.playPodcastEpisode(podcastPlayback(episode)));h.audioRef.current.currentTime=62;h.audioRef.current.paused=true;const downloaded={...episode,localPath:"C:/fixture/episode.mp3",downloadState:"downloaded"};await step(()=>h.api.updatePodcastEpisode(downloaded));assert.equal(h.api.activePodcastEpisode.playbackLocalPath,downloaded.localPath);assert.equal(h.api.activePodcastEpisode.savedProgressSeconds,62);assert.equal(h.audioRef.current.paused,true);await step(()=>h.api.playPodcastEpisode(podcastPlayback(downloaded)));assert.equal(h.audioRef.current.paused,false);assert.equal(h.armed.length,1);}finally{await h.close();}
});

test("finishing a download during streaming waits for pause before changing its source",async()=>{
 const h=await mountPodcastPlayback(async()=>[]);const episode=podcastEpisode("playing-download",{progressSeconds:60});
 try{await step(()=>h.api.playPodcastEpisode(podcastPlayback(episode)));h.audioRef.current.currentTime=66;h.audioRef.current.paused=false;h.playbackControlsRef.current.hasEpisodeStartedOnDevice=()=>true;await step(()=>h.api.updatePodcastEpisode({...episode,localPath:"C:/fixture/episode.mp3",downloadState:"downloaded"}));assert.equal(h.api.activePodcastEpisode.playbackLocalPath,undefined);assert.equal(h.audioRef.current.paused,false);await step(()=>h.audioRef.current.pause());assert.equal(h.api.activePodcastEpisode.playbackLocalPath,"C:/fixture/episode.mp3");assert.equal(h.api.activePodcastEpisode.savedProgressSeconds,66);assert.equal(h.audioRef.current.paused,true);}finally{await h.close();}
});
