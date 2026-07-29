import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stageSource = readFileSync("src/components/LyricsStage.tsx", "utf8");
const settingsPanelSource = readFileSync("src/components/lyricsStage/LyricsSettingsPanel.tsx", "utf8");
const sourceBrowserSource = readFileSync("src/components/lyricsStage/LyricsSourceBrowser.tsx", "utf8");

test("online lyrics search returns to settings when settings opened it", () => {
  assert.ok(stageSource.includes('useState<"stage" | "settings">("stage")'));
  assert.ok(settingsPanelSource.includes('openOnlineSearch(event.detail === 0, "settings")'));
  assert.ok(stageSource.includes('sourceBrowserOrigin === "settings"'));
  assert.ok(stageSource.includes('setSettingsOpen(true)'));
  assert.ok(sourceBrowserSource.includes('{sourceBrowserOrigin === "settings" ? "返回" : "关闭"}'));
});

test("direct online lyrics search keeps its close behavior", () => {
  assert.ok(stageSource.includes('origin: "stage" | "settings" = "stage"'));
  assert.ok(stageSource.includes('onClick={(event) => openOnlineSearch(event.detail === 0)}'));
});
