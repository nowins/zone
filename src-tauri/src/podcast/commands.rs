use std::path::PathBuf;
use tauri::State;
use super::*;

#[tauri::command]
pub async fn podcast_search_apple(query: String, limit: Option<u8>, request_id: Option<String>) -> Result<Vec<PodcastSearchResult>, String> {
  run_network_task(request_id.as_deref(), async {
    search_apple_cn(&query, limit.unwrap_or(12)).await
  }).await
}

#[tauri::command]
pub async fn podcast_browse_apple(limit: Option<u8>, request_id: Option<String>) -> Result<Vec<PodcastDiscoveryShow>, String> {
  run_network_task(request_id.as_deref(), async {
    browse_apple_cn(limit.unwrap_or(24)).await
  }).await
}

#[tauri::command]
pub async fn podcast_subscribe(
  state: State<'_, PodcastState>,
  feed_url: String,
  title_hint: Option<String>,
  author_hint: Option<String>,
  artwork_url: Option<String>,
) -> Result<PodcastSubscribeResult, String> {
  state.ensure_ready()?;
  let parsed = fetch_and_parse_feed(
    &feed_url,
    title_hint.as_deref(),
    author_hint.as_deref(),
    artwork_url.as_deref(),
  )
  .await?;
  let db_path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || store_subscription(&db_path, parsed))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_preview_feed(
  state: State<'_, PodcastState>,
  feed_url: String,
  title_hint: Option<String>,
  author_hint: Option<String>,
  artwork_url: Option<String>,
  request_id: Option<String>,
) -> Result<PodcastSubscribeResult, String> {
  run_network_task(request_id.as_deref(), async {
    state.ensure_ready()?;
    let cache_db_path = state.db_path.clone();
    let cache_feed_url = feed_url.clone();
    if let Some(cached) = tauri::async_runtime::spawn_blocking(move || {
      get_recent_preview(
        &cache_db_path,
        &cache_feed_url,
        unix_time_millis(),
      )
    })
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))??
    {
      return Ok(cached);
    }
    let parsed = fetch_and_parse_feed(
      &feed_url,
      title_hint.as_deref(),
      author_hint.as_deref(),
      artwork_url.as_deref(),
    )
    .await?;
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || store_preview(&db_path, parsed))
      .await
      .map_err(|error| format!("播客数据任务异常结束：{error}"))?
  }).await
}

#[tauri::command]
pub async fn podcast_refresh_feeds(
  state: State<'_, PodcastState>,
  feed_id: Option<String>,
  force: bool,
) -> Result<PodcastRefreshReport, String> {
  state.ensure_ready()?;
  if let Some(feed_id) = feed_id.as_deref() {
    validate_identifier(feed_id)?;
  }
  let db_path = state.db_path.clone();
  let target_feed_id = feed_id.clone();
  let targets = tauri::async_runtime::spawn_blocking(move || {
    list_refresh_targets(&db_path, target_feed_id.as_deref(), force, unix_time_millis())
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))??;

  let mut report = PodcastRefreshReport::default();
  let mut targets = targets.into_iter();
  let mut refresh_tasks = tokio::task::JoinSet::new();
  loop {
    while refresh_tasks.len() < PODCAST_REFRESH_CONCURRENCY {
      let Some(target) = targets.next() else { break; };
      refresh_tasks.spawn(refresh_feed_target(state.db_path.clone(), state.active_refreshes.clone(),
        state.refresh_semaphore.clone(), target, false));
    }
    let Some(outcome) = refresh_tasks.join_next().await else { break; };
    match outcome.map_err(|error| format!("播客刷新任务异常结束：{error}"))? {
      PodcastRefreshOutcome::Skipped => continue,
      PodcastRefreshOutcome::NotModified => report.not_modified += 1,
      PodcastRefreshOutcome::Updated { inserted, updated } => { report.inserted += inserted; report.updated += updated; }
      PodcastRefreshOutcome::Failed(failure) => report.failures.push(failure),
    }
    report.checked += 1;
  }
  Ok(report)
}

#[tauri::command]
pub async fn podcast_list_feeds(
  state: State<'_, PodcastState>,
  include_unsubscribed: Option<bool>,
) -> Result<Vec<PodcastFeed>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let include_unsubscribed = include_unsubscribed.unwrap_or(false);
  tauri::async_runtime::spawn_blocking(move || {
    if include_unsubscribed {
      list_feeds_with_policy(&db_path, true)
    } else {
      list_feeds(&db_path)
    }
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_set_following(
  state: State<'_, PodcastState>,
  feed_id: String,
  following: bool,
) -> Result<(), String> {
  state.ensure_ready()?;
  validate_identifier(&feed_id)?;
  let db_path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || set_following(&db_path, &feed_id, following))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_list_home(state: State<'_, PodcastState>) -> Result<PodcastHome, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || list_home(&db_path, &downloads_dir))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_list_downloads(
  state: State<'_, PodcastState>,
  offset: usize,
  limit: usize,
) -> Result<PodcastDownloadPage, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    list_downloads(&db_path, &downloads_dir, offset, limit)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_list_episodes(
  state: State<'_, PodcastState>,
  feed_id: String,
  offset: Option<usize>,
  limit: Option<usize>,
) -> Result<Vec<PodcastEpisode>, String> {
  state.ensure_ready()?;
  validate_identifier(&feed_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || list_episode_page(&db_path, &downloads_dir, &feed_id, offset.unwrap_or(0), limit.unwrap_or(100).clamp(1, 200)))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}
#[tauri::command]
pub async fn podcast_list_related_episodes(
  state: State<'_, PodcastState>,
  episode_id: String,
  limit: Option<u8>,
) -> Result<Vec<PodcastEpisode>, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let limit = usize::from(limit.unwrap_or(PODCAST_RELATED_EPISODE_DEFAULT_LIMIT as u8))
    .clamp(1, PODCAST_RELATED_EPISODE_MAX_LIMIT);
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    list_related_episodes(&db_path, &downloads_dir, &episode_id, limit)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_get_episode_detail(
  state: State<'_, PodcastState>,
  episode_id: String,
) -> Result<PodcastEpisodeDetail, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || get_episode_detail(&db_path, &downloads_dir, &episode_id))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_get_episode_chapters(
  state: State<'_, PodcastState>,
  episode_id: String,
  request_id: Option<String>,
) -> Result<PodcastChapterDocument, String> {
  run_network_task(request_id.as_deref(), async {
    state.ensure_ready()?;
    validate_identifier(&episode_id)?;
    get_episode_chapters_with_network_policy(
      &state.db_path,
      &episode_id,
      false,
    )
    .await
  }).await
}

#[tauri::command]
pub async fn podcast_set_episode_saved(
  state: State<'_, PodcastState>,
  episode_id: String,
  saved: bool,
) -> Result<PodcastEpisodeDetail, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    set_episode_saved(&db_path, &episode_id, saved)?;
    get_episode_detail(&db_path, &downloads_dir, &episode_id)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_list_saved_episodes(
  state: State<'_, PodcastState>,
) -> Result<Vec<PodcastEpisodeDetail>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || list_saved_episodes(&db_path, &downloads_dir))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_set_episode_played(
  state: State<'_, PodcastState>,
  episode_id: String,
  played: bool,
) -> Result<PodcastEpisodeDetail, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    set_episode_played(&db_path, &episode_id, played)?;
    get_episode_detail(&db_path, &downloads_dir, &episode_id)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_set_episodes_played(
  state: State<'_, PodcastState>,
  episode_ids: Vec<String>,
  played: bool,
) -> Result<Vec<PodcastEpisodeDetail>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let episode_ids = set_episodes_played(&db_path, &episode_ids, played)?;
    get_episode_details(&db_path, &downloads_dir, &episode_ids)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_list_queue(state: State<'_, PodcastState>) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || list_queue(&db_path, &downloads_dir))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_queue_add(
  state: State<'_, PodcastState>,
  episode_id: String,
  play_next: bool,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    queue_add(&db_path, &episode_id, play_next)?;
    list_queue(&db_path, &downloads_dir)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_queue_remove(
  state: State<'_, PodcastState>,
  episode_id: String,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    queue_remove(&db_path, &episode_id)?;
    list_queue(&db_path, &downloads_dir)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_queue_remove_many(
  state: State<'_, PodcastState>,
  episode_ids: Vec<String>,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    queue_remove_many(&db_path, &episode_ids)?;
    list_queue(&db_path, &downloads_dir)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_queue_reorder(
  state: State<'_, PodcastState>,
  episode_ids: Vec<String>,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  validate_queue_identifiers(&episode_ids)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    queue_reorder(&db_path, &episode_ids)?;
    list_queue(&db_path, &downloads_dir)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_queue_clear(state: State<'_, PodcastState>) -> Result<(), String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  tauri::async_runtime::spawn_blocking(move || queue_clear(&db_path))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_queue_autofill(
  state: State<'_, PodcastState>,
  current_episode_id: String,
  mode: String,
) -> Result<Vec<PodcastQueueItem>, String> {
  state.ensure_ready()?;
  validate_identifier(&current_episode_id)?;
  let mode = PodcastQueueAutofillMode::parse(&mode)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    queue_autofill(&db_path, &current_episode_id, mode)?;
    list_queue(&db_path, &downloads_dir)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_download_episode(
  state: State<'_, PodcastState>,
  episode_id: String,
  request_id: Option<String>,
) -> Result<PodcastDownloadResult, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let _file_guard = EpisodeFileGuard::acquire(&state.active_downloads, &episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  let source_id = episode_id.clone();
  let source = tauri::async_runtime::spawn_blocking(move || load_episode_download_source(&db_path, &source_id))
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))??;

  if let Some(local_path) = source.local_path.as_deref() {
    let path = PathBuf::from(local_path);
    if path.is_file() && is_managed_download_path(&downloads_dir, &episode_id, &path) {
      return Ok(PodcastDownloadResult {
        episode_id,
        local_path: path.to_string_lossy().to_string(),
        downloaded_bytes: source.downloaded_bytes,
        resumed: false,
      });
    }
  }

  let result = run_network_task(request_id.as_deref(), download_episode(
    &state.db_path,
    &downloads_dir,
    &episode_id,
    &source.enclosure_url,
    source.enclosure_type.as_deref(),
  )).await;

  if let Err(error) = &result {
    let db_path = state.db_path.clone();
    let failed_id = episode_id.clone();
    let part_path = downloads_dir.join(format!("{episode_id}.part"));
    let downloaded_bytes = tokio::fs::metadata(&part_path)
      .await
      .map(|metadata| metadata.len())
      .unwrap_or(0);
    let message = error.clone();
    let failed_source = source.enclosure_url.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
      mark_download_failed_for_source(&db_path, &failed_id, &failed_source, downloaded_bytes, &message)
    })
    .await;
  }

  result
}

#[tauri::command]
pub async fn podcast_delete_episode_download(
  state: State<'_, PodcastState>,
  episode_id: String,
) -> Result<PodcastEpisodeDetail, String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  let _file_guard = EpisodeFileGuard::acquire(&state.active_downloads, &episode_id)?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  tauri::async_runtime::spawn_blocking(move || {
    delete_episode_download(&db_path, &downloads_dir, &episode_id)?;
    get_episode_detail(&db_path, &downloads_dir, &episode_id)
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_delete_episode_downloads(
  state: State<'_, PodcastState>,
  episode_ids: Vec<String>,
) -> Result<PodcastDownloadDeleteResult, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  let active_downloads = state.active_downloads.clone();
  tauri::async_runtime::spawn_blocking(move || {
    delete_episode_downloads_guarded(
      &db_path,
      &downloads_dir,
      &active_downloads,
      episode_ids,
      false,
    )
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_clear_completed_downloads(
  state: State<'_, PodcastState>,
) -> Result<PodcastDownloadDeleteResult, String> {
  state.ensure_ready()?;
  let db_path = state.db_path.clone();
  let downloads_dir = state.downloads_dir.clone();
  let active_downloads = state.active_downloads.clone();
  tauri::async_runtime::spawn_blocking(move || {
    clear_completed_episode_downloads_guarded(
      &db_path,
      &downloads_dir,
      &active_downloads,
    )
  })
  .await
  .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub async fn podcast_cache_artwork(
  app: tauri::AppHandle,
  state: State<'_, PodcastState>,
  url: String,
) -> Result<Option<String>, String> {
  state.ensure_ready()?;
  let path = cache_podcast_artwork_file(state.artwork_cache_dir.clone(), url, false).await?;
  crate::image_scope::allow_images(&app, path.iter().map(String::as_str));
  Ok(path)
}

#[tauri::command]
pub async fn podcast_save_progress(
  state: State<'_, PodcastState>,
  episode_id: String,
  position_seconds: f64,
  duration_seconds: f64,
  force: Option<bool>,
) -> Result<(), String> {
  state.ensure_ready()?;
  validate_identifier(&episode_id)?;
  if !position_seconds.is_finite() || !duration_seconds.is_finite() || position_seconds < 0.0 || duration_seconds < 0.0
  {
    return Err("播客播放进度无效".to_string());
  }
  let db_path = state.db_path.clone();
  let force = force.unwrap_or(false);
  tauri::async_runtime::spawn_blocking(move || {
    if force {
      save_progress_with_policy(
        &db_path,
        &episode_id,
        position_seconds,
        duration_seconds,
        true,
      )
    } else {
      save_progress(&db_path, &episode_id, position_seconds, duration_seconds)
    }
  })
    .await
    .map_err(|error| format!("播客数据任务异常结束：{error}"))?
}

#[tauri::command]
pub fn podcast_cancel_network_request(request_id: String) -> Result<(), String> {
  cancel_network_task(&request_id)
}
