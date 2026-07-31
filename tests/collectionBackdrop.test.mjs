import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildCollectionBackdropLayout,
  buildCollectionBackdropScene,
  collectionParallaxOffset,
} from "../.tmp/visualizer-tests/utils/collectionBackdrop.js";

function track(id, artist, album, coverPath, overrides = {}) {
  return {
    id,
    path: `D:\\Music\\${id}.flac`,
    file_name: `${id}.flac`,
    title: id,
    artist,
    album,
    duration_seconds: 180,
    extension: "flac",
    cover_path: coverPath,
    ...overrides,
  };
}

test("collection backdrop prefers artist art, the active cover, and related albums", () => {
  const active = track("active", "王菲", "寓言", "D:\\covers\\active.jpg");
  const scene = buildCollectionBackdropScene({
    tracks: [
      track("other-b", "王菲", "执迷不悔", "D:\\covers\\b.jpg"),
      active,
      track("unrelated", "许巍", "时光", "D:\\covers\\other.jpg"),
      track("other-a", " 王菲 ", "天空", "D:\\covers\\a.jpg"),
      track("duplicate", "王菲", "寓言", "D:\\covers\\active.jpg"),
    ],
    activeTrack: active,
    artistImagePath: "D:\\artists\\faye.jpg",
  });

  assert.ok(scene);
  assert.deepEqual(scene.assets.map((asset) => asset.role), [
    "artist",
    "active-album",
    "related-album",
    "related-album",
  ]);
  assert.equal(scene.assets[0].path, "D:\\artists\\faye.jpg");
  assert.equal(scene.assets[1].path, "D:\\covers\\active.jpg");
  assert.ok(scene.assets.every((asset) => asset.path !== "D:\\covers\\other.jpg"));
  assert.equal(new Set(scene.assets.map((asset) => asset.path)).size, scene.assets.length);
});

test("collection backdrop follows album artist aliases and reuses an artist image from related tracks", () => {
  const active = track("duet", "王菲 / 窦唯", "合唱", "D:\\covers\\duet.jpg", {
    album_artist: "王菲",
  });
  const related = track("solo", "王菲", "天空", "D:\\covers\\sky.jpg", {
    artist_image_path: "D:\\artists\\faye.jpg",
  });
  const scene = buildCollectionBackdropScene({ tracks: [active, related], activeTrack: active });

  assert.ok(scene);
  assert.deepEqual(scene.assets.map((asset) => asset.path), [
    "D:\\artists\\faye.jpg",
    "D:\\covers\\duet.jpg",
    "D:\\covers\\sky.jpg",
  ]);
});

test("collection backdrop keeps an artist layout stable while the active album changes", () => {
  const first = track("first", "王菲", "寓言", "D:\\covers\\first.jpg");
  const second = track("second", "王菲", "天空", "D:\\covers\\second.jpg");
  const tracks = [first, second];
  const firstScene = buildCollectionBackdropScene({ tracks, activeTrack: first });
  const secondScene = buildCollectionBackdropScene({ tracks, activeTrack: second });

  assert.ok(firstScene);
  assert.ok(secondScene);
  assert.equal(firstScene.sceneKey, secondScene.sceneKey);
  assert.equal(firstScene.seed, secondScene.seed);
  assert.notEqual(firstScene.assetKey, secondScene.assetKey);
  assert.equal(firstScene.assets[0].path, "D:\\covers\\first.jpg");
  assert.equal(secondScene.assets[0].path, "D:\\covers\\second.jpg");
});

test("collection backdrop does not restart its scene for another song on the same album", () => {
  const first = track("first", "王菲", "寓言", "D:\\covers\\album.jpg");
  const second = track("second", "王菲", "寓言", "D:\\covers\\album.jpg");
  const tracks = [first, second];
  const firstScene = buildCollectionBackdropScene({ tracks, activeTrack: first });
  const secondScene = buildCollectionBackdropScene({ tracks, activeTrack: second });

  assert.ok(firstScene);
  assert.ok(secondScene);
  assert.equal(firstScene.sceneKey, secondScene.sceneKey);
  assert.equal(firstScene.assetKey, secondScene.assetKey);
});

test("collection backdrop limits assets and falls back cleanly", () => {
  const active = track("active", "Artist", "Album 0", "D:\\covers\\0.jpg");
  const tracks = [
    active,
    ...Array.from({ length: 10 }, (_, index) => (
      track(`track-${index}`, "Artist", `Album ${index + 1}`, `D:\\covers\\${index + 1}.jpg`)
    )),
  ];

  const scene = buildCollectionBackdropScene({
    tracks,
    activeTrack: active,
    artistImagePath: "D:\\artists\\artist.jpg",
  });
  assert.ok(scene);
  assert.equal(scene.assets.length, 6);
  assert.equal(buildCollectionBackdropScene({ tracks, activeTrack: null }), null);
  assert.equal(buildCollectionBackdropScene({
    tracks: [track("empty", "Artist", "Album", null)],
    activeTrack: track("empty", "Artist", "Album", null),
  }), null);
});

test("collection backdrop layout is deterministic and safe for every asset count", () => {
  const assets = [
    { key: "artist", path: "artist.jpg", role: "artist", label: "Artist" },
    { key: "active", path: "active.jpg", role: "active-album", label: "Active" },
    { key: "related", path: "related.jpg", role: "related-album", label: "Related" },
  ];
  const first = buildCollectionBackdropLayout(1400, 900, assets, 42);
  const second = buildCollectionBackdropLayout(1400, 900, assets, 42);

  assert.deepEqual(first, second);
  assert.ok(first.length >= 15);
  assert.ok(first.every((placement) => placement.assetIndex >= 0 && placement.assetIndex < assets.length));
  assert.ok(first.some((placement) => placement.x < 0 || placement.y < 0));
  assert.ok(first.every((placement) => placement.opacity <= 0.4));
  assert.deepEqual(buildCollectionBackdropLayout(1400, 900, [], 42), []);
});

test("collection backdrop forms a continuous scene and varies a single image crop", () => {
  const asset = [{ key: "active", path: "active.jpg", role: "active-album", label: "Active" }];
  const initial = buildCollectionBackdropLayout(1400, 900, asset, 42, 0);
  const scrolled = buildCollectionBackdropLayout(1400, 900, asset, 42, -300);

  assert.ok(initial.length >= 15);
  assert.ok(scrolled.length >= 15);
  assert.ok(new Set(initial.map((placement) => `${placement.cropX}:${placement.cropY}`)).size > 3);
  assert.notDeepEqual(
    initial.map((placement) => placement.y),
    scrolled.map((placement) => placement.y),
  );
});

test("collection parallax stays slower than content and respects reduced motion", () => {
  assert.equal(collectionParallaxOffset(100), -15);
  assert.equal(collectionParallaxOffset(10_000), -1_500);
  assert.equal(collectionParallaxOffset(-100), 0);
  assert.equal(collectionParallaxOffset(10_000, true), 0);
});

test("collection backdrop is a decorative canvas below collection content", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const componentSource = readFileSync(
    new URL("../src/components/CollectionArtworkBackdrop.tsx", import.meta.url),
    "utf8",
  );
  const collectionCss = readFileSync(new URL("../src/styles/collection.css", import.meta.url), "utf8");
  const motionCss = readFileSync(new URL("../src/styles/motion.css", import.meta.url), "utf8");

  assert.match(appSource, /<CollectionArtworkBackdrop[\s\S]+activePodcastEpisode \? null : activeTrack/);
  assert.ok(
    appSource.indexOf("<CollectionArtworkBackdrop") < appSource.indexOf('className="collection-ghost"'),
    "artwork should be mounted behind the collection ghost and content",
  );
  assert.match(componentSource, /<canvas[\s\S]+className="collection-artwork-canvas"/);
  assert.match(componentSource, /aria-hidden="true"/);
  assert.match(componentSource, /addEventListener\("scroll"[\s\S]+capture: true/);
  assert.match(componentSource, /requestAnimationFrame[\s\S]+redrawBackdropCanvases/);
  assert.match(componentSource, /ResizeObserver/);
  assert.match(componentSource, /IMAGE_CACHE_LIMIT = 32/);
  assert.match(collectionCss, /\.collection-artwork-backdrop\s*\{[\s\S]+position: absolute/);
  assert.match(collectionCss, /\.collection-artwork-backdrop\s*\{[\s\S]+pointer-events: none/);
  assert.match(collectionCss, /\.collection-band > :not\(\.collection-ghost, \.collection-artwork-backdrop\)/);
  assert.match(motionCss, /\.collection-artwork-backdrop/);
});
