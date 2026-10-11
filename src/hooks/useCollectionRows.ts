import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Keep the live song DOM bounded while retaining the entire ordered playback source. */
export function useCollectionRows(scroller: RefObject<HTMLDivElement>, count: number, enabled: boolean,
  rowHeight: number, savedTop = 0) {
  const virtual = enabled && count > 80;
  const [viewport, setViewport] = useState(() => ({ top: savedTop, height: 560, stride: rowHeight }));
  const pendingFocus = useRef<string>();
  const initializedArea = useRef<HTMLDivElement | null>(null);
  const lastStart = Math.max(0, count - Math.ceil(viewport.height / viewport.stride));
  const start = virtual ? Math.max(0, Math.min(lastStart, Math.floor(viewport.top / viewport.stride) - 3)) : 0;
  const end = virtual ? Math.min(count, Math.max(start, Math.ceil((viewport.top + viewport.height) / viewport.stride) + 3)) : count;
  const read = () => {
    const area = scroller.current;
    if (!area) return;
    const stride = area.querySelector<HTMLElement>(".collection-track-row")?.offsetHeight || rowHeight;
    const next = { top: area.scrollTop, height: area.clientHeight || 560, stride };
    setViewport(previous => previous.top === next.top && previous.height === next.height && previous.stride === next.stride ? previous : next);
  };
  useLayoutEffect(() => {
    const area = scroller.current;
    if (!area) return;
    // Seed the range from history before the parent's scroll/focus restoration.
    if (initializedArea.current !== area) {
      initializedArea.current = area;
      if (virtual) area.scrollTop = savedTop;
    }
    if (!virtual) return;
    read();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    resize?.observe(area);
    area.addEventListener("scroll", read, { passive: true });
    return () => { resize?.disconnect(); area.removeEventListener("scroll", read); };
  }, [virtual]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const target = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-collection-focus]") || [])]
      .find(node => node.dataset.collectionFocus === pendingFocus.current);
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = undefined; }
  });
  const reveal = (index: number, focusKey: string) => {
    const area = scroller.current;
    if (!area) return;
    const target = [...area.querySelectorAll<HTMLElement>("[data-collection-focus]")]
      .find(node => node.dataset.collectionFocus === focusKey);
    if (!virtual) { target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "nearest" }); return; }
    pendingFocus.current = focusKey;
    const top = index * viewport.stride, bottom = top + viewport.stride;
    if (top < area.scrollTop) area.scrollTop = top;
    else if (bottom > area.scrollTop + viewport.height) area.scrollTop = bottom - viewport.height;
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = undefined; }
    read();
  };
  return { virtual, start, end, top: start * viewport.stride, bottom: (count - end) * viewport.stride, reveal,
    reset: () => { if (scroller.current) scroller.current.scrollTop = 0; read(); } };
}
