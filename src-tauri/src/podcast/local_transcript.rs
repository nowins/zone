use super::*;
use super::{local_config::{self, TranscriptionSettings}, transcripts::{TranscriptCue, TranscriptDocument}};
use serde_json::{json, Value};
use std::{ffi::OsStr, io::Read, sync::atomic::{AtomicBool, Ordering}, time::Instant};
use tauri::{Emitter, State};

const CHUNK_SECONDS: usize = 60;
const ENGINE_COMMIT: &str = "4979e04f5dcaccb36057e059bbaed8a2f5288315";
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop { fn drop(&mut self) { self.0.store(true, Ordering::Relaxed); } }
pub(crate) fn engine_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().resource_dir().map_err(|_| "无法定位本地引擎")?.join("whisper");
    verify_engine(&root)
}
pub(crate) fn verify_engine(root: &Path) -> Result<PathBuf, String> {
    if !local_config::plain(root, true) { return Err("此安装缺少本地 CPU 引擎，请使用含本地引擎的 Windows 版本".into()); }
    let path = root.join("zone-whisper.exe");
    let manifest = root.join("engine.json");
    if !local_config::plain(&manifest, false) || fs::metadata(&manifest).map_err(|_| "引擎清单不可读")?.len() > 8192 { return Err("本地引擎清单无效".into()); }
    let bytes = fs::read(manifest).map_err(|_| "无法读取引擎清单")?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "引擎清单格式无效")?;
    let size = fs::metadata(&path).map_err(|_| "本地引擎文件缺失")?.len();
    if value["commit"] != ENGINE_COMMIT || value["version"] != "1.8.2" || value["protocol"] != 1 || size > 64 * 1024 * 1024 || value["sha256"].as_str() != Some(local_config::checksum(&path, size)?.as_str()) {
        return Err("本地引擎版本或 SHA-256 校验失败，请修复安装；未上传音频".into());
    }
    Ok(path)
}
struct Workspace(PathBuf);
impl Workspace {
    fn create(db: &Path) -> Result<Self, String> {
        let root = local_config::directory(db, "podcast-local-work")?;
        recover_temporary_files(db)?;
        let path = root.join(format!("job-{}-{}", std::process::id(), unix_time_millis()));
        fs::create_dir(&path).map_err(|_| "无法创建处理临时目录，请检查磁盘空间")?;
        Ok(Self(path))
    }
}
pub(crate) fn recover_temporary_files(db: &Path) -> Result<(), String> {
    let root = db.parent().ok_or("无法定位本地处理目录")?.join("podcast-local-work");
    if !root.exists() { return Ok(()); }
    if !local_config::plain(&root, true) { return Err("本地处理目录必须为普通目录".into()); }
    // Single-instance startup or the single task owns this directory. Only our
    // exact ordinary files are removed; unknown files and reparse points stay.
    for entry in fs::read_dir(&root).map_err(|_| "无法检查本地处理目录")?.take(1000) {
        let entry = entry.map_err(|_| "无法读取本地处理目录")?;
        let name = entry.file_name(); let name = name.to_string_lossy();
        if name.strip_prefix("job-").is_some_and(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit() || c == b'-')) && local_config::plain(&entry.path(), true) { cleanup(&entry.path()); }
    }
    Ok(())
}
fn cleanup(path: &Path) {
    if !local_config::plain(path, true) { return; }
    for name in ["chunk.wav", "result.json", "progress.txt"] {
        let file = path.join(name); if local_config::plain(&file, false) { let _ = fs::remove_file(file); }
    }
    let _ = fs::remove_dir(path);
}
impl Drop for Workspace { fn drop(&mut self) { cleanup(&self.0); } }
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    if !local_config::plain(path, false) { return Err("本地引擎未生成有效结果".into()); }
    let mut output = Vec::new();
    fs::File::open(path).map_err(|_| "无法读取本地结果")?.take(limit + 1).read_to_end(&mut output).map_err(|_| "本地结果读取失败")?;
    if output.len() as u64 > limit { return Err("本地引擎结果过大，已有字幕保持不变".into()); }
    Ok(output)
}
fn parse_chunk(bytes: &[u8], offset: f64, duration: f64) -> Result<Vec<TranscriptCue>, String> {
    // Empty speech chunks are allowed; the final document must contain speech.
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "本地引擎结果格式无效")?;
    let segments = value["segments"].as_array().ok_or("本地引擎未返回时间段")?;
    if segments.is_empty() { return Ok(Vec::new()); }
    let mut cues = super::transcripts::parse_transcript(bytes, "application/json")?;
    for cue in &mut cues {
        let start = cue.start_seconds.ok_or("本地转写缺少开始时间")?;
        let end = cue.end_seconds.ok_or("本地转写缺少结束时间")?;
        if start < 0.0 || start >= duration || end > duration + 0.1 { return Err("本地转写时间超出音频分段，已有字幕保持不变".into()); }
        cue.start_seconds = Some(offset + start);
        cue.end_seconds = Some(offset + end.min(duration));
    }
    Ok(cues)
}
// Only exact digital zero counts as silence. Keep quiet speech, noise and even
// one non-zero PCM bit; this is deliberately not an amplitude threshold or VAD.
fn remove_digital_silence(cues: &mut Vec<TranscriptCue>, wav: &[u8], offset: f64) {
    let mut runs = Vec::new(); let mut begin = None;
    let samples = &wav[44..]; let frames = samples.len() / 2;
    for (index, sample) in samples.chunks_exact(2).enumerate() {
        if sample == [0, 0] { begin.get_or_insert(index); }
        else if let Some(start) = begin.take() { if index - start >= 6 * 16000 { runs.push((start, index)); } }
    }
    if let Some(start) = begin { if frames - start >= 6 * 16000 { runs.push((start, frames)); } }
    cues.retain(|cue| {
        let start = ((cue.start_seconds.unwrap() - offset) * 16000.0).floor() as usize;
        let end = ((cue.end_seconds.unwrap() - offset) * 16000.0).ceil() as usize;
        // Require three full seconds of exact silence on both sides. Retain
        // boundary cues and imprecise timestamps near any non-zero audio.
        start < 3 * 16000 || end + 3 * 16000 > frames || !runs.iter().any(|&(a, b)| a <= start - 3 * 16000 && end + 3 * 16000 <= b)
    });
}
#[cfg(windows)]
fn infer(engine: &Path, model: &Path, work: &Path, settings: &TranscriptionSettings, cancelled: &AtomicBool, mut progress: impl FnMut(u32)) -> Result<Vec<u8>, String> {
    let input = work.join("chunk.wav"); let output = work.join("result.json"); let report = work.join("progress.txt");
    for file in [&output, &report] { if local_config::plain(file, false) { fs::remove_file(file).map_err(|_| "无法清理上次处理结果")?; } }
    let threads = settings.threads.min(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)).to_string();
    let child = super::local_process::EngineProcess::start(engine, &[model.as_os_str(), input.as_os_str(), output.as_os_str(), OsStr::new(&settings.language), OsStr::new(&threads), report.as_os_str()], work)?;
    let start = Instant::now(); let mut previous = 0;
    loop {
        if cancelled.load(Ordering::Relaxed) { return Err("已取消本地转写，已有字幕保持不变".into()); }
        if start.elapsed() > Duration::from_secs(1800) { return Err("本地引擎处理单段超过 30 分钟，已停止".into()); }
        if let Some(code) = child.status()? {
            if code != 0 { return Err(format!("本地引擎处理失败（代码 {code}），请检查模型、内存及磁盘；已有字幕保持不变")); }
            break;
        }
        if let Ok(bytes) = read_bounded(&report, 16384) {
            if let Some(value) = std::str::from_utf8(&bytes).ok().and_then(|s| s.lines().last()).and_then(|s| s.parse::<u32>().ok()).filter(|n| *n <= 100) {
                if value > previous { previous = value; progress(value); }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    read_bounded(&output, 8 * 1024 * 1024)
}
#[cfg(not(windows))]
fn infer(_: &Path, _: &Path, _: &Path, _: &TranscriptionSettings, _: &AtomicBool, _: impl FnMut(u32)) -> Result<Vec<u8>, String> { Err("本地转写目前支持 Windows CPU".into()) }

pub(crate) fn transcribe_file(db: &Path, audio: &Path, engine: &Path, model: &Path, settings: &TranscriptionSettings, cancelled: &AtomicBool, mut progress: impl FnMut(f64, &str)) -> Result<Vec<TranscriptCue>, String> {
    let work = Workspace::create(db)?;
    if local_config::available_bytes(&work.0).is_some_and(|n| n < 32 * 1024 * 1024) { return Err("本地转写需至少 32 MiB 临时可用空间".into()); }
    let mut cues = Vec::new(); let mut text_bytes = 0;
    progress(0.0, "decode");
    super::pcm_export::decode_chunks(audio, 0.0, None, CHUNK_SECONDS, cancelled, |chunk| {
        if cancelled.load(Ordering::Relaxed) { return Err("已取消本地转写".into()); }
        if chunk.bytes[44..].iter().all(|byte| *byte == 0) { progress(chunk.start + chunk.duration, "decode"); return Ok(()); }
        fs::write(work.0.join("chunk.wav"), &chunk.bytes).map_err(|_| "无法保存临时音频，请检查磁盘空间")?;
        progress(chunk.start, "infer");
        let response = infer(engine, model, &work.0, settings, cancelled, |percent| progress(chunk.start + chunk.duration * percent as f64 / 100.0, "infer"))?;
        let mut next = parse_chunk(&response, chunk.start, chunk.duration)?;
        remove_digital_silence(&mut next, &chunk.bytes, chunk.start);
        text_bytes += next.iter().map(|cue| cue.text.len()).sum::<usize>();
        if cues.len() + next.len() > 20000 || text_bytes > 4 * 1024 * 1024 { return Err("本地转写结果超出上限，已有字幕保持不变".into()); }
        cues.extend(next); progress(chunk.start + chunk.duration, "decode");
        Ok(())
    })?;
    if cancelled.load(Ordering::Relaxed) { return Err("已取消本地转写".into()); }
    if cues.is_empty() { return Err("未识别到语音，已有字幕保持不变".into()); }
    Ok(cues)
}
async fn process(state: &PodcastState, app: &AppHandle, episode: &str, expected: &TranscriptionSettings) -> Result<TranscriptDocument, String> {
    let _permit = super::cloud_transcript::PROCESSING.get_or_init(Default::default).try_lock().map_err(|_| "已有转写或翻译正在处理，请先完成或取消")?;
    let current = local_config::settings(&state.db_path)?;
    if current != *expected || current.backend != "local" { return Err("转写设置已变化，请重新确认处理方式".into()); }
    let file_guard = EpisodeFileGuard::acquire(&state.active_downloads, episode)?;
    let detail = get_episode_detail(&state.db_path, &state.downloads_dir, episode)?;
    let enclosure = detail.episode.enclosure_url;
    let audio = PathBuf::from(detail.episode.local_path.ok_or("请先完整下载本集音频")?);
    if !is_managed_download_path(&state.downloads_dir, episode, &audio) || !local_config::plain(&audio, false) || !local_config::plain(&state.downloads_dir, true) { return Err("音频不在受控下载目录或不是普通文件".into()); }
    let db = state.db_path.clone(); let handle = app.clone(); let id = episode.to_owned();
    let cancelled = Arc::new(AtomicBool::new(false)); let worker_cancel = cancelled.clone(); let _cancel = CancelOnDrop(cancelled.clone());
    let mut worker = tauri::async_runtime::spawn_blocking(move || {
        // Keep the download/file guard alive until the decoder and child fully exit.
        let _guard = file_guard;
        let engine = engine_path(&handle)?;
        let model = local_config::verified_model(&db, &current.model_id)?;
        transcribe_file(&db, &audio, &engine, &model, &current, &worker_cancel, |seconds, stage| {
            let _ = handle.emit("podcast-local-progress", json!({"episodeId": id, "processedSeconds": seconds, "stage": stage}));
        })
    });
    let result = match network_io(&mut worker).await {
        Ok(value) => value.map_err(|_| "本地音频处理线程失败")?,
        Err(error) => { cancelled.store(true, Ordering::Relaxed); let _ = worker.await; return Err(error); }
    }?;
    network_io(std::future::ready(())).await?;
    let document = super::cloud_transcript::persist(&state.db_path, episode, &enclosure, "generated", &result)?;
    let _ = app.emit("podcast-library-changed", ());
    Ok(document)
}
#[tauri::command]
pub async fn podcast_generate_local_transcript(state: State<'_, PodcastState>, app: AppHandle, episode_id: String, expected_settings: TranscriptionSettings, request_id: String) -> Result<TranscriptDocument, String> {
    state.ensure_ready()?; validate_identifier(&episode_id)?; local_config::validate(&expected_settings)?;
    run_network_task(Some(&request_id), process(state.inner(), &app, &episode_id, &expected_settings)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::podcast::test_support::*;
    #[test]
    fn exact_silence_guard_keeps_even_one_pcm_bit_and_boundary_speech() {
        let cue = |start, end, text: &str| TranscriptCue { start_seconds: Some(60.0 + start), end_seconds: Some(60.0 + end), text: text.into(), speaker: None };
        let mut samples = vec![0i16; 60 * 16000]; samples[11 * 16000] = 1;
        let mut cues = vec![cue(0.0, 1.0, "boundary"), cue(10.0, 12.0, "quiet speech"), cue(31.0, 33.0, "silence hallucination")];
        remove_digital_silence(&mut cues, &super::super::pcm_export::wav(&samples), 60.0);
        assert_eq!(cues.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["boundary", "quiet speech"]);
    }
    #[test]
    fn chunk_offsets_use_media_time_and_invalid_results_preserve_old_data() {
        let bytes = r#"{"segments":[{"startTime":0.5,"endTime":2.0,"body":"你好 hello"}]}"#.as_bytes();
        let cues = parse_chunk(bytes, 60.0, 3.0).unwrap();
        assert_eq!(cues[0].start_seconds, Some(60.5)); assert_eq!(cues[0].end_seconds, Some(62.0));
        assert!(parse_chunk(bytes, 0.0, 1.0).is_err());
        assert!(parse_chunk(br#"{"segments":[{"body":"bad"}]}"#, 0.0, 2.0).is_err());
        let dir = test_directory("local-atomic"); let state = PodcastState::initialize_at(&dir).unwrap();
        let parsed = parsed_fixture_with_episode_count(1); let id = parsed.episodes[0].id.clone(); let enclosure = parsed.episodes[0].enclosure_url.clone();
        store_subscription(&state.db_path, parsed).unwrap();
        super::super::cloud_transcript::persist(&state.db_path, &id, &enclosure, "generated", &cues).unwrap();
        let work = Workspace::create(&state.db_path).unwrap(); fs::write(work.0.join("chunk.wav"), b"private fixture").unwrap(); let work_path = work.0.clone(); drop(work); assert!(!work_path.exists());
        assert_eq!(super::super::cloud_transcript::cached_generated(&state.db_path, &id, "generated").unwrap().unwrap().cues[0].text, "你好 hello");
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "Requires explicitly generated Windows speech fixtures and the verified real model"]
    fn real_native_cpu_recognizes_english_chinese_segments_and_cancels() {
        let fixture = PathBuf::from(std::env::var_os("ZONE_WHISPER_TEST_FIXTURES").expect("set synthetic fixture directory"));
        let marker_bytes = fs::read(fixture.join("synthetic-fixtures.json")).unwrap();
        let marker: Value = serde_json::from_slice(marker_bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&marker_bytes)).unwrap();
        assert_eq!(marker["source"], "Windows SpeechSynthesizer");
        let engine_root = PathBuf::from(std::env::var_os("ZONE_WHISPER_TEST_ENGINE").expect("set built engine directory"));
        let engine = verify_engine(&engine_root).unwrap();
        let dir = test_directory("real-local-whisper-中文 空格");
        let state = PodcastState::initialize_at(&dir).unwrap();
        local_config::import(&state.db_path, "base-q5_1", &fixture.join("ggml-base-q5_1.bin")).unwrap();
        let model = local_config::verified_model(&state.db_path, "base-q5_1").unwrap();
        let mut settings = TranscriptionSettings::default(); settings.backend = "local".into(); settings.language = "en".into();
        let cancelled = AtomicBool::new(false); let mut observations = Vec::new();
        let began = Instant::now();
        let english = transcribe_file(&state.db_path, &fixture.join("english.wav"), &engine, &model, &settings, &cancelled, |seconds, _| observations.push(seconds)).unwrap();
        let english_text = english.iter().map(|c| c.text.as_str()).collect::<String>().to_lowercase();
        assert!(english_text.contains("podcast") && english_text.contains("computer"), "{english_text}");
        settings.language = "zh".into();
        let chinese = transcribe_file(&state.db_path, &fixture.join("chinese.wav"), &engine, &model, &settings, &cancelled, |_, _| {}).unwrap();
        let chinese_text = chinese.iter().map(|c| c.text.as_str()).collect::<String>();
        assert!(chinese_text.contains("中文") && (chinese_text.contains("音频") || chinese_text.contains("音頻")), "{chinese_text}");
        let mut canonical = Vec::new();
        super::super::pcm_export::decode_chunks(&fixture.join("english.wav"), 0.0, None, 60, &cancelled, |chunk| { canonical = chunk.bytes[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect(); Ok(()) }).unwrap();
        let mut samples = vec![0i16; 75 * 16000];
        for start in [16000, 61 * 16000] { samples[start..start + canonical.len()].copy_from_slice(&canonical); }
        let segmented = dir.join("segments.wav"); fs::write(&segmented, super::super::pcm_export::wav(&samples)).unwrap();
        settings.language = "en".into();
        let segmented_cues = transcribe_file(&state.db_path, &segmented, &engine, &model, &settings, &cancelled, |_, _| {}).unwrap();
        assert!(segmented_cues.iter().any(|c| c.start_seconds.unwrap() >= 60.0 && c.text.to_lowercase().contains("podcast")), "second chunk must preserve its media offset");
        assert!(segmented_cues.iter().all(|c| c.end_seconds.unwrap() <= 75.0));
        assert!(!segmented_cues.iter().any(|c| c.start_seconds.unwrap() >= 15.0 && c.end_seconds.unwrap() <= 55.0), "exact long silence must not invent words");
        let cancel = Arc::new(AtomicBool::new(false)); let trigger = cancel.clone();
        let canceller = std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(700)); trigger.store(true, Ordering::Relaxed); });
        let cancel_started = Instant::now();
        let error = transcribe_file(&state.db_path, &segmented, &engine, &model, &settings, &cancel, |_, _| {}).unwrap_err();
        canceller.join().unwrap();
        assert!(error.contains("取消"), "{error}"); assert!(cancel_started.elapsed() < Duration::from_secs(5));
        assert_eq!(fs::read_dir(local_config::directory(&state.db_path, "podcast-local-work").unwrap()).unwrap().count(), 0);
        assert!(observations.len() > 2, "real inference must emit progress");
        let result = json!({"engine":engine_root,"modelSha256":local_config::model("base-q5_1").unwrap().sha256,"english":english,"chinese":chinese,"segmented":segmented_cues,"cancelled":true,"temporaryFilesCleaned":true,"elapsedSeconds":began.elapsed().as_secs_f64()});
        fs::write(fixture.join("native-result.json"), serde_json::to_vec_pretty(&result).unwrap()).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
