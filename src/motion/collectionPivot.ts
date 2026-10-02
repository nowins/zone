import { COLLECTION_CATEGORY_ORDER, type CollectionHistory, type CollectionLocation } from "../utils/collectionNavigation.js";
import { COLLECTION_PIVOT_MOTION, MOTION_DRIFT, MOTION_EASINGS, MOTION_STAGGER } from "./tokens.js";

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
  ".collection-artist-index", ".collection-album-index", ".collection-track-scroll",
  ".collection-track-head", ".playlist-heading", ".playlist-create", ".playlist-list",
  ".collection-entity-heading", ".collection-detail-tabs", ".collection-entity-section",
].join(",");

/** Animate a few content regions, independent of the number of library rows. */
export function playCollectionPivot(root: HTMLElement, direction: -1 | 1): () => void {
  const document = root.ownerDocument, window = document.defaultView;
  if (!window || document.hidden || typeof root.animate !== "function") return () => {};
  const viewport = root.getBoundingClientRect();
  if (viewport.width <= 0 || viewport.height <= 0) return () => {};
  const interactionRoot = root.closest<HTMLElement>(".collection-connected") ?? root;
  const groups: HTMLElement[] = [];
  for (const node of root.querySelectorAll<HTMLElement>(groupSelector)) {
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
    interactionRoot.removeEventListener("pointerdown", settle, true);
    interactionRoot.removeEventListener("wheel", settle, true);
    interactionRoot.removeEventListener("keydown", stop, true);
    interactionRoot.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("resize", stop);
  };
  const animate = (node: HTMLElement, frames: Keyframe[], duration: number, delay = 0) => {
    const animation = node.animate(frames, {
      duration, delay, easing: `cubic-bezier(${MOTION_EASINGS.standard.join(",")})`, fill: "backwards",
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
    const frames = animations.map(({ node }) => {
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
    { transform: `translate3d(${direction * (index === 0 ? MOTION_DRIFT.m : MOTION_DRIFT.s)}px, 0, 0)`, opacity: 0 },
    { transform: "none", opacity: 1 },
  ], COLLECTION_PIVOT_MOTION.duration, Math.min(index, COLLECTION_PIVOT_MOTION.staggerGroups - 1) * MOTION_STAGGER.step));
  interactionRoot.addEventListener("pointerdown", settle, { capture: true, passive: true });
  interactionRoot.addEventListener("wheel", settle, { capture: true, passive: true });
  interactionRoot.addEventListener("keydown", stop, true);
  interactionRoot.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("resize", stop);
  return stop;
}
