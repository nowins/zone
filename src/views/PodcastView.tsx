import { Button } from "../components/Button";
import { useState, useRef, useLayoutEffect } from "react";
import { useBrowseEntrance } from "../hooks/useBrowseEntrance";
import { prepareBrowseTransition } from "../motion/browseTransition";
import { useLastNonNull } from "../motion/presence";
import { PodcastSettingsDialog } from "./podcast/components/SettingsDialog";
import {
  ArrowLeft,
  Check,
  Pin,
  PinOff,
} from "lucide-react";
import { PodcastEpisodeContextMenu } from "../components/PodcastEpisodeContextMenu";
import { MetroLoader } from "../components/MetroLoader";
import { Presence } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import type { PodcastViewProps } from "./podcast/types";
import { rootScreenLabel } from "./podcast/episodeModel";
import {
  PodcastDownloadCleanupDialog,
  PodcastQueueRemovalDialog,
} from "./podcast/components/Dialogs";
import { usePodcastViewModel } from "./podcast/usePodcastViewModel";
import { ListenScreen } from "./podcast/screens/ListenScreen";
import { DiscoverSearch } from "./podcast/components/DiscoverSearch";
import { DiscoverScreen } from "./podcast/screens/DiscoverScreen";
import { LibraryScreen } from "./podcast/screens/LibraryScreen";
import { PlaylistScreen } from "./podcast/screens/PlaylistScreen";
import { ShowScreen } from "./podcast/screens/ShowScreen";
import { EpisodeScreen } from "./podcast/screens/EpisodeScreen";

export function PodcastView(props: PodcastViewProps) {
  const rootRef = useRef<HTMLElement>(null);
  const order = ["listen", "discover", "library", "playlist", "show", "episode"];
  const directionBetween = (from: string, to: string): -1 | 1 => order.indexOf(to) < order.indexOf(from) ? -1 : 1;
  const vm = usePodcastViewModel(props, (from, to) => {
    if (rootRef.current) prepareBrowseTransition(rootRef.current, from, to, directionBetween(from, to));
  });
  const previousScreen = useRef(vm.screen);
  const direction = previousScreen.current === vm.screen ? 0 : directionBetween(previousScreen.current, vm.screen);
  useBrowseEntrance(rootRef, vm.screen, direction);
  useLayoutEffect(() => { previousScreen.current = vm.screen; }, [vm.screen]);
  const [settings, setSettings] = useState<{ feedId?: string; title: string } | null>(null);
  const lastSettings = useLastNonNull(settings);
  const {
    screen,
    returnScreen,
    heading,
    eyebrow,
    headingRef,
    changeRootScreen,
    closeShow,
    closeEpisodeDetail,
    openEpisodeShow,
    toggleFollowing,
    following,
    selectedFeed,
    pinnedPodcastFeedIds,
    onTogglePodcastPin,
    episodeReturnToNowPlaying,
    episodeOriginScreen,
    selectedEpisodeDetail,
    notice,
    error,
    downloadCleanupIntent,
    lastDownloadCleanupIntent,
    downloadCleanupAction,
    confirmDownloadCleanup,
    setDownloadCleanupIntent,
    queueRemovalIntent,
    lastQueueRemovalIntent,
    setQueueRemovalIntent,
    confirmQueueRemoval,
    queueBatchAction,
    episodeMenu,
    setEpisodeMenu,
    playEpisode,
    queueEpisodeFromMenu,
    toggleEpisodePlayedFromMenu,
    downloadEpisode,
    shareEpisode,
    openingCandidate,
    downloadingId,
    updatingPlayedId,
    detailAction,
    activeEpisodeId,
    queue,
  } = vm;

  return (
    <section ref={rootRef} className="content-band podcast-page" data-browse-motion="managed">

      <header className={`podcast-header ${screen === "show" || screen === "episode" ? "podcast-header-detail" : "podcast-header-root"}`}>
        <div className={screen === "show" || screen === "episode" ? "podcast-heading" : "podcast-heading podcast-heading-hidden"}>
          <span>{eyebrow}</span>
          <h1 ref={headingRef} tabIndex={-1}>{heading}</h1>
        </div>

        {screen === "show" ? (
          <div className="podcast-show-chrome">
            <Button variant="ghost" onClick={() => selectedFeed && setSettings({ feedId: selectedFeed.id, title: selectedFeed.title })}>节目设置</Button>
            <button type="button" onClick={closeShow}>
              <ArrowLeft size={16} />
              返回{rootScreenLabel(returnScreen)}
            </button>
            <button
              type="button"
              className={selectedFeed && pinnedPodcastFeedIds.has(selectedFeed.id) ? "active" : ""}
              aria-pressed={selectedFeed ? pinnedPodcastFeedIds.has(selectedFeed.id) : false}
              onClick={() => selectedFeed && onTogglePodcastPin(selectedFeed)}
              disabled={!selectedFeed}
              title={
                selectedFeed && pinnedPodcastFeedIds.has(selectedFeed.id)
                  ? "从 quickplay 取消固定"
                  : "固定到 quickplay"
              }
            >
              {selectedFeed && pinnedPodcastFeedIds.has(selectedFeed.id)
                ? <PinOff size={15} />
                : <Pin size={15} />}
              {selectedFeed && pinnedPodcastFeedIds.has(selectedFeed.id) ? "已固定" : "固定"}
            </button>
            <button
              type="button"
              className={selectedFeed?.subscribed ? "active" : ""}
              onClick={() => void toggleFollowing()}
              disabled={!selectedFeed || following}
            >
              {selectedFeed?.subscribed ? <Check size={15} /> : null}
              {selectedFeed?.subscribed ? "已关注" : "关注"}
            </button>
          </div>
        ) : screen === "episode" ? (
          <div className="podcast-show-chrome podcast-detail-chrome">
            <button type="button" onClick={closeEpisodeDetail}>
              <ArrowLeft size={16} />
              {episodeReturnToNowPlaying
                ? "返回正在播放"
                : episodeOriginScreen === "show"
                ? "返回节目"
                : `返回${rootScreenLabel(episodeOriginScreen)}`}
            </button>
            <button
              type="button"
              onClick={() => void openEpisodeShow()}
              disabled={!selectedEpisodeDetail}
            >
              进入节目
            </button>
          </div>
        ) : (
          <nav className="podcast-sections" aria-label="播客分区">
            <button
              type="button"
              className={screen === "listen" ? "active" : ""}
              onClick={() => changeRootScreen("listen")}
            >
              收听
            </button>
            <button
              type="button"
              className={screen === "discover" ? "active" : ""}
              onClick={() => changeRootScreen("discover")}
            >
              发现
            </button>
            <button
              type="button"
              className={screen === "library" ? "active" : ""}
              onClick={() => changeRootScreen("library")}
            >
              资料库
            </button>
            <button
              type="button"
              className={screen === "playlist" ? "active" : ""}
              onClick={() => changeRootScreen("playlist")}
            >
              播放列表
            </button>
          </nav>
        )}
        {screen === "discover" && <DiscoverSearch vm={vm} />}
      </header>

      {screen === "listen" ? <ListenScreen vm={vm} /> : null}
      {screen === "discover" ? <DiscoverScreen vm={vm} /> : null}
      {screen === "library" ? <LibraryScreen vm={vm} /> : null}
      {screen === "playlist" ? <PlaylistScreen vm={vm} /> : null}
      {screen === "show" && selectedFeed ? <ShowScreen vm={vm} /> : null}
      {screen === "episode" ? <EpisodeScreen vm={vm} /> : null}

      {openingCandidate ? (
        <div className="podcast-opening-state" role="status">
          <MetroLoader large />
          <strong>{openingCandidate.title}</strong>
          <span>正在打开节目</span>
        </div>
      ) : null}

      {(notice || error || downloadingId) ? (
        <div
          className={`podcast-notice${error ? " error" : ""}`}
          role={error ? "alert" : "status"}
        >
          <span>{error ?? notice ?? "下载进行中"}</span>
          {downloadingId ? (
            <Button variant="ghost" size="sm" onClick={vm.cancelDownload}>取消下载</Button>
          ) : null}
        </div>
      ) : null}

      <Presence
        show={downloadCleanupIntent !== null}
        exitDurationMs={MOTION_DURATIONS.micro}
      >
        {lastDownloadCleanupIntent ? (
          <PodcastDownloadCleanupDialog
            intent={lastDownloadCleanupIntent}
            busy={Boolean(downloadCleanupAction)}
            onCancel={() => {
              if (!downloadCleanupAction) setDownloadCleanupIntent(null);
            }}
            onConfirm={() => void confirmDownloadCleanup()}
          />
        ) : <span style={{ display: "none" }} />}
      </Presence>

      <Presence show={settings !== null} exitDurationMs={MOTION_DURATIONS.micro}>
        {lastSettings ? <PodcastSettingsDialog {...lastSettings} onClose={() => setSettings(null)} /> : <span style={{display:"none"}} />}
      </Presence>

      <Presence
        show={queueRemovalIntent !== null}
        exitDurationMs={MOTION_DURATIONS.micro}
      >
        {lastQueueRemovalIntent ? (
          <PodcastQueueRemovalDialog
            intent={lastQueueRemovalIntent}
            busy={queueBatchAction === "remove"}
            onCancel={() => {
              if (!queueBatchAction) setQueueRemovalIntent(null);
            }}
            onConfirm={() => void confirmQueueRemoval()}
          />
        ) : <span style={{ display: "none" }} />}
      </Presence>

      <PodcastEpisodeContextMenu
        menu={episodeMenu}
        downloading={Boolean(downloadingId)}
        updatingPlayed={Boolean(updatingPlayedId || detailAction === "played")}
        queueState={
          episodeMenu && activeEpisodeId === episodeMenu.episode.id
            ? "active"
            : episodeMenu
              && queue.some(
                (item) => item.episode.id === episodeMenu.episode.id,
              )
              ? "queued"
              : "available"
        }
        onClose={() => setEpisodeMenu(null)}
        onPlay={playEpisode}
        onQueue={(episode) => void queueEpisodeFromMenu(episode)}
        onTogglePlayed={(episode) =>
          void toggleEpisodePlayedFromMenu(episode)}
        onDownload={(episode) => void downloadEpisode(episode)}
        onShare={(episode) => void shareEpisode(episode)}
      />
    </section>
  );
}
