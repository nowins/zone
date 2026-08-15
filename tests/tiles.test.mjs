import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const tileSource = readFileSync("src/components/tiles/Tile.tsx", "utf8");
const flipSource = readFileSync("src/components/tiles/FlipTile.tsx", "utf8");
const cycleSource = readFileSync("src/components/tiles/CycleTile.tsx", "utf8");
const iconicSource = readFileSync("src/components/tiles/IconicTile.tsx", "utf8");
const mosaicSource = readFileSync("src/components/tiles/MosaicTile.tsx", "utf8");
const indexSource = readFileSync("src/components/tiles/index.ts", "utf8");
const tilesCss = readFileSync("src/styles/tiles.css", "utf8");
const motionCss = readFileSync("src/styles/motion.css", "utf8");
const quickplayCss = readFileSync("src/styles/quickplay.css", "utf8");
const collectionCss = readFileSync("src/styles/collection.css", "utf8");
const stylesEntry = readFileSync("src/styles.css", "utf8");
const quickplaySource = readFileSync("src/views/QuickplayView.tsx", "utf8");
const tiltPressSource = readFileSync("src/utils/tiltPress.ts", "utf8");

test("tile system exports Flip/Cycle/Iconic and wires its stylesheet", () => {
  for (const name of ["Tile", "FlipTile", "CycleTile", "CycleFrames", "IconicTile"]) {
    assert.ok(
      new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\} from`).test(indexSource),
      `index must export ${name}`,
    );
  }
  assert.ok(stylesEntry.includes("tiles.css"));
});

test("two reveal variants: peek slides, flip card-flips, both scoped", () => {
  // Peek (wide tiles): back layer parks below and slides up to cover.
  assert.ok(/\.tile-flip-v-peek \.tile-face-back\s*\{[^}]*translateY\(var\(--tile-peek, 100%\)\)/s.test(tilesCss));
  assert.ok(flipSource.includes("--tile-peek"));
  // Flip (square tiles): 3D card flip machinery, scoped to the variant.
  assert.ok(/\.tile-flip-v-flip \.tile-face-back\s*\{[^}]*rotateX\(180deg\)/s.test(tilesCss));
  assert.ok(/\.tile-flip-v-flip \.tile-face\s*\{[^}]*backface-visibility:\s*hidden/s.test(tilesCss));
  assert.ok(flipSource.includes("--tile-flip"));
  // The base face carries no 3D culling — only the flip variant opts in.
  assert.ok(!/^\.tile-face\s*\{[^}]*backface-visibility/sm.test(tilesCss), "base face must not cull backfaces");
  // overflow on the base surface forces transform-style: flat and kills the
  // flip's 3D context (front face renders mirrored past 90°). Clipping for
  // the peek variant is scoped to it alone.
  assert.ok(!/^\.tile-flip-surface\s*\{[^}]*overflow/sm.test(tilesCss), "base surface must not clip (breaks preserve-3d)");
  assert.ok(/\.tile-flip-v-peek \.tile-flip-surface\s*\{[^}]*overflow:\s*hidden/s.test(tilesCss));
  // Reduced motion swaps both reveals for an in-place cross-fade. The single
  // reduced-motion block lives in motion.css per the motion-system contract.
  assert.ok(!tilesCss.includes("prefers-reduced-motion"), "tiles.css must not own a second reduced-motion block");
  const reducedBlock = motionCss.slice(motionCss.indexOf("prefers-reduced-motion"));
  assert.ok(reducedBlock.includes("transform: none"), "reduced motion must not slide or rotate");
  assert.ok(reducedBlock.includes("backface-visibility: visible"), "reduced motion must not cull faces");
  // The variant face rules above are two-class selectors; the reduced-motion
  // neutralizer must be scoped per variant or the peek face stays parked
  // below the tile and the flip face stays rotated 180deg — a mirrored live
  // card for the whole dwell.
  assert.ok(
    /\.tile-flip-v-peek \.tile-face-back,\s*\.tile-flip-v-flip \.tile-face-back\s*\{[^}]*transform:\s*none/s.test(reducedBlock),
    "reduced motion must unpark/derotate the back face per variant",
  );
  // Single perspective: the property lives on the variant host; the surface
  // transform must not repeat it (double projection exaggerates mid-flip).
  assert.ok(/\.tile-flip-v-flip\s*\{[^}]*perspective:\s*900px/s.test(tilesCss));
  assert.ok(!/\.tile-flip-v-flip \.tile-flip-surface\s*\{[^}]*perspective\(/s.test(tilesCss));
});

test("quickplay pins reveal with the flip variant, overridable per pin later", () => {
  // All pins whole-tile flip to their info back; the variant is an explicit
  // prop so a future per-pin setting can override it.
  assert.ok(quickplaySource.includes('variant="flip"'));
  assert.ok(flipSource.includes('variant = "peek"'));
  assert.ok(indexSource.includes("TileRevealVariant"));
});

test("peek state machine: dwell exists, direction state stays out of effect deps", () => {
  // Root-cause guards for the "flash and gone" regression:
  // the back layer must dwell visible before sliding away.
  assert.ok(flipSource.includes("PEEK_HOLD_MS"), "peek must hold the back layer visible");
  // Direction state lives in the effect closure; putting showBack in the deps
  // re-ran the effect mid-cycle and cleanup parked the back layer instantly.
  assert.ok(flipSource.includes("[paused, live, reducedMotion, variant]"));
  assert.ok(!flipSource.includes("showBack]"), "showBack must not be an effect dep");
  // Slides start from the layer's actual position, never snapping to a fixed
  // endpoint first.
  assert.ok(flipSource.includes("from: showingBack ? 1 : 0"));
  // Cleanup parks the back layer and clears the state so pausing (edit mode)
  // never leaves a stale visible back.
  assert.ok(flipSource.includes("setShowBack(false)"));
  // The animation handle is retained and cancelled on cleanup.
  assert.ok(flipSource.includes("animationRef.current?.cancel()"));
  assert.ok(flipSource.includes("animationRef.current = animateValue"));
  // schedule() must not fire after the effect is cancelled.
  assert.ok(/const schedule = \(\) => \{\s*if \(cancelled\) return;/.test(flipSource));
  // The mid-flip completion guard also respects cancellation.
  assert.ok(flipSource.includes("if (cancelled) return;"));
});

test("each variant uses its calibrated curve and duration", () => {
  // Peek: one continuous 600ms sweep on the MangoTile MetroSlideIn curve
  // (0.22, 0, 0.05, 1) — a gentle push off, then a long glide home.
  assert.ok(flipSource.includes("PEEK_MS = 600"));
  assert.ok(flipSource.includes("metroSlideIn"));
  assert.ok(flipSource.includes("cubicBezier(0.22, 0, 0.05, 1"));
  // Flip: two brisk physical half-sweeps across the apex (WP7 People-hub feel).
  assert.ok(flipSource.includes("FLIP_HALF_MS = 200"));
  assert.ok(flipSource.includes("easing: accelerate"));
  assert.ok(flipSource.includes("easing: decelerate"));
});

test("keyboard reorder stays reachable in edit mode", () => {
  // Tile must remain focusable: aria-disabled, never the disabled attribute.
  assert.ok(tileSource.includes('aria-disabled={disabled || undefined}'));
  assert.ok(!/disabled=\{disabled\}/.test(tileSource), "button must not use the disabled attribute");
  assert.ok(quickplaySource.includes("onKeyDown={(event) => handlePinKey(event, item.pin.id)}"));
  // In edit mode the pin renders as a div so the draggable article owns the
  // HTML5 drag - a nested <button> would swallow the drag start.
  assert.ok(quickplaySource.includes("asButton={!editingPins}"));
  assert.ok(flipSource.includes("asButton?: boolean"));
});

test("disabled tiles never activate", () => {
  // aria-disabled keeps focus for keyboard reorder; the click handler must
  // swallow activation so a disabled tile can never fire onPress.
  assert.ok(/function handleClick\(\) \{[^}]*if \(disabled\) return;\s*onPress\?\.\(\);/s.test(tileSource));
  assert.ok(tileSource.includes("onClick={handleClick}"));
});

test("tile sizes ship intrinsic Win8 defaults that yield to host sizing", () => {
  // Zero-specificity :where() defaults (medium 150px, wide 2x150 + one 10px
  // gutter) so any host class — quickplay's grid-driven pins — wins
  // regardless of stylesheet order.
  assert.ok(/:where\(\.tile-medium\)\s*\{[^}]*width:\s*150px[^}]*height:\s*150px/s.test(tilesCss));
  assert.ok(/:where\(\.tile-wide\)\s*\{[^}]*width:\s*310px[^}]*height:\s*150px/s.test(tilesCss));
});

test("entrance is a turnstile pivot from the bottom edge, staggered, flash-free", () => {
  // Edge-origin perspective rotation, not a plain translate.
  assert.ok(tilesCss.includes("transform-origin: 50% 100%"));
  assert.ok(/rotateX\(-\d+deg\)/.test(tilesCss));
  assert.ok(tilesCss.includes("--tile-stagger-delay"));
  // Class is applied in a layout effect (before paint) to avoid a first flash.
  assert.ok(quickplaySource.includes("useLayoutEffect"));
  assert.ok(quickplaySource.includes('classList.add("tiles-enter")'));
});

test("flat Metro baseline: no acrylic glass variant, sharp edges", () => {
  assert.ok(!tilesCss.includes("backdrop-filter"), "glass blur must be removed");
  assert.ok(!tilesCss.includes("tile-glass"), "glass variant must be removed");
  assert.ok(!quickplaySource.includes("glass"), "quickplay must not enable a glass prop");
});

test("tiles flip sparingly and only when there is live content to reveal", () => {
  // Slow, WP-like cadence (tens of seconds), not a constant blink.
  assert.ok(flipSource.includes("MIN_INTERVAL_MS = 45_000"));
  assert.ok(flipSource.includes("MAX_INTERVAL_MS = 110_000"));
  // A live gate: tiles with nothing to reveal never flip on their own.
  assert.ok(flipSource.includes("live?: boolean"));
  assert.ok(/if \(paused \|\| !live\) \{[\s\S]*?return undefined;/.test(flipSource));
  // Quickplay reveals a real glanceable line (recent-play/stats), not a static
  // "已固定" placeholder.
  assert.ok(quickplaySource.includes("liveLine"));
  assert.ok(quickplaySource.includes("tile-back-live"));
  assert.ok(!quickplaySource.includes("已固定"), "static placeholder must be gone");
  // The back face is opaque so the cover never bleeds through.
  assert.ok(/rgba\(16, 16, 18, 0\.97\)/.test(tilesCss));
});

test("cycle and iconic templates model WP8", () => {
  // Cycle caps at nine frames and cross-fades, jittered per instance.
  assert.ok(cycleSource.includes("MAX_CYCLE_IMAGES"));
  assert.ok(cycleSource.includes("Math.random()"));
  assert.ok(tilesCss.includes(".tile-cycle-frame.is-active"));
  // The static collage never comes back — multi-cover pins live elsewhere now.
  assert.ok(!quickplaySource.includes("quick-pin-collage"), "static collage must be replaced by cycle");
  assert.ok(!tilesCss.includes("quick-pin-collage"), "collage styles must be removed");
  assert.ok(!quickplayCss.includes("quick-pin-collage"), "collage styles must be removed");
  // Iconic renders icon, corner count, and label.
  assert.ok(iconicSource.includes("tile-iconic-count"));
  assert.ok(iconicSource.includes("tile-iconic-label"));
  assert.ok(tilesCss.includes(".tile-iconic-icon"));
});

test("cycle layering: active frame on top, conveyor drift, no stuck delays", () => {
  // Root-cause guards for the "one row, stuck, then fills" regression:
  // the active frame must paint above any outgoing frame (wrap-around safe).
  assert.ok(/\.tile-cycle-frame\.is-active\s*\{[^}]*z-index:\s*1/s.test(tilesCss));
  // Outgoing frames drift upward (same direction as incoming) via is-leaving.
  assert.ok(cycleSource.includes("is-leaving"));
  assert.ok(tilesCss.includes(".tile-cycle-frame.is-leaving"));
  assert.ok(tilesCss.includes("calc(var(--motion-drift-s) * -1)"));
  // No hardcoded holdover delay may split opacity from transform again.
  assert.ok(!tilesCss.includes("1600ms"), "hardcoded 1600ms delay must be gone");
  assert.ok(!/\.tile-cycle-frame[^{]*\{[^}]*transition-delay/s.test(tilesCss), "cycle frames must not use transition-delay");
  // Reduced motion collapses the conveyor to a quick in-place fade owned by
  // the motion.css media query — no dead JS data-attribute mechanism.
  const reducedBlock = motionCss.slice(motionCss.indexOf("prefers-reduced-motion"));
  assert.ok(/\.tile-cycle-frame[^{]*\{[^}]*transition:\s*opacity var\(--motion-micro\)/s.test(reducedBlock));
  assert.ok(!cycleSource.includes("data-reduced"), "data-reduced attribute must be gone");
});

test("wide multi-cover pins use the People-hub mosaic, never cropped strips", () => {
  assert.ok(quickplaySource.includes("MosaicFrames"));
  assert.ok(tilesCss.includes(".tile-mosaic-cell"));
  // The cropped hero/strip collection layout is gone.
  assert.ok(!quickplaySource.includes("tile-collection"), "image-collection must be replaced by mosaic");
  assert.ok(!tilesCss.includes("tile-collection"), "image-collection styles must be removed");
  // Cells flip individually on a jittered cadence.
  assert.ok(mosaicSource.includes("MIN_CELL_FLIP_MS"));
  assert.ok(mosaicSource.includes("Math.random()"));
  assert.ok(mosaicSource.includes("--cell-flip"));
  // Card-swap rotates edge-on, swaps, then returns from the opposite edge.
  assert.ok(mosaicSource.includes("to: -90"));
  assert.ok(mosaicSource.includes("from: 90"));
  // Cleanup must reset the driven angle, not just cancel the animation —
  // a rescan or reduced-motion toggle mid-flip would otherwise park a cell
  // edge-on at +/-90 degrees.
  assert.ok(mosaicSource.includes('"--cell-flip", "0deg"'), "cleanup must reset --cell-flip to 0deg");
});

test("mosaic layout tiers by pool size and never duplicates a cover", () => {
  // Layout capacity matches the pool so empty transparent slots never show.
  // 2 pair, 3 trio, 4 quad, 5 feature, 6/7 3x2, 8+ 4x2.
  assert.ok(mosaicSource.includes('"pair"'));
  assert.ok(mosaicSource.includes('"trio"'));
  assert.ok(mosaicSource.includes('"quad"'));
  assert.ok(mosaicSource.includes('"feature"'));
  assert.ok(mosaicSource.includes('"grid-3"'));
  assert.ok(mosaicSource.includes('"grid"'));
  assert.ok(tilesCss.includes(".tile-mosaic.layout-pair"));
  assert.ok(tilesCss.includes(".tile-mosaic.layout-trio"));
  assert.ok(tilesCss.includes(".tile-mosaic.layout-quad"));
  assert.ok(tilesCss.includes(".tile-mosaic.layout-feature"));
  assert.ok(tilesCss.includes(".tile-mosaic.layout-grid-3"));
  assert.ok(tilesCss.includes(".tile-mosaic.layout-grid"));
  assert.ok(/\.tile-mosaic\.layout-grid\s*\{[^}]*repeat\(4/s.test(tilesCss));
  // Uniqueness invariant: only swap in an unshown cover. Never force a
  // paired exchange of two cells (that read as the whole tile flashing).
  assert.ok(mosaicSource.includes("unused"), "must track unshown covers");
  assert.ok(!/\[a, current\[b\]\],\s*\[b, current\[a\]\]/s.test(mosaicSource), "must not exchange two cells as a pair");
  assert.ok(mosaicSource.includes("images.length <= cellCount"), "must rest when every cover is already shown");
  // Cadence is sparse, not screensaver-fast.
  assert.ok(mosaicSource.includes("8_000") || mosaicSource.includes("8000"), "min flip interval should be multi-second");
  // Empty cells / initials placeholders stay gone — capacity matches pool.
  assert.ok(!mosaicSource.includes("placeholder"), "initials placeholders must be gone");
  // will-change is JS-managed for the flip's duration, not a permanent layer
  // tax on every cell.
  assert.ok(!/\.tile-mosaic-cell-inner\s*\{[^}]*will-change\s*:/s.test(tilesCss));
  assert.ok(mosaicSource.includes('willChange = "transform"'));
});

test("tilt press matches the Lumia-calibrated Metro touch response", () => {
  // MangoTile metroTilt: 10 degrees toward the finger, 0.94 scale, tight
  // perspective. Subtler values read as no feedback at all. One shared rule
  // in motion.css covers every tilt surface (tiles, pins, album/history covers).
  assert.ok(tiltPressSource.includes("TILT_DEGREES = 10"));
  assert.ok(motionCss.includes("scale(0.94)"));
  assert.ok(motionCss.includes("perspective(600px)"));
  assert.ok(
    /.tilt-pressed[^{]*\{[^}]*--tilt-rx/s.test(motionCss),
    "the shared tilt rule must consume the JS-driven tilt variables",
  );
  // The pre-unification geometry (900px / 0.97) must not drift back.
  const surfaces = tilesCss + quickplayCss + collectionCss;
  assert.ok(!/tilt-pressed[^{]*\{[^}]*perspective\(900px\)/s.test(surfaces));
  assert.ok(!/tilt-pressed[^{]*\{[^}]*scale\(0\.97\)/s.test(surfaces));
});
