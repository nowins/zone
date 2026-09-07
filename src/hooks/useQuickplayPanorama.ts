import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { animateValue, type AnimationHandle } from "../motion/animate";
import { PANORAMA_MOTION, SPRING_PRESETS } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";
import { clampPanorama, panoramaDepth, panoramaStatus, panoramaStep, panoramaWheel, type PanoramaMetric, type PanoramaSection, type PanoramaStatus } from "../utils/quickplayPanorama";

let savedScrollLeft = 0;
const INITIAL: PanoramaStatus = { activeId: "pins", previous: false, next: false, overflow: false };

export function useQuickplayPanorama(enabled: boolean, sections: PanoramaSection[]) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const metrics = useRef<PanoramaMetric[]>([]);
  const motion = useRef<{ handle: AnimationHandle | null; target: number }>({ handle: null, target: 0 });
  const preferred = useRef<string | null>(null);
  const restored = useRef(false);
  const statusRef = useRef(INITIAL);
  const [status, setStatus] = useState(INITIAL);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; left: number; lastX: number; time: number; velocity: number; moving: boolean } | null>(null);
  const reducedMotion = useReducedMotion();
  const sectionKey = sections.map(section => section.id).join("|");

  function stop() {
    motion.current.handle?.cancel();
    motion.current.handle = null;
  }
  function sync() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const left = viewport.scrollLeft;
    savedScrollLeft = left;
    const depth = panoramaDepth(left, reducedMotion);
    if (titleRef.current) titleRef.current.style.transform = `translate3d(${depth.title}px, 0, 0)`;
    if (backdropRef.current) backdropRef.current.style.transform = `translate3d(${depth.backdrop}px, 0, 0)`;
    const next = panoramaStatus(left, viewport.clientWidth, viewport.scrollWidth - viewport.clientWidth, metrics.current, preferred.current);
    const previous = statusRef.current;
    // React only receives a section/boundary change, never frame positions.
    if (next.activeId !== previous.activeId || next.previous !== previous.previous || next.next !== previous.next || next.overflow !== previous.overflow) {
      statusRef.current = next;
      setStatus(next);
    }
  }
  function measure() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    metrics.current = Array.from(viewport.querySelectorAll<HTMLElement>("[data-panorama-section]")).map(element => {
      const rect = element.getBoundingClientRect();
      return { id: element.dataset.panoramaSection!, left: rect.left - bounds.left + viewport.scrollLeft, width: rect.width };
    });
    const max = viewport.scrollWidth - viewport.clientWidth;
    viewport.scrollLeft = clampPanorama(restored.current ? viewport.scrollLeft : savedScrollLeft, max);
    restored.current = true;
    if (motion.current.handle) {
      motion.current.target = clampPanorama(motion.current.target, max);
      motion.current.handle.retarget(motion.current.target);
    }
    sync();
  }
  function panTo(left: number, smooth: boolean) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const target = clampPanorama(left, viewport.scrollWidth - viewport.clientWidth);
    motion.current.target = target;
    if (!smooth || reducedMotion) { stop(); viewport.scrollLeft = target; sync(); return; }
    const running = motion.current.handle;
    if (running) running.retarget(target);
    else motion.current.handle = animateValue({ from: viewport.scrollLeft, to: target, spring: SPRING_PRESETS.snappy,
      onUpdate: value => { viewport.scrollLeft = value; sync(); },
      onComplete: () => { motion.current.handle = null; sync(); },
    });
  }
  function goTo(id: string, smooth = true) {
    measure();
    const group = metrics.current.find(metric => metric.id === id);
    if (!group) return;
    preferred.current = id;
    panTo(group.left - (metrics.current[0]?.left ?? 0), smooth);
    sync();
  }
  function step(direction: -1 | 1, smooth = true) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    preferred.current = null;
    const left = motion.current.handle ? motion.current.target : viewport.scrollLeft;
    panTo(panoramaStep(left, direction, viewport.scrollWidth - viewport.clientWidth, metrics.current), smooth);
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport) return;
    stop();
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(viewport);
    if (viewport.firstElementChild) resize.observe(viewport.firstElementChild);
    viewport.querySelectorAll("[data-panorama-section]").forEach(element => resize.observe(element));
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || document.hidden) return;
      const section = event.target instanceof Element ? event.target.closest<HTMLElement>(".quick-section-scroll") : null;
      // Chromium also supplies a coarse legacy delta for tiny horizontal gestures.
      // Only fall back when neither standard axis carries a signal.
      const deltaY = event.deltaX || event.deltaY ? event.deltaY
        : -((event as WheelEvent & { wheelDelta?: number }).wheelDelta ?? 0);
      const intent = panoramaWheel({ deltaX: event.deltaX,
        deltaY,
        deltaMode: event.deltaMode, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, viewportWidth: viewport.clientWidth,
        verticalOverflow: Boolean(section && section.scrollHeight - section.clientHeight > 1),
      });
      if (!intent) return;
      preferred.current = null;
      const base = intent.smooth && motion.current.handle ? motion.current.target : viewport.scrollLeft;
      const target = clampPanorama(base + intent.delta, viewport.scrollWidth - viewport.clientWidth);
      if (target === base) return;
      event.preventDefault();
      panTo(target, intent.smooth);
    };
    const hidden = () => { if (document.hidden) { stop(); cancelDrag(); } };
    // Scope wheel capture to the panorama; portal dialogs and the player own theirs.
    viewport.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", cancelDrag);
    return () => {
      stop();
      cancelDrag();
      resize.disconnect();
      viewport.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", cancelDrag);
    };
  }, [enabled, sectionKey, reducedMotion]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    stop();
    preferred.current = null;
    if (event.key === "Home") panTo(0, false);
    else if (event.key === "End") panTo(Infinity, false);
    else step(event.key === "ArrowLeft" || event.key === "PageUp" ? -1 : 1, false);
  }
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    stop();
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if ((event.target as Element).closest("button, a, input, select, textarea, .quick-pin, .quick-section-scroll, [role='button']")) return;
    const viewport = event.currentTarget;
    if (viewport.scrollWidth <= viewport.clientWidth + 1) return;
    preferred.current = null;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: viewport.scrollLeft,
      lastX: event.clientX, time: event.timeStamp, velocity: 0, moving: false };
    viewport.setPointerCapture(event.pointerId);
    viewport.focus({ preventScroll: true });
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const distance = event.clientX - current.startX;
    if (!current.moving && Math.abs(distance) < 8) return;
    if (!current.moving && Math.abs(event.clientY - current.startY) > Math.abs(distance)) { cancelDrag(); return; }
    current.moving = true;
    event.preventDefault();
    const dt = event.timeStamp - current.time;
    if (dt > 0) current.velocity = Math.max(-2.5, Math.min(2.5, (current.lastX - event.clientX) / dt));
    current.lastX = event.clientX;
    current.time = event.timeStamp;
    event.currentTarget.classList.add("is-panning");
    panTo(current.left - distance, false);
  }
  function cancelDrag() {
    const current = drag.current;
    drag.current = null;
    const viewport = viewportRef.current;
    viewport?.classList.remove("is-panning");
    if (current && viewport?.hasPointerCapture(current.pointerId)) viewport.releasePointerCapture(current.pointerId);
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    cancelDrag();
    if (current.moving && event.timeStamp - current.time < PANORAMA_MOTION.velocityWindow && !reducedMotion) panTo(event.currentTarget.scrollLeft + current.velocity * PANORAMA_MOTION.coastMs, true);
  }

  return { viewportRef, titleRef, backdropRef, status, goTo, step,
    viewportProps: { onScroll: sync, onKeyDown, onPointerDown, onPointerMove, onPointerUp,
      onPointerCancel: cancelDrag, onLostPointerCapture: cancelDrag, onFocusCapture: stop },
  };
}
