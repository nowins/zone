import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Empty, correctly sized anchors preserve layout; only the viewport mounts controls/covers. */
export function useCollectionItemWindow(area: RefObject<HTMLDivElement>, keys: string[], savedAnchor?: string,
  savedFocus?: string, budget = 24) {
  const enabled = keys.length > budget * 2 && typeof IntersectionObserver !== "undefined";
  const signature = keys.join("\u001f");
  const seed = () => {
    const anchor = Math.max(0, keys.indexOf(savedAnchor || ""));
    return new Set(keys.slice(Math.max(0, anchor - budget), anchor + budget));
  };
  const [visible, setVisible] = useState(seed);
  const pendingFocus = useRef<string>();
  useLayoutEffect(() => {
    if (!enabled || !area.current) return;
    const initial = seed();
    setVisible(previous => previous.size === initial.size && [...previous].every(key => initial.has(key)) ? previous : initial);
    const inView = new Set<string>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.collectionWindowItem!;
        if (entry.isIntersecting) inView.add(key); else inView.delete(key);
      }
      const next = new Set(inView);
      const focused = document.activeElement?.closest<HTMLElement>("[data-collection-window-item]");
      if (focused && area.current?.contains(focused)) next.add(focused.dataset.collectionWindowItem!);
      setVisible(previous => previous.size === next.size && [...previous].every(key => next.has(key)) ? previous : next);
    }, { root: area.current, rootMargin: "200px 0px" });
    area.current.querySelectorAll("[data-collection-window-item]").forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [enabled, signature]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const target = [...(area.current?.querySelectorAll<HTMLElement>("[data-collection-focus]") || [])]
      .find(node => node.dataset.collectionFocus === pendingFocus.current);
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = undefined; }
  });
  const reveal = (key: string, focus: string) => {
    pendingFocus.current = focus;
    setVisible(previous => new Set([...previous, key]));
    const anchor = [...(area.current?.querySelectorAll<HTMLElement>("[data-collection-window-item]") || [])]
      .find(node => node.dataset.collectionWindowItem === key);
    anchor?.scrollIntoView({ block: "nearest" });
  };
  return { has: (key: string, focus?: string) => !enabled || visible.has(key) || Boolean(savedFocus && focus && savedFocus.startsWith(focus)), reveal };
}
