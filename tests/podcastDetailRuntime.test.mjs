import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { deferred, mountPodcastHook, podcastDetail, podcastEpisode, podcastFeed, runtime, step } from "./helpers/podcastRuntime.mjs";

for (const action of ["save", "delete", "played"]) {
  for (const destination of ["loaded", "loading", "closed"]) {
    test(`late ${action} results keep the ${destination} detail navigation while updating the original episode`, async () => {
      const result = deferred();
      const detailB = deferred();
      const a = podcastEpisode("a", { localPath: "a.mp3", downloadState: "downloaded" });
      const b = podcastEpisode("b", { title: "当前单集 B" });
      const stored = new Map([["a", a], ["b", b]]);
      const updates = [];
      const noop = () => {};
      const props = { queue: [], autoQueueMode: "off", activeEpisode: null, activeEpisodeId: null,
        activeProgress: 0, activeDuration: 0, libraryRevision: 0, episodeRequest: null, feedRequest: null,
        pinnedPodcastFeedIds: new Set(), isPlaying: false, onEpisodeRequestHandled: noop,
        onFeedRequestHandled: noop, onTogglePodcastPin: noop, onReturnToNowPlaying: noop,
        onPlayEpisode: noop, onPlayEpisodeAt: noop, onQueueEpisode: noop, onRemoveQueueEpisode: noop,
        onMoveQueueEpisode: noop, onReorderQueueEpisode: noop, onRemoveQueueEpisodes: noop,
        onSetQueueEpisodesPlayed: noop, onDownloadQueueEpisodes: noop, onClearQueue: noop,
        onAutoQueueMode: noop, onEpisodeUpdated: episode => updates.push(episode),
        onSetEpisodePlayed: () => result.promise, onDownloadsDeleted: noop };
      const harness = await mountPodcastHook(runtime.usePodcastViewModel, props, async (command, args) => {
        if (command === "podcast_list_feeds") return [podcastFeed];
        if (command === "podcast_list_home") return { latestEpisodes: [...stored.values()] };
        if (command === "podcast_list_saved_episodes") return [...stored.values()].filter(item => item.saved).map(podcastDetail);
        if (command === "podcast_list_related_episodes" || command === "podcast_browse_apple") return [];
        if (command === "podcast_refresh_feeds") return { checked: 0, notModified: 0, failures: [] };
        if (command === "podcast_list_episodes") return [...stored.values()];
        if (command === "podcast_get_episode_detail") {
          if (args.episodeId === "b" && destination === "loading") return detailB.promise;
          return podcastDetail(stored.get(args.episodeId));
        }
        if (command === "podcast_set_episode_saved" || command === "podcast_delete_episode_download") return result.promise;
        throw Error(command);
      }, {}, vm => React.createElement("div", null,
        React.createElement("h1", { ref: vm.headingRef, tabIndex: -1 },
          vm.screen === "episode" ? vm.displayedEpisodeDetail?.episode.title : "节目"),
        React.createElement("button", { onClick: vm.closeEpisodeDetail }, "返回"),
      ));
      try {
        await step(() => harness.api.openStoredFeed(podcastFeed, "listen"));
        await step(() => harness.api.openEpisodeDetail(a));
        let operation;
        await step(() => {
          const method = { save: "toggleEpisodeSaved", delete: "deleteEpisodeDownload", played: "toggleEpisodePlayed" }[action];
          operation = harness.api[method](harness.api.selectedEpisodeDetail);
        });
        if (destination === "closed") {
          await step(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
          assert.equal(harness.api.screen, "show");
        } else {
          await step(() => harness.api.openEpisodeDetail(b));
          if (destination === "loaded") assert.equal(harness.api.displayedEpisodeDetail.episode.id, "b");
          else assert.equal(harness.api.selectedEpisodeDetail, null);
        }
        const heading = document.querySelector("h1");
        heading.focus();
        const changed = { ...a, ...(action === "save" ? { saved: true }
          : action === "played" ? { completed: true, progressSeconds: 1000 }
          : { localPath: null, downloadState: "none", downloadedBytes: 0 }) };
        stored.set("a", changed);
        await step(async () => { result.resolve(podcastDetail(changed)); await operation; });
        assert.equal(document.activeElement, heading, "completion preserves the current keyboard focus");
        assert.equal(harness.api.screen, destination === "closed" ? "show" : "episode");
        if (destination === "loaded") {
          assert.equal(harness.api.displayedEpisodeDetail.episode.id, "b");
          assert.equal(heading.textContent, b.title);
        } else if (destination === "loading") {
          assert.equal(harness.api.selectedEpisodeDetail, null, "a response cannot fill another episode's loading screen");
          assert.equal(harness.api.detailState, "loading");
          await step(() => detailB.resolve(podcastDetail(b)));
          assert.equal(harness.api.displayedEpisodeDetail.episode.id, "b");
        }
        assert.deepEqual(updates.at(-1), changed, "the playback domain still receives the original episode update");
        assert.deepEqual(harness.api.episodes.find(item => item.id === "a"), changed);
        assert.deepEqual(harness.api.latestEpisodes.find(item => item.id === "a"), changed);
      } finally { await harness.close(); }
    });
  }
}

test("a detail mutation still replaces full metadata when its own episode remains selected", async () => {
  const result = deferred();
  const a = podcastEpisode("a");
  const noop = () => {};
  const props = { queue: [], autoQueueMode: "off", activeEpisode: null, activeEpisodeId: null,
    activeProgress: 0, activeDuration: 0, libraryRevision: 0, episodeRequest: null, feedRequest: null,
    pinnedPodcastFeedIds: new Set(), onEpisodeUpdated: noop };
  const harness = await mountPodcastHook(runtime.usePodcastViewModel, props, async command => {
    if (command === "podcast_get_episode_detail") return podcastDetail(a);
    if (command === "podcast_set_episode_saved") return result.promise;
    if (command === "podcast_list_home") return {};
    if (command === "podcast_refresh_feeds") return { checked: 0, failures: [] };
    return [];
  });
  try {
    await step(() => harness.api.openEpisodeDetail(a));
    let operation;
    await step(() => { operation = harness.api.toggleEpisodeSaved(harness.api.selectedEpisodeDetail); });
    const changed = { ...podcastDetail({ ...a, saved: true }), hasChapters: true, transcriptCount: 2 };
    await step(async () => { result.resolve(changed); await operation; });
    assert.deepEqual(harness.api.selectedEpisodeDetail, changed);
  } finally { await harness.close(); }
});
