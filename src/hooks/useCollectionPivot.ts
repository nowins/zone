import { useLayoutEffect, useRef, type RefObject } from "react";
import type { CollectionHistory } from "../utils/collectionNavigation";
import { collectionPivotDirection, playCollectionPivot } from "../motion/collectionPivot";
import { useReducedMotion } from "../motion/useReducedMotion";

export function useCollectionPivot(root: RefObject<HTMLDivElement>, history: CollectionHistory) {
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const running = useRef<(() => void) | null>(null);
  const direction = collectionPivotDirection(history);
  useLayoutEffect(() => {
    if (!root.current || !direction || reducedRef.current) return;
    const stop = playCollectionPivot(root.current, direction);
    running.current = stop;
    return () => { stop(); running.current = null; };
  }, [root, history.revision, direction]);
  // Enabling reduced motion settles immediately; disabling it must not replay a page.
  useLayoutEffect(() => { if (reduced) running.current?.(); }, [reduced]);
}
