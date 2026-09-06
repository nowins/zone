import { useEffect, useState } from "react";

export function useEntranceCompletion(started: boolean, durationMs: number) {
  const [complete, setComplete] = useState(false);
  useEffect(() => {
    if (!started) return;
    const timer = window.setTimeout(() => setComplete(true), durationMs);
    return () => window.clearTimeout(timer);
  }, [started, durationMs]);
  return complete;
}
