export type PodcastAudioOptions = { source: string | null; podcast: boolean; rate: number; normalize: boolean; trim: boolean; volume: number };

export function createPodcastAudioEnhancement(
  audio: HTMLAudioElement, context: AudioContext, input: AnalyserNode, output: GainNode, onError: () => void,
) {
  let options: PodcastAudioOptions = { source: null, podcast: false, rate: 1, normalize: false, trim: false, volume: 1 };
  let node: AudioWorkletNode | null = null, loading: Promise<void> | null = null;
  let epoch = 0, disposed = false, failed = false;
  function reset() {
    epoch++;
    if (options.podcast) audio.playbackRate = options.rate;
    audio.dataset.podcastSilence = "false";
    node?.port.postMessage({ epoch, enabled: options.podcast && !audio.paused && !audio.seeking, normalize: options.normalize, trim: options.trim, volume: options.volume });
  }
  function fallback() {
    if (failed || disposed) return;
    failed = true; node?.disconnect(); node?.port.close(); node = null;
    input.disconnect(); input.connect(output); reset(); onError();
  }
  async function install() {
    try {
      if (!context.audioWorklet || typeof AudioWorkletNode === "undefined") throw new Error("AudioWorklet unavailable");
      await context.audioWorklet.addModule(new URL("../workers/podcastAudio.worklet.js?no-inline", import.meta.url).href);
      if (disposed) return;
      node = new AudioWorkletNode(context, "zone-podcast-audio");
      node.onprocessorerror = fallback;
      node.port.onmessage = event => {
        const data = event.data;
        if (disposed || data.epoch !== epoch || !options.podcast || audio.paused || audio.seeking) return;
        audio.playbackRate = options.trim && data.silent ? Math.min(3, options.rate * 2) : options.rate;
        audio.dataset.podcastSilence = String(Boolean(options.trim && data.silent));
        audio.dataset.podcastVoiceGain = String(data.gain);
        audio.dataset.podcastSignal = String(data.rms);
      };
      input.disconnect(); input.connect(node); node.connect(output); reset();
    } catch { fallback(); }
  }
  audio.addEventListener("play", reset); audio.addEventListener("pause", reset); audio.addEventListener("seeking", reset); audio.addEventListener("seeked", reset);
  return {
    update(next: PodcastAudioOptions) {
      options = next; reset();
      if (next.podcast && (next.normalize || next.trim) && !node && !loading && !failed) loading = install();
    },
    dispose() {
      reset(); disposed = true;
      for (const event of ["play", "pause", "seeking", "seeked"]) audio.removeEventListener(event, reset);
      node?.port.close(); node?.disconnect(); input.disconnect(); input.connect(output);
    },
  };
}
