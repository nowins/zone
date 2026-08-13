use super::*;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn open_database(path: &Path) -> Result<Connection, String> {
  // Metadata shares the unified zone.sqlite file.
  crate::db::open_zone_database(path)
}

pub(crate) fn persist_metadata_candidate(
  state: &MetadataState,
  resolved: &ResolvedMetadataCandidate,
  tracks: &[MetadataTrackInput],
) -> Result<(), String> {
  state.ensure_ready()?;
  if tracks.is_empty() || tracks.len() > 500 {
    return Err("本地补充信息的歌曲范围无效".to_string());
  }
  let mut connection = open_database(&state.db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始保存音乐信息：{error}"))?;
  let now = unix_millis();
  let candidate = &resolved.candidate;

  transaction
    .execute(
      "
      INSERT INTO metadata_entities (
        id, kind, display_name, provider_id, provider_name, source_path, confidence, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        display_name = excluded.display_name,
        provider_id = excluded.provider_id,
        provider_name = excluded.provider_name,
        source_path = excluded.source_path,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at
      ",
      params![
        candidate.id,
        candidate.kind.as_str(),
        resolved.display_name,
        candidate.provider_id,
        candidate.provider_name,
        candidate.source_path,
        candidate.confidence,
        now,
      ],
    )
    .map_err(|error| format!("无法保存音乐信息实体：{error}"))?;
  transaction
    .execute(
      "DELETE FROM metadata_fields WHERE entity_id = ?1 AND provider_id = ?2",
      params![candidate.id, candidate.provider_id],
    )
    .map_err(|error| format!("无法更新音乐信息字段：{error}"))?;

  for (field_name, value) in &resolved.values {
    let value_json =
      serde_json::to_string(value).map_err(|error| format!("无法编码音乐信息字段：{error}"))?;
    transaction
      .execute(
        "
        INSERT INTO metadata_fields (
          entity_id, field_name, value_json, provider_id, confidence, fetched_at, expires_at, selected
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 1)
        ",
        params![
          candidate.id,
          field_name,
          value_json,
          candidate.provider_id,
          candidate.confidence,
          now,
        ],
      )
      .map_err(|error| format!("无法保存音乐信息字段：{error}"))?;
  }

  transaction
    .execute(
      "DELETE FROM metadata_provider_bindings WHERE entity_id = ?1",
      params![candidate.id],
    )
    .map_err(|error| format!("无法更新音乐信息外部标识：{error}"))?;
  for (provider_id, external_id) in &resolved.external_ids {
    transaction
      .execute(
        "
        INSERT INTO metadata_provider_bindings (
          entity_id, provider_id, external_id, confidence, matched_at
        ) VALUES (?1, ?2, ?3, ?4, ?5)
        ",
        params![
          candidate.id,
          provider_id,
          external_id,
          candidate.confidence,
          now,
        ],
      )
      .map_err(|error| format!("无法保存音乐信息外部标识：{error}"))?;
  }

  let mut seen_ids = HashSet::new();
  for track in tracks {
    if track.id.trim().is_empty() || track.id.len() > 256 || !seen_ids.insert(track.id.as_str()) {
      return Err("本地补充信息包含无效歌曲".to_string());
    }
    transaction
      .execute(
        "
        INSERT INTO metadata_entity_links (track_id, kind, entity_id, linked_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(track_id, kind) DO UPDATE SET
          entity_id = excluded.entity_id,
          linked_at = excluded.linked_at
        ",
        params![track.id, candidate.kind.as_str(), candidate.id, now],
      )
      .map_err(|error| format!("无法关联歌曲与补充信息：{error}"))?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交音乐信息：{error}"))?;
  Ok(())
}

pub(crate) fn read_track_overlays(
  state: &MetadataState,
  track_ids: &[String],
) -> Result<Vec<MetadataTrackOverlay>, String> {
  state.ensure_ready()?;
  if track_ids.len() > 100_000 {
    return Err("歌曲信息查询范围过大".to_string());
  }
  let requested: HashSet<&str> = track_ids
    .iter()
    .filter_map(|id| {
      let id = id.trim();
      (!id.is_empty() && id.len() <= 256).then_some(id)
    })
    .collect();
  if requested.is_empty() {
    return Ok(Vec::new());
  }
  let connection = open_database(&state.db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT
        links.track_id,
        entities.kind,
        fields.field_name,
        fields.value_json,
        entities.provider_id,
        entities.provider_name,
        entities.source_path,
        entities.confidence,
        entities.updated_at
      FROM metadata_entity_links AS links
      INNER JOIN metadata_entities AS entities ON entities.id = links.entity_id
      INNER JOIN metadata_fields AS fields ON fields.entity_id = entities.id
      WHERE fields.selected = 1
      ORDER BY
        links.track_id,
        CASE entities.kind WHEN 'artist' THEN 1 WHEN 'album' THEN 2 ELSE 3 END,
        fields.field_name
      ",
    )
    .map_err(|error| format!("无法读取音乐信息：{error}"))?;
  let rows = statement
    .query_map([], |row| {
      Ok((
        row.get::<_, String>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, String>(2)?,
        row.get::<_, String>(3)?,
        row.get::<_, String>(4)?,
        row.get::<_, String>(5)?,
        row.get::<_, String>(6)?,
        row.get::<_, u8>(7)?,
        row.get::<_, i64>(8)?,
      ))
    })
    .map_err(|error| format!("无法查询音乐信息：{error}"))?;

  let mut overlays: HashMap<String, MetadataTrackOverlay> = HashMap::new();
  for row in rows {
    let (
      track_id,
      kind,
      field_name,
      value_json,
      provider_id,
      provider_name,
      source_path,
      confidence,
      updated_at,
    ) = row.map_err(|error| format!("无法解析音乐信息：{error}"))?;
    if !requested.contains(track_id.as_str()) {
      continue;
    }
    let Ok(value) = serde_json::from_str::<Value>(&value_json) else {
      continue;
    };
    let Some(effective_field) = effective_track_field(&kind, &field_name) else {
      continue;
    };
    let overlay = overlays
      .entry(track_id.clone())
      .or_insert_with(|| MetadataTrackOverlay {
        track_id,
        ..MetadataTrackOverlay::default()
      });
    if apply_overlay_value(overlay, effective_field, &value) {
      overlay.sources.push(MetadataFieldSource {
        field: effective_field.to_string(),
        provider_id,
        provider_name,
        source_path,
        confidence,
        updated_at,
      });
    }
  }

  let mut overlays: Vec<_> = overlays.into_values().collect();
  overlays.sort_by(|left, right| left.track_id.cmp(&right.track_id));
  Ok(overlays)
}

fn effective_track_field<'a>(kind: &str, field_name: &'a str) -> Option<&'a str> {
  match (kind, field_name) {
    ("track", "title")
    | ("track", "artist")
    | ("track", "album")
    | ("track", "album_artist")
    | ("track", "track_number")
    | ("track", "disc_number")
    | ("track", "year")
    | ("track", "genres")
    | ("track", "album_cover_path") => Some(field_name),
    ("album", "title") => Some("album"),
    ("album", "artist") => Some("album_artist"),
    ("album", "year") => Some("year"),
    ("album", "genres") => Some("genres"),
    ("album", "album_cover_path") => Some("album_cover_path"),
    ("artist", "name") => Some("artist"),
    ("artist", "artist_image_path") => Some("artist_image_path"),
    ("artist", "biography") => Some("artist_biography"),
    _ => None,
  }
}

fn apply_overlay_value(
  overlay: &mut MetadataTrackOverlay,
  field: &str,
  value: &Value,
) -> bool {
  match field {
    "title" => set_string(&mut overlay.title, value),
    "artist" => set_string(&mut overlay.artist, value),
    "album" => set_string(&mut overlay.album, value),
    "album_artist" => set_string(&mut overlay.album_artist, value),
    "track_number" => {
      let Some(value) = value.as_u64().and_then(|value| u32::try_from(value).ok()) else {
        return false;
      };
      overlay.track_number = Some(value);
      true
    }
    "disc_number" => {
      let Some(value) = value.as_u64().and_then(|value| u32::try_from(value).ok()) else {
        return false;
      };
      overlay.disc_number = Some(value);
      true
    }
    "year" => {
      let Some(value) = value.as_u64().and_then(|value| u32::try_from(value).ok()) else {
        return false;
      };
      overlay.year = Some(value);
      true
    }
    "genres" => {
      let Some(values) = value.as_array() else {
        return false;
      };
      let values: Vec<String> = values
        .iter()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect();
      if values.is_empty() {
        false
      } else {
        overlay.genres = Some(values);
        true
      }
    }
    "album_cover_path" => set_string(&mut overlay.cover_path, value),
    "artist_image_path" => set_string(&mut overlay.artist_image_path, value),
    "artist_biography" => set_string(&mut overlay.artist_biography, value),
    _ => false,
  }
}

fn set_string(slot: &mut Option<String>, value: &Value) -> bool {
  let Some(value) = value.as_str().map(str::trim).filter(|value| !value.is_empty()) else {
    return false;
  };
  *slot = Some(value.to_string());
  true
}

pub(crate) fn read_context_metadata(
  state: &MetadataState,
  kind: MetadataEntityKind,
  track_ids: &[String],
) -> Result<Option<MetadataContextRecord>, String> {
  state.ensure_ready()?;
  if track_ids.is_empty() || track_ids.len() > 500 {
    return Ok(None);
  }
  let requested: HashSet<&str> = track_ids.iter().map(String::as_str).collect();
  let connection = open_database(&state.db_path)?;
  let mut link_statement = connection
    .prepare("SELECT track_id, entity_id FROM metadata_entity_links WHERE kind = ?1")
    .map_err(|error| format!("无法读取音乐信息关联：{error}"))?;
  let links = link_statement
    .query_map(params![kind.as_str()], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })
    .map_err(|error| format!("无法查询音乐信息关联：{error}"))?;
  let mut counts: HashMap<String, usize> = HashMap::new();
  for link in links {
    let (track_id, entity_id) =
      link.map_err(|error| format!("无法解析音乐信息关联：{error}"))?;
    if requested.contains(track_id.as_str()) {
      *counts.entry(entity_id).or_default() += 1;
    }
  }
  let Some((entity_id, _)) = counts.into_iter().max_by_key(|(_, count)| *count) else {
    return Ok(None);
  };
  let entity = connection
    .query_row(
      "
      SELECT provider_id, provider_name, source_path, confidence, updated_at
      FROM metadata_entities
      WHERE id = ?1 AND kind = ?2
      ",
      params![entity_id, kind.as_str()],
      |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, String>(2)?,
          row.get::<_, u8>(3)?,
          row.get::<_, i64>(4)?,
        ))
      },
    )
    .optional()
    .map_err(|error| format!("无法读取音乐信息实体：{error}"))?;
  let Some((provider_id, provider_name, source_path, confidence, updated_at)) = entity else {
    return Ok(None);
  };

  let mut field_statement = connection
    .prepare(
      "
      SELECT field_name, value_json
      FROM metadata_fields
      WHERE entity_id = ?1 AND selected = 1
      ORDER BY field_name
      ",
    )
    .map_err(|error| format!("无法读取音乐信息字段：{error}"))?;
  let rows = field_statement
    .query_map(params![entity_id], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })
    .map_err(|error| format!("无法查询音乐信息字段：{error}"))?;
  let mut fields = Vec::new();
  for row in rows {
    let (key, value_json) =
      row.map_err(|error| format!("无法解析音乐信息字段：{error}"))?;
    let Ok(value) = serde_json::from_str::<Value>(&value_json) else {
      continue;
    };
    fields.push(MetadataCandidateField {
      label: field_label(&key).to_string(),
      value: display_value(&value),
      key,
    });
  }

  Ok(Some(MetadataContextRecord {
    entity_id,
    kind,
    provider_id,
    provider_name,
    source_path,
    confidence,
    updated_at,
    fields,
  }))
}

pub(crate) fn clear_context_metadata(
  state: &MetadataState,
  kind: MetadataEntityKind,
  track_ids: &[String],
) -> Result<usize, String> {
  state.ensure_ready()?;
  if track_ids.is_empty() || track_ids.len() > 500 {
    return Ok(0);
  }
  let mut connection = open_database(&state.db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("无法开始清除音乐信息：{error}"))?;
  let mut removed = 0;
  let mut seen = HashSet::new();
  for track_id in track_ids {
    let track_id = track_id.trim();
    if track_id.is_empty() || track_id.len() > 256 || !seen.insert(track_id) {
      continue;
    }
    removed += transaction
      .execute(
        "DELETE FROM metadata_entity_links WHERE track_id = ?1 AND kind = ?2",
        params![track_id, kind.as_str()],
      )
      .map_err(|error| format!("无法清除音乐信息关联：{error}"))?;
  }
  transaction
    .commit()
    .map_err(|error| format!("无法提交音乐信息清理：{error}"))?;
  Ok(removed)
}

fn unix_millis() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .ok()
    .and_then(|duration| i64::try_from(duration.as_millis()).ok())
    .unwrap_or(0)
}
