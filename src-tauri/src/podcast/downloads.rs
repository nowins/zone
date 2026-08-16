use reqwest::header;
use reqwest::StatusCode;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use super::*;

#[derive(Debug)]
pub(crate) struct EpisodeDownloadSource {
  pub(crate) enclosure_url: String,
  pub(crate) enclosure_type: Option<String>,
  pub(crate) local_path: Option<String>,
  pub(crate) downloaded_bytes: u64,
}
pub(crate) struct EpisodeFileGuard {
  pub(crate) episode_id: String,
  pub(crate) active_downloads: Arc<Mutex<HashSet<String>>>,
}

impl EpisodeFileGuard {
  pub(crate) fn acquire(active_downloads: &Arc<Mutex<HashSet<String>>>, episode_id: &str) -> Result<Self, String> {
    let mut active = active_downloads
      .lock()
      .map_err(|_| "播客下载状态不可用".to_string())?;
    if !active.insert(episode_id.to_string()) {
      return Err("该播客单集正在下载或清理".to_string());
    }
    drop(active);
    Ok(Self {
      episode_id: episode_id.to_string(),
      active_downloads: active_downloads.clone(),
    })
  }

  pub(crate) fn acquire_many(
    active_downloads: &Arc<Mutex<HashSet<String>>>,
    episode_ids: &[String],
  ) -> Result<Vec<Self>, String> {
    let mut active = active_downloads
      .lock()
      .map_err(|_| "播客下载状态不可用".to_string())?;
    if episode_ids
      .iter()
      .any(|episode_id| active.contains(episode_id))
    {
      return Err("所选播客单集中有项目正在下载或清理".to_string());
    }
    for episode_id in episode_ids {
      active.insert(episode_id.clone());
    }
    let guards = episode_ids
      .iter()
      .map(|episode_id| Self {
        episode_id: episode_id.clone(),
        active_downloads: active_downloads.clone(),
      })
      .collect();
    drop(active);
    Ok(guards)
  }
}

impl Drop for EpisodeFileGuard {
  fn drop(&mut self) {
    if let Ok(mut active) = self.active_downloads.lock() {
      active.remove(&self.episode_id);
    }
  }
}
pub(crate) struct FeedRefreshGuard {
  pub(crate) feed_id: String,
  pub(crate) active_refreshes: Arc<Mutex<HashSet<String>>>,
}

impl FeedRefreshGuard {
  pub(crate) fn acquire(
    active_refreshes: &Arc<Mutex<HashSet<String>>>,
    feed_id: &str,
  ) -> Result<Option<Self>, String> {
    let mut active = active_refreshes
      .lock()
      .map_err(|_| "播客刷新状态不可用".to_string())?;
    if !active.insert(feed_id.to_string()) {
      return Ok(None);
    }
    drop(active);
    Ok(Some(Self {
      feed_id: feed_id.to_string(),
      active_refreshes: active_refreshes.clone(),
    }))
  }
}

impl Drop for FeedRefreshGuard {
  fn drop(&mut self) {
    if let Ok(mut active) = self.active_refreshes.lock() {
      active.remove(&self.feed_id);
    }
  }
}
pub(crate) fn load_episode_download_source(db_path: &Path, episode_id: &str) -> Result<EpisodeDownloadSource, String> {
  let connection = open_database(db_path)?;
  connection
    .query_row(
      "
      SELECT
        e.enclosure_url, e.enclosure_type, d.local_path,
        COALESCE(d.downloaded_bytes, 0)
      FROM podcast_episodes e
      LEFT JOIN podcast_downloads d ON d.episode_id = e.id
      WHERE e.id = ?1
      ",
      [episode_id],
      |row| {
        Ok(EpisodeDownloadSource {
          enclosure_url: row.get(0)?,
          enclosure_type: row.get(1)?,
          local_path: row.get(2)?,
          downloaded_bytes: row.get::<_, i64>(3)?.max(0) as u64,
        })
      },
    )
    .optional()
    .map_err(|error| format!("无法读取播客下载信息：{error}"))?
    .ok_or_else(|| "播客单集不存在".to_string())
}

pub(crate) fn remove_file_if_present(path: &Path, label: &str) -> Result<(), String> {
  match fs::remove_file(path) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(format!("无法删除{label}：{error}")),
  }
}

// Startup cleanup for files no database row can account for: episodes pruned
// in the narrow window before a download registers, commits finished between
// file staging and deletion, or crash residue from .zone-delete staging dirs.
// Runs at PodcastState construction, when no download can be in flight, and
// never touches files whose episode still exists (a .part file is resume
// state for a failed download).
pub(crate) fn sweep_orphan_download_files(db_path: &Path, downloads_dir: &Path) -> Result<(), String> {
  let read_dir = match fs::read_dir(downloads_dir) {
    Ok(read_dir) => read_dir,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(error) => return Err(format!("无法检查播客下载目录：{error}")),
  };
  let mut candidates: Vec<(String, PathBuf)> = Vec::new();
  let mut stale_staging_dirs: Vec<PathBuf> = Vec::new();
  for entry in read_dir {
    let entry = entry.map_err(|error| format!("无法检查播客下载目录：{error}"))?;
    let file_type = entry
      .file_type()
      .map_err(|error| format!("无法检查播客下载文件：{error}"))?;
    let path = entry.path();
    if file_type.is_dir() {
      if entry.file_name().to_string_lossy().starts_with(".zone-delete-") {
        stale_staging_dirs.push(path);
      }
      continue;
    }
    if !file_type.is_file() {
      continue;
    }
    let extension = path
      .extension()
      .and_then(|value| value.to_str())
      .map(|value| value.to_ascii_lowercase())
      .unwrap_or_default();
    if extension != "part" && !matches!(
      extension.as_str(),
      "mp3" | "flac" | "m4a" | "aac" | "wav" | "ogg"
    ) {
      continue;
    }
    let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
      continue;
    };
    if validate_identifier(stem).is_err() {
      continue;
    }
    candidates.push((stem.to_string(), path));
  }
  for staging_dir in stale_staging_dirs {
    fs::remove_dir_all(&staging_dir)
      .map_err(|error| format!("无法清理播客下载暂存目录：{error}"))?;
  }
  if candidates.is_empty() {
    return Ok(());
  }

  let connection = open_database(db_path)?;
  let mut surviving_ids: HashSet<String> = HashSet::new();
  let candidate_ids: Vec<&str> = candidates
    .iter()
    .map(|(episode_id, _)| episode_id.as_str())
    .collect();
  for chunk in candidate_ids.chunks(500) {
    let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT id FROM podcast_episodes WHERE id IN ({placeholders})");
    let mut statement = connection
      .prepare(&sql)
      .map_err(|error| format!("无法核对播客下载文件：{error}"))?;
    let rows = statement
      .query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
        row.get::<_, String>(0)
      })
      .map_err(|error| format!("无法核对播客下载文件：{error}"))?;
    for row in rows {
      surviving_ids.insert(row.map_err(|error| format!("无法核对播客下载文件：{error}"))?);
    }
  }
  for (episode_id, path) in candidates {
    if surviving_ids.contains(&episode_id) {
      continue;
    }
    remove_file_if_present(&path, "播客遗留下载文件")?;
  }
  Ok(())
}

pub(crate) fn delete_episode_download(
  db_path: &Path,
  downloads_dir: &Path,
  episode_id: &str,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  ensure_episode_exists(&connection, episode_id)?;
  let local_path = connection
    .query_row(
      "SELECT local_path FROM podcast_downloads WHERE episode_id = ?1",
      [episode_id],
      |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|error| format!("无法读取播客下载信息：{error}"))?
    .flatten();

  if let Some(local_path) = local_path {
    let path = PathBuf::from(local_path);
    if is_managed_download_path(downloads_dir, episode_id, &path) {
      remove_file_if_present(&path, "播客下载")?;
    }
  }
  remove_file_if_present(
    &downloads_dir.join(format!("{episode_id}.part")),
    "播客下载临时文件",
  )?;
  connection
    .execute(
      "DELETE FROM podcast_downloads WHERE episode_id = ?1",
      [episode_id],
    )
    .map_err(|error| format!("无法清除播客下载记录：{error}"))?;
  Ok(())
}

fn normalize_download_delete_ids(episode_ids: Vec<String>) -> Result<Vec<String>, String> {
  if episode_ids.len() > PODCAST_DOWNLOAD_DELETE_LIMIT {
    return Err(format!(
      "每次最多可清理 {PODCAST_DOWNLOAD_DELETE_LIMIT} 集播客"
    ));
  }
  validate_and_normalize_download_delete_ids(episode_ids)
}

fn validate_and_normalize_download_delete_ids(
  episode_ids: Vec<String>,
) -> Result<Vec<String>, String> {
  for episode_id in &episode_ids {
    validate_identifier(episode_id)?;
  }
  let mut normalized = episode_ids;
  normalized.sort_unstable();
  normalized.dedup();
  Ok(normalized)
}

fn list_completed_download_ids(db_path: &Path) -> Result<Vec<String>, String> {
  let connection = open_database(db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT d.episode_id
      FROM podcast_downloads d
      JOIN podcast_progress p ON p.episode_id = d.episode_id
      WHERE d.state = 'downloaded' AND p.completed = 1
      ORDER BY p.updated_at, d.episode_id
      ",
    )
    .map_err(|error| format!("无法读取已听完的播客下载：{error}"))?;
  let rows = statement
    .query_map([], |row| row.get(0))
    .map_err(|error| format!("无法读取已听完的播客下载：{error}"))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取已听完的播客下载：{error}"))
}

pub(crate) fn delete_episode_downloads_guarded(
  db_path: &Path,
  downloads_dir: &Path,
  active_downloads: &Arc<Mutex<HashSet<String>>>,
  episode_ids: Vec<String>,
  completed_only: bool,
) -> Result<PodcastDownloadDeleteResult, String> {
  let episode_ids = normalize_download_delete_ids(episode_ids)?;
  delete_normalized_episode_downloads_guarded(
    db_path,
    downloads_dir,
    active_downloads,
    episode_ids,
    completed_only,
  )
}

fn delete_normalized_episode_downloads_guarded(
  db_path: &Path,
  downloads_dir: &Path,
  active_downloads: &Arc<Mutex<HashSet<String>>>,
  episode_ids: Vec<String>,
  completed_only: bool,
) -> Result<PodcastDownloadDeleteResult, String> {
  let requested_count = episode_ids.len();
  let _file_guards = EpisodeFileGuard::acquire_many(active_downloads, &episode_ids)?;
  delete_episode_downloads(
    db_path,
    downloads_dir,
    &episode_ids,
    completed_only,
    requested_count,
  )
}

pub(crate) fn clear_completed_episode_downloads_guarded(
  db_path: &Path,
  downloads_dir: &Path,
  active_downloads: &Arc<Mutex<HashSet<String>>>,
) -> Result<PodcastDownloadDeleteResult, String> {
  let episode_ids = validate_and_normalize_download_delete_ids(
    list_completed_download_ids(db_path)?,
  )?;
  delete_normalized_episode_downloads_guarded(
    db_path,
    downloads_dir,
    active_downloads,
    episode_ids,
    true,
  )
}

#[derive(Debug)]
pub(crate) struct EpisodeDownloadDeleteTarget {
  pub(crate) episode_id: String,
  pub(crate) final_path: PathBuf,
  pub(crate) part_path: PathBuf,
}

#[derive(Debug)]
pub(crate) struct StagedDownloadFile {
  pub(crate) original_path: PathBuf,
  pub(crate) staged_path: PathBuf,
  pub(crate) bytes: u64,
}

fn load_episode_download_delete_targets(
  transaction: &Transaction<'_>,
  downloads_dir: &Path,
  episode_ids: &[String],
  completed_only: bool,
) -> Result<Vec<EpisodeDownloadDeleteTarget>, String> {
  let mut targets = Vec::new();
  for episode_id in episode_ids {
    let local_path = transaction
      .query_row(
        "
        SELECT d.local_path
        FROM podcast_downloads d
        WHERE d.episode_id = ?1
          AND d.state = 'downloaded'
          AND (
            ?2 = 0
            OR EXISTS (
              SELECT 1
              FROM podcast_progress p
              WHERE p.episode_id = d.episode_id AND p.completed = 1
            )
          )
        ",
        params![episode_id, i64::from(completed_only)],
        |row| row.get::<_, Option<String>>(0),
      )
      .optional()
      .map_err(|error| format!("无法读取播客下载信息：{error}"))?
      .flatten();
    let Some(local_path) = local_path else {
      continue;
    };
    let final_path = PathBuf::from(local_path);
    if !is_managed_download_path(downloads_dir, episode_id, &final_path) {
      continue;
    }
    targets.push(EpisodeDownloadDeleteTarget {
      episode_id: episode_id.clone(),
      final_path,
      part_path: downloads_dir.join(format!("{episode_id}.part")),
    });
  }
  Ok(targets)
}

fn create_download_delete_staging_dir(downloads_dir: &Path) -> Result<PathBuf, String> {
  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or(0);
  for attempt in 0..100u16 {
    let path = downloads_dir.join(format!(
      ".zone-delete-{}-{timestamp:x}-{attempt:x}",
      std::process::id(),
    ));
    match fs::create_dir(&path) {
      Ok(()) => return Ok(path),
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(error) => return Err(format!("无法创建播客下载暂存目录：{error}")),
    }
  }
  Err("无法创建唯一的播客下载暂存目录".to_string())
}

fn path_entry_exists(path: &Path) -> Result<bool, String> {
  match fs::symlink_metadata(path) {
    Ok(_) => Ok(true),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(error) => Err(format!("无法检查播客下载文件：{error}")),
  }
}

fn stage_download_file(
  original_path: &Path,
  staging_dir: &Path,
  rename_file: &mut dyn FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<Option<StagedDownloadFile>, String> {
  let metadata = match fs::symlink_metadata(original_path) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(format!("无法检查播客下载文件：{error}")),
  };
  if !metadata.file_type().is_file() {
    return Err("播客下载路径不是普通文件".to_string());
  }
  let file_name = original_path
    .file_name()
    .ok_or_else(|| "播客下载文件名无效".to_string())?;
  let staged_path = staging_dir.join(file_name);
  if path_entry_exists(&staged_path)? {
    return Err("播客下载暂存目标已存在".to_string());
  }
  rename_file(original_path, &staged_path)
    .map_err(|error| format!("无法暂存播客下载文件：{error}"))?;
  Ok(Some(StagedDownloadFile {
    original_path: original_path.to_path_buf(),
    staged_path,
    bytes: metadata.len(),
  }))
}

fn rollback_staged_download_files(
  staged_files: &[StagedDownloadFile],
  staging_dir: &Path,
) -> Result<(), String> {
  let mut failures = Vec::new();
  for staged in staged_files.iter().rev() {
    let staged_exists = match path_entry_exists(&staged.staged_path) {
      Ok(exists) => exists,
      Err(error) => {
        failures.push(error);
        continue;
      }
    };
    if !staged_exists {
      match path_entry_exists(&staged.original_path) {
        Ok(true) => {}
        Ok(false) => failures.push(format!(
          "暂存文件与原文件均不存在：{}",
          staged.original_path.display(),
        )),
        Err(error) => failures.push(error),
      }
      continue;
    }
    match path_entry_exists(&staged.original_path) {
      Ok(true) => {
        failures.push(format!(
          "原路径已存在，未覆盖：{}",
          staged.original_path.display(),
        ));
      }
      Ok(false) => {
        if let Err(error) = fs::rename(&staged.staged_path, &staged.original_path) {
          failures.push(format!(
            "无法恢复播客下载文件 {}：{error}",
            staged.original_path.display(),
          ));
        }
      }
      Err(error) => failures.push(error),
    }
  }
  if failures.is_empty() {
    match fs::remove_dir(staging_dir) {
      Ok(()) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => failures.push(format!("无法移除播客下载暂存目录：{error}")),
    }
  }
  if failures.is_empty() {
    Ok(())
  } else {
    Err(failures.join("；"))
  }
}

fn rollback_download_delete_error(
  error: String,
  staged_files: &[StagedDownloadFile],
  staging_dir: &Path,
) -> String {
  match rollback_staged_download_files(staged_files, staging_dir) {
    Ok(()) => error,
    Err(rollback_error) => format!("{error}；恢复暂存文件时发生错误：{rollback_error}"),
  }
}

fn rollback_download_delete_transaction(
  transaction: Transaction<'_>,
  error: String,
  staged_files: &[StagedDownloadFile],
  staging_dir: &Path,
) -> String {
  let error = match transaction.rollback() {
    Ok(()) => error,
    Err(rollback_error) => {
      format!("{error}；回滚播客下载数据库时发生错误：{rollback_error}")
    }
  };
  rollback_download_delete_error(error, staged_files, staging_dir)
}

fn cleanup_committed_staged_download_files(
  staged_files: &[StagedDownloadFile],
  staging_dir: &Path,
) {
  for staged in staged_files {
    if let Err(error) = remove_file_if_present(&staged.staged_path, "播客下载暂存文件") {
      eprintln!(
        "[podcast] 已清除下载记录，但暂存文件清理失败（{}）：{error}",
        staged.staged_path.display(),
      );
    }
  }
  if let Err(error) = fs::remove_dir(staging_dir) {
    if error.kind() != std::io::ErrorKind::NotFound {
      eprintln!(
        "[podcast] 已清除下载记录，但暂存目录清理失败（{}）：{error}",
        staging_dir.display(),
      );
    }
  }
}

fn delete_episode_downloads(
  db_path: &Path,
  downloads_dir: &Path,
  episode_ids: &[String],
  completed_only: bool,
  requested_count: usize,
) -> Result<PodcastDownloadDeleteResult, String> {
  let mut rename_file = |from: &Path, to: &Path| fs::rename(from, to);
  delete_episode_downloads_with_rename(
    db_path,
    downloads_dir,
    episode_ids,
    completed_only,
    requested_count,
    &mut rename_file,
  )
}

fn delete_episode_downloads_with_rename(
  db_path: &Path,
  downloads_dir: &Path,
  episode_ids: &[String],
  completed_only: bool,
  requested_count: usize,
  rename_file: &mut dyn FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<PodcastDownloadDeleteResult, String> {
  if episode_ids.is_empty() {
    return Ok(PodcastDownloadDeleteResult {
      requested_count,
      ..PodcastDownloadDeleteResult::default()
    });
  }

  let mut connection = open_database(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始清理播客下载：{error}"))?;
  let targets = load_episode_download_delete_targets(
    &transaction,
    downloads_dir,
    episode_ids,
    completed_only,
  )?;
  if targets.is_empty() {
    drop(transaction);
    return Ok(PodcastDownloadDeleteResult {
      requested_count,
      ..PodcastDownloadDeleteResult::default()
    });
  }

  let staging_dir = create_download_delete_staging_dir(downloads_dir)?;
  let mut staged_files = Vec::new();
  for target in &targets {
    for path in [&target.final_path, &target.part_path] {
      match stage_download_file(path, &staging_dir, rename_file) {
        Ok(Some(staged)) => staged_files.push(staged),
        Ok(None) => {}
        Err(error) => {
          return Err(rollback_download_delete_transaction(
            transaction,
            error,
            &staged_files,
            &staging_dir,
          ));
        }
      }
    }
  }

  let mut deleted_episode_ids = Vec::with_capacity(targets.len());
  for target in &targets {
    let deleted = match transaction
      .execute(
        "
        DELETE FROM podcast_downloads
        WHERE episode_id = ?1
          AND state = 'downloaded'
          AND (
            ?2 = 0
            OR EXISTS (
              SELECT 1
              FROM podcast_progress p
              WHERE p.episode_id = podcast_downloads.episode_id
                AND p.completed = 1
            )
          )
        ",
        params![target.episode_id, i64::from(completed_only)],
      )
    {
      Ok(deleted) => deleted,
      Err(error) => {
        return Err(rollback_download_delete_transaction(
          transaction,
          format!("无法清除播客下载记录：{error}"),
          &staged_files,
          &staging_dir,
        ));
      }
    };
    if deleted != 1 {
      return Err(rollback_download_delete_transaction(
        transaction,
        "播客下载状态已发生变化，请刷新后重试".to_string(),
        &staged_files,
        &staging_dir,
      ));
    }
    deleted_episode_ids.push(target.episode_id.clone());
  }

  if let Err(error) = transaction.commit() {
    return Err(rollback_download_delete_error(
      format!("无法提交播客下载清理：{error}"),
      &staged_files,
      &staging_dir,
    ));
  }
  let deleted_bytes = staged_files
    .iter()
    .fold(0u64, |total, staged| total.saturating_add(staged.bytes));
  cleanup_committed_staged_download_files(&staged_files, &staging_dir);
  Ok(PodcastDownloadDeleteResult {
    requested_count,
    deleted_count: deleted_episode_ids.len(),
    deleted_bytes,
    deleted_episode_ids,
  })
}
pub(crate) async fn download_episode(
  db_path: &Path,
  downloads_dir: &Path,
  episode_id: &str,
  enclosure_url: &str,
  enclosure_type: Option<&str>,
) -> Result<PodcastDownloadResult, String> {
  download_episode_with_network_policy(db_path, downloads_dir, episode_id, enclosure_url, enclosure_type, false).await
}

async fn download_episode_with_network_policy(
  db_path: &Path,
  downloads_dir: &Path,
  episode_id: &str,
  enclosure_url: &str,
  enclosure_type: Option<&str>,
  allow_private_network: bool,
) -> Result<PodcastDownloadResult, String> {
  let url = validate_url_shape_with_policy(enclosure_url, allow_private_network)?;
  let part_path = downloads_dir.join(format!("{episode_id}.part"));
  let mut offset = tokio::fs::metadata(&part_path)
    .await
    .map(|metadata| metadata.len())
    .unwrap_or(0);
  if offset > PODCAST_AUDIO_RESPONSE_LIMIT {
    let _ = tokio::fs::remove_file(&part_path).await;
    offset = 0;
  }

  let db_path_owned = db_path.to_path_buf();
  let started_id = episode_id.to_string();
  tauri::async_runtime::spawn_blocking(move || mark_download_started(&db_path_owned, &started_id, offset, None))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))??;

  let range = (offset > 0).then(|| format!("bytes={offset}-"));
  let mut public_response = send_public_get_with_policy(
    url,
    Duration::from_secs(30 * 60),
    range.as_deref(),
    allow_private_network,
  )
  .await?;
  if offset > 0 && public_response.response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
    tokio::fs::remove_file(&part_path)
      .await
      .map_err(|error| format!("无法重置失效的播客断点文件：{error}"))?;
    offset = 0;
    public_response = send_public_get_with_policy(
      validate_url_shape_with_policy(enclosure_url, allow_private_network)?,
      Duration::from_secs(30 * 60),
      None,
      allow_private_network,
    )
    .await?;
  }
  let status = public_response.response.status();
  if !status.is_success() {
    return Err(format!("播客音频来源返回错误 {}", status.as_u16()));
  }
  let response_content_type = header_text(public_response.response.headers(), header::CONTENT_TYPE);
  if !response_content_type_is_audio_candidate(
    response_content_type.as_deref(),
    enclosure_type,
    Some(enclosure_url),
  ) {
    return Err("播客音频来源返回了非音频内容".to_string());
  }

  let mut append = false;
  let mut resumed = false;
  if offset > 0 && status == StatusCode::PARTIAL_CONTENT {
    let content_range = header_text(public_response.response.headers(), header::CONTENT_RANGE)
      .ok_or_else(|| "播客音频断点响应缺少范围信息".to_string())?;
    let (start, _, _) = parse_content_range(&content_range).ok_or_else(|| "播客音频断点响应范围无效".to_string())?;
    if start != offset {
      return Err("播客音频断点响应与本地进度不一致".to_string());
    }
    append = true;
    resumed = true;
  } else if status == StatusCode::PARTIAL_CONTENT {
    let content_range = header_text(public_response.response.headers(), header::CONTENT_RANGE)
      .ok_or_else(|| "播客音频响应缺少范围信息".to_string())?;
    let (start, _, _) = parse_content_range(&content_range).ok_or_else(|| "播客音频响应范围无效".to_string())?;
    if start != 0 {
      return Err("播客音频响应没有从文件开头开始".to_string());
    }
    offset = 0;
  } else {
    offset = 0;
  }

  let response_total = header_text(public_response.response.headers(), header::CONTENT_RANGE)
    .and_then(|value| parse_content_range(&value).and_then(|(_, _, total)| total))
    .or_else(|| {
      public_response
        .response
        .content_length()
        .and_then(|length| offset.checked_add(length))
    });
  if response_total.is_some_and(|total| total > PODCAST_AUDIO_RESPONSE_LIMIT) {
    return Err("播客音频超过大小限制".to_string());
  }

  let db_path_owned = db_path.to_path_buf();
  let progress_id = episode_id.to_string();
  let total_for_db = response_total;
  tauri::async_runtime::spawn_blocking(move || {
    mark_download_started(&db_path_owned, &progress_id, offset, total_for_db)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))??;

  let mut options = tokio::fs::OpenOptions::new();
  options.create(true).write(true);
  if append {
    options.append(true);
  } else {
    options.truncate(true);
  }
  let mut file = options
    .open(&part_path)
    .await
    .map_err(|error| format!("无法创建播客下载文件：{error}"))?;
  let mut response = public_response.response;
  let mut downloaded_bytes = offset;
  let mut persisted_downloaded_bytes = offset;
  let mut last_progress_update = Instant::now();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|error| format!("无法读取播客音频响应：{error}"))?
  {
    downloaded_bytes = downloaded_bytes
      .checked_add(chunk.len() as u64)
      .ok_or_else(|| "播客音频大小无效".to_string())?;
    if downloaded_bytes > PODCAST_AUDIO_RESPONSE_LIMIT {
      return Err("播客音频超过大小限制".to_string());
    }
    file
      .write_all(&chunk)
      .await
      .map_err(|error| format!("无法写入播客下载文件：{error}"))?;
    let progress_elapsed = last_progress_update.elapsed();
    let progressed_bytes = downloaded_bytes.saturating_sub(persisted_downloaded_bytes);
    if (
      progressed_bytes >= PODCAST_DOWNLOAD_PROGRESS_BYTE_INTERVAL
        && progress_elapsed >= PODCAST_DOWNLOAD_PROGRESS_MIN_INTERVAL
    ) || progress_elapsed >= PODCAST_DOWNLOAD_PROGRESS_MAX_INTERVAL
    {
      let db_path_owned = db_path.to_path_buf();
      let progress_id = episode_id.to_string();
      let total_for_db = response_total;
      tauri::async_runtime::spawn_blocking(move || {
        mark_download_started(
          &db_path_owned,
          &progress_id,
          downloaded_bytes,
          total_for_db,
        )
      })
      .await
      .map_err(|error| format!("播客数据任务异常结束：{error}"))??;
      persisted_downloaded_bytes = downloaded_bytes;
      last_progress_update = Instant::now();
    }
  }
  file
    .flush()
    .await
    .map_err(|error| format!("无法完成播客下载文件：{error}"))?;
  drop(file);

  if downloaded_bytes == 0 {
    return Err("播客音频内容为空".to_string());
  }
  let extension = detect_audio_extension(&part_path).await?;
  let final_path = downloads_dir.join(format!("{episode_id}.{extension}"));
  if tokio::fs::metadata(&final_path).await.is_ok() {
    tokio::fs::remove_file(&final_path)
      .await
      .map_err(|error| format!("无法替换旧的播客下载：{error}"))?;
  }
  tokio::fs::rename(&part_path, &final_path)
    .await
    .map_err(|error| format!("无法完成播客下载：{error}"))?;
  let local_path = final_path.to_string_lossy().to_string();

  let db_path_owned = db_path.to_path_buf();
  let completed_id = episode_id.to_string();
  let completed_path = local_path.clone();
  tauri::async_runtime::spawn_blocking(move || {
    mark_download_complete(
      &db_path_owned,
      &completed_id,
      &completed_path,
      downloaded_bytes,
      response_total.or(Some(downloaded_bytes)),
    )
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))??;

  Ok(PodcastDownloadResult {
    episode_id: episode_id.to_string(),
    local_path,
    downloaded_bytes,
    resumed,
  })
}

pub(crate) fn mark_download_started(
  db_path: &Path,
  episode_id: &str,
  downloaded_bytes: u64,
  total_bytes: Option<u64>,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  connection
    .execute(
      "
      INSERT INTO podcast_downloads (
        episode_id, local_path, state, downloaded_bytes, total_bytes,
        error_message, updated_at
      ) VALUES (?1, NULL, 'downloading', ?2, ?3, NULL, ?4)
      ON CONFLICT(episode_id) DO UPDATE SET
        state = 'downloading',
        downloaded_bytes = excluded.downloaded_bytes,
        total_bytes = COALESCE(excluded.total_bytes, podcast_downloads.total_bytes),
        error_message = NULL,
        updated_at = excluded.updated_at
      ",
      params![
        episode_id,
        i64::try_from(downloaded_bytes).unwrap_or(i64::MAX),
        total_bytes.and_then(|value| i64::try_from(value).ok()),
        unix_time_millis(),
      ],
    )
    .map_err(|error| format!("无法保存播客下载状态：{error}"))?;
  Ok(())
}

pub(crate) fn mark_download_complete(
  db_path: &Path,
  episode_id: &str,
  local_path: &str,
  downloaded_bytes: u64,
  total_bytes: Option<u64>,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  connection
    .execute(
      "
      INSERT INTO podcast_downloads (
        episode_id, local_path, state, downloaded_bytes, total_bytes,
        error_message, updated_at
      ) VALUES (?1, ?2, 'downloaded', ?3, ?4, NULL, ?5)
      ON CONFLICT(episode_id) DO UPDATE SET
        local_path = excluded.local_path,
        state = 'downloaded',
        downloaded_bytes = excluded.downloaded_bytes,
        total_bytes = excluded.total_bytes,
        error_message = NULL,
        updated_at = excluded.updated_at
      ",
      params![
        episode_id,
        local_path,
        i64::try_from(downloaded_bytes).unwrap_or(i64::MAX),
        total_bytes.and_then(|value| i64::try_from(value).ok()),
        unix_time_millis(),
      ],
    )
    .map_err(|error| format!("无法保存播客下载结果：{error}"))?;
  Ok(())
}

pub(crate) fn mark_download_failed(db_path: &Path, episode_id: &str, downloaded_bytes: u64, message: &str) -> Result<(), String> {
  let connection = open_database(db_path)?;
  connection
    .execute(
      "
      INSERT INTO podcast_downloads (
        episode_id, local_path, state, downloaded_bytes, total_bytes,
        error_message, updated_at
      ) VALUES (?1, NULL, 'failed', ?2, NULL, ?3, ?4)
      ON CONFLICT(episode_id) DO UPDATE SET
        state = 'failed',
        downloaded_bytes = excluded.downloaded_bytes,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at
      ",
      params![
        episode_id,
        i64::try_from(downloaded_bytes).unwrap_or(i64::MAX),
        truncate_chars(message, 1_000),
        unix_time_millis(),
      ],
    )
    .map_err(|error| format!("无法保存播客下载错误：{error}"))?;
  Ok(())
}

pub(crate) fn save_progress(
  db_path: &Path,
  episode_id: &str,
  position_seconds: f64,
  duration_seconds: f64,
) -> Result<(), String> {
  save_progress_with_policy(db_path, episode_id, position_seconds, duration_seconds, false)
}

pub(crate) fn save_progress_with_policy(
  db_path: &Path,
  episode_id: &str,
  position_seconds: f64,
  duration_seconds: f64,
  force: bool,
) -> Result<(), String> {
  let connection = open_database(db_path)?;
  let exists = connection
    .query_row("SELECT 1 FROM podcast_episodes WHERE id = ?1", [episode_id], |_| Ok(()))
    .optional()
    .map_err(|error| format!("无法读取播客单集：{error}"))?
    .is_some();
  if !exists {
    return Err("播客单集不存在".to_string());
  }
  let clamped_position = if duration_seconds > 0.0 {
    position_seconds.min(duration_seconds)
  } else {
    position_seconds
  };
  let completed = duration_seconds > 0.0 && clamped_position / duration_seconds >= 0.95;
  // Ordinary timeupdate writes only move the playhead forward. Explicit seeks
  // and flushes pass force=true so rewinds and chapter jumps still persist.
  connection
    .execute(
      "
      INSERT INTO podcast_progress (
        episode_id, position_seconds, duration_seconds, completed, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(episode_id) DO UPDATE SET
        position_seconds = CASE
          WHEN ?6 != 0 THEN excluded.position_seconds
          WHEN excluded.position_seconds >= podcast_progress.position_seconds
            THEN excluded.position_seconds
          ELSE podcast_progress.position_seconds
        END,
        duration_seconds = COALESCE(excluded.duration_seconds, podcast_progress.duration_seconds),
        completed = MAX(podcast_progress.completed, excluded.completed),
        updated_at = excluded.updated_at
      ",
      params![
        episode_id,
        clamped_position,
        (duration_seconds > 0.0).then_some(duration_seconds),
        i64::from(completed),
        unix_time_millis(),
        i64::from(force),
      ],
    )
    .map_err(|error| format!("无法保存播客播放进度：{error}"))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  use tokio::io::AsyncReadExt;
  use tokio::net::TcpListener;

  #[test]
  fn ordinary_progress_is_monotonic_while_force_allows_rewind() {
    let directory = test_directory("progress-monotonic");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    save_progress(&state.db_path, &episode_id, 40.0, 100.0).expect("save later progress");
    save_progress(&state.db_path, &episode_id, 20.0, 100.0)
      .expect("stale earlier progress must not rewind");
    let after_stale =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("detail");
    assert_eq!(after_stale.episode.progress_seconds, 40.0);

    save_progress_with_policy(&state.db_path, &episode_id, 12.0, 100.0, true)
      .expect("forced seek may rewind");
    let after_force =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("detail");
    assert_eq!(after_force.episode.progress_seconds, 12.0);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn startup_sweep_removes_orphans_but_keeps_managed_downloads() {
    let directory = test_directory("sweep-orphans");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let final_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
    fs::write(&final_path, b"ID3-managed").expect("write managed download");
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &final_path.to_string_lossy(),
      11,
      Some(11),
    )
    .expect("mark managed download");
    let resume_part = state.downloads_dir.join(format!("{episode_id}.part"));
    fs::write(&resume_part, b"ID3-resume").expect("write resumable part");

    let orphan_id = "b".repeat(64);
    let orphan_audio = state.downloads_dir.join(format!("{orphan_id}.mp3"));
    let orphan_part = state.downloads_dir.join(format!("{orphan_id}.part"));
    fs::write(&orphan_audio, b"ID3-orphan").expect("write orphan audio");
    fs::write(&orphan_part, b"ID3-orphan-part").expect("write orphan part");
    let staging_dir = state.downloads_dir.join(".zone-delete-test");
    fs::create_dir(&staging_dir).expect("create stale staging dir");
    fs::write(staging_dir.join("staged.mp3"), b"ID3-staged").expect("write staged file");
    let unrelated = state.downloads_dir.join("notes.txt");
    fs::write(&unrelated, b"not a managed download").expect("write unrelated file");

    sweep_orphan_download_files(&state.db_path, &state.downloads_dir).expect("sweep orphans");

    assert!(final_path.exists());
    assert!(resume_part.exists());
    assert!(!orphan_audio.exists());
    assert!(!orphan_part.exists());
    assert!(!staging_dir.exists());
    assert!(unrelated.exists());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }

  #[test]
  fn deleting_download_removes_only_managed_files_and_cleans_database_state() {
    let directory = test_directory("delete-download");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let final_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
    let part_path = state.downloads_dir.join(format!("{episode_id}.part"));
    fs::write(&final_path, b"ID3-managed").expect("write managed download");
    fs::write(&part_path, b"ID3-part").expect("write part download");
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &final_path.to_string_lossy(),
      11,
      Some(11),
    )
    .expect("mark managed download");

    delete_episode_download(&state.db_path, &state.downloads_dir, &episode_id).expect("delete managed download");
    assert!(!final_path.exists());
    assert!(!part_path.exists());
    let detail =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("detail after delete");
    assert_eq!(detail.episode.download_state, "none");
    assert!(detail.episode.local_path.is_none());
    delete_episode_download(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("delete download idempotently");

    fs::write(&part_path, b"ID3-failed-part").expect("write failed part");
    mark_download_failed(&state.db_path, &episode_id, 15, "网络失败").expect("mark failed download");
    let failed =
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_id).expect("failed detail");
    assert_eq!(failed.download_error.as_deref(), Some("网络失败"));
    delete_episode_download(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("delete failed download");
    assert!(!part_path.exists());

    let outside_path = directory.join(format!("{episode_id}.mp3"));
    fs::write(&outside_path, b"ID3-outside").expect("write outside download");
    mark_download_complete(
      &state.db_path,
      &episode_id,
      &outside_path.to_string_lossy(),
      11,
      Some(11),
    )
    .expect("mark tampered download");
    delete_episode_download(&state.db_path, &state.downloads_dir, &episode_id)
      .expect("clean tampered record");
    assert!(outside_path.exists());
    let download_row_exists = open_database(&state.db_path)
      .expect("open database")
      .query_row(
        "SELECT 1 FROM podcast_downloads WHERE episode_id = ?1",
        [&episode_id],
        |_| Ok(()),
      )
      .optional()
      .expect("inspect download row")
      .is_some();
    assert!(!download_row_exists);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn bulk_download_delete_removes_only_selected_downloads() {
    let directory = test_directory("bulk-delete-downloads");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let mut paths = Vec::new();
    let mut expected_deleted_bytes = 0u64;
    for (index, episode_id) in episode_ids.iter().enumerate() {
      let path = state.downloads_dir.join(format!("{episode_id}.mp3"));
      let payload = format!("ID3-bulk-{index}").into_bytes();
      fs::write(&path, &payload).expect("write managed download");
      mark_download_complete(
        &state.db_path,
        episode_id,
        &path.to_string_lossy(),
        payload.len() as u64,
        Some(payload.len() as u64),
      )
      .expect("mark managed download");
      if index != 1 {
        expected_deleted_bytes += payload.len() as u64;
      }
      paths.push(path);
    }
    let part_path = state.downloads_dir.join(format!("{}.part", episode_ids[0]));
    let part_payload = b"ID3-bulk-part";
    fs::write(&part_path, part_payload).expect("write managed partial download");
    expected_deleted_bytes += part_payload.len() as u64;

    let result = delete_episode_downloads_guarded(
      &state.db_path,
      &state.downloads_dir,
      &state.active_downloads,
      vec![episode_ids[2].clone(), episode_ids[0].clone()],
      false,
    )
    .expect("delete selected downloads");
    assert_eq!(result.requested_count, 2);
    assert_eq!(result.deleted_count, 2);
    assert_eq!(result.deleted_bytes, expected_deleted_bytes);
    let mut expected_deleted_ids = vec![episode_ids[0].clone(), episode_ids[2].clone()];
    expected_deleted_ids.sort_unstable();
    assert_eq!(result.deleted_episode_ids, expected_deleted_ids);
    assert!(!paths[0].exists());
    assert!(!part_path.exists());
    assert!(paths[1].exists());
    assert!(!paths[2].exists());
    assert_eq!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_ids[0])
        .expect("selected detail")
        .episode
        .download_state,
      "none"
    );
    assert_eq!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_ids[1])
        .expect("unselected detail")
        .episode
        .download_state,
      "downloaded"
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn clearing_completed_downloads_keeps_unplayed_downloads() {
    let directory = test_directory("clear-completed-downloads");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let paths = episode_ids
      .iter()
      .enumerate()
      .map(|(index, episode_id)| {
        let path = state.downloads_dir.join(format!("{episode_id}.mp3"));
        let payload = format!("ID3-completed-{index}").into_bytes();
        fs::write(&path, &payload).expect("write managed download");
        mark_download_complete(
          &state.db_path,
          episode_id,
          &path.to_string_lossy(),
          payload.len() as u64,
          Some(payload.len() as u64),
        )
        .expect("mark managed download");
        path
      })
      .collect::<Vec<_>>();
    set_episode_played(&state.db_path, &episode_ids[0], true)
      .expect("mark first episode completed");
    set_episode_played(&state.db_path, &episode_ids[2], true)
      .expect("mark third episode completed");

    let result = clear_completed_episode_downloads_guarded(
      &state.db_path,
      &state.downloads_dir,
      &state.active_downloads,
    )
    .expect("clear completed downloads");
    assert_eq!(result.requested_count, 2);
    assert_eq!(result.deleted_count, 2);
    assert!(!paths[0].exists());
    assert!(paths[1].exists());
    assert!(!paths[2].exists());
    assert_eq!(
      get_episode_detail(&state.db_path, &state.downloads_dir, &episode_ids[1])
        .expect("unplayed detail")
        .episode
        .download_state,
      "downloaded"
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn clearing_completed_downloads_is_not_truncated_at_selection_limit() {
    let directory = test_directory("clear-all-completed-downloads");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(PODCAST_DOWNLOAD_DELETE_LIMIT + 1);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let mut connection = open_database(&state.db_path).expect("open podcast database");
    let transaction = connection
      .transaction_with_behavior(TransactionBehavior::Immediate)
      .expect("begin fixture transaction");
    for (index, episode_id) in episode_ids.iter().enumerate() {
      let local_path = state.downloads_dir.join(format!("{episode_id}.mp3"));
      transaction
        .execute(
          "
          INSERT INTO podcast_downloads (
            episode_id, local_path, state, downloaded_bytes, total_bytes,
            error_message, updated_at
          ) VALUES (?1, ?2, 'downloaded', 1, 1, NULL, ?3)
          ",
          params![
            episode_id,
            local_path.to_string_lossy(),
            i64::try_from(index).unwrap_or(i64::MAX),
          ],
        )
        .expect("insert completed download");
      transaction
        .execute(
          "
          INSERT INTO podcast_progress (
            episode_id, position_seconds, duration_seconds, completed, updated_at
          ) VALUES (?1, 1, 1, 1, ?2)
          ",
          params![
            episode_id,
            i64::try_from(index).unwrap_or(i64::MAX),
          ],
        )
        .expect("insert completed progress");
    }
    transaction.commit().expect("commit fixture transaction");
    drop(connection);

    assert_eq!(
      list_completed_download_ids(&state.db_path)
        .expect("list all completed downloads")
        .len(),
      PODCAST_DOWNLOAD_DELETE_LIMIT + 1
    );
    let result = clear_completed_episode_downloads_guarded(
      &state.db_path,
      &state.downloads_dir,
      &state.active_downloads,
    )
    .expect("clear every completed download");
    assert_eq!(result.requested_count, PODCAST_DOWNLOAD_DELETE_LIMIT + 1);
    assert_eq!(result.deleted_count, PODCAST_DOWNLOAD_DELETE_LIMIT + 1);
    assert_eq!(
      result.deleted_episode_ids.len(),
      PODCAST_DOWNLOAD_DELETE_LIMIT + 1
    );
    assert!(
      state
        .active_downloads
        .lock()
        .expect("inspect active downloads")
        .is_empty()
    );
    let remaining_downloads = {
      let connection = open_database(&state.db_path).expect("reopen podcast database");
      connection
        .query_row("SELECT COUNT(*) FROM podcast_downloads", [], |row| {
          row.get::<_, i64>(0)
        })
        .expect("count remaining downloads")
    };
    assert_eq!(remaining_downloads, 0);

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn bulk_download_delete_preflight_prevents_partial_cleanup() {
    let directory = test_directory("bulk-delete-preflight");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(3);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let paths = episode_ids
      .iter()
      .enumerate()
      .map(|(index, episode_id)| {
        let path = state.downloads_dir.join(format!("{episode_id}.mp3"));
        let payload = format!("ID3-preflight-{index}").into_bytes();
        fs::write(&path, &payload).expect("write managed download");
        mark_download_complete(
          &state.db_path,
          episode_id,
          &path.to_string_lossy(),
          payload.len() as u64,
          Some(payload.len() as u64),
        )
        .expect("mark managed download");
        path
      })
      .collect::<Vec<_>>();

    assert!(
      delete_episode_downloads_guarded(
        &state.db_path,
        &state.downloads_dir,
        &state.active_downloads,
        vec![episode_ids[0].clone(), "invalid".to_string(), episode_ids[1].clone()],
        false,
      )
      .is_err()
    );
    assert!(paths.iter().all(|path| path.exists()));
    assert!(
      delete_episode_downloads_guarded(
        &state.db_path,
        &state.downloads_dir,
        &state.active_downloads,
        vec![episode_ids[0].clone(); PODCAST_DOWNLOAD_DELETE_LIMIT + 1],
        false,
      )
      .is_err()
    );
    assert!(paths.iter().all(|path| path.exists()));

    let active_guard = EpisodeFileGuard::acquire(
      &state.active_downloads,
      &episode_ids[1],
    )
    .expect("reserve active episode");
    assert!(
      delete_episode_downloads_guarded(
        &state.db_path,
        &state.downloads_dir,
        &state.active_downloads,
        vec![episode_ids[0].clone(), episode_ids[1].clone()],
        false,
      )
      .is_err()
    );
    assert!(paths.iter().all(|path| path.exists()));
    drop(active_guard);

    let result = delete_episode_downloads_guarded(
      &state.db_path,
      &state.downloads_dir,
      &state.active_downloads,
      vec![
        episode_ids[0].clone(),
        episode_ids[0].clone(),
        episode_ids[1].clone(),
      ],
      false,
    )
    .expect("delete deduplicated selection");
    assert_eq!(result.requested_count, 2);
    assert_eq!(result.deleted_count, 2);
    assert_eq!(result.deleted_episode_ids.len(), 2);
    assert!(!paths[0].exists());
    assert!(!paths[1].exists());
    assert!(paths[2].exists());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn bulk_download_delete_restores_staged_files_when_a_later_rename_fails() {
    let directory = test_directory("bulk-delete-stage-rollback");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture_with_episode_count(2);
    let episode_ids = parsed
      .episodes
      .iter()
      .map(|episode| episode.id.clone())
      .collect::<Vec<_>>();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let paths = episode_ids
      .iter()
      .enumerate()
      .map(|(index, episode_id)| {
        let path = state.downloads_dir.join(format!("{episode_id}.mp3"));
        let payload = format!("ID3-rollback-{index}").into_bytes();
        fs::write(&path, &payload).expect("write managed download");
        mark_download_complete(
          &state.db_path,
          episode_id,
          &path.to_string_lossy(),
          payload.len() as u64,
          Some(payload.len() as u64),
        )
        .expect("mark managed download");
        (path, payload)
      })
      .collect::<Vec<_>>();

    let mut rename_count = 0usize;
    let mut injected_rename = |from: &Path, to: &Path| {
      rename_count += 1;
      if rename_count == 2 {
        return Err(std::io::Error::new(
          std::io::ErrorKind::Other,
          "injected staging failure",
        ));
      }
      fs::rename(from, to)
    };
    let result = delete_episode_downloads_with_rename(
      &state.db_path,
      &state.downloads_dir,
      &episode_ids,
      false,
      episode_ids.len(),
      &mut injected_rename,
    );
    assert!(result.is_err());
    assert_eq!(rename_count, 2);
    for ((path, payload), episode_id) in paths.iter().zip(&episode_ids) {
      assert_eq!(fs::read(path).expect("read restored download"), *payload);
      assert_eq!(
        get_episode_detail(&state.db_path, &state.downloads_dir, episode_id)
          .expect("detail after rollback")
          .episode
          .download_state,
        "downloaded"
      );
    }
    assert!(
      fs::read_dir(&state.downloads_dir)
        .expect("inspect downloads directory")
        .all(|entry| {
          !entry
            .expect("read downloads entry")
            .file_name()
            .to_string_lossy()
            .starts_with(".zone-delete-")
        })
    );

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[test]
  fn episode_file_guard_serializes_download_and_delete_operations() {
    let active = Arc::new(Mutex::new(HashSet::new()));
    let episode_id = "a".repeat(64);
    let first = EpisodeFileGuard::acquire(&active, &episode_id).expect("acquire first guard");
    assert!(EpisodeFileGuard::acquire(&active, &episode_id).is_err());
    drop(first);
    let second = EpisodeFileGuard::acquire(&active, &episode_id).expect("acquire after release");
    drop(second);
    assert!(active.lock().expect("lock active set").is_empty());
  }
  #[test]
  fn feed_refresh_guard_deduplicates_the_same_feed_only() {
    let active = Arc::new(Mutex::new(HashSet::new()));
    let first_id = "a".repeat(64);
    let second_id = "b".repeat(64);
    let first = FeedRefreshGuard::acquire(&active, &first_id)
      .expect("acquire first feed")
      .expect("first feed should be available");
    assert!(
      FeedRefreshGuard::acquire(&active, &first_id)
        .expect("inspect duplicate feed")
        .is_none()
    );
    let second = FeedRefreshGuard::acquire(&active, &second_id)
      .expect("acquire second feed")
      .expect("different feed should refresh concurrently");
    drop(first);
    assert!(
      FeedRefreshGuard::acquire(&active, &first_id)
        .expect("reacquire released feed")
        .is_some()
    );
    drop(second);
  }
  #[tokio::test]
  async fn download_resumes_a_part_file_with_range_and_persists_result() {
    let directory = test_directory("range");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
    let address = listener.local_addr().expect("server address");
    let audio = b"ID3-zone-podcast-range-download".to_vec();
    let split = 7usize;
    let expected_request = format!("Range: bytes={split}-");
    let server_audio = audio.clone();
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.expect("accept request");
      let mut request = vec![0u8; 8_192];
      let read = stream.read(&mut request).await.expect("read request");
      let request = String::from_utf8_lossy(&request[..read]);
      assert!(
        request
          .to_ascii_lowercase()
          .contains(&expected_request.to_ascii_lowercase()),
        "{request}"
      );
      let remaining = &server_audio[split..];
      let headers = format!(
        "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/mpeg\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
        remaining.len(),
        split,
        server_audio.len() - 1,
        server_audio.len(),
      );
      stream.write_all(headers.as_bytes()).await.expect("write headers");
      stream.write_all(remaining).await.expect("write body");
      stream.shutdown().await.expect("shutdown response");
    });

    let enclosure_url = format!("http://{address}/episode.mp3");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    let part_path = state.downloads_dir.join(format!("{episode_id}.part"));
    fs::write(&part_path, &audio[..split]).expect("write partial download");

    let result = download_episode_with_network_policy(
      &state.db_path,
      &state.downloads_dir,
      &episode_id,
      &enclosure_url,
      Some("audio/mpeg"),
      true,
    )
    .await
    .expect("resume download");
    server.await.expect("server task");
    assert!(result.resumed);
    assert_eq!(result.downloaded_bytes, audio.len() as u64);
    assert_eq!(fs::read(&result.local_path).expect("read downloaded file"), audio);
    assert!(!part_path.exists());
    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &feed_id).expect("list episodes");
    assert_eq!(episodes[0].download_state, "downloaded");
    assert_eq!(episodes[0].local_path.as_deref(), Some(result.local_path.as_str()));

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
}
