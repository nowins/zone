import { useEffect, useRef } from "react";
import { createPodcastRecovery } from "../utils/podcastRecovery.js";

type Options = {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  episodeId: string | null;
  remote: boolean;
  hasIntent: () => boolean;
  expireSleep: () => boolean;
  retry: () => void;
  resumeGraph: () => void;
  pauseForDevice: () => void;
  generation: () => number;
};
export function usePodcastRecovery(options: Options) {
  const latest = useRef(options); latest.current = options;
  useEffect(() => {
    const audio = options.audioRef.current;
    if (!audio || !options.episodeId) return;
    let disposed = false;
    const recovery = createPodcastRecovery({ audio,
      hasIntent: () => latest.current.hasIntent(), isRemote: () => latest.current.remote,
      online: () => window.navigator.onLine !== false, expireSleep: () => latest.current.expireSleep(),
      retry: () => latest.current.retry(), resumeGraph: () => latest.current.resumeGraph(),
      generation: () => latest.current.generation(),
    });
    const waiting = () => recovery.stalled(); const error = () => recovery.stalled(true);
    const progress = () => recovery.healthy(); const returned = () => recovery.returned();
    const visible = () => { if (document.visibilityState === "visible") returned(); };
    audio.addEventListener("waiting", waiting); audio.addEventListener("stalled", waiting);
    audio.addEventListener("error", error); audio.addEventListener("timeupdate", progress);
    window.addEventListener("online", returned); window.addEventListener("offline", recovery.offline);
    window.addEventListener("focus", returned); window.addEventListener("pageshow", returned);
    document.addEventListener("visibilitychange", visible);
    const devices = window.navigator.mediaDevices;
    let outputs: string | null = null;
    async function checkDevices(initial = false) {
      if (!devices?.enumerateDevices) return;
      try {
        const all = await devices.enumerateDevices(); if (disposed) return;
        const next = all.filter(device => device.kind === "audiooutput").map(device => device.deviceId).sort().join("|");
        if (!initial && outputs !== null && next !== outputs && latest.current.hasIntent()) latest.current.pauseForDevice();
        outputs = next;
      } catch { /* Device permissions are optional; playback remains usable. */ }
    }
    const deviceChanged = () => { void checkDevices(); };
    void checkDevices(true); devices?.addEventListener?.("devicechange", deviceChanged);
    return () => {
      disposed = true; recovery.dispose();
      audio.removeEventListener("waiting", waiting); audio.removeEventListener("stalled", waiting);
      audio.removeEventListener("error", error); audio.removeEventListener("timeupdate", progress);
      window.removeEventListener("online", returned); window.removeEventListener("offline", recovery.offline);
      window.removeEventListener("focus", returned); window.removeEventListener("pageshow", returned);
      document.removeEventListener("visibilitychange", visible); devices?.removeEventListener?.("devicechange", deviceChanged);
    };
  }, [options.episodeId]);
}
