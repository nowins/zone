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
const viewSource = readFileSync("src/views/PodcastNowPlayingView.tsx", "utf8");
const cssSource = readFileSync("src/styles/podcast-now-playing.css", "utf8");

test("podcast queue exposes direct mouse drag ordering with a precise insertion target", () => {
  assert.match(viewSource, /draggable=\{orderedQueue\.length > 1\}/);
  assert.match(
    viewSource,
    /<span[\s\S]{0,180}className="podcast-now-queue-drag"[\s\S]{0,220}aria-hidden="true"/,
  );
  assert.match(viewSource, /event\.dataTransfer\.effectAllowed = "move"/);
  assert.match(viewSource, /onDragOver=\{\(event\) => handleQueueDragOver\(event, queuedEpisode\.id\)\}/);
  assert.match(viewSource, /onDrop=\{\(event\) => handleQueueDrop\(event, queuedEpisode\.id\)\}/);
  assert.match(viewSource, /event\.clientY < bounds\.top \+ bounds\.height \/ 2 \? "before" : "after"/);
  assert.match(viewSource, /data-drop-position=\{dropPlacement\}/);
  assert.match(cssSource, /li\[data-drop-position="before"\]::before/);
  assert.match(cssSource, /li\[data-drop-position="after"\]::after/);
  assert.match(cssSource, /\.podcast-now-queue-drag[\s\S]*?cursor:\s*grab/);
});

test("drag reorder stays durable, optimistic, and uses one complete queue write", () => {
  assert.match(
    appSource,
    /function reorderPodcastQueueEpisode\([\s\S]*?beginPodcastQueueMutation\(reordered\)[\s\S]*?podcast_queue_reorder[\s\S]*?episodeIds:\s*reordered\.map/,
  );
  assert.match(
    appSource,
    /<PodcastNowPlayingView[\s\S]*?onReorderQueueItem=\{reorderPodcastQueueEpisode\}/,
  );
  assert.match(
    viewSource,
    /onReorderQueueItem\(sourceEpisodeId, targetEpisodeId, placement\)/,
  );
});

test("queue arrows remain an accessible fallback and reorder changes are announced", () => {
  assert.match(viewSource, /aria-label=\{`上移“\$\{queuedEpisode\.title\}”`\}/);
  assert.match(viewSource, /aria-label=\{`下移“\$\{queuedEpisode\.title\}”`\}/);
  assert.match(viewSource, /disabled=\{index === 0\}/);
  assert.match(viewSource, /disabled=\{index === orderedQueue\.length - 1\}/);
  assert.match(viewSource, /aria-live="polite"/);
  assert.match(viewSource, /拖动把手调整顺序，也可使用上移和下移按钮。/);
  assert.match(viewSource, /onDragEnd=\{resetQueueDrag\}/);
  assert.doesNotMatch(
    viewSource,
    /<button[\s\S]{0,180}className="podcast-now-queue-drag"/,
  );
});
