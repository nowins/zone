import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { SCROLL_FRAME_EVENT } from "../motion/wheelScroll";

/** Keep the live song DOM bounded while retaining the entire ordered playback source. */
export function useCollectionRows(scroller: RefObject<HTMLDivElement>, count: number, enabled: boolean,
  rowHeight: number, savedTop = 0, rowSelector = ".collection-track-row", rowGap = 0) {
  const virtual = enabled && count > 80;
  const [viewport, setViewport] = useState(() => ({ top: savedTop, height: 560, stride: rowHeight }));
  const pendingFocus = useRef<string>();
  const initializedArea = useRef<HTMLDivElement | null>(null);
  const currentViewport = useRef(viewport);
  const lastStart = Math.max(0, count - Math.ceil(viewport.height / viewport.stride));
  const start = virtual ? Math.max(0, Math.min(lastStart, Math.floor(viewport.top / viewport.stride) - 3)) : 0;
  const end = virtual ? Math.min(count, Math.max(start, Math.ceil((viewport.top + viewport.height) / viewport.stride) + 3)) : count;
  const rendered = useRef({ start, end, stride: viewport.stride });
  rendered.current = { start, end, stride: viewport.stride };
  const read = (synchronous = false, measure = false) => {
    const area = scroller.current;
    if (!area) return;
    // offsetHeight rounds fractional CSS pixels and accumulates errors at zoom.
    const measured = measure ? area.querySelector<HTMLElement>(rowSelector)?.getBoundingClientRect().height : 0;
    const stride = measured ? measured + rowGap : currentViewport.current.stride || rowHeight;
    const next = { top: area.scrollTop, height: area.clientHeight || 560, stride };
    currentViewport.current = next;
    const first = Math.max(0, Math.min(Math.max(0, count - Math.ceil(next.height / stride)), Math.floor(next.top / stride) - 3));
    const last = Math.min(count, Math.max(first, Math.ceil((next.top + next.height) / stride) + 3));
    if (rendered.current.start === first && rendered.current.end === last && rendered.current.stride === stride) return;
    // Scroll is continuous-priority in React; delaying this commit exposes spacers.
    if (synchronous) flushSync(() => setViewport(next));
    else setViewport(next);
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
    read(false, true);
    const scroll = () => read(true);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => read(true, true));
    resize?.observe(area);
    area.addEventListener("scroll", scroll, { passive: true });
    area.addEventListener(SCROLL_FRAME_EVENT, scroll);
    return () => { resize?.disconnect(); area.removeEventListener("scroll", scroll); area.removeEventListener(SCROLL_FRAME_EVENT, scroll); };
  }, [virtual, count, rowHeight, rowSelector, rowGap]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const target = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-collection-focus]") || [])]
      .find(node => node.dataset.collectionFocus === pendingFocus.current);
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = undefined; }
  });
  const scrollToIndex = (index: number) => {
    const area = scroller.current;
    if (!area) return;
    const { stride, height } = currentViewport.current;
    const top = index * stride, bottom = top + stride;
    if (top < area.scrollTop) area.scrollTop = top;
    else if (bottom > area.scrollTop + height) area.scrollTop = bottom - height;
    read();
  };
  const reveal = (index: number, focusKey: string) => {
    const area = scroller.current;
    if (!area) return;
    const target = [...area.querySelectorAll<HTMLElement>("[data-collection-focus]")]
      .find(node => node.dataset.collectionFocus === focusKey);
    if (!virtual) { target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "nearest" }); return; }
    pendingFocus.current = focusKey;
    scrollToIndex(index);
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = undefined; }
  };
  return { virtual, start, end, stride: viewport.stride, top: start * viewport.stride, bottom: (count - end) * viewport.stride, reveal, scrollToIndex,
    reset: () => { if (scroller.current) scroller.current.scrollTop = 0; read(); } };
}
