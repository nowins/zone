import { recordDiagnostic } from "../utils/diagnostics";
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { VISUALIZER_SAMPLE_COUNT } from "../constants";
import {
  createIdleBeatFrame,
  RealtimeBeatAnalyzer,
  type BeatFrame,
  type BeatGrid,
} from "../utils/beatAnalysis";
import { createAudioVisualizerFrame, createIdleVisualizerFrame } from "../utils/visualizer";
import { getVisualizerFrame, isDocumentVisible, isVisualizerSurfaceActive, publishVisualizerFrame } from "../utils/visualizerBus";
import type { ActivePlayback } from "./usePlaybackControls";
import type { Track } from "../types";

export type AudioEngineHandle = {
  resumeAudioGraph: () => Promise<void>;
  preAnalyzeBeatGrid: (track: Track) => Promise<void>;
  publishIdleBeatFrame: () => void;
  publishPodcastVisualizerReset: () => void;
  visualizerUnavailableRef: React.MutableRefObject<boolean>;
  realtimeBeatRef: React.MutableRefObject<RealtimeBeatAnalyzer | null>;
  offlineBeatGridRef: React.MutableRefObject<BeatGrid | null>;
  beatFrameRef: React.MutableRefObject<BeatFrame>;
  cancelBeatAnalysis: () => void;
};

type UseAudioEngineParams = {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  volume: number;
  progress: number;
  isPlaying: boolean;
  activePlayback: ActivePlayback;
  activePlaybackSourceKey: string | null;
  activeTrackId: string | null;
  visualizerVisible: boolean;
};

export function useAudioEngine({
  audioRef,
  volume,
  progress,
  isPlaying,
  activePlayback,
  activePlaybackSourceKey,
  activeTrackId,
  visualizerVisible,
}: UseAudioEngineParams): AudioEngineHandle {
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const visualizerFrameRef = useRef<number | null>(null);
  const visualizerSilenceFramesRef = useRef(0);
  const visualizerUnavailableRef = useRef(false);
  const visualizerEnergyRef = useRef(0.055);
  const visualizerSamplesRef = useRef<number[]>([]);
  const beatFrameRef = useRef<BeatFrame>(createIdleBeatFrame());
  const realtimeBeatRef = useRef<RealtimeBeatAnalyzer | null>(null);
  const offlineBeatGridRef = useRef<BeatGrid | null>(null);
  const beatGridCacheRef = useRef(new Map<string, BeatGrid | null>());
  const beatAnalysisRequestRef = useRef(0);
  const beatWorkerRef = useRef<Worker | null>(null);
  const finishWorkerRef = useRef<(() => void) | null>(null);
  const nativeCancellationRef = useRef<Promise<unknown>>(Promise.resolve());
  const activeTrackRef = useRef(activeTrackId);
  activeTrackRef.current = activeTrackId;
  useEffect(() => () => cancelBeatAnalysis(), []);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const stopLoop = () => {
      if (visualizerFrameRef.current) {
        cancelAnimationFrame(visualizerFrameRef.current);
        visualizerFrameRef.current = null;
      }
    };

    const syncLoop = () => {
      const shouldRun = isVisualizerSurfaceActive(isPlaying, visualizerVisible) && activePlayback?.kind === "music";
      if (!shouldRun) {
        stopLoop();
        beatFrameRef.current = createIdleBeatFrame();
        if (activePlayback?.kind === "podcast") publishPodcastVisualizerReset();
        else publishIdleBeatFrame();
        return;
      }
      if (!visualizerFrameRef.current) startVisualizer();
    };

    syncLoop();
    const onVisibility = () => syncLoop();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stopLoop();
    };
  }, [activePlaybackSourceKey, isPlaying, activePlayback?.kind, visualizerVisible]);

  function ensureAudioGraph() {
    if (visualizerUnavailableRef.current) return;

    const audio = audioRef.current;
    if (!audio) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      visualizerUnavailableRef.current = true;
      return;
    }

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContextClass();
      }

      if (!analyserRef.current) {
        const analyser = audioContextRef.current.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.78;
        analyserRef.current = analyser;
      }

      if (!audioSourceRef.current) {
        audioSourceRef.current = audioContextRef.current.createMediaElementSource(audio);
        audioSourceRef.current.connect(analyserRef.current);
      }

      if (!outputGainRef.current) {
        const outputGain = audioContextRef.current.createGain();
        outputGain.gain.value = 1;
        analyserRef.current.connect(outputGain);
        outputGain.connect(audioContextRef.current.destination);
        outputGainRef.current = outputGain;
      }

      if (audioContextRef.current.state === "suspended") {
        void audioContextRef.current.resume();
      }
    } catch (error) {
      console.warn("Audio visualizer disabled", error);
      visualizerUnavailableRef.current = true;
    }
  }

  async function resumeAudioGraph() {
    if (!audioRef.current || visualizerUnavailableRef.current) return;

    ensureAudioGraph();
    if (audioContextRef.current?.state === "suspended") {
      await audioContextRef.current.resume().catch(() => undefined);
    }
  }

  function cancelBeatAnalysis() {
    beatAnalysisRequestRef.current += 1;
    beatWorkerRef.current?.terminate();
    beatWorkerRef.current = null;
    finishWorkerRef.current?.();
    finishWorkerRef.current = null;
    nativeCancellationRef.current = invoke("music_cancel_beat_window").catch(() => undefined);
  }

  async function preAnalyzeBeatGrid(track: Track) {
    const requestId = ++beatAnalysisRequestRef.current;
    const started = performance.now();
    try {
      await nativeCancellationRef.current;
      if (requestId !== beatAnalysisRequestRef.current) return;
      const bytes = await invoke<ArrayBuffer>("music_decode_beat_window", { trackId: track.id });
      if (requestId !== beatAnalysisRequestRef.current) return;
      const cacheKey = `${track.id}:${Array.from(new Uint8Array(bytes, 0, 24)).join(".")}`;
      let grid = beatGridCacheRef.current.get(cacheKey);
      if (grid === undefined) {
        const worker = new Worker(new URL("../workers/beatAnalysis.worker.ts", import.meta.url), { type: "module" });
        beatWorkerRef.current = worker;
        grid = await new Promise<BeatGrid | null>((resolve, reject) => {
          finishWorkerRef.current = () => resolve(null);
          worker.onmessage = (event) => event.data.error ? reject(new Error("节拍计算失败")) : resolve(event.data.grid);
          worker.onerror = () => reject(new Error("节拍计算任务失败"));
          worker.postMessage(bytes, [bytes]);
        });
        if (requestId !== beatAnalysisRequestRef.current) return;
        worker.terminate();
        beatWorkerRef.current = null;
        finishWorkerRef.current = null;
        if (beatGridCacheRef.current.size >= 32) beatGridCacheRef.current.delete(beatGridCacheRef.current.keys().next().value!);
        beatGridCacheRef.current.set(cacheKey, grid);
      }
      if (activeTrackRef.current === track.id) offlineBeatGridRef.current = grid;
      recordDiagnostic({ domain: "visualizer", event: "beat_analysis", outcome: "ok", elapsedMs: performance.now() - started });
    } catch {
      if (requestId !== beatAnalysisRequestRef.current) return;
      beatWorkerRef.current?.terminate();
      beatWorkerRef.current = null;
      finishWorkerRef.current = null;
      offlineBeatGridRef.current = null;
      // Playback remains on the realtime analyzer; failed requests may retry.
      recordDiagnostic({ domain: "visualizer", event: "beat_analysis", outcome: "error", elapsedMs: performance.now() - started });
    }
  }

  // Keep the bus frame's beat fields at idle (samples/energy untouched) while
  // playback is paused or switching tracks, mirroring the old beatFrame reset.
  function publishIdleBeatFrame() {
    const current = getVisualizerFrame();
    publishVisualizerFrame({
      ...current,
      beatPulse: 0,
      beatPhase: 0,
      onsetStrength: 0,
      beatConfidence: 0,
    });
  }

  function publishPodcastVisualizerReset() {
    publishVisualizerFrame({
      samples: Array.from({ length: VISUALIZER_SAMPLE_COUNT }, () => 0.035),
      energy: 0.055,
      beatPulse: 0,
      beatPhase: 0,
      onsetStrength: 0,
      beatConfidence: 0,
    });
  }

  function startVisualizer() {
    void resumeAudioGraph();
    const frequencyData = new Uint8Array(analyserRef.current?.frequencyBinCount ?? 512);
    const timeData = new Uint8Array(analyserRef.current?.fftSize ?? 1024);
    const sample = () => {
      if (!isDocumentVisible() || !isPlaying) {
        visualizerFrameRef.current = null;
        publishIdleBeatFrame();
        return;
      }
      const analyser = analyserRef.current;
      let frame = createIdleVisualizerFrame(
        VISUALIZER_SAMPLE_COUNT,
        performance.now() * 0.001,
        audioRef.current?.currentTime ?? progress,
      );
      let beat = beatFrameRef.current;

      if (analyser && !visualizerUnavailableRef.current) {
        analyser.getByteFrequencyData(frequencyData);
        analyser.getByteTimeDomainData(timeData);
        const audioFrame = createAudioVisualizerFrame(
          frequencyData,
          timeData,
          VISUALIZER_SAMPLE_COUNT,
          audioContextRef.current?.sampleRate,
          analyser.fftSize,
        );
        visualizerSilenceFramesRef.current = audioFrame.active ? 0 : visualizerSilenceFramesRef.current + 1;
        if (visualizerSilenceFramesRef.current < 28) frame = audioFrame;

        if (!realtimeBeatRef.current) realtimeBeatRef.current = new RealtimeBeatAnalyzer();
        beat = realtimeBeatRef.current.update(
          frequencyData,
          timeData,
          audioRef.current?.currentTime ?? progress,
          audioContextRef.current?.sampleRate,
          analyser.fftSize,
          offlineBeatGridRef.current,
        );
        beatFrameRef.current = beat;
      }

      const previousEnergy = visualizerEnergyRef.current;
      const energy = frame.energy > previousEnergy
        ? previousEnergy * 0.64 + frame.energy * 0.36
        : previousEnergy * 0.9 + frame.energy * 0.1;
      visualizerEnergyRef.current = energy;

      if (visualizerSamplesRef.current.length !== VISUALIZER_SAMPLE_COUNT) {
        visualizerSamplesRef.current = Array.from({ length: VISUALIZER_SAMPLE_COUNT }, () => 0.035);
      }
      const samples = visualizerSamplesRef.current.map((previous, index) => {
        const next = frame.samples[index] ?? 0.035;
        return next > previous
          ? previous * 0.58 + next * 0.42
          : previous * 0.9 + next * 0.1;
      });
      visualizerSamplesRef.current = samples;

      publishVisualizerFrame({
        samples,
        energy,
        beatPulse: beat.beatPulse,
        beatPhase: beat.beatPhase,
        onsetStrength: beat.onsetStrength,
        beatConfidence: beat.confidence,
      });
      visualizerFrameRef.current = requestAnimationFrame(sample);
    };

    sample();
  }

  return {
    resumeAudioGraph,
    preAnalyzeBeatGrid,
    publishIdleBeatFrame,
    publishPodcastVisualizerReset,
    visualizerUnavailableRef,
    realtimeBeatRef,
    offlineBeatGridRef,
    beatFrameRef,
    cancelBeatAnalysis,
  };
}
