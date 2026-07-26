import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  ListMusic,
  LoaderCircle,
  Pause,
  Play,
  Podcast,
  RefreshCw,
  Rss,
  Search,
  SkipForward,
  Trash2,
  X,
} from "lucide-react";
import {
  PodcastEpisodeContextMenu,
  type PodcastEpisodeMenuState,
} from "../components/PodcastEpisodeContextMenu";
import { formatTime } from "../utils/music";
import { podcastArtworkSrc } from "../utils/podcastArtwork";
import {
  filterPodcastListeningEpisodes,
  isPodcastEpisodeNew,
  podcastEpisodePlayedPercent,
  type PodcastListenFilter,
} from "../utils/podcastListening";
import {
  groupPodcastDownloads,
  movePodcastFeedOrder,
  normalizePodcastFeedOrder,
  podcastDownloadedBytes,
  sortPodcastFeeds,
  type PodcastLibrarySort,
} from "../utils/podcastLibrary";
import { mergePodcastEpisodePlayback } from "../utils/podcastPlayback";
import type {
  PodcastDiscoveryShow,
  PodcastDownloadPage,
  PodcastDownloadResult,
  PodcastEpisode,
  PodcastEpisodeDetail,
  PodcastFeed,
  PodcastHome,
  PodcastPlayback,
  PodcastQueueItem,
  PodcastRefreshReport,
  PodcastSearchResult,
  PodcastSubscribeResult,
} from "../types";

type RequestState = "idle" | "loading" | "ready" | "error";
type PodcastScreen =
  | "listen"
  | "discover"
  | "library"
  | "playlist"
  | "show"
  | "episode";
type RootPodcastScreen = Exclude<PodcastScreen, "show" | "episode">;
type EpisodeOriginScreen = Exclude<PodcastScreen, "episode">;
type EpisodeRequest = {
  episodeId: string;
  nonce: number;
  returnToNowPlaying?: boolean;
};
type ShowCandidate = Pick<
  PodcastSearchResult,
  "id" | "title" | "author" | "feedUrl" | "artworkUrl"
>;

export type PodcastViewProps = {
  queue: PodcastQueueItem[];
  activeEpisode: PodcastPlayback | null;
  activeEpisodeId: string | null;
  activeProgress: number;
  activeDuration: number;
  libraryRevision: number;
  episodeRequest: EpisodeRequest | null;
  onEpisodeRequestHandled: (nonce: number) => void;
  onReturnToNowPlaying: () => void;
  isPlaying: boolean;
  onPlayEpisode: (episode: PodcastPlayback) => void;
  onQueueEpisode: (
    episode: PodcastEpisode,
    playNext: boolean,
  ) => boolean | Promise<boolean>;
  onRemoveQueueEpisode: (episodeId: string) => void | Promise<void>;
  onMoveQueueEpisode: (
    episodeId: string,
    direction: -1 | 1,
  ) => void | Promise<void>;
  onClearQueue: () => void | Promise<void>;
  onEpisodeUpdated: (episode: PodcastEpisode) => void;
  onSetEpisodePlayed: (
    episodeId: string,
    played: boolean,
  ) => Promise<PodcastEpisodeDetail>;
};

type PodcastSessionSnapshot = {
  screen: PodcastScreen;
  returnScreen: RootPodcastScreen;
  query: string;
  listenFilter: PodcastListenFilter;
  searchResults: PodcastSearchResult[];
  selectedFeed: PodcastFeed | null;
  episodes: PodcastEpisode[];
  selectedEpisodeId: string | null;
  selectedEpisodeDetail: PodcastEpisodeDetail | null;
  episodeOriginScreen: EpisodeOriginScreen;
  episodeOriginFeed: PodcastFeed | null;
  lastPlayedEpisode: PodcastEpisode | null;
};

const EMPTY_HOME: PodcastHome = {
  continueListening: [],
  latestEpisodes: [],
  unplayedEpisodes: [],
  downloadPriorityEpisodes: [],
  downloadedEpisodes: [],
  savedEpisodes: [],
  recentlyPlayedEpisodes: [],
};
const EMPTY_DOWNLOAD_PAGE: PodcastDownloadPage = {
  episodes: [],
  totalCount: 0,
  totalBytes: 0,
  feedCount: 0,
  hasMore: false,
};
const DISCOVERY_CACHE_TTL_MS = 15 * 60 * 1_000;
const PODCAST_LIBRARY_STORAGE_KEY = "zone-podcast-library-v1";
const PODCAST_DOWNLOAD_PAGE_SIZE = 60;
const PODCAST_LISTEN_FILTERS: Array<{
  id: PodcastListenFilter;
  label: string;
}> = [
  { id: "recent", label: "最近更新" },
  { id: "unplayed", label: "未收听" },
  { id: "download-first", label: "下载优先" },
];
const PODCAST_LIBRARY_SORTS: Array<{
  id: PodcastLibrarySort;
  label: string;
}> = [
  { id: "recent", label: "最近更新" },
  { id: "name", label: "名称" },
  { id: "custom", label: "手动排序" },
];
let discoveryCache: { shows: PodcastDiscoveryShow[]; fetchedAt: number } | null = null;
let podcastSessionSnapshot: PodcastSessionSnapshot | null = null;

export function PodcastView({
  queue,
  activeEpisode,
  activeEpisodeId,
  activeProgress,
  activeDuration,
  libraryRevision,
  episodeRequest,
  onEpisodeRequestHandled,
  onReturnToNowPlaying,
  isPlaying,
  onPlayEpisode,
  onQueueEpisode,
  onRemoveQueueEpisode,
  onMoveQueueEpisode,
  onClearQueue,
  onEpisodeUpdated,
  onSetEpisodePlayed,
}: PodcastViewProps) {
  const restoredSession = useMemo(() => podcastSessionSnapshot, []);
  const initialLibraryPreferences = useMemo(
    readPodcastLibraryPreferences,
    [],
  );
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
  const [searchState, setSearchState] = useState<RequestState>(
    restoredSession?.searchResults.length ? "ready" : "idle",
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
  const [selectedFeed, setSelectedFeed] = useState<PodcastFeed | null>(
    restoredSession?.selectedFeed ?? null,
  );
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
  const handledLibraryRevision = useRef(libraryRevision);
  const episodeListRequestRef = useRef(0);
  const episodeDetailRequestRef = useRef(0);
  const homeRequestRef = useRef(0);
  const downloadLibraryRequestRef = useRef(0);
  const discoveryRequestActive = useRef(false);
  const feedRefreshActive = useRef(false);
  const selectedFeedRef = useRef(selectedFeed);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const episodeReturnSessionRef = useRef<PodcastSessionSnapshot | null>(null);
  selectedFeedRef.current = selectedFeed;

  const currentEpisodeId = activeEpisode?.episodeId ?? activeEpisodeId;
  const feedById = useMemo(
    () => new Map(feeds.map((feed) => [feed.id, feed])),
    [feeds],
  );

  const loadFeeds = useCallback(async () => {
    try {
      const nextFeeds = await invoke<PodcastFeed[]>("podcast_list_feeds");
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
        invoke<PodcastHome>("podcast_list_home"),
        invoke<PodcastEpisodeDetail[]>("podcast_list_saved_episodes"),
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
      const page = await invoke<PodcastDownloadPage>(
        "podcast_list_downloads",
        { offset, limit: PODCAST_DOWNLOAD_PAGE_SIZE },
      );
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
    if (
      discoveryCache
      && Date.now() - discoveryCache.fetchedAt < DISCOVERY_CACHE_TTL_MS
    ) {
      setDiscoveryShows(discoveryCache.shows);
      setDiscoveryState("ready");
      return;
    }
    if (discoveryRequestActive.current) return;
    discoveryRequestActive.current = true;
    setDiscoveryState("loading");
    try {
      const shows = await invoke<PodcastDiscoveryShow[]>(
        "podcast_browse_apple",
        { limit: 24 },
      );
      discoveryCache = { shows, fetchedAt: Date.now() };
      setDiscoveryShows(shows);
      setDiscoveryState("ready");
    } catch {
      setDiscoveryShows([]);
      setDiscoveryState("error");
    } finally {
      discoveryRequestActive.current = false;
    }
  }, []);

  const loadEpisodes = useCallback(async (feed: PodcastFeed) => {
    const requestId = episodeListRequestRef.current + 1;
    episodeListRequestRef.current = requestId;
    setEpisodeState("loading");
    try {
      const nextEpisodes = await invoke<PodcastEpisode[]>(
        "podcast_list_episodes",
        { feedId: feed.id },
      );
      if (episodeListRequestRef.current !== requestId) return null;
      setEpisodes(nextEpisodes);
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

  const refreshSubscribedFeeds = useCallback(async () => {
    if (feedRefreshActive.current) return;
    feedRefreshActive.current = true;
    try {
      const report = await invoke<PodcastRefreshReport>(
        "podcast_refresh_feeds",
        { force: false },
      );
      const refreshed = Math.max(
        0,
        report.checked - report.notModified - report.failures.length,
      );
      if (refreshed === 0) return;
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

  const loadEpisodeDetail = useCallback(
    async (episodeId: string, preserveCurrent = false) => {
      const requestId = episodeDetailRequestRef.current + 1;
      episodeDetailRequestRef.current = requestId;
      setDetailState("loading");
      if (!preserveCurrent) setSelectedEpisodeDetail(null);
      try {
        const detail = await invoke<PodcastEpisodeDetail>(
          "podcast_get_episode_detail",
          { episodeId },
        );
        if (episodeDetailRequestRef.current !== requestId) return null;
        setSelectedEpisodeId(episodeId);
        setSelectedEpisodeDetail(detail);
        setDetailState("ready");
        return detail;
      } catch (reason) {
        if (episodeDetailRequestRef.current !== requestId) return null;
        setDetailState("error");
        setError(errorMessage(reason, "读取单集详情失败"));
        return null;
      }
    },
    [],
  );

  const applyEpisodeUpdate = useCallback(
    (nextEpisode: PodcastEpisode) => {
      const update = (episode: PodcastEpisode) =>
        episode.id === nextEpisode.id ? nextEpisode : episode;
      setEpisodes((current) => current.map(update));
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
    podcastSessionSnapshot = {
      screen,
      returnScreen,
      query,
      listenFilter,
      searchResults,
      selectedFeed,
      episodes,
      selectedEpisodeId,
      selectedEpisodeDetail,
      episodeOriginScreen,
      episodeOriginFeed,
      lastPlayedEpisode,
    };
  }, [
    episodeOriginFeed,
    episodeOriginScreen,
    episodes,
    lastPlayedEpisode,
    listenFilter,
    query,
    returnScreen,
    screen,
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

  async function searchApple(event: FormEvent) {
    event.preventDefault();
    const cleanQuery = query.trim();
    if (!cleanQuery || searchState === "loading") return;
    setSearchState("loading");
    setError(null);
    setNotice(null);
    try {
      const results = await invoke<PodcastSearchResult[]>(
        "podcast_search_apple",
        { query: cleanQuery, limit: 18 },
      );
      setSearchResults(results);
      setSearchState("ready");
    } catch (reason) {
      setSearchResults([]);
      setSearchState("error");
      setError(errorMessage(reason, "搜索节目失败"));
    }
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
    if (stored) {
      await openStoredFeed(stored, origin);
      return;
    }

    setOpeningId(candidate.id);
    setError(null);
    setNotice(`正在打开“${candidate.title}”`);
    try {
      const result = await invoke<PodcastSubscribeResult>(
        "podcast_preview_feed",
        {
          feedUrl: candidate.feedUrl,
          titleHint: candidate.title,
          authorHint: candidate.author,
          artworkUrl: candidate.artworkUrl ?? undefined,
        },
      );
      setNotice(null);
      setReturnScreen(origin);
      setSelectedFeed(result.feed);
      setScreen("show");
      await loadEpisodes(result.feed);
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason, "打开节目失败"));
    } finally {
      setOpeningId(null);
    }
  }

  async function subscribeRss(event: FormEvent) {
    event.preventDefault();
    const cleanUrl = rssUrl.trim();
    if (!cleanUrl || openingId) return;
    setOpeningId(cleanUrl);
    setError(null);
    setNotice("正在读取 RSS 与单集");
    try {
      const result = await invoke<PodcastSubscribeResult>(
        "podcast_subscribe",
        { feedUrl: cleanUrl },
      );
      setRssUrl("");
      setNotice(`已关注“${result.feed.title}”`);
      await loadFeeds();
      await loadHome();
      setReturnScreen("library");
      setSelectedFeed(result.feed);
      setScreen("show");
      await loadEpisodes(result.feed);
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason, "通过 RSS 关注节目失败"));
    } finally {
      setOpeningId(null);
    }
  }

  async function refreshSelectedFeed() {
    if (!selectedFeed || openingId) return;
    setOpeningId(selectedFeed.id);
    setError(null);
    setNotice(`正在刷新“${selectedFeed.title}”`);
    try {
      const report = await invoke<PodcastRefreshReport>(
        "podcast_refresh_feeds",
        { feedId: selectedFeed.id, force: true },
      );
      const failure = report.failures.find(
        (item) => item.feedId === selectedFeed.id,
      );
      if (failure) throw new Error(failure.message);
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
          const detail = await invoke<PodcastEpisodeDetail>(
            "podcast_get_episode_detail",
            { episodeId: nextEpisodes[0].id },
          );
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
      await invoke("podcast_set_following", {
        feedId: selectedFeed.id,
        following: nextSubscribed,
      });
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
    try {
      const result = await invoke<PodcastDownloadResult>(
        "podcast_download_episode",
        { episodeId: episode.id },
      );
      try {
        const nextDetail = await invoke<PodcastEpisodeDetail>(
          "podcast_get_episode_detail",
          { episodeId: episode.id },
        );
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
        const nextDetail = await invoke<PodcastEpisodeDetail>(
          "podcast_get_episode_detail",
          { episodeId: episode.id },
        );
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
      setDownloadingId(null);
    }
  }

  async function deleteEpisodeDownload(detail: PodcastEpisodeDetail) {
    if (detailAction || downloadingId) return;
    setDetailAction("delete");
    setError(null);
    try {
      const nextDetail = await invoke<PodcastEpisodeDetail>(
        "podcast_delete_episode_download",
        { episodeId: detail.episode.id },
      );
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
      const nextDetail = await invoke<PodcastEpisodeDetail>(
        "podcast_set_episode_saved",
        { episodeId: detail.episode.id, saved: nextSaved },
      );
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

  function playEpisode(episode: PodcastEpisode) {
    const feed = selectedFeed?.id === episode.feedId
      ? selectedFeed
      : feedById.get(episode.feedId);
    setLastPlayedEpisode(episode);
    setHome((current) => ({
      ...current,
      recentlyPlayedEpisodes: promoteEpisode(
        current.recentlyPlayedEpisodes,
        episode,
      ),
    }));
    onPlayEpisode({
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
    });
  }

  function openEpisodeDetail(
    episode: PodcastEpisode,
    origin: EpisodeOriginScreen = screen === "episode"
      ? episodeOriginScreen
      : screen,
  ) {
    episodeReturnSessionRef.current = null;
    setEpisodeReturnToNowPlaying(false);
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
    setError(null);
    setNotice(null);
    if (episodeReturnToNowPlaying) {
      if (episodeReturnSessionRef.current) {
        podcastSessionSnapshot = episodeReturnSessionRef.current;
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

  const liveEpisode = useCallback(
    (episode: PodcastEpisode) =>
      mergePodcastEpisodePlayback(
        episode,
        activeEpisode,
        activeProgress,
        activeDuration,
      ),
    [activeDuration, activeEpisode, activeProgress],
  );
  const liveActiveEpisode = useMemo(
    () => activeEpisode ? liveEpisode(activeEpisode) : null,
    [activeEpisode, liveEpisode],
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
    ? selectedFeed.title
    : screen === "episode"
      ? selectedEpisodeDetail?.episode.title ?? "单集"
      : screen === "playlist"
        ? "播放列表"
        : "播客";
  const eyebrow = screen === "show"
    ? selectedFeed?.author || "节目"
    : screen === "episode"
      ? selectedEpisodeDetail?.feed.title || "单集详情"
      : screen === "playlist"
        ? "正在播放与待播"
        : "音频节目";

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
      </header>

      {screen === "listen" ? (
        <main className="podcast-screen podcast-listen-screen">
          {continueListeningEpisodes.length > 0 ? (
            <PodcastSection title="继续收听" count={continueListeningEpisodes.length}>
              <div className="podcast-continue-grid">
                {continueListeningEpisodes.map((episode) => (
                  <ContinueCard
                    key={episode.id}
                    episode={episode}
                    active={currentEpisodeId === episode.id}
                    isPlaying={isPlaying}
                    onOpen={() => openEpisodeDetail(episode, "listen")}
                    onPlay={() => playEpisode(episode)}
                    onContextMenu={(event) =>
                      showEpisodeMenu(event, episode)}
                  />
                ))}
              </div>
            </PodcastSection>
          ) : null}

          {latestEpisodes.length > 0 ? (
            <PodcastSection
              title="来自你的节目"
              count={filteredLatestEpisodes.length}
            >
              <div
                className="podcast-listen-filters"
                role="group"
                aria-label="筛选来自你的节目"
              >
                {PODCAST_LISTEN_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    aria-pressed={listenFilter === filter.id}
                    onClick={() => setListenFilter(filter.id)}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              {filteredLatestEpisodes.length > 0 ? (
                <div className="podcast-home-episodes">
                  {filteredLatestEpisodes.slice(0, 8).map((episode) => (
                    <EpisodeRow
                      key={episode.id}
                      episode={episode}
                      active={currentEpisodeId === episode.id}
                      isPlaying={isPlaying}
                      downloading={downloadingId === episode.id}
                      showFeed
                      showArtwork
                      isNew={isPodcastEpisodeNew(
                        episode,
                        feedById.get(episode.feedId)?.subscribedAt,
                        listenNewReferenceTime,
                      )}
                      onOpen={() => openEpisodeDetail(episode, "listen")}
                      onPlay={() => playEpisode(episode)}
                      onDownload={() => void downloadEpisode(episode)}
                      onContextMenu={(event) =>
                        showEpisodeMenu(event, episode)}
                    />
                  ))}
                </div>
              ) : (
                <PodcastEmpty label="没有未收听的单集" />
              )}
            </PodcastSection>
          ) : null}

          {!hasListenContent ? (
            <PodcastSection title="开始收听">
              {homeState === "loading" ? (
                <PodcastLoading label="正在整理你的节目" />
              ) : homeState === "error" ? (
                <div className="podcast-inline-state">
                  <span>暂时无法整理收听内容</span>
                  <button type="button" onClick={() => void loadHome()}>重试</button>
                </div>
              ) : (
                <PodcastEmpty
                  label="关注节目后，新单集会出现在这里"
                  actionLabel="去发现"
                  onAction={() => changeRootScreen("discover")}
                />
              )}
            </PodcastSection>
          ) : null}
        </main>
      ) : null}

      {screen === "discover" ? (
        <main className="podcast-screen podcast-discover-screen">
          <form className="podcast-search-form" onSubmit={searchApple}>
            <Search size={17} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索节目、人物或主题…"
              aria-label="搜索播客"
            />
            <button
              type="submit"
              disabled={!query.trim() || searchState === "loading"}
            >
              {searchState === "loading"
                ? <LoaderCircle className="podcast-spinner" size={17} />
                : "搜索"}
            </button>
          </form>

          {searchState === "ready" || searchState === "loading" ? (
            <PodcastSection
              title={searchState === "loading" ? "正在搜索" : "搜索结果"}
              count={searchResults.length}
            >
              {searchState === "loading" ? (
                <PodcastLoading label="正在查找节目" />
              ) : searchResults.length > 0 ? (
                <div className="podcast-search-grid">
                  {searchResults.map((result) => (
                    <ShowCard
                      key={result.id}
                      show={result}
                      followed={feeds.some(
                        (feed) => feed.feedUrl === result.feedUrl,
                      )}
                      loading={openingId === result.id}
                      onOpen={() => void previewFeed(result, "discover")}
                    />
                  ))}
                </div>
              ) : (
                <PodcastEmpty label="没有找到相关节目" />
              )}
            </PodcastSection>
          ) : (
            <PodcastSection title="中国区热门节目" count={discoveryShows.length}>
              <DiscoveryShelf
                state={discoveryState}
                shows={discoveryShows}
                feeds={feeds}
                openingId={openingId}
                onOpen={(show) => void previewFeed(show, "discover")}
                onRetry={() => void loadDiscovery()}
              />
            </PodcastSection>
          )}

          <details className="podcast-rss-entry">
            <summary><Rss size={15} />通过 RSS 关注</summary>
            <form onSubmit={subscribeRss}>
              <input
                value={rssUrl}
                onChange={(event) => setRssUrl(event.target.value)}
                placeholder="粘贴公开 RSS 地址"
                aria-label="RSS 地址"
              />
              <button
                type="submit"
                disabled={!rssUrl.trim() || Boolean(openingId)}
              >
                关注
              </button>
            </form>
          </details>
        </main>
      ) : null}

      {screen === "library" ? (
        <main className="podcast-screen podcast-library-screen">
          <PodcastSection title="已关注" count={feeds.length}>
            {libraryState === "loading" ? (
              <PodcastLoading label="正在读取资料库" />
            ) : feeds.length > 0 ? (
              <>
                <div
                  className="podcast-listen-filters podcast-library-sorts"
                  role="group"
                  aria-label="已关注节目排序"
                >
                  {PODCAST_LIBRARY_SORTS.map((sort) => (
                    <button
                      key={sort.id}
                      type="button"
                      aria-pressed={librarySort === sort.id}
                      onClick={() => setLibrarySort(sort.id)}
                    >
                      {sort.label}
                    </button>
                  ))}
                </div>
                <div className="podcast-library-grid">
                  {orderedFeeds.map((feed, index) => (
                    <article
                      key={feed.id}
                      className="podcast-library-show"
                    >
                      <button
                        type="button"
                        className="podcast-library-show-open"
                        onClick={() => void openStoredFeed(feed, "library")}
                      >
                        <span className="podcast-library-artwork">
                          <PodcastArtwork
                            url={feed.artworkUrl}
                            title={feed.title}
                          />
                          {feed.unplayedCount > 0 ? (
                            <em
                              className="podcast-unplayed-badge"
                              aria-label={`${feed.unplayedCount} 集未听`}
                            >
                              {feed.unplayedCount > 99
                                ? "99+"
                                : feed.unplayedCount}
                            </em>
                          ) : null}
                        </span>
                        <span className="podcast-library-show-copy">
                          <strong>{feed.title}</strong>
                          <small>{feed.author || "未知作者"}</small>
                          <small className="podcast-library-updated">
                            {feed.latestEpisodeAt
                              ? `最近更新 ${formatEpisodeDate(
                                feed.latestEpisodeAt,
                              )}`
                              : "暂无单集"}
                          </small>
                        </span>
                      </button>
                      {librarySort === "custom" ? (
                        <span
                          className="podcast-library-order"
                          aria-label={`调整“${feed.title}”的位置`}
                        >
                          <button
                            type="button"
                            onClick={() => moveFollowedFeed(feed.id, -1)}
                            disabled={index === 0}
                            title="前移"
                            aria-label={`将“${feed.title}”前移`}
                          >
                            <ArrowLeft size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveFollowedFeed(feed.id, 1)}
                            disabled={index === orderedFeeds.length - 1}
                            title="后移"
                            aria-label={`将“${feed.title}”后移`}
                          >
                            <ArrowRight size={15} />
                          </button>
                        </span>
                      ) : null}
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <PodcastEmpty label="还没有关注节目，可以先去发现看看" />
            )}
          </PodcastSection>

          {recentlyPlayedEpisodes.length > 0 ? (
            <PodcastSection
              title="最近播放"
              count={recentlyPlayedEpisodes.length}
              actionLabel={recentlyPlayedEpisodes.length > 8
                ? recentHistoryExpanded ? "收起" : "查看全部"
                : undefined}
              onAction={recentlyPlayedEpisodes.length > 8
                ? () => setRecentHistoryExpanded((current) => !current)
                : undefined}
            >
              <div className="podcast-home-episodes">
                {(recentHistoryExpanded
                  ? recentlyPlayedEpisodes
                  : recentlyPlayedEpisodes.slice(0, 8)
                ).map((episode) => (
                  <EpisodeRow
                    key={episode.id}
                    episode={episode}
                    active={currentEpisodeId === episode.id}
                    isPlaying={isPlaying}
                    downloading={downloadingId === episode.id}
                    showFeed
                    onOpen={() => openEpisodeDetail(episode, "library")}
                    onPlay={() => playEpisode(episode)}
                    onDownload={() => void downloadEpisode(episode)}
                    onContextMenu={(event) =>
                      showEpisodeMenu(event, episode)}
                  />
                ))}
              </div>
            </PodcastSection>
          ) : null}

          {savedEpisodes.length > 0 ? (
            <PodcastSection title="稍后听" count={savedEpisodes.length}>
              <div className="podcast-home-episodes">
                {savedEpisodes.map((episode) => (
                  <EpisodeRow
                    key={episode.id}
                    episode={episode}
                    active={currentEpisodeId === episode.id}
                    isPlaying={isPlaying}
                    downloading={downloadingId === episode.id}
                    showFeed
                    onOpen={() => openEpisodeDetail(episode, "library")}
                    onPlay={() => playEpisode(episode)}
                    onDownload={() => void downloadEpisode(episode)}
                    onContextMenu={(event) =>
                      showEpisodeMenu(event, episode)}
                  />
                ))}
              </div>
            </PodcastSection>
          ) : null}

          {downloadedCount > 0 || downloadLibraryState === "loading"
            || downloadLibraryState === "error" ? (
            <PodcastSection
              title="已下载"
              count={downloadedCount}
            >
              {downloadedCount > 0 ? (
                <>
                  <div className="podcast-download-summary">
                    <span>
                      已下载占用 {formatFileSize(downloadedBytes)}
                    </span>
                    <span>{downloadedFeedCount} 个节目</span>
                  </div>
                  <div className="podcast-download-groups">
                    {downloadGroups.map((group) => (
                      <section
                        key={group.feedId}
                        className="podcast-download-group"
                      >
                        <div className="podcast-download-group-title">
                          <h3>{group.feedTitle}</h3>
                          <span>
                            {group.episodes.length} 集 ·{" "}
                            {formatFileSize(group.downloadedBytes)}
                          </span>
                        </div>
                        <div className="podcast-home-episodes">
                          {group.episodes.map((episode) => (
                            <EpisodeRow
                              key={episode.id}
                              episode={episode}
                              active={currentEpisodeId === episode.id}
                              isPlaying={isPlaying}
                              downloading={false}
                              showDownloadedSize
                              onOpen={() =>
                                openEpisodeDetail(episode, "library")}
                              onPlay={() => playEpisode(episode)}
                              onDownload={() => undefined}
                              onContextMenu={(event) =>
                                showEpisodeMenu(event, episode)}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                  {downloadPage.hasMore ? (
                    <button
                      type="button"
                      className="podcast-download-more"
                      disabled={loadingMoreDownloads}
                      onClick={() =>
                        void loadDownloadedLibrary(
                          downloadPage.episodes.length,
                        )}
                    >
                      {loadingMoreDownloads ? (
                        <>
                          <LoaderCircle
                            className="podcast-spinner"
                            size={15}
                          />
                          正在加载
                        </>
                      ) : "加载更多"}
                    </button>
                  ) : null}
                </>
              ) : downloadLibraryState === "loading" ? (
                <PodcastLoading label="正在读取下载资料库" />
              ) : (
                <div className="podcast-inline-state">
                  <span>暂时无法读取下载资料库</span>
                  <button
                    type="button"
                    onClick={() => void loadDownloadedLibrary(0)}
                  >
                    重试
                  </button>
                </div>
              )}
            </PodcastSection>
          ) : null}
        </main>
      ) : null}

      {screen === "playlist" ? (
        <main className="podcast-screen podcast-playlist-screen">
          <PodcastSection title="正在播放">
            {knownActiveEpisode ? (
              <CurrentEpisodeRow
                episode={knownActiveEpisode}
                isPlaying={isPlaying}
                onOpen={() => openEpisodeDetail(knownActiveEpisode, "playlist")}
                onPlay={() => playEpisode(knownActiveEpisode)}
                onContextMenu={(event) =>
                  showEpisodeMenu(event, knownActiveEpisode)}
              />
            ) : currentEpisodeId ? (
              <div className="podcast-inline-state">
                <span>当前单集正在播放</span>
              </div>
            ) : (
              <PodcastEmpty label="还没有正在播放的单集" />
            )}
          </PodcastSection>

          <PodcastSection
            title="待播队列"
            count={upNextQueue.length}
            actionLabel={upNextQueue.length > 0 ? "清空" : undefined}
            onAction={upNextQueue.length > 0 ? () => void onClearQueue() : undefined}
          >
            {upNextQueue.length > 0 ? (
              <div className="podcast-queue-list">
                {upNextQueue.map((item, index) => (
                  <QueueEpisodeRow
                    key={item.episode.id}
                    item={item}
                    index={index}
                    count={upNextQueue.length}
                    onOpen={() =>
                      openEpisodeDetail(item.episode, "playlist")}
                    onPlay={() => playEpisode(item.episode)}
                    onMove={(direction) =>
                      void onMoveQueueEpisode(item.episode.id, direction)}
                    onRemove={() =>
                      void onRemoveQueueEpisode(item.episode.id)}
                    onContextMenu={(event) =>
                      showEpisodeMenu(event, item.episode)}
                  />
                ))}
              </div>
            ) : (
              <PodcastEmpty label="待播队列为空，可从单集详情加入" />
            )}
          </PodcastSection>
        </main>
      ) : null}

      {screen === "show" && selectedFeed ? (
        <main className="podcast-screen podcast-show-screen">
          <section className="podcast-show-hero">
            <PodcastArtwork
              url={selectedFeed.artworkUrl}
              title={selectedFeed.title}
              large
            />
            <div>
              <span>{selectedFeed.subscribed ? "已加入资料库" : "公开播客"}</span>
              <h2>{selectedFeed.title}</h2>
              <strong>{selectedFeed.author || "未知作者"}</strong>
              {selectedFeed.description
                ? <p>{plainText(selectedFeed.description)}</p>
                : null}
            </div>
            <button
              type="button"
              className="podcast-refresh"
              onClick={() => void refreshSelectedFeed()}
              disabled={Boolean(openingId)}
              title="刷新节目"
            >
              <RefreshCw
                className={
                  openingId === selectedFeed.id ? "podcast-spinner" : ""
                }
                size={16}
              />
              刷新
            </button>
          </section>

          <section className="podcast-show-episodes">
            <div className="podcast-section-title">
              <h2>单集</h2>
              <span>{displayedEpisodes.length}</span>
            </div>
            {episodeState === "loading" && episodes.length === 0 ? (
              <PodcastLoading label="正在读取单集" />
            ) : displayedEpisodes.length > 0 ? (
              displayedEpisodes.map((episode) => (
                <EpisodeRow
                  key={episode.id}
                  episode={episode}
                  active={currentEpisodeId === episode.id}
                  isPlaying={isPlaying}
                  downloading={downloadingId === episode.id}
                  onOpen={() => openEpisodeDetail(episode, "show")}
                  onPlay={() => playEpisode(episode)}
                  onDownload={() => void downloadEpisode(episode)}
                  onContextMenu={(event) =>
                    showEpisodeMenu(event, episode)}
                />
              ))
            ) : (
              <PodcastEmpty label="这个节目还没有可播放的单集" />
            )}
          </section>
        </main>
      ) : null}

      {screen === "episode" ? (
        <main className="podcast-screen podcast-detail-screen">
          {detailState === "loading" && !selectedEpisodeDetail ? (
            <PodcastLoading label="正在读取单集详情" />
          ) : displayedEpisodeDetail ? (
            <EpisodeDetail
              detail={displayedEpisodeDetail}
              active={currentEpisodeId === displayedEpisodeDetail.episode.id}
              isPlaying={isPlaying}
              downloading={
                downloadingId === displayedEpisodeDetail.episode.id
              }
              action={detailAction}
              queuePosition={detailQueuePosition}
              onPlay={() => playEpisode(displayedEpisodeDetail.episode)}
              onPlayNext={() =>
                void onQueueEpisode(displayedEpisodeDetail.episode, true)}
              onAddQueue={() =>
                void onQueueEpisode(displayedEpisodeDetail.episode, false)}
              onToggleSaved={() =>
                void toggleEpisodeSaved(displayedEpisodeDetail)}
              onDownload={() =>
                void downloadEpisode(displayedEpisodeDetail.episode)}
              onDeleteDownload={() =>
                void deleteEpisodeDownload(displayedEpisodeDetail)}
              onTogglePlayed={() =>
                void toggleEpisodePlayed(displayedEpisodeDetail)}
              onOpenShow={() => void openEpisodeShow()}
            />
          ) : detailState === "error" ? (
            <PodcastEmpty label="无法读取这集内容，可以返回后重试" />
          ) : (
            <PodcastLoading label="正在准备单集详情" />
          )}
        </main>
      ) : null}

      {(notice || error) ? (
        <div
          className={`podcast-notice${error ? " error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {error ?? notice}
        </div>
      ) : null}

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

function PodcastSection({
  title,
  count,
  actionLabel,
  onAction,
  children,
}: {
  title: string;
  count?: number;
  actionLabel?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="podcast-content-section">
      <div className="podcast-section-title">
        <h2>{title}</h2>
        {typeof count === "number" && count > 0 ? <span>{count}</span> : null}
        {actionLabel && onAction ? (
          <button type="button" onClick={onAction}>{actionLabel}</button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function DiscoveryShelf({
  state,
  shows,
  feeds,
  openingId,
  onOpen,
  onRetry,
}: {
  state: RequestState;
  shows: PodcastDiscoveryShow[];
  feeds: PodcastFeed[];
  openingId: string | null;
  onOpen: (show: PodcastDiscoveryShow) => void;
  onRetry: () => void;
}) {
  if (state === "idle" || state === "loading") {
    return <PodcastLoading label="正在读取中国区热门节目" />;
  }
  if (state === "error") {
    return (
      <div className="podcast-inline-state">
        <span>热门节目暂时不可用，资料库和搜索仍可使用</span>
        <button type="button" onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (shows.length === 0) {
    return <PodcastEmpty label="暂时没有热门节目" />;
  }
  return (
    <div className="podcast-show-shelf">
      {shows.map((show) => (
        <ShowCard
          key={show.id}
          show={show}
          followed={feeds.some((feed) => feed.feedUrl === show.feedUrl)}
          loading={openingId === show.id}
          onOpen={() => onOpen(show)}
        />
      ))}
    </div>
  );
}

function ShowCard({
  show,
  followed,
  loading,
  onOpen,
}: {
  show: ShowCandidate & { genres?: string[]; rank?: number };
  followed: boolean;
  loading: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="podcast-show-card"
      onClick={onOpen}
      disabled={loading}
    >
      <PodcastArtwork url={show.artworkUrl} title={show.title} />
      <span className="podcast-show-card-copy">
        <strong>{show.title}</strong>
        <small>{show.author || "未知作者"}</small>
        {show.genres?.[0] ? <em>{show.genres[0]}</em> : null}
      </span>
      {loading ? (
        <LoaderCircle
          className="podcast-spinner podcast-card-state"
          size={16}
        />
      ) : followed ? (
        <Check className="podcast-card-state" size={16} />
      ) : show.rank ? (
        <span className="podcast-card-rank">{show.rank}</span>
      ) : null}
    </button>
  );
}

function podcastPlayedLabel(episode: PodcastEpisode): string | null {
  const percentage = podcastEpisodePlayedPercent(episode);
  if (percentage === 100) return "已播完";
  if (percentage !== null) return `已播 ${percentage}%`;
  return episode.progressSeconds > 0 ? "收听中" : null;
}

function ContinueCard({
  episode,
  active,
  isPlaying,
  onOpen,
  onPlay,
  onContextMenu,
}: {
  episode: PodcastEpisode;
  active: boolean;
  isPlaying: boolean;
  onOpen: () => void;
  onPlay: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const percentage = podcastEpisodePlayedPercent(episode) ?? 0;
  const progressLabel = podcastPlayedLabel(episode);
  return (
    <article
      className={`podcast-continue-card${active ? " active" : ""}`}
      onContextMenu={onContextMenu}
    >
      <div className="podcast-continue-artwork">
        <PodcastArtwork
          url={episode.artworkUrl ?? episode.feedArtworkUrl}
          title={episode.feedTitle ?? episode.title}
        />
        {progressLabel ? (
          <span className="podcast-cover-progress" aria-hidden="true">
            {progressLabel}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className="podcast-continue-open"
        onClick={onOpen}
        aria-label={`查看单集：${episode.title}，${progressLabel ?? "继续收听"}`}
      >
        <span>{episode.feedTitle || "播客"}</span>
        <strong>{episode.title}</strong>
        <span
          className="podcast-card-progress"
          aria-hidden="true"
        >
          <i style={{ width: `${percentage}%` }} />
        </span>
        <small>
          {episode.durationSeconds
            ? `共 ${formatTime(episode.durationSeconds)}`
            : "继续收听"}
        </small>
      </button>
      <button
        type="button"
        className="podcast-play-action"
        onClick={onPlay}
        title={active && isPlaying ? "暂停" : "继续播放"}
      >
        {active && isPlaying
          ? <Pause size={18} fill="currentColor" />
          : <Play size={18} fill="currentColor" />}
      </button>
    </article>
  );
}

function EpisodeRow({
  episode,
  active,
  isPlaying,
  downloading,
  showFeed = false,
  showArtwork = false,
  showDownloadedSize = false,
  isNew = false,
  onOpen,
  onPlay,
  onDownload,
  onContextMenu,
}: {
  episode: PodcastEpisode;
  active: boolean;
  isPlaying: boolean;
  downloading: boolean;
  showFeed?: boolean;
  showArtwork?: boolean;
  showDownloadedSize?: boolean;
  isNew?: boolean;
  onOpen: () => void;
  onPlay: () => void;
  onDownload: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const progressLabel = podcastPlayedLabel(episode);
  const accessibilityLabel = [
    `查看单集：${episode.title}`,
    isNew ? "24 小时内更新" : null,
    progressLabel,
  ].filter(Boolean).join("，");
  return (
    <article
      className={`podcast-episode${showArtwork ? " with-artwork" : ""}${
        active ? " active" : ""
      }`}
      onContextMenu={onContextMenu}
    >
      {showArtwork ? (
        <div className="podcast-episode-artwork">
          <PodcastArtwork
            url={episode.artworkUrl ?? episode.feedArtworkUrl}
            title={episode.feedTitle ?? episode.title}
          />
          {progressLabel ? (
            <span className="podcast-cover-progress" aria-hidden="true">
              {progressLabel}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="podcast-episode-date">
          <span>{formatEpisodeDate(episode.publishedAt)}</span>
          <small>
            {[
              episode.durationSeconds
                ? formatTime(episode.durationSeconds)
                : "时长未知",
              showDownloadedSize && episode.downloadedBytes > 0
                ? formatFileSize(episode.downloadedBytes)
                : null,
            ].filter(Boolean).join(" · ")}
          </small>
        </div>
      )}
      <button
        type="button"
        className="podcast-episode-copy podcast-episode-open"
        onClick={onOpen}
        aria-label={accessibilityLabel}
      >
        {showArtwork ? (
          <span className="podcast-episode-meta">
            {showFeed && episode.feedTitle ? (
              <span className="podcast-episode-feed">{episode.feedTitle}</span>
            ) : null}
            {isNew ? <em className="podcast-new-badge">新</em> : null}
            <span>{formatEpisodeDate(episode.publishedAt)}</span>
            <span>
              {episode.durationSeconds
                ? formatTime(episode.durationSeconds)
                : "时长未知"}
            </span>
          </span>
        ) : showFeed && episode.feedTitle ? (
          <span className="podcast-episode-feed">{episode.feedTitle}</span>
        ) : null}
        <strong>{episode.title}</strong>
        {episode.description ? <p>{plainText(episode.description)}</p> : null}
        {!showArtwork && (episode.progressSeconds > 0 || episode.completed) ? (
          <small>
            {episode.completed
              ? "已播放"
              : `已播放至 ${formatTime(episode.progressSeconds)}`}
          </small>
        ) : null}
      </button>
      <div className="podcast-episode-actions">
        <button
          type="button"
          className="podcast-download-action"
          onClick={onDownload}
          disabled={downloading || Boolean(episode.localPath)}
          title={
            episode.localPath
              ? "已下载，可离线收听"
              : downloading
                ? "正在下载"
                : "下载以便离线收听"
          }
        >
          {downloading ? (
            <LoaderCircle className="podcast-spinner" size={16} />
          ) : episode.localPath ? (
            <Check size={16} />
          ) : (
            <Download size={16} />
          )}
        </button>
        <button
          type="button"
          className="podcast-play-action"
          onClick={onPlay}
          title={
            active && isPlaying
              ? "暂停"
              : episode.progressSeconds > 0
                ? "继续播放"
                : "播放"
          }
        >
          {active && isPlaying
            ? <Pause size={17} fill="currentColor" />
            : <Play size={17} fill="currentColor" />}
        </button>
      </div>
    </article>
  );
}

function CurrentEpisodeRow({
  episode,
  isPlaying,
  onOpen,
  onPlay,
  onContextMenu,
}: {
  episode: PodcastEpisode;
  isPlaying: boolean;
  onOpen: () => void;
  onPlay: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  return (
    <article
      className="podcast-current-episode"
      onContextMenu={onContextMenu}
    >
      <PodcastArtwork
        url={episode.artworkUrl ?? episode.feedArtworkUrl}
        title={episode.feedTitle ?? episode.title}
      />
      <button
        type="button"
        className="podcast-current-copy"
        onClick={onOpen}
      >
        <span>{episode.feedTitle || "播客"}</span>
        <strong>{episode.title}</strong>
        <small>
          {episode.completed
            ? "已播放"
            : episode.progressSeconds > 0
              ? `已播放至 ${formatTime(episode.progressSeconds)}`
              : "正在播放"}
        </small>
      </button>
      <button
        type="button"
        className="podcast-play-action"
        onClick={onPlay}
        title={isPlaying ? "暂停" : "继续播放"}
      >
        {isPlaying
          ? <Pause size={18} fill="currentColor" />
          : <Play size={18} fill="currentColor" />}
      </button>
    </article>
  );
}

function QueueEpisodeRow({
  item,
  index,
  count,
  onOpen,
  onPlay,
  onMove,
  onRemove,
  onContextMenu,
}: {
  item: PodcastQueueItem;
  index: number;
  count: number;
  onOpen: () => void;
  onPlay: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  return (
    <article
      className="podcast-queue-episode"
      onContextMenu={onContextMenu}
    >
      <span className="podcast-queue-position">
        {String(index + 1).padStart(2, "0")}
      </span>
      <button
        type="button"
        className="podcast-queue-copy"
        onClick={onOpen}
      >
        <strong>{item.episode.title}</strong>
        <small>
          {item.episode.feedTitle || "播客"}
          {item.episode.durationSeconds
            ? ` · ${formatTime(item.episode.durationSeconds)}`
            : ""}
        </small>
      </button>
      <div className="podcast-queue-actions">
        <button type="button" onClick={onPlay} title="立即播放">
          <Play size={15} fill="currentColor" />
        </button>
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          title="上移"
        >
          <ChevronUp size={16} />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === count - 1}
          title="下移"
        >
          <ChevronDown size={16} />
        </button>
        <button type="button" onClick={onRemove} title="从待播队列移除">
          <X size={16} />
        </button>
      </div>
    </article>
  );
}

function EpisodeDetail({
  detail,
  active,
  isPlaying,
  downloading,
  action,
  queuePosition,
  onPlay,
  onPlayNext,
  onAddQueue,
  onToggleSaved,
  onDownload,
  onDeleteDownload,
  onTogglePlayed,
  onOpenShow,
}: {
  detail: PodcastEpisodeDetail;
  active: boolean;
  isPlaying: boolean;
  downloading: boolean;
  action: "save" | "played" | "delete" | null;
  queuePosition: number;
  onPlay: () => void;
  onPlayNext: () => void;
  onAddQueue: () => void;
  onToggleSaved: () => void;
  onDownload: () => void;
  onDeleteDownload: () => void;
  onTogglePlayed: () => void;
  onOpenShow: () => void;
}) {
  const { episode, feed } = detail;
  const playLabel = active && isPlaying
    ? "暂停"
    : episode.progressSeconds > 0 && !episode.completed
      ? "继续播放"
      : "播放";
  return (
    <article className="podcast-detail">
      <section className="podcast-detail-hero">
        <PodcastArtwork
          url={
            episode.artworkUrl
            ?? episode.feedArtworkUrl
            ?? feed.artworkUrl
          }
          title={episode.title}
          large
        />
        <div className="podcast-detail-copy">
          <button type="button" onClick={onOpenShow}>{feed.title}</button>
          <h2>{episode.title}</h2>
          <div className="podcast-detail-meta">
            <span>{formatEpisodeFullDate(episode.publishedAt)}</span>
            <span>
              {episode.durationSeconds
                ? formatTime(episode.durationSeconds)
                : "时长未知"}
            </span>
            {episode.completed ? <span>已播放</span> : null}
            {queuePosition >= 0
              ? <span>待播第 {queuePosition + 1} 位</span>
              : null}
          </div>
          {episode.progressSeconds > 0 && !episode.completed ? (
            <div className="podcast-detail-progress">
              <span>
                已播放至 {formatTime(episode.progressSeconds)}
              </span>
              {episode.durationSeconds ? (
                <i>
                  <b
                    style={{
                      width: `${
                        Math.min(
                          100,
                          episode.progressSeconds
                            / episode.durationSeconds
                            * 100,
                        )
                      }%`,
                    }}
                  />
                </i>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <div className="podcast-detail-actions" aria-label="单集操作">
        <button
          type="button"
          className="primary"
          onClick={onPlay}
        >
          {active && isPlaying
            ? <Pause size={17} fill="currentColor" />
            : <Play size={17} fill="currentColor" />}
          {playLabel}
        </button>
        <button type="button" onClick={onPlayNext}>
          <SkipForward size={16} />
          接着播放
        </button>
        <button type="button" onClick={onAddQueue}>
          <ListMusic size={16} />
          加入待播
        </button>
        <button
          type="button"
          onClick={onToggleSaved}
          disabled={Boolean(action)}
          className={episode.saved ? "active" : ""}
        >
          {action === "save"
            ? <LoaderCircle className="podcast-spinner" size={16} />
            : <Bookmark size={16} fill={episode.saved ? "currentColor" : "none"} />}
          {episode.saved ? "取消保存" : "保存"}
        </button>
        {episode.localPath ? (
          <button
            type="button"
            onClick={onDeleteDownload}
            disabled={Boolean(action)}
          >
            {action === "delete"
              ? <LoaderCircle className="podcast-spinner" size={16} />
              : <Trash2 size={16} />}
            删除下载
          </button>
        ) : (
          <button type="button" onClick={onDownload} disabled={downloading}>
            {downloading
              ? <LoaderCircle className="podcast-spinner" size={16} />
              : <Download size={16} />}
            {downloading ? "正在下载" : "下载"}
          </button>
        )}
        <button
          type="button"
          onClick={onTogglePlayed}
          disabled={Boolean(action)}
        >
          {action === "played"
            ? <LoaderCircle className="podcast-spinner" size={16} />
            : episode.completed
              ? <RefreshCw size={16} />
              : <CheckCircle2 size={16} />}
          {episode.completed ? "标记为未播放" : "标记为已播放"}
        </button>
      </div>

      <section className="podcast-detail-description">
        <h3>简介</h3>
        <p>
          {episode.description
            ? plainText(episode.description)
            : "这集暂时没有简介。"}
        </p>
      </section>
    </article>
  );
}

function PodcastArtwork({
  url,
  title,
  large = false,
}: {
  url?: string | null;
  title: string;
  large?: boolean;
}) {
  const artworkSrc = podcastArtworkSrc(url);
  return (
    <div className={`podcast-artwork${large ? " large" : ""}`}>
      {artworkSrc ? (
        <img src={artworkSrc} alt="" draggable={false} />
      ) : (
        <span>{title.trim().slice(0, 1) || <Podcast size={22} />}</span>
      )}
    </div>
  );
}

function PodcastLoading({ label }: { label: string }) {
  return (
    <div className="podcast-inline-state">
      <LoaderCircle className="podcast-spinner" size={17} />
      <span>{label}</span>
    </div>
  );
}

function PodcastEmpty({
  label,
  actionLabel,
  onAction,
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="podcast-inline-state">
      <span>{label}</span>
      {actionLabel && onAction ? (
        <button type="button" onClick={onAction}>{actionLabel}</button>
      ) : null}
    </div>
  );
}

function rootScreenLabel(screen: RootPodcastScreen) {
  if (screen === "listen") return "收听";
  if (screen === "discover") return "发现";
  if (screen === "library") return "资料库";
  return "播放列表";
}

function upsertEpisode(
  episodes: PodcastEpisode[],
  nextEpisode: PodcastEpisode,
) {
  const found = episodes.some((episode) => episode.id === nextEpisode.id);
  return found
    ? episodes.map((episode) =>
      episode.id === nextEpisode.id ? nextEpisode : episode)
    : [nextEpisode, ...episodes];
}

function promoteEpisode(
  episodes: PodcastEpisode[],
  nextEpisode: PodcastEpisode,
) {
  return [
    nextEpisode,
    ...episodes.filter((episode) => episode.id !== nextEpisode.id),
  ];
}

function deduplicateEpisodes(episodes: PodcastEpisode[]) {
  const seen = new Set<string>();
  return episodes.filter((episode) => {
    if (seen.has(episode.id)) return false;
    seen.add(episode.id);
    return true;
  });
}

function readPodcastLibraryPreferences(): {
  sort: PodcastLibrarySort;
  customOrder: string[];
} {
  try {
    const raw = localStorage.getItem(PODCAST_LIBRARY_STORAGE_KEY);
    if (!raw) return { sort: "recent", customOrder: [] };
    const parsed = JSON.parse(raw) as {
      sort?: unknown;
      customOrder?: unknown;
    };
    const sort = parsed.sort === "name" || parsed.sort === "custom"
      ? parsed.sort
      : "recent";
    const customOrder = Array.isArray(parsed.customOrder)
      ? parsed.customOrder.filter(
        (feedId): feedId is string =>
          typeof feedId === "string" && Boolean(feedId),
      )
      : [];
    return { sort, customOrder };
  } catch {
    return { sort: "recent", customOrder: [] };
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function formatFileSize(bytes: number) {
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (safeBytes < 1_024) return `${Math.round(safeBytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safeBytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const formatted = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: value >= 100 ? 0 : value >= 10 ? 1 : 2,
  }).format(value);
  return `${formatted} ${units[unitIndex]}`;
}

function formatEpisodeDate(timestamp?: number | null) {
  if (!timestamp || !Number.isFinite(timestamp)) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function formatEpisodeFullDate(timestamp?: number | null) {
  if (!timestamp || !Number.isFinite(timestamp)) return "发布日期未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(timestamp));
}

function plainText(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function shareablePodcastEpisodeUrl(
  episode: PodcastEpisode,
): string | null {
  for (const candidate of [episode.webpageUrl, episode.enclosureUrl]) {
    if (!candidate?.trim()) continue;
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:")
        && !parsed.username
        && !parsed.password
      ) {
        return parsed.toString();
      }
    } catch {
      // Ignore malformed feed metadata and try the enclosure fallback.
    }
  }
  return null;
}

async function copyPodcastShareUrl(url: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return;
    } catch {
      // Some WebView versions expose Clipboard API without granting access.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = url;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("clipboard unavailable");
    }
  } finally {
    textarea.remove();
  }
}

function errorMessage(reason: unknown, fallback: string) {
  if (typeof reason === "string" && reason.trim()) return reason;
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return fallback;
}
