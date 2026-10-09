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

/** Pointer capture keeps reordering inside the app, including in WebView2. */
export function usePinDrag(gridRef: RefObject<HTMLElement | null>, callbacks: {
  onStart: (id: string) => void;
  onMove: (x: number, y: number, offset: { x: number; y: number }) => void;
  onEnd: (commit: boolean) => void;
  ghostClassName?: string;
}) {
  const session = useRef<DragSession | null>(null);
  const latest = useRef(callbacks);
  latest.current = callbacks;

  function end(commit: boolean) {
    const drag = session.current;
    session.current = null;
    if (!drag) return;
    drag.ghost?.remove();
    const grid = gridRef.current;
    if (grid?.hasPointerCapture?.(drag.pointerId)) grid.releasePointerCapture(drag.pointerId);
    if (drag.ghost) latest.current.onEnd(commit);
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
      document.body.append(ghost);
      drag.ghost = ghost;
      latest.current.onStart(drag.id);
    }
    // Direct manipulation follows the pointer without a React render per frame.
    drag.ghost.style.transform = `translate3d(${event.clientX - drag.offsetX}px, ${event.clientY - drag.offsetY}px, 0)`;
    latest.current.onMove(event.clientX, event.clientY, { x: drag.offsetX, y: drag.offsetY });
  }

  function release(event: PointerEvent<HTMLElement>) {
    if (session.current?.pointerId !== event.pointerId) return;
    if (session.current.ghost) latest.current.onMove(event.clientX, event.clientY, { x: session.current.offsetX, y: session.current.offsetY });
    const grid = gridRef.current?.getBoundingClientRect();
    const viewport = gridRef.current?.closest(".quickplay-viewport")?.getBoundingClientRect();
    const within = (rect?: DOMRect) => !rect || (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    end(Boolean(grid) && within(grid) && within(viewport));
  }

  return { begin, move, release, cancel: () => end(false) };
}
