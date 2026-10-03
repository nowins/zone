// This standalone module runs in the audio rendering thread and in PCM tests.
export class PodcastVoiceEnvelope {
  constructor() { this.reset(); }
  reset() { this.gain = 1; this.quietSeconds = 0; }
  process(input, output, seconds, normalize, volume = 1) {
    let square = 0, count = 0;
    for (const channel of input) for (const sample of channel) { square += sample * sample; count++; }
    const rms = count ? Math.sqrt(square / count) : 0;
    const reference = volume > 0.001 ? rms / volume : 0;
    const quiet = volume > 0.001 && reference < 0.0056;
    this.quietSeconds = quiet ? this.quietSeconds + seconds : 0;
    const target = normalize && reference >= 0.01 ? Math.min(3, Math.max(0.25, 0.1 / reference)) : 1;
    const previous = this.gain;
    this.gain += (target - this.gain) * (1 - Math.exp(-seconds / (target < this.gain ? 0.08 : 0.6)));
    for (let c = 0; c < output.length; c++) {
      const samples = input[c] ?? input[0];
      for (let i = 0; i < output[c].length; i++) {
        const gain = previous + (this.gain - previous) * (i + 1) / output[c].length;
        const value = (samples?.[i] ?? 0) * (normalize ? gain : 1);
        output[c][i] = normalize ? Math.max(-0.98, Math.min(0.98, value)) : value;
      }
    }
    return { silent: this.quietSeconds >= 0.35, gain: this.gain, rms: reference };
  }
}

if (typeof registerProcessor === "function") {
  class PodcastAudioProcessor extends AudioWorkletProcessor {
    constructor() {
      super(); this.envelope = new PodcastVoiceEnvelope(); this.config = { enabled: false, epoch: 0, volume: 1 };
      this.lastSilent = false; this.frames = 0;
      this.port.onmessage = event => { this.config = event.data; this.envelope.reset(); this.lastSilent = false; this.frames = 0; };
    }
    process(inputs, outputs) {
      const input = inputs[0] ?? [], output = outputs[0] ?? [];
      const length = output[0]?.length ?? 128;
      const state = this.envelope.process(input, output, length / sampleRate, this.config.enabled && this.config.normalize, this.config.volume);
      const silent = this.config.enabled && this.config.trim && state.silent;
      this.frames += length;
      if (silent !== this.lastSilent || this.frames >= sampleRate / 10) {
        this.port.postMessage({ epoch: this.config.epoch, silent, gain: state.gain, rms: state.rms });
        this.lastSilent = silent; this.frames = 0;
      }
      return true;
    }
  }
  registerProcessor("zone-podcast-audio", PodcastAudioProcessor);
}
