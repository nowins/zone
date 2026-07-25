import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { resolveExitDurationMs } from "./tokens";
import { useReducedMotion } from "./useReducedMotion";

interface PresenceState {
  mounted: boolean;
  exiting: boolean;
}

/**
 * Keeps content mounted while `show` is false so a CSS exit transition can
 * finish: `exiting` flips true for `exitDurationMs`, then it unmounts.
 * Showing again mid-exit cancels the pending unmount. Any timer is cleared
 * when the component unmounts. Under reduced motion the wait collapses to
 * the instant tier, matching the opacity-only fade the CSS side plays.
 */
export function usePresence(show: boolean, exitDurationMs: number): PresenceState {
  const reducedMotion = useReducedMotion();
  const effectiveExitMs = resolveExitDurationMs(exitDurationMs, reducedMotion);
  const [state, setState] = useState<PresenceState>({ mounted: show, exiting: false });
  const mountedRef = useRef(show);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (show) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      mountedRef.current = true;
      setState({ mounted: true, exiting: false });
      return;
    }
    if (!mountedRef.current) return;
    setState({ mounted: true, exiting: true });
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      mountedRef.current = false;
      setState({ mounted: false, exiting: false });
    }, effectiveExitMs);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [show, effectiveExitMs]);

  return state;
}

/**
 * Remembers the most recent non-null value. Paired with `Presence` so an
 * exiting surface keeps rendering the element snapshot from the moment it
 * was closed; that snapshot's callbacks reference the data of that render,
 * which is exactly what a closing surface should show.
 */
export function useLastNonNull<T>(value: T | null): T | null {
  const ref = useRef<T | null>(value);
  if (value !== null) ref.current = value;
  return ref.current;
}

interface PresenceProps {
  show: boolean;
  exitDurationMs: number;
  exitClassName?: string;
  children: ReactElement;
}

/**
 * Mount/unmount wrapper with an exit window: while `show` is false the
 * children stay mounted for `exitDurationMs` and the wrapper carries
 * `exitClassName` (default "motion-exit") so CSS can animate them out.
 * The wrapper uses `display: contents` to avoid affecting layout; target
 * the children from the exit class with descendant selectors.
 */
export function Presence({
  show,
  exitDurationMs,
  exitClassName = "motion-exit",
  children,
}: PresenceProps): ReactElement | null {
  const { mounted, exiting } = usePresence(show, exitDurationMs);
  if (!mounted) return null;
  return (
    <span className={exiting ? exitClassName : undefined} style={{ display: "contents" }}>
      {children}
    </span>
  );
}
