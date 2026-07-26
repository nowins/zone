import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/App.tsx", "utf8");
const viewSource = readFileSync("src/views/PodcastView.tsx", "utf8");
const cssSource = readFileSync("src/styles/podcasts.css", "utf8");
const rustSource = readFileSync("src-tauri/src/podcast.rs", "utf8");

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
    /<button type="button" onClick=\{onCancel\} disabled=\{busy\} autoFocus>/,
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
