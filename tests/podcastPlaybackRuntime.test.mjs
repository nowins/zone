import assert from "node:assert/strict";
import test from "node:test";
import { mountPodcastPlayback, podcastEpisode, podcastPlayback, podcastDetail, step } from "./helpers/podcastRuntime.mjs";

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
