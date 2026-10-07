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
  const layer = document.createElement("div");
  layer.className = "motion-departure";
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
  (node.closest(".shell") ?? node.ownerDocument.body).append(layer);
  const scrollSelector = "[data-collection-scroll],.quickplay-viewport,.quick-section-scroll,.settings-main,.podcast-content,.now-queue-list";
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
