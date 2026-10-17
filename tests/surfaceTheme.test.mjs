import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";

await build({ entryPoints: ["src/hooks/useSurfaceTheme.ts"], outfile: ".tmp/surface-theme-runtime.js", bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const dom = new JSDOM('<body><div id="root"></div><div id="portal"></div></body>');
for (const key of ["window", "document", "HTMLElement", "Element", "Node"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { createPortal } = await import("react-dom");
const { useSurfaceTheme } = await import("../.tmp/surface-theme-runtime.js");

test("browsing and body portals share a light palette while startup and immersive playback stay dark", async t => {
  const root = createRoot(document.getElementById("root"));
  t.after(async () => { await act(async () => root.unmount()); });
  function Surface(props) {
    const theme = useSurfaceTheme(props.ready, props.compact, props.page);
    return React.createElement("section", { "data-surface-theme": theme }, createPortal(React.createElement("div", { role: "dialog" }, "设置"), document.getElementById("portal")));
  }
  const render = async (page, ready = true, compact = false) => {
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Surface, { page, ready, compact }))));
    assert.equal(document.querySelector("#root section").dataset.surfaceTheme, document.documentElement.dataset.surfaceTheme);
    return document.documentElement.dataset.surfaceTheme;
  };
  assert.equal(await render("quickplay", false), "dark");
  for (const page of ["quickplay", "collection", "podcasts", "settings"]) assert.equal(await render(page), "light");
  assert.ok(document.body.querySelector('[role="dialog"]'));
  assert.equal(await render("nowPlaying"), "dark");
  assert.equal(await render("collection", true, true), "dark");
  assert.equal(await render("settings"), "light");
  await act(async () => root.unmount());
  assert.equal(document.documentElement.hasAttribute("data-surface-theme"), false);
});

test("light text roles retain contrast and background changes consume motion tokens", () => {
  const css = readFileSync("src/styles/base.css", "utf8");
  const palette = css.match(/\[data-surface-theme="light"\]\s*\{([^}]+)\}/)[1];
  const luminance = hex => [...hex.matchAll(/[a-f\d]{2}/gi)].map(m => parseInt(m[0], 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = hex => 1.05 / (luminance(hex) + .05);
  const color = role => palette.match(new RegExp(`--${role}:\\s*(#[a-f\\d]{6})`, "i"))[1];
  assert.ok(contrast(color("text")) >= 12);
  assert.ok(contrast(color("muted")) >= 7);
  assert.ok(contrast(color("quiet")) >= 4.5);
  assert.match(css, /transition: background-color var\(--motion-page\)/);
  assert.match(readFileSync("src/styles/motion.css", "utf8"), /\.shell \{ transition-duration: var\(--motion-instant\); \}/);
});
