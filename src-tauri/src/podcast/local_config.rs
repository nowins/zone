use super::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use tauri::State;

const KEY: &str = "private.podcast.transcription.v1";
pub(crate) const MODEL_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionSettings {
    pub backend: String,
    pub model_id: String,
    pub language: String,
    pub threads: usize,
}
impl Default for TranscriptionSettings {
    fn default() -> Self {
        Self { backend: "cloud".into(), model_id: "base-q5_1".into(), language: "auto".into(), threads: 4 }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: &'static str,
    pub filename: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    pub installed: bool,
    pub source_url: String,
}
pub(crate) fn models() -> Vec<LocalModel> {
    [
        ("tiny-q5_1", "ggml-tiny-q5_1.bin", 32152673, "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7"),
        ("base-q5_1", "ggml-base-q5_1.bin", 59707625, "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898"),
    ].into_iter().map(|(id, filename, bytes, sha256)| LocalModel {
        id, filename, bytes, sha256, installed: false,
        source_url: format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/{MODEL_REVISION}/{filename}"),
    }).collect()
}
pub(crate) fn model(id: &str) -> Result<LocalModel, String> {
    models().into_iter().find(|m| m.id == id).ok_or_else(|| "请选择受支持的多语言模型".into())
}
pub(crate) fn validate(settings: &TranscriptionSettings) -> Result<(), String> {
    if !matches!(settings.backend.as_str(), "local" | "cloud") || !matches!(settings.language.as_str(), "auto" | "zh" | "en") || !(1..=8).contains(&settings.threads) {
        return Err("转写方式、语言或线程数无效".into());
    }
    model(&settings.model_id)?;
    Ok(())
}
pub(crate) fn settings(path: &Path) -> Result<TranscriptionSettings, String> {
    let db = open_database(path)?;
    let saved: Option<String> = db.query_row("SELECT value_json FROM app_settings WHERE key=?1", [KEY], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    let value = saved.map(|s| serde_json::from_str(&s).map_err(|_| "转写设置损坏，原记录已保留".to_string())).transpose()?.unwrap_or_default();
    validate(&value)?;
    Ok(value)
}
pub(crate) fn save(path: &Path, value: &TranscriptionSettings) -> Result<(), String> {
    validate(value)?;
    open_database(path)?.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", params![KEY, serde_json::to_string(value).map_err(|e| e.to_string())?, unix_time_millis()]).map_err(|e| e.to_string())?;
    Ok(())
}
// Reject junctions as well as symbolic links before reading or deleting managed files.
pub(crate) fn plain(path: &Path, directory: bool) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else { return false; };
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return false; }
    }
    !meta.file_type().is_symlink() && if directory { meta.is_dir() } else { meta.is_file() }
}
pub(crate) fn directory(db: &Path, name: &str) -> Result<PathBuf, String> {
    let parent = db.parent().ok_or("无法定位本地模型目录")?;
    let root = parent.join(name);
    if !plain(parent, true) { return Err("用户数据目录不可用".into()); }
    if !root.exists() { fs::create_dir(&root).map_err(|_| "无法创建本地转写目录，请检查磁盘和权限")?; }
    if !plain(&root, true) { return Err("本地转写目录必须为普通目录".into()); }
    Ok(root)
}
pub(crate) fn checksum(path: &Path, bytes: u64) -> Result<String, String> {
    if !plain(path, false) || fs::metadata(path).map_err(|_| "无法读取模型")?.len() != bytes { return Err("模型大小不匹配，请使用所选官方多语言模型".into()); }
    let mut input = fs::File::open(path).map_err(|_| "无法读取模型文件")?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let n = input.read(&mut buffer).map_err(|_| "模型读取失败")?;
        if n == 0 { break; }
        count += n as u64;
        if count > bytes { return Err("模型大小发生变化".into()); }
        hash.update(&buffer[..n]);
    }
    if count != bytes { return Err("模型文件不完整".into()); }
    Ok(format!("{:x}", hash.finalize()))
}
pub(crate) fn verified_model(db: &Path, id: &str) -> Result<PathBuf, String> {
    let selected = model(id)?;
    let path = directory(db, "podcast-models")?.join(selected.filename);
    if checksum(&path, selected.bytes)? != selected.sha256 { return Err("模型 SHA-256 校验失败，请重新导入；已有字幕保持不变".into()); }
    Ok(path)
}
pub(crate) fn available_bytes(path: &Path) -> Option<u64> {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDiskFreeSpaceExW};
        let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free = 0;
        if unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None) }.is_ok() { return Some(free); }
    }
    None
}
struct PartialFile(PathBuf);
impl Drop for PartialFile { fn drop(&mut self) { let _ = fs::remove_file(&self.0); } }
pub(crate) fn import(db: &Path, id: &str, source: &Path) -> Result<(), String> {
    let selected = model(id)?;
    let root = directory(db, "podcast-models")?;
    if available_bytes(&root).is_some_and(|free| free < selected.bytes + 32 * 1024 * 1024) { return Err("磁盘可用空间不足：导入需模型大小及额外 32 MiB".into()); }
    if checksum(source, selected.bytes)? != selected.sha256 { return Err("模型 SHA-256 不匹配，未导入；仅接受列表中的官方多语言模型".into()); }
    let destination = root.join(selected.filename);
    if destination.exists() {
        if verified_model(db, id).is_ok() { return Ok(()); }
        return Err("同名模型已损坏，请先在模型目录移走该文件后重试".into());
    }
    let temporary = root.join(format!("import-{}-{}.part", std::process::id(), unix_time_millis()));
    let _cleanup = PartialFile(temporary.clone());
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "无法创建模型临时文件")?;
    let mut input = fs::File::open(source).map_err(|_| "无法读取模型文件")?;
    let copied = std::io::copy(&mut Read::by_ref(&mut input).take(selected.bytes + 1), &mut output).map_err(|_| "模型复制失败，请检查磁盘空间")?;
    output.flush().and_then(|_| output.sync_all()).map_err(|_| "模型保存失败，请检查磁盘空间")?;
    drop(output);
    if copied != selected.bytes || checksum(&temporary, selected.bytes)? != selected.sha256 { return Err("复制后模型校验失败，未导入".into()); }
    // A hard link creates the final name atomically without overwriting anything.
    fs::hard_link(&temporary, &destination).map_err(|_| "无法原子保存模型（目录需支持硬链接），已有文件保持不变")?;
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub settings: TranscriptionSettings,
    pub models: Vec<LocalModel>,
    pub model_directory: String,
    pub available_bytes: Option<u64>,
    pub engine_ready: bool,
    pub engine_error: Option<String>,
}
fn status(db: &Path, app: &AppHandle) -> Result<LocalStatus, String> {
    let root = directory(db, "podcast-models")?;
    let mut available = models();
    for m in &mut available { m.installed = plain(&root.join(m.filename), false) && fs::metadata(root.join(m.filename)).is_ok_and(|v| v.len() == m.bytes); }
    let engine_error = super::local_transcript::engine_path(app).err();
    Ok(LocalStatus { settings: settings(db)?, models: available, model_directory: root.to_string_lossy().into(), available_bytes: available_bytes(&root), engine_ready: engine_error.is_none(), engine_error })
}
#[tauri::command]
pub async fn podcast_local_transcription_status(state: State<'_, PodcastState>, app: AppHandle) -> Result<LocalStatus, String> {
    state.ensure_ready()?;
    let db = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || status(&db, &app)).await.map_err(|_| "读取本地转写设置失败")?
}
#[tauri::command]
pub async fn podcast_set_transcription_settings(state: State<'_, PodcastState>, value: TranscriptionSettings) -> Result<(), String> {
    state.ensure_ready()?;
    let db = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || save(&db, &value)).await.map_err(|_| "保存转写设置失败")?
}
#[tauri::command]
pub async fn podcast_import_local_model(state: State<'_, PodcastState>, app: AppHandle, model_id: String) -> Result<LocalStatus, String> {
    state.ensure_ready()?;
    model(&model_id)?;
    let db = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = rfd::FileDialog::new().set_title("导入官方多语言 Whisper GGML 模型").add_filter("Whisper GGML 模型", &["bin"]).pick_file() { import(&db, &model_id, &path)?; }
        status(&db, &app)
    }).await.map_err(|_| "模型导入线程失败")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::podcast::test_support::*;
    #[test]
    fn settings_stay_local_and_invalid_import_preserves_files() {
        let dir = test_directory("local-settings");
        let state = PodcastState::initialize_at(&dir).unwrap();
        assert_eq!(settings(&state.db_path).unwrap().backend, "cloud");
        let mut value = TranscriptionSettings::default(); value.backend = "local".into();
        save(&state.db_path, &value).unwrap();
        assert_eq!(settings(&state.db_path).unwrap(), value);
        value.threads = 99; assert!(save(&state.db_path, &value).is_err());
        let source = dir.join("untrusted.bin"); fs::write(&source, b"not a model").unwrap();
        assert!(import(&state.db_path, "base-q5_1", &source).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"not a model");
        assert_eq!(fs::read_dir(directory(&state.db_path, "podcast-models").unwrap()).unwrap().count(), 0);
        let backup = dir.join("snapshot.zonepodcast");
        export_backup(&state, &backup, Default::default(), false).unwrap();
        assert!(!fs::read_to_string(backup).unwrap().contains(KEY));
        fs::remove_dir_all(dir).unwrap();
    }
}
