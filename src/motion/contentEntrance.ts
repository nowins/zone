import { BROWSE_MOTION } from "./tokens.js";

const listSelector = ".collection-track-scroll,.collection-track-window,.collection-artist-index,.collection-album-index,.collection-browse-index";
const itemSelector = ".collection-track-row,.collection-artist-index > li,.collection-album-index > div,.collection-browse-index > li";
const podcastItemSelector = ".podcast-episode,.podcast-show-card,.podcast-library-show,.podcast-continue-card,.podcast-queue-episode";
const quickplayItemSelector = ".quick-pin,.quick-album,.quick-feature";
export type ContentFrame = { transform: string; opacity: string };
export type ContentItem = { node: HTMLElement; key: string; delay: number; kind: "card" | "list" };
export type ContentFrames = Map<string, ContentFrame>;
type Animate = (node: HTMLElement, frames: Keyframe[], duration: number, delay?: number) => void;
const anchoringOwners = new WeakMap<HTMLElement, { value: string; count: number }>();

function itemKey(node: HTMLElement): string {
  const list = node.parentElement!;
  return `${list.className}:${list.closest<HTMLElement>("[data-collection-list]")?.dataset.collectionList ?? ""}:${node.dataset.collectionAnchor ?? node.dataset.podcastEpisode ?? node.dataset.podcastShow ?? node.dataset.pinId ?? node.dataset.collectionFocus ?? node.getAttribute("aria-label") ?? node.textContent}`;
}

/** Uniform rows and regular grids need two item measurements, even after scroll restoration. */
export function contentEntranceItems(root: HTMLElement): ContentItem[] {
  const window = root.ownerDocument.defaultView!;
  const viewport = root.getBoundingClientRect();
  const items: ContentItem[] = [];
  const append = (node: HTMLElement, index: number) => {
    const kind = node.matches(".collection-track-row,.collection-browse-index > li,.podcast-episode,.podcast-queue-episode") ? "list" : "card";
    items.push({ node, key: itemKey(node), kind, delay: kind === "card" ? Math.min(index * BROWSE_MOTION.stagger, BROWSE_MOTION.maxDelay) : 0 });
  };
  for (const list of [...root.querySelectorAll<HTMLElement>(listSelector)].slice(0, BROWSE_MOTION.maxRegions)) {
    const children = list.children;
    const first = children[0] as HTMLElement | undefined;
    if (!first?.matches(itemSelector)) continue;
    const area = list.closest<HTMLElement>("[data-collection-scroll]") ?? list;
    const clip = area.getBoundingClientRect();
    const top = Math.max(viewport.top, clip.top, 0), bottom = Math.min(viewport.bottom, clip.bottom, window.innerHeight);
    if (bottom <= top || clip.right <= Math.max(viewport.left, 0) || clip.left >= Math.min(viewport.right, window.innerWidth)) continue;
    const style = window.getComputedStyle(list);
    const columns = style.display === "grid" ? Math.max(1, style.gridTemplateColumns.split(/\s+/).filter(value => value.endsWith("px")).length) : 1;
    const count = children.length;
    const firstRect = first.getBoundingClientRect();
    const next = children[columns] as HTMLElement | undefined;
    const stride = next ? next.getBoundingClientRect().top - firstRect.top : firstRect.height + (parseFloat(style.rowGap) || 0);
    if (firstRect.height <= 0 || stride <= 0) continue;
    const start = Math.max(0, Math.floor((top - firstRect.top - firstRect.height) / stride) + 1) * columns;
    const end = Math.min(count, Math.ceil((bottom - firstRect.top) / stride) * columns);
    for (let index = start; index < end && items.length < BROWSE_MOTION.maxItems; index++) {
      const node = children[index] as HTMLElement;
      if (!node.matches(itemSelector)) continue;
      append(node, index - start);
    }
    if (items.length === BROWSE_MOTION.maxItems) break;
  }
  // Podcast rows and panorama covers have variable geometry; inspect only their
  // viewport band instead of inferring a uniform stride or animating hidden items.
  for (const node of root.querySelectorAll<HTMLElement>(`${podcastItemSelector},${quickplayItemSelector}`)) {
    if (items.length === BROWSE_MOTION.maxItems) break;
    const area = node.closest<HTMLElement>(".podcast-screen,.quick-section-scroll,.quickplay-viewport") ?? root;
    const clip = area.getBoundingClientRect(), rect = node.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0 || rect.bottom <= Math.max(viewport.top, clip.top, 0)
      || rect.top >= Math.min(viewport.bottom, clip.bottom, window.innerHeight)
      || rect.right <= Math.max(viewport.left, clip.left, 0) || rect.left >= Math.min(viewport.right, clip.right, window.innerWidth)) continue;
    append(node, items.filter(item => item.kind === "card").length);
  }
  return items;
}

/** Snapshots already froze animated targets; settled rows need no style reads. */
export function captureContentFrames(snapshot: HTMLElement): ContentFrames {
  const frames: ContentFrames = new Map();
  for (const node of snapshot.querySelectorAll<HTMLElement>(`${itemSelector},${podcastItemSelector},${quickplayItemSelector}`)) {
    if (node.style.transform || node.style.opacity) frames.set(itemKey(node), {
      transform: node.style.transform || "none", opacity: node.style.opacity || "1",
    });
  }
  return frames;
}

/** Keep scroll restoration stable while visible regions move. */
export function suspendContentAnchoring(items: ContentItem[]): () => void {
  const areas = new Set(items.map(({ node }) => node.closest<HTMLElement>("[data-collection-scroll],.podcast-screen,.quick-section-scroll,.quickplay-viewport") ?? node.parentElement!));
  for (const area of areas) {
    const owner = anchoringOwners.get(area) ?? { value: area.style.overflowAnchor, count: 0 };
    owner.count++;
    anchoringOwners.set(area, owner);
    area.style.overflowAnchor = "none";
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const area of areas) {
      const owner = anchoringOwners.get(area)!;
      if (--owner.count) continue;
      area.style.overflowAnchor = owner.value;
      anchoringOwners.delete(area);
    }
  };
}

/** Covers build in reading order; text lists reveal together at their region. */
export function playContentEntrance(items: ContentItem[], animate: Animate, returning: ContentFrames | null = null): void {
  for (const { node, key, delay, kind } of items) {
    if (kind !== "card") continue;
    // Regions own movement in both libraries; item baselines never change.
    const start = returning ? returning.get(key) ?? { transform: "none", opacity: "1" }
      : { transform: "none", opacity: "0" };
    const wait = returning ? 0 : delay;
    animate(node, [{ opacity: start.opacity }, { opacity: 1 }], BROWSE_MOTION.reveal, wait);
  }
}
