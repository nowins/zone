import { useState, type RefObject } from "react";
import type { LyricsExportFormat } from "../../utils/lyricsExport";
import {
  LYRICS_FONT_SIZE_OPTIONS,
  type LyricsDisplaySettings,
  type LyricsFontSize,
} from "../../utils/lyricsDisplay";
import { formatLyricsTimingOffset, LYRICS_TIMING_STEP_MS } from "../../utils/lyricsTiming";
import { fileName, fontSizeLabel } from "./lyricsLineUtils";

/**
 * Lyrics settings surface (display / sync / source / export). Rendered by
 * LyricsStage only while open and kept alive through its Presence exit, so
 * the export status can live here: it resets whenever the panel unmounts
 * after closing. Display settings themselves stay owned by the stage, which
 * also consumes them for line rendering.
 */
export function LyricsSettingsPanel({
  settingsKeyboardTransition,
  setSettingsKeyboardTransition,
  settings,
  setFontSize,
  setDisplayOption,
  displayAvailability,
  isPlain,
  isDemoSource,
  isManualSource,
  hasOnlineProviders,
  sourceLabel,
  timingOffsetMs,
  settingsPanelRef,
  closeSettings,
  openOnlineSearch,
  runSettingsSourceAction,
  onSelectSource,
  onClearManualSource,
  onAdjustTimingOffset,
  onResetTimingOffset,
  onExportLyrics,
  onInteraction,
}: {
  settingsKeyboardTransition: boolean;
  setSettingsKeyboardTransition: (keyboardTransition: boolean) => void;
  settings: LyricsDisplaySettings;
  setFontSize: (fontSize: LyricsFontSize) => void;
  setDisplayOption: (
    option: "showTranslation" | "showTransliteration" | "showBackgroundVocals",
    enabled: boolean,
  ) => void;
  displayAvailability: {
    translation: boolean;
    transliteration: boolean;
    backgroundVocals: boolean;
  };
  isPlain: boolean;
  isDemoSource: boolean;
  isManualSource: boolean;
  hasOnlineProviders: boolean;
  sourceLabel?: string;
  timingOffsetMs: number;
  settingsPanelRef: RefObject<HTMLElement>;
  closeSettings: (keyboardInitiated?: boolean) => void;
  openOnlineSearch: (keyboardInitiated?: boolean, origin?: "stage" | "settings") => void;
  runSettingsSourceAction: (action: () => void | Promise<void>, keyboardInitiated?: boolean) => void;
  onSelectSource: () => void | Promise<void>;
  onClearManualSource: () => void;
  onAdjustTimingOffset: (deltaMs: number) => void;
  onResetTimingOffset: () => void;
  onExportLyrics: (format: LyricsExportFormat) => Promise<string | null>;
  onInteraction: () => void;
}) {
  const [exportState, setExportState] = useState<{
    status: "idle" | "saving" | "success" | "error";
    message: string;
  }>({ status: "idle", message: "" });

  async function exportLyrics(format: LyricsExportFormat) {
    onInteraction();
    setExportState({ status: "saving", message: "正在打开保存位置…" });
    try {
      const path = await onExportLyrics(format);
      setExportState(path
        ? { status: "success", message: `已导出 ${fileName(path)}` }
        : { status: "idle", message: "" });
    } catch (exportError) {
      setExportState({
        status: "error",
        message: exportError instanceof Error ? exportError.message : "导出失败",
      });
    }
  }

  const displayToggle = (
    option: "showTranslation" | "showTransliteration" | "showBackgroundVocals",
    label: string,
    available: boolean,
    availableDescription: string,
    unavailableDescription: string,
  ) => (
    <button
      className="lyrics-settings-row lyrics-settings-switch-row"
      type="button"
      role="switch"
      aria-checked={settings[option]}
      data-unavailable={!available || undefined}
      onClick={(event) => {
        setSettingsKeyboardTransition(event.detail === 0);
        setDisplayOption(option, !settings[option]);
        onInteraction();
      }}
    >
      <span>
        <strong>{label}</strong>
        <small>{available ? availableDescription : unavailableDescription}</small>
      </span>
      <span className="lyrics-settings-switch" aria-hidden="true" />
    </button>
  );

  return (
    <section
      ref={settingsPanelRef}
      id="lyrics-settings-panel"
      className={`lyrics-settings-panel ${settingsKeyboardTransition ? "is-keyboard-transition" : ""}`}
      role="dialog"
      aria-labelledby="lyrics-settings-title"
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          closeSettings(true);
        }
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        setSettingsKeyboardTransition(false);
      }}
    >
      <header>
        <div>
          <span>歌词</span>
          <h2 id="lyrics-settings-title">设置</h2>
        </div>
        <button
          type="button"
          onClick={(event) => closeSettings(event.detail === 0)}
        >
          关闭
        </button>
      </header>

      <div className="lyrics-settings-content">
        <section className="lyrics-settings-section" aria-labelledby="lyrics-display-settings">
          <h3 id="lyrics-display-settings">显示</h3>
          <div className="lyrics-settings-row lyrics-font-size-row">
            <span>
              <strong>歌词大小</strong>
              <small>只调整歌词舞台，不影响应用界面</small>
            </span>
            <div className="lyrics-font-size-options" role="group" aria-label="歌词大小">
              {LYRICS_FONT_SIZE_OPTIONS.map((fontSize) => (
                <button
                  type="button"
                  key={fontSize}
                  aria-pressed={settings.fontSize === fontSize}
                  onClick={(event) => {
                    setSettingsKeyboardTransition(event.detail === 0);
                    setFontSize(fontSize);
                    onInteraction();
                  }}
                >
                  {fontSizeLabel(fontSize)}
                </button>
              ))}
            </div>
          </div>
          {displayToggle(
            "showTranslation",
            "翻译",
            displayAvailability.translation,
            "显示原文下方的翻译",
            "当前歌词不包含翻译",
          )}
          {displayToggle(
            "showTransliteration",
            "音译",
            displayAvailability.transliteration,
            "显示罗马字或读音辅助",
            "当前歌词不包含音译",
          )}
          {displayToggle(
            "showBackgroundVocals",
            "背景人声",
            displayAvailability.backgroundVocals,
            "显示独立时间轴上的和声与伴唱",
            "当前歌词不包含背景人声",
          )}
        </section>

        {!isPlain && !isDemoSource ? (
          <section className="lyrics-settings-section" aria-labelledby="lyrics-sync-settings">
            <h3 id="lyrics-sync-settings">同步</h3>
            <div className="lyrics-settings-row lyrics-settings-timing">
              <span>
                <strong>歌词时间</strong>
                <small>正值表示歌词延后</small>
              </span>
              <div>
                <button
                  type="button"
                  title="歌词出现得太晚"
                  onClick={(event) => {
                    setSettingsKeyboardTransition(event.detail === 0);
                    onAdjustTimingOffset(-LYRICS_TIMING_STEP_MS);
                    onInteraction();
                  }}
                >
                  提前
                </button>
                <output aria-live="polite">{formatLyricsTimingOffset(timingOffsetMs)}</output>
                <button
                  type="button"
                  title="歌词出现得太早"
                  onClick={(event) => {
                    setSettingsKeyboardTransition(event.detail === 0);
                    onAdjustTimingOffset(LYRICS_TIMING_STEP_MS);
                    onInteraction();
                  }}
                >
                  延后
                </button>
                <button
                  className="lyrics-settings-reset"
                  type="button"
                  disabled={timingOffsetMs === 0}
                  onClick={(event) => {
                    setSettingsKeyboardTransition(event.detail === 0);
                    onResetTimingOffset();
                    onInteraction();
                  }}
                >
                  重置
                </button>
              </div>
            </div>
          </section>
        ) : null}

        <section className="lyrics-settings-section" aria-labelledby="lyrics-source-settings">
          <h3 id="lyrics-source-settings">来源</h3>
          <div className="lyrics-settings-current-source">
            <span>当前</span>
            <strong title={sourceLabel}>{sourceLabel ?? "本地歌词"}</strong>
            {isManualSource ? <em>已手动选择</em> : null}
          </div>
          <div className="lyrics-settings-actions">
            {hasOnlineProviders ? (
              <button
                type="button"
                onClick={(event) => openOnlineSearch(event.detail === 0, "settings")}
              >
                <strong>在线搜索</strong>
                <small>同时查询所有已启用的来源</small>
              </button>
            ) : null}
            <button
              type="button"
              onClick={(event) => runSettingsSourceAction(onSelectSource, event.detail === 0)}
            >
              <strong>{isDemoSource ? "选择本地歌词" : "更换本地文件"}</strong>
              <small>支持 TTML、LRC 和纯文本</small>
            </button>
            {isManualSource ? (
              <button
                type="button"
                onClick={(event) => runSettingsSourceAction(onClearManualSource, event.detail === 0)}
              >
                <strong>恢复自动查找</strong>
                <small>移除当前曲目的手动来源</small>
              </button>
            ) : null}
          </div>
        </section>

        {!isDemoSource ? (
          <section className="lyrics-settings-section lyrics-settings-export" aria-labelledby="lyrics-export-settings">
            <h3 id="lyrics-export-settings">导出</h3>
            <div className="lyrics-settings-actions">
              <button
                type="button"
                disabled={exportState.status === "saving"}
                onClick={(event) => {
                  setSettingsKeyboardTransition(event.detail === 0);
                  void exportLyrics("ttml");
                }}
              >
                <strong>TTML</strong>
                <small>完整保留逐词、翻译、音译和背景人声</small>
              </button>
              <button
                type="button"
                disabled={exportState.status === "saving"}
                onClick={(event) => {
                  setSettingsKeyboardTransition(event.detail === 0);
                  void exportLyrics("lrc");
                }}
              >
                <strong>LRC</strong>
                <small>兼容逐行、逐词起点和翻译；不含音译、背景人声</small>
              </button>
            </div>
            {exportState.message ? (
              <output className={`is-${exportState.status}`} aria-live="polite">
                {exportState.message}
              </output>
            ) : null}
          </section>
        ) : null}
      </div>
    </section>
  );
}
