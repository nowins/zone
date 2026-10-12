import assert from "node:assert/strict";
import test from "node:test";
import { NOW_PLAYING_MOTION } from "../.tmp/visualizer-tests/motion/tokens.js";
import { advanceArtistPhotoOpacity, advanceArtistPhotoScene, artistPhotoSceneBlend, artistPhotoTransform,
  createArtistPhotoScene, nowPlayingArtistIdentity, selectNowPlayingArtistPhotos, setArtistPhotoOpacityTarget,
} from "../.tmp/visualizer-tests/utils/nowPlayingArtist.js";

const track = (id, artist, paths = []) => ({ id, artist, album: id, path: `${id}.mp3`, title: id,
  artist_image_path: paths[0], artist_images: paths.slice(1).map(path => ({ path })) });

test("artist photographs use the album artist identity, deduplicate, stay bounded and survive same-artist skips", () => {
  const first = { ...track("first", "Guest", ["portrait-b", "portrait-a", "portrait-b"]), album_artist: " Artist " };
  const second = track("second", "ARTIST", ["portrait-c", "portrait-d", "portrait-e"]);
  const other = track("other", "Other", ["unrelated"]);
  assert.equal(nowPlayingArtistIdentity(first), "artist");
  assert.deepEqual(selectNowPlayingArtistPhotos([first, second, other], first), ["portrait-a", "portrait-b", "portrait-c", "portrait-d"]);
  assert.deepEqual(selectNowPlayingArtistPhotos([first, second, other], first), selectNowPlayingArtistPhotos([first, second, other], second));
  assert.deepEqual(selectNowPlayingArtistPhotos([first], null), []);
});

test("only two ready photos can leave the three-second grid stage", () => {
  const scene = createArtistPhotoScene();
  scene.paths = ["first"];
  advanceArtistPhotoScene(scene, 10_000, true, false);
  assert.equal(scene.current, null);
  scene.paths.push("second");
  advanceArtistPhotoScene(scene, 0, true, false);
  assert.equal(scene.current, "first");
  const delayed = createArtistPhotoScene();
  delayed.paths = ["first", "second"];
  advanceArtistPhotoScene(delayed, NOW_PLAYING_MOTION.artistGridDelay - 1, true, false);
  assert.equal(delayed.current, null);
  advanceArtistPhotoScene(delayed, 1, true, false);
  assert.equal(delayed.current, "first");
});

test("32-second scenes alternate photos and motion while a two-second dissolve completes on pause", () => {
  const scene = createArtistPhotoScene();
  scene.paths = ["first", "second"];
  advanceArtistPhotoScene(scene, NOW_PLAYING_MOTION.artistGridDelay, true, false);
  advanceArtistPhotoScene(scene, NOW_PLAYING_MOTION.artistScene, true, false);
  assert.equal(scene.current, "second");
  assert.equal(scene.previous, "first");
  assert.equal(scene.motion, "zoom");
  assert.equal(artistPhotoSceneBlend(scene), 0);
  advanceArtistPhotoScene(scene, 1000, false, false);
  assert.equal(scene.elapsedMs, 0, "pause freezes scene movement");
  assert.equal(artistPhotoSceneBlend(scene), 0.5);
  advanceArtistPhotoScene(scene, 1000, false, false);
  assert.equal(scene.previous, null);
  advanceArtistPhotoScene(scene, NOW_PLAYING_MOTION.artistScene, true, false);
  assert.equal(scene.current, "first");
  assert.equal(scene.motion, "slide");
  advanceArtistPhotoScene(scene, 0, true, true);
  assert.equal(scene.previous, null, "reduced motion finishes the pending dissolve immediately");
  assert.equal(scene.elapsedMs, 0);
});

test("linear photo travel keeps window edges covered and zoom reaches the recovered 1.2 scale", () => {
  for (const width of [920, 1180, 3840]) {
    const start = artistPhotoTransform("slide", 0, width);
    const middle = artistPhotoTransform("slide", NOW_PLAYING_MOTION.artistScene / 2, width);
    const end = artistPhotoTransform("slide", NOW_PLAYING_MOTION.artistScene, width);
    assert.equal(start.offsetX, -end.offsetX);
    assert.equal(middle.offsetX, 0);
    assert.ok((width - width * start.scale) / 2 + start.offsetX <= 0.000001);
    assert.ok((width - width * end.scale) / 2 + end.offsetX + width * end.scale >= width - 0.000001);
  }
  assert.equal(artistPhotoTransform("zoom", 0, 1180).scale, 1);
  assert.equal(artistPhotoTransform("zoom", NOW_PLAYING_MOTION.artistScene, 1180).scale, 1.2);
});

test("interrupted opacity reverses from the visible value and reduced motion settles without waiting", () => {
  const opacity = { value: 0, from: 0, target: 0, elapsedMs: 0 };
  setArtistPhotoOpacityTarget(opacity, 1);
  advanceArtistPhotoOpacity(opacity, 1000, false);
  assert.equal(opacity.value, 0.5);
  setArtistPhotoOpacityTarget(opacity, 0);
  advanceArtistPhotoOpacity(opacity, 0, false);
  assert.equal(opacity.value, 0.5);
  advanceArtistPhotoOpacity(opacity, 1000, false);
  assert.equal(opacity.value, 0.25);
  advanceArtistPhotoOpacity(opacity, 0, true);
  assert.equal(opacity.value, 0);
});
