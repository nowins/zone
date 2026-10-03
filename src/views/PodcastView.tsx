import { Button } from "../components/Button";
import { useState } from "react";
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
import { DiscoverScreen } from "./podcast/screens/DiscoverScreen";
import { LibraryScreen } from "./podcast/screens/LibraryScreen";
import { PlaylistScreen } from "./podcast/screens/PlaylistScreen";
import { ShowScreen } from "./podcast/screens/ShowScreen";
import { EpisodeScreen } from "./podcast/screens/EpisodeScreen";

export function PodcastView(props: PodcastViewProps) {
  const vm = usePodcastViewModel(props);
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
    <section className="content-band podcast-page">
      <p className="podcast-ghost" aria-hidden="true">podcasts</p>

      <header className={`podcast-header ${screen === "show" || screen === "episode" ? "podcast-header-detail" : ""}`}>
        <div className="podcast-heading">
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
              待播
            </button>
          </nav>
        )}
      </header>

      {screen === "listen" ? <ListenScreen vm={vm} /> : null}
      {screen === "library" && <div className="podcast-library-actions"><Button variant="ghost" onClick={() => setSettings({title:"下载与存储"})}>播客设置</Button></div>}
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
