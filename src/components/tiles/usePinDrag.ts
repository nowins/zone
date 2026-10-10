import { useEffect, useRef, type PointerEvent, type RefObject } from "react";

type DragSession = {
  id: string;
  pointerId: number;
  source: HTMLElement;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  ghost: HTMLElement | null;
};

type ReleasePose = { rect: DOMRect; surface: boolean; opacity: number };

/** Pointer capture keeps reordering inside the app, including in WebView2. */
export function usePinDrag(gridRef: RefObject<HTMLElement | null>, callbacks: {
  onStart: (id: string) => void;
  onMove: (x: number, y: number, offset: { x: number; y: number }) => void;
  onEnd: (commit: boolean, release?: ReleasePose) => void;
  ghostClassName?: string;
  surfaceSelector?: string;
}) {
  const session = useRef<DragSession | null>(null);
  const latest = useRef(callbacks);
  latest.current = callbacks;

  function end(commit: boolean) {
    const drag = session.current;
    session.current = null;
    if (!drag) return;
    const surface = latest.current.surfaceSelector ? drag.ghost?.querySelector<HTMLElement>(latest.current.surfaceSelector) : undefined;
    const visualRect = surface?.getBoundingClientRect();
    const isSurface = Boolean(visualRect?.width && visualRect.height);
    // Cancellation returns from the same floating pose as a committed drop.
    const releaseRect = isSurface ? visualRect : drag.ghost?.getBoundingClientRect();
    const opacity = surface ? Number.parseFloat(getComputedStyle(surface).opacity) : 1;
    drag.ghost?.remove();
    const grid = gridRef.current;
    if (grid?.hasPointerCapture?.(drag.pointerId)) grid.releasePointerCapture(drag.pointerId);
    if (drag.ghost) latest.current.onEnd(commit, releaseRect ? { rect: releaseRect, surface: isSurface, opacity: Number.isFinite(opacity) ? opacity : 1 } : undefined);
  }

  useEffect(() => {
    const cancel = () => end(false);
    const escape = (event: globalThis.KeyboardEvent) => {
      if (!session.current || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
      const drag = session.current;
      session.current = null;
      drag?.ghost?.remove();
      if (drag && gridRef.current?.hasPointerCapture?.(drag.pointerId)) gridRef.current.releasePointerCapture(drag.pointerId);
    };
  }, [gridRef]);

  function begin(id: string, source: HTMLElement, pointerId: number, x: number, y: number) {
    if (session.current) return;
    const rect = source.getBoundingClientRect();
    session.current = { id, source, pointerId, x, y, offsetX: x - rect.left, offsetY: y - rect.top, ghost: null };
    gridRef.current?.setPointerCapture?.(pointerId);
  }

  function move(event: PointerEvent<HTMLElement>) {
    const drag = session.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.ghost && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
    event.preventDefault();
    if (!drag.ghost) {
      const rect = drag.source.getBoundingClientRect();
      const ghost = drag.source.cloneNode(true) as HTMLElement;
      ghost.classList.remove("selected", "dragging");
      ghost.classList.add(latest.current.ghostClassName || "quick-pin-drag-ghost");
      ghost.removeAttribute("data-pin-id");
      ghost.removeAttribute("tabindex");
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      ghost.querySelector(".quick-pin-edit-tools")?.remove();
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      if (latest.current.ghostClassName) ghost.style.gridTemplateColumns = getComputedStyle(drag.source).gridTemplateColumns;
      const selector = latest.current.surfaceSelector;
      const sourceSurface = selector ? drag.source.querySelector<HTMLElement>(selector) : null;
      const ghostSurface = selector ? ghost.querySelector<HTMLElement>(selector) : null;
      if (sourceSurface && ghostSurface) {
        const pose = getComputedStyle(sourceSurface);
        ghostSurface.style.transform = pose.transform;
        ghostSurface.style.opacity = pose.opacity;
        ghostSurface.style.transition = pose.transition;
      }
      document.body.append(ghost);
      drag.ghost = ghost;
      if (ghostSurface) {
        // Establish the copied pose before lifting toward the selected pose.
        void getComputedStyle(ghostSurface).transform;
        ghostSurface.style.removeProperty("transform");
        ghostSurface.style.removeProperty("opacity");
      }
      latest.current.onStart(drag.id);
    }
    // Direct manipulation follows the pointer without a React render per frame.
    drag.ghost.style.transform = `translate3d(${event.clientX - drag.offsetX}px, ${event.clientY - drag.offsetY}px, 0)`;
    latest.current.onMove(event.clientX, event.clientY, { x: drag.offsetX, y: drag.offsetY });
  }

  function release(event: PointerEvent<HTMLElement>) {
    if (session.current?.pointerId !== event.pointerId) return;
    if (session.current.ghost) move(event);
    const grid = gridRef.current?.getBoundingClientRect();
    const viewport = gridRef.current?.closest(".quickplay-viewport")?.getBoundingClientRect();
    const within = (rect?: DOMRect) => !rect || (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    end(Boolean(grid) && within(grid) && within(viewport));
  }

  return { begin, move, release, cancel: () => end(false) };
}
