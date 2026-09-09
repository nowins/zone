import { useEffect, useRef, type RefObject } from "react";

const isolationOwners = new WeakMap<HTMLElement, { count: number; wasInert: boolean }>();
const returnTargets = new WeakMap<HTMLElement, HTMLElement[]>();

export function useModalFocus(ref: RefObject<HTMLElement | null>) {
  const active = document.activeElement as HTMLElement | null;
  const parentDialog = active?.closest<HTMLElement>('[aria-modal="true"]');
  const returnFocusRef = useRef<HTMLElement[]>([
    ...(active ? [active] : []), ...(parentDialog ? returnTargets.get(parentDialog) || [] : []),
  ]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const dialog: HTMLElement = element;
    returnTargets.set(dialog, returnFocusRef.current);
    const isolated: HTMLElement[] = [];
    let branch: HTMLElement = dialog;
    while (branch.parentElement) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (sibling instanceof HTMLElement && sibling !== branch) {
          const owner = isolationOwners.get(sibling) || { count: 0, wasInert: sibling.hasAttribute("inert") };
          owner.count += 1;
          isolationOwners.set(sibling, owner);
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
      isolated.forEach(element => {
        const owner = isolationOwners.get(element);
        if (!owner || --owner.count > 0) return;
        if (!owner.wasInert) element.removeAttribute("inert");
        isolationOwners.delete(element);
      });
      returnTargets.delete(dialog);
      returnFocusRef.current.find(element => element.isConnected && !element.closest("[inert]"))?.focus();
    };
  }, [ref]);
}
