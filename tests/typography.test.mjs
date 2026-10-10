import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const sheets = Object.fromEntries(readdirSync("src/styles").filter(file => file.endsWith(".css"))
  .map(file => [file, readFileSync(`src/styles/${file}`, "utf8")]));
const base = sheets["base.css"];
const normalize = selector => selector.replace(/\s+/g, " ").trim();
function rules(file, selector) {
  return [...sheets[file].matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => normalize(match[1]) === normalize(selector)).map(match => match[2]);
}

test("typography consumers use shared roles instead of isolated sizes and weights", () => {
  for (const [file, css] of Object.entries(sheets)) {
    for (const [, property, value] of css.matchAll(/(?:^|[;{\s])font-(size|weight):\s*([^;}]+)/g)) {
      assert.match(value.trim(), /^(?:var\(--(?:type|weight|lyrics)-[\w-]+\)|inherit)$/, `${file}: font-${property}: ${value}`);
    }
    for (const [, variable] of css.matchAll(/var\((--(?:type|weight)-[\w-]+)\)/g)) {
      assert.ok(base.includes(`${variable}:`), `${file} references undefined ${variable}`);
    }
  }
});

test("peer category and content navigation keep the same size and weight", () => {
  const peers = [
    ["collection-details.css", ".collection-categories > button", "secondary"],
    ["podcasts.css", ".podcast-header-root .podcast-sections button", "secondary"],
    ["overlays-settings.css", ".settings-categories button", "secondary"],
    ["compact-player.css", ".compact-categories .button", "secondary"],
    ["collection-details.css", ".collection-detail-tabs > button", "tertiary"],
    ["podcasts.css", ".podcast-library-tabs button", "tertiary"],
    ["podcasts.css", ".podcast-settings-tabs .button", "tertiary"],
    ["podcasts.css", ".podcast-list-pivots button", "tertiary"],
    ["podcast-now-playing.css", ".podcast-now-reading-nav .button", "tertiary"],
  ];
  for (const [file, selector, level] of peers) {
    const declarations = rules(file, selector);
    assert.ok(declarations.length, `${file} is missing ${selector}`);
    for (const rule of declarations) {
      assert.ok(rule.includes(`font-size: var(--type-nav-${level})`), `${selector} bypasses its navigation level`);
      assert.ok(rule.includes("font-weight: var(--weight-body)"), `${selector} changes weight between navigation contexts`);
    }
  }
});

test("display, media artwork and user-selected lyric scales remain distinct from functional text", () => {
  assert.match(base, /--type-body:\s*14px/);
  assert.match(base, /--type-caption:\s*12px/);
  assert.match(base, /--weight-display:\s*250/);
  assert.match(base, /--weight-body:\s*400/);
  assert.match(base, /--weight-emphasis:\s*600/);
  assert.ok(rules("quickplay.css", ".quick-group h2")[0].includes("var(--type-feature-title)"));
  assert.ok(rules("collection.css", ".collection-ghost").every(rule => rule.includes("var(--type-ghost)")));
  assert.ok(sheets["lyrics.css"].includes('data-lyrics-font-size="small"'));
  assert.ok(sheets["lyrics.css"].includes('data-lyrics-font-size="large"'));
  assert.ok(rules("lyrics.css", ".lyrics-line-copy")[0].includes("var(--lyrics-main-font-size)"));
});
