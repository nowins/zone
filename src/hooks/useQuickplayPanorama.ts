import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { animateValue, type AnimationHandle } from "../motion/animate";
import { PANORAMA_MOTION, SPRING_PRESETS } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";
import { useWheelScroll } from "./useWheelScroll";
import { clampPanorama, panoramaDepth, panoramaStep, panoramaWheel, type PanoramaMetric } from "../utils/quickplayPanorama";

let savedScrollLeft = 0;

export function useQuickplayPanorama(enabled: boolean, sectionIds: string[]) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLInputElement>(null);
  const metrics = useRef<PanoramaMetric[]>([]);
  const motion = useRef<{ handle: AnimationHandle | null; target: number }>({ handle: null, target: 0 });
  const restored = useRef(false);
  const lastLeft = useRef(0);
  const overflowRef = useRef(false);
  const [overflow, setOverflow] = useState(false);
  const fadeTimer = useRef<number | null>(null);
  const scrollbarPointer = useRef<number | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; left: number; lastX: number; time: number; velocity: number; moving: boolean } | null>(null);
  const reducedMotion = useReducedMotion();
  const sectionKey = sectionIds.join("|");
  useWheelScroll(viewportRef, ".quick-section-scroll", sectionKey, enabled);

  function clearFadeTimer() {
    if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
    fadeTimer.current = null;
  }
  function revealScrollbar() {
    if (!overflowRef.current || document.hidden) return;
    scrollbarRef.current?.classList.add("is-scrolling");
    clearFadeTimer();
    if (scrollbarPointer.current !== null) return;
    fadeTimer.current = window.setTimeout(() => {
      fadeTimer.current = null;
      scrollbarRef.current?.classList.remove("is-scrolling");
    }, PANORAMA_MOTION.scrollbarIdle);
  }
  function hideScrollbar() {
    clearFadeTimer();
    const pointer = scrollbarPointer.current;
    scrollbarPointer.current = null;
    const scrollbar = scrollbarRef.current;
    if (pointer !== null && scrollbar?.hasPointerCapture(pointer)) scrollbar.releasePointerCapture(pointer);
    scrollbar?.classList.remove("is-scrolling");
  }

  function stop() {
    motion.current.handle?.cancel();
    motion.current.handle = null;
  }
  function sync(reveal = true) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const left = viewport.scrollLeft;
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    savedScrollLeft = left;
    const depth = panoramaDepth(left, reducedMotion);
    if (titleRef.current) titleRef.current.style.transform = `translate3d(${depth.title}px, 0, 0)`;
    if (backdropRef.current) backdropRef.current.style.transform = `translate3d(${depth.backdrop}px, 0, 0)`;
    const canScroll = max > 1;
    // React only receives an overflow change, never frame positions.
    if (canScroll !== overflowRef.current) {
      overflowRef.current = canScroll;
      setOverflow(canScroll);
    }
    const scrollbar = scrollbarRef.current;
    if (scrollbar) scrollbar.value = String(clampPanorama(left, max));
    if (!canScroll) hideScrollbar();
    else if (reveal && Math.abs(left - lastLeft.current) > 0.01) revealScrollbar();
    lastLeft.current = left;
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
    const scrollbar = scrollbarRef.current;
    if (scrollbar) {
      scrollbar.max = String(Math.max(0, max));
      scrollbar.style.setProperty("--panorama-thumb-width", `${Math.max(24, scrollbar.clientWidth * viewport.clientWidth / Math.max(1, viewport.scrollWidth))}px`);
    }
    viewport.scrollLeft = clampPanorama(restored.current ? viewport.scrollLeft : savedScrollLeft, max);
    restored.current = true;
    if (motion.current.handle) {
      motion.current.target = clampPanorama(motion.current.target, max);
      motion.current.handle.retarget(motion.current.target);
    }
    sync(false);
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
  function step(direction: -1 | 1, smooth = true) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const left = motion.current.handle ? motion.current.target : viewport.scrollLeft;
    panTo(panoramaStep(left, direction, viewport.scrollWidth - viewport.clientWidth, metrics.current), smooth);
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport) return;
    const scrollbar = scrollbarRef.current;
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
      const base = intent.smooth && motion.current.handle ? motion.current.target : viewport.scrollLeft;
      const target = clampPanorama(base + intent.delta, viewport.scrollWidth - viewport.clientWidth);
      if (target === base) return;
      event.preventDefault();
      panTo(target, intent.smooth);
    };
    const blur = () => { stop(); cancelDrag(); hideScrollbar(); };
    const hidden = () => { if (document.hidden) blur(); };
    // Scope wheel capture to the panorama; portal dialogs and the player own theirs.
    viewport.addEventListener("wheel", wheel, { passive: false });
    scrollbar?.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", blur);
    return () => {
      stop();
      cancelDrag();
      hideScrollbar();
      resize.disconnect();
      viewport.removeEventListener("wheel", wheel);
      scrollbar?.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", blur);
    };
  }, [enabled, sectionKey, reducedMotion]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    stop();
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

  function onScrollbarInput(event: FormEvent<HTMLInputElement>) {
    panTo(event.currentTarget.valueAsNumber, false);
  }
  function onScrollbarPointerDown(event: PointerEvent<HTMLInputElement>) {
    if (event.button !== 0) return;
    stop();
    scrollbarPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    revealScrollbar();
  }
  function onScrollbarPointerUp() {
    const pointer = scrollbarPointer.current;
    if (pointer === null) return;
    scrollbarPointer.current = null;
    if (pointer !== null && scrollbarRef.current?.hasPointerCapture(pointer)) scrollbarRef.current.releasePointerCapture(pointer);
    revealScrollbar();
  }

  return { viewportRef, titleRef, backdropRef, scrollbarRef, overflow,
    scrollbarProps: { onInput: onScrollbarInput, onFocus: stop,
      onPointerDown: onScrollbarPointerDown, onPointerUp: onScrollbarPointerUp,
      onPointerCancel: hideScrollbar, onLostPointerCapture: onScrollbarPointerUp },
    viewportProps: { onScroll: () => sync(), onKeyDown, onPointerDown, onPointerMove, onPointerUp,
      onPointerCancel: cancelDrag, onLostPointerCapture: cancelDrag, onFocusCapture: stop },
  };
}
