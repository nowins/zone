import { useLayoutEffect, useRef, type RefObject } from "react";
import type { CollectionHistory } from "../utils/collectionNavigation";
import { collectionPivotDirection, playCollectionPivot } from "../motion/collectionPivot";
import { useReducedMotion } from "../motion/useReducedMotion";

function useCollectionEntrance(root: RefObject<HTMLElement>, key: string | number, direction: -1 | 0 | 1, enabled: boolean) {
  const reduced = useReducedMotion();
  const latest = useRef({ reduced, direction, enabled });
  latest.current = { reduced, direction, enabled };
  const running = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const plan = latest.current;
    if (!root.current || !plan.direction || !plan.enabled || plan.reduced) return;
    const stop = playCollectionPivot(root.current, plan.direction);
    running.current = stop;
    return () => { stop(); running.current = null; };
  }, [root, key]);
  // Enabling reduced motion settles immediately; disabling it must not replay a page.
  useLayoutEffect(() => { if (reduced || !enabled) running.current?.(); }, [reduced, enabled]);
}

export function useCollectionPivot(root: RefObject<HTMLElement>, history: CollectionHistory) {
  useCollectionEntrance(root, history.revision, collectionPivotDirection(history), history.animate);
}

/** Only a changed panel moves; its persistent heading, tabs and scroll owner stay put. */
export function useCollectionPanelMotion(root: RefObject<HTMLElement>, key: string, order?: readonly string[], enabled = true) {
  const previous = useRef(key);
  const direction = previous.current === key ? 0 : order && order.indexOf(key) < order.indexOf(previous.current) ? -1 : 1;
  useCollectionEntrance(root, key, direction, enabled);
  useLayoutEffect(() => { previous.current = key; }, [key]);
}
