import { NAVIGATION_MOTION, MOTION_EASINGS, MOTION_DURATIONS } from "./tokens.js";
import type { PageTransition } from "./pageTransition.js";
import { captureContentFrames, contentEntranceItems, playContentEntrance, suspendContentAnchoring, type ContentFrames } from "./contentEntrance.js";

type Frame = { transform: string; opacity: string };
type Surface = { key: string; node: HTMLElement; layer: HTMLElement; animation: Animation };
const pageSelector = ".quickplay,.content-band,.now-playing-stage";
const groupSelector = ".quick-group,.collection-toolbar,.collection-content,.settings-main-stack,.settings-sidebar,.podcast-header,.podcast-content";
const easing = `cubic-bezier(${MOTION_EASINGS.navigation.join(",")})`;

function frame(node: HTMLElement): Frame {
  const style = node.ownerDocument.defaultView!.getComputedStyle(node);
  return { transform: style.transform || "none", opacity: style.opacity || "1" };
}

function inheritedFrame(node: HTMLElement, parent: Frame, own: Frame): Frame {
  const offset = (value: Frame) => {
    if (!value.transform || value.transform === "none") return { x: 0, y: 0 };
    const matrix = new node.ownerDocument.defaultView!.DOMMatrixReadOnly(value.transform);
    return { x: matrix.m41, y: matrix.m42 };
  };
  const a = offset(parent), b = offset(own);
  return { transform: `translate3d(${a.x + b.x}px,${a.y + b.y}px,0)`, opacity: `${Number(parent.opacity) * Number(own.opacity)}` };
}

export function surfaceOffset(node: HTMLElement): { x: number; y: number } {
  const transform = frame(node).transform;
  if (!transform || transform === "none") return { x: 0, y: 0 };
  const matrix = new node.ownerDocument.defaultView!.DOMMatrixReadOnly(transform);
  return { x: matrix.m41, y: matrix.m42 };
}

/** A finite, inert visual copy; the old React tree and its effects unmount normally. */
export function snapshotSurface(node: HTMLElement): { layer: HTMLElement; node: HTMLElement } {
  const document = node.ownerDocument, window = document.defaultView!;
  const rect = node.getBoundingClientRect();
  const offset = surfaceOffset(node);
  const lookup = new Map<HTMLElement, HTMLElement>();
  const duplicate = (source: HTMLElement): HTMLElement => {
    const clone = source.cloneNode(false) as HTMLElement;
    lookup.set(source, clone);
    const first = source.firstElementChild, second = first?.nextElementSibling;
    if (source.matches(".collection-track-scroll") && first?.matches(".collection-track-row") && second?.matches(".collection-track-row")) {
      // Track rows are uniform single-line rows. Two measurements bound the
      // snapshot independently of library size, preserving the full scroll range.
      const firstRect = first.getBoundingClientRect();
      // Staggered row translations are visual offsets, not the layout stride.
      const firstTop = firstRect.top - surfaceOffset(first as HTMLElement).y;
      const stride = second.getBoundingClientRect().top - surfaceOffset(second as HTMLElement).y - firstTop;
      const owner = source.closest("[data-collection-scroll]") ?? source;
      const clip = owner.getBoundingClientRect();
      if (stride > 0) {
        const count = source.children.length;
        const start = Math.max(0, Math.min(count, Math.floor((Math.max(0, clip.top) - firstTop) / stride) - NAVIGATION_MOTION.snapshotOverscanRows));
        const end = Math.max(start, Math.min(count, Math.ceil((Math.min(window.innerHeight, clip.bottom) - firstTop) / stride) + NAVIGATION_MOTION.snapshotOverscanRows));
        const spacer = (height: number) => {
          if (height <= 0) return;
          const gap = document.createElement("div");
          gap.style.height = `${height}px`; gap.style.flexShrink = "0";
          clone.append(gap);
        };
        spacer(start * stride);
        for (let index = start; index < end; index++) clone.append(duplicate(source.children[index] as HTMLElement));
        spacer((count - end) * stride);
        return clone;
      }
      if (firstRect.height === 0) return clone;
    }
    for (const child of source.childNodes) clone.append(child.nodeType === 1 ? duplicate(child as HTMLElement) : child.cloneNode(true));
    return clone;
  };
  const copy = duplicate(node);
  // Freeze only active animation targets, rather than reading every library row.
  for (const animation of node.getAnimations?.({ subtree: true }) ?? []) {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    const clone = target && lookup.get(target as HTMLElement);
    if (clone) Object.assign(clone.style, frame(target as HTMLElement));
  }
  for (const [source, clone] of lookup) {
    clone.removeAttribute("id");
    for (const name of clone.getAttributeNames()) {
      if (name === "data-collection-focus" || name === "autofocus") clone.removeAttribute(name);
    }
    if (source.tagName === "CANVAS") {
      // Preserve the actual last painted frame; never run a second visualizer.
      try { (clone as HTMLCanvasElement).getContext("2d")?.drawImage(source as HTMLCanvasElement, 0, 0); } catch { /* A lost context can be empty. */ }
    }
  }
  copy.style.width = `${rect.width}px`;
  copy.style.height = `${rect.height}px`;
  copy.style.margin = "0";
  const layer = document.createElement("div");
  layer.className = "motion-departure";
  const collection = node.closest<HTMLElement>(".collection-connected");
  if (collection && collection !== node) {
    layer.classList.add("collection-connected");
    layer.dataset.collectionSurface = collection.dataset.collectionSurface;
  }
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  Object.assign(layer.style, { left: `${rect.left - offset.x}px`, top: `${rect.top - offset.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  layer.append(copy);
  (node.closest(".shell") ?? node.ownerDocument.body).append(layer);
  const scrollSelector = "[data-collection-scroll],.quickplay-viewport,.quick-section-scroll,.settings-main,.podcast-content,.now-queue-list";
  for (const source of node.querySelectorAll<HTMLElement>(scrollSelector)) {
    const clone = lookup.get(source);
    if (!clone) continue;
    clone.scrollTop = source.scrollTop;
    clone.scrollLeft = source.scrollLeft;
  }
  // Root and WAAPI transforms must survive disabling inherited CSS entrances.
  Object.assign(copy.style, frame(node));
  return { layer, node: copy };
}

/** Paired page hand-off, without retaining live pages or delaying navigation. */
export class SurfaceTransition {
  private outgoing: Surface | null = null;
  private incoming: Animation[] = [];
  private returning: Frame[] | null = null;
  private returningPane: Frame | null = null;
  private returningContent: ContentFrames | null = null;
  private sourceContent: ContentFrames | null = null;
  private removeInputListeners: (() => void) | null = null;
  private restoreAnchoring: (() => void) | null = null;
  private source: HTMLElement | null = null;
  private plan: PageTransition | null = null;

  constructor(private host: HTMLElement) {}

  private groups(node: HTMLElement): HTMLElement[] {
    const playlist = node.querySelector<HTMLElement>(".playlist-content");
    if (node.matches(".collection-connected") && playlist) return [playlist];
    return [...node.querySelectorAll<HTMLElement>(groupSelector)].filter(group => {
      const parent = group.parentElement?.closest(groupSelector);
      return !parent || !node.contains(parent);
    }).slice(0, NAVIGATION_MOTION.maxGroups);
  }

  current(): HTMLElement | null {
    return [...this.host.children].find(node => node.matches(pageSelector)) as HTMLElement | undefined ?? null;
  }

  prepare(from: string, to: string, plan: PageTransition, enabled: boolean): void {
    const source = this.current();
    enabled = enabled && typeof this.host.animate === "function";
    const returning = this.outgoing?.key === to
      ? [this.outgoing.node, ...this.groups(this.outgoing.node)].map(frame) : null;
    const returningContent = returning && this.outgoing ? captureContentFrames(this.outgoing.node) : null;
    const oldPane = returning && this.outgoing?.node.matches(".collection-connected") ? this.outgoing.node.querySelector<HTMLElement>(".playlist-content") : null;
    const returningPane = returning && oldPane ? inheritedFrame(oldPane, returning[0], frame(oldPane)) : null;
    const snapshot = source && enabled ? snapshotSurface(source) : null;
    this.stop();
    this.returning = returning;
    this.returningPane = returningPane;
    this.returningContent = returningContent;
    this.sourceContent = snapshot ? captureContentFrames(snapshot.node) : null;
    this.source = source;
    this.plan = enabled ? plan : null;
    if (!snapshot) return;
    // The clone continues from the visible frame, including interrupted entrances.
    const start = frame(snapshot.node);
    const offset = surfaceOffset(snapshot.node);
    const animation = snapshot.node.animate([
      start,
      { transform: `translate3d(${offset.x - plan.direction * plan.exitDriftPx}px,${offset.y}px,0)`, opacity: 0 },
    ], { duration: plan.exitMs, easing, fill: "forwards" });
    this.outgoing = { ...snapshot, key: from, animation };
    animation.onfinish = () => {
      if (this.outgoing?.animation !== animation) return;
      snapshot.layer.remove();
      this.outgoing = null;
      animation.cancel();
    };
  }

  enter(): boolean {
    const root = this.current(), plan = this.plan;
    if (!root) return false; // A lazy page can arrive after its loading indicator.
    this.plan = null;
    const source = this.source;
    this.source = null;
    if (!plan || root.matches(".now-playing-stage")) { this.returning = null; this.returningPane = null; this.returningContent = null; this.sourceContent = null; return true; } // Its Canvas and FLIP own stage arrival.
    // Suppress only this mount's legacy feathers. Later internal changes still
    // get their own entrance, without replaying every row on page arrival.
    root.querySelectorAll<HTMLElement>(".quick-group,.quick-album,.folder-list > div,.settings-section-heading,.settings-sidebar > section,.podcast-content-section,.podcast-episode,.podcast-show-card,.podcast-continue-card,.podcast-queue-episode")
      .forEach(node => { node.style.animation = "none"; });
    const groups = this.groups(root);
    const playlist = root.matches(".collection-connected") ? root.querySelector<HTMLElement>(".playlist-content") : null;
    const arrivalRoot = playlist ?? root;
    // Measure the settled layout before starting any parent transform.
    const contentItems = contentEntranceItems(root);
    this.restoreAnchoring = suspendContentAnchoring(contentItems);
    const starts = root === source ? [root, ...groups].map(frame) : this.returning;
    const contentStarts = root === source ? this.sourceContent : this.returningContent;
    const arrivalStart = playlist && starts
      ? root === source ? inheritedFrame(playlist, starts[0], frame(playlist)) : this.returningPane ?? starts[0]
      : starts?.[0];
    this.returning = null;
    this.returningPane = null;
    this.returningContent = null;
    this.sourceContent = null;
    const animate = (node: HTMLElement, frames: Keyframe[], duration: number, delay = 0) => {
      const animation = node.animate(frames, { duration, delay, easing, fill: "backwards" });
      this.incoming.push(animation);
      animation.onfinish = () => {
        animation.onfinish = null;
        animation.cancel();
        this.incoming = this.incoming.filter(item => item !== animation);
        if (!this.incoming.length) {
          this.removeInputListeners?.(); this.removeInputListeners = null;
          this.restoreAnchoring?.(); this.restoreAnchoring = null;
        }
      };
    };
    animate(arrivalRoot, [
      { transform: arrivalStart?.transform ?? `translate3d(${plan.direction * plan.enterDriftPx}px,0,0)` },
      { transform: "none" },
    ], plan.enterMs);
    animate(arrivalRoot, [{ opacity: arrivalStart?.opacity ?? 0 }, { opacity: 1 }], NAVIGATION_MOTION.fade);
    (playlist ? [] : groups).forEach((node, index) => animate(node, [
      { transform: starts?.[index + 1]?.transform ?? `translate3d(${plan.direction * NAVIGATION_MOTION.groupDrift}px,0,0)` },
      { transform: "none" },
    ], plan.enterMs, Math.min(index, 2) * NAVIGATION_MOTION.stagger));
    playContentEntrance(contentItems, animate, contentStarts);
    if (contentItems.length) {
      const positions = new Map([...root.querySelectorAll<HTMLElement>("[data-collection-scroll]")].map(area => [area, { top: area.scrollTop, left: area.scrollLeft }]));
      const settle = () => this.settle();
      const onScroll = (event: Event) => {
        const area = event.target as HTMLElement, saved = positions.get(area);
        if (saved && saved.top === area.scrollTop && saved.left === area.scrollLeft) return;
        settle();
      };
      root.addEventListener("pointerdown", settle, { capture: true, passive: true });
      root.addEventListener("wheel", settle, { capture: true, passive: true });
      root.addEventListener("keydown", settle, true);
      root.addEventListener("scroll", onScroll, { capture: true, passive: true });
      this.removeInputListeners = () => {
        root.removeEventListener("pointerdown", settle, true);
        root.removeEventListener("wheel", settle, true);
        root.removeEventListener("keydown", settle, true);
        root.removeEventListener("scroll", onScroll, true);
      };
    }
    return true;
  }

  /** An internal pivot takes ownership without snapping its moving parent. */
  settle(scope?: "collection-content"): void {
    const nodes = new Set(this.incoming.map(animation => (animation.effect as KeyframeEffect).target as HTMLElement));
    let starts = [...nodes].filter(node => this.host.contains(node)).map(node => ({ node, start: frame(node) }));
    const root = scope === "collection-content" ? this.current() : null;
    const content = root?.matches(".collection-connected") ? root.querySelector<HTMLElement>(".collection-content") : null;
    if (root && content && starts.length) {
      // Transfer inherited transport to the old content before a pivot replaces it.
      // Newly mounted navigation must never inherit the previous page's movement.
      const start = inheritedFrame(content, frame(root), frame(content));
      starts = starts.filter(({ node }) => node !== content && content.contains(node));
      starts.unshift({ node: content, start });
    }
    const restoreAnchoring = this.restoreAnchoring;
    this.restoreAnchoring = null;
    this.stop();
    this.restoreAnchoring = restoreAnchoring;
    if (!starts.length) { this.restoreAnchoring?.(); this.restoreAnchoring = null; }
    for (const { node, start } of starts) {
      const animation = node.animate([start, { transform: "none", opacity: 1 }], { duration: MOTION_DURATIONS.press, easing, fill: "backwards" });
      this.incoming.push(animation);
      animation.onfinish = () => {
        animation.onfinish = null; animation.cancel(); this.incoming = this.incoming.filter(item => item !== animation);
        if (!this.incoming.length) { this.restoreAnchoring?.(); this.restoreAnchoring = null; }
      };
    }
  }

  stop(): void {
    this.restoreAnchoring?.();
    this.restoreAnchoring = null;
    this.removeInputListeners?.();
    this.removeInputListeners = null;
    for (const animation of this.incoming) { animation.onfinish = null; animation.cancel(); }
    this.incoming = [];
    if (this.outgoing) {
      this.outgoing.animation.onfinish = null;
      this.outgoing.animation.cancel();
      this.outgoing.layer.remove();
      this.outgoing = null;
    }
    this.plan = null;
    this.source = null;
    this.returning = null;
    this.returningPane = null;
    this.returningContent = null;
    this.sourceContent = null;
  }
}
