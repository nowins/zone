//! Background full-library acoustic feature analysis.
//!
//! A single background task drains `music_feature_jobs` in small batches,
//! decoding a short mid-track PCM window per song with Symphonia and folding
//! the result into the existing feature vector table. Progress is pushed to
//! the frontend as `feature-status-changed` events so the UI can show a light,
//! non-blocking indicator.
use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::features::{
  analyze_and_store_track_with_pcm, enqueue_missing_feature_jobs, feature_status,
};
use super::pcm::summarize_pcm_from_path;
use super::types::MusicState;
use crate::db::open_zone_database;

const BATCH_SIZE: usize = 8;
const IDLE_DELAY_MS: u64 = 1500;

static WORKER_STARTED: AtomicBool = AtomicBool::new(false);
static WAKE_SIGNAL: OnceLock<Mutex<bool>> = OnceLock::new();

fn wake_signal() -> &'static Mutex<bool> {
  WAKE_SIGNAL.get_or_init(|| Mutex::new(false))
}

/// Ensure the background worker is running. Safe to call multiple times.
pub(crate) fn start_feature_worker(app: AppHandle, state: MusicState) {
  if WORKER_STARTED.swap(true, Ordering::SeqCst) {
    return;
  }
  std::thread::spawn(move || run_worker(app, state));
}

/// Ask the worker to look for new jobs soon (e.g. after a scan or manual trigger).
pub(crate) fn request_feature_analysis() {
  if let Ok(mut pending) = wake_signal().lock() {
    *pending = true;
  }
}

fn run_worker(app: AppHandle, state: MusicState) {
  loop {
    if state.ensure_ready().is_err() {
      std::thread::sleep(Duration::from_millis(IDLE_DELAY_MS * 4));
      continue;
    }

    let mut connection = match open_zone_database(state.db_path()) {
      Ok(connection) => connection,
      Err(_) => {
        std::thread::sleep(Duration::from_millis(IDLE_DELAY_MS * 4));
        continue;
      }
    };

    // Top up the queue with any tracks that still lack current-version features.
    let _ = enqueue_missing_feature_jobs(&connection, BATCH_SIZE * 4);

    let processed = match process_batch(&mut connection, &app, BATCH_SIZE) {
      Ok(count) => count,
      Err(error) => {
        eprintln!("[features] background batch failed: {error}");
        0
      }
    };

    if processed == 0 {
      // Nothing to do; wait for a wake-up or poll again slowly.
      let signaled = wake_signal()
        .lock()
        .map(|mut flag| {
          let was = *flag;
          *flag = false;
          was
        })
        .unwrap_or(false);
      if !signaled {
        std::thread::sleep(Duration::from_millis(IDLE_DELAY_MS * 4));
      }
    } else {
      // Yield briefly between batches to stay out of the way of playback.
      std::thread::sleep(Duration::from_millis(IDLE_DELAY_MS / 3));
    }
  }
}

fn process_batch(
  connection: &mut Connection,
  app: &AppHandle,
  limit: usize,
) -> Result<usize, String> {
  let now = crate::db::unix_millis();
  let mut statement = connection
    .prepare(
      "
      SELECT j.track_id, t.path
      FROM music_feature_jobs j
      JOIN music_tracks t ON t.id = j.track_id
      WHERE j.status IN ('pending', 'failed') AND t.missing = 0
      ORDER BY j.queued_at ASC
      LIMIT ?1
      ",
    )
    .map_err(|error| format!("无法读取分析任务：{error}"))?;
  let jobs = statement
    .query_map(params![limit as i64], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })
    .map_err(|error| format!("无法读取分析任务：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取分析任务：{error}"))?;

  if jobs.is_empty() {
    emit_status(connection, app);
    return Ok(0);
  }

  let mut processed = 0_usize;
  for (track_id, path) in jobs {
    connection
      .execute(
        "
        UPDATE music_feature_jobs
        SET status = 'running', attempts = attempts + 1, started_at = ?2, last_error = NULL
        WHERE track_id = ?1
        ",
        params![track_id, now],
      )
      .map_err(|error| format!("无法更新分析任务：{error}"))?;

    let pcm = summarize_pcm_from_path(&path);
    match analyze_and_store_track_with_pcm(connection, &track_id, pcm) {
      Ok(_) => {
        connection
          .execute(
            "UPDATE music_feature_jobs SET status = 'done', finished_at = ?2 WHERE track_id = ?1",
            params![track_id, crate::db::unix_millis()],
          )
          .map_err(|error| format!("无法完成分析任务：{error}"))?;
      }
      Err(error) => {
        connection
          .execute(
            "UPDATE music_feature_jobs SET status = 'failed', finished_at = ?2, last_error = ?3 WHERE track_id = ?1",
            params![track_id, crate::db::unix_millis(), error],
          )
          .map_err(|error| format!("无法记录分析失败：{error}"))?;
      }
    }
    processed += 1;
    emit_status(connection, app);
  }
  Ok(processed)
}

fn emit_status(connection: &Connection, app: &AppHandle) {
  if let Ok(status) = feature_status(connection) {
    let _ = app.emit("feature-status-changed", status);
  }
}
