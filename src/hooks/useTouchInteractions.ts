import { useEffect, type RefObject } from "react";
import { installTouchInteractions } from "../utils/touchInteractions.js";

export function useTouchInteractions(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (root) return installTouchInteractions(root);
  }, [rootRef]);
}
