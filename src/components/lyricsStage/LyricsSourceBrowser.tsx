import { useEffect, useState, type FormEvent, type RefObject } from "react";
import type { LyricsCandidate, LyricsSearchMetadata } from "../../types";
import type { LyricsOnlineSearchState } from "../../hooks/useLyrics";
import { formatDuration, providerOutcomeLabel } from "./lyricsLineUtils";

/**
 * Online lyrics search surface. Rendered by LyricsStage only while open and
 * kept alive through its Presence exit, so the metadata editing state can
 * live here: it resets whenever the panel unmounts after closing.
 */
export function LyricsSourceBrowser({
  sourceBrowserOrigin,
  sourceBrowserKeyboardTransition,
  onlineSearch,
  searchMetadata,
  hasSearchMetadataOverride,
  sourceBrowserRef,
  onClose,
  onPointerInteraction,
  onSelectCandidate,
  onUpdateSearchMetadata,
  onResetSearchMetadata,
  onSearchOnline,
  runSourceAction,
  onInteraction,
}: {
  sourceBrowserOrigin: "stage" | "settings";
  sourceBrowserKeyboardTransition: boolean;
  onlineSearch: LyricsOnlineSearchState;
  searchMetadata: LyricsSearchMetadata | null;
  hasSearchMetadataOverride: boolean;
  sourceBrowserRef: RefObject<HTMLElement>;
  onClose: (keyboardInitiated?: boolean) => void;
  onPointerInteraction: () => void;
  onSelectCandidate: (candidate: LyricsCandidate, keyboardInitiated: boolean) => void;
  onUpdateSearchMetadata: (metadata: LyricsSearchMetadata) => boolean;
  onResetSearchMetadata: () => void;
  onSearchOnline: () => void | Promise<void>;
  runSourceAction: (action: () => void | Promise<void>) => void;
  onInteraction: () => void;
}) {
  const [searchMetadataEditing, setSearchMetadataEditing] = useState(false);
  const [searchMetadataDraft, setSearchMetadataDraft] = useState<LyricsSearchMetadata>({
    title: "",
    artist: "",
    album: "",
  });

  useEffect(() => {
    setSearchMetadataEditing(false);
    if (searchMetadata) setSearchMetadataDraft({ ...searchMetadata });
  }, [searchMetadata?.album, searchMetadata?.artist, searchMetadata?.title]);

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
          onClose(true);
        }
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerInteraction();
      }}
    >
      <header>
        <div>
          <span>歌词来源</span>
          <h2>在线搜索</h2>
        </div>
        <button type="button" onClick={(event) => onClose(event.detail === 0)}>
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
            onClick={(event) => onSelectCandidate(candidate, event.detail === 0)}
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
