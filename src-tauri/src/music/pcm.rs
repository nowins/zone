//! Decode a short mid-track PCM window and compute light acoustic features.
//!
//! This runs entirely on a background thread: we only take a file path, decode
//! a bounded window, and fold it into the existing feature vector pipeline.
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use super::features::PcmFeatureSummary;

const ANALYSIS_SECONDS: usize = 30;
const TARGET_SAMPLE_RATE: u32 = 22050;

/// Decode up to `ANALYSIS_SECONDS` from the middle of the file at `path` and
/// compute a light acoustic summary. Returns `None` if the file cannot be
/// decoded (unsupported/corrupt); callers should treat that as best-effort.
pub(crate) fn summarize_pcm_from_path(path: &str) -> Option<PcmFeatureSummary> {
  let file = std::fs::File::open(path).ok()?;
  let mss = MediaSourceStream::new(Box::new(file), Default::default());

  let mut hint = Hint::new();
  if let Some(extension) = std::path::Path::new(path)
    .extension()
    .and_then(|value| value.to_str())
  {
    hint.with_extension(extension);
  }

  let probed = symphonia::default::get_probe()
    .format(
      &hint,
      mss,
      &FormatOptions::default(),
      &MetadataOptions::default(),
    )
    .ok()?;
  let mut format = probed.format;

  let track = format
    .tracks()
    .iter()
    .find(|item| item.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)?;
  let track_id = track.id;
  let codec_params = track.codec_params.clone();
  let sample_rate = codec_params.sample_rate.unwrap_or(TARGET_SAMPLE_RATE);

  let mut decoder = symphonia::default::get_codecs()
    .make(&codec_params, &DecoderOptions::default())
    .ok()?;

  // Collect mono samples at native rate, then downsample for cheap stats.
  let mut mono: Vec<f32> = Vec::new();
  let max_samples = sample_rate as usize * ANALYSIS_SECONDS;
  // Skip roughly the first third to land on a representative mid-section.
  let total_frames = codec_params.n_frames.unwrap_or(0);
  let mut skipped: u64 = 0;
  let skip_target = total_frames / 3;

  loop {
    let packet = match format.next_packet() {
      Ok(packet) => packet,
      Err(SymphoniaError::IoError(_)) => break, // EOF
      Err(_) => break,
    };
    if packet.track_id() != track_id {
      continue;
    }
    if skipped < skip_target {
      skipped += packet.dur();
      continue;
    }
    let decoded = match decoder.decode(&packet) {
      Ok(decoded) => decoded,
      Err(SymphoniaError::DecodeError(_)) => continue,
      Err(_) => break,
    };
    let spec = *decoded.spec();
    let channels = spec.channels.count().max(1);
    let frames = decoded.frames();
    let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
    buffer.copy_interleaved_ref(decoded);
    let samples = buffer.samples();
    for frame in 0..frames {
      let mut acc = 0.0_f32;
      for channel in 0..channels {
        acc += samples.get(frame * channels + channel).copied().unwrap_or(0.0);
      }
      mono.push(acc / channels as f32);
    }
    if mono.len() >= max_samples {
      break;
    }
  }

  if mono.len() < sample_rate as usize / 2 {
    return None; // too little audio to be meaningful
  }
  mono.truncate(max_samples);
  Some(compute_summary(&mono, sample_rate))
}

fn compute_summary(samples: &[f32], sample_rate: u32) -> PcmFeatureSummary {
  let length = samples.len().max(1);
  let mut sum_squares = 0.0_f32;
  let mut peak = 0.0_f32;
  let mut zero_crossings = 0_u64;
  let mut weighted = 0.0_f32;
  let mut magnitude_sum = 0.0_f32;

  for index in 0..samples.len() {
    let sample = samples[index];
    let abs = sample.abs();
    sum_squares += sample * sample;
    if abs > peak {
      peak = abs;
    }
    if index > 0 {
      let prev = samples[index - 1];
      if (sample >= 0.0 && prev < 0.0) || (sample < 0.0 && prev >= 0.0) {
        zero_crossings += 1;
      }
      let delta = (sample - prev).abs();
      weighted += delta * (index as f32 / length as f32);
      magnitude_sum += delta;
    }
  }

  let rms = (sum_squares / length as f32).sqrt();
  let zcr = zero_crossings as f32 / length as f32;
  let centroid = if magnitude_sum > 1e-9 {
    weighted / magnitude_sum
  } else {
    0.5
  };

  let tempo_bpm = estimate_tempo(samples, sample_rate);

  PcmFeatureSummary {
    rms: Some((rms * 2.4).clamp(0.0, 1.0)),
    peak: Some(peak.clamp(0.0, 1.0)),
    zero_crossing_rate: Some((zcr * 8.0).clamp(0.0, 1.0)),
    spectral_centroid: Some(centroid.clamp(0.0, 1.0)),
    tempo_bpm,
  }
}

/// Very light tempo estimate from an energy-envelope autocorrelation.
fn estimate_tempo(samples: &[f32], sample_rate: u32) -> Option<f32> {
  let step = (sample_rate as usize / 200).max(1);
  let mut envelope: Vec<f32> = Vec::with_capacity(samples.len() / step + 1);
  let mut index = 0;
  while index < samples.len() {
    let end = (index + step).min(samples.len());
    let mut acc = 0.0_f32;
    for cursor in index..end {
      acc += samples[cursor].abs();
    }
    envelope.push(acc / (end - index) as f32);
    index = end;
  }
  if envelope.len() < 8 {
    return None;
  }
  let rate = sample_rate as f32 / step as f32;
  let min_lag = (60.0 / 200.0 * rate) as usize;
  let max_lag = (60.0 / 60.0 * rate) as usize;
  let mut best_lag = 0_usize;
  let mut best_score = f32::NEG_INFINITY;
  for lag in min_lag..=max_lag.min(envelope.len() / 2) {
    let mut score = 0.0_f32;
    for i in 0..(envelope.len() - lag) {
      score += envelope[i] * envelope[i + lag];
    }
    if score > best_score {
      best_score = score;
      best_lag = lag;
    }
  }
  if best_lag == 0 {
    None
  } else {
    Some(60.0 * rate / best_lag as f32)
  }
}
