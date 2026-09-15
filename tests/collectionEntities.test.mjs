import assert from "node:assert/strict";
import test from "node:test";
import { buildCollectionIndex, artistReference, albumReference, resolveCollectionEntity, knownDuration, referenceForPayload, sameCollectionEntity } from "../.tmp/visualizer-tests/utils/collectionEntities.js";
import { initialCollectionHistory, pushCollectionLocation, travelCollectionHistory, emptyCollectionSurface } from "../.tmp/visualizer-tests/utils/collectionNavigation.js";
import { normalizePlaylists, reorderPlaylistTrack } from "../.tmp/visualizer-tests/utils/music.js";
const track = (id, fields = {}) => ({ id, path: id, file_name: `${id}.mp3`, extension: "mp3", title: id, album: "作品", artist: "AC/DC", ...fields });

test("context navigation suppresses the same resolved object across different anchors", () => {
  const index = buildCollectionIndex([track("a"), track("b"), track("c", { artist: "另一位" })]);
  const artist = artistReference(index.artistsByName.get("AC/DC"));
  assert.equal(sameCollectionEntity(index, artist, { ...artist, anchorTrackId: "b" }), true);
  assert.equal(sameCollectionEntity(index, artist, artistReference(index.artistsByName.get("另一位"))), false);
  const album = albumReference(index.albumByTrackId.get("a"));
  assert.equal(sameCollectionEntity(index, album, { ...album, anchorTrackId: "b" }), true);
  assert.equal(sameCollectionEntity(index, album, artist), false);
  assert.equal(sameCollectionEntity(index, artist, null), false);
  assert.equal(sameCollectionEntity(index, artist, { ...artist, anchorTrackId: "missing" }), false);
  assert.equal(sameCollectionEntity(index, { kind: "playlist", id: "p" }, { kind: "playlist", id: "p" }), true);
});

test("collection index preserves exact credits and separates album owners from performers", () => {
  const tracks = [track("a", { artist: "A/B", album_artist: "群星", disc_number: 2, track_number: 1, artist_image_path: "portrait-a" }),
    track("b", { artist: "AC/DC", album_artist: "群星", disc_number: 1, track_number: 2 }),
    track("c", { artist: "A B", album: "作品", disc_number: 1 }), track("d", { artist: "ACDC", album: "作品" })];
  const index = buildCollectionIndex(tracks);
  assert.equal(index.albums.length, 3);
  assert.deepEqual(index.albums.find(a => a.artist === "群星").tracks.map(t => t.id), ["b", "a"]);
  assert.equal(index.artistsByName.has("AC"), false);
  assert.equal(index.artistsByName.get("AC/DC").albums.length, 0);
  assert.equal(index.artistsByName.get("AC/DC").appearances.length, 1);
  assert.equal(index.artistsByName.get("群星").albums.length, 1);
  assert.equal(index.artistsByName.get("群星").imagePath, undefined);
  assert.equal(index.artistsByName.get("群星").performedTracks.length, 0);
  assert.equal(index.artistsByName.get("A/B").imagePath, "portrait-a");
});
test("entity anchors follow a metadata rename but never fall through after removal", () => {
  const tracks = [track("a"), track("b", { artist: "另一位", album: "作品" })];
  const index = buildCollectionIndex(tracks);
  const artist = artistReference(index.artistsByName.get("AC/DC"));
  const album = albumReference(index.albumByTrackId.get("a"));
  const renamed = buildCollectionIndex([track("a", { artist: "新名称", album: "新专辑名" }), tracks[1]]);
  assert.equal(resolveCollectionEntity(renamed, artist).artist.artist, "新名称");
  assert.equal(resolveCollectionEntity(renamed, album).album.album, "新专辑名");
  const removed = buildCollectionIndex([tracks[1]]);
  assert.equal(resolveCollectionEntity(removed, artist), null);
  assert.equal(resolveCollectionEntity(removed, album), null);
  assert.equal(referenceForPayload(index, { kind: "artist", title: "不存在", tracks: [tracks[0]] }), null);
});
test("adopted profile fields stay together and unknown durations stay unknown", () => {
  const index = buildCollectionIndex([track("b", { artist_biography: "来自另一份资料" }), track("a", { artist_image_path: "photo" })]);
  assert.equal(index.artists[0].imagePath, "photo");
  assert.equal(index.artists[0].biography, undefined);
  assert.equal(knownDuration([]), null);
  assert.equal(knownDuration([track("a", { duration_seconds: 60 }), track("b")]), null);
  assert.equal(knownDuration([track("a", { duration_seconds: 60 }), track("b", { duration_seconds: 90 })]), 150);
});
test("album groups adopt a shared description from any member track", () => {
  const index = buildCollectionIndex([track("a", { album: "专辑X", album_description: "专辑介绍" }), track("b")]);
  assert.equal(index.albums.find(album => album.album === "专辑X").biography, "专辑介绍");
  assert.equal(index.albums.find(album => album.album === "作品").biography, undefined);
});
test("history retains source state through cycles, deduplicates repeats and drops stale forward branches", () => {
  let history = initialCollectionHistory();
  const source = { focus: "row:b", scrolls: { songs: { top: 90, left: 0, anchor: "b", offset: -4 } }, selections: { songs: "b" } };
  const open = entity => { history = pushCollectionLocation(history, { ...history.entries[history.cursor], entity, surface: emptyCollectionSurface() }, source); };
  open({ kind: "track", id: "b" });
  const unchanged = history;
  open({ kind: "track", id: "b" });
  assert.equal(history, unchanged);
  open({ kind: "track", id: "a" }); open({ kind: "track", id: "b" });
  history = travelCollectionHistory(history, -1, emptyCollectionSurface());
  assert.equal(history.entries[history.cursor].entity.id, "a");
  history = travelCollectionHistory(history, -1, emptyCollectionSurface());
  assert.deepEqual(history.entries[history.cursor].surface, source);
  open({ kind: "track", id: "c" });
  assert.equal(history.cursor, history.entries.length - 1);
  assert.equal(travelCollectionHistory(history, 1, source), history);
});
test("manual reordering and favorite rename preserve IDs, other entries and smart rules", () => {
  const manual = { id: "manual", name: "通勤", kind: "manual", trackIds: ["a", "missing", "b", "c"] };
  const changed = reorderPlaylistTrack(manual, "c", "a");
  assert.deepEqual(changed.trackIds, ["c", "a", "missing", "b"]);
  assert.deepEqual(manual.trackIds, ["a", "missing", "b", "c"]);
  assert.equal(reorderPlaylistTrack(manual, "absent", "a"), manual);
  const smart = { id: "smart", kind: "smart", smart: { rules: [] } };
  assert.equal(reorderPlaylistTrack(smart, "a", "b"), smart);
  const lists = normalizePlaylists([{ id: "favorites", name: "收藏", trackIds: ["c", "a"] }, manual]);
  assert.equal(lists[0].name, "喜欢的歌曲");
  assert.deepEqual(lists[0].trackIds, ["c", "a"]);
  assert.deepEqual(lists[1].trackIds, manual.trackIds);
});
