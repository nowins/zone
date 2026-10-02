import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { WINDOW_VISIBILITY_EVENT } from "../utils/visualizerBus";

/** WebView2 may remain document-visible when its native window is hidden. */
export function useNativeWindowVisibility() {
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let pending = false;
    const sync = async () => {
      if (pending || !alive) return;
      pending = true;
      try {
        const visible = await invoke<boolean>("get_main_window_visibility");
        if (!alive) return;
        const value = String(visible);
        if (document.documentElement.dataset.zoneWindowVisible !== value) {
          document.documentElement.dataset.zoneWindowVisible = value;
          document.dispatchEvent(new window.Event(WINDOW_VISIBILITY_EVENT));
        }
      } catch { /* Keep the last known visibility when the host is unavailable. */ }
      finally { pending = false; }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 1000);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      delete document.documentElement.dataset.zoneWindowVisible;
    };
  }, []);
}
