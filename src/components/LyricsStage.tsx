import { SlidersHorizontal } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent,
} from "react";
import type { LyricsCandidate, LyricsDocument, LyricsLine, LyricsSearchMetadata, LyricsWord } from "../types";
import type { LyricsOnlineSearchState } from "../hooks/useLyrics";
import { useLyricsDisplaySettings } from "../hooks/useLyricsDisplaySettings";
import type { LyricsExportFormat } from "../utils/lyricsExport";
import {
  LYRICS_FONT_SIZE_OPTIONS,
  type LyricsDisplaySettings,
  type LyricsFontSize,
} from "../utils/lyricsDisplay";
import { isLyricsLongNote, lyricsLongNoteEnvelope } from "../utils/lyricsMotion";
import {
  formatLyricsTimingOffset,
  LYRICS_TIMING_STEP_MS,
  lyricsTimeToMediaTime,
  mediaTimeToLyricsTime,
} from "../utils/lyricsTiming";
import { Presence, useLastNonNull } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";

const BROWSE_RETURN_DELAY = 3_000;
const WHEEL_STEP_THRESHOLD = 34;

type LyricsLineStyle = CSSProperties & {
  "--lyrics-y": string;
  "--lyrics-distance": number;
  "--lyrics-opacity": number;
  "--lyrics-scale": number;
  "--lyrics-blur": string;
};

function findActiveLine(lines: LyricsLine[], progress: number) {
  if (lines.length === 0) return -1;
  let activeIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (progress < lines[index].start) break;
    activeIndex = index;
  }
  return activeIndex;
}

function getWordProgress(word: LyricsWord, progress: number) {
  if (progress <= word.start) return 0;
  if (progress >= word.end) return 1;
  return (progress - word.start) / Math.max(0.001, word.end - word.start);
}

function getBackgroundPresence(start: number, end: number, progress: number) {
  if (progress < start || progress >= end) return 0;
  const fadeIn = Math.min(1, (progress - start) / 0.16);
  const fadeOut = Math.min(1, (end - progress) / 0.22);
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

function lineAriaLabel(line: LyricsLine, isPlain: boolean, settings: LyricsDisplaySettings) {
  if (isPlain) return line.text;
  const supportingText = [
    settings.showTranslation ? line.translation : undefined,
    settings.showTransliteration ? line.transliteration : undefined,
    ...(!settings.showBackgroundVocals ? [] : (line.background ?? []).flatMap((background) => [
      `背景人声：${background.text}`,
      settings.showTranslation ? background.translation : undefined,
      settings.showTransliteration ? background.transliteration : undefined,
    ])),
  ].filter(Boolean);
  return [`跳转到歌词：${line.text}`, ...supportingText].join("；");
}

function lineStyle(offset: number, browsing: boolean): LyricsLineStyle {
  const distance = Math.abs(offset);
  const opacity = browsing
    ? Math.max(0.2, 1 - distance * 0.18)
    : distance === 0
      ? 1
      : Math.max(0.06, 0.48 - (distance - 1) * 0.14);
  const scale = Math.max(0.74, 1 - distance * 0.085);
  const blur = browsing || distance === 0 ? 0 : Math.min(6, 1.4 + (distance - 1) * 1.65);

  return {
    "--lyrics-y": `${offset * 10.5}vh`,
    "--lyrics-distance": distance,
    "--lyrics-opacity": opacity,
    "--lyrics-scale": scale,
    "--lyrics-blur": `${blur}px`,
  };
}

export function LyricsStage({
  document,
  status,
  sourceLabel,
  isManualSource,
  isDemoSource,
  onlineSearch,
  hasOnlineProviders,
  searchMetadata,
  hasSearchMetadataOverride,
  error,
  progress,
  isPlaying,
  playbackClock,
  duration,
  timingOffsetMs,
  visible,
  onSeek,
  onSelectSource,
  onSearchOnline,
  onUpdateSearchMetadata,
  onResetSearchMetadata,
  onExportLyrics,
  onSelectOnlineSource,
  onClearManualSource,
  onRetry,
  onAdjustTimingOffset,
  onResetTimingOffset,
  onInteraction,
}: {
  document: LyricsDocument | null;
  status: "idle" | "loading" | "ready" | "missing" | "error";
  sourceLabel?: string;
  isManualSource: boolean;
  isDemoSource: boolean;
  onlineSearch: LyricsOnlineSearchState;
  hasOnlineProviders: boolean;
  searchMetadata: LyricsSearchMetadata | null;
  hasSearchMetadataOverride: boolean;
  error?: string;
  progress: number;
  isPlaying: boolean;
  playbackClock: () => number;
  duration: number;
  timingOffsetMs: number;
  visible: boolean;
  onSeek: (value: number) => void;
  onSelectSource: () => void | Promise<void>;
  onSearchOnline: () => void | Promise<void>;
  onUpdateSearchMetadata: (metadata: LyricsSearchMetadata) => boolean;
  onResetSearchMetadata: () => void;
  onExportLyrics: (format: LyricsExportFormat) => Promise<string | null>;
  onSelectOnlineSource: (candidate: LyricsCandidate) => void | Promise<void>;
  onClearManualSource: () => void;
  onRetry: () => void;
  onAdjustTimingOffset: (deltaMs: number) => void;
  onResetTimingOffset: () => void;
  onInteraction: () => void;
}) {
  const [browseIndex, setBrowseIndex] = useState<number | null>(null);
  const [sourceBrowserOpen, setSourceBrowserOpen] = useState(false);
  const [sourceBrowserOrigin, setSourceBrowserOrigin] = useState<"stage" | "settings">("stage");
  const [sourceBrowserKeyboardTransition, setSourceBrowserKeyboardTransition] = useState(false);
  const [searchMetadataEditing, setSearchMetadataEditing] = useState(false);
  const [searchMetadataDraft, setSearchMetadataDraft] = useState<LyricsSearchMetadata>({
    title: "",
    artist: "",
    album: "",
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsKeyboardTransition, setSettingsKeyboardTransition] = useState(false);
  const [exportState, setExportState] = useState<{
    status: "idle" | "saving" | "success" | "error";
    message: string;
  }>({ status: "idle", message: "" });
  const { settings, setFontSize, setDisplayOption } = useLyricsDisplaySettings();
  const [navigationInput, setNavigationInput] = useState<"pointer" | "keyboard">("pointer");
  const returnTimerRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const settingsPanelRef = useRef<HTMLElement | null>(null);
  const sourceBrowserRef = useRef<HTMLElement | null>(null);
  const lineButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const wordProgressRefs = useRef<Array<Array<HTMLSpanElement | null>>>([]);
  const wordMotionRefs = useRef<Array<Array<HTMLSpanElement | null>>>([]);
  const wordSustainRefs = useRef<Array<Array<HTMLSpanElement | null>>>([]);
  const backgroundLineRefs = useRef<Array<Array<HTMLSpanElement | null>>>([]);
  const backgroundWordProgressRefs = useRef<Array<Array<Array<HTMLSpanElement | null>>>>([]);
  const playbackClockRef = useRef(playbackClock);
  const lines = document?.lines ?? [];
  const isPlain = document?.format === "plain";
  const lyricsProgress = mediaTimeToLyricsTime(progress, timingOffsetMs);
  const initialActiveIndex = useMemo(
    () => isPlain ? -1 : findActiveLine(lines, lyricsProgress),
    [document?.trackId, document?.sourceId, isPlain],
  );
  const [activeIndex, setActiveIndex] = useState(initialActiveIndex);
  const activeIndexRef = useRef(initialActiveIndex);
  const focusIndex = browseIndex ?? activeIndex;
  const browsing = browseIndex !== null;
  const displayAvailability = useMemo(() => ({
    translation: lines.some((line) => Boolean(
      line.translation || line.background?.some((background) => background.translation),
    )),
    transliteration: lines.some((line) => Boolean(
      line.transliteration || line.background?.some((background) => background.transliteration),
    )),
    backgroundVocals: lines.some((line) => Boolean(line.background?.length)),
  }), [document?.lines]);

  playbackClockRef.current = playbackClock;

  const paintWordProgress = useCallback((time: number, syncEveryLine = false) => {
    if (isPlain) return;
    const nextActiveIndex = findActiveLine(lines, time);
    if (nextActiveIndex !== activeIndexRef.current) {
      activeIndexRef.current = nextActiveIndex;
      setActiveIndex(nextActiveIndex);
      syncEveryLine = true;
    }

    lines.forEach((line, lineIndex) => {
      if (!syncEveryLine && lineIndex !== nextActiveIndex) return;
      const words = line.words ?? [{ text: line.text, start: line.start, end: line.end }];
      words.forEach((word, wordIndex) => {
        const element = wordProgressRefs.current[lineIndex]?.[wordIndex];
        if (!element) return;
        const fill = lineIndex < nextActiveIndex
          ? 1
          : lineIndex > nextActiveIndex
            ? 0
            : getWordProgress(word, time);
        element.style.clipPath = `inset(0 ${(1 - fill) * 100}% 0 0)`;
        const sustain = line.words?.length && lineIndex === nextActiveIndex
          ? lyricsLongNoteEnvelope(word, time)
          : 0;
        const motionElement = wordMotionRefs.current[lineIndex]?.[wordIndex];
        if (motionElement) motionElement.style.transform = `scale(${(1 + sustain * 0.016).toFixed(4)})`;
        const sustainElement = wordSustainRefs.current[lineIndex]?.[wordIndex];
        if (sustainElement) {
          sustainElement.style.clipPath = `inset(0 ${(1 - fill) * 100}% 0 0)`;
          sustainElement.style.opacity = String(sustain * 0.34);
        }
      });

      line.background?.forEach((background, backgroundIndex) => {
        const presence = lineIndex === nextActiveIndex
          ? getBackgroundPresence(background.start, background.end, time)
          : 0;
        const backgroundElement = backgroundLineRefs.current[lineIndex]?.[backgroundIndex];
        backgroundElement?.style.setProperty("--lyrics-background-presence", String(presence));
        backgroundElement?.style.setProperty("--lyrics-background-shift", `${(1 - presence) * 4}px`);

        const backgroundWords = background.words ?? [{
          text: background.text,
          start: background.start,
          end: background.end,
        }];
        backgroundWords.forEach((word, wordIndex) => {
          const element = backgroundWordProgressRefs.current[lineIndex]?.[backgroundIndex]?.[wordIndex];
          if (!element) return;
          const fill = lineIndex < nextActiveIndex
            ? 1
            : lineIndex > nextActiveIndex
              ? 0
              : getWordProgress(word, time);
          element.style.clipPath = `inset(0 ${(1 - fill) * 100}% 0 0)`;
        });
      });
    });
  }, [isPlain, lines]);

  function clearReturnTimer() {
    if (returnTimerRef.current) window.clearTimeout(returnTimerRef.current);
    returnTimerRef.current = null;
  }

  function scheduleReturnToPlayback() {
    clearReturnTimer();
    returnTimerRef.current = window.setTimeout(() => {
      setBrowseIndex(null);
      setNavigationInput("pointer");
      wheelDeltaRef.current = 0;
    }, BROWSE_RETURN_DELAY);
  }

  function browseTo(index: number) {
    if (lines.length === 0) return;
    setBrowseIndex(Math.min(lines.length - 1, Math.max(0, index)));
    scheduleReturnToPlayback();
    onInteraction();
  }

  function handleWheel(event: WheelEvent<HTMLElement>) {
    if (!visible || lines.length === 0) return;
    if (isPlain) return;
    event.preventDefault();
    setNavigationInput("pointer");
    wheelDeltaRef.current += event.deltaY;
    if (Math.abs(wheelDeltaRef.current) < WHEEL_STEP_THRESHOLD) return;
    const direction = wheelDeltaRef.current > 0 ? 1 : -1;
    wheelDeltaRef.current = 0;
    browseTo((browseIndex ?? activeIndex) + direction);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      if (sourceBrowserOpen) {
        event.preventDefault();
        closeSourceBrowser(true);
      } else if (settingsOpen) {
        event.preventDefault();
        closeSettings(true);
      }
      return;
    }
    if (isPlain) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setNavigationInput("keyboard");
    const nextIndex = Math.min(
      lines.length - 1,
      Math.max(0, (browseIndex ?? activeIndex) + (event.key === "ArrowDown" ? 1 : -1)),
    );
    browseTo(nextIndex);
    lineButtonRefs.current[nextIndex]?.focus();
  }

  function seekToLine(line: LyricsLine, keyboardInitiated: boolean) {
    clearReturnTimer();
    setBrowseIndex(null);
    wheelDeltaRef.current = 0;
    setNavigationInput(keyboardInitiated ? "keyboard" : "pointer");
    onSeek(lyricsTimeToMediaTime(line.start, timingOffsetMs, duration));
    onInteraction();
    if (keyboardInitiated) window.requestAnimationFrame(() => setNavigationInput("pointer"));
  }

  useEffect(() => {
    setBrowseIndex(null);
    setNavigationInput("pointer");
    wheelDeltaRef.current = 0;
    clearReturnTimer();
    const nextActiveIndex = isPlain ? -1 : findActiveLine(lines, lyricsProgress);
    activeIndexRef.current = nextActiveIndex;
    setActiveIndex(nextActiveIndex);
    window.requestAnimationFrame(() => {
      paintWordProgress(mediaTimeToLyricsTime(playbackClockRef.current(), timingOffsetMs), true);
    });
  }, [document?.trackId, document?.sourceId, isPlain, visible]);

  useEffect(() => {
    if (!visible) return;
    if (!isPlaying) {
      paintWordProgress(mediaTimeToLyricsTime(playbackClockRef.current(), timingOffsetMs), true);
      return;
    }

    let frame = 0;
    const drawFrame = () => {
      paintWordProgress(mediaTimeToLyricsTime(playbackClockRef.current(), timingOffsetMs));
      frame = window.requestAnimationFrame(drawFrame);
    };
    frame = window.requestAnimationFrame(drawFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [document?.trackId, document?.sourceId, isPlaying, paintWordProgress, timingOffsetMs, visible]);

  useEffect(() => {
    if (visible && !isPlaying) paintWordProgress(lyricsProgress, true);
  }, [isPlaying, lyricsProgress, paintWordProgress, visible]);

  useEffect(() => () => clearReturnTimer(), []);

  function runSourceAction(action: () => void | Promise<void>) {
    onInteraction();
    void action();
  }

  function openOnlineSearch(
    keyboardInitiated = false,
    origin: "stage" | "settings" = "stage",
  ) {
    setSourceBrowserKeyboardTransition(keyboardInitiated);
    setSettingsKeyboardTransition(keyboardInitiated);
    setSourceBrowserOrigin(origin);
    setSourceBrowserOpen(true);
    setSearchMetadataEditing(false);
    setSettingsOpen(false);
    runSourceAction(onSearchOnline);
  }

  function closeSourceBrowser(keyboardInitiated = false) {
    setSourceBrowserKeyboardTransition(keyboardInitiated);
    setSourceBrowserOpen(false);
    if (sourceBrowserOrigin === "settings") {
      setSettingsKeyboardTransition(keyboardInitiated);
      setSettingsOpen(true);
    }
    onInteraction();
  }

  function toggleSettings(event: ReactMouseEvent<HTMLButtonElement>) {
    const keyboardInitiated = event.detail === 0;
    setSettingsKeyboardTransition(keyboardInitiated);
    setSourceBrowserOpen(false);
    setSettingsOpen((open) => !open);
    setExportState({ status: "idle", message: "" });
    onInteraction();
  }

  function closeSettings(keyboardInitiated = false) {
    setSettingsKeyboardTransition(keyboardInitiated);
    setSettingsOpen(false);
    onInteraction();
    if (keyboardInitiated) {
      window.requestAnimationFrame(() => settingsTriggerRef.current?.focus());
    }
  }

  function runSettingsSourceAction(action: () => void | Promise<void>, keyboardInitiated = false) {
    closeSettings(keyboardInitiated);
    runSourceAction(action);
  }

  function editSearchMetadata() {
    if (!searchMetadata) return;
    setSearchMetadataDraft({ ...searchMetadata });
    setSearchMetadataEditing(true);
    onInteraction();
  }

  function submitSearchMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onUpdateSearchMetadata(searchMetadataDraft)) return;
    setSearchMetadataEditing(false);
    runSourceAction(onSearchOnline);
  }

  function restoreSearchMetadata() {
    onResetSearchMetadata();
    setSearchMetadataEditing(false);
    runSourceAction(onSearchOnline);
  }

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

  function chooseOnlineSource(candidate: LyricsCandidate, keyboardInitiated: boolean) {
    setSourceBrowserKeyboardTransition(keyboardInitiated);
    onInteraction();
    void Promise.resolve(onSelectOnlineSource(candidate)).then(() => setSourceBrowserOpen(false));
  }

  function sourceBrowser() {
    if (!sourceBrowserOpen) return null;
    const providerCount = new Set(onlineSearch.candidates.map((candidate) => candidate.providerId)).size;
    const message = onlineSearch.status === "loading"
      ? `正在联系已启用的来源${onlineSearch.attempt > 1 ? `（第 ${onlineSearch.attempt} 次）` : ""}…`
      : onlineSearch.status === "error"
        ? onlineSearch.errors[0] ?? "在线歌词暂时不可用"
        : onlineSearch.candidates.length === 0
          ? "没有找到足够接近的结果"
          : `${onlineSearch.candidates.length} 个候选，来自 ${providerCount} 个来源，按匹配度排列`;
    return (
      <section
        ref={sourceBrowserRef}
        className={`lyrics-source-browser ${onlineSearch.status === "loading" ? "is-searching" : ""} ${
          sourceBrowserKeyboardTransition ? "is-keyboard-transition" : ""
        }`}
        aria-label="在线歌词候选"
        aria-busy={onlineSearch.status === "loading"}
        onWheel={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            closeSourceBrowser(true);
          }
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          setSourceBrowserKeyboardTransition(false);
        }}
      >
        <header>
          <div>
            <span>歌词来源</span>
            <h2>在线搜索</h2>
          </div>
          <button type="button" onClick={(event) => closeSourceBrowser(event.detail === 0)}>
            {sourceBrowserOrigin === "settings" ? "返回" : "关闭"}
          </button>
        </header>
        {searchMetadataEditing ? (
          <form className="lyrics-search-metadata-form" onSubmit={submitSearchMetadata}>
            <label>
              <span>标题</span>
              <input
                type="text"
                value={searchMetadataDraft.title}
                required
                autoFocus
                onChange={(event) => setSearchMetadataDraft((current) => ({
                  ...current,
                  title: event.target.value,
                }))}
              />
            </label>
            <label>
              <span>艺术家</span>
              <input
                type="text"
                value={searchMetadataDraft.artist}
                onChange={(event) => setSearchMetadataDraft((current) => ({
                  ...current,
                  artist: event.target.value,
                }))}
              />
            </label>
            <label>
              <span>专辑</span>
              <input
                type="text"
                value={searchMetadataDraft.album}
                onChange={(event) => setSearchMetadataDraft((current) => ({
                  ...current,
                  album: event.target.value,
                }))}
              />
            </label>
            <div className="lyrics-search-metadata-actions">
              <button type="submit">保存并搜索</button>
              <button type="button" onClick={() => setSearchMetadataEditing(false)}>取消</button>
              {hasSearchMetadataOverride ? (
                <button type="button" onClick={restoreSearchMetadata}>恢复标签</button>
              ) : null}
            </div>
          </form>
        ) : searchMetadata ? (
          <div className="lyrics-search-metadata-summary">
            <div>
              <strong>{searchMetadata.title}</strong>
              <span>
                {searchMetadata.artist || "未指定艺术家"}
                {searchMetadata.album ? ` / ${searchMetadata.album}` : ""}
              </span>
            </div>
            {hasSearchMetadataOverride ? <em>已修正</em> : null}
            <button type="button" onClick={editSearchMetadata}>修改</button>
          </div>
        ) : null}
        <p className={onlineSearch.status === "error" ? "is-error" : ""}>{message}</p>
        {onlineSearch.providers.length > 0 ? (
          <div className="lyrics-provider-outcomes" aria-label="歌词来源搜索状态">
            {onlineSearch.providers.map((provider) => (
              <span
                key={provider.providerId}
                className={`is-${provider.status}`}
                title={provider.message}
              >
                <strong>{provider.providerName}</strong>
                <em>{providerOutcomeLabel(provider.status)}</em>
              </span>
            ))}
          </div>
        ) : null}
        <div className="lyrics-candidate-list" aria-live="polite">
          {onlineSearch.candidates.map((candidate) => (
            <button
              type="button"
              key={candidate.id}
              onClick={(event) => chooseOnlineSource(candidate, event.detail === 0)}
            >
              <span className="lyrics-candidate-score">{candidate.score.total}</span>
              <span className="lyrics-candidate-copy">
                <strong>{candidate.title}</strong>
                <span>{candidate.artist}{candidate.album ? ` / ${candidate.album}` : ""}</span>
              </span>
              <span className="lyrics-candidate-meta">
                {candidate.providerName} · {candidate.formatHint === "plain" ? "纯文本" : "同步"}
                {candidate.duration ? ` · ${formatDuration(candidate.duration)}` : ""}
              </span>
            </button>
          ))}
        </div>
        <button
          className="lyrics-source-refresh"
          type="button"
          disabled={onlineSearch.status === "loading"}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (onlineSearch.status !== "loading") runSourceAction(onSearchOnline);
          }}
          onClick={(event) => {
            // Pointer input is handled on pointerdown so the action survives
            // controls fading or focus changes between press and release.
            // Keyboard and accessibility activation still arrive as detail 0.
            if (event.detail === 0) runSourceAction(onSearchOnline);
          }}
        >
          {onlineSearch.status === "loading" ? "正在重试…" : "重新搜索"}
        </button>
      </section>
    );
  }

  function settingsPanel() {
    if (!settingsOpen) return null;
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

  useEffect(() => {
    if (status === "loading" || !visible) {
      setSourceBrowserOpen(false);
      setSettingsOpen(false);
    }
  }, [status, visible]);

  useEffect(() => {
    setSettingsOpen(false);
    setExportState({ status: "idle", message: "" });
  }, [document?.trackId, document?.sourceId]);

  useEffect(() => {
    if (!settingsOpen || !settingsKeyboardTransition) return;
    const frame = window.requestAnimationFrame(() => {
      settingsPanelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [settingsKeyboardTransition, settingsOpen]);

  useEffect(() => {
    if (!sourceBrowserOpen || !sourceBrowserKeyboardTransition) return;
    const frame = window.requestAnimationFrame(() => {
      sourceBrowserRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sourceBrowserKeyboardTransition, sourceBrowserOpen]);

  useEffect(() => {
    setSearchMetadataEditing(false);
    if (searchMetadata) setSearchMetadataDraft({ ...searchMetadata });
  }, [searchMetadata?.album, searchMetadata?.artist, searchMetadata?.title]);

  const sourceBrowserElement = sourceBrowser();
  const lastSourceBrowserElement = useLastNonNull(sourceBrowserElement);
  const settingsPanelElement = settingsPanel();
  const lastSettingsPanelElement = useLastNonNull(settingsPanelElement);
  const sourceBrowserSurface = (
    <Presence
      show={sourceBrowserOpen}
      exitDurationMs={sourceBrowserKeyboardTransition ? 0 : MOTION_DURATIONS.micro}
    >
      {sourceBrowserElement ?? lastSourceBrowserElement ?? <span aria-hidden="true" style={{ display: "none" }} />}
    </Presence>
  );
  const settingsPanelSurface = (
    <Presence
      show={settingsOpen}
      exitDurationMs={settingsKeyboardTransition ? 0 : MOTION_DURATIONS.micro}
    >
      {settingsPanelElement ?? lastSettingsPanelElement ?? <span aria-hidden="true" style={{ display: "none" }} />}
    </Presence>
  );

  if (!document) {
    const emptyLabel = status === "loading"
      ? "正在查找歌词"
      : status === "error"
        ? "歌词无法读取"
        : "没有找到歌词";
    return (
      <section className={`lyrics-stage ${visible ? "is-visible" : ""}`} aria-hidden={!visible} aria-label="歌词">
        <div className="lyrics-empty" title={error}>
          <p>{emptyLabel}</p>
          {status !== "loading" && status !== "idle" ? (
            <div className="lyrics-empty-actions">
              {hasOnlineProviders ? (
                <button
                  type="button"
                  onClick={(event) => openOnlineSearch(event.detail === 0)}
                >
                  在线搜索
                </button>
              ) : null}
              <button type="button" onClick={() => runSourceAction(onSelectSource)}>选择本地歌词</button>
              {status === "error" ? <button type="button" onClick={() => runSourceAction(onRetry)}>重试</button> : null}
              {isManualSource ? (
                <button type="button" onClick={() => runSourceAction(onClearManualSource)}>恢复自动查找</button>
              ) : null}
            </div>
          ) : null}
        </div>
        {sourceBrowserSurface}
      </section>
    );
  }

  return (
    <section
      className={`lyrics-stage ${visible ? "is-visible" : ""} ${browsing ? "is-browsing" : ""} ${
        isPlain ? "is-plain" : ""
      } ${
        navigationInput === "keyboard" ? "is-keyboard-browsing" : ""
      }`}
      data-lyrics-font-size={settings.fontSize}
      aria-hidden={!visible}
      aria-label="歌词"
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onPointerDown={() => {
        setNavigationInput("pointer");
        if (settingsOpen) closeSettings();
      }}
    >
      <div
        className="lyrics-source-control"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className="lyrics-source-label" title={sourceLabel}>
          {sourceLabel ?? "本地歌词"}
        </span>
        <button
          ref={settingsTriggerRef}
          className={`lyrics-settings-toggle ${settingsOpen ? "is-open" : ""}`}
          type="button"
          aria-expanded={settingsOpen}
          aria-controls="lyrics-settings-panel"
          onClick={toggleSettings}
        >
          <SlidersHorizontal size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>歌词设置</span>
          {timingOffsetMs !== 0 ? <em aria-label={`已校准 ${formatLyricsTimingOffset(timingOffsetMs)}`} /> : null}
        </button>
      </div>
      {settingsPanelSurface}
      {sourceBrowserSurface}
      <div className="lyrics-lines">
        {lines.map((line, index) => {
          const offset = index - focusIndex;
          const distance = Math.abs(offset);
          const isPlaybackLine = index === activeIndex;
          const isFocusLine = index === focusIndex;
          return (
            <button
              key={line.id}
              type="button"
              ref={(element) => {
                lineButtonRefs.current[index] = element;
              }}
              className={`lyrics-line ${isPlaybackLine ? "is-active" : ""} ${isFocusLine ? "is-focus" : ""}`}
              style={lineStyle(offset, browsing)}
              onClick={isPlain ? undefined : (event) => seekToLine(line, event.detail === 0)}
              onFocus={onInteraction}
              aria-current={isPlaybackLine ? "true" : undefined}
              aria-label={lineAriaLabel(line, isPlain, settings)}
              tabIndex={visible && (isPlain || distance <= 3) ? 0 : -1}
            >
              <span className="lyrics-line-copy">
                {(line.words ?? [{ text: line.text, start: line.start, end: line.end }]).map((word, wordIndex) => {
                  const hasLongNote = Boolean(line.words?.length) && isLyricsLongNote(word);
                  return (
                    <span
                      className={`lyrics-word ${hasLongNote ? "has-long-note" : ""}`}
                      key={`${line.id}-word-${wordIndex}`}
                      ref={hasLongNote ? (element) => {
                        if (!wordMotionRefs.current[index]) wordMotionRefs.current[index] = [];
                        wordMotionRefs.current[index][wordIndex] = element;
                      } : undefined}
                    >
                      <span className="lyrics-word-base">{word.text}</span>
                      <span
                        className="lyrics-word-progress"
                        ref={(element) => {
                          if (!wordProgressRefs.current[index]) wordProgressRefs.current[index] = [];
                          wordProgressRefs.current[index][wordIndex] = element;
                        }}
                        aria-hidden="true"
                      >
                        {word.text}
                      </span>
                      {hasLongNote ? (
                        <span
                          className="lyrics-word-sustain"
                          ref={(element) => {
                            if (!wordSustainRefs.current[index]) wordSustainRefs.current[index] = [];
                            wordSustainRefs.current[index][wordIndex] = element;
                          }}
                          aria-hidden="true"
                        >
                          {word.text}
                        </span>
                      ) : null}
                    </span>
                  );
                })}
              </span>
              {settings.showTranslation && line.translation ? (
                <span className="lyrics-translation">{line.translation}</span>
              ) : null}
              {settings.showTransliteration && line.transliteration ? (
                <span className="lyrics-transliteration">{line.transliteration}</span>
              ) : null}
              {settings.showBackgroundVocals && line.background?.length ? (
                <span className="lyrics-backgrounds" aria-hidden="true">
                  {line.background.map((background, backgroundIndex) => (
                    <span
                      className="lyrics-background-line"
                      key={background.id}
                      ref={(element) => {
                        if (!backgroundLineRefs.current[index]) backgroundLineRefs.current[index] = [];
                        backgroundLineRefs.current[index][backgroundIndex] = element;
                      }}
                    >
                      <span className="lyrics-background-copy">
                        {(background.words ?? [{
                          text: background.text,
                          start: background.start,
                          end: background.end,
                        }]).map((word, wordIndex) => (
                          <span className="lyrics-word" key={`${background.id}-word-${wordIndex}`}>
                            <span className="lyrics-word-base">{word.text}</span>
                            <span
                              className="lyrics-word-progress"
                              ref={(element) => {
                                if (!backgroundWordProgressRefs.current[index]) {
                                  backgroundWordProgressRefs.current[index] = [];
                                }
                                if (!backgroundWordProgressRefs.current[index][backgroundIndex]) {
                                  backgroundWordProgressRefs.current[index][backgroundIndex] = [];
                                }
                                backgroundWordProgressRefs.current[index][backgroundIndex][wordIndex] = element;
                              }}
                            >
                              {word.text}
                            </span>
                          </span>
                        ))}
                      </span>
                      {settings.showTranslation && background.translation ? (
                        <span className="lyrics-background-translation">{background.translation}</span>
                      ) : null}
                      {settings.showTransliteration && background.transliteration ? (
                        <span className="lyrics-background-transliteration">{background.transliteration}</span>
                      ) : null}
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function formatDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function providerOutcomeLabel(status: LyricsOnlineSearchState["providers"][number]["status"]) {
  if (status === "ready") return "有结果";
  if (status === "empty") return "未找到";
  return "失败";
}

function fontSizeLabel(fontSize: LyricsFontSize) {
  if (fontSize === "small") return "小";
  if (fontSize === "large") return "大";
  return "标准";
}

function fileName(path: string) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
