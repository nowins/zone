import { COLLECTION_CATEGORY_ORDER, type CollectionHistory, type CollectionLocation } from "../utils/collectionNavigation.js";
import { COLLECTION_PIVOT_MOTION, MOTION_DRIFT, MOTION_DURATIONS, MOTION_EASINGS, MOTION_STAGGER } from "./tokens.js";

const isIndex = (location: CollectionLocation) => !location.entity && !(location.query.trim() && location.searchMode === "results");

/** History travel restores a surface; category order supplies spatial direction. */
export function collectionPivotDirection(history: CollectionHistory): -1 | 0 | 1 {
  const current = history.entries[history.cursor];
  if (!history.animate || !isIndex(current)) return 0;
  const previous = history.entries[history.cursor - 1];
  if (!previous || !isIndex(previous)) return 1;
  return COLLECTION_CATEGORY_ORDER.indexOf(current.view) < COLLECTION_CATEGORY_ORDER.indexOf(previous.view) ? -1 : 1;
}

const itemSelector = [
  ".collection-artist-index > li", ".collection-album-index > div", ".collection-track-row",
  ".collection-track-head", ".playlist-heading", ".playlist-create", ".playlist-list > button",
].join(",");

/** Short compositor entrances, clipped to visible rows; never retain an outgoing view. */
export function playCollectionPivot(root: HTMLElement, direction: -1 | 1): () => void {
  const document = root.ownerDocument, window = document.defaultView;
  if (!window || document.hidden || typeof root.animate !== "function") return () => {};
  const viewport = root.getBoundingClientRect();
  if (viewport.width <= 0 || viewport.height <= 0) return () => {};
  const interactionRoot = root.closest<HTMLElement>(".collection-connected") ?? root;
  const visible: { node: HTMLElement; top: number }[] = [];
  for (const node of root.querySelectorAll<HTMLElement>(itemSelector)) {
    const rect = node.getBoundingClientRect();
    const scroll = node.closest<HTMLElement>("[data-collection-scroll]")?.getBoundingClientRect() ?? viewport;
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= Math.max(viewport.top, scroll.top, 0)
      || rect.top >= Math.min(viewport.bottom, scroll.bottom, window.innerHeight)
      || rect.right <= Math.max(viewport.left, scroll.left, 0)
      || rect.left >= Math.min(viewport.right, scroll.right, window.innerWidth)) continue;
    visible.push({ node, top: rect.top });
    if (visible.length === COLLECTION_PIVOT_MOTION.maxItems) break;
  }
  visible.sort((a, b) => a.top - b.top);
  const animations: Animation[] = [];
  const events = ["pointerdown", "keydown", "wheel", "scroll"] as const;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const animation of animations) { animation.onfinish = null; animation.cancel(); }
    for (const event of events) interactionRoot.removeEventListener(event, stop, true);
    document.removeEventListener("visibilitychange", stop);
    window.removeEventListener("resize", stop);
  };
  const animate = (node: HTMLElement, drift: number, delay: number, fade: boolean) => {
    const animation = node.animate([
      { transform: `translate3d(${direction * drift}px, 0, 0)`, ...(fade ? { opacity: 0 } : {}) },
      { transform: "translate3d(0, 0, 0)", ...(fade ? { opacity: 1 } : {}) },
    ], { duration: MOTION_DURATIONS.content, delay, easing: `cubic-bezier(${MOTION_EASINGS.entrance.join(",")})`, fill: "backwards" });
    animation.onfinish = () => {
      if (animations.every(item => item.playState === "finished")) stop();
    };
    animations.push(animation);
  };
  // One shared movement gives the page direction; rows add a small delayed drift.
  animate(root, MOTION_DRIFT.m, 0, visible.length === 0);
  let row = -1, rowTop = -Infinity;
  for (const { node, top } of visible) {
    if (top - rowTop > 2) { row += 1; rowTop = top; }
    animate(node, MOTION_DRIFT.s, Math.min(row, COLLECTION_PIVOT_MOTION.groups - 1) * MOTION_STAGGER.step, true);
  }
  for (const event of events) interactionRoot.addEventListener(event, stop, { capture: true, passive: true });
  document.addEventListener("visibilitychange", stop);
  window.addEventListener("resize", stop);
  return stop;
}
