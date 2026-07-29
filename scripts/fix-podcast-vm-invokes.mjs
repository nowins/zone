import { readFileSync, writeFileSync } from "node:fs";

let s = readFileSync("src/views/podcast/usePodcastViewModel.ts", "utf8");

s = s.replaceAll('from "./podcast/', 'from "./');

// Drop view-only component imports if still present
for (const mod of [
  "primitives",
  "EpisodeRows",
  "QueueEpisodeRow",
  "EpisodeDetail",
  "ContinueCard",
  "ShowCards",
  "Dialogs",
]) {
  s = s.replace(
    new RegExp(`import\\s*\\{[\\s\\S]*?\\}\\s*from\\s*"\\.\\/components\\/${mod}";\\n`),
    "",
  );
}

const chunks = [
  [
    /await invoke<PodcastDownloadPage>\(\s*"podcast_list_downloads",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.listPodcastDownloads(offset, PODCAST_DOWNLOAD_PAGE_SIZE)",
  ],
  [
    /await invoke<PodcastDiscoveryShow\[\]>\(\s*"podcast_browse_apple",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.browseApplePodcasts(24)",
  ],
  [
    /await invoke<PodcastEpisode\[\]>\(\s*"podcast_list_episodes",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.listPodcastEpisodes(feed.id)",
  ],
  [
    /await invoke<PodcastRefreshReport>\(\s*"podcast_refresh_feeds",\s*\{\s*force: false,\s*\}\s*\)/g,
    "await podcastApi.refreshPodcastFeeds({ force: false })",
  ],
  [
    /await invoke<PodcastRefreshReport>\(\s*"podcast_refresh_feeds",\s*\{\s*feedId: selectedFeed\.id,\s*force: true,\s*\}\s*\)/g,
    "await podcastApi.refreshPodcastFeeds({ feedId: selectedFeed.id, force: true })",
  ],
  [
    /await invoke<PodcastEpisode\[\]>\(\s*"podcast_list_related_episodes",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.listRelatedEpisodes(episodeId, 6)",
  ],
  [
    /await invoke<PodcastChapterDocument>\(\s*"podcast_get_episode_chapters",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.getEpisodeChapters(episodeId)",
  ],
  [
    /await invoke<PodcastEpisodeDetail>\(\s*"podcast_get_episode_detail",\s*\{\s*episodeId,\s*\}\s*\)/g,
    "await podcastApi.getEpisodeDetail(episodeId)",
  ],
  [
    /await invoke<PodcastEpisodeDetail>\(\s*"podcast_get_episode_detail",\s*\{\s*episodeId: nextEpisodes\[0\]\.id,\s*\}\s*\)/g,
    "await podcastApi.getEpisodeDetail(nextEpisodes[0].id)",
  ],
  [
    /await invoke<PodcastEpisodeDetail>\(\s*"podcast_get_episode_detail",\s*\{\s*episodeId: episode\.id,\s*\}\s*\)/g,
    "await podcastApi.getEpisodeDetail(episode.id)",
  ],
  [
    /await invoke<PodcastDownloadDeleteResult>\(\s*"podcast_delete_episode_downloads",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.deleteEpisodeDownloads(intent.episodeIds)",
  ],
  [
    /await invoke<PodcastDownloadDeleteResult>\(\s*"podcast_clear_completed_downloads"\s*\)/g,
    "await podcastApi.clearCompletedDownloads()",
  ],
  [
    /await invoke<PodcastSearchResult\[\]>\(\s*"podcast_search_apple",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.searchApplePodcasts(cleanQuery, 18)",
  ],
  [
    /await invoke<PodcastSubscribeResult>\(\s*"podcast_preview_feed",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.previewPodcastFeed(candidate.feedUrl)",
  ],
  [
    /await invoke<PodcastSubscribeResult>\(\s*"podcast_subscribe",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.subscribePodcastFeed(cleanUrl)",
  ],
  [
    /await invoke\(\s*"podcast_set_following",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.setFeedFollowing(selectedFeed.id, nextSubscribed)",
  ],
  [
    /await invoke<PodcastDownloadResult>\(\s*"podcast_download_episode",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.downloadPodcastEpisode(episode.id)",
  ],
  [
    /await invoke<PodcastEpisodeDetail>\(\s*"podcast_delete_episode_download",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.deleteEpisodeDownload(detail.episode.id)",
  ],
  [
    /await invoke<PodcastEpisodeDetail>\(\s*"podcast_set_episode_saved",\s*\{[\s\S]*?\}\s*\)/g,
    "await podcastApi.setEpisodeSaved(detail.episode.id, nextSaved)",
  ],
];

for (const [re, rep] of chunks) {
  const before = (s.match(re) || []).length;
  s = s.replace(re, rep);
  console.log(String(re).slice(0, 60), "matches", before);
}

writeFileSync("src/views/podcast/usePodcastViewModel.ts", s);
const lines = s.split("\n").filter((line) => line.includes("invoke"));
console.log("remaining invoke lines:", lines.length);
for (const line of lines) console.log(line.trim().slice(0, 140));
