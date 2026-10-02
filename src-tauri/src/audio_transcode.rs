//! Bounded, lossless ALAC compatibility cache for WebView2 playback.
use std::{fs::{self, File}, io::{BufWriter, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant, UNIX_EPOCH}};
use sha2::{Digest, Sha256};
use symphonia::core::{audio::SampleBuffer, codecs::{DecoderOptions, CODEC_TYPE_ALAC}, errors::Error, formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};

const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 2 * MAX_OUTPUT_BYTES;
const MAX_DECODE_TIME: Duration = Duration::from_secs(60);
static TRANSCODE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn playback_path(source: &Path, cache_dir: &Path) -> Result<PathBuf, String> {
  if !source.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("m4a")) {
    return Ok(source.to_path_buf());
  }
  let metadata = fs::metadata(source).map_err(|_| "无法读取音频文件")?;
  if metadata.len() > MAX_SOURCE_BYTES { return Err("音频文件超出兼容解码大小上限".into()); }
  let mut hint = Hint::new();
  hint.with_extension("m4a");
  let stream = MediaSourceStream::new(Box::new(File::open(source).map_err(|_| "无法打开音频文件")?), Default::default());
  let probed = symphonia::default::get_probe().format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
    .map_err(|_| "音频文件格式无法识别")?;
  let mut format = probed.format;
  let track = format.default_track().ok_or("音频文件没有音轨")?;
  if track.codec_params.codec != CODEC_TYPE_ALAC { return Ok(source.to_path_buf()); }
  let track_id = track.id;
  let params = track.codec_params.clone();
  let mut digest = Sha256::new();
  digest.update(b"zone-alac-pcm32-v1");
  digest.update(fs::canonicalize(source).map_err(|_| "无法定位音频文件")?.to_string_lossy().as_bytes());
  digest.update(metadata.len().to_le_bytes());
  digest.update(metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|time| time.as_nanos()).unwrap_or(0).to_le_bytes());
  let key = format!("{:x}", digest.finalize());
  let output = cache_dir.join(format!("{key}.wav"));
  let _guard = TRANSCODE_LOCK.lock().map_err(|_| "音频兼容缓存暂不可用")?;
  fs::create_dir_all(cache_dir).map_err(|_| "无法创建音频兼容缓存")?;
  if fs::metadata(&output).is_ok_and(|entry| entry.is_file() && entry.len() >= 44 && entry.len() <= MAX_OUTPUT_BYTES + 44) {
    return Ok(output);
  }
  prune_cache(cache_dir, &output, MAX_OUTPUT_BYTES);
  let partial = output.with_extension("part");
  let result = (|| -> Result<(), String> {
    let mut writer = BufWriter::new(File::create(&partial).map_err(|_| "无法写入音频兼容缓存")?);
    writer.write_all(&[0; 44]).map_err(|_| "无法写入音频兼容缓存")?;
    let mut decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).map_err(|_| "无法解码 ALAC 音频")?;
    let start = Instant::now();
    let mut bytes = 0u64;
    let mut frames = 0u64;
    let mut output_spec = None;
    loop {
      if start.elapsed() > MAX_DECODE_TIME { return Err("音频兼容解码超时".into()); }
      let packet = match format.next_packet() {
        Ok(packet) => packet,
        Err(Error::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
        Err(_) => return Err("音频文件损坏，无法完成解码".into()),
      };
      if packet.track_id() != track_id { continue; }
      let decoded = decoder.decode(&packet).map_err(|_| "音频文件损坏，无法完成解码")?;
      let spec = (decoded.spec().rate, decoded.spec().channels.count());
      validate_spec(spec.0, spec.1)?;
      if output_spec.is_some_and(|previous| previous != spec) || decoded.capacity() > 65536 {
        return Err("音频参数超出兼容解码范围".into());
      }
      output_spec = Some(spec);
      frames = frames.saturating_add(decoded.frames() as u64);
      let mut samples = SampleBuffer::<i32>::new(decoded.capacity() as u64, *decoded.spec());
      samples.copy_interleaved_ref(decoded);
      bytes = bytes.checked_add(samples.samples().len() as u64 * 4).ok_or("音频兼容缓存过大")?;
      if bytes > MAX_OUTPUT_BYTES { return Err("音频兼容缓存超出大小上限".into()); }
      for sample in samples.samples() {
        writer.write_all(&sample.to_le_bytes()).map_err(|_| "无法写入音频兼容缓存")?;
      }
    }
    if bytes == 0 || params.n_frames.is_some_and(|expected| frames < expected) {
      return Err("音频文件不完整，无法完成解码".into());
    }
    let (rate, channels) = output_spec.ok_or("音频文件没有可解码内容")?;
    writer.seek(SeekFrom::Start(0)).map_err(|_| "无法完成音频兼容缓存")?;
    writer.write_all(&wav_header(rate, channels as u16, bytes as u32)).map_err(|_| "无法完成音频兼容缓存")?;
    writer.flush().map_err(|_| "无法完成音频兼容缓存")?;
    writer.get_ref().sync_all().map_err(|_| "无法完成音频兼容缓存")?;
    drop(writer);
    fs::rename(&partial, &output).map_err(|_| "无法保存音频兼容缓存")?;
    Ok(())
  })();
  if result.is_err() { let _ = fs::remove_file(&partial); }
  result?;
  Ok(output)
}

fn validate_spec(rate: u32, channels: usize) -> Result<(), String> {
  if rate == 0 || rate > 192000 || !(1..=2).contains(&channels) {
    Err("ALAC 兼容播放支持最高 192 kHz 的单声道或双声道音频".into())
  } else { Ok(()) }
}

fn wav_header(rate: u32, channels: u16, bytes: u32) -> [u8; 44] {
  let mut header = [0; 44];
  header[0..4].copy_from_slice(b"RIFF");
  header[4..8].copy_from_slice(&(36 + bytes).to_le_bytes());
  header[8..16].copy_from_slice(b"WAVEfmt ");
  header[16..20].copy_from_slice(&16u32.to_le_bytes());
  header[20..22].copy_from_slice(&1u16.to_le_bytes());
  header[22..24].copy_from_slice(&channels.to_le_bytes());
  header[24..28].copy_from_slice(&rate.to_le_bytes());
  header[28..32].copy_from_slice(&(rate * u32::from(channels) * 4).to_le_bytes());
  header[32..34].copy_from_slice(&(channels * 4).to_le_bytes());
  header[34..36].copy_from_slice(&32u16.to_le_bytes());
  header[36..40].copy_from_slice(b"data");
  header[40..44].copy_from_slice(&bytes.to_le_bytes());
  header
}

fn prune_cache(directory: &Path, keep: &Path, reserve: u64) {
  let Ok(entries) = fs::read_dir(directory) else { return; };
  let mut entries: Vec<_> = entries.filter_map(Result::ok).filter_map(|entry| {
    let path = entry.path();
    let name = path.file_stem()?.to_str()?;
    if path == keep || path.extension()? != "wav" || name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() { return None; }
    Some((path, metadata.len(), metadata.modified().unwrap_or(UNIX_EPOCH)))
  }).collect();
  entries.sort_by_key(|entry| entry.2);
  let mut total: u64 = entries.iter().map(|entry| entry.1).sum();
  for (path, bytes, _) in entries {
    if total.saturating_add(reserve) <= MAX_CACHE_BYTES { break; }
    if fs::remove_file(path).is_ok() { total = total.saturating_sub(bytes); }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn pcm_header_and_decoder_limits_are_consistent() {
    let header = wav_header(44100, 2, 352800);
    assert_eq!(&header[0..4], b"RIFF");
    assert_eq!(u32::from_le_bytes(header[28..32].try_into().unwrap()), 352800);
    assert_eq!(u32::from_le_bytes(header[4..8].try_into().unwrap()), 352836);
    assert!(validate_spec(0, 2).is_err());
    assert!(validate_spec(192001, 2).is_err());
    assert!(validate_spec(44100, 8).is_err());
  }
  #[test]
  fn cache_pruning_only_removes_owned_wav_files() {
    let directory = std::env::temp_dir().join(format!("zone-alac-prune-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let owned = directory.join(format!("{}.wav", "a".repeat(64)));
    let unrelated = directory.join("keep.wav");
    fs::write(&owned, [0; 44]).unwrap();
    fs::write(&unrelated, [0; 44]).unwrap();
    prune_cache(&directory, &directory.join("new.wav"), MAX_CACHE_BYTES);
    assert!(!owned.exists());
    assert!(unrelated.exists());
    fs::remove_dir_all(directory).unwrap();
  }
  #[test]
  #[ignore = "requires ZONE_AUDIO_FIXTURES containing a real ALAC M4A"]
  fn real_alac_is_lossless_cached_and_range_ready() {
    let source = PathBuf::from(std::env::var("ZONE_AUDIO_FIXTURES").expect("fixtures")).join("alac.m4a");
    let cache = std::env::temp_dir().join(format!("zone-alac-test-{}", std::process::id()));
    let output = playback_path(&source, &cache).expect("decode");
    let bytes = fs::read(&output).unwrap();
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(&bytes[34..36], &32u16.to_le_bytes());
    assert!(bytes[44..].iter().any(|value| *value != 0));
    let modified = fs::metadata(&output).unwrap().modified().unwrap();
    assert_eq!(playback_path(&source, &cache).unwrap(), output);
    assert_eq!(fs::metadata(&output).unwrap().modified().unwrap(), modified);
    fs::remove_dir_all(cache).unwrap();
  }
}
