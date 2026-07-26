import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const appSource = readFileSync("src/App.tsx", "utf8");
const appHeaderSource = readFileSync("src/components/AppHeader.tsx", "utf8");
const playerBarSource = readFileSync("src/components/PlayerBar.tsx", "utf8");
const podcastPlayerBarSource = readFileSync("src/components/PodcastProbePlayerBar.tsx", "utf8");
const podcastViewSource = readFileSync("src/views/PodcastProbeView.tsx", "utf8");
const nowPlayingSource = readFileSync("src/views/NowPlayingView.tsx", "utf8");
const typesSource = readFileSync("src/types.ts", "utf8");
const rustEntrySource = readFileSync("src-tauri/src/lib.rs", "utf8");

const frontendSources = sourceFiles("src", /\.(?:ts|tsx)$/);
const allFrontendSource = frontendSources.map(({ source }) => source).join("\n");
const invokeHandlerSource =
  /generate_handler!\s*\[([\s\S]*?)\]\s*\)/.exec(rustEntrySource)?.[1] ?? "";

const PODCAST_COMMANDS = [
  "podcast_search_apple",
  "podcast_subscribe",
  "podcast_list_feeds",
  "podcast_list_episodes",
  "podcast_download_episode",
  "podcast_save_progress",
];

test("podcast playback reuses the app's single audio element", () => {
  const audioOwners = frontendSources
    .filter(({ source }) => /<audio\b/.test(source))
    .map(({ path }) => path);

  assert.deepEqual(audioOwners, ["src/App.tsx"]);
  assert.equal(occurrences(appSource, /<audio\b/g), 1);
  assert.equal(occurrences(allFrontendSource, /\bnew\s+Audio\s*\(/g), 0);
  includes(appSource, /ref=\{audioRef\}/, "the shared audio element must keep audioRef");
  excludes(podcastViewSource, /<audio\b|\bnew\s+Audio\s*\(/, "PodcastProbeView must not own audio");
  excludes(podcastPlayerBarSource, /<audio\b|\bnew\s+Audio\s*\(/, "the podcast bar must not own audio");
});

test("podcasts are a peer page wired to the complete probe command chain", () => {
  includes(typesSource, /type AppPage\s*=[^;]*"podcasts"/, "AppPage must include podcasts");
  includes(appHeaderSource, /onNavigate\("podcasts"\)/, "the primary navigation must open podcasts");
  includes(appHeaderSource, />\s*播客\s*</, "the podcast navigation label must be Chinese");
  includes(appSource, /page\s*===\s*"podcasts"/, "App must render a podcasts page branch");
  includes(appSource, /<PodcastProbeView\b/, "App must mount PodcastProbeView");

  for (const command of PODCAST_COMMANDS) {
    assert.ok(
      hasInvoke(allFrontendSource, command),
      `frontend does not invoke ${command}`,
    );
    includes(
      invokeHandlerSource,
      new RegExp(`\\b${command}\\b`),
      `Tauri does not register ${command}`,
    );
  }
});

test("podcast episodes remain outside music queue, Track, now playing, and beat analysis", () => {
  const trackType = declaredTypeBody(typesSource, "Track");
  const playPodcastSource = declaredFunctionSource(appSource, "playPodcastEpisode");
  const moveSource = declaredFunctionSource(appSource, "move");
  const openNowPlayingSource = declaredFunctionSource(appSource, "openNowPlaying");

  excludes(trackType, /podcast|feedUrl|enclosureUrl|downloadState/i, "Track must stay music-only");
  excludes(
    podcastViewSource,
    /\bTrack\b|\b(?:setQueue|appendToQueue|onAddToQueue|queueIds)\b/,
    "PodcastProbeView must not use the music queue",
  );
  excludes(
    podcastPlayerBarSource,
    /\bTrack\b|\b(?:setQueue|appendToQueue|onAddToQueue|queueIds)\b/,
    "the podcast bar must not use Track or the music queue",
  );
  excludes(
    nowPlayingSource,
    /\bPodcast(?:Episode|Feed|Probe|Playback)?\b/,
    "the music NowPlayingView must stay podcast-free",
  );

  includes(
    playPodcastSource,
    /setActivePodcastEpisode\(\s*episode\s*\)/,
    "podcast playback must use its separate active state",
  );
  excludes(
    playPodcastSource,
    /\b(?:setQueue|setActiveTrackId|appendToQueue|preAnalyzeBeatGrid)\b/,
    "starting a podcast must not mutate the music queue or active track",
  );
  includes(
    moveSource,
    /if\s*\(\s*activePodcastEpisode\s*\)\s*return\b/,
    "music queue movement must stop while a podcast owns playback",
  );
  includes(
    openNowPlayingSource,
    /if\s*\(\s*activePodcastEpisode\s*(?:\|\||\))/,
    "music now playing must stay closed for podcast playback",
  );

  includes(
    appSource,
    /if\s*\(\s*activePlayback\.kind\s*===\s*"music"\s*\)[\s\S]{0,400}preAnalyzeBeatGrid\(\s*activePlayback\.track\s*\)/,
    "beat pre-analysis must stay behind the music playback branch",
  );
  excludes(
    appSource,
    /preAnalyzeBeatGrid\(\s*(?:(?:activePodcastEpisode|podcast|episode)\b|activePlayback(?!\.track))/i,
    "podcasts must not enter music beat pre-analysis",
  );

  includes(appSource, /activePodcastEpisode/, "App must keep separate podcast playback state");
  includes(appSource, /<PodcastProbePlayerBar\b/, "App must render the podcast-specific player bar");
  excludes(
    playerBarSource,
    /\bPodcast(?:Episode|Feed|Probe|Playback)?\b/,
    "the music PlayerBar must remain podcast-free",
  );
});

function sourceFiles(root, extensionPattern) {
  const entries = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      entries.push(...sourceFiles(absolutePath, extensionPattern));
    } else if (extensionPattern.test(entry.name)) {
      entries.push({
        path: relative(".", absolutePath).replaceAll("\\", "/"),
        source: readFileSync(absolutePath, "utf8"),
      });
    }
  }

  return entries;
}

function occurrences(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

function includes(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

function excludes(source, pattern, message) {
  assert.ok(!pattern.test(source), message);
}

function hasInvoke(source, command) {
  const commandPattern = new RegExp(
    String.raw`\binvoke(?:<[^;\n]+?>)?\(\s*["']${command}["']`,
  );
  return commandPattern.test(source);
}

function declaredTypeBody(source, name) {
  const declaration = new RegExp(
    String.raw`export\s+(?:interface|type)\s+${name}\b[^={]*[={]([\s\S]*?)\n}`,
  ).exec(source);
  assert.ok(declaration, `missing ${name} declaration`);
  return declaration[1];
}

function declaredFunctionSource(source, name) {
  const declaration = new RegExp(String.raw`\bfunction\s+${name}\s*\(`).exec(source);
  assert.ok(declaration, `missing ${name} function`);
  const tail = source.slice(declaration.index + declaration[0].length);
  const nextDeclaration = /\n {2}(?:async\s+)?function\s+\w/.exec(tail);
  return source.slice(
    declaration.index,
    nextDeclaration
      ? declaration.index + declaration[0].length + nextDeclaration.index
      : source.length,
  );
}
