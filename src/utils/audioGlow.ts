import { clamp, clampInt } from "../motion/math.js";

export type ZuneGlowHotspot = {
  x: number;
  y: number;
  radius: number;
  alpha: number;
};

export type ZuneGlowFrame = {
  active: boolean;
  bodyWidth: number;
  bodyHeight: number;
  bodyAlpha: number;
  baseAlpha: number;
  crestAlpha: number;
  crestSoftness: number;
  bodyLift: number;
  visibleTop: number;
  centerIntensity: number;
  edgeIntensity: number;
  hotspots: ZuneGlowHotspot[];
};

export type ZuneMountainPoint = {
  x: number;
  height: number;
  heat: number;
  softness: number;
};

export type ZuneMountainFrame = ZuneGlowFrame & {
  bodyCenterX: number;
  ridgePoints: ZuneMountainPoint[];
  ridgePeak: number;
};

/** A light falloff, not a filled silhouette. Each live audio column diffuses
 * upward continuously, so the eye never sees a stroked mountain boundary. */
export function zuneGlowRadiance(height: number, heat: number, rise: number) {
  const drive = clamp((height - 0.008) / 0.492, 0, 1);
  if (drive === 0) return 0;
  const reach = 0.028 + drive * 0.26 + clamp(heat, 0, 1) * 0.04;
  const tail = Math.exp(-((Math.max(0, rise) / reach) ** 1.8));
  const floor = Math.exp(-Math.max(0, rise) / 0.045);
  return clamp(drive ** 0.9 * (tail * 1.4 + floor * 0.28), 0, 1);
}

export function createZuneGlowFrame({
  energy,
  beatPulse,
  onsetStrength,
  beatPhase,
  bodyLevel,
  spreadLevel,
  crestLevel,
  hotspotLevel,
}: {
  energy: number;
  beatPulse: number;
  onsetStrength: number;
  beatPhase: number;
  time: number;
  bodyLevel?: number;
  spreadLevel?: number;
  crestLevel?: number;
  hotspotLevel?: number;
}): ZuneGlowFrame {
  const safeEnergy = clamp(energy, 0, 1);
  const hit = clamp(Math.max(beatPulse, onsetStrength), 0, 1);
  const decay = Math.exp(-clamp(beatPhase, 0, 1) * 3.2);
  const body = clamp(bodyLevel ?? safeEnergy * 0.72 + hit * 0.26 + beatPulse * decay * 0.18, 0, 1);
  const spread = clamp(spreadLevel ?? safeEnergy * 0.56 + hit * 0.46 + beatPulse * decay * 0.12, 0, 1);
  const crest = clamp(crestLevel ?? hit * 0.68 + safeEnergy * 0.3, 0, 1);
  const hotspot = clamp(hotspotLevel ?? onsetStrength * 0.72 + beatPulse * 0.24, 0, 1);
  const active = body > 0.012 || spread > 0.012 || crest > 0.02 || hotspot > 0.04;

  if (!active) return createEmptyGlowFrame();

  const bodyWidth = clamp(0.32 + spread * 0.3, 0.32, 0.62);
  const bodyHeight = clamp(0.22 + body * 0.17 + crest * 0.035, 0.22, 0.4);
  const visibleTop = clamp(0.98 - bodyHeight - crest * 0.04, 0.55, 0.84);
  const bodyAlpha = clamp(0.3 + body * 0.6 + hit * 0.16, 0.24, 0.94);
  const baseAlpha = clamp(0.16 + safeEnergy * 0.26 + beatPulse * 0.1, 0.12, 0.44);
  const crestAlpha = clamp(0.035 + crest * 0.28 + safeEnergy * 0.06, 0.025, 0.38);
  const crestSoftness = clamp(0.52 + (1 - crest) * 0.18, 0.5, 0.72);
  const bodyLift = clamp(hit * 0.035 + safeEnergy * 0.02, 0, 0.055);

  return {
    active,
    bodyWidth,
    bodyHeight,
    bodyAlpha,
    baseAlpha,
    crestAlpha,
    crestSoftness,
    bodyLift,
    visibleTop,
    centerIntensity: clamp(bodyAlpha + crestAlpha * 0.62, 0, 1),
    edgeIntensity: clamp(baseAlpha * 0.18 + bodyAlpha * 0.028, 0, 0.1),
    hotspots: [],
  };
}

export function createZuneMountainFrame({
  samples,
  transients = [],
  pointCount = 96,
  energy,
  beatPulse,
  onsetStrength,
  beatPhase,
  time,
  bodyLevel,
  spreadLevel,
  crestLevel,
  hotspotLevel,
}: {
  samples: number[];
  transients?: number[];
  pointCount?: number;
  energy: number;
  beatPulse: number;
  onsetStrength: number;
  beatPhase: number;
  time: number;
  bodyLevel?: number;
  spreadLevel?: number;
  crestLevel?: number;
  hotspotLevel?: number;
}): ZuneMountainFrame {
  const glow = createZuneGlowFrame({
    energy,
    beatPulse,
    onsetStrength,
    beatPhase,
    time,
    bodyLevel,
    spreadLevel,
    crestLevel,
    hotspotLevel,
  });
  if (!glow.active) return { ...glow, bodyCenterX: 0.5, ridgePoints: [], ridgePeak: 0 };

  const count = clampInt(pointCount, 48, 128);
  const source = samples.length > 0 ? samples : [0];
  const hit = clamp(Math.max(beatPulse, onsetStrength), 0, 1);
  const ridgePoints = Array.from({ length: count }, (_, index) => {
    const x = index / Math.max(1, count - 1);
    const sample = sampleWindow(source, x);
    const sampleDrive = clamp(sample / 0.34, 0, 1);
    const localHit = transients.length ? sampleWindow(transients, x) : hit * sampleDrive;
    // The sampler already supplies the spatial envelope. A second central
    // mountain here used to erase the differences between songs and sections.
    const height = clamp(0.008 + sampleDrive * 0.4 + localHit * 0.12, 0.008, 0.5);
    const heat = clamp(sampleDrive * 0.64 + localHit * 0.36, 0, 1);
    return {
      x,
      height,
      heat,
      softness: clamp(0.48 + (1 - sampleDrive) * 0.24 - hit * 0.06, 0.42, 0.72),
    };
  });

  return {
    ...glow,
    bodyCenterX: ridgePoints.reduce((sum, point) => sum + point.x * point.height ** 2, 0)
      / Math.max(0.0001, ridgePoints.reduce((sum, point) => sum + point.height ** 2, 0)),
    // Highlights follow the actual crests, not pseudo-random wall-clock noise.
    hotspots: ridgePoints.filter((point, index) => index > 0 && index < count - 1
      && point.height > ridgePoints[index - 1].height && point.height >= ridgePoints[index + 1].height)
      .sort((a, b) => b.heat - a.heat).slice(0, 3)
      .map((point) => ({
        x: point.x, y: 1 - point.height * 0.85,
        radius: 0.014 + point.heat * 0.02,
        alpha: point.heat * hit * 0.24,
      })),
    ridgePoints,
    ridgePeak: ridgePoints.reduce((peak, point) => Math.max(peak, point.height), 0),
  };
}

function createEmptyGlowFrame(): ZuneGlowFrame {
  return {
    active: false,
    bodyWidth: 0,
    bodyHeight: 0,
    bodyAlpha: 0,
    baseAlpha: 0,
    crestAlpha: 0,
    crestSoftness: 0.6,
    bodyLift: 0,
    visibleTop: 1,
    centerIntensity: 0,
    edgeIntensity: 0,
    hotspots: [],
  };
}


function sampleWindow(samples: number[], ratio: number) {
  if (samples.length === 1) return samples[0] ?? 0;
  const center = ratio * (samples.length - 1);
  const base = Math.floor(center);
  const weights = [1, 2, 3, 2, 1];
  let total = 0;
  let weightTotal = 0;
  for (let offset = -2; offset <= 2; offset += 1) {
    const index = clampInt(base + offset, 0, samples.length - 1);
    const weight = weights[offset + 2];
    total += (samples[index] ?? 0) * weight;
    weightTotal += weight;
  }
  return total / Math.max(weightTotal, 1);
}
