import { COLLECTION_CATEGORY_ORDER, type CollectionHistory, type CollectionLocation } from "../utils/collectionNavigation.js";
import { COLLECTION_PIVOT_MOTION, MOTION_EASINGS, NAVIGATION_MOTION } from "./tokens.js";
import { snapshotSurface } from "./surfaceTransition.js";
import { captureContentFrames, contentEntranceItems, playContentEntrance, suspendContentAnchoring, type ContentFrames } from "./contentEntrance.js";

const isIndex = (location: CollectionLocation) => !location.entity && !(location.query.trim() && location.searchMode === "results");

/** Category order supplies sibling direction; object history has a matching return. */
export function collectionPivotDirection(history: CollectionHistory): -1 | 0 | 1 {
  const current = history.entries[history.cursor];
  if (!history.animate) return 0;
  const previous = history.entries[history.cursor - history.direction];
  if (!previous || !isIndex(previous) || !isIndex(current)) return history.direction;
  return COLLECTION_CATEGORY_ORDER.indexOf(current.view) < COLLECTION_CATEGORY_ORDER.indexOf(previous.view) ? -1 : 1;
}

const groupSelector = [
  ".collection-artist-index", ".collection-album-index", ".collection-track-list", ".collection-track-scroll",
  ".collection-track-head", ".playlist-content", ".playlist-heading",
  ".collection-entity-heading", ".collection-detail-tabs", ".collection-entity-section",
].join(",");

type Departure = { key: string; layer: HTMLElement; node: HTMLElement; animation: Animation; arrival: Map<string, Keyframe>; contentArrival: ContentFrames | null };
const departures = new WeakMap<HTMLElement, Departure>();
const surfaceKey = (location: CollectionLocation) => JSON.stringify([location.view, location.entity, location.query, location.searchMode, location.playlistId]);
const groupKey = (node: HTMLElement, index: number) => `${[...node.classList].join(".")}:${index}`;
const clearDeparture = (root: HTMLElement, departure: Departure | undefined) => {
  if (!departure) return;
  departure.animation.onfinish = null;
  departure.animation.cancel();
  departure.layer.remove();
  if (departures.get(root) === departure) departures.delete(root);
};

/** Capture before React replaces the keyed content; keep no live old view. */
export function prepareCollectionPivot(root: HTMLElement, history: CollectionHistory, next: CollectionHistory): void {
  const window = root.ownerDocument.defaultView!;
  const content = root.querySelector<HTMLElement>(".collection-content");
  if (!content || !next.animate || root.ownerDocument.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || typeof content.animate !== "function") return;
  const direction = collectionPivotDirection(next) || next.direction;
  const previous = departures.get(root), arrival = new Map<string, Keyframe>();
  const returning = previous?.key === surfaceKey(next.entries[next.cursor]);
  const contentArrival = returning ? captureContentFrames(previous.node) : null;
  if (returning) {
    const parent = window.getComputedStyle(previous.node);
    const offset = new window.DOMMatrixReadOnly(parent.transform === "none" ? undefined : parent.transform).m41;
    [...previous.node.querySelectorAll<HTMLElement>(groupSelector)].forEach((node, index) => {
      const style = window.getComputedStyle(node);
      const x = new window.DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform).m41;
      arrival.set(groupKey(node, index), { transform: `translate3d(${x + offset}px,0,0)`, opacity: Number(parent.opacity || 1) * Number(style.opacity || 1) });
    });
  }
  const snapshot = snapshotSurface(content);
  // Navigation belongs to the live page, not the departing data surface.
  snapshot.node.querySelectorAll<HTMLElement>(".playlist-list").forEach(node => { node.style.visibility = "hidden"; });
  clearDeparture(root, previous);
  const animation = snapshot.node.animate([
    { transform: "none", opacity: 1 },
    { transform: `translate3d(${-direction * NAVIGATION_MOTION.exitDrift}px,0,0)`, opacity: 0 },
  ], { duration: NAVIGATION_MOTION.exit, easing: `cubic-bezier(${MOTION_EASINGS.navigation.join(",")})`, fill: "forwards" });
  const departure = { ...snapshot, animation, arrival, contentArrival, key: surfaceKey(history.entries[history.cursor]) };
  departures.set(root, departure);
  animation.onfinish = () => clearDeparture(root, departure);
}

/** Horizontal regions and a bounded first-screen content build-in. */
export function playCollectionPivot(root: HTMLElement, direction: -1 | 1): () => void {
  const document = root.ownerDocument, window = document.defaultView;
  if (!window || document.hidden || typeof root.animate !== "function") return () => {};
  const viewport = root.getBoundingClientRect();
  if (viewport.width <= 0 || viewport.height <= 0) return () => {};
  const interactionRoot = root.closest<HTMLElement>(".collection-connected") ?? root;
  const departure = departures.get(interactionRoot);
  const contentItems = contentEntranceItems(root);
  const restoreAnchoring = suspendContentAnchoring(contentItems);
  const groups: HTMLElement[] = [];
  const allGroups = [...root.querySelectorAll<HTMLElement>(groupSelector)];
  for (const node of allGroups) {
    // A section owns its descendants' movement, including the track list.
    const parent = node.parentElement?.closest(groupSelector);
    if (parent && root.contains(parent)) continue;
    const rect = node.getBoundingClientRect();
    const scroll = node.closest<HTMLElement>("[data-collection-scroll]")?.getBoundingClientRect() ?? viewport;
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= Math.max(viewport.top, scroll.top, 0)
      || rect.top >= Math.min(viewport.bottom, scroll.bottom, window.innerHeight)
      || rect.right <= Math.max(viewport.left, scroll.left, 0)
      || rect.left >= Math.min(viewport.right, scroll.right, window.innerWidth)) continue;
    groups.push(node);
    if (groups.length === COLLECTION_PIVOT_MOTION.maxGroups) break;
  }
  if (!groups.length) groups.push(root);
  let animations: { node: HTMLElement; animation: Animation }[] = [];
  const scrollPositions = new Map<Element, { top: number; left: number }>();
  for (const area of interactionRoot.querySelectorAll<HTMLElement>("[data-collection-scroll]")) {
    scrollPositions.set(area, { top: area.scrollTop, left: area.scrollLeft });
  }
  let stopped = false, settling = false;
  const cancelAnimations = () => {
    for (const { animation } of animations) { animation.onfinish = null; animation.cancel(); }
    animations = [];
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimations();
    restoreAnchoring();
    clearDeparture(interactionRoot, departure);
    interactionRoot.removeEventListener("pointerdown", settle, true);
    interactionRoot.removeEventListener("wheel", settle, true);
    interactionRoot.removeEventListener("keydown", settle, true);
    interactionRoot.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("resize", stop);
  };
  const animate = (node: HTMLElement, frames: Keyframe[], duration: number, delay = 0) => {
    const animation = node.animate(frames, {
      duration, delay, easing: `cubic-bezier(${MOTION_EASINGS.navigation.join(",")})`, fill: "backwards",
    });
    animations.push({ node, animation });
    animation.onfinish = () => {
      if (animations.every(item => item.animation.playState === "finished")) stop();
    };
  };
  const settle = () => {
    if (stopped || settling) return;
    settling = true;
    // Read every current frame before cancelling; otherwise text snaps to its end.
    const frames = [...new Set(animations.map(({ node }) => node))].map(node => {
      const style = window.getComputedStyle(node);
      return { node, transform: style.transform, opacity: style.opacity };
    });
    cancelAnimations();
    for (const frame of frames) animate(frame.node, [
      { transform: frame.transform, opacity: frame.opacity }, { transform: "none", opacity: 1 },
    ], COLLECTION_PIVOT_MOTION.settle);
  };
  const onScroll = (event: Event) => {
    const area = event.target as HTMLElement;
    const saved = scrollPositions.get(area);
    // Queued restoration events describe the same position and need no interruption.
    if (saved && saved.top === area.scrollTop && saved.left === area.scrollLeft) return;
    settle();
  };
  const hidden = () => { if (document.hidden) stop(); };
  groups.forEach((node, index) => animate(node, [
    departure?.arrival.get(groupKey(node, allGroups.indexOf(node))) ?? { transform: `translate3d(${direction * (index === 0 ? COLLECTION_PIVOT_MOTION.drift : COLLECTION_PIVOT_MOTION.secondaryDrift)}px, 0, 0)`, opacity: 0 },
    { transform: "none", opacity: 1 },
  ], COLLECTION_PIVOT_MOTION.duration, Math.min(index, COLLECTION_PIVOT_MOTION.staggerGroups - 1) * COLLECTION_PIVOT_MOTION.stagger));
  playContentEntrance(contentItems, animate, departure?.contentArrival);
  interactionRoot.addEventListener("pointerdown", settle, { capture: true, passive: true });
  interactionRoot.addEventListener("wheel", settle, { capture: true, passive: true });
  interactionRoot.addEventListener("keydown", settle, true);
  interactionRoot.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("resize", stop);
  return stop;
}
