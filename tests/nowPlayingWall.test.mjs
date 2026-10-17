import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNowPlayingWall,
  NOW_PLAYING_WALL_TILE_COUNT,
} from "../.tmp/visualizer-tests/utils/nowPlayingWall.js";

test("the wall bounds its artwork pool to twenty slots in a large library", () => {
  const tracks = Array.from({ length: 200 }, (_, index) => makeTrack(`${index}`, "Artist", `Album ${index}`, `${index}.jpg`));
  const wall = buildNowPlayingWall(tracks, tracks[199]);
  assert.equal(NOW_PLAYING_WALL_TILE_COUNT, 20);
  assert.equal(wall.length, 20);
  assert.equal(new Set(wall.map(album => album.key)).size, 20);
  assert.ok(wall.some(album => album.coverPath === "199.jpg"), "current album survives a large library");
});

test("the current album and queued albums take priority over library fillers", () => {
  const library = Array.from({ length: 40 }, (_, index) => makeTrack(`library-${index}`, "Library", `Library ${index}`, `library-${index}.jpg`));
  const active = makeTrack("active", "Active", "Current", "active.jpg");
  const queue = Array.from({ length: 19 }, (_, index) => makeTrack(`queue-${index}`, "Queue", `Queue ${index}`, `queue-${index}.jpg`));
  const wall = buildNowPlayingWall(library, active, queue);
  const paths = new Set(wall.map(album => album.coverPath));
  assert.equal(paths.size, 20);
  assert.ok(paths.has(active.cover_path));
  for (const item of queue) assert.ok(paths.has(item.cover_path));
  assert.ok(wall.every(album => !album.coverPath.startsWith("library-")));
});

test("only the queue's first twenty songs nominate albums and duplicates leave space for library art", () => {
  const library = Array.from({ length: 30 }, (_, index) => makeTrack(`library-${index}`, "Library", `Library ${index}`, `library-${index}.jpg`));
  const repeated = Array.from({ length: 20 }, (_, index) => makeTrack(`queue-${index}`, "Queue", "Repeated", "queue.jpg"));
  const outsideWindow = makeTrack("late", "Queue", "Outside", "outside.jpg");
  const wall = buildNowPlayingWall(library, repeated[0], [...repeated, outsideWindow]);
  assert.equal(wall.filter(album => album.coverPath === "queue.jpg").length, 1);
  assert.equal(new Set(wall.map(album => album.key)).size, 20);
  assert.ok(wall.some(album => album.coverPath.startsWith("library-")));
  assert.ok(wall.every(album => album.coverPath !== outsideWindow.cover_path));
});

test("small artwork pools repeat evenly and shuffle without changing on repeated calls", () => {
  const tracks = [
    makeTrack("1", "One", "First", "one.jpg"),
    makeTrack("2", "Two", "Second", "two.jpg"),
    makeTrack("3", "Three", "Third", "three.jpg"),
  ];
  const wall = buildNowPlayingWall(tracks, tracks[0], tracks);
  assert.deepEqual(wall, buildNowPlayingWall(tracks, tracks[0], tracks));
  const counts = tracks.map(track => wall.filter(album => album.coverPath === track.cover_path).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  assert.notDeepEqual(wall.map(album => album.coverPath), Array.from({ length: 20 }, (_, index) => tracks[index % 3].cover_path));
});

test("same-album song changes keep the cover pool order and canonical artwork", () => {
  const first = makeTrack("first", "Artist", "Album", "canonical.jpg");
  first.artist_image_path = "artist-one.jpg";
  const second = makeTrack("second", "Artist", "Album", "alternative.jpg");
  second.artist_image_path = "artist-two.jpg";
  const other = makeTrack("other", "Other", "Another", "other.jpg");
  const tracks = [first, second, other];
  const firstWall = buildNowPlayingWall(tracks, first, tracks);
  const secondWall = buildNowPlayingWall(tracks, second, tracks);
  assert.deepEqual(firstWall, secondWall);
  assert.ok(secondWall.some(album => album.coverPath === "canonical.jpg"));
  assert.ok(secondWall.every(album => album.coverPath !== "alternative.jpg"));
});

test("now playing wall falls back when no covers are available", () => {
  const wall = buildNowPlayingWall([makeTrack("1", "No Art", "Missing", null)], null);

  assert.equal(wall.length, NOW_PLAYING_WALL_TILE_COUNT);
  assert.ok(wall.every((album) => album.album === "Zone"));
});

function makeTrack(id, artist, album, coverPath) {
  return {
    id,
    path: `${id}.mp3`,
    file_name: `${id}.mp3`,
    title: `Track ${id}`,
    artist,
    album,
    extension: "mp3",
    cover_path: coverPath,
  };
}

test("an active song without cover art never inserts blank albums into a covered wall", () => {
  const missing = makeTrack("missing", "Artist", "No cover", null);
  const covered = makeTrack("covered", "Other", "Cover", "cover.jpg");
  const wall = buildNowPlayingWall([missing, covered], missing);
  assert.ok(wall.every(album => album.coverPath === "cover.jpg"));
});

test("missing and empty queue artwork never crowds out covered library albums", () => {
  const missing = makeTrack("missing", "Artist", "Missing", null);
  const empty = makeTrack("empty", "Artist", "Empty", "");
  const covered = makeTrack("covered", "Other", "Cover", "cover.jpg");
  const wall = buildNowPlayingWall([covered], missing, [missing, empty]);
  assert.ok(wall.every(album => album.coverPath === covered.cover_path));
});

test("an album can use a queued sibling's cover when its library song lacks art", () => {
  const missing = makeTrack("missing", "Artist", "Album", null);
  const sibling = makeTrack("sibling", "Artist", "Album", "sibling.jpg");
  const wall = buildNowPlayingWall([missing], missing, [sibling]);
  assert.ok(wall.every(album => album.coverPath === sibling.cover_path));
  assert.equal(new Set(wall.map(album => album.key)).size, 1);
});

test("now playing wall mixes in enriched artist photos for the active artist only", () => {
  const active = makeTrack("1", "蔡琴", "不悔", "buhui.jpg");
  active.artist_image_path = "D:\\art\\tsai.zone.jpg";
  active.artist_images = [
    { path: "D:\\art\\tsai.zone.jpg", providerId: "netease-music" },
    { path: "D:\\art\\tsai-2.zone.jpg", providerId: "netease-music" },
  ];
  const sameArtist = makeTrack("2", "蔡琴", "机遇", null);
  sameArtist.artist_image_path = "D:\\art\\tsai-3.zone.jpg";
  const other = makeTrack("3", "方大同", "橙月", "orange.jpg");
  other.artist_image_path = "D:\\art\\khalil.zone.jpg";

  const wall = buildNowPlayingWall([active, sameArtist, other], active);
  const paths = new Set(wall.map((album) => album.coverPath));
  assert.ok(paths.has("D:\\art\\tsai.zone.jpg"), "active track artist image should appear");
  assert.ok(paths.has("D:\\art\\tsai-2.zone.jpg"), "secondary artist image should appear");
  assert.ok(paths.has("D:\\art\\tsai-3.zone.jpg"), "same-artist track image should appear");
  assert.ok(!paths.has("D:\\art\\khalil.zone.jpg"), "other artists' photos stay out");

  const artistKeys = new Set(
    wall.filter((album) => album.key.startsWith("artist-image:")).map((album) => album.key),
  );
  assert.equal(artistKeys.size, 3, "duplicated artist image paths collapse into one entry");
});

test("artist photos are capped and keep the wall alive without any covers", () => {
  const active = makeTrack("1", "蔡琴", "不悔", null);
  active.artist_image_path = "D:\\art\\tsai-0.zone.jpg";
  active.artist_images = [1, 2, 3, 4, 5].map((n) => ({
    path: `D:\\art\\tsai-${n}.zone.jpg`,
    providerId: "netease-music",
  }));

  const wall = buildNowPlayingWall([active], active);
  assert.ok(wall.some((album) => album.coverPath === "D:\\art\\tsai-0.zone.jpg"));
  assert.ok(wall.every((album) => album.album !== "Zone"), "artist photos prevent the Zone fallback");
  const artistKeys = new Set(
    wall.filter((album) => album.key.startsWith("artist-image:")).map((album) => album.key),
  );
  assert.ok(artistKeys.size <= 4, `artist photos should be capped, got ${artistKeys.size}`);
});

test("artist photos reserve at most four bounded slots while keeping current and queue albums", () => {
  const active = makeTrack("active", "Artist", "Current", "active.jpg");
  active.artist_images = Array.from({ length: 8 }, (_, index) => ({ path: `artist-${index}.jpg`, providerId: "test" }));
  const queue = Array.from({ length: 20 }, (_, index) => makeTrack(`queue-${index}`, "Queue", `Queued ${index}`, `queue-${index}.jpg`));
  const wall = buildNowPlayingWall([], active, queue);
  assert.equal(wall.length, 20);
  assert.equal(wall.filter(album => album.key.startsWith("artist-image:")).length, 4);
  assert.ok(wall.some(album => album.coverPath === "active.jpg"));
  for (const item of queue.slice(0, 15)) assert.ok(wall.some(album => album.coverPath === item.cover_path));
  assert.ok(wall.every(album => album.coverPath !== "queue-15.jpg"));
});
