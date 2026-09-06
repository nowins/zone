import { useEffect, useRef, type RefObject } from "react";

export function useModalFocus(ref: RefObject<HTMLElement | null>) {
  const returnFocusRef = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const dialog: HTMLElement = element;
    const previous = returnFocusRef.current;
    const isolated: HTMLElement[] = [];
    let branch: HTMLElement = dialog;
    while (branch.parentElement) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (sibling instanceof HTMLElement && sibling !== branch && !sibling.hasAttribute("inert")) {
          sibling.setAttribute("inert", "");
          isolated.push(sibling);
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]',
    )).filter(element => !element.matches(':disabled, [tabindex="-1"]')
      && !element.closest('[hidden], [inert], [aria-hidden="true"]')
      && getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden");
    const focusFirst = () => (focusable()[0] ?? dialog).focus();
    if (!dialog.contains(document.activeElement)) focusFirst();
    const isTop = () => {
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      return dialogs[dialogs.length - 1] === dialog;
    };
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Tab" || !isTop()) return;
      const items = focusable();
      const first = items[0] ?? dialog;
      const last = items[items.length - 1] ?? dialog;
      if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)
        || (!event.shiftKey && document.activeElement === last) || items.length === 0) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
    function onFocus(event: FocusEvent) {
      if (isTop() && !dialog.contains(event.target as Node)) focusFirst();
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      isolated.forEach(element => element.removeAttribute("inert"));
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
    };
  }, [ref]);
}
