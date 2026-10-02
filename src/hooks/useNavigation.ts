import { useEffect, useRef, useState } from "react";
import { MOTION_DRIFT, MOTION_DURATIONS } from "../motion/tokens";
import { resolvePageTransition } from "../motion/pageTransition";
import { useReducedMotion } from "../motion/useReducedMotion";
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
  const lastNavigationAt = useRef(-Infinity);
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
    focusSearchPendingRef.current = false;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [page]);

  // Commit the intent synchronously, including reversals in one React batch.
  // Frequent input settles immediately rather than restarting an entrance.
  function requestNavigation(next: AppPage, rememberCollection = true, animate = true) {
    const from = pageRef.current;
    if (next === from) return;
    if (next !== "collection") focusSearchPendingRef.current = false;
    if (from === "collection" && rememberCollection) collection.remember();
    const transition = resolvePageTransition(from, next);
    const now = performance.now();
    setNavigationAnimated(animate && !reducedMotion && now - lastNavigationAt.current >= MOTION_DURATIONS.page);
    lastNavigationAt.current = now;
    setNavDir(transition.direction);
    setNavDrift(transition.enterDriftPx);
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
    requestNavigation("collection", true, false);
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
        travelCollection(event.key === "ArrowLeft" ? -1 : 1, false);
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
