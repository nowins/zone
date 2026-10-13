import { VISUALIZER_SAMPLE_COUNT } from "../constants.js";
import { createIdleBeatFrame } from "./beatAnalysis.js";
import { createSilentVisualizerFrame } from "./visualizer.js";

export interface VisualizerFrameData {
  glowBands: readonly number[];
  sourceKey?: string | null;
  samples: number[];
  transients: number[];
  bass: number;
  texture: number;
  energy: number;
  beatPulse: number;
  beatPhase: number;
  onsetStrength: number;
  beatConfidence: number;
}

function createIdleVisualizerFrameData(): VisualizerFrameData {
  const beat = createIdleBeatFrame();
  return {
    glowBands: [],
    ...createSilentVisualizerFrame(VISUALIZER_SAMPLE_COUNT),
    beatPulse: beat.beatPulse,
    beatPhase: beat.beatPhase,
    onsetStrength: beat.onsetStrength,
    beatConfidence: beat.confidence,
  };
}

// Single-slot latest-frame store. The App-level sampler publishes once per
// frame; the shell glow and now-playing canvases pull from their own rAF loops, so no
// subscription fan-out is needed.
let latestFrame: VisualizerFrameData = createIdleVisualizerFrameData();

export function publishVisualizerFrame(frame: VisualizerFrameData): void {
  latestFrame = frame;
}

export function getVisualizerFrame(): VisualizerFrameData {
  return latestFrame;
}


export function isDocumentVisible() {
  if (typeof document === "undefined") return true;
  return !document.hidden && document.visibilityState !== "hidden" && document.documentElement?.dataset.zoneWindowVisible !== "false";
}

export const WINDOW_VISIBILITY_EVENT = "zone-window-visibility";

export function isVisualizerSurfaceActive(isPlaying: boolean, surfaceVisible = true) {
  return isPlaying && surfaceVisible && isDocumentVisible();
}
