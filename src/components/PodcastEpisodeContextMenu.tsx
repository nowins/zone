import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useLastNonNull, usePresence } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import type { PodcastEpisode } from "../types";
import { MetroLoader } from "./MetroLoader";

export type PodcastEpisodeMenuState = {
  x: number;
  y: number;
  episode: PodcastEpisode;
  returnFocus: HTMLElement | null;
};

type PodcastEpisodeContextMenuProps = {
  menu: PodcastEpisodeMenuState | null;
  downloading: boolean;
  updatingPlayed: boolean;
  queueState: "available" | "queued" | "active";
  onClose: () => void;
  onPlay: (episode: PodcastEpisode) => void;
  onQueue: (episode: PodcastEpisode) => void;
  onTogglePlayed: (episode: PodcastEpisode) => void;
  onDownload: (episode: PodcastEpisode) => void;
  onShare: (episode: PodcastEpisode) => void;
};

export function PodcastEpisodeContextMenu(
  props: PodcastEpisodeContextMenuProps,
) {
  const { mounted, exiting } = usePresence(
    props.menu !== null,
    MOTION_DURATIONS.micro,
  );
  const lastMenu = useLastNonNull(props.menu);

  if (!mounted || !lastMenu || typeof document === "undefined") return null;

  return createPortal(
    <span
      className={exiting ? "motion-exit" : undefined}
      style={{ display: "contents" }}
    >
      <PodcastEpisodeMenuSurface
        {...props}
        menu={lastMenu}
      />
    </span>,
    document.body,
  );
}

function PodcastEpisodeMenuSurface({
  menu,
  downloading,
  updatingPlayed,
  queueState,
  onClose,
  onPlay,
  onQueue,
  onTogglePlayed,
  onDownload,
  onShare,
}: Omit<PodcastEpisodeContextMenuProps, "menu"> & {
  menu: PodcastEpisodeMenuState;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({
    left: menu.x,
    top: menu.y,
    ready: false,
  });

  useLayoutEffect(() => {
    function placeMenu() {
      const element = menuRef.current;
      if (!element) return;
      const gutter = 12;
      const rect = { width: element.offsetWidth, height: element.offsetHeight };
      const maxLeft = Math.max(gutter, window.innerWidth - rect.width - gutter);
      const maxTop = Math.max(gutter, window.innerHeight - rect.height - gutter);
      setPosition({
        left: Math.min(Math.max(gutter, Math.round(menu.x)), maxLeft),
        top: Math.min(Math.max(gutter, Math.round(menu.y)), maxTop),
        ready: true,
      });
    }
    placeMenu();
    window.addEventListener("resize", placeMenu);
    return () => window.removeEventListener("resize", placeMenu);
  }, [menu.episode.id, menu.x, menu.y]);

  useLayoutEffect(() => {
    if (!position.ready) return;
    const firstAction = menuRef.current?.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    );
    firstAction?.focus({ preventScroll: true });
  }, [position.ready, menu.episode.id, menu.x, menu.y]);

  useEffect(() => {
    function closeFromOutside(event: PointerEvent) {
      if (
        event.target instanceof Node
        && menuRef.current?.contains(event.target)
      ) {
        return;
      }
      onClose();
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    }

    function closeOnScroll(event: Event) {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    }

    document.addEventListener("pointerdown", closeFromOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [menu.returnFocus, onClose]);

  function close(restoreFocus = false) {
    onClose();
    if (!restoreFocus || !menu.returnFocus) return;
    window.requestAnimationFrame(() => {
      if (menu.returnFocus?.isConnected) {
        menu.returnFocus.focus({ preventScroll: true });
      }
    });
  }

  function run(action: () => void) {
    action();
    close(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) {
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  const downloaded = Boolean(menu.episode.localPath);
  const queueUnavailable = queueState !== "available";

  return (
    <div
      ref={menuRef}
      className="context-menu podcast-episode-context-menu"
      role="menu"
      aria-label={`${menu.episode.title} 的播客单集操作`}
      style={{
        left: position.left,
        top: position.top,
        visibility: position.ready ? "visible" : "hidden",
      }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="context-title">
        <strong>{menu.episode.title}</strong>
        <span>{menu.episode.feedTitle || "播客"}</span>
      </div>
      <div className="context-actions">
        <button
          type="button"
          role="menuitem"
          onClick={() => run(() => onPlay(menu.episode))}
        >
          <span>
            {menu.episode.progressSeconds > 0 && !menu.episode.completed
              ? "继续收听"
              : "播放"}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => run(() => onQueue(menu.episode))}
          disabled={queueUnavailable}
        >
          <span>
            {queueState === "active"
              ? "正在播放"
              : queueState === "queued"
                ? "已在待播"
                : "加入待播"}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => run(() => onTogglePlayed(menu.episode))}
          disabled={updatingPlayed}
        >
          {updatingPlayed && <MetroLoader size={14} />}
          <span>
            {updatingPlayed
              ? "正在更新播放状态"
              : menu.episode.completed
                ? "标记为未播放"
                : "标记为已播放"}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => run(() => onDownload(menu.episode))}
          disabled={downloading || downloaded}
        >
          {downloading && !downloaded && <MetroLoader size={14} />}
          <span>
            {downloaded ? "已下载" : downloading ? "正在下载" : "下载"}
          </span>
        </button>
      </div>
      <div className="context-actions context-actions-secondary">
        <button
          type="button"
          role="menuitem"
          onClick={() => run(() => onShare(menu.episode))}
        >
          <span>分享</span>
        </button>
      </div>
    </div>
  );
}
