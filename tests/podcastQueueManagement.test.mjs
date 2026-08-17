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
  "src/views/podcast/components/QueueEpisodeRow.tsx",
  "src/views/podcast/components/Dialogs.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const cssSource = readFileSync("src/styles/podcasts.css", "utf8");
const rustSource = [
  "src-tauri/src/podcast/commands.rs",
  "src-tauri/src/podcast/queue.rs",
  "src-tauri/src/podcast/query.rs",
].map((path) => readFileSync(path, "utf8")).join("\n");

test("podcast playlist supports bounded batch editing with explicit confirmation", () => {
  assert.match(viewSource, /PODCAST_QUEUE_BATCH_LIMIT = 500/);
  assert.match(viewSource, /aria-label="批量管理待播"/);
  assert.match(viewSource, /顺序下载/);
  assert.match(viewSource, /标为已听/);
  assert.match(viewSource, /标为未听/);
  assert.match(viewSource, /移除所选/);
  assert.match(viewSource, /show=\{queueRemovalIntent !== null\}/);
  assert.match(viewSource, /下载文件与收听进度都会保留/);
  assert.match(
    viewSource,
    /<Button onClick=\{onCancel\} disabled=\{busy\} autoFocus>/,
  );
});

test("podcast batch queue mutations stay atomic and synchronize through App", () => {
  assert.match(
    appSource,
    /function removePodcastQueueEpisodes\([\s\S]*?beginPodcastQueueMutation\(optimistic\)[\s\S]*?podcast_queue_remove_many/,
  );
  assert.match(
    appSource,
    /function setPodcastQueueEpisodesPlayed\([\s\S]*?podcastProgressMutationRef\.current\.then[\s\S]*?podcast_set_episodes_played/,
  );
  assert.match(
    appSource,
    /function downloadPodcastQueueEpisodes\([\s\S]*?for \(const episode of uniqueEpisodes\)[\s\S]*?podcast_download_episode/,
  );
  assert.match(rustSource, /pub async fn podcast_queue_remove_many\(/);
  assert.match(rustSource, /transaction_with_behavior\(TransactionBehavior::Immediate\)/);
  assert.match(rustSource, /pub async fn podcast_set_episodes_played\(/);
});

test("playlist queue exposes drag ordering and useful episode metadata", () => {
  assert.match(viewSource, /className="podcast-queue-drag"/);
  assert.match(viewSource, /onDragOver=\{onDragOver\}/);
  assert.match(viewSource, /onDrop=\{onDrop\}/);
  assert.match(viewSource, /onReorderQueueEpisode\(/);
  assert.match(viewSource, /item\.episode\.totalBytes/);
  assert.match(viewSource, /formatFileSize\(fileBytes\)/);
  assert.match(cssSource, /\.podcast-queue-episode\[data-drop-position="before"\]::before/);
  assert.match(cssSource, /\.podcast-queue-episode\[data-drop-position="after"\]::after/);
  assert.match(
    cssSource,
    /\.podcast-queue-drag,[\s\S]*?width:\s*40px;[\s\S]*?height:\s*40px;/,
  );
});

test("podcast playlist keeps its controls and queue on one responsive content track", () => {
  assert.match(
    viewSource,
    /className="podcast-playlist-content"[\s\S]*?<PodcastSection title="正在播放" className="podcast-playlist-current">[\s\S]*?className="podcast-auto-queue"[\s\S]*?title="待播队列"[\s\S]*?className="podcast-playlist-queue"/,
  );
  assert.match(
    cssSource,
    /\.podcast-playlist-content\s*\{[\s\S]*?width:\s*min\(1240px,\s*100%\);[\s\S]*?\}/,
  );
  assert.match(
    cssSource,
    /@media \(min-width: 1400px\)[\s\S]*?\.podcast-playlist-content \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(300px, 380px\)/,
    "wide windows must lay the playlist out as queue main track plus sidebar",
  );
  assert.match(
    cssSource,
    /\.podcast-playlist-queue\s*\{[\s\S]*?grid-column:\s*1;[\s\S]*?grid-row:\s*1 \/ span 2;/,
    "the queue must own the main column across both sidebar rows",
  );
  assert.match(
    cssSource,
    /\.podcast-playlist-content \.podcast-current-episode,[\s\S]*?\.podcast-playlist-content \.podcast-queue-batch\s*\{[\s\S]*?width:\s*100%;[\s\S]*?\}/,
  );
});
