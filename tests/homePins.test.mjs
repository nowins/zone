import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHomePinToggle,
  applyHomePinToggleForPin,
  homePinForPayload,
  homePinId,
  moveHomePin,
  normalizeHomePins,
  reconcileHomePins,
  shiftHomePin,
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
