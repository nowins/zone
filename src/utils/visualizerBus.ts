import { VISUALIZER_SAMPLE_COUNT } from "../constants.js";
import { createIdleBeatFrame } from "./beatAnalysis.js";

export interface VisualizerFrameData {
  samples: number[];
  energy: number;
  beatPulse: number;
  beatPhase: number;
  onsetStrength: number;
  beatConfidence: number;
}

function createIdleVisualizerFrameData(): VisualizerFrameData {
  const beat = createIdleBeatFrame();
  return {
    samples: Array.from({ length: VISUALIZER_SAMPLE_COUNT }, () => 0.035),
    energy: 0.055,
    beatPulse: beat.beatPulse,
    beatPhase: beat.beatPhase,
    onsetStrength: beat.onsetStrength,
    beatConfidence: beat.confidence,
  };
}

// Single-slot latest-frame store. The App-level sampler publishes once per
// frame; the now-playing canvases pull from their own rAF loops, so no
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
  return document.visibilityState !== "hidden";
}

export function isVisualizerSurfaceActive(isPlaying: boolean, surfaceVisible = true) {
  return isPlaying && surfaceVisible && isDocumentVisible();
}
