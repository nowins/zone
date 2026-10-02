import { useLayoutEffect, type RefObject } from "react";
import { attachWheelScroll } from "../motion/wheelScroll";
import { useReducedMotion } from "../motion/useReducedMotion";

export function useWheelScroll(root: RefObject<HTMLElement>, selector: string, revision: string | number, enabled = true) {
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    if (!enabled || reduced || !root.current) return;
    return attachWheelScroll(root.current, selector);
  }, [root, selector, revision, enabled, reduced]);
}
