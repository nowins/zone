import { TILE_MOTION } from "../motion/tokens.js";

const MOVE_TOLERANCE = 8;
const SCROLL_SETTLE_MS = 150;
const COMPATIBILITY_CLICK_MS = 1000;
const ROW_ACTIONS = ".collection-track-actions,.album-play,.podcast-episode-actions,.podcast-continue-controls,.podcast-queue-actions,.podcast-queue-select-control,.podcast-queue-drag,.podcast-play-action";
const MENU_EXCLUSIONS = `input,select,textarea,[contenteditable],[aria-haspopup],.quick-pin,${ROW_ACTIONS}`;

type TouchSession = {
  id: number;
  target: Element;
  menuTarget: Element | null;
  x: number;
  y: number;
  invalid: boolean;
  menuOpened: boolean;
  timer: number | null;
};

/** Share touch arbitration without changing layout or taking native scrolling. */
export function installTouchInteractions(root: HTMLElement) {
  const doc = root.ownerDocument;
  const view = doc.defaultView!;
  const scrolling = new WeakMap<Element, number>();
  const pointers = new Set<number>();
  let session: TouchSession | null = null;
  let blockedUntil = 0;
  let dispatchingMenu = false;

  function clearHold() {
    if (session?.timer !== null && session?.timer !== undefined) view.clearTimeout(session.timer);
    if (session) session.timer = null;
  }
  function invalidate() {
    clearHold();
    if (session) session.invalid = true;
    blockedUntil = view.performance.now() + COMPATIBILITY_CLICK_MS;
  }
  function recentScroll(target: Element) {
    const now = view.performance.now();
    for (let node: Element | null = target; node; node = node.parentElement) {
      const at = scrolling.get(node);
      if (at !== undefined && now - at < SCROLL_SETTLE_MS) return true;
      if (node === root) break;
    }
    return false;
  }
  function pointerDown(event: PointerEvent) {
    if (event.pointerType !== "touch") {
      clearHold(); session = null; blockedUntil = 0;
      return;
    }
    const target = event.target instanceof view.Element ? event.target : null;
    pointers.add(event.pointerId);
    if (!event.isPrimary || pointers.size > 1) { invalidate(); return; }
    if (!target || !root.contains(target)) { clearHold(); session = null; blockedUntil = 0; return; }
    clearHold();
    blockedUntil = 0;
    session = { id: event.pointerId, target, menuTarget: target.closest(MENU_EXCLUSIONS) ? null : target.closest("[data-touch-menu]"),
      x: event.clientX, y: event.clientY, invalid: false, menuOpened: false, timer: null };
    if (recentScroll(target)) { invalidate(); return; }
    if (!session.menuTarget) return;
    const current = session;
    current.timer = view.setTimeout(() => {
      current.timer = null;
      if (session !== current || current.invalid || !current.target.isConnected || !root.contains(current.target)) return;
      current.menuOpened = true;
      invalidate();
      // Existing React context-menu handlers retain entity and queue semantics.
      dispatchingMenu = true;
      try {
        current.target.dispatchEvent(new view.MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, button: 2, clientX: current.x, clientY: current.y,
        }));
      } finally { dispatchingMenu = false; }
    }, TILE_MOTION.longPress);
  }
  function pointerMove(event: PointerEvent) {
    if (event.pointerId === session?.id && Math.hypot(event.clientX - session.x, event.clientY - session.y) >= MOVE_TOLERANCE) invalidate();
  }
  function pointerEnd(event: PointerEvent) {
    if (event.pointerType !== "touch") return;
    pointers.delete(event.pointerId);
    if (event.pointerId !== session?.id) return;
    if (event.type === "pointercancel") invalidate();
    else pointerMove(event);
    clearHold();
    if (session.invalid) blockedUntil = view.performance.now() + COMPATIBILITY_CLICK_MS;
  }
  function onScroll(event: Event) {
    const target = event.target instanceof view.Element ? event.target : null;
    if (!target || !root.contains(target)) return;
    scrolling.set(target, view.performance.now());
    if (session && pointers.has(session.id) && target.contains(session.target)) invalidate();
  }
  function onClick(event: MouseEvent) {
    const pointer = event as PointerEvent;
    // Keyboard/assistive activation stays available after a cancelled gesture.
    if (event.detail === 0 && pointer.pointerType !== "touch") return;
    if (view.performance.now() >= blockedUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function contextMenu(event: MouseEvent) {
    if (dispatchingMenu || !session || (view.performance.now() >= blockedUntil && !pointers.has(session.id))) return;
    const target = event.target instanceof view.Element ? event.target : null;
    if (!target) return;
    if (!session.menuTarget && target.closest(ROW_ACTIONS) && target.closest("[data-touch-menu]")) {
      invalidate(); event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (!session.menuTarget?.contains(target)) return;
    if (session.invalid || session.menuOpened) {
      event.preventDefault(); event.stopImmediatePropagation();
    } else { session.menuOpened = true; invalidate(); }
  }
  function cancel() { if (session) invalidate(); pointers.clear(); }
  function visibility() { if (doc.hidden) cancel(); }
  function keyDown(event: KeyboardEvent) {
    clearHold();
    if (event.key === "Escape") cancel();
    else if (pointers.size === 0) { session = null; blockedUntil = 0; }
  }
  const listeners = [
    ["pointerdown", pointerDown], ["pointermove", pointerMove], ["pointerup", pointerEnd], ["pointercancel", pointerEnd],
    ["scroll", onScroll], ["mousedown", onClick], ["click", onClick], ["dblclick", onClick], ["contextmenu", contextMenu], ["keydown", keyDown],
  ] as const;
  for (const [type, listener] of listeners) doc.addEventListener(type, listener as EventListener, true);
  view.addEventListener("blur", cancel);
  doc.addEventListener("visibilitychange", visibility);
  return () => {
    clearHold();
    for (const [type, listener] of listeners) doc.removeEventListener(type, listener as EventListener, true);
    view.removeEventListener("blur", cancel);
    doc.removeEventListener("visibilitychange", visibility);
  };
}
