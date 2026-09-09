import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** The native window owns geometry; changing the surface never replaces the audio. */
export function useCompactMode() {
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(true);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (isTauri() ? invoke<boolean>("get_compact_mode") : Promise.resolve(false))
      .then(value => { if (!cancelled) setActive(value); })
      .catch(() => { if (!cancelled) setError("无法读取窗口模式，请重试"); })
      .finally(() => {
        if (!cancelled) { busy.current = false; setPending(false); }
      });
    return () => { cancelled = true; mounted.current = false; };
  }, []);

  async function setCompact(value: boolean) {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const actual = isTauri() ? await invoke<boolean>("set_compact_mode", { compact: value }) : value;
      if (mounted.current) setActive(actual);
      return actual === value;
    } catch {
      // A partial native rollback can still retain a restoration snapshot.
      if (isTauri()) {
        try {
          const actual = await invoke<boolean>("get_compact_mode");
          if (mounted.current) setActive(actual);
        } catch { /* Keep the last known mode until the next request. */ }
      }
      if (mounted.current) setError(value ? "无法进入小屏模式，请重试" : "无法恢复正常模式，请重试");
      return false;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return { active, pending, error, setCompact };
}
