use super::*;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const MANUAL_TEXT_LIMIT: usize = 500;
const MANUAL_DESCRIPTION_LIMIT: usize = 20_000;
const MANUAL_LIST_LIMIT: usize = 64;

pub(crate) fn apply_manual_metadata(
  state: &MetadataState,
  kind: MetadataEntityKind,
  tracks: &[MetadataTrackInput],
  fields: &[MetadataManualFieldInput],
) -> Result<(), String> {
  validate_metadata_tracks(tracks)?;
  let values = normalize_manual_fields(kind, fields)?;
  if values.is_empty() {
    return Err("请至少填写一项信息".to_string());
  }

  let display_name = values
    .iter()
    .find(|(key, _)| matches!((kind, key.as_str()),
      (MetadataEntityKind::Track, "title")
        | (MetadataEntityKind::Album, "title")
        | (MetadataEntityKind::Artist, "name")
    ))
    .and_then(|(_, value)| value.as_str())
    .map(ToString::to_string)
    .unwrap_or_else(|| match kind {
      MetadataEntityKind::Track => tracks[0].title.clone(),
      MetadataEntityKind::Album => tracks[0].album.clone(),
      MetadataEntityKind::Artist => tracks[0].artist.clone(),
    });
  let fields = values
    .iter()
    .map(|(key, value)| MetadataCandidateField {
      key: key.clone(),
      label: field_label(key).to_string(),
      value: display_value(value),
    })
    .collect();
  let resolved = ResolvedMetadataCandidate {
    candidate: MetadataCandidate {
      id: manual_candidate_id(kind, tracks),
      kind,
      provider_id: MANUAL_METADATA_PROVIDER_ID.to_string(),
      provider_name: MANUAL_METADATA_PROVIDER_NAME.to_string(),
      title: display_name.clone(),
      subtitle: "保存在 Zone 的独立覆盖层".to_string(),
      source_path: "Zone 手动编辑".to_string(),
      confidence: 100,
      fields,
    },
    display_name,
    values,
    external_ids: Vec::new(),
  };
  persist_metadata_candidate(state, &resolved, tracks)
}

fn normalize_manual_fields(
  kind: MetadataEntityKind,
  fields: &[MetadataManualFieldInput],
) -> Result<Vec<(String, Value)>, String> {
  if fields.len() > 16 {
    return Err("编辑的信息项过多".to_string());
  }
  let mut seen = HashSet::new();
  let mut values = Vec::new();
  for field in fields {
    let key = field.key.trim();
    if !seen.insert(key.to_string()) || !field_allowed(kind, key) {
      return Err("包含不支持的编辑字段".to_string());
    }
    let Some(value) = normalize_manual_value(key, &field.value)? else {
      continue;
    };
    values.push((key.to_string(), value));
  }
  Ok(values)
}

fn field_allowed(kind: MetadataEntityKind, key: &str) -> bool {
  match kind {
    MetadataEntityKind::Track => matches!(
      key,
      "title"
        | "artist"
        | "album"
        | "album_artist"
        | "track_number"
        | "disc_number"
        | "year"
        | "genres"
        | "description"
    ),
    MetadataEntityKind::Album => {
      matches!(key, "title" | "artist" | "year" | "genres" | "description")
    }
    MetadataEntityKind::Artist => {
      matches!(key, "name" | "biography" | "aliases" | "identities")
    }
  }
}

fn normalize_manual_value(key: &str, value: &Value) -> Result<Option<Value>, String> {
  match key {
    "track_number" | "disc_number" | "year" => {
      let Some(number) = value.as_u64() else {
        return Err("曲序、碟号和年份必须是数字".to_string());
      };
      let maximum = match key {
        "disc_number" => 10_000,
        "year" => 9_999,
        _ => 100_000,
      };
      if number == 0 || number > maximum {
        return Err("曲序、碟号或年份超出允许范围".to_string());
      }
      Ok(Some(Value::from(number)))
    }
    "genres" | "aliases" | "identities" => {
      let Some(items) = value.as_array() else {
        return Err("流派、别名和身份必须是文本列表".to_string());
      };
      let mut normalized = Vec::new();
      let mut seen = HashSet::new();
      for item in items.iter().take(MANUAL_LIST_LIMIT) {
        let Some(item) = item.as_str().map(str::trim).filter(|item| !item.is_empty()) else {
          continue;
        };
        let item: String = item.chars().take(MANUAL_TEXT_LIMIT).collect();
        if seen.insert(item.to_lowercase()) {
          normalized.push(Value::String(item));
        }
      }
      Ok((!normalized.is_empty()).then_some(Value::Array(normalized)))
    }
    _ => {
      let Some(text) = value.as_str().map(str::trim).filter(|text| !text.is_empty()) else {
        return Ok(None);
      };
      let limit = if matches!(key, "description" | "biography") {
        MANUAL_DESCRIPTION_LIMIT
      } else {
        MANUAL_TEXT_LIMIT
      };
      Ok(Some(Value::String(text.chars().take(limit).collect())))
    }
  }
}

fn manual_candidate_id(kind: MetadataEntityKind, tracks: &[MetadataTrackInput]) -> String {
  let mut ids: Vec<&str> = tracks.iter().map(|track| track.id.as_str()).collect();
  ids.sort_unstable();
  let mut hasher = Sha256::new();
  hasher.update(b"zone-manual-metadata:");
  hasher.update(kind.as_str().as_bytes());
  for id in ids {
    hasher.update(b":");
    hasher.update(id.as_bytes());
  }
  let digest = hasher.finalize();
  let mut id = String::with_capacity(64);
  for byte in digest {
    id.push_str(&format!("{byte:02x}"));
  }
  format!("manual:{id}")
}
