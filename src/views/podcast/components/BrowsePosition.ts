import { useLayoutEffect, useRef } from "react";
const positions = new Map<string, { top: number; episode: string | null }>();
export function usePodcastBrowsePosition(key: string) {
  const page = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const root = page.current;
    if (!root) return;
    const saved = positions.get(key);
    let restoring = Boolean(saved);
    let restoringFocus = false;
    let episode = saved?.episode ?? null;
    const observer = new MutationObserver(restore);
    function restore() {
      if (!root || !saved || !restoring) return;
      root.scrollTop = saved.top;
      const target = saved.episode ? Array.from(root.querySelectorAll<HTMLElement>("[data-podcast-episode]")).find(el => el.dataset.podcastEpisode === saved.episode)?.querySelector<HTMLButtonElement>(".podcast-episode-open") : null;
      if (target) { restoringFocus = true; target.focus({ preventScroll: true }); restoringFocus = false; }
      if (root.scrollHeight - root.clientHeight >= saved.top && (!saved.episode || target)) { restoring = false; observer.disconnect(); }
    }
    function takeControl() { restoring = false; observer.disconnect(); }
    function focus(event: FocusEvent) { if (!restoringFocus) takeControl(); const target = event.target; if (target instanceof Element) episode = target.closest<HTMLElement>("[data-podcast-episode]")?.dataset.podcastEpisode ?? episode; }
    root.addEventListener("wheel", takeControl, { passive: true });
    root.addEventListener("pointerdown", takeControl);
    root.addEventListener("keydown", takeControl);
    root.addEventListener("focusin", focus);
    observer.observe(root, { childList: true, subtree: true });
    restore();
    return () => {
      positions.set(key, { top: restoring && saved ? saved.top : root.scrollTop, episode });
      while (positions.size > 100) positions.delete(positions.keys().next().value!);
      observer.disconnect();
      root.removeEventListener("wheel", takeControl); root.removeEventListener("pointerdown", takeControl); root.removeEventListener("keydown", takeControl); root.removeEventListener("focusin", focus);
    };
  }, [key]);
  return page;
}
