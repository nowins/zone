import { CONTENT_ENTRANCE_MOTION } from "./tokens.js";

const listSelector = ".collection-track-scroll,.collection-artist-index,.collection-album-index,.playlist-list";
const itemSelector = ".collection-track-row,.collection-artist-index > li,.collection-album-index > div,.playlist-list > button";
export type ContentFrame = { transform: string; opacity: string };
export type ContentItem = { node: HTMLElement; key: string; delay: number };
export type ContentFrames = Map<string, ContentFrame>;
type Animate = (node: HTMLElement, frames: Keyframe[], duration: number, delay?: number) => void;
const anchoringOwners = new WeakMap<HTMLElement, { value: string; count: number }>();

function itemKey(node: HTMLElement): string {
  const list = node.parentElement!;
  return `${list.className}:${list.closest<HTMLElement>("[data-collection-list]")?.dataset.collectionList ?? ""}:${node.dataset.collectionAnchor}`;
}

/** Uniform rows and regular grids need two item measurements, even after scroll restoration. */
export function contentEntranceItems(root: HTMLElement): ContentItem[] {
  const window = root.ownerDocument.defaultView!;
  const viewport = root.getBoundingClientRect();
  const items: ContentItem[] = [];
  for (const list of [...root.querySelectorAll<HTMLElement>(listSelector)].slice(0, CONTENT_ENTRANCE_MOTION.maxRegions)) {
    const children = list.children;
    const skip = list.matches(".playlist-list") ? 1 : 0; // The creation action precedes playlist rows.
    const first = children[skip] as HTMLElement | undefined;
    if (!first?.matches(itemSelector)) continue;
    const area = list.closest<HTMLElement>("[data-collection-scroll]") ?? list;
    const clip = area.getBoundingClientRect();
    const top = Math.max(viewport.top, clip.top, 0), bottom = Math.min(viewport.bottom, clip.bottom, window.innerHeight);
    if (bottom <= top || clip.right <= Math.max(viewport.left, 0) || clip.left >= Math.min(viewport.right, window.innerWidth)) continue;
    const style = window.getComputedStyle(list);
    const columns = style.display === "grid" ? Math.max(1, style.gridTemplateColumns.split(/\s+/).filter(value => value.endsWith("px")).length) : 1;
    const count = children.length - skip;
    const firstRect = first.getBoundingClientRect();
    const next = children[skip + columns] as HTMLElement | undefined;
    const stride = next ? next.getBoundingClientRect().top - firstRect.top : firstRect.height + (parseFloat(style.rowGap) || 0);
    if (firstRect.height <= 0 || stride <= 0) continue;
    const start = Math.max(0, Math.floor((top - firstRect.top - firstRect.height) / stride) + 1) * columns;
    const end = Math.min(count, Math.ceil((bottom - firstRect.top) / stride) * columns);
    for (let index = start; index < end && items.length < CONTENT_ENTRANCE_MOTION.maxItems; index++) {
      const node = children[index + skip] as HTMLElement;
      if (!node.matches(itemSelector)) continue;
      items.push({ node, key: itemKey(node), delay: CONTENT_ENTRANCE_MOTION.delay + Math.min((index - start) * CONTENT_ENTRANCE_MOTION.step, CONTENT_ENTRANCE_MOTION.maxDelay) });
    }
    if (items.length === CONTENT_ENTRANCE_MOTION.maxItems) break;
  }
  return items;
}

/** Snapshots already froze animated targets; settled rows need no style reads. */
export function captureContentFrames(snapshot: HTMLElement): ContentFrames {
  const frames: ContentFrames = new Map();
  for (const node of snapshot.querySelectorAll<HTMLElement>(itemSelector)) {
    if (node.style.transform || node.style.opacity) frames.set(itemKey(node), {
      transform: node.style.transform || "none", opacity: node.style.opacity || "1",
    });
  }
  return frames;
}

/** Browser scroll anchoring must not compensate for the explicit item translation. */
export function suspendContentAnchoring(items: ContentItem[]): () => void {
  const areas = new Set(items.map(({ node }) => node.closest<HTMLElement>("[data-collection-scroll]") ?? node.parentElement!));
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

/** A quick build-in, separate from the page's horizontal transport. */
export function playContentEntrance(items: ContentItem[], animate: Animate, returning: ContentFrames | null = null): void {
  for (const { node, key, delay } of items) {
    const start = returning ? returning.get(key) ?? { transform: "none", opacity: "1" }
      : { transform: `translate3d(0,${CONTENT_ENTRANCE_MOTION.drift}px,0)`, opacity: "0" };
    const wait = returning ? 0 : delay;
    animate(node, [{ transform: start.transform }, { transform: "none" }], CONTENT_ENTRANCE_MOTION.move, wait);
    animate(node, [{ opacity: start.opacity }, { opacity: 1 }], CONTENT_ENTRANCE_MOTION.fade, wait);
  }
}
