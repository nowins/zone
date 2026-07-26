import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowLeft,
  Bookmark,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Gauge,
  GripVertical,
  ListMusic,
  LoaderCircle,
  Pause,
  Play,
  Podcast,
  RotateCcw,
  RotateCw,
  SkipForward,
  X,
} from "lucide-react";
import { PlaybackProgress } from "../components/PlaybackProgress";
import { VolumeControl } from "../components/TransportControls";
import { Presence, useLastNonNull } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import type {
  PodcastPlayback,
  PodcastPlaybackStatus,
  PodcastQueueItem,
  PodcastSleepTimer,
} from "../types";
import { formatTime } from "../utils/music";
import { podcastArtworkSrc } from "../utils/podcastArtwork";

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
const SLEEP_MINUTES = [15, 30, 45, 60] as const;

type PodcastNowMenu = "rate" | "sleep" | null;
type PodcastQueueDropPlacement = "before" | "after";

type PodcastQueueDropTarget = {
  episodeId: string;
  placement: PodcastQueueDropPlacement;
};

export function PodcastNowPlayingView({
  episode,
  queue,
  status,
  isPlaying,
  progress,
  duration,
  volume,
  playbackRate,
  sleepTimer,
  onBack,
  onPlayPause,
  onSeek,
  onVolume,
  onPlaybackRate,
  onSleepTimer,
  onPlayQueueItem,
  onRemoveQueueItem,
  onMoveQueueItem,
  onReorderQueueItem,
  onClearQueue,
  onOpenEpisode,
  onToggleSaved,
  onNext,
  onRetry,
}: {
  episode: PodcastPlayback;
  queue: PodcastQueueItem[];
  status: PodcastPlaybackStatus;
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  playbackRate: number;
  sleepTimer: PodcastSleepTimer;
  onBack: () => void;
  onPlayPause: () => void;
  onSeek: (value: number) => void;
  onVolume: (value: number) => void;
  onPlaybackRate: (value: number) => void;
  onSleepTimer: (timer: PodcastSleepTimer) => void;
  onPlayQueueItem: (episodeId: string) => void;
  onRemoveQueueItem: (episodeId: string) => void;
  onMoveQueueItem: (episodeId: string, direction: -1 | 1) => void;
  onReorderQueueItem: (
    episodeId: string,
    targetEpisodeId: string,
    placement: PodcastQueueDropPlacement,
  ) => void;
  onClearQueue: () => void;
  onOpenEpisode: () => void;
  onToggleSaved: () => void;
  onNext: () => void;
  onRetry: () => void;
}) {
  const [activeMenu, setActiveMenu] = useState<PodcastNowMenu>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [draggedQueueEpisodeId, setDraggedQueueEpisodeId] = useState<string | null>(null);
  const [queueDropTarget, setQueueDropTarget] = useState<PodcastQueueDropTarget | null>(null);
  const [queueAnnouncement, setQueueAnnouncement] = useState("");
  const rateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sleepTriggerRef = useRef<HTMLButtonElement | null>(null);
  const queueTriggerRef = useRef<HTMLButtonElement | null>(null);
  const queueCloseRef = useRef<HTMLButtonElement | null>(null);
  const rateMenuRef = useRef<HTMLDivElement | null>(null);
  const sleepMenuRef = useRef<HTMLDivElement | null>(null);
  const artworkUrl = episode.artworkUrl ?? episode.feedArtworkUrl;
  const artworkSrc = podcastArtworkSrc(artworkUrl);
  const description = useMemo(
    () => podcastDescriptionText(episode.description),
    [episode.description],
  );
  const orderedQueue = useMemo(
    () => queue
      .filter((item) => item.episode.id !== episode.episodeId)
      .sort((left, right) => (
        left.position - right.position || left.addedAt - right.addedAt
      )),
    [episode.episodeId, queue],
  );
  const mediaDuration = Number.isFinite(duration) && duration > 0
    ? duration
    : Math.max(0, episode.durationSeconds ?? 0);
  const safeProgress = Math.max(0, Number.isFinite(progress) ? progress : 0);
  const sleepLabel = formatSleepTimer(sleepTimer, clockNow);
  const statusLabel = playbackStatusLabel(status);

  useEffect(() => {
    setDescriptionExpanded(false);
    setActiveMenu(null);
    setDraggedQueueEpisodeId(null);
    setQueueDropTarget(null);
  }, [episode.episodeId]);

  useEffect(() => {
    if (sleepTimer?.kind !== "deadline") return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [sleepTimer]);

  useEffect(() => {
    if (!activeMenu) return;
    const frame = window.requestAnimationFrame(() => {
      const menu = activeMenu === "rate"
        ? rateMenuRef.current
        : sleepMenuRef.current;
      const items = menu
        ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'))
        : [];
      const selected = items.find((item) =>
        item.getAttribute("aria-checked") === "true"
        || item.classList.contains("active")
      );
      (selected ?? items[0])?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeMenu]);

  useEffect(() => {
    if (!queueOpen) return;
    const frame = window.requestAnimationFrame(() => {
      queueCloseRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [queueOpen]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (activeMenu) {
        event.preventDefault();
        closeActiveMenu(true);
        return;
      }
      if (queueOpen) {
        event.preventDefault();
        closeQueue(true);
        return;
      }
      onBack();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeMenu, onBack, queueOpen]);

  function closeActiveMenu(restoreFocus = false) {
    const menu = activeMenu;
    setActiveMenu(null);
    if (!restoreFocus || !menu) return;
    window.requestAnimationFrame(() => {
      (menu === "rate" ? rateTriggerRef.current : sleepTriggerRef.current)?.focus();
    });
  }

  function closeQueue(restoreFocus = false) {
    setQueueOpen(false);
    setDraggedQueueEpisodeId(null);
    setQueueDropTarget(null);
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => queueTriggerRef.current?.focus());
  }

  function resetQueueDrag() {
    setDraggedQueueEpisodeId(null);
    setQueueDropTarget(null);
  }

  function handleQueueDragStart(
    event: ReactDragEvent<HTMLSpanElement>,
    episodeId: string,
  ) {
    const row = event.currentTarget.closest("li");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", episodeId);
    if (row) {
      event.dataTransfer.setDragImage(
        row,
        Math.min(24, row.clientWidth / 2),
        row.clientHeight / 2,
      );
    }
    setDraggedQueueEpisodeId(episodeId);
    setQueueDropTarget(null);
    setQueueAnnouncement("");
  }

  function queueDropPlacement(
    event: ReactDragEvent<HTMLLIElement>,
  ): PodcastQueueDropPlacement {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
  }

  function handleQueueDragOver(
    event: ReactDragEvent<HTMLLIElement>,
    targetEpisodeId: string,
  ) {
    if (!draggedQueueEpisodeId || draggedQueueEpisodeId === targetEpisodeId) {
      setQueueDropTarget(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const placement = queueDropPlacement(event);
    setQueueDropTarget((current) => (
      current?.episodeId === targetEpisodeId && current.placement === placement
        ? current
        : { episodeId: targetEpisodeId, placement }
    ));
  }

  function handleQueueDrop(
    event: ReactDragEvent<HTMLLIElement>,
    targetEpisodeId: string,
  ) {
    event.preventDefault();
    const sourceEpisodeId = draggedQueueEpisodeId
      ?? event.dataTransfer.getData("text/plain");
    const placement = queueDropPlacement(event);
    const sourceIndex = orderedQueue.findIndex(
      (item) => item.episode.id === sourceEpisodeId,
    );
    const targetIndex = orderedQueue.findIndex(
      (item) => item.episode.id === targetEpisodeId,
    );
    if (
      sourceIndex >= 0
      && targetIndex >= 0
      && sourceEpisodeId !== targetEpisodeId
    ) {
      let destinationIndex = targetIndex + (placement === "after" ? 1 : 0);
      if (sourceIndex < destinationIndex) destinationIndex -= 1;
      if (destinationIndex !== sourceIndex) {
        onReorderQueueItem(sourceEpisodeId, targetEpisodeId, placement);
        const draggedEpisode = orderedQueue[sourceIndex]?.episode;
        setQueueAnnouncement(
          `已将“${draggedEpisode?.title ?? "单集"}”移到第 ${destinationIndex + 1} 位`,
        );
      }
    }
    resetQueueDrag();
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'),
    );
    if (items.length === 0) return;
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeActiveMenu(true);
      return;
    } else if (event.key === "Tab") {
      setActiveMenu(null);
      return;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  const rateMenuElement = activeMenu === "rate" ? (
    <div
      ref={rateMenuRef}
      id="podcast-rate-menu"
      className="podcast-now-popover podcast-rate-popover"
      role="menu"
      aria-label="播放速度"
      onKeyDown={handleMenuKeyDown}
    >
      <strong>播放速度</strong>
      <div className="podcast-rate-options">
        {PLAYBACK_RATES.map((rate) => (
          <button
            key={rate}
            type="button"
            role="menuitemradio"
            tabIndex={-1}
            aria-checked={playbackRate === rate}
            className={playbackRate === rate ? "active" : ""}
            onClick={() => {
              onPlaybackRate(rate);
              closeActiveMenu(true);
            }}
          >
            <span>{formatPlaybackRate(rate)}</span>
            {playbackRate === rate ? <Check size={14} aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
    </div>
  ) : null;

  const sleepMenuElement = activeMenu === "sleep" ? (
    <div
      ref={sleepMenuRef}
      id="podcast-sleep-menu"
      className="podcast-now-popover podcast-sleep-popover"
      role="menu"
      aria-label="睡眠定时器"
      onKeyDown={handleMenuKeyDown}
    >
      <strong>睡眠定时器</strong>
      <div className="podcast-sleep-options">
        {SLEEP_MINUTES.map((minutes) => (
          <button
            key={minutes}
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              onSleepTimer({
                kind: "deadline",
                deadlineAt: Date.now() + minutes * 60_000,
              });
              closeActiveMenu(true);
            }}
          >
            {minutes} 分钟
          </button>
        ))}
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={sleepTimer?.kind === "episodeEnd" ? "active" : ""}
          onClick={() => {
            onSleepTimer({
              kind: "episodeEnd",
              episodeId: episode.episodeId,
            });
            closeActiveMenu(true);
          }}
        >
          <span>本集结束</span>
          {sleepTimer?.kind === "episodeEnd" ? <Check size={14} aria-hidden="true" /> : null}
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={!sleepTimer ? "active" : ""}
          onClick={() => {
            onSleepTimer(null);
            closeActiveMenu(true);
          }}
        >
          <span>关闭</span>
          {!sleepTimer ? <Check size={14} aria-hidden="true" /> : null}
        </button>
      </div>
    </div>
  ) : null;

  const queuePanelElement = queueOpen ? (
    <aside
      id="podcast-now-queue"
      className="podcast-now-queue"
      aria-labelledby="podcast-now-queue-title"
    >
      <header>
        <div>
          <ListMusic size={16} aria-hidden="true" />
          <h2 id="podcast-now-queue-title">待播</h2>
          {orderedQueue.length > 0 ? <span>{orderedQueue.length}</span> : null}
        </div>
        <div className="podcast-now-queue-header-actions">
          {orderedQueue.length > 0 ? (
            <button type="button" onClick={onClearQueue}>
              清空
            </button>
          ) : null}
          <button
            ref={queueCloseRef}
            type="button"
            className="podcast-now-queue-close"
            onClick={() => closeQueue(true)}
            aria-label="关闭待播列表"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {orderedQueue.length > 0 ? (
        <>
          <p
            id="podcast-now-queue-reorder-help"
            className="podcast-now-queue-reorder-help"
          >
            拖动把手调整顺序，也可使用上移和下移按钮。
          </p>
          <output
            className="podcast-now-queue-announcement"
            aria-live="polite"
          >
            {queueAnnouncement}
          </output>
          <ol
            className="podcast-now-queue-list"
            aria-describedby="podcast-now-queue-reorder-help"
          >
            {orderedQueue.map((item, index) => {
              const queuedEpisode = item.episode;
              const dropPlacement = queueDropTarget?.episodeId === queuedEpisode.id
                ? queueDropTarget.placement
                : undefined;
              return (
                <li
                  key={queuedEpisode.id}
                  className={[
                    draggedQueueEpisodeId === queuedEpisode.id ? "is-dragging" : "",
                    dropPlacement ? "is-drop-target" : "",
                  ].filter(Boolean).join(" ")}
                  data-drop-position={dropPlacement}
                  onDragOver={(event) => handleQueueDragOver(event, queuedEpisode.id)}
                  onDrop={(event) => handleQueueDrop(event, queuedEpisode.id)}
                >
                  <span
                    className="podcast-now-queue-drag"
                    draggable={orderedQueue.length > 1}
                    aria-hidden="true"
                    data-disabled={orderedQueue.length < 2}
                    title="拖动排序"
                    onDragStart={(event) => handleQueueDragStart(event, queuedEpisode.id)}
                    onDragEnd={resetQueueDrag}
                  >
                    <GripVertical size={15} aria-hidden="true" />
                  </span>
                  <button
                    type="button"
                    className="podcast-now-queue-select"
                    onClick={() => {
                      onPlayQueueItem(queuedEpisode.id);
                      closeQueue(true);
                    }}
                    title={`播放“${queuedEpisode.title}”`}
                  >
                    <span>{index + 1}</span>
                    <span>
                      <strong>{queuedEpisode.title}</strong>
                      <small>
                        {queuedEpisode.feedTitle || "播客"}
                        {queuedEpisode.durationSeconds
                          ? ` · ${formatTime(queuedEpisode.durationSeconds)}`
                          : ""}
                      </small>
                    </span>
                  </button>
                  <div className="podcast-now-queue-actions">
                    <button
                      type="button"
                      onClick={() => {
                        onMoveQueueItem(queuedEpisode.id, -1);
                        setQueueAnnouncement(
                          `已将“${queuedEpisode.title}”移到第 ${index} 位`,
                        );
                      }}
                      disabled={index === 0}
                      aria-label={`上移“${queuedEpisode.title}”`}
                      title="上移"
                    >
                      <ChevronUp size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onMoveQueueItem(queuedEpisode.id, 1);
                        setQueueAnnouncement(
                          `已将“${queuedEpisode.title}”移到第 ${index + 2} 位`,
                        );
                      }}
                      disabled={index === orderedQueue.length - 1}
                      aria-label={`下移“${queuedEpisode.title}”`}
                      title="下移"
                    >
                      <ChevronDown size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveQueueItem(queuedEpisode.id)}
                      aria-label={`从待播移除“${queuedEpisode.title}”`}
                      title="从待播移除"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <div className="podcast-now-queue-empty">
          <span>待播列表为空</span>
          <small>从单集菜单加入接下来播放的内容</small>
        </div>
      )}

      {orderedQueue.length > 0 ? (
        <button className="podcast-now-next" type="button" onClick={onNext}>
          <SkipForward size={14} />
          播放下一集
        </button>
      ) : null}
    </aside>
  ) : null;

  const lastRateMenuElement = useLastNonNull(rateMenuElement);
  const lastSleepMenuElement = useLastNonNull(sleepMenuElement);
  const lastQueuePanelElement = useLastNonNull(queuePanelElement);

  return (
    <section
      className="podcast-now-playing-stage"
      data-status={status}
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (!target.closest(".podcast-now-menu-anchor")) setActiveMenu(null);
      }}
    >
      <div className="podcast-now-backdrop" aria-hidden="true">
        {artworkSrc ? <img src={artworkSrc} alt="" draggable={false} /> : null}
      </div>
      <div className="podcast-now-grade" aria-hidden="true" />
      <p className="podcast-now-ghost" aria-hidden="true">podcast</p>

      <button className="podcast-now-back" type="button" onClick={onBack} title="返回">
        <ArrowLeft size={35} strokeWidth={2.45} />
      </button>

      <button
        ref={queueTriggerRef}
        type="button"
        className="podcast-now-queue-trigger"
        aria-controls="podcast-now-queue"
        aria-expanded={queueOpen}
        onClick={() => {
          setActiveMenu(null);
          setQueueOpen((current) => !current);
        }}
      >
        <ListMusic size={16} aria-hidden="true" />
        <span>待播</span>
        {orderedQueue.length > 0 ? <em>{orderedQueue.length}</em> : null}
      </button>

      <main className="podcast-now-main">
        <div className="podcast-now-artwork">
          {artworkSrc ? (
            <img src={artworkSrc} alt="" draggable={false} />
          ) : (
            <span aria-hidden="true"><Podcast size={54} strokeWidth={1.25} /></span>
          )}
        </div>

        <section className="podcast-now-copy" aria-labelledby="podcast-now-title">
          <div className="podcast-now-eyebrow">
            <button type="button" onClick={onOpenEpisode}>{episode.podcastTitle}</button>
            {episode.publishedAt ? <span>{formatEpisodeDate(episode.publishedAt)}</span> : null}
          </div>
          <h1 id="podcast-now-title">{episode.title}</h1>
          <div className="podcast-now-meta">
            {episode.completed ? <span>已播放</span> : null}
            {episode.localPath ? <span>已下载</span> : null}
            {mediaDuration > 0 ? <span>{formatTime(mediaDuration)}</span> : null}
          </div>

          {description ? (
            <div
              className={`podcast-now-description${descriptionExpanded ? " expanded" : ""}`}
            >
              <p>{description}</p>
              <button
                type="button"
                aria-expanded={descriptionExpanded}
                onClick={() => setDescriptionExpanded((current) => !current)}
              >
                {descriptionExpanded ? "收起简介" : "展开简介"}
              </button>
            </div>
          ) : (
            <button className="podcast-now-open-episode" type="button" onClick={onOpenEpisode}>
              查看单集信息
            </button>
          )}

          <div className="podcast-now-copy-actions">
            <button type="button" onClick={onOpenEpisode}>单集信息</button>
            <button
              type="button"
              className={episode.saved ? "active" : ""}
              aria-pressed={episode.saved}
              onClick={onToggleSaved}
            >
              <Bookmark size={14} fill={episode.saved ? "currentColor" : "none"} />
              {episode.saved ? "已存储" : "存储"}
            </button>
          </div>
        </section>
      </main>

      <Presence show={queuePanelElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {queuePanelElement
          ?? lastQueuePanelElement
          ?? <span style={{ display: "none" }} />}
      </Presence>

      <footer className="podcast-now-transport">
        <PlaybackProgress
          label={`${episode.title} · ${episode.podcastTitle}`}
          progress={safeProgress}
          duration={mediaDuration}
          onLabelClick={onOpenEpisode}
          onSeek={onSeek}
        />

        <div className="podcast-now-transport-row">
          <div className="podcast-now-secondary-controls">
            <div className="podcast-now-menu-anchor">
              <button
                ref={rateTriggerRef}
                type="button"
                className={activeMenu === "rate" ? "active" : ""}
                aria-haspopup="menu"
                aria-controls="podcast-rate-menu"
                aria-expanded={activeMenu === "rate"}
                onClick={() =>
                  setActiveMenu((current) => current === "rate" ? null : "rate")
                }
              >
                <Gauge size={14} />
                {formatPlaybackRate(playbackRate)}
              </button>
              <Presence show={rateMenuElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
                {rateMenuElement ?? lastRateMenuElement ?? <span style={{ display: "none" }} />}
              </Presence>
            </div>

            <div className="podcast-now-menu-anchor">
              <button
                ref={sleepTriggerRef}
                type="button"
                className={sleepTimer ? "active" : ""}
                aria-haspopup="menu"
                aria-controls="podcast-sleep-menu"
                aria-expanded={activeMenu === "sleep"}
                onClick={() =>
                  setActiveMenu((current) => current === "sleep" ? null : "sleep")
                }
              >
                <Clock3 size={14} />
                {sleepLabel}
              </button>
              <Presence show={sleepMenuElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
                {sleepMenuElement ?? lastSleepMenuElement ?? <span style={{ display: "none" }} />}
              </Presence>
            </div>
          </div>

          <div className="podcast-now-primary-controls">
            <button
              type="button"
              onClick={() => onSeek(Math.max(0, safeProgress - 15))}
              title="后退 15 秒"
            >
              <RotateCcw size={20} />
              <span>15</span>
            </button>
            <button
              type="button"
              className="podcast-now-play"
              onClick={status === "error" ? onRetry : onPlayPause}
              title={status === "error" ? "重试播放" : isPlaying ? "暂停" : "播放"}
            >
              {status === "loading" || status === "buffering" ? (
                <LoaderCircle className="podcast-now-spinner" size={25} />
              ) : isPlaying ? (
                <Pause size={26} fill="currentColor" />
              ) : (
                <Play size={26} fill="currentColor" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onSeek(Math.min(mediaDuration || safeProgress + 30, safeProgress + 30))}
              title="前进 30 秒"
            >
              <RotateCw size={20} />
              <span>30</span>
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={orderedQueue.length === 0}
              title="下一集"
            >
              <SkipForward size={18} />
            </button>
          </div>

          <div className="podcast-now-volume">
            <VolumeControl volume={volume} onVolume={onVolume} />
          </div>
        </div>

        {statusLabel ? (
          <div
            className={`podcast-now-status${status === "error" ? " error" : ""}`}
            role={status === "error" ? "alert" : "status"}
          >
            {status === "loading" || status === "buffering"
              ? <LoaderCircle className="podcast-now-spinner" size={13} />
              : null}
            <span>{statusLabel}</span>
            {status === "error" ? (
              <button type="button" onClick={onRetry}>重试</button>
            ) : null}
          </div>
        ) : null}
      </footer>
    </section>
  );
}

function playbackStatusLabel(status: PodcastPlaybackStatus) {
  if (status === "loading") return "正在连接音频";
  if (status === "buffering") return "正在缓冲";
  if (status === "error") return "播放遇到问题，请检查网络后重试";
  return null;
}

function formatPlaybackRate(rate: number) {
  return `${Number.isInteger(rate) ? rate.toFixed(0) : rate.toFixed(2).replace(/0$/, "")}×`;
}

function formatSleepTimer(timer: PodcastSleepTimer, now: number) {
  if (!timer) return "睡眠";
  if (timer.kind === "episodeEnd") return "本集结束";
  const remainingSeconds = Math.max(0, Math.ceil((timer.deadlineAt - now) / 1_000));
  if (remainingSeconds <= 0) return "即将暂停";
  if (remainingSeconds < 60) return "不到 1 分钟";
  return `剩余 ${Math.ceil(remainingSeconds / 60)} 分钟`;
}

function formatEpisodeDate(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(timestamp));
}

function podcastDescriptionText(value?: string | null) {
  if (!value) return "";
  return value
    .replace(/<(?:br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
