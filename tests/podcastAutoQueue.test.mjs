import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = [
  "src/app/podcastPlaybackSettings.ts",
  "src/hooks/useNavigation.ts",
  "src/hooks/useMusicLibrary.ts",
  "src/hooks/usePodcastPlayback.ts",
  "src/hooks/usePlaybackControls.ts",
  "src/hooks/useAudioEngine.ts",
  "src/hooks/usePlaylists.ts",
  "src/App.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const viewSource = [
  "src/views/PodcastView.tsx",
  "src/views/podcast/usePodcastViewModel.ts",
  "src/views/podcast/api.ts",
  "src/views/podcast/screens/ListenScreen.tsx",
  "src/views/podcast/screens/DiscoverScreen.tsx",
  "src/views/podcast/screens/LibraryScreen.tsx",
  "src/views/podcast/screens/PlaylistScreen.tsx",
  "src/views/podcast/screens/ShowScreen.tsx",
  "src/views/podcast/screens/EpisodeScreen.tsx",
  "src/views/podcast/constants.ts",
].map((path) => readFileSync(path, "utf8")).join("\n");
const stylesSource = readFileSync("src/styles/podcasts.css", "utf8");
const typesSource = readFileSync("src/types.ts", "utf8");
const rustSource = [
  "src-tauri/src/podcast/commands.rs",
  "src-tauri/src/podcast/queue.rs",
].map((path) => readFileSync(path, "utf8")).join("\n");

test("smart podcast continuation is a persistent mutually exclusive preference", () => {
  assert.match(
    typesSource,
    /PodcastAutoQueueMode = "off" \| "same-feed" \| "random-unplayed"/,
  );
  assert.match(viewSource, /id="podcast-auto-queue-label">播完后/);
  assert.match(viewSource, /role="group"/);
  assert.match(viewSource, /aria-pressed=\{autoQueueMode === mode\.id\}/);
  assert.match(viewSource, /停止/);
  assert.match(viewSource, /同节目下一集/);
  assert.match(viewSource, /随机未听/);
  assert.match(viewSource, /手动待播优先/);
  assert.match(stylesSource, /\.podcast-auto-queue-options button[\s\S]*?min-height:\s*40px/);
  assert.match(
    appSource,
    /patchPodcastPlaybackSettings\(\{ autoQueueMode: mode \}\)/,
  );
  assert.match(
    appSource,
    /JSON\.stringify\(\{ \.\.\.readPodcastPlaybackSettings\(\), \.\.\.patch \}\)/,
  );
});

test("episode completion keeps sleep and manual queue ahead of smart autofill", () => {
  const endedStart = appSource.indexOf("function handleEpisodeEnded(");
  const endedEnd = appSource.indexOf("\n  function ", endedStart + 1);
  const endedSource = appSource.slice(endedStart, endedEnd);
  const sleepIndex = endedSource.indexOf('podcastSleepTimer?.kind === "episodeEnd"');
  const manualIndex = endedSource.indexOf("playNextPodcastEpisode(false)");
  const autoIndex = endedSource.indexOf("autofillPodcastQueueAfter(endedEpisodeId)");
  const pauseIndex = endedSource.lastIndexOf('setPodcastPlaybackStatus("paused")');
  assert.ok(sleepIndex >= 0);
  assert.ok(sleepIndex < manualIndex);
  assert.ok(manualIndex < autoIndex);
  assert.ok(autoIndex < pauseIndex);
});

test("smart autofill is revision-aware and backed by an atomic queue command", () => {
  const autofillStart = appSource.indexOf("function autofillPodcastQueueAfter(");
  const autofillEnd = appSource.indexOf("\n  function appendToQueue(", autofillStart);
  const autofillSource = appSource.slice(autofillStart, autofillEnd);
  assert.match(
    appSource,
    /function autofillPodcastQueueAfter\([\s\S]*?beginPodcastQueueMutation\([\s\S]*?podcast_queue_autofill/,
  );
  assert.match(
    appSource,
    /const isCurrentAttempt = \(\) =>[\s\S]*?podcastAutoQueueAttemptRef\.current === attempt[\s\S]*?podcastAutoQueueModeRef\.current === mode/,
  );
  assert.match(
    appSource,
    /const ownsRevision = podcastQueueRevisionRef\.current === revision/,
  );
  const invokeIndex = autofillSource.indexOf("const items = await invoke");
  assert.ok(
    autofillSource.indexOf("if (ownsRevision) applyPodcastQueueResult(items, revision)")
      < autofillSource.indexOf("if (!isCurrentAttempt()) return;", invokeIndex),
    "committed autofill results should be reconciled before a stale response stops playback",
  );
  assert.match(rustSource, /pub async fn podcast_queue_autofill\(/);
  assert.match(
    rustSource,
    /fn queue_autofill\([\s\S]*?transaction_with_behavior\(TransactionBehavior::Immediate\)/,
  );
  assert.match(rustSource, /f\.subscribed = 1/);
  assert.match(rustSource, /COALESCE\(p\.position_seconds, 0\) <= 0/);
});
