import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MOTION_DRIFT } from "../motion/tokens";
import { resolvePageTransition } from "../motion/pageTransition";
import { useReducedMotion } from "../motion/useReducedMotion";
import { SurfaceTransition } from "../motion/surfaceTransition";
import { resolveSearchSurface } from "../utils/collectionSearch";
import { useCollectionNavigation } from "./useCollectionNavigation";
import type { CollectionEntityRef } from "../utils/collectionEntities";
import type { CollectionLocation } from "../utils/collectionNavigation";
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
  shortcutsEnabled?: boolean;
  contextMenu: ContextMenuState | null;
  infoTarget: ContextPayload | null;
  addToPlaylistTarget: ContextPayload | null;
  playlistDialog: PlaylistDialogState | null;
  smartPlaylistDialog: SmartPlaylist | "create" | null;
  nowPlayingTargetsRef: React.MutableRefObject<NowPlayingTargets>;
};

export function useNavigation({
  shortcutsEnabled = true,
  contextMenu,
  infoTarget,
  addToPlaylistTarget,
  playlistDialog,
  smartPlaylistDialog,
  nowPlayingTargetsRef,
}: UseNavigationParams) {
  const previousPageRef = useRef<"quickplay" | "collection" | "podcasts" | "settings">("quickplay");
  const pageRef = useRef<AppPage>("quickplay");
  const workspaceRef = useRef<HTMLElement | null>(null);
  const pageMotion = useRef<SurfaceTransition | null>(null);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const collection = useCollectionNavigation();
  const { query, searchMode, view, playlistId: selectedPlaylistId } = collection.location;
  const pendingReturn = useRef<CollectionLocation["origin"]>();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const focusSearchPendingRef = useRef(false);
  const [page, setPage] = useState<AppPage>("quickplay");
  const [navDir, setNavDir] = useState<1 | -1>(1);
  const [navDrift, setNavDrift] = useState<number>(MOTION_DRIFT.m);
  const [navigationAnimated, setNavigationAnimated] = useState(true);
  const [quickplayEntrance, setQuickplayEntrance] = useState(true);
  const reducedMotion = useReducedMotion();

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !shortcutsEnabled) return;
    const motion = new SurfaceTransition(workspace);
    pageMotion.current = motion;
    const stop = () => motion.stop();
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener("resize", stop);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      stop(); pageMotion.current = null;
      window.removeEventListener("resize", stop);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [shortcutsEnabled]);

  useLayoutEffect(() => {
    if (reducedMotion) { pageMotion.current?.stop(); return; }
    const motion = pageMotion.current, workspace = workspaceRef.current;
    if (!motion || !workspace || motion.enter()) return;
    const observer = new MutationObserver(() => { if (motion.enter()) observer.disconnect(); });
    observer.observe(workspace, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [page, navigationRevision, reducedMotion, shortcutsEnabled]);

  useEffect(() => {
    if (!pendingReturn.current || page === "collection") return;
    const { focus, scrolls } = pendingReturn.current;
    pendingReturn.current = undefined;
    if (page === "quickplay") document.querySelectorAll<HTMLElement>(".quickplay-viewport,.quick-section-scroll").forEach((area, i) => {
      if (scrolls?.[i]) { area.scrollTop = scrolls[i].top; area.scrollLeft = scrolls[i].left; }
    });
    const target = [...document.querySelectorAll<HTMLElement>("[data-collection-focus]")]
      .find(node => node.dataset.collectionFocus === focus);
    (target?.matches('button,a[href],[tabindex]') ? target : target?.querySelector<HTMLElement>('button,a[href]'))?.focus({ preventScroll: true });
  }, [page]);

  useEffect(() => {
    if (page !== "collection" || !focusSearchPendingRef.current) return;
    // The collection chunk may mount after the navigation's first frame.
    const observer = new window.MutationObserver(() => focusSearch());
    const focusSearch = () => {
      if (!focusSearchPendingRef.current || pageRef.current !== "collection" || !searchInputRef.current) return;
      focusSearchPendingRef.current = false;
      searchInputRef.current.focus();
      observer.disconnect();
    };
    if (workspaceRef.current) observer.observe(workspaceRef.current, { childList: true, subtree: true });
    const frame = window.requestAnimationFrame(focusSearch);
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [page]);

  // Commit the intent synchronously, including reversals in one React batch.
  // Visual hand-off overlaps the mounted target and survives rapid reversals.
  function requestNavigation(next: AppPage, rememberCollection = true, animate = true) {
    const from = pageRef.current;
    if (next === from) return;
    if (next !== "collection") focusSearchPendingRef.current = false;
    if (from === "collection" && rememberCollection) collection.remember();
    const transition = resolvePageTransition(from, next);
    const enabled = animate && !reducedMotion && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches && !document.hidden;
    const visiblePage = workspaceRef.current?.dataset.page ?? from;
    pageMotion.current?.prepare(visiblePage, next, transition, enabled);
    setNavigationAnimated(enabled);
    setNavigationRevision(revision => revision + 1);
    setNavDir(transition.direction);
    setNavDrift(next === "nowPlaying" ? MOTION_DRIFT.l : MOTION_DRIFT.m);
    if (next === "quickplay") setQuickplayEntrance(false);
    pageRef.current = next;
    setPage(next);
  }

  function clearCollectionSearch() {
    collection.patch({ query: "", searchMode: "browse", filter: "all" });
  }

  function setCollectionSearchQuery(value: string) {
    collection.setQuery(value);
  }

  function focusCollectionSearch() {
    if (pageRef.current === "collection") {
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
      return;
    }
    focusSearchPendingRef.current = true;
    requestNavigation("collection");
  }

  function navigatePage(nextPage: "quickplay" | "collection" | "podcasts" | "settings", animate = true) {
    requestNavigation(nextPage, true, animate);
  }

  function navigateCollection(nextView: ViewMode) {
    collection.openIndex(nextView);
    requestNavigation("collection");
  }

  function openCollectionEntity(entity: CollectionEntityRef) {
    const focus = document.activeElement?.closest<HTMLElement>("[data-collection-focus]")?.dataset.collectionFocus;
    const scrolls = page === "quickplay" ? [...document.querySelectorAll<HTMLElement>(".quickplay-viewport,.quick-section-scroll")]
      .map(area => ({ top: area.scrollTop, left: area.scrollLeft })) : undefined;
    collection.open(entity, page === "collection" ? undefined : { page, focus, scrolls });
    requestNavigation("collection");
  }

  function travelCollection(direction: 1 | -1, animate = true) {
    const origin = collection.travel(direction, animate);
    if (origin) {
      pendingReturn.current = origin;
      requestNavigation(origin.page, false, animate);
    }
  }

  useEffect(() => {
    function handleCollectionSearchKeys(event: KeyboardEvent) {
      if (!shortcutsEnabled) return;
      if (event.isComposing || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (contextMenu || infoTarget || addToPlaylistTarget || playlistDialog || smartPlaylistDialog) return;
      if (page === "collection" && event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        travelCollection(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
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
        collection.patch({ searchMode: "results" });
      }
    }

    window.addEventListener("keydown", handleCollectionSearchKeys, true);
    return () => window.removeEventListener("keydown", handleCollectionSearchKeys, true);
  }, [addToPlaylistTarget, contextMenu, infoTarget, page, playlistDialog, query, searchMode, smartPlaylistDialog, shortcutsEnabled]);

  function openNowPlaying() {
    const { activePodcastEpisode, activeTrack } = nowPlayingTargetsRef.current;
    if (!activePodcastEpisode && !activeTrack) return;
    if (pageRef.current !== "nowPlaying") previousPageRef.current = pageRef.current;
    requestNavigation("nowPlaying");
  }

  return {
    query,
    searchMode,
    searchInputRef,
    view,
    collection,
    selectedPlaylistId,
    setSelectedPlaylistId: collection.setPlaylistId,
    openCollectionEntity,
    travelCollection,
    page,
    workspaceRef,
    navDir,
    navDrift,
    navigationAnimated,
    quickplayEntrance,
    previousPageRef,
    requestNavigation,
    clearCollectionSearch,
    setCollectionSearchQuery,
    navigatePage,
    navigateCollection,
    openNowPlaying,
  };
}
