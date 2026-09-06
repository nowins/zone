import { useCallback, useRef } from "react";

/** Stable event identity with the latest render's behavior. */
export function useEvent<T extends (...args: any[]) => any>(callback: T): T {
  const current = useRef(callback);
  current.current = callback;
  return useCallback(((...args: Parameters<T>) => current.current(...args)) as T, []);
}
