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
  ridgePoints: ZuneMountainPoint[];
  ridgePeak: number;
};

export function createZuneGlowFrame({
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

  const widthBreath = Math.sin(time * 0.72) * 0.014 + Math.sin(time * 0.37 + 1.7) * 0.011;
  const heightBreath = Math.sin(time * 0.83 + 0.6) * 0.012;
  const bodyWidth = clamp(0.32 + spread * 0.3 + widthBreath, 0.32, 0.62);
  const bodyHeight = clamp(0.22 + body * 0.17 + crest * 0.035 + heightBreath, 0.22, 0.4);
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
    hotspots: createHotspots(hotspot, bodyWidth, visibleTop, time),
  };
}

export function createZuneMountainFrame({
  samples,
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
  if (!glow.active) return { ...glow, ridgePoints: [], ridgePeak: 0 };

  const count = clampInt(pointCount, 48, 128);
  const source = samples.length > 0 ? samples : [Math.max(0.018, energy * 0.12)];
  const hit = clamp(Math.max(beatPulse, onsetStrength), 0, 1);
  const ridgePoints = Array.from({ length: count }, (_, index) => {
    const x = index / Math.max(1, count - 1);
    const centerWeight = 0.18 + Math.pow(Math.sin(Math.PI * x), 1.35) * 0.82;
    const sample = sampleWindow(source, x);
    const sampleDrive = clamp(Math.pow(Math.max(0, sample - 0.008) / 0.34, 0.76), 0, 1);
    const texture =
      Math.sin(time * 8.4 + index * 0.71) * 0.55 +
      Math.sin(time * 5.7 + index * 1.37) * 0.3 +
      Math.sin(time * 11.2 + index * 0.29) * 0.15;
    const baseline = 0.018 + glow.baseAlpha * (0.03 + centerWeight * 0.055);
    const sampleLift = sampleDrive * (0.055 + centerWeight * 0.32);
    const hitLift = hit * (0.028 + centerWeight * 0.09);
    const motion = texture * (0.008 + sampleDrive * 0.024) * (0.42 + centerWeight * 0.58);
    const height = clamp(baseline + sampleLift + hitLift + motion, 0.018, 0.5);
    const heat = clamp((sampleDrive * 0.62 + hit * 0.22 + glow.bodyAlpha * 0.16) * (0.34 + centerWeight * 0.66), 0, 1);
    return {
      x,
      height,
      heat,
      softness: clamp(0.48 + (1 - sampleDrive) * 0.24 - hit * 0.06, 0.42, 0.72),
    };
  });

  return {
    ...glow,
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

function createHotspots(level: number, bodyWidth: number, visibleTop: number, time: number): ZuneGlowHotspot[] {
  if (level < 0.12) return [];
  const count = level > 0.62 ? 5 : level > 0.34 ? 3 : 1;
  return Array.from({ length: count }, (_, index) => {
    const seed = seededNoise(index * 19.13 + Math.floor(time * 4) * 7.31);
    const offset = (seed - 0.5) * bodyWidth * 0.74;
    const yNoise = seededNoise(index * 31.7 + Math.floor(time * 5) * 3.9);
    return {
      x: clamp(0.5 + offset, 0.5 - bodyWidth * 0.42, 0.5 + bodyWidth * 0.42),
      y: clamp(visibleTop + 0.08 + yNoise * 0.16, 0.62, 0.91),
      radius: clamp(0.012 + level * 0.018 + seed * 0.008, 0.012, 0.04),
      alpha: clamp((0.12 + level * 0.24) * (0.72 + seed * 0.28), 0.08, 0.34),
    };
  });
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

function seededNoise(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
