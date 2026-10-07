import { useLayoutEffect, useRef, type RefObject } from "react";
import { browseSurface, browseContentPending, playBrowseTransition } from "../motion/browseTransition";
import { useReducedMotion } from "../motion/useReducedMotion";

/** Music and podcasts share timing, interruption and reduced-motion ownership. */
export function useBrowseEntrance(root: RefObject<HTMLElement>, key: string | number, direction: -1 | 0 | 1, enabled = true) {
  const reduced = useReducedMotion();
  const latest = useRef({ reduced, direction, enabled });
  latest.current = { reduced, direction, enabled };
  const running = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const plan = latest.current;
    if (!root.current || !plan.direction || !plan.enabled || plan.reduced) return;
    let observer: MutationObserver | null = null;
    const start = () => {
      if (latest.current.reduced || !latest.current.enabled) return true;
      const node = root.current;
      if (!node || node.matches(".podcast-page,.collection-connected") && !browseSurface(node) || browseContentPending(node)) return false;
      running.current = playBrowseTransition(node, plan.direction as -1 | 1);
      return true;
    };
    if (!start()) {
      observer = new MutationObserver(() => { if (start()) observer?.disconnect(); });
      observer.observe(root.current, { childList: true, subtree: true });
      running.current = () => observer?.disconnect();
    }
    return () => { observer?.disconnect(); running.current?.(); running.current = null; };
  }, [root, key]);
  useLayoutEffect(() => { if (reduced || !enabled) running.current?.(); }, [reduced, enabled]);
}

/** A changed panel moves while its persistent heading and tabs stay put. */
export function useBrowsePanelMotion(root: RefObject<HTMLElement>, key: string, order?: readonly string[], enabled = true) {
  const previous = useRef(key);
  const direction = previous.current === key ? 0 : order && order.indexOf(key) < order.indexOf(previous.current) ? -1 : 1;
  useBrowseEntrance(root, key, direction, enabled);
  useLayoutEffect(() => { previous.current = key; }, [key]);
}
