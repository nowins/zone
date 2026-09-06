import { useEffect, useRef, useState } from "react";
import { MOTION_DRIFT, resolveExitDurationMs } from "../motion/tokens";
import { resolvePageTransition } from "../motion/pageTransition";
import { useReducedMotion } from "../motion/useReducedMotion";
import { resolveSearchSurface, type CollectionSearchMode } from "../utils/collectionSearch";
import type { PlaylistDialogState } from "../components/PlaylistDialog";
import type {
  AppPage,
  ContextMenuState,
  ContextPayload,
  PodcastPlayback,
  SmartPlaylist,
  Track,
  ViewMode,
} from "../types";

export type NowPlayingTargets = {
  activePodcastEpisode: PodcastPlayback | null;
  activeTrack: Track | null;
};

type UseNavigationParams = {
  contextMenu: ContextMenuState | null;
  infoTarget: ContextPayload | null;
  addToPlaylistTarget: ContextPayload | null;
  playlistDialog: PlaylistDialogState | null;
  smartPlaylistDialog: SmartPlaylist | "create" | null;
  nowPlayingTargetsRef: React.MutableRefObject<NowPlayingTargets>;
  setSelectedPlaylistId: React.Dispatch<React.SetStateAction<string>>;
};

export function useNavigation({
  contextMenu,
  infoTarget,
  addToPlaylistTarget,
  playlistDialog,
  smartPlaylistDialog,
  nowPlayingTargetsRef,
  setSelectedPlaylistId,
}: UseNavigationParams) {
  const previousPageRef = useRef<"quickplay" | "collection" | "podcasts" | "settings">("quickplay");
  const navExitTimerRef = useRef<number | null>(null);
  const navTargetRef = useRef<AppPage | null>(null);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<CollectionSearchMode>("results");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const focusSearchPendingRef = useRef(false);
  const [view, setView] = useState<ViewMode>("albums");
  const [page, setPage] = useState<AppPage>("quickplay");
  // Page-transition state: `navExit` is the in-flight exit direction (null when
  // idle), `navDir` persists the latest direction so the incoming page's enter
  // keyframe reads the same `--motion-dir` after the exit window ends. `navDrift`
  // carries the table's per-pair amplitudes onto the shell (`--motion-drift` for
  // the enter keyframe, `--motion-exit-drift` for the exit one), so push/pop
  // travel further than a peer pivot instead of sharing one hardcoded distance.
  const [navExit, setNavExit] = useState<1 | -1 | null>(null);
  const [navDir, setNavDir] = useState<1 | -1>(1);
  const [navDrift, setNavDrift] = useState<{ enter: number; exit: number }>({
    enter: MOTION_DRIFT.m,
    exit: MOTION_DRIFT.s,
  });
  const reducedMotion = useReducedMotion();
  const [selectedAlbumKey, setSelectedAlbumKey] = useState<string | null>(null);
  const [selectedArtistName, setSelectedArtistName] = useState<string | null>(null);

  useEffect(() => {
    if (page !== "collection" || !focusSearchPendingRef.current) return;
    focusSearchPendingRef.current = false;
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [page]);

  // Page transitions play a short exit on the outgoing page before the new one
  // mounts (WP7 pivot/push/pop from `resolvePageTransition`). Navigating again
  // inside the exit window jumps straight to the latest target — no queueing.
  // `navTargetRef` records where an in-flight exit is heading so chrome (app
  // header, player bar) can start its own exit together with the old page
  // instead of lingering until the new page flips in.
  function requestNavigation(next: AppPage) {
    if (next === page) return;
    if (navExitTimerRef.current !== null) {
      window.clearTimeout(navExitTimerRef.current);
      navExitTimerRef.current = null;
      setNavExit(null);
      const interrupted = resolvePageTransition(page, next);
      setNavDir(interrupted.direction);
      setNavDrift({ enter: interrupted.enterDriftPx, exit: interrupted.exitDriftPx });
      navTargetRef.current = next;
      setPage(next);
      return;
    }
    const transition = resolvePageTransition(page, next);
    setNavDir(transition.direction);
    setNavDrift({ enter: transition.enterDriftPx, exit: transition.exitDriftPx });
    navTargetRef.current = next;
    if (transition.exitMs === 0) {
      setPage(next);
      return;
    }
    setNavExit(transition.direction);
    navExitTimerRef.current = window.setTimeout(() => {
      navExitTimerRef.current = null;
      setNavExit(null);
      setPage(next);
    }, resolveExitDurationMs(transition.exitMs, reducedMotion));
  }

  function clearCollectionSearch() {
    setQuery("");
    setSearchMode("results");
  }

  function setCollectionSearchQuery(value: string) {
    setQuery(value);
    setSearchMode("results");
  }

  function focusCollectionSearch() {
    if (page === "collection") {
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
      return;
    }
    focusSearchPendingRef.current = true;
    requestNavigation("collection");
  }

  function navigatePage(nextPage: "quickplay" | "collection" | "podcasts" | "settings") {
    if (nextPage !== "collection") {
      clearCollectionSearch();
    }
    requestNavigation(nextPage);
  }

  function navigateCollection(nextView: ViewMode) {
    setView(nextView);
    requestNavigation("collection");
  }

  function openSearchArtist(artist: string) {
    setSelectedArtistName(artist);
    setView("artists");
    setSearchMode("browse");
  }

  function openSearchAlbum(key: string) {
    setSelectedAlbumKey(key);
    setView("albums");
    setSearchMode("browse");
  }

  function openSearchPlaylist(playlistId: string) {
    setSelectedPlaylistId(playlistId);
    setView("playlists");
    setSearchMode("browse");
  }

  useEffect(() => {
    function handleCollectionSearchKeys(event: KeyboardEvent) {
      if (event.isComposing || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        if (page === "podcasts") return;
        event.preventDefault();
        focusCollectionSearch();
        return;
      }

      if (event.key !== "Escape" || page !== "collection") return;
      if (contextMenu || infoTarget || addToPlaylistTarget || playlistDialog || smartPlaylistDialog) return;

      if (resolveSearchSurface(query, searchMode) === "results") {
        event.preventDefault();
        clearCollectionSearch();
        return;
      }

      if (query.trim().length > 0 && searchMode === "browse") {
        event.preventDefault();
        setSearchMode("results");
      }
    }

    window.addEventListener("keydown", handleCollectionSearchKeys, true);
    return () => window.removeEventListener("keydown", handleCollectionSearchKeys, true);
  }, [addToPlaylistTarget, contextMenu, infoTarget, page, playlistDialog, query, searchMode, smartPlaylistDialog]);

  function openNowPlaying() {
    const { activePodcastEpisode, activeTrack } = nowPlayingTargetsRef.current;
    if (!activePodcastEpisode && !activeTrack) return;
    if (page !== "nowPlaying") previousPageRef.current = page;
    requestNavigation("nowPlaying");
  }

  return {
    query,
    searchMode,
    setSearchMode,
    searchInputRef,
    view,
    setView,
    page,
    navExit,
    navDir,
    navDrift,
    navTargetRef,
    navExitTimerRef,
    previousPageRef,
    selectedAlbumKey,
    setSelectedAlbumKey,
    selectedArtistName,
    setSelectedArtistName,
    requestNavigation,
    clearCollectionSearch,
    setCollectionSearchQuery,
    navigatePage,
    navigateCollection,
    openSearchArtist,
    openSearchAlbum,
    openSearchPlaylist,
    openNowPlaying,
  };
}
