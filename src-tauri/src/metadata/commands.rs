use super::*;
use tauri::State;

#[tauri::command]
pub(crate) fn metadata_list_providers(
  state: State<'_, MetadataState>,
) -> Vec<MetadataProviderDescriptor> {
  let enabled = state.ensure_ready().is_ok();
  vec![
    MetadataProviderDescriptor {
      id: APPLE_MUSIC_PROVIDER_ID.to_string(),
      name: APPLE_MUSIC_PROVIDER_NAME.to_string(),
      description: "查询中国区曲目、专辑、发行年份、流派与专辑封面，无需账户"
        .to_string(),
      capabilities: vec![
        "metadata.track".to_string(),
        "metadata.album".to_string(),
        "artwork.album".to_string(),
      ],
      available: enabled,
      enabled,
      experimental: false,
    },
    MetadataProviderDescriptor {
      id: NETEASE_MUSIC_PROVIDER_ID.to_string(),
      name: NETEASE_MUSIC_PROVIDER_NAME.to_string(),
      description:
        "查询歌曲、专辑、发行年份、专辑封面及歌手资料，播放时按需补全歌手图片"
          .to_string(),
      capabilities: vec![
        "metadata.track".to_string(),
        "metadata.album".to_string(),
        "metadata.artist".to_string(),
        "artwork.album".to_string(),
        "artwork.artist".to_string(),
      ],
      available: enabled,
      enabled,
      experimental: true,
    },
    MetadataProviderDescriptor {
      id: LOCAL_SIDECAR_PROVIDER_ID.to_string(),
      name: LOCAL_SIDECAR_PROVIDER_NAME.to_string(),
      description:
        "读取歌曲名.zone.json、album.zone.json、artist.zone.json 与同目录图片"
          .to_string(),
      capabilities: vec![
        "metadata.track".to_string(),
        "metadata.album".to_string(),
        "metadata.artist".to_string(),
        "artwork.album".to_string(),
        "artwork.artist".to_string(),
      ],
      available: enabled,
      enabled,
      experimental: false,
    },
  ]
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
  persist_metadata_candidate(&state, resolved, &tracks)
}

#[tauri::command]
pub(crate) async fn metadata_search_apple_music(
  kind: MetadataEntityKind,
  tracks: Vec<MetadataTrackInput>,
) -> Result<Vec<MetadataCandidate>, String> {
  Ok(
    search_apple_music_candidates(kind, &tracks)
      .await?
      .into_iter()
      .map(|candidate| candidate.resolved.candidate)
      .collect(),
  )
}

#[tauri::command]
pub(crate) async fn metadata_apply_apple_music(
  state: State<'_, MetadataState>,
  candidate_id: String,
  kind: MetadataEntityKind,
  tracks: Vec<MetadataTrackInput>,
) -> Result<(), String> {
  apply_apple_music_candidate(&state, &candidate_id, kind, &tracks).await
}

#[tauri::command]
pub(crate) async fn metadata_search_netease_music(
  kind: MetadataEntityKind,
  tracks: Vec<MetadataTrackInput>,
) -> Result<Vec<MetadataCandidate>, String> {
  Ok(
    search_netease_music_candidates(kind, &tracks)
      .await?
      .into_iter()
      .map(|candidate| candidate.resolved.candidate)
      .collect(),
  )
}

#[tauri::command]
pub(crate) async fn metadata_apply_netease_music(
  state: State<'_, MetadataState>,
  candidate_id: String,
  kind: MetadataEntityKind,
  tracks: Vec<MetadataTrackInput>,
) -> Result<(), String> {
  apply_netease_music_candidate(&state, &candidate_id, kind, &tracks).await
}

#[tauri::command]
pub(crate) fn metadata_apply_manual(
  state: State<'_, MetadataState>,
  kind: MetadataEntityKind,
  tracks: Vec<MetadataTrackInput>,
  fields: Vec<MetadataManualFieldInput>,
) -> Result<(), String> {
  apply_manual_metadata(&state, kind, &tracks, &fields)
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
