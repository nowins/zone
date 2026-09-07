import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHomePinToggle,
  applyHomePinToggleForPin,
  customizeHomePin,
  defaultHomePinSize,
  homePinForPayload,
  homePinId,
  homePinSize,
  moveHomePin,
  nextHomePinSize,
  normalizeHomePins,
  reconcileHomePins,
  setHomePinSize,
  shiftHomePin,
  stepHomePinSize,
} from "../.tmp/visualizer-tests/utils/homePins.js";

function track(overrides = {}) {
  return {
    id: overrides.id ?? "track-1",
    path: overrides.path ?? "C:/Music/track.mp3",
    file_name: overrides.file_name ?? "track.mp3",
    title: overrides.title ?? "Track",
    artist: overrides.artist ?? "Artist",
    album: overrides.album ?? "Album",
    album_artist: overrides.album_artist ?? "Artist",
    extension: "mp3",
    ...overrides,
  };
}

test("context payloads become stable home pins while the live queue stays ephemeral", () => {
  const album = homePinForPayload({
    kind: "album",
    title: " Album ",
    subtitle: "ARTIST",
    tracks: [track()],
  }, 123);
  const queue = homePinForPayload({
    kind: "playlist",
    title: "正在播放",
    subtitle: "当前队列",
    tracks: [track()],
    playlistId: "now",
  }, 123);

  assert.equal(album?.id, homePinId("album", "album\u0000artist"));
  assert.equal(album?.createdAt, 123);
  assert.equal(queue, null);
});

test("artist pins keep the raw library artist name so whitespace tags round-trip", () => {
  const artistTrack = track({ artist: " Artist ", album_artist: " Artist " });
  const pin = homePinForPayload({
    kind: "artist",
    title: " Artist ",
    subtitle: "1 首歌曲",
    tracks: [artistTrack],
  }, 123);

  assert.equal(pin?.targetId, " Artist ");
  const reconciled = reconcileHomePins([pin], [artistTrack], []);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].targetId, " Artist ");
});

test("album pins keep the stable group key from the payload instead of display strings", () => {
  // Grouping collapses an empty album_artist to the bare album name, while the
  // display subtitle still shows a derived artist. The pin must follow the
  // explicit targetId, not the reverse-engineered title/subtitle key.
  const pinned = homePinForPayload({
    kind: "album",
    title: "Greatest Hits",
    subtitle: "Various Artists",
    tracks: [track({ album: "Greatest Hits", album_artist: "" })],
    targetId: "greatest hits",
  }, 456);

  assert.equal(pinned?.targetId, "greatest hits");
  assert.equal(pinned?.id, homePinId("album", "greatest hits"));

  const reconciled = reconcileHomePins([pinned], [
    track({ id: "t1", album: "Greatest Hits", album_artist: "" }),
  ], []);
  assert.equal(reconciled.length, 1);

});

test("restored home pins are validated, deduplicated and capped", () => {
  const input = Array.from({ length: 15 }, (_, index) => ({
    id: "legacy-id",
    kind: "track",
    targetId: `track-${index}`,
    createdAt: index,
  }));
  input.push(input[0], { kind: "unknown", targetId: "bad" });

  const pins = normalizeHomePins(input);
  assert.equal(pins.length, 12);
  assert.equal(pins[0].id, "track:track-0");
  assert.equal(new Set(pins.map((pin) => pin.id)).size, pins.length);
});

test("missing library entities and deleted playlists are removed from pins", () => {
  const libraryTrack = track();
  const pins = normalizeHomePins([
    { kind: "track", targetId: libraryTrack.id },
    { kind: "album", targetId: "album\u0000artist" },
    { kind: "artist", targetId: libraryTrack.artist },
    { kind: "playlist", targetId: "favorites" },
    { kind: "playlist", targetId: "deleted" },
  ]);
  const reconciled = reconcileHomePins(pins, [libraryTrack], [
    { id: "favorites", name: "收藏", description: "收藏的歌曲", trackIds: [] },
  ]);

  assert.deepEqual(reconciled.map((pin) => pin.kind), ["track", "album", "artist", "playlist"]);
});

test("pins can be reordered by drag target or keyboard shift", () => {
  const pins = normalizeHomePins([
    { kind: "track", targetId: "one" },
    { kind: "track", targetId: "two" },
    { kind: "track", targetId: "three" },
  ]);

  const moved = moveHomePin(pins, "track:three", "track:one");
  assert.deepEqual(moved.map((pin) => pin.targetId), ["three", "one", "two"]);
  assert.deepEqual(shiftHomePin(moved, "track:three", 1).map((pin) => pin.targetId), ["one", "three", "two"]);
});

test("drag drops insert before or after the target by drop half", () => {
  const pins = normalizeHomePins([
    { kind: "track", targetId: "one" },
    { kind: "track", targetId: "two" },
    { kind: "track", targetId: "three" },
    { kind: "track", targetId: "four" },
  ]);

  // Forward move, both insertion sides.
  assert.deepEqual(
    moveHomePin(pins, "track:one", "track:three", false).map((pin) => pin.targetId),
    ["two", "one", "three", "four"],
  );
  assert.deepEqual(
    moveHomePin(pins, "track:one", "track:three", true).map((pin) => pin.targetId),
    ["two", "three", "one", "four"],
  );
  // Backward move landing after the target.
  assert.deepEqual(
    moveHomePin(pins, "track:four", "track:one", true).map((pin) => pin.targetId),
    ["one", "four", "two", "three"],
  );
  // Default stays "before", preserving the pre-customization drop behavior.
  assert.deepEqual(
    moveHomePin(pins, "track:three", "track:one").map((pin) => pin.targetId),
    ["three", "one", "two", "four"],
  );
});

test("pin sizes default by kind, validate on normalize and persist explicitly", () => {
  // Defaults keep existing walls unchanged: artist/playlist wide, rest medium.
  assert.equal(defaultHomePinSize("artist"), "wide");
  assert.equal(defaultHomePinSize("playlist"), "wide");
  assert.equal(defaultHomePinSize("track"), "medium");
  assert.equal(defaultHomePinSize("album"), "medium");
  assert.equal(defaultHomePinSize("podcastFeed"), "medium");

  const pins = normalizeHomePins([
    { kind: "track", targetId: "a", size: "large" },
    { kind: "artist", targetId: "b", size: "huge" },
    { kind: "playlist", targetId: "c" },
  ]);
  assert.equal(pins[0].size, "large");
  assert.equal(homePinSize(pins[0]), "large");
  // Sizes off the ladder are dropped, not persisted.
  assert.equal(pins[1].size, undefined);
  assert.equal(homePinSize(pins[1]), "wide");
  assert.equal(homePinSize(pins[2]), "wide");

  const resized = setHomePinSize(pins, homePinId("playlist", "c"), "medium");
  assert.equal(resized[2].size, "medium");
  assert.equal(resized.length, pins.length);
  // Unknown ids and invalid sizes leave the array untouched.
  assert.equal(setHomePinSize(pins, "track:missing", "large"), pins);
  assert.equal(setHomePinSize(pins, "track:a", "huge"), pins);
});

test("resize cycles wrap for the edit button and clamp for keyboard steps", () => {
  assert.equal(nextHomePinSize("small"), "medium");
  assert.equal(stepHomePinSize("small", -1), "small");
  assert.equal(nextHomePinSize("medium"), "wide");
  assert.equal(nextHomePinSize("wide"), "large");
  assert.equal(nextHomePinSize("large"), "small");
  assert.equal(stepHomePinSize("medium", 1), "wide");
  assert.equal(stepHomePinSize("medium", -1), "small");
  assert.equal(stepHomePinSize("large", 1), "large");
  assert.equal(stepHomePinSize("large", -1), "wide");
});

test("small tiles and appearance preferences survive normalization, resizing and reordering", () => {
  const pins = normalizeHomePins([
    { kind: "track", targetId: "one", size: "small", live: false, tone: "teal" },
    { kind: "album", targetId: "two", size: "medium", live: "false", tone: "constructor" },
  ]);
  assert.equal(pins[0].size, "small");
  assert.equal(pins[0].live, false);
  assert.equal(pins[0].tone, "teal");
  assert.equal(pins[1].live, undefined);
  assert.equal(pins[1].tone, undefined);
  const customized = customizeHomePin(pins, "track:one", { tone: "purple", live: true });
  const moved = shiftHomePin(setHomePinSize(customized, "track:one", "wide"), "track:one", 1);
  assert.deepEqual(moved[1], { ...pins[0], tone: "purple", live: true, size: "wide" });
  assert.equal(pins[0].tone, "teal", "updates do not mutate the saved snapshot");
  assert.deepEqual(normalizeHomePins(JSON.parse(JSON.stringify(moved))), moved);
});

test("toggle pins/unpins against the latest array so rapid clicks never duplicate", () => {
  const payload = {
    kind: "track",
    title: "Track",
    subtitle: "Artist / Album",
    tracks: [track({ id: "one" })],
  };

  const first = applyHomePinToggle([], payload, 100);
  assert.equal(first.action, "pinned");
  assert.equal(first.pins.length, 1);

  // A second rapid toggle must see the pin the first click appended — pin
  // then unpin, never a duplicate second entry.
  const second = applyHomePinToggle(first.pins, payload, 101);
  assert.equal(second.action, "unpinned");
  assert.equal(second.pins.length, 0);

  const again = applyHomePinToggle(second.pins, payload, 102);
  assert.equal(again.action, "pinned");
  assert.equal(again.pins.length, 1);
  assert.equal(new Set(again.pins.map((pin) => pin.id)).size, again.pins.length);
});

test("toggle respects the pin cap and ignores unpinnable payloads", () => {
  const full = normalizeHomePins(
    Array.from({ length: 12 }, (_, index) => ({ kind: "track", targetId: `full-${index}` })),
  );
  const capped = applyHomePinToggle(full, {
    kind: "track",
    title: "Track",
    subtitle: "Artist / Album",
    tracks: [track({ id: "overflow" })],
  });
  assert.equal(capped.action, "capped");
  assert.equal(capped.pins.length, 12);

  const ignored = applyHomePinToggle([], {
    kind: "playlist",
    title: "正在播放",
    subtitle: "当前队列",
    tracks: [track()],
    playlistId: "now",
  });
  assert.equal(ignored.action, "ignored");
  assert.equal(ignored.pins.length, 0);
});

test("podcast feed pins normalize, toggle by identity and survive library reconcile", () => {
  const pins = normalizeHomePins([
    { kind: "podcastFeed", targetId: "feed-1", createdAt: 7 },
    { kind: "podcastFeed", targetId: "feed-1", createdAt: 8 },
  ]);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].id, homePinId("podcastFeed", "feed-1"));
  assert.equal(pins[0].createdAt, 7);

  const pinned = applyHomePinToggleForPin(pins, {
    id: homePinId("podcastFeed", "feed-2"),
    kind: "podcastFeed",
    targetId: "feed-2",
    createdAt: 9,
  });
  assert.equal(pinned.action, "pinned");
  assert.equal(pinned.pins.length, 2);

  const unpinned = applyHomePinToggleForPin(pinned.pins, {
    id: homePinId("podcastFeed", "feed-2"),
    kind: "podcastFeed",
    targetId: "feed-2",
    createdAt: 10,
  });
  assert.equal(unpinned.action, "unpinned");
  assert.equal(unpinned.pins.length, 1);

  // Music-side reconcile knows nothing about SQLite feeds; podcast pins must
  // pass through untouched instead of being dropped as unresolvable.
  const reconciled = reconcileHomePins(unpinned.pins, [], []);
  assert.deepEqual(reconciled.map((pin) => pin.id), [homePinId("podcastFeed", "feed-1")]);

  const full = normalizeHomePins([
    ...Array.from({ length: 11 }, (_, index) => ({
      kind: "track",
      targetId: "full-" + index,
    })),
    { kind: "podcastFeed", targetId: "feed-full" },
  ]);
  const capped = applyHomePinToggleForPin(full, {
    id: homePinId("podcastFeed", "feed-overflow"),
    kind: "podcastFeed",
    targetId: "feed-overflow",
    createdAt: 11,
  });
  assert.equal(capped.action, "capped");
  assert.equal(capped.pins.length, 12);
});
