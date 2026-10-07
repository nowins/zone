import { BROWSE_MOTION, MOTION_EASINGS } from "./tokens.js";
import { inheritedFrame, readSurfaceFrame, snapshotSurface } from "./surfaceSnapshot.js";
import { captureContentFrames, contentEntranceItems, playContentEntrance, suspendContentAnchoring, type ContentFrames } from "./contentEntrance.js";

const pageSelector = ".collection-connected,.podcast-page";
const groupSelector = [
  ".collection-artist-index", ".collection-album-index", ".collection-track-list", ".collection-track-scroll",
  ".collection-track-head", ".playlist-content", ".playlist-heading",
  ".collection-entity-heading", ".collection-detail-tabs", ".collection-entity-section", ".podcast-content-section",
  ".podcast-show-hero", ".podcast-show-episodes", ".podcast-detail", ".podcast-episode-results",
].join(",");
const easing = `cubic-bezier(${MOTION_EASINGS.browse.join(",")})`;
const revealEasing = `cubic-bezier(${MOTION_EASINGS.dissolve.join(",")})`;
const groupKey = (node: HTMLElement, index: number) => `${[...node.classList].join(".")}:${index}`;
export type BrowseFrames = { groups: Map<string, Keyframe>; items: ContentFrames };
export type BrowseControl = (() => void) & { settle: () => void; beforeNavigate: () => void };
type Departure = { key: string; layer: HTMLElement; node: HTMLElement; animation: Animation; returning: BrowseFrames | null };
const departures = new WeakMap<HTMLElement, Departure>();
const arrivals = new WeakMap<HTMLElement, BrowseControl>();
const idle = (): BrowseControl => Object.assign(() => {}, { settle: () => {}, beforeNavigate: () => {} });

/** The shell, navigation and search fields never belong to the data surface. */
export function browseSurface(page: HTMLElement): HTMLElement | null {
  if (page.matches(".collection-connected")) return page.querySelector(".collection-content");
  if (page.matches(".podcast-page")) return page.querySelector(".podcast-screen");
  return null;
}

/** Show loading immediately; reserve the single entrance for the first real content. */
export function browseContentPending(root: HTMLElement): boolean {
  return Boolean(root.querySelector('.podcast-loading-state,[data-browse-pending="true"]') && !root.querySelector(
    ".podcast-show-hero,.podcast-detail,.podcast-episode,.podcast-show-card,.podcast-library-show,.podcast-continue-card,.podcast-queue-episode",
  ));
}

/** A full-width previous screen must not cover the new persistent playlist index. */
function clipPlaylistDeparture(page: HTMLElement): void {
  const pane = page.querySelector<HTMLElement>(".playlist-content");
  if (!pane || !page.querySelector(".playlist-list")) return;
  const rect = pane.getBoundingClientRect();
  for (const layer of (page.closest(".shell") ?? page.ownerDocument.body).querySelectorAll<HTMLElement>(".motion-departure")) {
    const bounds = layer.getBoundingClientRect();
    layer.style.clipPath = `inset(${Math.max(0, rect.top - bounds.top)}px ${Math.max(0, bounds.right - rect.right)}px ${Math.max(0, bounds.bottom - rect.bottom)}px ${Math.max(0, rect.left - bounds.left)}px)`;
  }
}

export function captureBrowseFrames(root: HTMLElement): BrowseFrames {
  const parent = readSurfaceFrame(root), groups = new Map<string, Keyframe>();
  [...root.querySelectorAll<HTMLElement>(groupSelector)].forEach((node, index) => {
    groups.set(groupKey(node, index), inheritedFrame(node, parent, readSurfaceFrame(node)));
  });
  groups.set(groupKey(root, -1), parent);
  const panel = root.querySelector<HTMLElement>(".podcast-tab-content");
  if (panel) groups.set(groupKey(panel, -1), inheritedFrame(panel, parent, readSurfaceFrame(panel)));
  return { groups, items: captureContentFrames(root) };
}

const clearDeparture = (root: HTMLElement, departure: Departure | undefined) => {
  if (!departure) return;
  departure.animation.onfinish = null;
  departure.animation.cancel();
  departure.layer.remove();
  if (departures.get(root) === departure) departures.delete(root);
};

/** Capture data before React replaces it, without retaining a live old screen. */
export function prepareBrowseTransition(root: HTMLElement, from: string, to: string, direction: -1 | 1, enabled = true): void {
  const content = browseSurface(root), window = root.ownerDocument.defaultView;
  if (!content || !window || !enabled || root.ownerDocument.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || typeof content.animate !== "function") return;
  arrivals.get(root)?.beforeNavigate();
  const previous = departures.get(root);
  const returning = previous?.key === to ? captureBrowseFrames(previous.node) : null;
  const snapshot = snapshotSurface(content);
  snapshot.node.querySelectorAll<HTMLElement>(".playlist-list").forEach(node => { node.style.visibility = "hidden"; });
  clearDeparture(root, previous);
  const start = readSurfaceFrame(snapshot.node);
  const animation = snapshot.node.animate([
    start,
    { transform: start.transform, opacity: 0 },
  ], { duration: BROWSE_MOTION.exit, easing, fill: "forwards" });
  const departure = { ...snapshot, animation, key: from, returning };
  departures.set(root, departure);
  animation.onfinish = () => clearDeparture(root, departure);
}

/** Shared region transport and first-screen reveal for music and podcasts. */
export function playBrowseTransition(target: HTMLElement, direction: -1 | 1, returning?: BrowseFrames | null, beforeNavigate = () => {}): BrowseControl {
  const document = target.ownerDocument, window = document.defaultView;
  if (!window || document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || typeof target.animate !== "function") return idle();
  const root = target.matches(pageSelector) ? browseSurface(target) : target;
  if (!root) return idle();
  const interactionRoot = root.closest<HTMLElement>(pageSelector) ?? root;
  arrivals.get(interactionRoot)?.();
  const viewport = root.getBoundingClientRect();
  if (viewport.width <= 0 || viewport.height <= 0) return idle();
  const departure = departures.get(interactionRoot);
  clipPlaylistDeparture(interactionRoot);
  const starts = returning ?? departure?.returning;
  const contentItems = contentEntranceItems(root);
  const restoreAnchoring = suspendContentAnchoring(contentItems);
  const groups: HTMLElement[] = [];
  const allGroups = [...root.querySelectorAll<HTMLElement>(groupSelector)];
  for (const node of allGroups) {
    const parent = node.parentElement?.closest(groupSelector);
    if (parent && root.contains(parent)) continue;
    const rect = node.getBoundingClientRect();
    const scroll = node.closest<HTMLElement>("[data-collection-scroll],.podcast-screen")?.getBoundingClientRect() ?? viewport;
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= Math.max(viewport.top, scroll.top, 0)
      || rect.top >= Math.min(viewport.bottom, scroll.bottom, window.innerHeight)
      || rect.right <= Math.max(viewport.left, scroll.left, 0)
      || rect.left >= Math.min(viewport.right, scroll.right, window.innerWidth)) continue;
    groups.push(node);
    if (groups.length === BROWSE_MOTION.maxGroups) break;
  }
  if (!groups.length) groups.push(root.querySelector<HTMLElement>(".playlist-content,.podcast-tab-content") ?? root);
  let animations: { node: HTMLElement; animation: Animation }[] = [];
  const scrollPositions = new Map<Element, { top: number; left: number }>();
  for (const area of [root, ...interactionRoot.querySelectorAll<HTMLElement>("[data-collection-scroll],.podcast-screen")]) {
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
    if (arrivals.get(interactionRoot) === control) arrivals.delete(interactionRoot);
    cancelAnimations();
    restoreAnchoring();
    clearDeparture(interactionRoot, departure);
    interactionRoot.removeEventListener("pointerdown", onInput, true);
    interactionRoot.removeEventListener("wheel", onInput, true);
    interactionRoot.removeEventListener("keydown", onInput, true);
    interactionRoot.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("resize", stop);
  };
  const animate = (node: HTMLElement, frames: Keyframe[], duration: number, delay = 0) => {
    const spatial = frames.some(frame => frame.transform !== undefined);
    const animation = node.animate(frames, { duration, delay, easing: spatial ? easing : revealEasing, fill: "backwards" });
    animations.push({ node, animation });
    animation.onfinish = () => { if (animations.every(item => item.animation.playState === "finished")) stop(); };
  };
  const settle = () => {
    if (stopped || settling) return;
    settling = true;
    const frames = [...new Set(animations.map(({ node }) => node))].map(node => ({ node, ...readSurfaceFrame(node) }));
    cancelAnimations();
    for (const frame of frames) animate(frame.node, [
      { transform: frame.transform, opacity: frame.opacity }, { transform: "none", opacity: 1 },
    ], BROWSE_MOTION.settle);
  };
  const onScroll = (event: Event) => {
    const area = event.target as HTMLElement, saved = scrollPositions.get(area);
    if (!groups.some(node => node.contains(area) || area.contains(node))) return;
    if (saved && saved.top === area.scrollTop && saved.left === area.scrollLeft) return;
    settle();
  };
  const onInput = (event: Event) => {
    if (event.target instanceof window.Node && groups.some(node => node.contains(event.target as Node))) settle();
  };
  const hidden = () => { if (document.hidden) stop(); };
  groups.forEach(node => {
    const start = starts?.groups.get(groupKey(node, allGroups.indexOf(node)));
    animate(node, [
      { transform: start?.transform ?? `translate3d(${-direction * BROWSE_MOTION.drift}px,0,0)` },
      { transform: "none" },
    ], BROWSE_MOTION.duration);
    const cards = contentItems.some(item => item.kind === "card" && node.contains(item.node));
    // Only one alpha owner: covers reveal themselves; text regions reveal together.
    if (!cards || (start && Number(start.opacity) < 1)) animate(node, [
      { opacity: start?.opacity ?? 0 }, { opacity: 1 },
    ], BROWSE_MOTION.reveal);
  });
  playContentEntrance(contentItems, animate, starts?.items);
  interactionRoot.addEventListener("pointerdown", onInput, { capture: true, passive: true });
  interactionRoot.addEventListener("wheel", onInput, { capture: true, passive: true });
  interactionRoot.addEventListener("keydown", onInput, true);
  interactionRoot.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("resize", stop);
  const control = Object.assign(stop, { settle, beforeNavigate });
  arrivals.set(interactionRoot, control);
  return control;
}
