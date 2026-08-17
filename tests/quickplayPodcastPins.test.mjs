import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const quickplaySource = readFileSync("src/views/QuickplayView.tsx", "utf8");
const playlistsHookSource = readFileSync("src/hooks/usePlaylists.ts", "utf8");
const appSource = readFileSync("src/App.tsx", "utf8");
const podcastViewSource = readFileSync("src/views/PodcastView.tsx", "utf8");
const viewModelSource = readFileSync("src/views/podcast/usePodcastViewModel.ts", "utf8");
const homePinsSource = readFileSync("src/utils/homePins.ts", "utf8");
const schemaSource = readFileSync("src-tauri/src/db/schema.rs", "utf8");

function includes(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

test("quickplay resolves pinned podcast feeds into proxied-artwork tiles", () => {
  includes(
    quickplaySource,
    /pin\.kind === "podcastFeed"[\s\S]{0,900}podcastArtworkSrc\(feed\.artworkUrl\)/,
    "podcast feed pins must resolve their feed and route artwork through the proxy",
  );
  includes(
    quickplaySource,
    /item\.podcastFeed[\s\S]{0,140}onOpenPodcastFeed\?\.\(item\.pin\.targetId\)/,
    "pressing a podcast pin must deep-link into the podcast page, not the music transport",
  );
  includes(
    quickplaySource,
    /variant=\{item\.podcastFeed \? "peek" : "flip"\}/,
    "podcast pins must reveal live info with the vertical peek, not the card flip",
  );
  includes(
    quickplaySource,
    /quick-pin-front-band[\s\S]{0,220}unplayedCount > 0/,
    "the podcast front band must carry more than the cover: title plus unplayed count or author",
  );
  includes(
    quickplaySource,
    /item\.podcastFeed\.latestEpisodeTitle \?\? item\.title/,
    "the peek back must headline the latest episode title",
  );
  includes(
    quickplaySource,
    /播客节目/,
    "the tile back must identify pinned shows as podcast programs",
  );
  includes(
    quickplaySource,
    /onTogglePodcastPin\?\.\(item\.pin\.targetId\)/,
    "edit mode must unpin podcast feeds through the podcast toggle path",
  );
});

test("podcast pins share the home pin pipeline without music payloads", () => {
  includes(
    homePinsSource,
    /"podcastFeed",\s*\]\);/,
    "podcastFeed must be a normalized home pin kind",
  );
  includes(
    homePinsSource,
    /pin\.kind === "podcastFeed"\) return true;/,
    "music library reconcile must not drop podcast pins it cannot resolve",
  );
  includes(
    playlistsHookSource,
    /applyHomePinToggleForPin\(homePins, \{\s*id: homePinId\("podcastFeed", feed\.id\),/,
    "the podcast pin toggle must work from the feed identity directly",
  );
  includes(
    schemaSource,
    /'podcastFeed'/,
    "the persisted home pins table must accept the podcastFeed kind",
  );
});

test("app loads every feed for pins and reconciles only after a successful load", () => {
  includes(
    appSource,
    /podcast_list_feeds", \{ includeUnsubscribed: true \}/,
    "pin resolution must include unsubscribed preview feeds",
  );
  includes(
    appSource,
    /podcastPinFeedsLoadedRef\.current\) return;[\s\S]{0,400}pin\.kind !== "podcastFeed"/,
    "a failed feed load must never strip pinned shows",
  );
  includes(
    appSource,
    /setPodcastFeedRequest\(\{ feedId, feed, nonce: Date\.now\(\) \}\);[\s\S]{0,80}requestNavigation\("podcasts"\)/,
    "pressing a pinned show must carry a feed request into the podcast page",
  );
});

test("the show screen owns pinning and the feed request deep-links back to it", () => {
  includes(
    podcastViewSource,
    /固定到 quickplay/,
    "the show screen must offer pinning to quickplay",
  );
  includes(
    podcastViewSource,
    /onTogglePodcastPin\(selectedFeed\)/,
    "the pin button must toggle the selected feed",
  );
  includes(
    viewModelSource,
    /feedRequest\.feed[\s\S]{0,300}openStoredFeed\(/,
    "the feed request must open the resolved show, falling back to the request snapshot",
  );
});
