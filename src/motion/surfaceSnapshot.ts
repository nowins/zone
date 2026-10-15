import { NAVIGATION_MOTION } from "./tokens.js";

export type Frame = { transform: string; opacity: string };

export function readSurfaceFrame(node: HTMLElement): Frame {
  const style = node.ownerDocument.defaultView!.getComputedStyle(node);
  return { transform: style.transform || "none", opacity: style.opacity || "1" };
}

export function inheritedFrame(node: HTMLElement, parent: Frame, own: Frame): Frame {
  const offset = (value: Frame) => {
    if (!value.transform || value.transform === "none") return { x: 0, y: 0 };
    const matrix = new node.ownerDocument.defaultView!.DOMMatrixReadOnly(value.transform);
    return { x: matrix.m41, y: matrix.m42 };
  };
  const a = offset(parent), b = offset(own);
  return { transform: `translate3d(${a.x + b.x}px,${a.y + b.y}px,0)`, opacity: `${Number(parent.opacity) * Number(own.opacity)}` };
}

export function surfaceOffset(node: HTMLElement): { x: number; y: number } {
  const transform = readSurfaceFrame(node).transform;
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
  const clips = new Map<Element, DOMRect>();
  const clipSelector = "[data-collection-scroll],.quick-section-scroll,.quickplay-viewport,.podcast-screen,.now-panel-tracks";
  const variableItem = ".quick-group,.quick-pin,.quick-album,.quick-feature,.podcast-content-section,.podcast-episode,.podcast-queue-episode,.podcast-library-show,.podcast-show-card,.podcast-continue-card,.now-panel-upcoming > button";
  const duplicate = (source: HTMLElement): HTMLElement => {
    const clone = source.cloneNode(false) as HTMLElement;
    lookup.set(source, clone);
    if (source.matches(variableItem)) {
      const owner = source.closest(clipSelector);
      if (owner) {
        let clip = clips.get(owner);
        if (!clip) { clip = owner.getBoundingClientRect(); clips.set(owner, clip); }
        const bounds = source.getBoundingClientRect();
        if (bounds.height > 0 && bounds.width > 0 && (bounds.bottom <= Math.max(0, clip.top, rect.top)
          || bounds.top >= Math.min(window.innerHeight, clip.bottom, rect.bottom)
          || bounds.right <= Math.max(0, clip.left, rect.left) || bounds.left >= Math.min(window.innerWidth, clip.right, rect.right))) {
          // Keep variable-height rows and panorama columns in their layout slots,
          // without copying offscreen artwork, controls or media subtrees.
          Object.assign(clone.style, { width: `${bounds.width}px`, height: `${bounds.height}px`, boxSizing: "border-box", flexShrink: "0" });
          return clone;
        }
      }
    }
    if (source.matches(".collection-browse-album-group")) {
      const bounds = source.getBoundingClientRect();
      const clip = source.closest("[data-collection-scroll]")!.getBoundingClientRect();
      if (bounds.height > 0 && (bounds.bottom <= Math.max(0, clip.top) || bounds.top >= Math.min(window.innerHeight, clip.bottom))) {
        clone.style.height = `${bounds.height}px`;
        return clone;
      }
    }
    const grid = source.matches(".collection-album-index") && source.closest(".collection-browse-records");
    const names = source.matches(".collection-browse-index");
    const tracks = source.matches(".collection-track-scroll") && source.firstElementChild?.matches(".collection-track-row");
    const columns = grid ? Math.max(1, window.getComputedStyle(source).gridTemplateColumns.split(/\s+/).filter(value => value.endsWith("px")).length) : 1;
    const first = source.firstElementChild, second = source.children[columns];
    if ((grid || names || tracks) && first && second) {
      // Uniform name/song rows and regular cover grids need two measurements,
      // independent of library size. Padding preserves grid column alignment.
      const firstRect = first.getBoundingClientRect();
      // Staggered row translations are visual offsets, not the layout stride.
      const firstTop = firstRect.top - surfaceOffset(first as HTMLElement).y;
      const stride = second.getBoundingClientRect().top - surfaceOffset(second as HTMLElement).y - firstTop;
      const owner = source.closest("[data-collection-scroll]") ?? source;
      const clip = owner.getBoundingClientRect();
      if (stride > 0) {
        const count = source.children.length, rows = Math.ceil(count / columns);
        const startRow = Math.max(0, Math.min(rows, Math.floor((Math.max(0, clip.top) - firstTop) / stride) - NAVIGATION_MOTION.snapshotOverscanRows));
        const endRow = Math.max(startRow, Math.min(rows, Math.ceil((Math.min(window.innerHeight, clip.bottom) - firstTop) / stride) + NAVIGATION_MOTION.snapshotOverscanRows));
        const start = startRow * columns, end = Math.min(count, endRow * columns);
        const spacer = (height: number) => {
          if (height <= 0) return;
          const gap = document.createElement("div");
          gap.style.height = `${height}px`; gap.style.flexShrink = "0";
          clone.append(gap);
        };
        if (tracks) spacer(startRow * stride);
        else { clone.style.paddingTop = `${startRow * stride}px`; clone.style.paddingBottom = `${(rows - endRow) * stride}px`; }
        for (let index = start; index < end; index++) clone.append(duplicate(source.children[index] as HTMLElement));
        if (tracks) spacer((rows - endRow) * stride);
        return clone;
      }
      if (firstRect.height === 0) return clone;
    }
    for (const child of source.childNodes) {
      // A shell handoff freezes pixels, never a second media session or an
      // older departure that is still being removed by the controller.
      if (child.nodeType === 1 && (child as Element).matches("audio,video,.motion-departure")) continue;
      clone.append(child.nodeType === 1 ? duplicate(child as HTMLElement) : child.cloneNode(true));
    }
    return clone;
  };
  const copy = duplicate(node);
  // Freeze only active animation targets, rather than reading every library row.
  for (const animation of node.getAnimations?.({ subtree: true }) ?? []) {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    const clone = target && lookup.get(target as HTMLElement);
    if (clone) Object.assign(clone.style, readSurfaceFrame(target as HTMLElement));
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
  const surfaceStyle = window.getComputedStyle(node);
  // The background must fade with the animated copy, not its stationary clip.
  copy.style.backgroundColor = surfaceStyle.backgroundColor === "rgba(0, 0, 0, 0)" ? "var(--app-bg)" : surfaceStyle.backgroundColor;
  if (node.matches(".shell")) copy.style.color = surfaceStyle.color;
  const layer = document.createElement("div");
  layer.className = "motion-departure";
  // Departing content keeps its palette when navigation changes the shell.
  const theme = node.closest<HTMLElement>("[data-surface-theme]")?.dataset.surfaceTheme;
  if (theme) layer.dataset.surfaceTheme = theme;
  const collection = node.closest<HTMLElement>(".collection-connected");
  if (collection && collection !== node) {
    layer.classList.add("collection-connected");
    layer.dataset.collectionSurface = collection.dataset.collectionSurface;
  }
  if (node.closest(".podcast-page")) layer.classList.add("podcast-page");
  if (node.closest(".quickplay")) layer.classList.add("quickplay");
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  Object.assign(layer.style, { left: `${rect.left - offset.x}px`, top: `${rect.top - offset.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  layer.append(copy);
  // A complete shell copy keeps the old layout outside the new shell's CSS.
  (node.matches(".shell") ? document.body : node.closest(".shell") ?? document.body).append(layer);
  const scrollSelector = `${clipSelector},.settings-main,.podcast-content,.now-queue-list`;
  for (const source of node.querySelectorAll<HTMLElement>(scrollSelector)) {
    const clone = lookup.get(source);
    if (!clone) continue;
    clone.scrollTop = source.scrollTop;
    clone.scrollLeft = source.scrollLeft;
  }
  copy.scrollTop = node.scrollTop;
  copy.scrollLeft = node.scrollLeft;
  // Root and WAAPI transforms must survive disabling inherited CSS entrances.
  Object.assign(copy.style, readSurfaceFrame(node));
  return { layer, node: copy };
}
