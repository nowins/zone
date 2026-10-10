import { computeFlipDelta, registerFlipSource, takeFlipSource } from "./flip.js";
import type { FlipRect, FlipSource } from "./flip.js";
import { MOTION_EASINGS, NOW_PLAYING_MOTION } from "./tokens.js";

export interface CoverFlipHandle {
  cancel(): void;
}

interface Flight extends CoverFlipHandle {
  id: string;
  clone: HTMLCanvasElement;
  attach(target: HTMLElement): void;
}

// Return flights outlive the departing view, but only for one bounded tween.
let activeFlight: Flight | null = null;
let playerCoverRect: FlipRect | null = null;
let pendingReturn: { id: string; until: number } | null = null;
const CLONE_Z_INDEX = "60";

function viewportRect(element: HTMLElement): FlipRect {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

/** Capture the visible cover, including a flight being reversed mid-air. */
export function registerCoverFlipSource(id: string, element: HTMLElement): FlipSource {
  const image = element.querySelector<HTMLImageElement>("img");
  const source: FlipSource = activeFlight?.id === id
    ? { ...viewportRect(activeFlight.clone), image: activeFlight.clone }
    : { ...viewportRect(element), image: image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0 ? image : undefined };
  activeFlight?.cancel();
  pendingReturn = null;
  registerFlipSource(id, source);
  return source;
}

/** Remember the actual bar geometry, including responsive layout changes. */
export function rememberCoverReturnTarget(element: HTMLElement): void {
  playerCoverRect = viewportRect(element);
}

/** Start returning while the old page is still fading, before the bar mounts. */
export function startCoverReturn(id: string, element: HTMLElement): void {
  const source = registerCoverFlipSource(id, element);
  if (!source.image || !playerCoverRect) return;
  takeFlipSource(id);
  pendingReturn = { id, until: performance.now() + 1000 };
  startFlight(id, source, playerCoverRect, "exit", element);
}

/** Bind the returning clone to the newly mounted bar; never restart its trip. */
export function attachCoverReturn(id: string, target: HTMLElement): boolean {
  if (!pendingReturn) return false;
  if (pendingReturn.id !== id) {
    // The bar mounted a new track while the old cover was returning.
    if (activeFlight?.id === pendingReturn.id) { activeFlight.cancel(); pendingReturn = null; }
    return false;
  }
  const fresh = pendingReturn.until >= performance.now();
  pendingReturn = null;
  if (!fresh) return false;
  if (activeFlight?.id === id) activeFlight.attach(target);
  return true;
}

/** A decoded source is required; missing artwork uses the normal page reveal. */
export function playCoverFlip({ id, source, target, direction = "enter" }: {
  id: string;
  source: FlipSource;
  target: HTMLElement;
  direction?: "enter" | "exit";
}): CoverFlipHandle | null {
  return startFlight(id, source, target, direction);
}

function startFlight(id: string, source: FlipSource, destination: HTMLElement | FlipRect,
  direction: "enter" | "exit", outgoing?: HTMLElement): Flight | null {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const image = source.image;
  if (!image) return null;
  const imageWidth = "naturalWidth" in image ? image.complete ? image.naturalWidth : 0 : image.width;
  const imageHeight = "naturalHeight" in image ? image.naturalHeight : image.height;
  if (media.matches || document.hidden || imageWidth <= 0 || imageHeight <= 0 ||
    source.width <= 0 || source.height <= 0) return null;
  activeFlight?.cancel();
  let target = "getBoundingClientRect" in destination ? destination : null;
  let dock = target ? viewportRect(target) : destination as FlipRect;
  if (dock.width <= 0 || dock.height <= 0) return null;

  // Paint the image that is already on screen. Re-decoding a new img after
  // navigation created a visible stationary pause, even with a warm cache.
  const clone = document.createElement("canvas");
  const context = clone.getContext("2d");
  if (!context) return null;
  clone.width = clone.height = Math.min(512, imageWidth);
  const crop = Math.min(imageWidth, imageHeight);
  context.drawImage(image, (imageWidth - crop) / 2,
    (imageHeight - crop) / 2, crop, crop, 0, 0, clone.width, clone.height);
  clone.setAttribute("aria-hidden", "true");
  clone.dataset.coverFlight = direction;
  const { style } = clone;
  style.position = "fixed";
  style.left = `${source.x}px`;
  style.top = `${source.y}px`;
  style.width = `${source.width}px`;
  style.height = `${source.height}px`;
  style.pointerEvents = "none";
  style.zIndex = CLONE_Z_INDEX;
  style.transformOrigin = "center";
  style.willChange = "transform";
  style.borderRadius = target ? getComputedStyle(target).borderRadius : "0";
  document.body.appendChild(clone);

  const hidden = new Map<HTMLElement, string>();
  const hide = (element: HTMLElement) => {
    if (!hidden.has(element)) hidden.set(element, element.style.visibility);
    element.style.visibility = "hidden";
  };
  if (target) hide(target);
  if (outgoing) hide(outgoing);
  const duration = direction === "enter" ? NOW_PLAYING_MOTION.coverEnter : NOW_PLAYING_MOTION.coverExit;
  const startedAt = performance.now();
  const easing = `cubic-bezier(${MOTION_EASINGS.standard.join(",")})`;
  let animation: Animation | null = null;
  let reveal: Animation | null = null;
  let finished = false;
  let targetObserver: MutationObserver | null = null;

  function watchTarget(element: HTMLElement) {
    targetObserver?.disconnect();
    if (typeof MutationObserver === "undefined") return;
    const artwork = () => element.querySelector("img")?.getAttribute("src") ?? null;
    let captured = artwork();
    targetObserver = new MutationObserver(() => {
      const current = artwork();
      // Initial decode/controlled-protocol mounting may add the same cover.
      // Once present, a replacement belongs to a different handoff.
      if (captured && captured !== current) finish();
      else captured = current;
    });
    targetObserver.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset"] });
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (animation) { animation.onfinish = null; animation.cancel(); }
    if (reveal) { reveal.onfinish = null; reveal.cancel(); }
    targetObserver?.disconnect();
    clone.remove();
    hidden.forEach((visibility, element) => { element.style.visibility = visibility; });
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", finish);
    media.removeEventListener("change", finish);
    if (activeFlight === flight) activeFlight = null;
  }

  function onVisibility() { if (document.hidden) finish(); }

  function land() {
    if (finished) return;
    if (direction === "enter" && target?.isConnected) {
      // Only the outline fades in at the endpoint; the opaque clone keeps
      // the artwork continuous until its real image has taken over.
      target.style.visibility = hidden.get(target) ?? "";
      reveal = target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: NOW_PLAYING_MOTION.coverHandoff });
      reveal.onfinish = finish;
    } else finish();
  }

  function transform(rect: FlipRect) {
    const delta = computeFlipDelta(rect, source);
    return `translate3d(${delta.dx}px, ${delta.dy}px, 0) scale(${delta.scaleX}, ${delta.scaleY})`;
  }

  function fly(from: FlipRect, remaining: number) {
    if (animation) { animation.onfinish = null; animation.cancel(); }
    animation = clone.animate([{ transform: transform(from) }, { transform: transform(dock) }],
      { duration: remaining, easing, fill: "forwards" });
    animation.onfinish = land;
  }

  const flight: Flight = {
    id, clone, cancel: finish,
    attach(element) {
      if (finished) return;
      target = element;
      hide(element);
      watchTarget(element);
      const actual = viewportRect(element);
      // Usually identical. Correct once if the returning page reflows; do
      // not chase layout or paint a blur on every animation frame.
      if (Math.max(Math.abs(actual.x - dock.x), Math.abs(actual.y - dock.y),
        Math.abs(actual.width - dock.width), Math.abs(actual.height - dock.height)) > 0.5) {
        const current = viewportRect(clone);
        dock = actual;
        fly(current, Math.max(1, duration - (performance.now() - startedAt)));
      }
    },
  };
  activeFlight = flight;
  if (target) watchTarget(target);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", finish);
  media.addEventListener("change", finish);
  fly(source, duration);
  return flight;
}
