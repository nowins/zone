import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { VISUALIZER_SAMPLE_COUNT } from "../constants";
import {
  analyzePcmBeatGrid,
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
  beatGridCacheRef: React.MutableRefObject<Map<string, BeatGrid | null>>;
  beatFrameRef: React.MutableRefObject<BeatFrame>;
  beatAnalysisRequestRef: React.MutableRefObject<number>;
};

type UseAudioEngineParams = {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  volume: number;
  progress: number;
  isPlaying: boolean;
  activePlayback: ActivePlayback;
  activePlaybackSourceKey: string | null;
  activeTrackId: string | null;
};

export function useAudioEngine({
  audioRef,
  volume,
  progress,
  isPlaying,
  activePlayback,
  activePlaybackSourceKey,
  activeTrackId,
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
      const shouldRun = isVisualizerSurfaceActive(isPlaying) && activePlayback?.kind === "music";
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
  }, [activePlaybackSourceKey, isPlaying, activePlayback?.kind]);

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

  async function preAnalyzeBeatGrid(track: Track) {
    if (beatGridCacheRef.current.has(track.id)) {
      offlineBeatGridRef.current = beatGridCacheRef.current.get(track.id) ?? null;
      return;
    }

    const requestId = beatAnalysisRequestRef.current + 1;
    beatAnalysisRequestRef.current = requestId;

    try {
      const sourceUrl = convertFileSrc(track.path, "zone-audio");
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`beat analysis fetch failed: ${response.status}`);
      const bytes = await response.arrayBuffer();
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("AudioContext unavailable");
      const context = audioContextRef.current ?? new AudioContextClass();
      const shouldClose = !audioContextRef.current;
      const buffer = await context.decodeAudioData(bytes.slice(0));
      const mixed = mixAudioBuffer(buffer);
      const grid = analyzePcmBeatGrid(mixed, buffer.sampleRate);
      beatGridCacheRef.current.set(track.id, grid);
      if (shouldClose) void context.close();
      if (beatAnalysisRequestRef.current === requestId && activeTrackId === track.id) {
        offlineBeatGridRef.current = grid;
      }
    } catch {
      beatGridCacheRef.current.set(track.id, null);
      if (beatAnalysisRequestRef.current === requestId && activeTrackId === track.id) {
        offlineBeatGridRef.current = null;
      }
    }
  }

  function mixAudioBuffer(buffer: AudioBuffer) {
    const length = buffer.length;
    const channels = Math.min(2, buffer.numberOfChannels);
    if (channels <= 1) return new Float32Array(buffer.getChannelData(0));

    const mixed = new Float32Array(length);
    for (let channel = 0; channel < channels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < length; index += 1) mixed[index] += data[index] / channels;
    }
    return mixed;
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
    beatGridCacheRef,
    beatFrameRef,
    beatAnalysisRequestRef,
  };
}
