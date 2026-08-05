import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSmartDjSession,
  buildSmartDjQueue,
  createSmartDjSession,
  noteSmartDjSkip,
  rankSmartDjCandidates,
  seedFromTracks,
  syncSmartDjSessionWithQueue,
} from "../.tmp/visualizer-tests/utils/smartDj.js";

function track(id, overrides = {}) {
  return {
    id,
    path: `/music/${id}.mp3`,
    file_name: `${id}.mp3`,
    title: overrides.title ?? id,
    artist: overrides.artist ?? "Artist",
    album: overrides.album ?? "Album",
    album_artist: overrides.artist ?? "Artist",
    genres: overrides.genres ?? ["Pop"],
    year: overrides.year ?? 2020,
    extension: "mp3",
    ...overrides,
  };
}

test("smart dj prefers same artist/album and avoids banned/played tracks", () => {
  const seedTrack = track("seed", { artist: "Aiko", album: "Dawn", genres: ["City Pop"] });
  const tracks = [
    seedTrack,
    track("same-artist", { artist: "Aiko", album: "Night", genres: ["City Pop"] }),
    track("same-album", { artist: "Other", album: "Dawn", genres: ["Jazz"] }),
    track("same-genre", { artist: "Miki", album: "Soft", genres: ["City Pop"] }),
    track("noise", { artist: "ZZ", album: "Far", genres: ["Metal"], year: 1990 }),
  ];
  const session = createSmartDjSession(seedFromTracks("track", seedTrack.id, seedTrack.title, [seedTrack]));
  const ranked = rankSmartDjCandidates(session, {
    tracks,
    activity: {},
    favoriteTrackIds: new Set(),
  }, new Set([seedTrack.id]));

  assert.equal(ranked[0].track.id, "same-artist");
  assert.ok(ranked.some((item) => item.track.id === "same-genre"));
  assert.ok(!ranked.some((item) => item.track.id === seedTrack.id));
});

test("buildSmartDjQueue starts from seed and fills a horizon", () => {
  const seedTrack = track("seed", { artist: "Aiko", album: "Dawn", genres: ["Pop"] });
  const tracks = [
    seedTrack,
    ...Array.from({ length: 20 }, (_, index) => track(`t${index}`, {
      artist: index % 2 === 0 ? "Aiko" : `Artist${index}`,
      album: index % 3 === 0 ? "Dawn" : `Album${index}`,
      genres: ["Pop"],
    })),
  ];
  const session = createSmartDjSession(
    seedFromTracks("track", seedTrack.id, seedTrack.title, [seedTrack]),
    { horizon: 8, maxPerArtist: 3, maxPerAlbum: 2 },
  );
  const queue = buildSmartDjQueue(session, {
    tracks,
    activity: {},
    favoriteTrackIds: new Set([seedTrack.id]),
  });
  assert.equal(queue[0].id, "seed");
  assert.ok(queue.length >= 6);
  assert.equal(new Set(queue.map((item) => item.id)).size, queue.length);
});

test("advanceSmartDjSession consumes played track and refills", () => {
  const seedTrack = track("seed", { artist: "Aiko", album: "Dawn" });
  const tracks = [
    seedTrack,
    track("next-1", { artist: "Aiko", album: "Dawn" }),
    track("next-2", { artist: "Aiko", album: "Other" }),
    track("next-3", { artist: "Miki", album: "Soft", genres: ["Pop"] }),
  ];
  let session = createSmartDjSession(
    seedFromTracks("track", seedTrack.id, seedTrack.title, [seedTrack]),
    { horizon: 3, maxPerArtist: 3, maxPerAlbum: 2 },
  );
  const context = { tracks, activity: {}, favoriteTrackIds: new Set() };
  const initial = buildSmartDjQueue(session, context);
  session = {
    ...session,
    queuedIds: initial.map((item) => item.id),
    status: "playing",
  };
  const advanced = advanceSmartDjSession(session, "seed", context);
  assert.ok(advanced.playedIds.includes("seed"));
  assert.ok(!advanced.queuedIds.includes("seed"));
  assert.ok(advanced.queuedIds.length >= 1);
});


test("skip ban removes track and refills upcoming recommendations", () => {
  const seedTrack = track("seed", { artist: "Aiko", album: "Dawn", genres: ["Pop"] });
  const tracks = [
    seedTrack,
    track("skip-me", { artist: "Aiko", album: "Dawn", genres: ["Pop"] }),
    track("keep-1", { artist: "Aiko", album: "Other", genres: ["Pop"] }),
    track("keep-2", { artist: "Miki", album: "Soft", genres: ["Pop"] }),
    track("keep-3", { artist: "Neko", album: "City", genres: ["Pop"] }),
  ];
  let session = createSmartDjSession(
    seedFromTracks("track", seedTrack.id, seedTrack.title, [seedTrack]),
    { horizon: 4, maxPerArtist: 3, maxPerAlbum: 2 },
  );
  const context = { tracks, activity: {}, favoriteTrackIds: new Set() };
  const queue = buildSmartDjQueue(session, context).map((item) => item.id);
  session = {
    ...session,
    queuedIds: queue,
    status: "playing",
  };
  const next = noteSmartDjSkip(session, "skip-me", context, { ban: true });
  assert.ok(next.bannedIds.includes("skip-me"));
  assert.ok(!next.queuedIds.includes("skip-me"));
  assert.ok(next.queuedIds.length >= 2);
});

test("syncSmartDjSessionWithQueue marks played prefix and keeps active track", () => {
  const seedTrack = track("seed", { artist: "Aiko", album: "Dawn" });
  const tracks = [
    seedTrack,
    track("a", { artist: "Aiko", album: "Dawn" }),
    track("b", { artist: "Aiko", album: "Night" }),
    track("c", { artist: "Miki", album: "Soft", genres: ["Pop"] }),
  ];
  let session = createSmartDjSession(
    seedFromTracks("track", seedTrack.id, seedTrack.title, [seedTrack]),
    { horizon: 4, maxPerArtist: 3, maxPerAlbum: 2 },
  );
  const context = { tracks, activity: {}, favoriteTrackIds: new Set() };
  const queue = buildSmartDjQueue(session, context).map((item) => item.id);
  session = { ...session, queuedIds: queue, status: "playing" };
  const synced = syncSmartDjSessionWithQueue(session, queue, queue[1] ?? queue[0], context);
  if (queue[0] && queue[1]) {
    assert.ok(synced.playedIds.includes(queue[0]));
    assert.ok(synced.queuedIds.includes(queue[1]));
  } else {
    assert.ok(synced.queuedIds.length >= 1);
  }
});
