import { SlidersHorizontal } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent,
} from "react";
import type { LyricsCandidate, LyricsDocument, LyricsLine, LyricsSearchMetadata } from "../types";
import type { LyricsOnlineSearchState } from "../hooks/useLyrics";
import { useLyricsDisplaySettings } from "../hooks/useLyricsDisplaySettings";
import type { LyricsExportFormat } from "../utils/lyricsExport";
import { isLyricsLongNote } from "../utils/lyricsMotion";
import {
  formatLyricsTimingOffset,
  lyricsTimeToMediaTime,
  mediaTimeToLyricsTime,
} from "../utils/lyricsTiming";
import { Presence, useLastNonNull } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import {
  BROWSE_RETURN_DELAY,
  WHEEL_STEP_THRESHOLD,
  lineAriaLabel,
  lineStyle,
} from "./lyricsStage/lyricsLineUtils";
import { LyricsSettingsPanel } from "./lyricsStage/LyricsSettingsPanel";
import { LyricsSourceBrowser } from "./lyricsStage/LyricsSourceBrowser";
import { useLyricsPaintLoop } from "./lyricsStage/useLyricsPaintLoop";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsKeyboardTransition, setSettingsKeyboardTransition] = useState(false);
  const { settings, setFontSize, setDisplayOption } = useLyricsDisplaySettings();
  const [navigationInput, setNavigationInput] = useState<"pointer" | "keyboard">("pointer");
  const returnTimerRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const settingsPanelRef = useRef<HTMLElement | null>(null);
  const sourceBrowserRef = useRef<HTMLElement | null>(null);
  const lineButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lines = document?.lines ?? [];
  const isPlain = document?.format === "plain";
  const lyricsProgress = mediaTimeToLyricsTime(progress, timingOffsetMs);
  const {
    activeIndex,
    wordProgressRefs,
    wordMotionRefs,
    wordSustainRefs,
    backgroundLineRefs,
    backgroundWordProgressRefs,
  } = useLyricsPaintLoop({
    document,
    isPlain,
    lines,
    lyricsProgress,
    timingOffsetMs,
    playbackClock,
    isPlaying,
    visible,
  });
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
  }, [document?.trackId, document?.sourceId, isPlain, visible]);

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

  function chooseOnlineSource(candidate: LyricsCandidate, keyboardInitiated: boolean) {
    setSourceBrowserKeyboardTransition(keyboardInitiated);
    onInteraction();
    void Promise.resolve(onSelectOnlineSource(candidate)).then(() => setSourceBrowserOpen(false));
  }

  useEffect(() => {
    if (status === "loading" || !visible) {
      setSourceBrowserOpen(false);
      setSettingsOpen(false);
    }
  }, [status, visible]);

  useEffect(() => {
    setSettingsOpen(false);
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

  const sourceBrowserElement = sourceBrowserOpen ? (
    <LyricsSourceBrowser
      sourceBrowserOrigin={sourceBrowserOrigin}
      sourceBrowserKeyboardTransition={sourceBrowserKeyboardTransition}
      onlineSearch={onlineSearch}
      searchMetadata={searchMetadata}
      hasSearchMetadataOverride={hasSearchMetadataOverride}
      sourceBrowserRef={sourceBrowserRef}
      onClose={closeSourceBrowser}
      onPointerInteraction={() => setSourceBrowserKeyboardTransition(false)}
      onSelectCandidate={chooseOnlineSource}
      onUpdateSearchMetadata={onUpdateSearchMetadata}
      onResetSearchMetadata={onResetSearchMetadata}
      onSearchOnline={onSearchOnline}
      runSourceAction={runSourceAction}
      onInteraction={onInteraction}
    />
  ) : null;
  const lastSourceBrowserElement = useLastNonNull(sourceBrowserElement);
  const settingsPanelElement = settingsOpen ? (
    <LyricsSettingsPanel
      settingsKeyboardTransition={settingsKeyboardTransition}
      setSettingsKeyboardTransition={setSettingsKeyboardTransition}
      settings={settings}
      setFontSize={setFontSize}
      setDisplayOption={setDisplayOption}
      displayAvailability={displayAvailability}
      isPlain={isPlain}
      isDemoSource={isDemoSource}
      isManualSource={isManualSource}
      hasOnlineProviders={hasOnlineProviders}
      sourceLabel={sourceLabel}
      timingOffsetMs={timingOffsetMs}
      settingsPanelRef={settingsPanelRef}
      closeSettings={closeSettings}
      openOnlineSearch={openOnlineSearch}
      runSettingsSourceAction={runSettingsSourceAction}
      onSelectSource={onSelectSource}
      onClearManualSource={onClearManualSource}
      onAdjustTimingOffset={onAdjustTimingOffset}
      onResetTimingOffset={onResetTimingOffset}
      onExportLyrics={onExportLyrics}
      onInteraction={onInteraction}
    />
  ) : null;
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

  const attachStage = useCallback((element: HTMLElement | null) => {
    element?.toggleAttribute("inert", !visible);
  }, [visible]);

  if (!document) {
    const emptyLabel = status === "loading"
      ? "正在查找歌词"
      : status === "error"
        ? "歌词无法读取"
        : "没有找到歌词";
    return (
      <section ref={attachStage} className={`lyrics-stage ${visible ? "is-visible" : ""}`} aria-hidden={!visible} aria-label="歌词">
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
      ref={attachStage}
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
