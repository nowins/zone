import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

interface CompactMode { active: boolean; pinned: boolean }

/** The native window owns geometry; changing the surface never replaces the audio. */
export function useCompactMode() {
  const [mode, setMode] = useState<CompactMode>({ active: false, pinned: false });
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(true);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (isTauri() ? invoke<CompactMode>("get_compact_mode") : Promise.resolve({ active: false, pinned: false }))
      .then(value => { if (!cancelled) setMode(value); })
      .catch(() => { if (!cancelled) setError("无法读取窗口模式，请重试"); })
      .finally(() => {
        if (!cancelled) { busy.current = false; setPending(false); }
      });
    return () => { cancelled = true; mounted.current = false; };
  }, []);

  async function updateMode(kind: "compact" | "pinned", value: boolean) {
    if (busy.current || (kind === "pinned" && !mode.active)) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const actual = isTauri()
        ? await invoke<CompactMode>(kind === "compact" ? "set_compact_mode" : "set_compact_pinned", { [kind]: value })
        : kind === "compact" ? { active: value, pinned: false } : { ...mode, pinned: value };
      if (mounted.current) setMode(actual);
      return (kind === "compact" ? actual.active : actual.pinned) === value;
    } catch {
      // A partial native rollback can still retain a restoration snapshot.
      if (isTauri()) {
        try {
          const actual = await invoke<CompactMode>("get_compact_mode");
          if (mounted.current) setMode(actual);
        } catch { /* Keep the last known mode until the next request. */ }
      }
      if (mounted.current) setError(kind === "compact"
        ? value ? "无法进入小屏模式，请重试" : "无法恢复正常模式，请重试"
        : value ? "无法置顶窗口，请重试" : "无法取消置顶，请重试");
      return false;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return { ...mode, pending, error,
    setCompact: (value: boolean) => updateMode("compact", value),
    setPinned: (value: boolean) => updateMode("pinned", value),
  };
}
