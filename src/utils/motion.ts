import type { AppPage, ViewMode } from "../types";

export type MotionDirection = "neutral" | "forward" | "backward" | "depth-in" | "depth-out";
export type MotionInput = "system" | "pointer" | "keyboard";

const PAGE_ORDER: Record<Exclude<AppPage, "nowPlaying">, number> = {
  quickplay: 0,
  collection: 1,
  settings: 2,
};

const COLLECTION_ORDER: Record<ViewMode, number> = {
  artists: 0,
  albums: 1,
  songs: 2,
  playlists: 3,
};

export function orderedMotionDirection<T extends string>(
  current: T,
  next: T,
  order: Record<T, number>,
): MotionDirection {
  if (current === next) return "neutral";
  return order[next] > order[current] ? "forward" : "backward";
}

export function pageMotionDirection(current: AppPage, next: AppPage): MotionDirection {
  if (current === next) return "neutral";
  if (next === "nowPlaying") return "depth-in";
  if (current === "nowPlaying") return "depth-out";
  return orderedMotionDirection(
    current as Exclude<AppPage, "nowPlaying">,
    next as Exclude<AppPage, "nowPlaying">,
    PAGE_ORDER,
  );
}

export function collectionMotionDirection(current: ViewMode, next: ViewMode): MotionDirection {
  return orderedMotionDirection(current, next, COLLECTION_ORDER);
}

export function installMetroTilt() {
  if (typeof document === "undefined" || typeof window === "undefined") return () => undefined;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let active:
    | {
        element: HTMLElement;
        pointerId: number;
        transition: string;
        transform: string;
        transformOrigin: string;
        resetTimer: number | null;
      }
    | null = null;

  function restoreActive(immediate = false) {
    if (!active) return;
    const current = active;
    active = null;
    if (current.resetTimer) window.clearTimeout(current.resetTimer);

    if (immediate || reducedMotion.matches) {
      current.element.style.transition = current.transition;
      current.element.style.transform = current.transform;
      current.element.style.transformOrigin = current.transformOrigin;
      return;
    }

    current.element.style.transition = "transform 167ms cubic-bezier(0.23, 1, 0.32, 1)";
    current.element.style.transform = "perspective(760px) rotateX(0deg) rotateY(0deg) scale(1)";
    current.resetTimer = window.setTimeout(() => {
      current.element.style.transition = current.transition;
      current.element.style.transform = current.transform;
      current.element.style.transformOrigin = current.transformOrigin;
    }, 180);
  }

  function handlePointerDown(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || reducedMotion.matches) return;
    const element = (event.target as Element | null)?.closest<HTMLElement>("[data-motion-tilt]");
    if (!element || element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return;

    restoreActive(true);
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const horizontal = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
    const vertical = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));

    active = {
      element,
      pointerId: event.pointerId,
      transition: element.style.transition,
      transform: element.style.transform,
      transformOrigin: element.style.transformOrigin,
      resetTimer: null,
    };
    element.style.transformOrigin = `${((horizontal + 1) / 2) * 100}% ${((vertical + 1) / 2) * 100}%`;
    element.style.transition = "transform 90ms cubic-bezier(0.23, 1, 0.32, 1)";
    element.style.transform = `perspective(760px) rotateX(${(-vertical * 3.2).toFixed(2)}deg) rotateY(${(
      horizontal * 3.2
    ).toFixed(2)}deg) scale(0.985)`;
  }

  function handlePointerEnd(event: PointerEvent) {
    if (!active || active.pointerId !== event.pointerId) return;
    restoreActive();
  }

  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("pointerup", handlePointerEnd, true);
  document.addEventListener("pointercancel", handlePointerEnd, true);

  return () => {
    restoreActive(true);
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("pointerup", handlePointerEnd, true);
    document.removeEventListener("pointercancel", handlePointerEnd, true);
  };
}
