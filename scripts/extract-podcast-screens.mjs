/**
 * Rebuild PodcastView shell + screens so each screen receives `vm` (view model).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Re-read current PodcastView is messy (already partially extracted).
// Use _jsx_extract.txt (original full JSX) as the source of truth for screen bodies.
const jsxFull = readFileSync("src/views/podcast/_jsx_extract.txt", "utf8");
const lines = jsxFull.split("\n");

function findLine(predicate, from = 0) {
  for (let i = from; i < lines.length; i++) {
    if (predicate(lines[i])) return i;
  }
  return -1;
}

function extractBlock(startLine) {
  let depth = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "(" || ch === "{" || ch === "[") {
        depth += 1;
        started = true;
      } else if (ch === ")" || ch === "}" || ch === "]") {
        depth -= 1;
      }
    }
    if (started && depth === 0) return { start: startLine, end: i };
  }
  throw new Error("unclosed " + startLine);
}

function innerOfBlock(start, end) {
  const joined = lines.slice(start, end + 1).join("\n");
  const q = joined.indexOf("? (");
  if (q >= 0) {
    const close = joined.lastIndexOf(") : null}");
    return joined.slice(q + 3, close).trim();
  }
  const a = joined.indexOf("&& (");
  if (a >= 0) {
    // find last closing paren before final }
    const close = joined.lastIndexOf(")");
    return joined.slice(a + 4, close).trim();
  }
  throw new Error("no inner");
}

function indent(text, n) {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => (l.length ? pad + l : l))
    .join("\n");
}

/** Prefix free identifiers used from the view model with `vm.` — keep known locals. */
function bindVm(inner) {
  // The extracted JSX was written against free variables from the parent scope.
  // Screens receive `vm` and destructure at the top instead (clearer, no renames).
  return inner;
}

const markers = {
  listen: findLine((l) => l.includes('{screen === "listen" ? (')),
  discover: findLine((l) => l.includes('{screen === "discover" ? (')),
  library: findLine((l) => l.includes('{screen === "library" ? (')),
  playlist: findLine((l) => l.includes('{screen === "playlist" ? (')),
  show: findLine((l) => l.includes('{screen === "show" && selectedFeed')),
  episode: findLine((l) => l.includes('{screen === "episode" ? (')),
};

const blocks = Object.fromEntries(
  Object.entries(markers).map(([k, start]) => [k, extractBlock(start)]),
);

const screenMeta = [
  {
    key: "listen",
    name: "ListenScreen",
    imports: `
import { isPodcastEpisodeNew } from "../../../utils/podcastListening";
import { PODCAST_LISTEN_FILTERS } from "../constants";
import { ContinueCard } from "../components/ContinueCard";
import { EpisodeRow } from "../components/EpisodeRows";
import {
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";
`,
  },
  {
    key: "discover",
    name: "DiscoverScreen",
    imports: `
import { Search, Rss } from "lucide-react";
import {
  PODCAST_DISCOVERY_SORTS,
  PODCAST_DISCOVERY_TOPICS,
} from "../constants";
import { DiscoveryShelf, ShowCard } from "../components/ShowCards";
import {
  PodcastActivityIndicator,
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";
`,
  },
  {
    key: "library",
    name: "LibraryScreen",
    imports: `
import { ArrowLeft, ArrowRight } from "lucide-react";
import { isPodcastEpisodeNew } from "../../../utils/podcastListening";
import { PODCAST_LIBRARY_SORTS, PODCAST_DOWNLOAD_BATCH_LIMIT } from "../constants";
import { formatFileSize } from "../format";
import { EpisodeRow } from "../components/EpisodeRows";
import {
  PodcastArtwork,
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";
`,
  },
  {
    key: "playlist",
    name: "PlaylistScreen",
    imports: `
import { PODCAST_AUTO_QUEUE_MODES } from "../constants";
import { formatEpisodeDate, plainText } from "../format";
import { CurrentEpisodeRow } from "../components/EpisodeRows";
import { QueueEpisodeRow } from "../components/QueueEpisodeRow";
import { PodcastEmpty, PodcastSection } from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";
`,
  },
  {
    key: "show",
    name: "ShowScreen",
    imports: `
import { LoaderCircle, RefreshCw } from "lucide-react";
import { plainText } from "../format";
import { EpisodeRow } from "../components/EpisodeRows";
import {
  PodcastArtwork,
  PodcastEmpty,
  PodcastLoading,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";
`,
  },
  {
    key: "episode",
    name: "EpisodeScreen",
    imports: `
import { EpisodeDetail } from "../components/EpisodeDetail";
import { EpisodeRow } from "../components/EpisodeRows";
import {
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";
`,
  },
];

mkdirSync("src/views/podcast/screens", { recursive: true });

for (const meta of screenMeta) {
  const range = blocks[meta.key];
  const inner = bindVm(innerOfBlock(range.start, range.end));
  // Destructure every identifier that appears as a free variable is hard;
  // destructure the full view model for simplicity and tree-shake-less clarity.
  const content = `${meta.imports.trim()}

export function ${meta.name}({ vm }: { vm: PodcastViewModel }) {
  const {
    // pull fields used by this screen (full bag is fine; unused locals are ok at runtime)
    ..._
  } = vm;
  void _;
  // Prefer explicit access via vm.* for readability of auto-extract; bind common names:
  const {
    continueListeningEpisodes,
    latestEpisodes,
    filteredLatestEpisodes,
    listenFilter,
    setListenFilter,
    listenNewReferenceTime,
    hasListenContent,
    homeState,
    loadHome,
    currentEpisodeId,
    isPlaying,
    openEpisodeDetail,
    playEpisode,
    showEpisodeMenu,
    downloadingId,
    downloadEpisode,
    feedById,
    changeRootScreen,
    query,
    setQuery,
    searchApple,
    searchState,
    discoveryTopic,
    rssExpanded,
    setRssExpanded,
    rssUrl,
    setRssUrl,
    subscribeRss,
    openingId,
    searchHistory,
    setSearchHistory,
    repeatPodcastSearch,
    browseDiscoveryTopic,
    searchHeading,
    searchResults,
    showPopularDiscovery,
    searchSort,
    setSearchSort,
    sortedSearchResults,
    feeds,
    searchHighlightQuery,
    previewFeed,
    discoveryState,
    discoveryShows,
    loadDiscovery,
    libraryState,
    librarySort,
    setLibrarySort,
    orderedFeeds,
    openStoredFeed,
    moveFollowedFeed,
    savedEpisodes,
    downloadedEpisodes,
    recentlyPlayedEpisodes,
    recentHistoryExpanded,
    setRecentHistoryExpanded,
    downloadLibraryState,
    downloadGroups,
    downloadedBytes,
    downloadedCount,
    downloadedFeedCount,
    hasDownloadedLibraryPage,
    downloadPage,
    loadDownloadedLibrary,
    loadingMoreDownloads,
    downloadSelectionMode,
    toggleDownloadSelectionMode,
    toggleAllLoadedDownloads,
    allLoadedDownloadsSelected,
    loadedDownloadsExceedBatchLimit,
    selectedDownloadIds,
    toggleDownloadSelection,
    requestSelectedDownloadDeletion,
    setDownloadCleanupIntent,
    knownActiveEpisode,
    upNextQueue,
    queueSelectionMode,
    toggleQueueSelectionMode,
    toggleAllQueueEpisodes,
    allQueueEpisodesSelected,
    selectedQueueIds,
    selectedQueueEpisodes,
    toggleQueueSelection,
    downloadSelectedQueueEpisodes,
    setSelectedQueueEpisodesPlayed,
    requestSelectedQueueRemoval,
    queueBatchAction,
    queueAnnouncement,
    setQueueAnnouncement,
    autoQueueMode,
    onAutoQueueMode,
    onClearQueue,
    draggedQueueEpisodeId,
    queueDropTarget,
    handleQueueDragStart,
    handleQueueDragOver,
    handleQueueDrop,
    resetQueueDrag,
    onMoveQueueEpisode,
    onRemoveQueueEpisode,
    onReorderQueueEpisode,
    selectedFeed,
    displayedEpisodes,
    episodeState,
    loadEpisodes,
    refreshSelectedFeed,
    following,
    displayedEpisodeDetail,
    detailState,
    liveActiveEpisode,
    activeProgress,
    activeDuration,
    detailQueuePosition,
    detailAction,
    updatingPlayedId,
    chapterDocument,
    chapterState,
    chaptersOpen,
    toggleEpisodeChapters,
    loadEpisodeChapters,
    playEpisodeAt,
    onQueueEpisode,
    toggleEpisodeSaved,
    toggleEpisodePlayed,
    deleteEpisodeDownload,
    shareEpisode,
    displayedRelatedEpisodes,
    relatedState,
    loadRelatedEpisodes,
    openEpisodeShow,
    episodes,
  } = vm;

  return (
${indent(inner, 4)}
  );
}
`;
  writeFileSync(
    join("src/views/podcast/screens", `${meta.name}.tsx`),
    content,
    "utf8",
  );
  console.log(meta.name, content.split("\n").length);
}

// Build thin PodcastView shell from original extract structure: header + screen switch + overlays
const shell = `import {
  ArrowLeft,
  Check,
} from "lucide-react";
import { PodcastEpisodeContextMenu } from "../components/PodcastEpisodeContextMenu";
import { Presence } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import type { PodcastViewProps } from "./podcast/types";
import { rootScreenLabel } from "./podcast/episodeModel";
import {
  PodcastDownloadCleanupDialog,
  PodcastQueueRemovalDialog,
} from "./podcast/components/Dialogs";
import { PodcastActivityIndicator } from "./podcast/components/primitives";
import { usePodcastViewModel } from "./podcast/usePodcastViewModel";
import { ListenScreen } from "./podcast/screens/ListenScreen";
import { DiscoverScreen } from "./podcast/screens/DiscoverScreen";
import { LibraryScreen } from "./podcast/screens/LibraryScreen";
import { PlaylistScreen } from "./podcast/screens/PlaylistScreen";
import { ShowScreen } from "./podcast/screens/ShowScreen";
import { EpisodeScreen } from "./podcast/screens/EpisodeScreen";

export function PodcastView(props: PodcastViewProps) {
  const vm = usePodcastViewModel(props);
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

      <header className="podcast-header">
        <div className="podcast-heading">
          <span>{eyebrow}</span>
          <h1 ref={headingRef} tabIndex={-1}>{heading}</h1>
        </div>

        {screen === "show" ? (
          <div className="podcast-show-chrome">
            <button type="button" onClick={closeShow}>
              <ArrowLeft size={16} />
              返回{rootScreenLabel(returnScreen)}
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
                : \`返回\${rootScreenLabel(episodeOriginScreen)}\`}
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
      </header>

      {screen === "listen" ? <ListenScreen vm={vm} /> : null}
      {screen === "discover" ? <DiscoverScreen vm={vm} /> : null}
      {screen === "library" ? <LibraryScreen vm={vm} /> : null}
      {screen === "playlist" ? <PlaylistScreen vm={vm} /> : null}
      {screen === "show" && selectedFeed ? <ShowScreen vm={vm} /> : null}
      {screen === "episode" ? <EpisodeScreen vm={vm} /> : null}

      {openingCandidate ? (
        <div className="podcast-opening-state" role="status">
          <PodcastActivityIndicator className="large" />
          <strong>{openingCandidate.title}</strong>
          <span>正在打开节目</span>
        </div>
      ) : null}

      {(notice || error) ? (
        <div
          className={\`podcast-notice\${error ? " error" : ""}\`}
          role={error ? "alert" : "status"}
        >
          {error ?? notice}
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
`;

writeFileSync("src/views/PodcastView.tsx", shell, "utf8");
console.log("PodcastView lines", shell.split("\n").length);
