use super::*;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary { pub file_name: String, pub created_at: Option<i64>, pub audio_count: usize, pub automatic: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStorage { pub directory: String, pub latest: Option<BackupSummary>, pub history: Vec<BackupSummary>, pub schedule: super::scheduled::BackupSchedule, pub schedule_error: Option<String> }

pub(super) fn valid_backup_name(name:&str)->bool {
  name.len()<=150&&name.strip_prefix("Zone播客备份-").and_then(|rest|rest.strip_suffix(".zonepodcast")).is_some_and(|rest|!rest.is_empty()&&rest.chars().all(|c|c.is_ascii_hexdigit()||c=='-'))
}

pub(super) fn managed_backup_directory(state: &PodcastState, create: bool) -> Result<PathBuf, String> {
  let base = state.db_path.parent().ok_or("Zone 工作目录不可用")?.canonicalize().map_err(|_| "Zone 工作目录不可访问")?;
  let folder = base.join("podcast-backups");
  if !folder.exists() && create {
    match fs::create_dir(&folder) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}, Err(_) => return Err("无法创建播客备份目录".into()) }
  }
  match fs::symlink_metadata(&folder) {
    Ok(metadata) => {
      if !metadata.is_dir() || metadata.file_type().is_symlink() || folder.canonicalize().map_err(|_| "备份目录不可访问")? != folder { return Err("播客备份目录不是受控普通目录".into()); }
    },
    Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => {},
    Err(_) => return Err("播客备份目录不可访问".into()),
  }
  Ok(folder)
}

fn backup_storage(state: &PodcastState) -> Result<BackupStorage, String> {
  let folder = managed_backup_directory(state, false)?;
  let mut candidates = Vec::new();
  if folder.exists() {
    for (index, entry) in fs::read_dir(&folder).map_err(|_| "无法读取备份目录")?.enumerate() {
      if index >= 1024 { return Err("本机备份较多，请先整理备份目录".into()); }
      let entry = entry.map_err(|_| "无法读取备份文件")?;
      let name = entry.file_name().to_string_lossy().into_owned();
      if !valid_backup_name(&name) { continue; }
      let metadata = fs::symlink_metadata(entry.path()).map_err(|_| "无法读取备份文件")?;
      if metadata.is_file() && !metadata.file_type().is_symlink() { candidates.push((metadata.modified().ok(), entry.path(), name)); }
    }
  }
  candidates.sort_by(|left, right| right.0.cmp(&left.0));
  let local=super::scheduled::read_local(state)?;
  let automatic=local.automatic.iter().map(|item|item.name.as_str()).collect::<HashSet<_>>();
  let mut history = candidates.into_iter().take(40).filter_map(|(_, path, file_name)| {
    let backup = read_backup(&path).ok()?;
    (backup.format == "ZonePodcastBackup" && backup.version == 1).then(||BackupSummary { automatic:automatic.contains(file_name.as_str()),file_name, created_at: backup.created_at, audio_count: backup.media.len() })
  }).collect::<Vec<_>>();
  let latest=history.first().map(|item|BackupSummary{file_name:item.file_name.clone(),created_at:item.created_at,audio_count:item.audio_count,automatic:item.automatic});
  history.truncate(40);
  Ok(BackupStorage { directory: folder.to_string_lossy().into_owned(), latest,history,schedule:local.schedule,schedule_error:local.error })
}

pub(super) fn create_managed_backup(state: &PodcastState, frontend: BTreeMap<String, String>, include_audio: bool) -> Result<BackupExportResult, String> {
  let folder = managed_backup_directory(state, true)?;
  let id = super::super::lists::new_collection_id("backup", &state.db_path.to_string_lossy());
  let path = folder.join(format!("Zone播客备份-{}-{}.zonepodcast", unix_time_millis(), &id[..10]));
  // Reserve a new destination; failures may clean up only files owned by this operation.
  let reservation = fs::OpenOptions::new().create_new(true).write(true).open(&path).map_err(|_| "无法创建本机备份")?;
  drop(reservation);
  let mut owned = CopiedFiles { files: vec![path.clone()], directories: vec![], committed: false };
  export_backup(state, &path, frontend, include_audio)?;
  owned.committed = true;
  let count = read_backup(&path)?.media.len();
  super::preview::remember_backup_location(state, &path, count)
}

#[tauri::command]
pub async fn podcast_create_backup(state: State<'_, PodcastState>, frontend_settings: BTreeMap<String, String>, include_audio: bool) -> Result<BackupExportResult, String> {
  state.ensure_ready()?; let state = state.inner().clone();
  tauri::async_runtime::spawn_blocking(move || {let _lock=super::scheduled::backup_lock().lock().map_err(|_|"备份任务锁不可用")?;create_managed_backup(&state, frontend_settings, include_audio)}).await.map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn podcast_get_backup_storage(state: State<'_, PodcastState>) -> Result<BackupStorage, String> {
  state.ensure_ready()?; let state = state.inner().clone();
  tauri::async_runtime::spawn_blocking(move || backup_storage(&state)).await.map_err(|error| error.to_string())?
}
#[tauri::command]
pub fn podcast_open_managed_backup_folder(app: tauri::AppHandle, state: State<'_, PodcastState>) -> Result<(), String> {
  state.ensure_ready()?;
  let folder = managed_backup_directory(&state, true)?;
  app.opener().open_path(folder.to_string_lossy().into_owned(), None::<&str>).map_err(|_| "无法打开本机备份目录".into())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  #[test]
  fn managed_backups_use_the_app_directory_preserve_prior_snapshots_and_optional_audio() {
    let dir = test_directory("managed-backups"); let state = PodcastState::initialize_at(&dir).unwrap();
    assert!(backup_storage(&state).unwrap().latest.is_none()); assert!(!dir.join("podcast-backups").exists());
    let parsed = parsed_fixture("https://example.com/a.mp3"); let id = parsed.episodes[0].id.clone(); store_subscription(&state.db_path, parsed).unwrap();
    let audio = state.downloads_dir.join(format!("{id}.mp3")); fs::write(&audio, b"audio").unwrap(); mark_download_complete(&state.db_path, &id, &audio.to_string_lossy(), 5, Some(5)).unwrap();
    let first = create_managed_backup(&state, BTreeMap::new(), false).unwrap();
    let folder = managed_backup_directory(&state, false).unwrap(); let first_path = folder.join(&first.file_name); let original = fs::read(&first_path).unwrap();
    assert_eq!(first.audio_count, 0);
    let second = create_managed_backup(&state, BTreeMap::new(), true).unwrap(); assert_eq!(second.audio_count, 1); assert_ne!(first.file_name, second.file_name);
    assert_eq!(fs::read(first_path).unwrap(), original); assert_eq!(fs::read(audio).unwrap(), b"audio");
    let latest = backup_storage(&state).unwrap().latest.unwrap(); assert_eq!(latest.file_name, second.file_name); assert_eq!(latest.audio_count, 1);
    let preview = super::super::preview::create_backup_preview(&state, &folder.join(second.file_name)).unwrap(); assert_eq!(preview.audio_bytes, 5);
  }
  #[test]
  fn managed_backup_failure_removes_only_its_reserved_file_and_rejects_invalid_roots() {
    let dir = test_directory("managed-backup-failure"); let state = PodcastState::initialize_at(&dir).unwrap();
    let result = create_managed_backup(&state, BTreeMap::from([("music.secret".into(), "value".into())]), false); assert!(result.is_err());
    let folder = managed_backup_directory(&state, false).unwrap(); assert_eq!(fs::read_dir(&folder).unwrap().count(), 0);
    fs::remove_dir(&folder).unwrap(); fs::write(&folder, b"unrelated").unwrap();
    assert!(create_managed_backup(&state, BTreeMap::new(), false).is_err()); assert_eq!(fs::read(&folder).unwrap(), b"unrelated");
  }
}
