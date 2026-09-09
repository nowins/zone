import { COLLECTION_CATEGORY_ORDER, type CollectionHistory, type CollectionLocation } from "../utils/collectionNavigation.js";
import { BROWSE_MOTION, COLLECTION_PIVOT_MOTION, MOTION_DRIFT, MOTION_EASINGS, MOTION_STAGGER } from "./tokens.js";

const isIndex = (location: CollectionLocation) => !location.entity && !(location.query.trim() && location.searchMode === "results");

/** Category order supplies sibling direction; object history has a matching return. */
export function collectionPivotDirection(history: CollectionHistory): -1 | 0 | 1 {
  const current = history.entries[history.cursor];
  if (!history.animate) return 0;
  const previous = history.entries[history.cursor - history.direction];
  if (!previous || !isIndex(previous) || !isIndex(current)) return history.direction;
  return COLLECTION_CATEGORY_ORDER.indexOf(current.view) < COLLECTION_CATEGORY_ORDER.indexOf(previous.view) ? -1 : 1;
}

const itemSelector = [
  ".collection-artist-index > li", ".collection-album-index > div", ".collection-track-row",
  ".collection-track-head", ".playlist-heading", ".playlist-create", ".playlist-list > button",
  ".collection-entity-heading", ".collection-detail-tabs", ".collection-entity-section > h2",
  ".collection-disc-label", ".collection-related-album", ".collection-playlist-relations > li",
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
  const events = ["pointerdown", "keydown", "wheel"] as const;
  const scrollPositions = new Map<Element, { top: number; left: number }>();
  for (const area of interactionRoot.querySelectorAll<HTMLElement>("[data-collection-scroll]")) {
    scrollPositions.set(area, { top: area.scrollTop, left: area.scrollLeft });
  }
  const onScroll = (event: Event) => {
    const area = event.target as HTMLElement;
    const saved = scrollPositions.get(area);
    // Scroll restoration may dispatch its event after the layout effect starts motion.
    if (saved && saved.top === area.scrollTop && saved.left === area.scrollLeft) return;
    stop();
  };
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const animation of animations) { animation.onfinish = null; animation.cancel(); }
    for (const event of events) interactionRoot.removeEventListener(event, stop, true);
    interactionRoot.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("visibilitychange", stop);
    window.removeEventListener("resize", stop);
  };
  const animate = (node: HTMLElement, drift: number, delay: number, fade: boolean, scale = 1) => {
    const animation = node.animate([
      { transform: `translate3d(${direction * drift}px, 0, 0) scale(${scale})`, ...(fade ? { opacity: 0 } : {}) },
      { transform: "translate3d(0, 0, 0)", ...(fade ? { opacity: 1 } : {}) },
    ], { duration: BROWSE_MOTION.duration, delay, easing: `cubic-bezier(${MOTION_EASINGS.standard.join(",")})`, fill: "backwards" });
    animation.onfinish = () => {
      if (animations.every(item => item.playState === "finished")) stop();
    };
    animations.push(animation);
  };
  // Use the podcast feather curve and scale, with a bounded row-by-row cascade.
  animate(root, MOTION_DRIFT.m, 0, visible.length === 0);
  let row = -1, rowTop = -Infinity;
  for (const { node, top } of visible) {
    if (top - rowTop > 2) { row += 1; rowTop = top; }
    animate(node, MOTION_DRIFT.m, Math.min(row * MOTION_STAGGER.step, MOTION_STAGGER.max), true, BROWSE_MOTION.scale);
  }
  for (const event of events) interactionRoot.addEventListener(event, stop, { capture: true, passive: true });
  interactionRoot.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("visibilitychange", stop);
  window.addEventListener("resize", stop);
  return stop;
}
