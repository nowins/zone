import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const menuSource = readFileSync(
  "src/components/PodcastEpisodeContextMenu.tsx",
  "utf8",
);
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
const podcastViewSource = [
  "src/views/PodcastView.tsx",
  "src/views/podcast/usePodcastViewModel.ts",
  "src/views/podcast/api.ts",
  "src/views/podcast/screens/ListenScreen.tsx",
  "src/views/podcast/screens/DiscoverScreen.tsx",
  "src/views/podcast/screens/LibraryScreen.tsx",
  "src/views/podcast/screens/PlaylistScreen.tsx",
  "src/views/podcast/screens/ShowScreen.tsx",
  "src/views/podcast/screens/EpisodeScreen.tsx",
  "src/views/podcast/format.ts",
  "src/views/podcast/components/EpisodeRows.tsx",
  "src/views/podcast/components/QueueEpisodeRow.tsx",
  "src/views/podcast/components/ContinueCard.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const podcastCss = readFileSync("src/styles/podcasts.css", "utf8");

test("podcast episode actions use a dedicated accessible context menu", () => {
  assert.doesNotMatch(menuSource, /\bContextPayload\b|\bContextMenuState\b/);
  assert.match(menuSource, /type PodcastEpisodeMenuState/);
  assert.match(menuSource, /role="menu"/);
  assert.match(menuSource, /role="menuitem"/);
  assert.match(menuSource, /播客单集/);
  assert.match(menuSource, /加入待播/);
  assert.match(menuSource, /queueState === "active"[\s\S]*?正在播放/);
  assert.match(menuSource, /标记为已播放/);
  assert.match(menuSource, /标记为未播放/);
  assert.match(menuSource, /正在下载/);
  assert.match(menuSource, /已下载/);
  assert.match(menuSource, />分享</);
});

test("the episode menu is viewport-safe, keyboard navigable, and animated through presence", () => {
  assert.match(menuSource, /createPortal\(/);
  assert.match(menuSource, /usePresence\(/);
  assert.match(menuSource, /window\.innerWidth/);
  assert.match(menuSource, /window\.innerHeight/);
  assert.match(menuSource, /ArrowDown/);
  assert.match(menuSource, /ArrowUp/);
  assert.match(menuSource, /menu\.returnFocus\.focus\(\{ preventScroll: true \}\)/);
  assert.match(menuSource, /event\.key === "Tab"[\s\S]{0,120}event\.preventDefault\(\)/);
  assert.match(menuSource, /button\[role="menuitem"\]:not\(:disabled\)/);
  assert.match(
    podcastCss,
    /\.context-menu\.podcast-episode-context-menu\s*\{[\s\S]*?width:\s*264px/,
  );
  assert.match(
    podcastCss,
    /\.motion-exit \.podcast-episode-context-menu\s*\{[\s\S]*?pointer-events:\s*none/,
  );
});

test("listen and show episode rows expose the podcast shortcut menu without replacing primary actions", () => {
  assert.match(
    podcastViewSource,
    /function ContinueCard\([\s\S]*?onContextMenu=\{onContextMenu\}/,
  );
  assert.match(
    podcastViewSource,
    /function EpisodeRow\([\s\S]*?onContextMenu=\{onContextMenu\}/,
  );
  assert.match(
    podcastViewSource,
    /openEpisodeDetail\(episode, "listen"\)[\s\S]*?showEpisodeMenu\(event, episode\)/,
  );
  assert.match(
    podcastViewSource,
    /openEpisodeDetail\(episode, "show"\)[\s\S]*?showEpisodeMenu\(event, episode\)/,
  );
  assert.match(
    podcastViewSource,
    /function CurrentEpisodeRow\([\s\S]*?onContextMenu=\{onContextMenu\}/,
  );
  assert.match(
    podcastViewSource,
    /function QueueEpisodeRow\([\s\S]*?onContextMenu=\{onContextMenu\}/,
  );
  assert.match(podcastViewSource, /onQueueEpisode\(episode, false\)/);
  assert.match(
    podcastViewSource,
    /activeEpisodeId === episode\.id[\s\S]*?setNotice\("本集正在播放"\)/,
  );
  assert.match(podcastViewSource, /onSetEpisodePlayed\(episode\.id, nextPlayed\)/);
  assert.match(podcastViewSource, /downloadEpisode\(episode\)/);
});

test("sharing prefers Web Share and safely falls back from webpage to audio URL and clipboard", () => {
  assert.match(
    podcastViewSource,
    /\[episode\.webpageUrl, episode\.enclosureUrl\]/,
  );
  assert.match(podcastViewSource, /typeof navigator\.share === "function"/);
  assert.match(podcastViewSource, /navigator\.share\(shareData\)/);
  assert.match(podcastViewSource, /navigator\.clipboard\?\.writeText/);
  assert.match(podcastViewSource, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(podcastViewSource, /document\.execCommand\("copy"\)/);
  assert.match(podcastViewSource, /这集没有可分享的链接/);
  assert.match(podcastViewSource, /已复制单集链接/);
  assert.match(podcastViewSource, /无法分享这集，请稍后重试/);
});

test("episode shortcut mutations resolve fresh state and report queue persistence truthfully", () => {
  assert.match(
    podcastViewSource,
    /podcastApi\.downloadPodcastEpisode\([\s\S]{0,420}podcastApi\.getEpisodeDetail\([\s\S]{0,180}applyEpisodeUpdate\(nextDetail\.episode\)/,
  );
  assert.doesNotMatch(
    podcastViewSource,
    /\.\.\.episode,\s*downloadState:\s*"downloaded"/,
  );
  assert.match(
    podcastViewSource,
    /setEpisodeMenu\(\(current\) =>[\s\S]{0,220}episode:\s*nextEpisode/,
  );
  assert.match(
    podcastViewSource,
    /homeRequestRef\.current !== requestId/,
  );
  assert.match(
    appSource,
    /queuePodcastEpisode\([\s\S]*?return true;[\s\S]*?return false;/,
  );
  assert.match(
    podcastViewSource,
    /const added = await onQueueEpisode\(episode, false\)[\s\S]{0,120}if \(!added\)/,
  );
});
