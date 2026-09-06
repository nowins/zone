import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as podcastApi from "./api";
import type { PodcastEpisodeMenuState } from "../../components/PodcastEpisodeContextMenu";
import { useLastNonNull } from "../../motion/presence";
import {
  filterPodcastListeningEpisodes,
  isPodcastEpisodeNew,
  type PodcastListenFilter,
} from "../../utils/podcastListening";
import {
  groupPodcastDownloads,
  movePodcastFeedOrder,
  normalizePodcastFeedOrder,
  podcastDownloadedBytes,
  sortPodcastFeeds,
  type PodcastLibrarySort,
} from "../../utils/podcastLibrary";
import {
  addPodcastSearchHistory,
  isRememberedPodcastSearchTerm,
  PODCAST_SEARCH_COMPOSITION_GRACE_MS,
  shouldBlockPodcastSearchCommit,
  sortPodcastSearchResults,
  type PodcastDiscoverySort,
} from "../../utils/podcastDiscovery";
import { mergePodcastEpisodePlayback } from "../../utils/podcastPlayback";
import type {
  PodcastChapterDocument,
  PodcastDiscoveryShow,
  PodcastDownloadDeleteResult,
  PodcastDownloadPage,
  PodcastDownloadResult,
  PodcastEpisode,
  PodcastEpisodeDetail,
  PodcastFeed,
  PodcastHome,
  PodcastPlayback,
  PodcastRefreshReport,
  PodcastSearchResult,
  PodcastSubscribeResult,
} from "../../types";
import type {
  EpisodeOriginScreen,
  PodcastDiscoveryTopic,
  PodcastDownloadCleanupIntent,
  PodcastQueueDropPlacement,
  PodcastQueueDropTarget,
  PodcastQueueRemovalIntent,
  PodcastScreen,
  PodcastSessionSnapshot,
  PodcastViewProps,
  RequestState,
  RootPodcastScreen,
  ShowCandidate,
} from "./types";
import {
  CHAPTER_CACHE_TTL_MS,
  CHAPTER_MEMORY_CACHE_LIMIT,
  DISCOVERY_CACHE_TTL_MS,
  EMPTY_DOWNLOAD_PAGE,
  EMPTY_HOME,
  PODCAST_AUTO_QUEUE_MODES,
  PODCAST_DISCOVERY_SORTS,
  PODCAST_DISCOVERY_TOPICS,
  PODCAST_DOWNLOAD_BATCH_LIMIT,
  PODCAST_DOWNLOAD_PAGE_SIZE,
  PODCAST_DOWNLOAD_PROGRESS_POLL_MS,
  PODCAST_LIBRARY_SORTS,
  PODCAST_LIBRARY_STORAGE_KEY,
  PODCAST_LISTEN_FILTERS,
  PODCAST_QUEUE_BATCH_LIMIT,
  PREVIEW_FEED_CACHE_TTL_MS,
  SEARCH_CACHE_LIMIT,
  SEARCH_CACHE_TTL_MS,
  STALE_CHAPTER_CACHE_TTL_MS,
} from "./constants";
import {
  cacheEntryIsFresh,
  chapterDocumentCache,
  discoveryCache,
  podcastSessionSnapshot,
  previewFeedCache,
  rememberBoundedCacheEntry,
  searchCache,
  setDiscoveryCache,
  setPodcastSessionSnapshot,
} from "./cache";
import {
  clearPodcastEpisodeDownload,
  deduplicateEpisodes,
  promoteEpisode,
  rootScreenLabel,
  upsertEpisode,
} from "./episodeModel";
import {
  readPodcastLibraryPreferences,
  readPodcastSearchHistory,
  writePodcastSearchHistory,
} from "./preferences";
import {
  copyPodcastShareUrl,
  errorMessage,
  formatEpisodeDate,
  formatFileSize,
  plainText,
  sameStringArray,
  shareablePodcastEpisodeUrl,
} from "./format";

export type PodcastViewModel = ReturnType<typeof usePodcastViewModel>;

export function usePodcastViewModel({
  queue,
  autoQueueMode,
  activeEpisode,
  activeEpisodeId,
  activeProgress,
  activeDuration,
  libraryRevision,
  episodeRequest,
  onEpisodeRequestHandled,
  feedRequest,
  onFeedRequestHandled,
  pinnedPodcastFeedIds,
  onTogglePodcastPin,
  onReturnToNowPlaying,
  isPlaying,
  onPlayEpisode,
  onPlayEpisodeAt,
  onQueueEpisode,
  onRemoveQueueEpisode,
  onMoveQueueEpisode,
  onReorderQueueEpisode,
  onRemoveQueueEpisodes,
  onSetQueueEpisodesPlayed,
  onDownloadQueueEpisodes,
  onClearQueue,
  onAutoQueueMode,
  onEpisodeUpdated,
  onSetEpisodePlayed,
  onDownloadsDeleted,
}: PodcastViewProps) {
  const restoredSession = useMemo(() => podcastSessionSnapshot, []);
  const initialLibraryPreferences = useMemo(
    readPodcastLibraryPreferences,
    [],
  );
  const initialSearchHistory = useMemo(readPodcastSearchHistory, []);
  const restoredSearchState = restoredSession?.searchState === "loading"
    ? "idle"
    : restoredSession?.searchState;
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  useEffect(() => {
    function focusPodcastSearch(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[aria-modal="true"]')) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      changeRootScreen("discover");
      setSearchFocusRequest(value => value + 1);
    }
    window.addEventListener("keydown", focusPodcastSearch);
    return () => window.removeEventListener("keydown", focusPodcastSearch);
  }, []);
  const [screen, setScreen] = useState<PodcastScreen>(
    restoredSession?.screen ?? "listen",
  );
  const [returnScreen, setReturnScreen] = useState<RootPodcastScreen>(
    restoredSession?.returnScreen ?? "listen",
  );
  const [query, setQuery] = useState(restoredSession?.query ?? "");
  const [listenFilter, setListenFilter] = useState<PodcastListenFilter>(
    restoredSession?.listenFilter ?? "recent",
  );
  const [rssUrl, setRssUrl] = useState("");
  const [rssExpanded, setRssExpanded] = useState(false);
  const [discoveryTopic, setDiscoveryTopic] =
    useState<PodcastDiscoveryTopic | null>(
      restoredSession?.searchState === "loading"
        ? "popular"
        : restoredSession
          ? restoredSession.discoveryTopic
          : "popular",
    );
  const [searchHeading, setSearchHeading] = useState(
    restoredSession?.searchState === "loading"
      ? "搜索结果"
      : restoredSession?.searchHeading ?? "搜索结果",
  );
  const [searchSort, setSearchSort] = useState<PodcastDiscoverySort>(
    restoredSession?.searchSort ?? "relevance",
  );
  const [searchHighlightQuery, setSearchHighlightQuery] = useState(
    restoredSession?.searchState === "loading"
      ? ""
      : restoredSession?.searchHighlightQuery ?? "",
  );
  const [searchHistory, setSearchHistory] =
    useState<string[]>(initialSearchHistory);
  const [searchState, setSearchState] = useState<RequestState>(
    restoredSearchState
      ?? (restoredSession?.searchResults.length ? "ready" : "idle"),
  );
  const [searchResults, setSearchResults] = useState<PodcastSearchResult[]>(
    restoredSession?.searchResults ?? [],
  );
  const [discoveryState, setDiscoveryState] = useState<RequestState>("idle");
  const [discoveryShows, setDiscoveryShows] = useState<PodcastDiscoveryShow[]>([]);
  const [feeds, setFeeds] = useState<PodcastFeed[]>([]);
  const [libraryState, setLibraryState] = useState<RequestState>("loading");
  const [librarySort, setLibrarySort] = useState<PodcastLibrarySort>(
    initialLibraryPreferences.sort,
  );
  const [customFeedOrder, setCustomFeedOrder] = useState<string[]>(
    initialLibraryPreferences.customOrder,
  );
  const [home, setHome] = useState<PodcastHome>(EMPTY_HOME);
  const [homeState, setHomeState] = useState<RequestState>("loading");
  const [downloadPage, setDownloadPage] =
    useState<PodcastDownloadPage>(EMPTY_DOWNLOAD_PAGE);
  const [downloadLibraryState, setDownloadLibraryState] =
    useState<RequestState>("idle");
  const [loadingMoreDownloads, setLoadingMoreDownloads] = useState(false);
  const [recentHistoryExpanded, setRecentHistoryExpanded] = useState(false);
  const [downloadSelectionMode, setDownloadSelectionMode] = useState(false);
  const [selectedDownloadIds, setSelectedDownloadIds] =
    useState<Set<string>>(() => new Set());
  const [downloadCleanupIntent, setDownloadCleanupIntent] =
    useState<PodcastDownloadCleanupIntent | null>(null);
  const [downloadCleanupAction, setDownloadCleanupAction] =
    useState<"selected" | "completed" | null>(null);
  const [queueSelectionMode, setQueueSelectionMode] = useState(false);
  const [selectedQueueIds, setSelectedQueueIds] =
    useState<Set<string>>(() => new Set());
  const [queueBatchAction, setQueueBatchAction] =
    useState<"remove" | "download" | "played" | null>(null);
  const [queueRemovalIntent, setQueueRemovalIntent] =
    useState<PodcastQueueRemovalIntent | null>(null);
  const [draggedQueueEpisodeId, setDraggedQueueEpisodeId] =
    useState<string | null>(null);
  const [queueDropTarget, setQueueDropTarget] =
    useState<PodcastQueueDropTarget | null>(null);
  const [queueAnnouncement, setQueueAnnouncement] = useState("");
  const [selectedFeed, setSelectedFeed] = useState<PodcastFeed | null>(
    restoredSession?.selectedFeed ?? null,
  );
  const [hasMoreEpisodes, setHasMoreEpisodes] = useState(true);
  const episodePageLoadingRef = useRef(false);
  const [loadingEpisodePage, setLoadingEpisodePage] = useState(false);
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>(
    restoredSession?.episodes ?? [],
  );
  const [episodeState, setEpisodeState] = useState<RequestState>(
    restoredSession?.episodes.length ? "ready" : "idle",
  );
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(
    restoredSession?.selectedEpisodeId ?? null,
  );
  const [selectedEpisodeDetail, setSelectedEpisodeDetail] =
    useState<PodcastEpisodeDetail | null>(
      restoredSession?.selectedEpisodeDetail ?? null,
    );
  const [detailState, setDetailState] = useState<RequestState>(
    restoredSession?.selectedEpisodeDetail ? "ready" : "idle",
  );
  const [relatedEpisodes, setRelatedEpisodes] = useState<PodcastEpisode[]>([]);
  const [relatedState, setRelatedState] = useState<RequestState>("idle");
  const [chapterDocument, setChapterDocument] =
    useState<PodcastChapterDocument | null>(null);
  const [chapterState, setChapterState] = useState<RequestState>("idle");
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [episodeOriginScreen, setEpisodeOriginScreen] =
    useState<EpisodeOriginScreen>(
      restoredSession?.episodeOriginScreen ?? "listen",
    );
  const [episodeOriginFeed, setEpisodeOriginFeed] = useState<PodcastFeed | null>(
    restoredSession?.episodeOriginFeed ?? null,
  );
  const [episodeReturnToNowPlaying, setEpisodeReturnToNowPlaying] =
    useState(false);
  const [lastPlayedEpisode, setLastPlayedEpisode] =
    useState<PodcastEpisode | null>(
      restoredSession?.lastPlayedEpisode ?? null,
    );
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openingCandidate, setOpeningCandidate] = useState<ShowCandidate | null>(null);
  const [following, setFollowing] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [detailAction, setDetailAction] = useState<
    "save" | "played" | "delete" | null
  >(null);
  const [updatingPlayedId, setUpdatingPlayedId] = useState<string | null>(null);
  const [episodeMenu, setEpisodeMenu] =
    useState<PodcastEpisodeMenuState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);
  const handledEpisodeRequestNonce = useRef<number | null>(null);
  const handledFeedRequestNonce = useRef<number | null>(null);
  const handledLibraryRevision = useRef(libraryRevision);
  const episodeListRequestRef = useRef(0);
  const episodeDetailRequestRef = useRef(0);
  const relatedEpisodeRequestRef = useRef(0);
  const chapterRequestRef = useRef(0);
  const homeRequestRef = useRef(0);
  const downloadLibraryRequestRef = useRef(0);
  const downloadProgressPollRef = useRef<number | null>(null);
  const downloadProgressEpisodeRef = useRef<string | null>(null);
  const appleSearchRequestRef = useRef(0);
  const podcastSearchComposingRef = useRef(false);
  const ignorePodcastSearchSubmitRef = useRef(false);
  const ignorePodcastSearchSubmitTimerRef = useRef<number | null>(null);
  const discoveryRequestActive = useRef(false);
  const feedRefreshActive = useRef(false);
  const selectedFeedRef = useRef(selectedFeed);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const episodeReturnSessionRef = useRef<PodcastSessionSnapshot | null>(null);
  const lastDownloadCleanupIntent = useLastNonNull(downloadCleanupIntent);
  const lastQueueRemovalIntent = useLastNonNull(queueRemovalIntent);
  selectedFeedRef.current = selectedFeed;

  useEffect(() => () => {
    downloadProgressEpisodeRef.current = null;
    if (downloadProgressPollRef.current !== null) {
      window.clearInterval(downloadProgressPollRef.current);
      downloadProgressPollRef.current = null;
    }
  }, []);

  const currentEpisodeId = activeEpisode?.episodeId ?? activeEpisodeId;
  const sortedSearchResults = useMemo(
    () => sortPodcastSearchResults(searchResults, searchSort),
    [searchResults, searchSort],
  );
  const feedById = useMemo(
    () => new Map(feeds.map((feed) => [feed.id, feed])),
    [feeds],
  );

  const loadFeeds = useCallback(async () => {
    try {
      const nextFeeds = await podcastApi.listPodcastFeeds();
      setFeeds(nextFeeds);
      setSelectedFeed((current) => {
        if (!current) return null;
        return nextFeeds.find((feed) => feed.id === current.id) ?? current;
      });
      setLibraryState("ready");
      return nextFeeds;
    } catch (reason) {
      setLibraryState("error");
      setError(errorMessage(reason, "读取播客资料库失败"));
      return [];
    }
  }, []);

  const loadHome = useCallback(async () => {
    const requestId = homeRequestRef.current + 1;
    homeRequestRef.current = requestId;
    setHomeState("loading");
    try {
      const [nextHome, savedEpisodeDetails] = await Promise.all([
        podcastApi.listPodcastHome(),
        podcastApi.listSavedEpisodes(),
      ]);
      if (homeRequestRef.current !== requestId) return;
      const resolvedHome: PodcastHome = {
        continueListening: nextHome.continueListening ?? [],
        latestEpisodes: nextHome.latestEpisodes ?? [],
        unplayedEpisodes: nextHome.unplayedEpisodes ?? [],
        downloadPriorityEpisodes: nextHome.downloadPriorityEpisodes ?? [],
        downloadedEpisodes: nextHome.downloadedEpisodes ?? [],
        savedEpisodes: savedEpisodeDetails.map((detail) => detail.episode),
        recentlyPlayedEpisodes: nextHome.recentlyPlayedEpisodes ?? [],
      };
      setHome(resolvedHome);
      setEpisodeMenu((current) => {
        if (!current) return current;
        const nextEpisode = [
          ...resolvedHome.continueListening,
          ...resolvedHome.latestEpisodes,
          ...resolvedHome.unplayedEpisodes,
          ...resolvedHome.downloadPriorityEpisodes,
          ...resolvedHome.downloadedEpisodes,
          ...resolvedHome.savedEpisodes,
          ...resolvedHome.recentlyPlayedEpisodes,
        ].find((episode) => episode.id === current.episode.id);
        return nextEpisode ? { ...current, episode: nextEpisode } : current;
      });
      setHomeState("ready");
    } catch {
      if (homeRequestRef.current !== requestId) return;
      setHome(EMPTY_HOME);
      setHomeState("error");
    }
  }, []);

  const loadDownloadedLibrary = useCallback(async (offset = 0) => {
    const requestId = downloadLibraryRequestRef.current + 1;
    downloadLibraryRequestRef.current = requestId;
    if (offset === 0) {
      setDownloadLibraryState("loading");
    } else {
      setLoadingMoreDownloads(true);
    }
    try {
      const page = await podcastApi.listPodcastDownloads(offset, PODCAST_DOWNLOAD_PAGE_SIZE);
      if (downloadLibraryRequestRef.current !== requestId) return;
      setDownloadPage((current) => {
        if (offset === 0) return page;
        const episodes = deduplicateEpisodes([
          ...current.episodes,
          ...page.episodes,
        ]);
        return { ...page, episodes };
      });
      setDownloadLibraryState("ready");
    } catch (reason) {
      if (downloadLibraryRequestRef.current !== requestId) return;
      setDownloadLibraryState("error");
      setError(errorMessage(reason, "读取下载资料库失败"));
    } finally {
      if (downloadLibraryRequestRef.current === requestId) {
        setLoadingMoreDownloads(false);
      }
    }
  }, []);

  const loadDiscovery = useCallback(async () => {
    const cached = discoveryCache;
    if (cached) {
      setDiscoveryShows(cached.shows);
      setDiscoveryState("ready");
      if (Date.now() - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) return;
    }
    if (discoveryRequestActive.current) return;
    discoveryRequestActive.current = true;
    if (!cached) setDiscoveryState("loading");
    try {
      const shows = await podcastApi.browseApplePodcasts(24);
      setDiscoveryCache({ shows, fetchedAt: Date.now() });
      setDiscoveryShows(shows);
      setDiscoveryState("ready");
    } catch {
      if (!cached) {
        setDiscoveryShows([]);
        setDiscoveryState("error");
      }
    } finally {
      discoveryRequestActive.current = false;
    }
  }, []);

  const loadEpisodes = useCallback(async (feed: PodcastFeed) => {
    const requestId = episodeListRequestRef.current + 1;
    episodeListRequestRef.current = requestId;
    setEpisodeState("loading");
    try {
      const nextEpisodes = await podcastApi.listPodcastEpisodes(feed.id);
      if (episodeListRequestRef.current !== requestId) return null;
      setEpisodes(nextEpisodes);
      setHasMoreEpisodes(nextEpisodes.length === 100);
      setEpisodeState("ready");
      return nextEpisodes;
    } catch (reason) {
      if (episodeListRequestRef.current !== requestId) return null;
      setEpisodes([]);
      setEpisodeState("error");
      setError(errorMessage(reason, "读取单集失败"));
      return null;
    }
  }, []);

  async function loadMoreEpisodes() {
    if (!selectedFeed || episodePageLoadingRef.current || episodeState === "loading" || !hasMoreEpisodes) return;
    const requestId = episodeListRequestRef.current;
    episodePageLoadingRef.current = true;
    setLoadingEpisodePage(true);
    try {
      const page = await podcastApi.listPodcastEpisodes(selectedFeed.id, episodes.length);
      if (episodeListRequestRef.current !== requestId) return;
      setEpisodes(current => {
        const ids = new Set(current.map(episode => episode.id));
        return [...current, ...page.filter(episode => !ids.has(episode.id))];
      });
      setHasMoreEpisodes(page.length === 100);
    } catch {
      if (episodeListRequestRef.current === requestId) setError("读取更多单集失败，请重试");
    } finally {
      episodePageLoadingRef.current = false;
      setLoadingEpisodePage(false);
    }
  }


  const refreshSubscribedFeeds = useCallback(async () => {
    if (feedRefreshActive.current) return;
    feedRefreshActive.current = true;
    try {
      const report = await podcastApi.refreshPodcastFeeds({ force: false });
      const refreshed = Math.max(
        0,
        report.checked - report.notModified - report.failures.length,
      );
      if (refreshed === 0) return;
      chapterDocumentCache.clear();
      const [nextFeeds] = await Promise.all([loadFeeds(), loadHome()]);
      const currentFeed = selectedFeedRef.current;
      const refreshedFeed = currentFeed
        ? nextFeeds.find((feed) => feed.id === currentFeed.id)
        : null;
      if (refreshedFeed) {
        await loadEpisodes(refreshedFeed);
      }
    } catch {
      // Cached podcast content remains usable when a background refresh fails.
    } finally {
      feedRefreshActive.current = false;
    }
  }, [loadEpisodes, loadFeeds, loadHome]);

  const loadRelatedEpisodes = useCallback(async (episodeId: string) => {
    const requestId = relatedEpisodeRequestRef.current + 1;
    relatedEpisodeRequestRef.current = requestId;
    setRelatedEpisodes([]);
    setRelatedState("loading");
    try {
      const nextEpisodes = await podcastApi.listRelatedEpisodes(episodeId, 6);
      if (relatedEpisodeRequestRef.current !== requestId) return;
      setRelatedEpisodes(
        nextEpisodes
          .filter((episode) =>
            episode.id !== episodeId && Boolean(episode.enclosureUrl.trim()))
          .slice(0, 6),
      );
      setRelatedState("ready");
    } catch (reason) {
      if (relatedEpisodeRequestRef.current !== requestId) return;
      setRelatedEpisodes([]);
      setRelatedState("error");
      if (import.meta.env.DEV) {
        console.warn("[podcast] related episodes failed", reason);
      }
    }
  }, []);

  const loadEpisodeChapters = useCallback(async (
    episodeId: string,
    force = false,
  ) => {
    const requestId = chapterRequestRef.current + 1;
    chapterRequestRef.current = requestId;
    const cachedEntry = chapterDocumentCache.get(episodeId);
    const cachedDocument = cachedEntry?.value ?? null;
    const cacheTtl = cachedDocument?.stale
      ? STALE_CHAPTER_CACHE_TTL_MS
      : CHAPTER_CACHE_TTL_MS;
    if (!force && cacheEntryIsFresh(cachedEntry, cacheTtl)) {
      setChapterDocument(cachedDocument);
      setChapterState("ready");
      return;
    }
    setChapterDocument(cachedDocument);
    setChapterState(cachedDocument ? "ready" : "loading");
    try {
      const document = await podcastApi.getEpisodeChapters(episodeId);
      if (chapterRequestRef.current !== requestId) return;
      const chapters = document.chapters
        .filter((chapter) =>
          Number.isFinite(chapter.startSeconds)
          && chapter.startSeconds >= 0
          && Boolean(chapter.title.trim()))
        .slice(0, 1_000);
      if (document.episodeId !== episodeId || chapters.length === 0) {
        throw new Error("没有可显示的章节");
      }
      const resolvedDocument = { ...document, chapters };
      rememberBoundedCacheEntry(
        chapterDocumentCache,
        episodeId,
        { value: resolvedDocument, fetchedAt: Date.now() },
        CHAPTER_MEMORY_CACHE_LIMIT,
      );
      setChapterDocument(resolvedDocument);
      setChapterState("ready");
    } catch (reason) {
      if (chapterRequestRef.current !== requestId) return;
      setChapterDocument(cachedDocument);
      setChapterState(cachedDocument ? "ready" : "error");
      if (import.meta.env.DEV) {
        console.warn("[podcast] episode chapters failed", reason);
      }
    }
  }, []);

  const loadEpisodeDetail = useCallback(
    async (episodeId: string, preserveCurrent = false) => {
      const requestId = episodeDetailRequestRef.current + 1;
      episodeDetailRequestRef.current = requestId;
      relatedEpisodeRequestRef.current += 1;
      setRelatedEpisodes([]);
      setRelatedState("idle");
      chapterRequestRef.current += 1;
      setChapterDocument(null);
      setChapterState("idle");
      setChaptersOpen(false);
      setDetailState("loading");
      if (!preserveCurrent) setSelectedEpisodeDetail(null);
      try {
        const detail = await podcastApi.getEpisodeDetail(episodeId);
        if (episodeDetailRequestRef.current !== requestId) return null;
        setSelectedEpisodeId(episodeId);
        setSelectedEpisodeDetail(detail);
        setDetailState("ready");
        void loadRelatedEpisodes(episodeId);
        return detail;
      } catch (reason) {
        if (episodeDetailRequestRef.current !== requestId) return null;
        setDetailState("error");
        setError(errorMessage(reason, "读取单集详情失败"));
        return null;
      }
    },
    [loadRelatedEpisodes],
  );

  const applyEpisodeUpdate = useCallback(
    (nextEpisode: PodcastEpisode) => {
      const update = (episode: PodcastEpisode) =>
        episode.id === nextEpisode.id ? nextEpisode : episode;
      setEpisodes((current) => current.map(update));
      setRelatedEpisodes((current) => current.map(update));
      setHome((current) => ({
        continueListening: nextEpisode.completed
          ? current.continueListening.filter(
            (episode) => episode.id !== nextEpisode.id,
          )
          : current.continueListening.map(update),
        latestEpisodes: current.latestEpisodes.map(update),
        unplayedEpisodes:
          nextEpisode.completed || nextEpisode.progressSeconds > 0
            ? current.unplayedEpisodes.filter(
              (episode) => episode.id !== nextEpisode.id,
            )
            : current.unplayedEpisodes.map(update),
        downloadPriorityEpisodes: current.downloadPriorityEpisodes.map(update),
        downloadedEpisodes: nextEpisode.localPath
          ? upsertEpisode(current.downloadedEpisodes, nextEpisode)
          : current.downloadedEpisodes.filter(
            (episode) => episode.id !== nextEpisode.id,
          ),
        savedEpisodes: nextEpisode.saved
          ? upsertEpisode(current.savedEpisodes, nextEpisode)
          : current.savedEpisodes.filter(
            (episode) => episode.id !== nextEpisode.id,
          ),
        recentlyPlayedEpisodes:
          nextEpisode.progressSeconds > 0 || nextEpisode.completed
            ? upsertEpisode(current.recentlyPlayedEpisodes, nextEpisode)
            : current.recentlyPlayedEpisodes.filter(
              (episode) => episode.id !== nextEpisode.id,
            ),
      }));
      setSelectedEpisodeDetail((current) => {
        if (!current || current.episode.id !== nextEpisode.id) return current;
        return {
          ...current,
          episode: nextEpisode,
          saved: nextEpisode.saved,
        };
      });
      setEpisodeMenu((current) =>
        current?.episode.id === nextEpisode.id
          ? { ...current, episode: nextEpisode }
          : current
      );
      setLastPlayedEpisode((current) =>
        current?.id === nextEpisode.id ? nextEpisode : current
      );
      onEpisodeUpdated(nextEpisode);
    },
    [onEpisodeUpdated],
  );

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void Promise.all([loadFeeds(), loadHome()]).then(() =>
      refreshSubscribedFeeds()
    );
    if (
      restoredSession?.screen === "show"
      && restoredSession.selectedFeed
    ) {
      void loadEpisodes(restoredSession.selectedFeed);
    }
    if (
      !episodeRequest
      && restoredSession?.screen === "episode"
      && restoredSession.selectedEpisodeId
    ) {
      void loadEpisodeDetail(
        restoredSession.selectedEpisodeId,
        Boolean(restoredSession.selectedEpisodeDetail),
      );
    }
  }, [
    episodeRequest,
    loadEpisodeDetail,
    loadEpisodes,
    loadFeeds,
    loadHome,
    refreshSubscribedFeeds,
    restoredSession,
  ]);

  useEffect(() => {
    if (screen !== "discover" || discoveryState !== "idle") return;
    void loadDiscovery();
  }, [discoveryState, loadDiscovery, screen]);

  useEffect(() => {
    if (screen !== "library") return;
    void loadDownloadedLibrary(0);
  }, [libraryRevision, loadDownloadedLibrary, screen]);

  useEffect(() => {
    if (screen === "library") return;
    setDownloadSelectionMode(false);
    setSelectedDownloadIds(new Set());
    setDownloadCleanupIntent(null);
  }, [screen]);

  useEffect(() => {
    if (screen === "playlist") return;
    setQueueSelectionMode(false);
    setSelectedQueueIds(new Set());
    setQueueRemovalIntent(null);
    setDraggedQueueEpisodeId(null);
    setQueueDropTarget(null);
  }, [screen]);

  useEffect(() => {
    if (libraryState !== "ready") return;
    setCustomFeedOrder((current) => {
      const normalized = normalizePodcastFeedOrder(current, feeds);
      return sameStringArray(current, normalized) ? current : normalized;
    });
  }, [feeds, libraryState]);

  useEffect(() => {
    try {
      localStorage.setItem(
        PODCAST_LIBRARY_STORAGE_KEY,
        JSON.stringify({
          sort: librarySort,
          customOrder: customFeedOrder,
        }),
      );
    } catch {
      // Library ordering remains available for the current session.
    }
  }, [customFeedOrder, librarySort]);

  useEffect(() => {
    writePodcastSearchHistory(searchHistory);
  }, [searchHistory]);

  useEffect(() => {
    return () => {
      if (ignorePodcastSearchSubmitTimerRef.current !== null) {
        window.clearTimeout(ignorePodcastSearchSubmitTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setPodcastSessionSnapshot({
      screen,
      returnScreen,
      query,
      listenFilter,
      discoveryTopic,
      searchHeading,
      searchSort,
      searchHighlightQuery,
      searchState,
      searchResults,
      selectedFeed,
      episodes,
      selectedEpisodeId,
      selectedEpisodeDetail,
      episodeOriginScreen,
      episodeOriginFeed,
      lastPlayedEpisode,
    });
  }, [
    episodeOriginFeed,
    episodeOriginScreen,
    episodes,
    discoveryTopic,
    lastPlayedEpisode,
    listenFilter,
    query,
    returnScreen,
    screen,
    searchHeading,
    searchHighlightQuery,
    searchSort,
    searchState,
    searchResults,
    selectedEpisodeDetail,
    selectedEpisodeId,
    selectedFeed,
  ]);

  useEffect(() => {
    if (
      !episodeRequest
      || handledEpisodeRequestNonce.current === episodeRequest.nonce
    ) {
      return;
    }
    handledEpisodeRequestNonce.current = episodeRequest.nonce;
    if (episodeRequest.returnToNowPlaying) {
      episodeReturnSessionRef.current = podcastSessionSnapshot ?? {
        screen,
        returnScreen,
        query,
        listenFilter,
        discoveryTopic,
        searchHeading,
        searchSort,
        searchHighlightQuery,
        searchState,
        searchResults,
        selectedFeed,
        episodes,
        selectedEpisodeId,
        selectedEpisodeDetail,
        episodeOriginScreen,
        episodeOriginFeed,
        lastPlayedEpisode,
      };
      setEpisodeReturnToNowPlaying(true);
    } else {
      episodeReturnSessionRef.current = null;
      setEpisodeReturnToNowPlaying(false);
    }
    const origin = screen === "episode" ? episodeOriginScreen : screen;
    const originFeed = screen === "show"
      ? selectedFeed
      : screen === "episode"
        ? episodeOriginFeed
        : null;
    setEpisodeOriginScreen(origin);
    setEpisodeOriginFeed(originFeed);
    setSelectedEpisodeId(episodeRequest.episodeId);
    setSelectedEpisodeDetail((current) =>
      current?.episode.id === episodeRequest.episodeId ? current : null
    );
    setScreen("episode");
    setError(null);
    setNotice(null);
    void (async () => {
      await loadEpisodeDetail(
        episodeRequest.episodeId,
        selectedEpisodeDetail?.episode.id === episodeRequest.episodeId,
      );
      onEpisodeRequestHandled(episodeRequest.nonce);
    })();
  }, [
    episodeOriginFeed,
    episodeOriginScreen,
    episodeRequest,
    listenFilter,
    loadEpisodeDetail,
    onEpisodeRequestHandled,
    screen,
    selectedEpisodeDetail,
    selectedFeed,
  ]);

  useEffect(() => {
    if (screen !== "show" && screen !== "episode") return;
    const frame = window.requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [screen, selectedEpisodeId, selectedFeed?.id]);

  // quickplay 固定磁贴的深链：优先用已加载/随请求带来的节目快照，最后回退
  // 到资料库重新读取，保证未关注节目也能落到节目页。
  useEffect(() => {
    if (!feedRequest || handledFeedRequestNonce.current === feedRequest.nonce) {
      return;
    }
    handledFeedRequestNonce.current = feedRequest.nonce;
    void (async () => {
      const known = feeds.find((feed) => feed.id === feedRequest.feedId)
        ?? feedRequest.feed
        ?? (await loadFeeds()).find((feed) => feed.id === feedRequest.feedId);
      if (known) {
        await openStoredFeed(
          known,
          screen === "show" || screen === "episode" ? returnScreen : screen,
        );
      } else {
        setError("找不到固定的播客节目");
      }
      onFeedRequestHandled(feedRequest.nonce);
    })();
  }, [feedRequest, feeds, loadFeeds, onFeedRequestHandled, returnScreen, screen]);

  useEffect(() => {
    if (screen !== "show" && screen !== "episode") return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (screen === "episode") closeEpisodeDetail();
      else closeShow();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [
    episodeOriginFeed,
    episodeOriginScreen,
    episodeReturnToNowPlaying,
    returnScreen,
    screen,
  ]);

  useEffect(() => {
    if (libraryRevision <= handledLibraryRevision.current) return;
    handledLibraryRevision.current = libraryRevision;
    void Promise.all([loadFeeds(), loadHome()]);
    if (selectedEpisodeId) {
      void loadEpisodeDetail(selectedEpisodeId, Boolean(selectedEpisodeDetail));
    }
  }, [
    libraryRevision,
    loadEpisodeDetail,
    loadFeeds,
    loadHome,
  ]);

  function changeRootScreen(nextScreen: RootPodcastScreen) {
    episodeReturnSessionRef.current = null;
    setEpisodeReturnToNowPlaying(false);
    setScreen(nextScreen);
    setReturnScreen(nextScreen);
    setError(null);
    setNotice(null);
  }

  function moveFollowedFeed(feedId: string, direction: -1 | 1) {
    const order = normalizePodcastFeedOrder(customFeedOrder, feeds);
    const index = order.indexOf(feedId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= order.length) return;
    setCustomFeedOrder(
      movePodcastFeedOrder(order, feedId, order[targetIndex]),
    );
    setLibrarySort("custom");
    const feed = feeds.find((candidate) => candidate.id === feedId);
    setNotice(feed ? `已调整“${feed.title}”的位置` : "已调整节目位置");
  }

  function toggleDownloadSelection(episodeId: string) {
    if (
      !selectedDownloadIds.has(episodeId)
      && selectedDownloadIds.size >= PODCAST_DOWNLOAD_BATCH_LIMIT
    ) {
      setNotice(`每次最多选择 ${PODCAST_DOWNLOAD_BATCH_LIMIT} 集`);
      return;
    }
    setSelectedDownloadIds((current) => {
      const next = new Set(current);
      if (next.has(episodeId)) next.delete(episodeId);
      else next.add(episodeId);
      return next;
    });
  }

  function toggleDownloadSelectionMode() {
    if (downloadSelectionMode) setSelectedDownloadIds(new Set());
    setDownloadSelectionMode(!downloadSelectionMode);
  }

  function toggleAllLoadedDownloads() {
    const selectableIds = libraryDownloadedEpisodes
      .slice(0, PODCAST_DOWNLOAD_BATCH_LIMIT)
      .map((episode) => episode.id);
    const allSelected = selectableIds.length > 0
      && selectableIds.every((episodeId) => selectedDownloadIds.has(episodeId));
    setSelectedDownloadIds(
      allSelected ? new Set() : new Set(selectableIds),
    );
    if (
      !allSelected
      && libraryDownloadedEpisodes.length > PODCAST_DOWNLOAD_BATCH_LIMIT
    ) {
      setNotice(`已选择前 ${PODCAST_DOWNLOAD_BATCH_LIMIT} 集`);
    }
  }

  function requestSelectedDownloadDeletion() {
    const selectedEpisodes = libraryDownloadedEpisodes.filter((episode) =>
      selectedDownloadIds.has(episode.id)
    );
    if (selectedEpisodes.length === 0) return;
    setDownloadCleanupIntent({
      kind: "selected",
      episodeIds: selectedEpisodes.map((episode) => episode.id),
      downloadedBytes: podcastDownloadedBytes(selectedEpisodes),
    });
  }

  function applyDownloadDeletionLocally(episodeIds: readonly string[]) {
    const deleted = new Set(episodeIds);
    const clear = (episode: PodcastEpisode) =>
      deleted.has(episode.id) ? clearPodcastEpisodeDownload(episode) : episode;
    setEpisodes((current) => current.map(clear));
    setHome((current) => ({
      continueListening: current.continueListening.map(clear),
      latestEpisodes: current.latestEpisodes.map(clear),
      unplayedEpisodes: current.unplayedEpisodes.map(clear),
      downloadPriorityEpisodes: current.downloadPriorityEpisodes.map(clear),
      downloadedEpisodes: current.downloadedEpisodes.filter(
        (episode) => !deleted.has(episode.id),
      ),
      savedEpisodes: current.savedEpisodes.map(clear),
      recentlyPlayedEpisodes: current.recentlyPlayedEpisodes.map(clear),
    }));
    setDownloadPage((current) => ({
      ...current,
      episodes: current.episodes.filter(
        (episode) => !deleted.has(episode.id),
      ),
    }));
    setSelectedEpisodeDetail((current) => {
      if (!current || !deleted.has(current.episode.id)) return current;
      return {
        ...current,
        episode: clearPodcastEpisodeDownload(current.episode),
      };
    });
    setEpisodeMenu((current) => {
      if (!current || !deleted.has(current.episode.id)) return current;
      return {
        ...current,
        episode: clearPodcastEpisodeDownload(current.episode),
      };
    });
    setLastPlayedEpisode((current) =>
      current && deleted.has(current.id)
        ? clearPodcastEpisodeDownload(current)
        : current
    );
  }

  async function confirmDownloadCleanup() {
    const intent = downloadCleanupIntent;
    if (!intent || downloadCleanupAction) return;
    setDownloadCleanupAction(intent.kind);
    setError(null);
    setNotice(null);
    try {
      const result = intent.kind === "selected"
        ? await podcastApi.deleteEpisodeDownloads(intent.episodeIds)
        : await podcastApi.clearCompletedDownloads();
      applyDownloadDeletionLocally(result.deletedEpisodeIds);
      setSelectedDownloadIds(new Set());
      if (intent.kind === "selected") setDownloadSelectionMode(false);
      setDownloadCleanupIntent(null);
      await Promise.all([
        Promise.resolve(onDownloadsDeleted(result.deletedEpisodeIds)),
        loadFeeds(),
        loadHome(),
        loadDownloadedLibrary(0),
      ]);
      if (result.deletedCount > 0) {
        setNotice(
          `已删除 ${result.deletedCount} 集下载，释放 ${
            formatFileSize(result.deletedBytes)
          }`,
        );
      } else {
        setNotice(
          intent.kind === "completed"
            ? "没有可清理的已听完下载"
            : "所选下载已不存在",
        );
      }
    } catch (reason) {
      setError(errorMessage(reason, "删除播客下载失败"));
    } finally {
      setDownloadCleanupAction(null);
    }
  }

  function toggleQueueSelection(episodeId: string) {
    if (
      !selectedQueueIds.has(episodeId)
      && selectedQueueIds.size >= PODCAST_QUEUE_BATCH_LIMIT
    ) {
      setNotice(`每次最多选择 ${PODCAST_QUEUE_BATCH_LIMIT} 集`);
      return;
    }
    setSelectedQueueIds((current) => {
      const next = new Set(current);
      if (next.has(episodeId)) next.delete(episodeId);
      else next.add(episodeId);
      return next;
    });
  }

  function toggleQueueSelectionMode() {
    if (queueBatchAction) return;
    if (queueSelectionMode) setSelectedQueueIds(new Set());
    setDraggedQueueEpisodeId(null);
    setQueueDropTarget(null);
    setQueueSelectionMode(!queueSelectionMode);
  }

  function toggleAllQueueEpisodes() {
    const selectableIds = upNextQueue
      .slice(0, PODCAST_QUEUE_BATCH_LIMIT)
      .map((item) => item.episode.id);
    setSelectedQueueIds(
      allQueueEpisodesSelected ? new Set() : new Set(selectableIds),
    );
    if (
      !allQueueEpisodesSelected
      && upNextQueue.length > PODCAST_QUEUE_BATCH_LIMIT
    ) {
      setNotice(`已选择前 ${PODCAST_QUEUE_BATCH_LIMIT} 集`);
    }
  }

  async function downloadSelectedQueueEpisodes() {
    if (queueBatchAction || selectedQueueEpisodes.length === 0) return;
    const episodesToDownload = selectedQueueEpisodes.filter(
      (episode) => !episode.localPath,
    );
    setError(null);
    if (episodesToDownload.length === 0) {
      setNotice("所选单集均已下载");
      return;
    }
    setQueueBatchAction("download");
    setNotice(`正在依次下载 ${episodesToDownload.length} 集`);
    try {
      const result = await onDownloadQueueEpisodes(episodesToDownload);
      if (result.downloadedCount === 0 && result.failedCount === 0) {
        setNotice("所选单集均已下载");
      } else if (result.failedCount > 0) {
        setNotice(
          result.downloadedCount > 0
            ? `已下载 ${result.downloadedCount} 集，${result.failedCount} 集未完成`
            : `${result.failedCount} 集下载未完成`,
        );
      } else {
        setNotice(`已完成 ${result.downloadedCount} 集下载`);
      }
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason, "批量下载失败"));
    } finally {
      setQueueBatchAction(null);
    }
  }

  async function setSelectedQueueEpisodesPlayed(played: boolean) {
    if (queueBatchAction || selectedQueueEpisodes.length === 0) return;
    const episodeIds = selectedQueueEpisodes.map((episode) => episode.id);
    setQueueBatchAction("played");
    setError(null);
    setNotice(null);
    try {
      await onSetQueueEpisodesPlayed(episodeIds, played);
      setNotice(
        `已将 ${episodeIds.length} 集标记为${played ? "已听" : "未听"}`,
      );
    } catch (reason) {
      setError(errorMessage(reason, "批量更新播放状态失败"));
    } finally {
      setQueueBatchAction(null);
    }
  }

  function requestSelectedQueueRemoval() {
    if (selectedQueueEpisodes.length === 0) return;
    setQueueRemovalIntent({
      episodeIds: selectedQueueEpisodes.map((episode) => episode.id),
    });
  }

  async function confirmQueueRemoval() {
    const intent = queueRemovalIntent;
    if (!intent || queueBatchAction) return;
    setQueueBatchAction("remove");
    setError(null);
    setNotice(null);
    try {
      await onRemoveQueueEpisodes(intent.episodeIds);
      setSelectedQueueIds(new Set());
      setQueueSelectionMode(false);
      setQueueRemovalIntent(null);
      setNotice(`已从待播移除 ${intent.episodeIds.length} 集`);
    } catch (reason) {
      setError(errorMessage(reason, "批量移除待播失败"));
    } finally {
      setQueueBatchAction(null);
    }
  }

  function resetQueueDrag() {
    setDraggedQueueEpisodeId(null);
    setQueueDropTarget(null);
  }

  function handleQueueDragStart(
    event: ReactDragEvent<HTMLSpanElement>,
    episodeId: string,
  ) {
    if (queueSelectionMode || queueBatchAction) {
      event.preventDefault();
      return;
    }
    const row = event.currentTarget.closest("article");
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
    event: ReactDragEvent<HTMLElement>,
  ): PodcastQueueDropPlacement {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
  }

  function handleQueueDragOver(
    event: ReactDragEvent<HTMLElement>,
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
      current?.episodeId === targetEpisodeId
      && current.placement === placement
        ? current
        : { episodeId: targetEpisodeId, placement }
    ));
  }

  function handleQueueDrop(
    event: ReactDragEvent<HTMLElement>,
    targetEpisodeId: string,
  ) {
    event.preventDefault();
    const sourceEpisodeId = draggedQueueEpisodeId
      ?? event.dataTransfer.getData("text/plain");
    const placement = queueDropPlacement(event);
    const sourceIndex = upNextQueue.findIndex(
      (item) => item.episode.id === sourceEpisodeId,
    );
    const targetIndex = upNextQueue.findIndex(
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
        void Promise.resolve(
          onReorderQueueEpisode(
            sourceEpisodeId,
            targetEpisodeId,
            placement,
          ),
        ).catch((reason) => {
          setError(errorMessage(reason, "无法调整待播顺序"));
        });
        setQueueAnnouncement(
          `已将“${upNextQueue[sourceIndex]?.episode.title ?? "单集"}”移到第 ${
            destinationIndex + 1
          } 位`,
        );
      }
    }
    resetQueueDrag();
  }

  async function runAppleSearch(
    requestedQuery: string,
    {
      heading = "搜索结果",
      topic = null,
      remember = false,
    }: {
      heading?: string;
      topic?: PodcastDiscoveryTopic | null;
      remember?: boolean;
    } = {},
  ) {
    const cleanQuery = requestedQuery.trim();
    if (!cleanQuery) return;
    const requestId = appleSearchRequestRef.current + 1;
    appleSearchRequestRef.current = requestId;
    setDiscoveryTopic(topic);
    setSearchHeading(heading);
    setSearchSort("relevance");
    setSearchHighlightQuery(remember ? cleanQuery : "");
    setError(null);
    setNotice(null);
    if (remember && isRememberedPodcastSearchTerm(cleanQuery)) {
      setSearchHistory((current) =>
        addPodcastSearchHistory(current, cleanQuery)
      );
    }
    const cacheKey = cleanQuery.toLocaleLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached) {
      setSearchResults(cached.results);
      setSearchState("ready");
      if (Date.now() - cached.fetchedAt < SEARCH_CACHE_TTL_MS) return;
    } else {
      setSearchResults([]);
      setSearchState("loading");
    }
    try {
      const results = await podcastApi.searchApplePodcasts(cleanQuery, 18);
      if (appleSearchRequestRef.current !== requestId) return;
      rememberBoundedCacheEntry(
        searchCache,
        cacheKey,
        { results, fetchedAt: Date.now() },
        SEARCH_CACHE_LIMIT,
      );
      setSearchResults(results);
      setSearchState("ready");
    } catch (reason) {
      if (appleSearchRequestRef.current !== requestId) return;
      if (cached) {
        setSearchResults(cached.results);
        setSearchState("ready");
        setNotice("网络暂时不可用，已保留上次搜索结果");
      } else {
        setSearchResults([]);
        setSearchState("error");
        setError(errorMessage(reason, "搜索节目失败"));
      }
    }
  }

  function searchApple(event: ReactFormEvent) {
    event.preventDefault();
    const nativeEvent = event.nativeEvent as {
      isComposing?: boolean;
      keyCode?: number;
    };
    if (
      shouldBlockPodcastSearchCommit({
        composing: podcastSearchComposingRef.current,
        ignoreSubmit: ignorePodcastSearchSubmitRef.current,
        isComposing: nativeEvent.isComposing,
        keyCode: nativeEvent.keyCode,
      })
    ) {
      return;
    }
    void runAppleSearch(query, { remember: true });
  }

  function handlePodcastSearchCompositionStart() {
    podcastSearchComposingRef.current = true;
  }

  function handlePodcastSearchCompositionEnd() {
    podcastSearchComposingRef.current = false;
    ignorePodcastSearchSubmitRef.current = true;
    if (ignorePodcastSearchSubmitTimerRef.current !== null) {
      window.clearTimeout(ignorePodcastSearchSubmitTimerRef.current);
    }
    ignorePodcastSearchSubmitTimerRef.current = window.setTimeout(() => {
      ignorePodcastSearchSubmitRef.current = false;
      ignorePodcastSearchSubmitTimerRef.current = null;
    }, PODCAST_SEARCH_COMPOSITION_GRACE_MS);
  }

  function handlePodcastSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    if (shouldBlockPodcastSearchCommit({
      composing: podcastSearchComposingRef.current,
      ignoreSubmit: ignorePodcastSearchSubmitRef.current,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
    })) {
      event.preventDefault();
    }
  }

  function showPopularDiscovery() {
    appleSearchRequestRef.current += 1;
    setDiscoveryTopic("popular");
    setQuery("");
    setSearchResults([]);
    setSearchState("idle");
    setSearchHeading("搜索结果");
    setSearchSort("relevance");
    setSearchHighlightQuery("");
    setError(null);
    setNotice(null);
    void loadDiscovery();
  }

  function browseDiscoveryTopic(topic: PodcastDiscoveryTopic) {
    if (topic === "popular") {
      showPopularDiscovery();
      return;
    }
    const topicOption = PODCAST_DISCOVERY_TOPICS.find(
      (candidate) => candidate.id === topic,
    );
    if (!topicOption?.query) return;
    setQuery("");
    void runAppleSearch(topicOption.query, {
      heading: `${topicOption.label}主题`,
      topic,
    });
  }

  function repeatPodcastSearch(historyQuery: string) {
    setQuery(historyQuery);
    void runAppleSearch(historyQuery, { remember: true });
  }

  async function openStoredFeed(
    feed: PodcastFeed,
    origin: RootPodcastScreen,
  ) {
    setReturnScreen(origin);
    setSelectedFeed(feed);
    setScreen("show");
    setError(null);
    setNotice(null);
    await loadEpisodes(feed);
  }

  async function previewFeed(
    candidate: ShowCandidate,
    origin: RootPodcastScreen,
  ) {
    if (openingId) return;
    const stored = selectedFeed?.feedUrl === candidate.feedUrl
      ? selectedFeed
      : feeds.find((feed) => feed.feedUrl === candidate.feedUrl);
    const cachedPreviewEntry = previewFeedCache.get(candidate.feedUrl);
    const cachedPreview = cacheEntryIsFresh(
      cachedPreviewEntry,
      PREVIEW_FEED_CACHE_TTL_MS,
    )
      ? cachedPreviewEntry?.value
      : null;
    const reusableStoredFeed = stored && (
      stored.subscribed
      || Date.now() - stored.lastFetchedAt < PREVIEW_FEED_CACHE_TTL_MS
    )
      ? stored
      : null;
    const reusableFeed = reusableStoredFeed ?? cachedPreview;
    if (reusableFeed) {
      await openStoredFeed(reusableFeed, origin);
      return;
    }

    setOpeningId(candidate.id);
    setOpeningCandidate(candidate);
    setError(null);
    try {
      const result = await podcastApi.previewPodcastFeed(candidate.feedUrl);
      rememberBoundedCacheEntry(
        previewFeedCache,
        candidate.feedUrl,
        { value: result.feed, fetchedAt: Date.now() },
        SEARCH_CACHE_LIMIT,
      );
      setNotice(null);
      setReturnScreen(origin);
      setSelectedFeed(result.feed);
      setScreen("show");
      setOpeningCandidate(null);
      await loadEpisodes(result.feed);
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason, "打开节目失败"));
    } finally {
      setOpeningId(null);
      setOpeningCandidate(null);
    }
  }

  async function subscribeRss(event: ReactFormEvent) {
    event.preventDefault();
    const cleanUrl = rssUrl.trim();
    if (!cleanUrl || openingId) return;
    setOpeningId(cleanUrl);
    setOpeningCandidate({
      id: cleanUrl,
      title: "RSS 订阅",
      author: cleanUrl,
      feedUrl: cleanUrl,
      artworkUrl: null,
    });
    setError(null);
    setNotice(null);
    try {
      const result = await podcastApi.subscribePodcastFeed(cleanUrl);
      setRssUrl("");
      setNotice(`已关注“${result.feed.title}”`);
      await loadFeeds();
      await loadHome();
      setReturnScreen("library");
      setSelectedFeed(result.feed);
      setScreen("show");
      setOpeningCandidate(null);
      await loadEpisodes(result.feed);
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason, "通过 RSS 关注节目失败"));
    } finally {
      setOpeningId(null);
      setOpeningCandidate(null);
    }
  }

  async function refreshSelectedFeed() {
    if (!selectedFeed || openingId) return;
    setOpeningId(selectedFeed.id);
    setError(null);
    setNotice(`正在刷新“${selectedFeed.title}”`);
    try {
      const report = await podcastApi.refreshPodcastFeeds({ feedId: selectedFeed.id, force: true });
      const failure = report.failures.find(
        (item) => item.feedId === selectedFeed.id,
      );
      if (failure) throw new Error(failure.message);
      chapterDocumentCache.clear();
      const nextFeeds = await loadFeeds();
      const listedFeed = nextFeeds.find(
        (feed) => feed.id === selectedFeed.id,
      );
      const refreshedFeed = listedFeed ?? selectedFeed;
      setSelectedFeed(refreshedFeed);
      const [nextEpisodes] = await Promise.all([
        loadEpisodes(refreshedFeed),
        loadHome(),
      ]);
      if (!listedFeed && nextEpisodes?.[0]) {
        try {
          const detail = await podcastApi.getEpisodeDetail(nextEpisodes[0].id);
          if (selectedFeedRef.current?.id === selectedFeed.id) {
            setSelectedFeed(detail.feed);
          }
        } catch {
          // Refreshed episodes remain usable if preview metadata cannot be reloaded.
        }
      }
      setNotice(
        report.inserted > 0
          ? `已更新，新增 ${report.inserted} 集`
          : report.updated > 0
            ? `已更新 ${report.updated} 集信息`
            : "节目已是最新",
      );
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason, "刷新节目失败"));
    } finally {
      setOpeningId(null);
    }
  }

  async function toggleFollowing() {
    if (!selectedFeed || following) return;
    setFollowing(true);
    setError(null);
    try {
      const nextSubscribed = !selectedFeed.subscribed;
      await podcastApi.setFeedFollowing(selectedFeed.id, nextSubscribed);
      setSelectedFeed((current) =>
        current ? { ...current, subscribed: nextSubscribed } : current
      );
      setNotice(
        nextSubscribed
          ? `已关注“${selectedFeed.title}”`
          : `已取消关注“${selectedFeed.title}”`,
      );
      await loadFeeds();
      await loadHome();
    } catch (reason) {
      setError(errorMessage(reason, "更新关注状态失败"));
    } finally {
      setFollowing(false);
    }
  }

  async function downloadEpisode(episode: PodcastEpisode) {
    if (downloadingId || episode.localPath) return;
    setDownloadingId(episode.id);
    setError(null);
    setNotice(`正在下载“${episode.title}”`);
    downloadProgressEpisodeRef.current = episode.id;
    let progressRequestActive = false;
    const refreshDownloadProgress = async () => {
      if (
        downloadProgressEpisodeRef.current !== episode.id
        || progressRequestActive
      ) return;
      progressRequestActive = true;
      try {
        const detail = await podcastApi.getEpisodeDetail(episode.id);
        if (downloadProgressEpisodeRef.current === episode.id) {
          applyEpisodeUpdate(detail.episode);
        }
      } catch (reason) {
        if (import.meta.env.DEV) {
          console.warn("[podcast] download progress refresh failed", reason);
        }
      } finally {
        progressRequestActive = false;
      }
    };
    const progressPoll = window.setInterval(
      () => void refreshDownloadProgress(),
      PODCAST_DOWNLOAD_PROGRESS_POLL_MS,
    );
    downloadProgressPollRef.current = progressPoll;
    void refreshDownloadProgress();
    try {
      const result = await podcastApi.downloadPodcastEpisode(episode.id);
      try {
        const nextDetail = await podcastApi.getEpisodeDetail(episode.id);
        applyEpisodeUpdate(nextDetail.episode);
      } catch (refreshReason) {
        if (import.meta.env.DEV) {
          console.warn(
            "[podcast] downloaded episode refresh failed",
            refreshReason,
          );
        }
      }
      setNotice(
        result.resumed
          ? "下载已续传完成，可离线收听"
          : "下载完成，可离线收听",
      );
      await loadHome();
    } catch (reason) {
      try {
        const nextDetail = await podcastApi.getEpisodeDetail(episode.id);
        applyEpisodeUpdate(nextDetail.episode);
      } catch (refreshReason) {
        if (import.meta.env.DEV) {
          console.warn(
            "[podcast] failed download refresh failed",
            refreshReason,
          );
        }
      }
      setNotice(null);
      setError(errorMessage(reason, "下载单集失败"));
    } finally {
      if (downloadProgressEpisodeRef.current === episode.id) {
        downloadProgressEpisodeRef.current = null;
      }
      window.clearInterval(progressPoll);
      if (downloadProgressPollRef.current === progressPoll) {
        downloadProgressPollRef.current = null;
      }
      setDownloadingId(null);
    }
  }

  async function deleteEpisodeDownload(detail: PodcastEpisodeDetail) {
    if (detailAction || downloadingId) return;
    setDetailAction("delete");
    setError(null);
    try {
      const nextDetail = await podcastApi.deleteEpisodeDownload(detail.episode.id);
      setSelectedEpisodeDetail(nextDetail);
      applyEpisodeUpdate(nextDetail.episode);
      setNotice("已删除离线文件");
      await loadHome();
    } catch (reason) {
      setError(errorMessage(reason, "删除离线文件失败"));
    } finally {
      setDetailAction(null);
    }
  }

  async function toggleEpisodeSaved(detail: PodcastEpisodeDetail) {
    if (detailAction) return;
    const nextSaved = !detail.episode.saved;
    setDetailAction("save");
    setError(null);
    try {
      const nextDetail = await podcastApi.setEpisodeSaved(detail.episode.id, nextSaved);
      setSelectedEpisodeDetail(nextDetail);
      applyEpisodeUpdate(nextDetail.episode);
      setNotice(nextSaved ? "已加入稍后听" : "已从稍后听移除");
      await loadHome();
    } catch (reason) {
      setError(errorMessage(reason, "更新稍后听失败"));
    } finally {
      setDetailAction(null);
    }
  }

  async function toggleEpisodePlayed(detail: PodcastEpisodeDetail) {
    if (detailAction || updatingPlayedId) return;
    const nextPlayed = !detail.episode.completed;
    setDetailAction("played");
    setError(null);
    try {
      const nextDetail = await onSetEpisodePlayed(
        detail.episode.id,
        nextPlayed,
      );
      setSelectedEpisodeDetail(nextDetail);
      applyEpisodeUpdate(nextDetail.episode);
      setNotice(nextPlayed ? "已标记为已播放" : "已标记为未播放");
      await loadHome();
    } catch (reason) {
      setError(errorMessage(reason, "更新播放状态失败"));
    } finally {
      setDetailAction(null);
    }
  }

  async function toggleEpisodePlayedFromMenu(episode: PodcastEpisode) {
    if (detailAction || updatingPlayedId) return;
    const nextPlayed = !episode.completed;
    setUpdatingPlayedId(episode.id);
    setError(null);
    setNotice(null);
    try {
      const nextDetail = await onSetEpisodePlayed(episode.id, nextPlayed);
      applyEpisodeUpdate(nextDetail.episode);
      setNotice(nextPlayed ? "已标记为已播放" : "已标记为未播放");
      await loadHome();
    } catch (reason) {
      setError(errorMessage(reason, "更新播放状态失败"));
    } finally {
      setUpdatingPlayedId(null);
    }
  }

  async function queueEpisodeFromMenu(episode: PodcastEpisode) {
    setError(null);
    setNotice(null);
    if (activeEpisodeId === episode.id) {
      setNotice("本集正在播放");
      return;
    }
    if (queue.some((item) => item.episode.id === episode.id)) {
      setNotice("本集已在待播");
      return;
    }
    try {
      const added = await onQueueEpisode(episode, false);
      if (!added) {
        setError("加入待播失败");
        return;
      }
      setNotice(`已将“${episode.title}”加入待播`);
    } catch (reason) {
      setError(errorMessage(reason, "加入待播失败"));
    }
  }

  async function shareEpisode(episode: PodcastEpisode) {
    const url = shareablePodcastEpisodeUrl(episode);
    setError(null);
    setNotice(null);
    if (!url) {
      setError("这集没有可分享的链接");
      return;
    }

    const shareData = {
      title: episode.title,
      text: episode.feedTitle
        ? `${episode.feedTitle} · ${episode.title}`
        : episode.title,
      url,
    };

    let canUseWebShare = typeof navigator.share === "function";
    if (canUseWebShare && typeof navigator.canShare === "function") {
      try {
        canUseWebShare = navigator.canShare(shareData);
      } catch {
        canUseWebShare = false;
      }
    }

    if (canUseWebShare) {
      try {
        await navigator.share(shareData);
        setNotice("已分享单集");
        return;
      } catch (reason) {
        if (reason instanceof Error && reason.name === "AbortError") return;
        // Web Share may be exposed but unavailable in the current WebView.
        // Continue with the clipboard path so the action still succeeds.
      }
    }

    try {
      await copyPodcastShareUrl(url);
      setNotice("已复制单集链接");
    } catch {
      setNotice(null);
      setError("无法分享这集，请稍后重试");
    }
  }

  function showEpisodeMenu(
    event: ReactMouseEvent<HTMLElement>,
    episode: PodcastEpisode,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const openedFromKeyboard = event.clientX === 0 && event.clientY === 0;
    setEpisodeMenu({
      x: openedFromKeyboard
        ? rect.left + Math.min(rect.width, 120)
        : event.clientX,
      y: openedFromKeyboard
        ? rect.top + Math.min(rect.height, 36)
        : event.clientY,
      episode,
      returnFocus: event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button")
        : null,
    });
  }

  function podcastPlaybackForEpisode(
    episode: PodcastEpisode,
  ): PodcastPlayback {
    const feed = selectedFeed?.id === episode.feedId
      ? selectedFeed
      : feedById.get(episode.feedId);
    return {
      ...episode,
      episodeId: episode.id,
      podcastTitle: episode.feedTitle ?? feed?.title ?? "播客",
      artworkUrl:
        episode.artworkUrl
        ?? episode.feedArtworkUrl
        ?? feed?.artworkUrl
        ?? null,
      savedProgressSeconds: Math.max(0, episode.progressSeconds),
      playbackLocalPath: episode.localPath,
    };
  }

  function rememberEpisodePlayback(episode: PodcastEpisode) {
    setLastPlayedEpisode(episode);
    setHome((current) => ({
      ...current,
      recentlyPlayedEpisodes: promoteEpisode(
        current.recentlyPlayedEpisodes,
        episode,
      ),
    }));
  }

  function playEpisode(episode: PodcastEpisode) {
    rememberEpisodePlayback(episode);
    onPlayEpisode(podcastPlaybackForEpisode(episode));
  }

  function playEpisodeAt(episode: PodcastEpisode, positionSeconds: number) {
    rememberEpisodePlayback(episode);
    onPlayEpisodeAt(
      podcastPlaybackForEpisode(episode),
      Math.max(0, positionSeconds),
    );
  }

  function toggleEpisodeChapters() {
    if (!selectedEpisodeDetail?.hasChapters) return;
    if (chaptersOpen) {
      setChaptersOpen(false);
      return;
    }
    setChaptersOpen(true);
    if (
      chapterState === "idle"
      || chapterState === "error"
      || chapterDocument?.episodeId !== selectedEpisodeDetail.episode.id
    ) {
      void loadEpisodeChapters(selectedEpisodeDetail.episode.id);
    }
  }

  function openEpisodeDetail(
    episode: PodcastEpisode,
    origin: EpisodeOriginScreen = screen === "episode"
      ? episodeOriginScreen
      : screen,
  ) {
    const preserveNowPlayingReturn =
      screen === "episode" && episodeReturnToNowPlaying;
    if (!preserveNowPlayingReturn) {
      episodeReturnSessionRef.current = null;
      setEpisodeReturnToNowPlaying(false);
    }
    const originFeed = origin === "show" ? selectedFeed : null;
    setEpisodeOriginScreen(origin);
    setEpisodeOriginFeed(originFeed);
    setSelectedEpisodeId(episode.id);
    setSelectedEpisodeDetail((current) =>
      current?.episode.id === episode.id ? current : null
    );
    setScreen("episode");
    setError(null);
    setNotice(null);
    void loadEpisodeDetail(
      episode.id,
      selectedEpisodeDetail?.episode.id === episode.id,
    );
  }

  function closeEpisodeDetail() {
    episodeDetailRequestRef.current += 1;
    relatedEpisodeRequestRef.current += 1;
    chapterRequestRef.current += 1;
    setError(null);
    setNotice(null);
    if (episodeReturnToNowPlaying) {
      if (episodeReturnSessionRef.current) {
        setPodcastSessionSnapshot(episodeReturnSessionRef.current);
      }
      episodeReturnSessionRef.current = null;
      onReturnToNowPlaying();
      return;
    }
    if (episodeOriginScreen === "show" && episodeOriginFeed) {
      setSelectedFeed(episodeOriginFeed);
      setScreen("show");
      return;
    }
    const nextScreen = episodeOriginScreen === "show"
      ? returnScreen
      : episodeOriginScreen;
    setScreen(nextScreen);
    setReturnScreen(nextScreen);
  }

  function closeShow() {
    setScreen(returnScreen);
    setError(null);
    setNotice(null);
  }

  async function openEpisodeShow() {
    if (!selectedEpisodeDetail) return;
    episodeDetailRequestRef.current += 1;
    relatedEpisodeRequestRef.current += 1;
    chapterRequestRef.current += 1;
    episodeReturnSessionRef.current = null;
    setEpisodeReturnToNowPlaying(false);
    const originRoot = episodeOriginScreen === "show"
      ? returnScreen
      : episodeOriginScreen;
    setReturnScreen(originRoot);
    setSelectedFeed(selectedEpisodeDetail.feed);
    setScreen("show");
    setError(null);
    setNotice(null);
    await loadEpisodes(selectedEpisodeDetail.feed);
  }

  // Progress ticks arrive at ~4Hz while the overlays only display
  // second-granularity values; flooring keeps the dependent memo chains from
  // recomputing on every tick.
  const activeProgressSeconds = Number.isFinite(activeProgress)
    ? Math.max(0, Math.floor(activeProgress))
    : 0;
  const liveEpisode = useCallback(
    (episode: PodcastEpisode) =>
      mergePodcastEpisodePlayback(
        episode,
        activeEpisode,
        activeProgressSeconds,
        activeDuration,
      ),
    [activeDuration, activeEpisode, activeProgressSeconds],
  );
  const liveActiveEpisode = useMemo(
    () => activeEpisode ? liveEpisode(activeEpisode) : null,
    [activeEpisode, liveEpisode],
  );
  const displayedRelatedEpisodes = useMemo(
    () => relatedEpisodes
      .map(liveEpisode)
      .filter((episode) =>
        episode.id !== selectedEpisodeId
        && Boolean(episode.enclosureUrl.trim()))
      .slice(0, 6),
    [liveEpisode, relatedEpisodes, selectedEpisodeId],
  );
  const continueListeningEpisodes = useMemo(() => {
    const next = home.continueListening
      .map(liveEpisode)
      .filter((episode) => !episode.completed);
    if (
      liveActiveEpisode
      && liveActiveEpisode.progressSeconds > 0
      && !liveActiveEpisode.completed
      && !next.some((episode) => episode.id === liveActiveEpisode.id)
    ) {
      return [liveActiveEpisode, ...next];
    }
    return next;
  }, [home.continueListening, liveActiveEpisode, liveEpisode]);
  const latestEpisodes = useMemo(
    () => home.latestEpisodes.map(liveEpisode),
    [home.latestEpisodes, liveEpisode],
  );
  const listeningFilterEpisodes = useMemo(() => {
    const source =
      listenFilter === "unplayed"
        ? home.unplayedEpisodes
        : listenFilter === "download-first"
          ? home.downloadPriorityEpisodes
          : home.latestEpisodes;
    return source.map(liveEpisode);
  }, [
    home.downloadPriorityEpisodes,
    home.latestEpisodes,
    home.unplayedEpisodes,
    listenFilter,
    liveEpisode,
  ]);
  const filteredLatestEpisodes = useMemo(
    () => filterPodcastListeningEpisodes(listeningFilterEpisodes, listenFilter),
    [listenFilter, listeningFilterEpisodes],
  );
  const listenNewReferenceTime = Date.now();
  const hasListenContent =
    continueListeningEpisodes.length > 0 || latestEpisodes.length > 0;
  const savedEpisodes = useMemo(
    () => home.savedEpisodes.map(liveEpisode),
    [home.savedEpisodes, liveEpisode],
  );
  const downloadedEpisodes = useMemo(
    () => home.downloadedEpisodes.map(liveEpisode),
    [home.downloadedEpisodes, liveEpisode],
  );
  const recentlyPlayedEpisodes = useMemo(
    () => home.recentlyPlayedEpisodes.map(liveEpisode),
    [home.recentlyPlayedEpisodes, liveEpisode],
  );
  const hasDownloadedLibraryPage =
    downloadLibraryState === "ready" || downloadPage.totalCount > 0;
  const libraryDownloadedEpisodes = useMemo(() => {
    if (hasDownloadedLibraryPage) {
      return downloadPage.episodes.map(liveEpisode);
    }
    return downloadedEpisodes;
  }, [
    downloadPage.episodes,
    downloadedEpisodes,
    hasDownloadedLibraryPage,
    liveEpisode,
  ]);
  const orderedFeeds = useMemo(
    () => sortPodcastFeeds(feeds, librarySort, customFeedOrder),
    [customFeedOrder, feeds, librarySort],
  );
  const downloadGroups = useMemo(
    () => groupPodcastDownloads(libraryDownloadedEpisodes),
    [libraryDownloadedEpisodes],
  );
  const downloadedBytes = useMemo(
    () => hasDownloadedLibraryPage
      ? downloadPage.totalBytes
      : podcastDownloadedBytes(libraryDownloadedEpisodes),
    [
      downloadPage.totalBytes,
      hasDownloadedLibraryPage,
      libraryDownloadedEpisodes,
    ],
  );
  const downloadedCount = hasDownloadedLibraryPage
    ? downloadPage.totalCount
    : libraryDownloadedEpisodes.length;
  const downloadedFeedCount = hasDownloadedLibraryPage
    ? downloadPage.feedCount
    : downloadGroups.length;
  const allLoadedDownloadsSelected =
    libraryDownloadedEpisodes.length > 0
    && libraryDownloadedEpisodes
      .slice(0, PODCAST_DOWNLOAD_BATCH_LIMIT)
      .every((episode) =>
      selectedDownloadIds.has(episode.id)
    );
  const loadedDownloadsExceedBatchLimit =
    libraryDownloadedEpisodes.length > PODCAST_DOWNLOAD_BATCH_LIMIT;

  useEffect(() => {
    const available = new Set(
      libraryDownloadedEpisodes.map((episode) => episode.id),
    );
    setSelectedDownloadIds((current) => {
      const next = new Set(
        [...current].filter((episodeId) => available.has(episodeId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [libraryDownloadedEpisodes]);

  const displayedEpisodes = useMemo(
    () => episodes.map(liveEpisode),
    [episodes, liveEpisode],
  );
  const displayedEpisodeDetail = useMemo(() => {
    if (!selectedEpisodeDetail) return null;
    return {
      ...selectedEpisodeDetail,
      episode: liveEpisode(selectedEpisodeDetail.episode),
    };
  }, [liveEpisode, selectedEpisodeDetail]);
  const upNextQueue = useMemo(
    () => queue.filter((item) => item.episode.id !== currentEpisodeId),
    [currentEpisodeId, queue],
  );
  const selectedQueueEpisodes = useMemo(
    () => upNextQueue
      .map((item) => item.episode)
      .filter((episode) => selectedQueueIds.has(episode.id))
      .slice(0, PODCAST_QUEUE_BATCH_LIMIT),
    [selectedQueueIds, upNextQueue],
  );
  const allQueueEpisodesSelected =
    upNextQueue.length > 0
    && upNextQueue
      .slice(0, PODCAST_QUEUE_BATCH_LIMIT)
      .every((item) => selectedQueueIds.has(item.episode.id));

  useEffect(() => {
    const available = new Set(
      upNextQueue.map((item) => item.episode.id),
    );
    setSelectedQueueIds((current) => {
      const next = new Set(
        [...current].filter((episodeId) => available.has(episodeId)),
      );
      return next.size === current.size ? current : next;
    });
    if (upNextQueue.length === 0) setQueueSelectionMode(false);
  }, [upNextQueue]);

  const knownActiveEpisode = useMemo(() => {
    if (liveActiveEpisode) return liveActiveEpisode;
    if (!currentEpisodeId) return null;
    const knownEpisodes = [
      selectedEpisodeDetail?.episode,
      lastPlayedEpisode,
      ...queue.map((item) => item.episode),
      ...displayedEpisodes,
      ...continueListeningEpisodes,
      ...latestEpisodes,
      ...savedEpisodes,
      ...downloadedEpisodes,
      ...libraryDownloadedEpisodes,
      ...recentlyPlayedEpisodes,
    ].filter((episode): episode is PodcastEpisode => Boolean(episode));
    return knownEpisodes.find((episode) => episode.id === currentEpisodeId) ?? null;
  }, [
    continueListeningEpisodes,
    currentEpisodeId,
    displayedEpisodes,
    downloadedEpisodes,
    libraryDownloadedEpisodes,
    latestEpisodes,
    lastPlayedEpisode,
    liveActiveEpisode,
    queue,
    recentlyPlayedEpisodes,
    savedEpisodes,
    selectedEpisodeDetail,
  ]);

  const detailQueuePosition = selectedEpisodeDetail
    ? upNextQueue.findIndex(
      (item) => item.episode.id === selectedEpisodeDetail.episode.id,
    )
    : -1;
  const heading = screen === "show" && selectedFeed
    ? "节目"
    : screen === "episode"
      ? "单集"
      : screen === "playlist"
        ? "待播"
        : "播客";
  const eyebrow = screen === "show"
    ? selectedFeed?.author || "节目"
    : screen === "episode"
      ? selectedEpisodeDetail?.feed.title || "单集详情"
      : screen === "playlist"
        ? "正在播放与待播"
        : "音频节目";

  return {
    screen,
    searchFocusRequest,
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
    setError,
    continueListeningEpisodes,
    latestEpisodes,
    filteredLatestEpisodes,
    listenFilter,
    setListenFilter,
    listenNewReferenceTime,
    hasListenContent,
    homeState,
    loadHome,
    query,
    setQuery,
    searchApple,
    handlePodcastSearchCompositionStart,
    handlePodcastSearchCompositionEnd,
    handlePodcastSearchKeyDown,
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
    downloadCleanupIntent,
    lastDownloadCleanupIntent,
    downloadCleanupAction,
    confirmDownloadCleanup,
    knownActiveEpisode,
    currentEpisodeId,
    isPlaying,
    playEpisode,
    openEpisodeDetail,
    showEpisodeMenu,
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
    queueRemovalIntent,
    lastQueueRemovalIntent,
    setQueueRemovalIntent,
    confirmQueueRemoval,
    displayedEpisodes,
    hasMoreEpisodes,
    loadingEpisodePage,
    loadMoreEpisodes,
    episodeState,
    loadEpisodes,
    refreshSelectedFeed,
    displayedEpisodeDetail,
    detailState,
    liveActiveEpisode,
    activeProgress,
    activeDuration,
    detailQueuePosition,
    detailAction,
    downloadingId,
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
    downloadEpisode,
    deleteEpisodeDownload,
    shareEpisode,
    displayedRelatedEpisodes,
    relatedState,
    episodeMenu,
    setEpisodeMenu,
    queueEpisodeFromMenu,
    toggleEpisodePlayedFromMenu,
    feedById,
    // additional values referenced by the view shell / screens
    setQueueAnnouncement,
    loadRelatedEpisodes,
    openingCandidate,
    episodes,
    activeEpisodeId,
    queue,
  };
}
