use super::*;
use rusqlite::{params, Connection, TransactionBehavior};
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
  exclude_fields: &[&str],
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
  // Excluded fields survive re-adoption: keep their existing rows instead of
  // clearing them with the provider's other fields.
  let mut delete_sql =
    "DELETE FROM metadata_fields WHERE entity_id = ?1 AND provider_id = ?2".to_string();
  for index in 0..exclude_fields.len() {
    delete_sql.push_str(&format!(" AND field_name != ?{}", index + 3));
  }
  let mut delete_params: Vec<Box<dyn rusqlite::ToSql>> = vec![
    Box::new(candidate.id.clone()),
    Box::new(candidate.provider_id.clone()),
  ];
  for field in exclude_fields {
    delete_params.push(Box::new(field.to_string()));
  }
  let delete_params_ref: Vec<&dyn rusqlite::ToSql> =
    delete_params.iter().map(|param| param.as_ref()).collect();
  transaction
    .execute(&delete_sql, delete_params_ref.as_slice())
    .map_err(|error| format!("无法更新音乐信息字段：{error}"))?;

  for (field_name, value) in &resolved.values {
    // Automatic passes may veto fields that would clobber good local data
    // (e.g. description backfill must not replace an embedded album cover).
    if exclude_fields.contains(&field_name.as_str()) {
      continue;
    }
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
        DELETE FROM metadata_entity_links
        WHERE track_id = ?1
          AND kind = ?2
          AND entity_id IN (
            SELECT id FROM metadata_entities WHERE provider_id = ?3
          )
        ",
        params![track.id, candidate.kind.as_str(), candidate.provider_id],
      )
      .map_err(|error| format!("无法更新音乐信息来源关联：{error}"))?;
    transaction
      .execute(
        "
        INSERT INTO metadata_entity_links (track_id, kind, entity_id, linked_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(track_id, kind, entity_id) DO UPDATE SET
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
        fields.provider_id,
        entities.provider_name,
        entities.source_path,
        fields.confidence,
        fields.fetched_at
      FROM metadata_entity_links AS links
      INNER JOIN metadata_entities AS entities ON entities.id = links.entity_id
      INNER JOIN metadata_fields AS fields ON fields.entity_id = entities.id
      WHERE fields.selected = 1
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

  let mut selected_fields: HashMap<(String, String), RankedMetadataField> = HashMap::new();
  let mut artist_images: HashMap<String, HashMap<String, RankedImageAsset>> = HashMap::new();
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
    let source = MetadataFieldSource {
      field: effective_field.to_string(),
      provider_id,
      provider_name,
      source_path,
      confidence,
      updated_at,
    };
    let rank = metadata_field_rank(&kind, &source);
    if effective_field == "artist_image_path" {
      for path in metadata_image_paths(&value) {
        let candidate = RankedImageAsset {
          asset: MetadataImageAsset {
            path: path.clone(),
            provider_id: source.provider_id.clone(),
            provider_name: source.provider_name.clone(),
            source_path: source.source_path.clone(),
            confidence: source.confidence,
            updated_at: source.updated_at,
          },
          rank,
        };
        let images = artist_images.entry(track_id.clone()).or_default();
        if images
          .get(&path)
          .map_or(true, |current| ranked_image_precedes(&candidate, current))
        {
          images.insert(path, candidate);
        }
      }
      continue;
    }
    let key = (track_id, effective_field.to_string());
    let candidate = RankedMetadataField { value, source, rank };
    if selected_fields
      .get(&key)
      .map_or(true, |current| ranked_field_precedes(&candidate, current))
    {
      selected_fields.insert(key, candidate);
    }
  }

  let mut overlays: HashMap<String, MetadataTrackOverlay> = HashMap::new();
  for ((track_id, field), selected) in selected_fields {
    let overlay = overlays
      .entry(track_id.clone())
      .or_insert_with(|| MetadataTrackOverlay {
        track_id,
        ..MetadataTrackOverlay::default()
      });
    if apply_overlay_value(overlay, &field, &selected.value) {
      overlay.sources.push(selected.source);
    }
  }
  for (track_id, images) in artist_images {
    let overlay = overlays
      .entry(track_id.clone())
      .or_insert_with(|| MetadataTrackOverlay {
        track_id,
        ..MetadataTrackOverlay::default()
      });
    let mut images = images.into_values().collect::<Vec<_>>();
    images.sort_by(|left, right| compare_image_rank(right, left));
    overlay.artist_images = images
      .into_iter()
      .map(|image| image.asset)
      .collect();
    overlay.artist_image_path = overlay
      .artist_images
      .first()
      .map(|image| image.path.clone());
    overlay.sources.extend(overlay.artist_images.iter().map(|image| MetadataFieldSource {
      field: "artist_image_path".to_string(),
      provider_id: image.provider_id.clone(),
      provider_name: image.provider_name.clone(),
      source_path: image.source_path.clone(),
      confidence: image.confidence,
      updated_at: image.updated_at,
    }));
  }
  for overlay in overlays.values_mut() {
    overlay.sources.sort_by(|left, right| {
      left
        .field
        .cmp(&right.field)
        .then_with(|| metadata_provider_priority(&right.provider_id).cmp(&metadata_provider_priority(&left.provider_id)))
        .then_with(|| right.confidence.cmp(&left.confidence))
        .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
  }

  let mut overlays: Vec<_> = overlays.into_values().collect();
  overlays.sort_by(|left, right| left.track_id.cmp(&right.track_id));
  Ok(overlays)
}

type MetadataFieldRank = (u8, u8, u8, i64);

#[derive(Clone)]
struct RankedMetadataField {
  value: Value,
  source: MetadataFieldSource,
  rank: MetadataFieldRank,
}

struct RankedImageAsset {
  asset: MetadataImageAsset,
  rank: MetadataFieldRank,
}

fn metadata_provider_priority(provider_id: &str) -> u8 {
  match provider_id {
    MANUAL_METADATA_PROVIDER_ID => 3,
    LOCAL_SIDECAR_PROVIDER_ID => 2,
    _ => 1,
  }
}

fn metadata_kind_priority(kind: &str) -> u8 {
  match kind {
    "track" => 3,
    "album" => 2,
    "artist" => 1,
    _ => 0,
  }
}

fn metadata_field_rank(kind: &str, source: &MetadataFieldSource) -> MetadataFieldRank {
  (
    metadata_provider_priority(&source.provider_id),
    metadata_kind_priority(kind),
    source.confidence,
    source.updated_at,
  )
}

fn ranked_field_precedes(candidate: &RankedMetadataField, current: &RankedMetadataField) -> bool {
  candidate.rank > current.rank
    || (candidate.rank == current.rank
      && candidate.source.provider_id < current.source.provider_id)
}

fn ranked_image_precedes(candidate: &RankedImageAsset, current: &RankedImageAsset) -> bool {
  candidate.rank > current.rank
    || (candidate.rank == current.rank
      && candidate.asset.provider_id < current.asset.provider_id)
}

fn compare_image_rank(
  left: &RankedImageAsset,
  right: &RankedImageAsset,
) -> std::cmp::Ordering {
  left
    .rank
    .cmp(&right.rank)
    .then_with(|| right.asset.provider_id.cmp(&left.asset.provider_id))
    .then_with(|| right.asset.path.cmp(&left.asset.path))
}

fn metadata_image_paths(value: &Value) -> Vec<String> {
  match value {
    Value::String(path) if !path.trim().is_empty() => vec![path.trim().to_string()],
    Value::String(_) => Vec::new(),
    Value::Array(paths) => paths
      .iter()
      .filter_map(Value::as_str)
      .map(str::trim)
      .filter(|path| !path.is_empty())
      .map(ToString::to_string)
      .take(8)
      .collect(),
    _ => Vec::new(),
  }
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
    ("album", "description") => Some("album_description"),
    ("artist", "name") => Some("artist"),
    ("artist", "artist_image_path") | ("artist", "artist_image_paths") => {
      Some("artist_image_path")
    }
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
    "album_description" => set_string(&mut overlay.album_description, value),
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
  let mut field_statement = connection
    .prepare(
      "
      SELECT
        links.track_id,
        entities.id,
        fields.field_name,
        fields.value_json,
        fields.provider_id,
        entities.provider_name,
        entities.source_path,
        fields.confidence,
        fields.fetched_at
      FROM metadata_entity_links AS links
      INNER JOIN metadata_entities AS entities ON entities.id = links.entity_id
      INNER JOIN metadata_fields AS fields ON fields.entity_id = entities.id
      WHERE links.kind = ?1 AND fields.selected = 1
      ",
    )
    .map_err(|error| format!("无法读取音乐信息字段：{error}"))?;
  let rows = field_statement
    .query_map(params![kind.as_str()], |row| {
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
    .map_err(|error| format!("无法查询音乐信息字段：{error}"))?;
  let mut entity_ids = HashSet::new();
  let mut selected_fields: HashMap<String, RankedMetadataField> = HashMap::new();
  for row in rows {
    let (
      track_id,
      entity_id,
      field_name,
      value_json,
      provider_id,
      provider_name,
      source_path,
      confidence,
      updated_at,
    ) =
      row.map_err(|error| format!("无法解析音乐信息字段：{error}"))?;
    if !requested.contains(track_id.as_str()) {
      continue;
    }
    let Ok(value) = serde_json::from_str::<Value>(&value_json) else {
      continue;
    };
    entity_ids.insert(entity_id);
    let field = if field_name == "artist_image_paths" {
      "artist_image_path".to_string()
    } else {
      field_name
    };
    let value = if field == "artist_image_path" {
      metadata_image_paths(&value)
        .into_iter()
        .next()
        .map(Value::String)
        .unwrap_or(Value::Null)
    } else {
      value
    };
    if value.is_null() {
      continue;
    }
    let source = MetadataFieldSource {
      field: field.clone(),
      provider_id,
      provider_name,
      source_path,
      confidence,
      updated_at,
    };
    let candidate = RankedMetadataField {
      value,
      rank: metadata_field_rank(kind.as_str(), &source),
      source,
    };
    if selected_fields
      .get(&field)
      .map_or(true, |current| ranked_field_precedes(&candidate, current))
    {
      selected_fields.insert(field, candidate);
    }
  }

  if selected_fields.is_empty() {
    return Ok(None);
  }
  let mut selected_fields = selected_fields.into_iter().collect::<Vec<_>>();
  selected_fields.sort_by(|(left, _), (right, _)| left.cmp(right));
  let fields = selected_fields
    .iter()
    .map(|(key, selected)| MetadataCandidateField {
      label: field_label(key).to_string(),
      value: display_value(&selected.value),
      key: key.clone(),
    })
    .collect::<Vec<_>>();
  let sources = selected_fields
    .into_iter()
    .map(|(_, selected)| selected.source)
    .collect::<Vec<_>>();
  let provider_ids = sources
    .iter()
    .map(|source| source.provider_id.as_str())
    .collect::<HashSet<_>>();
  let single_source = (provider_ids.len() == 1).then(|| &sources[0]);
  let provider_id = single_source
    .map(|source| source.provider_id.clone())
    .unwrap_or_else(|| "field-merge".to_string());
  let provider_name = single_source
    .map(|source| source.provider_name.clone())
    .unwrap_or_else(|| "多个来源".to_string());
  let source_path = single_source
    .map(|source| source.source_path.clone())
    .unwrap_or_else(|| "按字段合并".to_string());
  let confidence = sources.iter().map(|source| source.confidence).max().unwrap_or(0);
  let updated_at = sources.iter().map(|source| source.updated_at).max().unwrap_or(0);
  let mut entity_ids = entity_ids.into_iter().collect::<Vec<_>>();
  entity_ids.sort();
  let entity_id = if entity_ids.len() == 1 {
    entity_ids.remove(0)
  } else {
    format!("field-merge:{}", kind.as_str())
  };

  Ok(Some(MetadataContextRecord {
    entity_id,
    kind,
    provider_id,
    provider_name,
    source_path,
    confidence,
    updated_at,
    fields,
    sources,
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
