import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from "react";

type Scrub = { pointerId: number; value: number; duration: number; mediaKey: string | undefined; canceled: boolean; changed: boolean };

export function usePlaybackScrub({ progress, duration, disabled, mediaKey, onSeek }: {
  progress: number;
  duration: number;
  disabled: boolean;
  mediaKey?: string;
  onSeek: (value: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const scrubRef = useRef<Scrub | null>(null);
  const lastPointerValue = useRef<number | null>(null);
  const finalChangeTimer = useRef<number | null>(null);
  const latest = useRef({ duration, disabled, mediaKey, onSeek });
  latest.current = { duration, disabled, mediaKey, onSeek };
  const [preview, setPreview] = useState<Scrub | null>(null);

  const clearFinalChange = useCallback(() => {
    if (finalChangeTimer.current !== null) window.clearTimeout(finalChangeTimer.current);
    finalChangeTimer.current = null;
    lastPointerValue.current = null;
  }, []);

  const cancel = useCallback(() => {
    if (!scrubRef.current) return;
    scrubRef.current.canceled = true;
    setPreview(null);
  }, []);

  const finish = useCallback((pointerId: number, commit: boolean) => {
    const scrub = scrubRef.current;
    if (!scrub || scrub.pointerId !== pointerId) return;
    const current = latest.current;
    scrubRef.current = null;
    clearFinalChange();
    lastPointerValue.current = scrub.value;
    finalChangeTimer.current = window.setTimeout(clearFinalChange, 0);
    setPreview(null);
    if (inputRef.current?.hasPointerCapture(pointerId)) inputRef.current.releasePointerCapture(pointerId);
    if (commit && scrub.changed && !scrub.canceled && !current.disabled && current.duration > 0
      && scrub.mediaKey === current.mediaKey && scrub.duration === current.duration) {
      current.onSeek(scrub.value);
    }
  }, [clearFinalChange]);

  useEffect(() => { cancel(); }, [duration, disabled, mediaKey, cancel]);
  useEffect(() => {
    const input = inputRef.current;
    function release(event: globalThis.PointerEvent) { finish(event.pointerId, true); }
    function abort(event: globalThis.PointerEvent) { finish(event.pointerId, false); }
    function additionalPointer(event: globalThis.PointerEvent) {
      if (scrubRef.current && event.pointerId !== scrubRef.current.pointerId) cancel();
    }
    function visibility() { if (document.hidden) cancel(); }
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("blur", cancel);
    document.addEventListener("pointerdown", additionalPointer, true);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("pointerdown", additionalPointer, true);
      document.removeEventListener("visibilitychange", visibility);
      clearFinalChange();
      const scrub = scrubRef.current;
      scrubRef.current = null;
      if (scrub && input?.hasPointerCapture(scrub.pointerId)) input.releasePointerCapture(scrub.pointerId);
    };
  }, [cancel, finish, clearFinalChange]);

  function onPointerDown(event: PointerEvent<HTMLInputElement>) {
    if (disabled || duration <= 0 || event.button !== 0 || !event.isPrimary) return;
    const previous = scrubRef.current;
    if (previous && !previous.canceled) return;
    if (previous) finish(previous.pointerId, false);
    const scrub = { pointerId: event.pointerId, value: progress, duration, mediaKey, canceled: false, changed: false };
    scrubRef.current = scrub;
    clearFinalChange();
    setPreview({ ...scrub });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    if (disabled || duration <= 0) return;
    const value = Math.min(duration, Math.max(0, Number(event.currentTarget.value)));
    if (!Number.isFinite(value)) return;
    const scrub = scrubRef.current;
    if (scrub) {
      if (scrub.canceled || scrub.mediaKey !== mediaKey || scrub.duration !== duration) return;
      scrub.value = value;
      scrub.changed = true;
      setPreview({ ...scrub });
    } else if (value !== lastPointerValue.current) {
      // Native ranges may deliver a final change after the release has already committed.
      clearFinalChange();
      onSeek(value);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && scrubRef.current) {
      event.preventDefault();
      cancel();
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
      const scrub = scrubRef.current;
      if (scrub) finish(scrub.pointerId, false);
      clearFinalChange();
    }
  }

  return {
    value: preview && !disabled && preview.mediaKey === mediaKey && preview.duration === duration ? preview.value : progress,
    inputProps: {
      ref: inputRef, onPointerDown, onChange, onKeyDown, onBlur: cancel,
      onLostPointerCapture: cancel,
    },
  };
}
