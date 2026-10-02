import { useEffect, useState, type RefObject } from "react";
import { isDocumentVisible, WINDOW_VISIBILITY_EVENT } from "../../utils/visualizerBus";

/** Ambient work belongs only to visible tiles that the user is not handling. */
export function useTileActivity(ref: RefObject<HTMLElement | null>, ownerKey?: unknown) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const element = ref.current?.closest<HTMLElement>(".tile") ?? ref.current;
    if (!element) return;
    let visible = typeof IntersectionObserver === "undefined";
    let hovered = element.matches(":hover");
    let focused = element.contains(document.activeElement);
    const update = () => setActive(visible && isDocumentVisible() && !hovered && !focused);
    const enter = () => { hovered = true; update(); };
    const leave = () => { hovered = false; update(); };
    const focus = () => { focused = true; update(); };
    const blur = (event: FocusEvent) => {
      focused = element.contains(event.relatedTarget as Node | null);
      update();
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      update();
    });
    observer?.observe(element);
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("focusin", focus);
    element.addEventListener("focusout", blur);
    document.addEventListener("visibilitychange", update);
    document.addEventListener(WINDOW_VISIBILITY_EVENT, update);
    update();
    return () => {
      observer?.disconnect();
      element.removeEventListener("pointerenter", enter);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("focusin", focus);
      element.removeEventListener("focusout", blur);
      document.removeEventListener("visibilitychange", update);
      document.removeEventListener(WINDOW_VISIBILITY_EVENT, update);
    };
  }, [ref, ownerKey]);
  return active;
}
