import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsView = readFileSync("src/views/SettingsView.tsx", "utf8");
const appHeader = readFileSync("src/components/AppHeader.tsx", "utf8");
const titlebar = readFileSync("src/components/Titlebar.tsx", "utf8");
const appSource = [
  "src/app/podcastPlaybackSettings.ts",
  "src/hooks/useNavigation.ts",
  "src/hooks/useMusicLibrary.ts",
  "src/hooks/usePodcastPlayback.ts",
  "src/hooks/usePlaybackControls.ts",
  "src/hooks/useAudioEngine.ts",
  "src/hooks/usePlaylists.ts",
  "src/App.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");
const baseCss = readFileSync("src/styles/base.css", "utf8");
const controlsCss = readFileSync("src/styles/controls.css", "utf8");
const settingsCss = readFileSync("src/styles/overlays-settings.css", "utf8");
const responsiveCss = readFileSync("src/styles/animations-responsive.css", "utf8");

test("music folder management has one persistent entry point", () => {
  assert.ok(settingsView.includes('className="settings-heading-action"'));
  assert.ok(settingsView.includes('variant="page"'));
  assert.ok(!appHeader.includes("FolderPlus"));
  assert.ok(!appHeader.includes("onAddFolder"));
  assert.ok(!settingsView.includes("settings-actions"));
});

test("settings use a spacious Zune-like library hierarchy", () => {
  const layoutRule = cssRule(settingsCss, ".settings-layout");
  const headerRule = cssRule(settingsCss, ".settings-header");
  const folderRowRule = cssRule(settingsCss, ".folder-row");
  const sidebarRule = cssRule(settingsCss, ".settings-sidebar");

  assert.ok(layoutRule.includes("grid-template-columns: minmax(520px, 1.55fr) minmax(280px, 0.62fr)"));
  assert.ok(layoutRule.includes("gap: clamp(48px, 6vw, 96px)"));
  assert.ok(headerRule.includes("border-bottom: 1px solid"));
  assert.ok(folderRowRule.includes("min-height: 66px"));
  assert.ok(folderRowRule.includes("grid-template-columns: 28px minmax(0, 1fr) auto"));
  assert.ok(sidebarRule.includes("border-left: 1px solid"));
});

test("settings separate primary, secondary, and destructive actions", () => {
  const pageRule = cssRule(controlsCss, ".button-page");
  const ghostRule = cssRule(controlsCss, ".button-ghost");
  const dangerRule = cssRule(controlsCss, ".button-danger");

  assert.ok(pageRule.includes("border-left: 3px solid var(--accent)"));
  assert.ok(ghostRule.includes("justify-content: flex-start"));
  assert.ok(dangerRule.includes("border: 1px solid rgba(225, 90, 103, 0.7)"));
  assert.ok(settingsView.includes("不会删除电脑中的音乐文件"));
  assert.ok(settingsView.includes("重新扫描资料库"));
});

test("settings live in the titlebar; collection owns search", () => {
  const settingsControlRule = cssRule(baseCss, ".window-controls .titlebar-settings");

  assert.ok(!appHeader.includes("app-utilities"));
  assert.ok(!titlebar.includes("titlebar-search"));
  assert.ok(readFileSync("src/views/CollectionView.tsx", "utf8").includes("<CollectionSearchField"));
  assert.ok(!appHeader.includes('onNavigate("settings")'));
  assert.ok(titlebar.includes('className={isSettings ? "titlebar-settings active" : "titlebar-settings"}'));
  assert.ok(appSource.includes('onOpenSettings={() => navigatePage("settings")}'));
  assert.ok(settingsControlRule.includes("border-right: 1px solid"));
});

test("settings remain reachable at the default window height", () => {
  const pageRule = cssRule(settingsCss, ".settings-page");
  const layoutRule = cssRule(settingsCss, ".settings-layout");

  assert.ok(pageRule.includes("overflow-y: auto"));
  assert.ok(layoutRule.includes("overflow: visible"));
  assert.ok(responsiveCss.includes("@media (max-height: 800px)"));
  assert.ok(responsiveCss.includes(".settings-danger-action"));
});

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}

function cssRuleLast(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...source.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))];
  assert.ok(matches.length > 0, `missing CSS rule ${selector}`);
  return matches.at(-1)[1];
}
