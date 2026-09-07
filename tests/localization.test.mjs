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
const artistSource = readFileSync("src/views/ArtistBrowser.tsx", "utf8");
const librarySource = readFileSync("src/views/LibraryView.tsx", "utf8");
const nowPlayingSource = readFileSync("src/views/NowPlayingView.tsx", "utf8");
const settingsSource = readFileSync("src/views/SettingsView.tsx", "utf8");
const playlistSource = readFileSync("src/views/PlaylistBrowser.tsx", "utf8");
const podcastSource = [
  "src/views/PodcastView.tsx",
  "src/views/podcast/usePodcastViewModel.ts",
  "src/views/podcast/api.ts",
  "src/views/podcast/screens/ListenScreen.tsx",
  "src/views/podcast/screens/DiscoverScreen.tsx",
  "src/views/podcast/screens/LibraryScreen.tsx",
  "src/views/podcast/screens/PlaylistScreen.tsx",
  "src/views/podcast/screens/ShowScreen.tsx",
  "src/views/podcast/screens/EpisodeScreen.tsx",
  "src/views/podcast/types.ts",
  "src/views/podcast/constants.ts",
  "src/views/podcast/cache.ts",
  "src/views/podcast/episodeModel.ts",
  "src/views/podcast/preferences.ts",
  "src/views/podcast/format.ts",
  "src/views/podcast/components/primitives.tsx",
  "src/views/podcast/components/EpisodeRows.tsx",
  "src/views/podcast/components/QueueEpisodeRow.tsx",
  "src/views/podcast/components/EpisodeDetail.tsx",
  "src/views/podcast/components/ContinueCard.tsx",
  "src/views/podcast/components/ShowCards.tsx",
  "src/views/podcast/components/Dialogs.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const podcastNowPlayingSource = readFileSync("src/views/PodcastNowPlayingView.tsx", "utf8");
const emptySource = readFileSync("src/components/EmptyState.tsx", "utf8");
const playerBarSource = readFileSync("src/components/PlayerBar.tsx", "utf8");
const podcastPlayerBarSource = readFileSync("src/components/PodcastPlayerBar.tsx", "utf8");
const titlebarSource = readFileSync("src/components/Titlebar.tsx", "utf8");
const pinBoardSource = readFileSync("src/components/tiles/QuickplayPinBoard.tsx", "utf8");

test("tile editing and appearance use Chinese functional labels", () => {
  for (const label of ["固定", "完成", "编辑", "外观", "取消固定", "磁贴外观", "尺寸", "背景", "动态内容", "保存", "取消"]) {
    assert.ok(pinBoardSource.includes(label), `tile action must remain localized: ${label}`);
  }
  assert.ok(pinBoardSource.includes('small: "小", medium: "中", wide: "宽", large: "大"'));
});

test("collection totals are shown once and use Chinese units", () => {
  assert.ok(!artistSource.includes("<p>{artists.length}"));
  assert.ok(artistSource.includes("{artistAlbums.length} 张专辑"));
  assert.ok(artistSource.includes("{visibleSongs.length} 首歌曲"));
  assert.ok(!settingsSource.includes("settings-summary"));
  assert.equal(occurrences(playlistSource, "{selected.tracks.length} 首歌曲"), 1);
  assert.ok(playlistSource.includes('"收藏的歌曲"'));
  assert.ok(playlistSource.includes('"自定义播放列表"'));
  assert.ok(playlistSource.includes('name: "正在播放"'));
  assert.ok(!playlistSource.includes('name: "now playing"'));
});

test("functional UI copy does not fall back to English", () => {
  const source = [
    appSource,
    artistSource,
    librarySource,
    nowPlayingSource,
    podcastSource,
    podcastNowPlayingSource,
    emptySource,
    playerBarSource,
    podcastPlayerBarSource,
    titlebarSource,
  ].join("\n");

  for (const englishCopy of [
    "artists</p>",
    "albums</p>",
    "songs</p>",
    "nothing playing",
    "choose a song",
    "save as playlist",
    "Save playlist",
    "add music folder",
    "no album selected",
    'title="Minimize"',
    'title="Maximize"',
    'title="Close"',
    "songs indexed",
    "Search podcasts",
    "Add RSS",
    "Download and play",
    "Back to podcasts",
    "Unknown author",
    "No episodes",
  ]) {
    assert.ok(!source.includes(englishCopy), `unexpected English UI copy: ${englishCopy}`);
  }
});

function occurrences(source, value) {
  return source.split(value).length - 1;
}
