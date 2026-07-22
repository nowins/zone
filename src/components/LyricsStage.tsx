import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type WheelEvent } from "react";
import type { LyricsCandidate, LyricsDocument, LyricsLine, LyricsSearchMetadata, LyricsWord } from "../types";
import type { LyricsOnlineSearchState } from "../hooks/useLyrics";
import {
  formatLyricsTimingOffset,
  LYRICS_TIMING_STEP_MS,
  lyricsTimeToMediaTime,
  mediaTimeToLyricsTime,
} from "../utils/lyricsTiming";

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

function lineAriaLabel(line: LyricsLine, isPlain: boolean) {
  if (isPlain) return line.text;
  const supportingText = [
    line.translation,
    line.transliteration,
    ...(line.background ?? []).flatMap((background) => [
      `背景人声：${background.text}`,
      background.translation,
      background.transliteration,
    ]),
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
  onSelectOnlineSource: (candidate: LyricsCandidate) => void | Promise<void>;
  onClearManualSource: () => void;
  onRetry: () => void;
  onAdjustTimingOffset: (deltaMs: number) => void;
  onResetTimingOffset: () => void;
  onInteraction: () => void;
}) {
  const [browseIndex, setBrowseIndex] = useState<number | null>(null);
  const [sourceBrowserOpen, setSourceBrowserOpen] = useState(false);
  const [searchMetadataEditing, setSearchMetadataEditing] = useState(false);
  const [searchMetadataDraft, setSearchMetadataDraft] = useState<LyricsSearchMetadata>({
    title: "",
    artist: "",
    album: "",
  });
  const [timingControlOpen, setTimingControlOpen] = useState(false);
  const [navigationInput, setNavigationInput] = useState<"pointer" | "keyboard">("pointer");
  const returnTimerRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const lineButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const wordProgressRefs = useRef<Array<Array<HTMLSpanElement | null>>>([]);
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

  function openOnlineSearch() {
    setSourceBrowserOpen(true);
    setSearchMetadataEditing(false);
    runSourceAction(onSearchOnline);
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

  function chooseOnlineSource(candidate: LyricsCandidate) {
    onInteraction();
    void Promise.resolve(onSelectOnlineSource(candidate)).then(() => setSourceBrowserOpen(false));
  }

  function sourceBrowser() {
    if (!sourceBrowserOpen) return null;
    const message = onlineSearch.status === "loading"
      ? `正在联系已启用的来源${onlineSearch.attempt > 1 ? `（第 ${onlineSearch.attempt} 次）` : ""}…`
      : onlineSearch.status === "error"
        ? onlineSearch.errors[0] ?? "在线歌词暂时不可用"
        : onlineSearch.candidates.length === 0
          ? "没有找到足够接近的结果"
          : `${onlineSearch.candidates.length} 个候选，按匹配度排列`;
    return (
      <section
        className={`lyrics-source-browser ${onlineSearch.status === "loading" ? "is-searching" : ""}`}
        aria-label="在线歌词候选"
        aria-busy={onlineSearch.status === "loading"}
        onWheel={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>歌词来源</span>
            <h2>在线搜索</h2>
          </div>
          <button type="button" onClick={() => setSourceBrowserOpen(false)}>关闭</button>
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
        <div className="lyrics-candidate-list" aria-live="polite">
          {onlineSearch.candidates.map((candidate) => (
            <button type="button" key={candidate.id} onClick={() => chooseOnlineSource(candidate)}>
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

  useEffect(() => {
    if (status === "loading" || !visible) {
      setSourceBrowserOpen(false);
      setTimingControlOpen(false);
    }
  }, [status, visible]);

  useEffect(() => setTimingControlOpen(false), [document?.trackId, document?.sourceId]);

  useEffect(() => {
    setSearchMetadataEditing(false);
    if (searchMetadata) setSearchMetadataDraft({ ...searchMetadata });
  }, [searchMetadata?.album, searchMetadata?.artist, searchMetadata?.title]);

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
                <button type="button" onClick={openOnlineSearch}>在线搜索</button>
              ) : null}
              <button type="button" onClick={() => runSourceAction(onSelectSource)}>选择本地歌词</button>
              {status === "error" ? <button type="button" onClick={() => runSourceAction(onRetry)}>重试</button> : null}
              {isManualSource ? (
                <button type="button" onClick={() => runSourceAction(onClearManualSource)}>恢复自动查找</button>
              ) : null}
            </div>
          ) : null}
        </div>
        {sourceBrowser()}
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
      aria-hidden={!visible}
      aria-label="歌词"
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onPointerDown={() => setNavigationInput("pointer")}
    >
      <div className="lyrics-source-control">
        <span title={sourceLabel}>{sourceLabel ?? "本地歌词"}</span>
        {!isPlain && !isDemoSource ? (
          <div className={`lyrics-timing-control ${timingControlOpen ? "is-open" : ""}`}>
            <button
              className="lyrics-timing-toggle"
              type="button"
              aria-expanded={timingControlOpen}
              onClick={() => {
                onInteraction();
                setTimingControlOpen((open) => !open);
              }}
            >
              {timingOffsetMs === 0 ? "校准" : formatLyricsTimingOffset(timingOffsetMs)}
            </button>
            {timingControlOpen ? (
              <div
                className="lyrics-timing-popover"
                role="group"
                aria-label="歌词时间校准"
                onWheel={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <span>歌词时间</span>
                <button
                  type="button"
                  title="歌词出现得太晚"
                  onClick={() => {
                    onInteraction();
                    onAdjustTimingOffset(-LYRICS_TIMING_STEP_MS);
                  }}
                >
                  提前
                </button>
                <output aria-live="polite">{formatLyricsTimingOffset(timingOffsetMs)}</output>
                <button
                  type="button"
                  title="歌词出现得太早"
                  onClick={() => {
                    onInteraction();
                    onAdjustTimingOffset(LYRICS_TIMING_STEP_MS);
                  }}
                >
                  延后
                </button>
                <button
                  className="lyrics-timing-reset"
                  type="button"
                  disabled={timingOffsetMs === 0}
                  onClick={() => {
                    onInteraction();
                    onResetTimingOffset();
                  }}
                >
                  重置
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {hasOnlineProviders ? <button type="button" onClick={openOnlineSearch}>在线搜索</button> : null}
        <button type="button" onClick={() => runSourceAction(onSelectSource)}>
          {isDemoSource ? "选择本地歌词" : "更换文件"}
        </button>
        {isManualSource ? (
          <button type="button" onClick={() => runSourceAction(onClearManualSource)}>恢复自动</button>
        ) : null}
      </div>
      {sourceBrowser()}
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
              aria-label={lineAriaLabel(line, isPlain)}
              tabIndex={visible && (isPlain || distance <= 3) ? 0 : -1}
            >
              <span className="lyrics-line-copy">
                {(line.words ?? [{ text: line.text, start: line.start, end: line.end }]).map((word, wordIndex) => (
                  <span className="lyrics-word" key={`${line.id}-word-${wordIndex}`}>
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
                  </span>
                ))}
              </span>
              {line.translation ? <span className="lyrics-translation">{line.translation}</span> : null}
              {line.transliteration ? (
                <span className="lyrics-transliteration">{line.transliteration}</span>
              ) : null}
              {line.background?.length ? (
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
                      {background.translation ? (
                        <span className="lyrics-background-translation">{background.translation}</span>
                      ) : null}
                      {background.transliteration ? (
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
