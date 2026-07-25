import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const motionCss = readFileSync("src/styles/motion.css", "utf8");
const appSource = readFileSync("src/App.tsx", "utf8");
const presenceSource = readFileSync("src/motion/presence.tsx", "utf8");

// Reduced-motion exits must not leave a dead pause: CSS plays an 80ms
// opacity-only fade and the JS lifecycles wait the same instant tier.
test("reduced motion swaps spatial exits for an instant-tier opacity fade", () => {
  assert.ok(motionCss.includes("@keyframes motion-exit-reduced"));
  const reducedBlock = motionCss.slice(motionCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(reducedBlock.includes("animation: motion-exit-reduced var(--motion-instant)"));
  // The fade rule covers both page exits and Presence overlay exits.
  assert.ok(reducedBlock.includes('.shell[data-nav-state="exiting"] .quickplay'));
  assert.ok(reducedBlock.includes(".motion-exit .context-menu"));
  // Exit selectors must not sit in the animation:none kill list any more.
  const killList = reducedBlock.match(/animation:\s*none;/)?.[0];
  assert.ok(killList, "reduced block still kills entrance/feedback animations");
  const killRule = reducedBlock.slice(0, reducedBlock.indexOf("animation: none;"));
  assert.ok(!killRule.includes(".motion-exit .context-menu"), "context menu exit needs the fade, not a dead wait");
  assert.ok(!killRule.includes('[data-nav-state="exiting"]'), "page exit needs the fade, not a dead wait");
});

test("navigation and Presence lifecycles consume the shared exit-duration policy", () => {
  assert.ok(appSource.includes("resolveExitDurationMs(transition.exitMs, reducedMotion)"));
  assert.ok(presenceSource.includes("resolveExitDurationMs(exitDurationMs, reducedMotion)"));
});
