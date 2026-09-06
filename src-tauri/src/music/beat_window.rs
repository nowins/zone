//! Bounded native decoding for the visualizer. Audio playback's Range protocol
//! stays independent; only a registered music track may be analyzed.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Instant, UNIX_EPOCH};
use symphonia::core::{audio::SampleBuffer, codecs::DecoderOptions, errors::Error,
  formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};
use tauri::State;
use super::{MusicState, open_music_db};

static GENERATION: AtomicU64 = AtomicU64::new(0);
static DECODE_LOCK: Mutex<()> = Mutex::new(());
const SECONDS: usize = 30;
const MAX_RATE: u32 = 22050;

#[tauri::command]
pub(crate) fn music_cancel_beat_window() { GENERATION.fetch_add(1, Ordering::SeqCst); }

#[tauri::command]
pub(crate) async fn music_decode_beat_window(
  state: State<'_, MusicState>, track_id: String,
) -> Result<tauri::ipc::Response, String> {
  let state = state.inner().clone();
  let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
  tauri::async_runtime::spawn_blocking(move || {
    let _lock = DECODE_LOCK.lock().map_err(|_| "音频分析暂不可用".to_string())?;
    let cancelled = || GENERATION.load(Ordering::SeqCst) != generation;
    if cancelled() { return Err("音频分析已取消".to_string()); }
    let connection = open_music_db(&state)?;
    let path: String = connection.query_row(
      "SELECT path FROM music_tracks WHERE id = ?1 AND missing = 0", [&track_id], |row| row.get(0),
    ).map_err(|_| "找不到待分析的音乐".to_string())?;
    drop(connection);
    decode_window(&path, cancelled).map(tauri::ipc::Response::new)
  }).await.map_err(|_| "音频分析任务异常结束".to_string())?
}

fn decode_window(path: &str, cancelled: impl Fn() -> bool) -> Result<Vec<u8>, String> {
  let file = std::fs::File::open(path).map_err(|_| "无法读取待分析的音乐".to_string())?;
  let metadata = file.metadata().map_err(|_| "无法读取音乐版本".to_string())?;
  let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok())
    .map(|time| time.as_nanos() as u64).unwrap_or(0);
  let mut hint = Hint::new();
  if let Some(extension) = std::path::Path::new(path).extension().and_then(|value| value.to_str()) {
    hint.with_extension(extension);
  }
  let probed = symphonia::default::get_probe().format(&hint,
    MediaSourceStream::new(Box::new(file), Default::default()),
    &FormatOptions::default(), &MetadataOptions::default(),
  ).map_err(|_| "音频格式暂不支持节拍分析".to_string())?;
  let mut format = probed.format;
  let track = format.default_track().ok_or("没有可分析的音轨")?;
  let id = track.id;
  let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())
    .map_err(|_| "音频解码器不可用".to_string())?;
  let mut rate = 0u32;
  let mut phase = 0u32;
  let mut samples = Vec::<f32>::new();
  let started = Instant::now();
  loop {
    if cancelled() { return Err("音频分析已取消".into()); }
    if started.elapsed().as_secs() >= 8 { return Err("音频分析超时".into()); }
    let packet = match format.next_packet() {
      Ok(value) => value,
      Err(Error::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
      Err(_) => return Err("音频数据无法分析".into()),
    };
    if packet.track_id() != id { continue; }
    let decoded = match decoder.decode(&packet) {
      Ok(value) => value,
      Err(Error::DecodeError(_)) => continue,
      Err(_) => return Err("音频数据无法解码".into()),
    };
    let spec = *decoded.spec();
    if spec.rate == 0 || spec.rate > 384000 { return Err("音频采样率不支持分析".into()); }
    let output_rate = spec.rate.min(MAX_RATE);
    if rate != 0 && rate != output_rate { return Err("音频采样率发生变化".into()); }
    rate = output_rate;
    let channels = spec.channels.count();
    if channels == 0 || channels > 32 { return Err("音频声道数不支持分析".into()); }
    let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
    buffer.copy_interleaved_ref(decoded);
    for frame in buffer.samples().chunks_exact(channels) {
      phase += rate;
      if phase < spec.rate { continue; }
      phase -= spec.rate;
      let sample = frame.iter().copied().sum::<f32>() / channels as f32;
      samples.push(if sample.is_finite() { sample } else { 0.0 });
      if samples.len() >= rate as usize * SECONDS { break; }
    }
    if samples.len() >= rate as usize * SECONDS { break; }
  }
  if samples.len() < rate as usize || rate == 0 { return Err("音频片段过短，使用实时分析".into()); }
  // Header: version, sample rate, file modification nanos, file size (24 bytes).
  let mut bytes = Vec::with_capacity(24 + samples.len() * 4);
  bytes.extend(1u32.to_le_bytes());
  bytes.extend(rate.to_le_bytes());
  bytes.extend(modified.to_le_bytes());
  bytes.extend(metadata.len().to_le_bytes());
  for sample in samples { bytes.extend(sample.to_le_bytes()); }
  Ok(bytes)
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  #[ignore = "Requires generated audio fixtures in ZONE_AUDIO_FIXTURES"]
  fn supported_audio_format_windows() {
    let dir = std::path::PathBuf::from(std::env::var("ZONE_AUDIO_FIXTURES").expect("fixture directory"));
    for name in ["sample.mp3", "sample.flac", "sample.m4a", "sample.aac", "sample.wav", "sample.ogg", "alac.m4a"] {
      let bytes = decode_window(dir.join(name).to_str().unwrap(), || false)
        .unwrap_or_else(|error| panic!("{name}: {error}"));
      assert!(bytes.len() <= 24 + MAX_RATE as usize * SECONDS * 4);
      assert!(bytes[24..].chunks_exact(4).any(|sample| f32::from_le_bytes(sample.try_into().unwrap()).abs() > 0.01), "{name} decoded silence");
      eprintln!("{name}: {} bytes", bytes.len());
    }
  }
  #[test]
  fn wav_window_is_bounded_and_cancellable() {
    let dir = crate::podcast::test_support::test_directory("beat-window");
    let path = dir.join("sample.wav");
    let rate = 44100u32;
    let length = rate * 32 * 2;
    let mut bytes = Vec::new();
    bytes.extend(b"RIFF"); bytes.extend((36 + length).to_le_bytes()); bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes()); bytes.extend(1u16.to_le_bytes()); bytes.extend(1u16.to_le_bytes());
    bytes.extend(rate.to_le_bytes()); bytes.extend((rate * 2).to_le_bytes());
    bytes.extend(2u16.to_le_bytes()); bytes.extend(16u16.to_le_bytes()); bytes.extend(b"data");
    bytes.extend(length.to_le_bytes()); bytes.resize(44 + length as usize, 0);
    std::fs::write(&path, bytes).unwrap();
    let result = decode_window(path.to_str().unwrap(), || false).unwrap();
    assert_eq!(u32::from_le_bytes(result[4..8].try_into().unwrap()), MAX_RATE);
    assert_eq!(result.len(), 24 + MAX_RATE as usize * SECONDS * 4);
    assert!(decode_window(path.to_str().unwrap(), || true).unwrap_err().contains("取消"));
  }
}
