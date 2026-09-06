import { useEffect } from "react";

type HotkeyHandlers = {
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onVolumeUp: () => void;
  onVolumeDown: () => void;
  onSeekLeft?: () => void;
  onSeekRight?: () => void;
  onDislikeSmartDj?: () => void;
};

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("[contenteditable=true], input, textarea, select, [role='textbox']"));
}

export function useAppHotkeys(handlers: HotkeyHandlers, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.isComposing) return;
      if (isEditableTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest(
        'button, a[href], summary, [role="button"], [role^="menuitem"], [role="slider"], [role="tab"], [role="checkbox"], [role="radio"]',
      )) return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      const key = event.key;
      if (key === " " || key === "Spacebar" || key.toLowerCase() === "k") {
        event.preventDefault();
        handlers.onTogglePlay();
        return;
      }
      if (key.toLowerCase() === "j" || key === "ArrowLeft" && event.shiftKey) {
        event.preventDefault();
        handlers.onPrevious();
        return;
      }
      if (key.toLowerCase() === "l" || key === "ArrowRight" && event.shiftKey) {
        event.preventDefault();
        handlers.onNext();
        return;
      }
      if (key === "ArrowUp") {
        event.preventDefault();
        handlers.onVolumeUp();
        return;
      }
      if (key === "ArrowDown") {
        event.preventDefault();
        handlers.onVolumeDown();
        return;
      }
      if (key === "ArrowLeft") {
        handlers.onSeekLeft?.();
        return;
      }
      if (key === "ArrowRight") {
        handlers.onSeekRight?.();
        return;
      }
      if (key.toLowerCase() === "d") {
        handlers.onDislikeSmartDj?.();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, handlers]);
}
