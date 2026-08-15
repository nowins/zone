import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const podcastsCss = readFileSync("src/styles/podcasts.css", "utf8");
const podcastNowCss = readFileSync("src/styles/podcast-now-playing.css", "utf8");
const motionCss = readFileSync("src/styles/motion.css", "utf8");

// Guards for the registered podcast motion language:
// design/motion-system.md "Hover 反馈分级" level 4 + the podcast list-row
// rule, and component-guidelines.md §4.3 (popover exits live next to their
// styles while reduced-motion stays centralized in motion.css).

test("podcast cover-card hover dims and lifts the artwork, never scales it", () => {
  const cardRule = podcastsCss.match(/\.podcast-show-card:hover:not\(:disabled\) \.podcast-artwork\s*\{([^}]*)\}/);
  assert.ok(cardRule, "show-card artwork hover rule must exist");
  assert.ok(cardRule[1].includes("opacity: 0.8"));
  assert.ok(cardRule[1].includes("translateY(-2px)"));
  assert.ok(!cardRule[1].includes("scale("), "podcast covers must not scale on hover");
  // The transition lives on the artwork itself so hover on/off share it.
  const artworkRule = podcastsCss.match(/^\.podcast-artwork\s*\{([^}]*)\}/m);
  assert.ok(artworkRule[1].includes("var(--motion-micro)"));
});

test("podcast list rows brighten text only: no row background, no transition", () => {
  assert.ok(/\.podcast-episode-open:hover > strong/.test(podcastsCss));
  assert.ok(
    !/\.podcast-episode-open:hover\s*\{[^}]*background/.test(podcastsCss),
    "episode rows must not gain a background hover",
  );
  assert.ok(
    !/\.podcast-episode-open\s*\{[^}]*transition/.test(podcastsCss),
    "episode rows must not transition",
  );
});

test("podcast now-playing popovers keep token-based paired exits beside their styles", () => {
  assert.ok(
    /\.motion-exit \.podcast-now-popover\s*\{[^}]*var\(--motion-micro\) var\(--motion-ease-exit\)/.test(podcastNowCss),
    "popover must exit on micro/ease-exit tokens",
  );
  assert.ok(
    /\.motion-exit \.podcast-now-queue\s*\{[^}]*var\(--motion-micro\) var\(--motion-ease-exit\)/.test(podcastNowCss),
    "queue panel must exit on micro/ease-exit tokens",
  );
  // Reduced-motion convergence still comes from the single block in motion.css.
  const reduced = motionCss.slice(motionCss.indexOf("prefers-reduced-motion"));
  assert.ok(reduced.includes(".podcast-now-popover"));
  assert.ok(reduced.includes(".podcast-now-queue"));
});

test("podcast screens join the shared feather cascade with the standard stagger cap", () => {
  const featherRule = motionCss.match(/([^{}]*)\{[^}]*animation: motion-feather-in/);
  assert.ok(featherRule, "the feather rule must exist");
  assert.ok(featherRule[1].includes(".podcast-content-section"));
  assert.ok(featherRule[1].includes(".podcast-episode"));
  assert.ok(featherRule[1].includes(".podcast-show-card"));
  assert.ok(featherRule[1].includes(".podcast-queue-episode"));
  // Same 24ms step / 144ms cap table as every other list surface.
  assert.ok(motionCss.includes(".podcast-episode:nth-child(2) { --stagger: 24ms; }") || /\.podcast-episode:nth-child\(2\)[,\s]/.test(motionCss));
  assert.ok(/\.podcast-episode:nth-child\(n \+ 7\)[,\s]/.test(motionCss));
  // Reduced motion collapses the podcast cascade in the same single block.
  const reduced = motionCss.slice(motionCss.indexOf("prefers-reduced-motion"));
  assert.ok(reduced.includes(".podcast-episode"));
  assert.ok(reduced.includes(".podcast-content-section"));
});

test("podcast now-playing chrome and row play actions join the press group", () => {
  const scaleRule = motionCss.match(/:active:not\(:disabled\)[^{]*\{\s*transform: scale\(0\.97\);\s*\}/);
  assert.ok(scaleRule, "the shared press-scale rule must exist");
  assert.ok(motionCss.includes(".podcast-now-primary-controls > button:active:not(:disabled)"));
  assert.ok(motionCss.includes(".podcast-now-back:active:not(:disabled)"));
  assert.ok(motionCss.includes(".podcast-play-action:active:not(:disabled)"));
  // Section tabs transition color like pivot tabs but never scale.
  assert.ok(motionCss.includes(".podcast-sections button,"));
  assert.ok(!motionCss.includes(".podcast-sections button:active"));
});
