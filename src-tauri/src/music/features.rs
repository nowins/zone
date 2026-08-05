use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;

use super::types::*;
use super::store::track_exists_on;
use crate::db::unix_millis;
use crate::library::Track;

pub(crate) const FEATURE_ANALYZER_VERSION: i64 = 1;
pub(crate) const FEATURE_DIM: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackFeatureVector {
  pub track_id: String,
  pub analyzer_version: i64,
  pub vector: Vec<f32>,
  pub duration_seconds: Option<f64>,
  pub sample_rate: Option<i64>,
  pub computed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeatureJobStatus {
  pub pending: i64,
  pub running: i64,
  pub done: i64,
  pub failed: i64,
  pub cancelled: i64,
  pub total_tracks: i64,
  pub analyzer_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SimilarTrackMatch {
  pub track_id: String,
  pub score: f32,
  pub distance: f32,
}


#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PcmFeatureSummary {
  pub rms: Option<f32>,
  pub peak: Option<f32>,
  pub zero_crossing_rate: Option<f32>,
  pub spectral_centroid: Option<f32>,
  pub tempo_bpm: Option<f32>,
}

pub(crate) fn enrich_vector_with_pcm(mut vector: Vec<f32>, pcm: &PcmFeatureSummary) -> Vec<f32> {
  if vector.len() < FEATURE_DIM {
    vector.resize(FEATURE_DIM, 0.0);
  }
  // Reuse trailing slots with real acoustic measurements when available.
  if let Some(rms) = pcm.rms {
    vector[18] = vector[18] * 0.35 + rms.clamp(0.0, 1.0) * 0.65;
  }
  if let Some(peak) = pcm.peak {
    vector[19] = vector[19] * 0.35 + peak.clamp(0.0, 1.0) * 0.65;
  }
  if let Some(zcr) = pcm.zero_crossing_rate {
    vector[20] = vector[20] * 0.4 + zcr.clamp(0.0, 1.0) * 0.6;
  }
  if let Some(centroid) = pcm.spectral_centroid {
    vector[21] = vector[21] * 0.4 + centroid.clamp(0.0, 1.0) * 0.6;
  }
  if let Some(tempo) = pcm.tempo_bpm {
    vector[22] = ((tempo - 60.0) / 140.0).clamp(0.0, 1.0);
  }
  l2_normalize(&mut vector);
  vector
}

pub(crate) fn build_feature_vector(
  track: &Track,
  activity: Option<&TrackActivityRecord>,
) -> Vec<f32> {
  let mut vector = vec![0.0_f32; FEATURE_DIM];

  // 0..7 genre hash bags
  for genre in &track.genres {
    let bucket = stable_bucket(genre, 8);
    vector[bucket] += 1.0;
  }
  normalize_slice(&mut vector[0..8]);

  // 8..11 artist identity
  let artist = if track.artist.trim().is_empty() {
    track.album_artist.as_str()
  } else {
    track.artist.as_str()
  };
  write_hash_slots(&mut vector, 8, 4, artist);

  // 12..14 album identity
  write_hash_slots(&mut vector, 12, 3, &track.album);

  // 15 year normalized around 1950..2030
  if let Some(year) = track.year {
    let y = (year as f32 - 1950.0) / 80.0;
    vector[15] = y.clamp(0.0, 1.0);
  }

  // 16 duration bucket
  if let Some(duration) = track.duration_seconds {
    vector[16] = ((duration as f32) / 480.0).clamp(0.0, 1.0);
  }

  // 17 title token-ish hash
  write_hash_slots(&mut vector, 17, 1, &track.title);

  // 18..23 listening profile
  if let Some(stats) = activity {
    let attempts = (stats.play_count + stats.skip_count).max(0) as f32;
    let play = stats.play_count.max(0) as f32;
    let complete = stats.completed_count.max(0) as f32;
    let skip = stats.skip_count.max(0) as f32;
    vector[18] = (play / 20.0).clamp(0.0, 1.0);
    vector[19] = if play > 0.0 { (complete / play).clamp(0.0, 1.0) } else { 0.0 };
    vector[20] = if attempts > 0.0 { (skip / attempts).clamp(0.0, 1.0) } else { 0.0 };
    if let Some(last_played) = stats.last_played_at {
      let age_days = ((unix_millis() - last_played).max(0) as f32) / 86_400_000.0;
      vector[21] = (age_days / 180.0).clamp(0.0, 1.0);
    } else {
      vector[21] = 1.0;
    }
    vector[22] = if stats.play_count > 0 { 1.0 } else { 0.0 };
    vector[23] = if stats.completed_count > 0 { 1.0 } else { 0.0 };
  } else {
    vector[21] = 1.0;
  }

  l2_normalize(&mut vector);
  vector
}

pub(crate) fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
  if left.len() != right.len() || left.is_empty() {
    return 0.0;
  }
  let mut dot = 0.0;
  let mut left_norm = 0.0;
  let mut right_norm = 0.0;
  for index in 0..left.len() {
    dot += left[index] * right[index];
    left_norm += left[index] * left[index];
    right_norm += right[index] * right[index];
  }
  if left_norm <= f32::EPSILON || right_norm <= f32::EPSILON {
    return 0.0;
  }
  (dot / (left_norm.sqrt() * right_norm.sqrt())).clamp(-1.0, 1.0)
}

pub(crate) fn enqueue_missing_feature_jobs(
  connection: &Connection,
  limit: usize,
) -> Result<i64, String> {
  let now = unix_millis();
  let mut statement = connection
    .prepare(
      "
      SELECT t.id
      FROM music_tracks t
      LEFT JOIN music_track_features f
        ON f.track_id = t.id AND f.analyzer_version = ?1
      LEFT JOIN music_feature_jobs j
        ON j.track_id = t.id
      WHERE t.missing = 0
        AND f.track_id IS NULL
        AND (j.track_id IS NULL OR j.status IN ('failed', 'cancelled'))
      ORDER BY t.added_at DESC, t.id
      LIMIT ?2
      ",
    )
    .map_err(|error| format!("无法查询待分析曲目：{error}"))?;
  let ids = statement
    .query_map(params![FEATURE_ANALYZER_VERSION, limit as i64], |row| row.get::<_, String>(0))
    .map_err(|error| format!("无法查询待分析曲目：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法查询待分析曲目：{error}"))?;

  let mut queued = 0_i64;
  for track_id in ids {
    connection
      .execute(
        "
        INSERT INTO music_feature_jobs (
          track_id, status, attempts, last_error, queued_at, started_at, finished_at
        ) VALUES (?1, 'pending', 0, NULL, ?2, NULL, NULL)
        ON CONFLICT(track_id) DO UPDATE SET
          status = 'pending',
          last_error = NULL,
          queued_at = excluded.queued_at,
          started_at = NULL,
          finished_at = NULL
        ",
        params![track_id, now],
      )
      .map_err(|error| format!("无法写入分析任务：{error}"))?;
    queued += 1;
  }
  Ok(queued)
}

pub(crate) fn process_feature_jobs(
  connection: &Connection,
  limit: usize,
) -> Result<i64, String> {
  let now = unix_millis();
  let mut statement = connection
    .prepare(
      "
      SELECT track_id
      FROM music_feature_jobs
      WHERE status IN ('pending', 'failed')
      ORDER BY queued_at ASC
      LIMIT ?1
      ",
    )
    .map_err(|error| format!("无法读取分析任务：{error}"))?;
  let jobs = statement
    .query_map(params![limit as i64], |row| row.get::<_, String>(0))
    .map_err(|error| format!("无法读取分析任务：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取分析任务：{error}"))?;

  let mut done = 0_i64;
  for track_id in jobs {
    connection
      .execute(
        "
        UPDATE music_feature_jobs
        SET status = 'running',
            attempts = attempts + 1,
            started_at = ?2,
            last_error = NULL
        WHERE track_id = ?1
        ",
        params![track_id, now],
      )
      .map_err(|error| format!("无法更新分析任务：{error}"))?;

    match analyze_and_store_track(connection, &track_id) {
      Ok(_) => {
        connection
          .execute(
            "
            UPDATE music_feature_jobs
            SET status = 'done', finished_at = ?2
            WHERE track_id = ?1
            ",
            params![track_id, unix_millis()],
          )
          .map_err(|error| format!("无法完成分析任务：{error}"))?;
        done += 1;
      }
      Err(error) => {
        connection
          .execute(
            "
            UPDATE music_feature_jobs
            SET status = 'failed', finished_at = ?2, last_error = ?3
            WHERE track_id = ?1
            ",
            params![track_id, unix_millis(), error],
          )
          .map_err(|error| format!("无法记录分析失败：{error}"))?;
      }
    }
  }
  Ok(done)
}

pub(crate) fn analyze_and_store_track(
  connection: &Connection,
  track_id: &str,
) -> Result<TrackFeatureVector, String> {
  analyze_and_store_track_with_pcm(connection, track_id, None)
}

pub(crate) fn analyze_and_store_track_with_pcm(
  connection: &Connection,
  track_id: &str,
  pcm: Option<PcmFeatureSummary>,
) -> Result<TrackFeatureVector, String> {
  if !track_exists_on(connection, track_id) {
    return Err("曲目不存在".to_string());
  }
  let track = load_track(connection, track_id)?;
  let activity = load_activity(connection, track_id)?;
  let mut vector = build_feature_vector(&track, activity.as_ref());
  if let Some(summary) = pcm.as_ref() {
    vector = enrich_vector_with_pcm(vector, summary);
  }
  let now = unix_millis();
  let vector_json = serde_json::to_string(&vector)
    .map_err(|error| format!("无法序列化特征向量：{error}"))?;
  connection
    .execute(
      "
      INSERT INTO music_track_features (
        track_id, analyzer_version, vector_json, duration_seconds, sample_rate, computed_at
      ) VALUES (?1, ?2, ?3, ?4, NULL, ?5)
      ON CONFLICT(track_id) DO UPDATE SET
        analyzer_version = excluded.analyzer_version,
        vector_json = excluded.vector_json,
        duration_seconds = excluded.duration_seconds,
        sample_rate = excluded.sample_rate,
        computed_at = excluded.computed_at
      ",
      params![
        track_id,
        FEATURE_ANALYZER_VERSION,
        vector_json,
        track.duration_seconds.map(|value| value as f64),
        now
      ],
    )
    .map_err(|error| format!("无法保存特征向量：{error}"))?;
  Ok(TrackFeatureVector {
    track_id: track_id.to_string(),
    analyzer_version: FEATURE_ANALYZER_VERSION,
    vector,
    duration_seconds: track.duration_seconds.map(|value| value as f64),
    sample_rate: None,
    computed_at: now,
  })
}

#[allow(dead_code)]
pub(crate) fn recompute_all_features(connection: &Connection) -> Result<i64, String> {
  let mut statement = connection
    .prepare("SELECT id FROM music_tracks WHERE missing = 0")
    .map_err(|error| format!("无法读取曲目：{error}"))?;
  let ids = statement
    .query_map([], |row| row.get::<_, String>(0))
    .map_err(|error| format!("无法读取曲目：{error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法读取曲目：{error}"))?;
  let mut count = 0_i64;
  for track_id in ids {
    analyze_and_store_track(connection, &track_id)?;
    count += 1;
  }
  Ok(count)
}

pub(crate) fn feature_status(connection: &Connection) -> Result<FeatureJobStatus, String> {
  let total_tracks: i64 = connection
    .query_row("SELECT COUNT(*) FROM music_tracks WHERE missing = 0", [], |row| row.get(0))
    .map_err(|error| format!("无法统计曲目：{error}"))?;
  let mut status = FeatureJobStatus {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    total_tracks,
    analyzer_version: FEATURE_ANALYZER_VERSION,
  };
  let mut statement = connection
    .prepare("SELECT status, COUNT(*) FROM music_feature_jobs GROUP BY status")
    .map_err(|error| format!("无法统计分析任务：{error}"))?;
  let rows = statement
    .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
    .map_err(|error| format!("无法统计分析任务：{error}"))?;
  for row in rows {
    let (name, count) = row.map_err(|error| format!("无法统计分析任务：{error}"))?;
    match name.as_str() {
      "pending" => status.pending = count,
      "running" => status.running = count,
      "done" => status.done = count,
      "failed" => status.failed = count,
      "cancelled" => status.cancelled = count,
      _ => {}
    }
  }
  // Prefer feature table done count when jobs table is sparse.
  let feature_done: i64 = connection
    .query_row(
      "SELECT COUNT(*) FROM music_track_features WHERE analyzer_version = ?1",
      params![FEATURE_ANALYZER_VERSION],
      |row| row.get(0),
    )
    .unwrap_or(0);
  if feature_done > status.done {
    status.done = feature_done;
  }
  Ok(status)
}

pub(crate) fn load_feature_map(
  connection: &Connection,
) -> Result<HashMap<String, Vec<f32>>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT track_id, vector_json
      FROM music_track_features
      WHERE analyzer_version = ?1
      ",
    )
    .map_err(|error| format!("无法读取特征：{error}"))?;
  let rows = statement
    .query_map(params![FEATURE_ANALYZER_VERSION], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })
    .map_err(|error| format!("无法读取特征：{error}"))?;
  let mut map = HashMap::new();
  for row in rows {
    let (track_id, raw) = row.map_err(|error| format!("无法读取特征：{error}"))?;
    if let Ok(vector) = serde_json::from_str::<Vec<f32>>(&raw) {
      if vector.len() == FEATURE_DIM {
        map.insert(track_id, vector);
      }
    }
  }
  Ok(map)
}

pub(crate) fn find_similar_tracks(
  connection: &Connection,
  track_id: &str,
  limit: usize,
) -> Result<Vec<SimilarTrackMatch>, String> {
  let features = load_feature_map(connection)?;
  let Some(seed) = features.get(track_id) else {
    return Ok(vec![]);
  };
  let mut matches = features
    .iter()
    .filter(|(id, _)| id.as_str() != track_id)
    .map(|(id, vector)| {
      let score = cosine_similarity(seed, vector);
      SimilarTrackMatch {
        track_id: id.clone(),
        score,
        distance: 1.0 - score,
      }
    })
    .collect::<Vec<_>>();
  matches.sort_by(|left, right| {
    right
      .score
      .partial_cmp(&left.score)
      .unwrap_or(Ordering::Equal)
      .then_with(|| left.track_id.cmp(&right.track_id))
  });
  matches.truncate(limit.max(1));
  Ok(matches)
}

fn load_track(connection: &Connection, track_id: &str) -> Result<Track, String> {
  connection
    .query_row(
      "
      SELECT
        id, path, file_name, title, artist, album, album_artist,
        track_number, disc_number, year, duration_seconds, genres_json,
        added_at, extension, cover_path
      FROM music_tracks
      WHERE id = ?1
      ",
      params![track_id],
      |row| {
        let genres_json: String = row.get(11)?;
        let genres = serde_json::from_str(&genres_json).unwrap_or_default();
        Ok(Track {
          id: row.get(0)?,
          path: row.get(1)?,
          file_name: row.get(2)?,
          title: row.get(3)?,
          artist: row.get(4)?,
          album: row.get(5)?,
          album_artist: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
          track_number: row.get::<_, Option<i64>>(7)?.and_then(|value| u32::try_from(value).ok()),
          disc_number: row.get::<_, Option<i64>>(8)?.and_then(|value| u32::try_from(value).ok()),
          year: row.get::<_, Option<i64>>(9)?.and_then(|value| u32::try_from(value).ok()),
          genres,
          duration_seconds: row.get::<_, Option<f64>>(10)?.map(|value| value.round() as u64),
          added_at: row.get::<_, Option<i64>>(12)?.and_then(|value| u64::try_from(value).ok()),
          extension: row.get(13)?,
          cover_path: row.get(14)?,
        })
      },
    )
    .map_err(|error| format!("无法读取曲目：{error}"))
}

fn load_activity(
  connection: &Connection,
  track_id: &str,
) -> Result<Option<TrackActivityRecord>, String> {
  connection
    .query_row(
      "
      SELECT
        COALESCE(t.added_at, 0),
        COALESCE(s.play_count, 0),
        COALESCE(s.complete_count, 0),
        COALESCE(s.skip_count, 0),
        s.last_played_at,
        s.last_skipped_at
      FROM music_tracks t
      LEFT JOIN music_track_stats s ON s.track_id = t.id
      WHERE t.id = ?1
      ",
      params![track_id],
      |row| {
        Ok(TrackActivityRecord {
          added_at: row.get(0)?,
          play_count: row.get(1)?,
          completed_count: row.get(2)?,
          skip_count: row.get(3)?,
          last_played_at: row.get(4)?,
          last_skipped_at: row.get(5)?,
        })
      },
    )
    .optional()
    .map_err(|error| format!("无法读取播放统计：{error}"))
}

fn write_hash_slots(vector: &mut [f32], offset: usize, slots: usize, value: &str) {
  if slots == 0 || value.trim().is_empty() {
    return;
  }
  let bucket = stable_bucket(value, slots);
  if offset + bucket < vector.len() {
    vector[offset + bucket] = 1.0;
  }
}

fn stable_bucket(value: &str, buckets: usize) -> usize {
  if buckets == 0 {
    return 0;
  }
  let mut hash: u32 = 2166136261;
  for byte in value.trim().to_lowercase().bytes() {
    hash ^= u32::from(byte);
    hash = hash.wrapping_mul(16777619);
  }
  (hash as usize) % buckets
}

fn normalize_slice(values: &mut [f32]) {
  let sum: f32 = values.iter().map(|value| value.max(0.0)).sum();
  if sum <= f32::EPSILON {
    return;
  }
  for value in values.iter_mut() {
    *value /= sum;
  }
}

fn l2_normalize(values: &mut [f32]) {
  let mut norm = 0.0;
  for value in values.iter() {
    norm += *value * *value;
  }
  let norm = norm.sqrt();
  if norm <= f32::EPSILON {
    return;
  }
  for value in values.iter_mut() {
    *value /= norm;
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::library::Track;

  fn sample(id: &str, artist: &str, album: &str, genres: &[&str]) -> Track {
    Track {
      id: id.to_string(),
      path: format!("C:/music/{id}.mp3"),
      file_name: format!("{id}.mp3"),
      title: id.to_string(),
      artist: artist.to_string(),
      album: album.to_string(),
      album_artist: artist.to_string(),
      track_number: Some(1),
      disc_number: Some(1),
      year: Some(2020),
      genres: genres.iter().map(|value| value.to_string()).collect(),
      duration_seconds: Some(200),
      added_at: Some(1),
      extension: "mp3".to_string(),
      cover_path: None,
    }
  }

  #[test]
  fn similar_tracks_rank_closer_metadata_higher() {
    let seed = sample("seed", "Aiko", "Dawn", &["City Pop", "Pop"]);
    let near = sample("near", "Aiko", "Night", &["City Pop"]);
    let far = sample("far", "MetalBand", "Forge", &["Metal"]);
    let seed_vec = build_feature_vector(&seed, None);
    let near_vec = build_feature_vector(&near, None);
    let far_vec = build_feature_vector(&far, None);
    let near_score = cosine_similarity(&seed_vec, &near_vec);
    let far_score = cosine_similarity(&seed_vec, &far_vec);
    assert!(near_score > far_score);
  }
}
