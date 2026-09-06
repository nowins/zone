import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Owns fullscreen only for the lifetime of the now-playing surface. */
export function useNowPlayingFullscreen() {
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let actual = false;
    let target = false;
    let requested = false;
    // Serialize window mutations: Escape during entry must win, and cleanup
    // must restore the window even when an entry request is still in flight.
    let operations = appWindow.isFullscreen().then((value) => {
      actual = value;
      if (!requested) target = value;
      if (!disposed) setActive(value);
    }).catch(() => {});

    function request(value: boolean) {
      target = value;
      requested = true;
      setPending(true);
      setError(null);
      operations = operations.then(async () => {
        if (disposed || value !== target) return;
        try {
          await appWindow.setFullscreen(value);
          actual = value;
          if (!disposed) setActive(value);
        } catch {
          if (!disposed) setError(value ? "无法进入全屏，请重试" : "无法退出全屏，请重试");
          if (target === value) target = actual;
        } finally {
          if (!disposed && target === actual) setPending(false);
        }
      });
    }

    const toggle = () => request(!target);
    toggleRef.current = toggle;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || (!target && !actual)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      request(false);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      disposed = true;
      if (toggleRef.current === toggle) toggleRef.current = () => {};
      window.removeEventListener("keydown", onKeyDown, true);
      void operations.then(async () => {
        if (actual) await appWindow.setFullscreen(false);
      }).catch(() => {});
    };
  }, []);

  return { active, pending, error, toggle: () => toggleRef.current() };
}
