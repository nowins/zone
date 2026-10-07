import { useCallback, useRef, useState, type SetStateAction } from "react";
import type { ViewMode } from "../types";
import type { CollectionEntityRef } from "../utils/collectionEntities";
import { prepareCollectionPivot } from "../motion/collectionPivot";
import { surfaceOffset } from "../motion/surfaceTransition";
import { emptyCollectionSurface, initialCollectionHistory, pushCollectionLocation, travelCollectionHistory,
  type CollectionHistory, type CollectionLocation, type CollectionSurface } from "../utils/collectionNavigation";

export function useCollectionNavigation(onTransition?: () => void) {
  const [history, setHistory] = useState(initialCollectionHistory);
  const historyRef = useRef(history);
  const rootRef = useRef<HTMLElement | null>(null);
  const lastFocus = useRef<string>();
  const onTransitionRef = useRef(onTransition);
  onTransitionRef.current = onTransition;
  const commit = useCallback((update: (current: CollectionHistory) => CollectionHistory) => {
    const next = update(historyRef.current);
    if (next.revision !== historyRef.current.revision && rootRef.current) {
      onTransitionRef.current?.();
      prepareCollectionPivot(rootRef.current, historyRef.current, next);
    }
    historyRef.current = next;
    setHistory(next);
  }, []);
  const capture = useCallback((): CollectionSurface => {
    const surface = emptyCollectionSurface(), root = rootRef.current;
    if (!root) return historyRef.current.entries[historyRef.current.cursor].surface;
    const focused = document.activeElement?.closest<HTMLElement>("[data-collection-focus]");
    surface.focus = focused && root.contains(focused) ? focused.dataset.collectionFocus : lastFocus.current;
    for (const area of root.querySelectorAll<HTMLElement>("[data-collection-scroll]")) {
      const top = area.getBoundingClientRect().top;
      const anchor = [...area.querySelectorAll<HTMLElement>("[data-collection-anchor]")].find(node =>
        node.closest("[data-collection-scroll]") === area && node.getBoundingClientRect().bottom > top);
      surface.scrolls[area.dataset.collectionScroll!] = { top: area.scrollTop, left: area.scrollLeft,
        anchor: anchor?.dataset.collectionAnchor, offset: anchor ? anchor.getBoundingClientRect().top - top - surfaceOffset(anchor).y : undefined };
    }
    for (const list of root.querySelectorAll<HTMLElement>("[data-collection-list]")) {
      const selected = list.dataset.collectionSelection;
      if (selected) surface.selections[list.dataset.collectionList!] = selected;
    }
    return surface;
  }, []);
  const remember = useCallback(() => {
    const surface = capture();
    commit(current => ({ ...current, animate: false, entries: current.entries.map((entry, i) => i === current.cursor ? { ...entry, surface } : entry) }));
  }, [capture, commit]);
  const patch = useCallback((values: Partial<CollectionLocation>, animate?: boolean) => {
    commit(current => ({ ...current, animate: animate ?? current.animate,
      entries: current.entries.map((entry, i) => i === current.cursor ? { ...entry, ...values } : entry) }));
  }, [commit]);
  const push = useCallback((values: Partial<CollectionLocation>, animate = true) => {
    const outgoing = capture();
    commit(current => pushCollectionLocation(current, { ...current.entries[current.cursor], tab: "overview",
      surface: emptyCollectionSurface(), origin: undefined, ...values }, outgoing, animate));
  }, [capture, commit]);
  const open = useCallback((entity: CollectionEntityRef, origin?: CollectionLocation["origin"]) => {
    push(entity.kind === "playlist" ? { entity: null, view: "playlists", playlistId: entity.id, searchMode: "browse", origin }
      : { entity, searchMode: "browse", origin });
  }, [push]);
  const openIndex = useCallback((view: ViewMode, animate = true) => push({ entity: null, view, query: "", searchMode: "results", filter: "all" }, animate), [push]);
  const travel = useCallback((direction: 1 | -1, animate = true) => {
    const before = historyRef.current;
    const origin = direction === -1 ? before.entries[before.cursor].origin : undefined;
    commit(current => {
      const next = travelCollectionHistory(current, direction, capture());
      return next === current ? current : { ...next, animate };
    });
    return before === historyRef.current ? undefined : origin;
  }, [capture, commit]);
  const setPlaylistId = useCallback((action: SetStateAction<string>) => {
    const current = historyRef.current.entries[historyRef.current.cursor].playlistId;
    const playlistId = typeof action === "function" ? action(current) : action;
    patch({ playlistId });
  }, [patch]);
  const setQuery = useCallback((query: string) => {
    const current = historyRef.current.entries[historyRef.current.cursor];
    if (query.trim() && (!current.query.trim() || current.searchMode === "browse")) {
      push({ query, searchMode: "results", filter: "all" }, false);
    } else patch({ query, searchMode: "results", filter: "all" });
  }, [patch, push]);
  const restore = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const surface = historyRef.current.entries[historyRef.current.cursor].surface;
    for (const area of root.querySelectorAll<HTMLElement>("[data-collection-scroll]")) {
      const saved = surface.scrolls[area.dataset.collectionScroll!];
      if (!saved) continue;
      area.scrollTop = saved.top;
      area.scrollLeft = saved.left;
      const anchor = [...area.querySelectorAll<HTMLElement>("[data-collection-anchor]")]
        .find(node => node.dataset.collectionAnchor === saved.anchor && node.closest("[data-collection-scroll]") === area);
      if (anchor && saved.offset !== undefined) area.scrollTop += anchor.getBoundingClientRect().top - area.getBoundingClientRect().top - surfaceOffset(anchor).y - saved.offset;
    }
    const focus = [...root.querySelectorAll<HTMLElement>("[data-collection-focus]")]
      .find(node => node.dataset.collectionFocus === surface.focus);
    if (!document.activeElement?.matches(".collection-search input")) {
      (focus || root.querySelector<HTMLElement>("[data-collection-heading]"))?.focus({ preventScroll: true });
    }
    lastFocus.current = surface.focus;
  }, []);
  const recordFocus = useCallback((target: EventTarget | null) => {
    if (target instanceof HTMLElement) lastFocus.current = target.closest<HTMLElement>("[data-collection-focus]")?.dataset.collectionFocus;
  }, []);
  return { history, location: history.entries[history.cursor], rootRef, open, openIndex, patch, remember, travel,
    setPlaylistId, setQuery, restore, recordFocus };
}
export type CollectionNavigation = ReturnType<typeof useCollectionNavigation>;
