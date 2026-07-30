use super::*;
use tauri::State;

#[tauri::command]
pub(crate) fn metadata_list_providers(
  state: State<'_, MetadataState>,
) -> Vec<MetadataProviderDescriptor> {
  vec![MetadataProviderDescriptor {
    id: LOCAL_SIDECAR_PROVIDER_ID.to_string(),
    name: LOCAL_SIDECAR_PROVIDER_NAME.to_string(),
    description:
      "读取歌曲名.zone.json、album.zone.json、artist.zone.json 与同目录图片".to_string(),
    capabilities: vec![
      "metadata.track".to_string(),
      "metadata.album".to_string(),
      "metadata.artist".to_string(),
      "artwork.album".to_string(),
      "artwork.artist".to_string(),
    ],
    enabled: state.ensure_ready().is_ok(),
    experimental: false,
  }]
}

#[tauri::command]
pub(crate) fn metadata_search_sidecars(
  kind: MetadataEntityKind,
  tracks: Vec<MetadataTrackInput>,
) -> Result<Vec<MetadataCandidate>, String> {
  Ok(
    find_sidecar_candidates(kind, &tracks)?
      .into_iter()
      .map(|resolved| resolved.candidate)
      .collect(),
  )
}

#[tauri::command]
pub(crate) fn metadata_apply_sidecar(
  state: State<'_, MetadataState>,
  candidate_id: String,
  kind: MetadataEntityKind,
  tracks: Vec<MetadataTrackInput>,
) -> Result<(), String> {
  let candidates = find_sidecar_candidates(kind, &tracks)?;
  let resolved = candidates
    .iter()
    .find(|candidate| candidate.candidate.id == candidate_id)
    .ok_or_else(|| "本地补充候选已不存在，请重新查找".to_string())?;
  persist_sidecar_candidate(&state, resolved, &tracks)
}

#[tauri::command]
pub(crate) fn metadata_get_track_overlays(
  state: State<'_, MetadataState>,
  track_ids: Vec<String>,
) -> Result<Vec<MetadataTrackOverlay>, String> {
  read_track_overlays(&state, &track_ids)
}

#[tauri::command]
pub(crate) fn metadata_get_context(
  state: State<'_, MetadataState>,
  kind: MetadataEntityKind,
  track_ids: Vec<String>,
) -> Result<Option<MetadataContextRecord>, String> {
  read_context_metadata(&state, kind, &track_ids)
}

#[tauri::command]
pub(crate) fn metadata_clear_context(
  state: State<'_, MetadataState>,
  kind: MetadataEntityKind,
  track_ids: Vec<String>,
) -> Result<usize, String> {
  clear_context_metadata(&state, kind, &track_ids)
}
