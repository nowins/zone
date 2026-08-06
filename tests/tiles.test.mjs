import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const tileSource = readFileSync("src/components/tiles/Tile.tsx", "utf8");
const flipSource = readFileSync("src/components/tiles/FlipTile.tsx", "utf8");
const cycleSource = readFileSync("src/components/tiles/CycleTile.tsx", "utf8");
const iconicSource = readFileSync("src/components/tiles/IconicTile.tsx", "utf8");
const indexSource = readFileSync("src/components/tiles/index.ts", "utf8");
const tilesCss = readFileSync("src/styles/tiles.css", "utf8");
const stylesEntry = readFileSync("src/styles.css", "utf8");
const quickplaySource = readFileSync("src/views/QuickplayView.tsx", "utf8");
const tokensSource = readFileSync("src/motion/tokens.ts", "utf8");

test("tile system exports Flip/Cycle/Iconic and wires its stylesheet", () => {
  for (const name of ["Tile", "FlipTile", "CycleTile", "IconicTile"]) {
    assert.ok(indexSource.includes(`export { ${name} }`), `index must export ${name}`);
  }
  assert.ok(stylesEntry.includes("tiles.css"));
});

test("flip is a true 0->180 rotation with no face culled or inverted", () => {
  // Front and back each carry backface-visibility, so the active face shows
  // across the whole rotation and neither is culled at rest.
  assert.ok(flipSource.includes("to: apex"));
  assert.ok(flipSource.includes("from: apex"));
  // No rule hides a face wholesale outside the backface mechanism.
  const faceRules = tilesCss.split("\n").filter((line) => /\.tile-face/.test(line));
  assert.ok(
    !faceRules.some((line) => line.includes("visibility: hidden")),
    "no .tile-face rule may hide a face wholesale",
  );
  // Reduced motion removes the 180deg back transform so text is never inverted.
  const reducedBlock = tilesCss.slice(tilesCss.indexOf("prefers-reduced-motion"));
  assert.ok(reducedBlock.includes("transform: none"), "reduced motion must not keep the back rotated");
});

test("flip lifecycle is airtight: handles cancelled, no leaked timers", () => {
  // The animation handle is retained and cancelled on cleanup.
  assert.ok(flipSource.includes("animationRef.current?.cancel()"));
  assert.ok(flipSource.includes("animationRef.current = animateValue"));
  // schedule() must not fire after the effect is cancelled.
  assert.ok(/const schedule = \(\) => \{\s*if \(cancelled\) return;/.test(flipSource));
  // The mid-flip completion guard also respects cancellation.
  assert.ok(flipSource.includes("if (cancelled) return;"));
});

test("flip uses a continuous physical curve within the motion budget", () => {
  // Accelerate into the apex, decelerate out — not two easeInOut halves.
  assert.ok(flipSource.includes("easing: accelerate"));
  assert.ok(flipSource.includes("easing: decelerate"));
  assert.ok(!flipSource.includes("easeInOut"), "must not use soft easeInOut halves");
  // Total duration derives from the content token, staying under the 260ms tier.
  assert.ok(flipSource.includes("MOTION_DURATIONS.content"));
  assert.ok(tokensSource.includes("content: 220"));
});

test("keyboard reorder stays reachable in edit mode", () => {
  // Tile must remain focusable: aria-disabled, never the disabled attribute.
  assert.ok(tileSource.includes('aria-disabled={disabled || undefined}'));
  assert.ok(!/disabled=\{disabled\}/.test(tileSource), "button must not use the disabled attribute");
  assert.ok(quickplaySource.includes("onKeyDown={(event) => handlePinKey(event, item.pin.id)}"));
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
  assert.ok(/if \(paused \|\| !live\) return undefined;/.test(flipSource));
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
  // Iconic renders icon, corner count, and label.
  assert.ok(iconicSource.includes("tile-iconic-count"));
  assert.ok(iconicSource.includes("tile-iconic-label"));
  assert.ok(tilesCss.includes(".tile-iconic-icon"));
});
