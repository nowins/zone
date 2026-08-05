use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn fixture_dir(name: &str) -> PathBuf {
  let nonce = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap()
    .as_nanos();
  let path = std::env::temp_dir().join(format!(
    "zone-metadata-{name}-{}-{nonce}",
    std::process::id()
  ));
  fs::create_dir_all(&path).unwrap();
  path
}

fn write_audio(path: &Path) {
  fs::write(path, b"ID3-test-audio").unwrap();
}

#[test]
fn legacy_entity_links_are_migrated_for_field_merging() {
  let root = fixture_dir("field-merge-migration");
  let database_path = root.join("music-metadata.sqlite");
  let connection = rusqlite::Connection::open(&database_path).unwrap();
  connection
    .execute_batch(
      "
      PRAGMA foreign_keys = ON;
      CREATE TABLE metadata_entities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE metadata_entity_links (
        track_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES metadata_entities(id) ON DELETE CASCADE,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY(track_id, kind)
      );
      ",
    )
    .unwrap();
  drop(connection);

  let connection = open_database(&database_path).unwrap();
  let mut statement = connection
    .prepare("PRAGMA table_info(metadata_entity_links)")
    .unwrap();
  let mut primary_key = statement
    .query_map([], |row| {
      Ok((row.get::<_, String>(1)?, row.get::<_, u32>(5)?))
    })
    .unwrap()
    .map(Result::unwrap)
    .filter(|(_, position)| *position > 0)
    .collect::<Vec<_>>();
  primary_key.sort_by_key(|(_, position)| *position);
  assert_eq!(
    primary_key.into_iter().map(|(name, _)| name).collect::<Vec<_>>(),
    ["track_id", "kind", "entity_id"]
  );

  drop(statement);
  drop(connection);
  fs::remove_dir_all(root).unwrap();
}

fn track(path: &Path, id: &str) -> MetadataTrackInput {
  MetadataTrackInput {
    id: id.to_string(),
    path: path.to_string_lossy().to_string(),
    title: "本地标题".to_string(),
    artist: "本地艺术家".to_string(),
    album: "本地专辑".to_string(),
    album_artist: Some("本地艺术家".to_string()),
    track_number: Some(1),
    disc_number: Some(1),
    year: None,
    genres: Some(Vec::new()),
    duration_seconds: Some(240),
  }
}

#[test]
fn sidecar_candidate_can_be_applied_and_cleared() {
  let root = fixture_dir("apply");
  let artist_dir = root.join("艺术家");
  let album_dir = artist_dir.join("专辑");
  fs::create_dir_all(&album_dir).unwrap();
  let audio_path = album_dir.join("01 - 歌曲.mp3");
  write_audio(&audio_path);
  fs::write(
    album_dir.join("album.zone.json"),
    r#"{
      "kind": "album",
      "title": "补全专辑",
      "albumArtist": "补全艺术家",
      "year": 2024,
      "genres": ["流行", "电子"],
      "description": "专辑介绍",
      "externalIds": {"musicbrainz": "release-id"}
    }"#,
  )
  .unwrap();

  let state = MetadataState::initialize_at(&root.join("data")).unwrap();
  let tracks = vec![track(&audio_path, "track-1")];
  let candidates = find_sidecar_candidates(MetadataEntityKind::Album, &tracks).unwrap();
  assert_eq!(candidates.len(), 1);
  assert_eq!(candidates[0].candidate.title, "补全专辑");

  persist_metadata_candidate(&state, &candidates[0], &tracks).unwrap();
  let overlays = read_track_overlays(&state, &["track-1".to_string()]).unwrap();
  assert_eq!(overlays.len(), 1);
  assert_eq!(overlays[0].album.as_deref(), Some("补全专辑"));
  assert_eq!(overlays[0].album_artist.as_deref(), Some("补全艺术家"));
  assert_eq!(overlays[0].year, Some(2024));
  assert_eq!(
    overlays[0].genres.as_deref(),
    Some(["流行".to_string(), "电子".to_string()].as_slice())
  );

  let context = read_context_metadata(
    &state,
    MetadataEntityKind::Album,
    &["track-1".to_string()],
  )
  .unwrap()
  .unwrap();
  assert_eq!(context.provider_id, LOCAL_SIDECAR_PROVIDER_ID);
  assert!(context.fields.iter().any(|field| field.key == "description"));

  assert_eq!(
    clear_context_metadata(
      &state,
      MetadataEntityKind::Album,
      &["track-1".to_string()]
    )
    .unwrap(),
    1
  );
  assert!(read_track_overlays(&state, &["track-1".to_string()])
    .unwrap()
    .is_empty());

  fs::remove_dir_all(root).unwrap();
}

#[test]
fn artist_sidecar_is_discovered_from_artist_folder() {
  let root = fixture_dir("artist");
  let artist_dir = root.join("艺术家");
  let album_dir = artist_dir.join("专辑");
  fs::create_dir_all(&album_dir).unwrap();
  let audio_path = album_dir.join("歌曲.flac");
  write_audio(&audio_path);
  fs::write(
    artist_dir.join("artist.zone.json"),
    r#"{"name":"补全艺术家","biography":"歌手简介","artistImages":["artist.zone.jpg","portrait.png"]}"#,
  )
  .unwrap();
  fs::write(
    artist_dir.join("artist.zone.jpg"),
    [0xff, 0xd8, 0xff, 0x00],
  )
  .unwrap();
  fs::write(
    artist_dir.join("portrait.png"),
    [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
  )
  .unwrap();

  let candidates =
    find_sidecar_candidates(MetadataEntityKind::Artist, &[track(&audio_path, "track-1")])
      .unwrap();
  assert_eq!(candidates.len(), 1);
  assert_eq!(candidates[0].candidate.title, "补全艺术家");
  assert!(candidates[0]
    .candidate
    .fields
    .iter()
    .any(|field| field.key == "biography"));
  assert!(candidates[0]
    .candidate
    .fields
    .iter()
    .any(|field| field.key == "artist_image_path"));

  let state = MetadataState::initialize_at(&root.join("data")).unwrap();
  let tracks = vec![track(&audio_path, "track-1")];
  persist_metadata_candidate(&state, &candidates[0], &tracks).unwrap();
  let overlays = read_track_overlays(&state, &["track-1".to_string()]).unwrap();
  assert_eq!(overlays.len(), 1);
  assert!(overlays[0]
    .artist_image_path
    .as_deref()
    .is_some_and(|path| path.ends_with("artist.zone.jpg")));
  assert_eq!(overlays[0].artist_images.len(), 2);
  assert!(overlays[0]
    .artist_images
    .iter()
    .any(|image| image.path.ends_with("portrait.png")));
  assert_eq!(overlays[0].artist_biography.as_deref(), Some("歌手简介"));

  apply_manual_metadata(
    &state,
    MetadataEntityKind::Artist,
    &tracks,
    &[MetadataManualFieldInput {
      key: "biography".to_string(),
      value: serde_json::json!("手动简介"),
    }],
  )
  .unwrap();
  let overlays = read_track_overlays(&state, &["track-1".to_string()]).unwrap();
  assert_eq!(overlays[0].artist_biography.as_deref(), Some("手动简介"));
  assert_eq!(overlays[0].artist_images.len(), 2);
  assert!(overlays[0].sources.iter().any(|source| {
    source.field == "artist_biography"
      && source.provider_id == MANUAL_METADATA_PROVIDER_ID
  }));
  assert!(overlays[0].sources.iter().any(|source| {
    source.field == "artist_image_path"
      && source.provider_id == LOCAL_SIDECAR_PROVIDER_ID
  }));
  let context = read_context_metadata(
    &state,
    MetadataEntityKind::Artist,
    &["track-1".to_string()],
  )
  .unwrap()
  .unwrap();
  assert_eq!(context.provider_name, "多个来源");
  assert_eq!(context.source_path, "按字段合并");
  assert!(context.sources.iter().any(|source| {
    source.field == "biography" && source.provider_id == MANUAL_METADATA_PROVIDER_ID
  }));
  assert!(context.sources.iter().any(|source| {
    source.field == "artist_image_path"
      && source.provider_id == LOCAL_SIDECAR_PROVIDER_ID
  }));

  fs::remove_dir_all(root).unwrap();
}

#[test]
fn track_sidecar_uses_the_audio_stem_for_its_default_artwork() {
  let root = fixture_dir("track-artwork");
  let audio_path = root.join("歌曲.flac");
  write_audio(&audio_path);
  fs::write(
    root.join("歌曲.zone.json"),
    r#"{"kind":"track","title":"补全歌曲"}"#,
  )
  .unwrap();
  fs::write(
    root.join("歌曲.zone.jpg"),
    [0xff, 0xd8, 0xff, 0x00],
  )
  .unwrap();

  let candidates =
    find_sidecar_candidates(MetadataEntityKind::Track, &[track(&audio_path, "track-1")])
      .unwrap();
  assert_eq!(candidates.len(), 1);
  assert!(candidates[0]
    .candidate
    .fields
    .iter()
    .any(|field| field.key == "album_cover_path"));

  fs::remove_dir_all(root).unwrap();
}

#[test]
fn manual_album_metadata_is_saved_as_an_overlay() {
  let root = fixture_dir("manual-album");
  let audio_path = root.join("歌曲.flac");
  write_audio(&audio_path);
  let state = MetadataState::initialize_at(&root.join("data")).unwrap();
  let tracks = vec![track(&audio_path, "track-1")];
  let fields = vec![
    MetadataManualFieldInput {
      key: "title".to_string(),
      value: serde_json::json!("手动专辑"),
    },
    MetadataManualFieldInput {
      key: "artist".to_string(),
      value: serde_json::json!("手动艺术家"),
    },
    MetadataManualFieldInput {
      key: "genres".to_string(),
      value: serde_json::json!(["流行", "电子"]),
    },
  ];

  apply_manual_metadata(&state, MetadataEntityKind::Album, &tracks, &fields).unwrap();
  let overlays = read_track_overlays(&state, &["track-1".to_string()]).unwrap();
  assert_eq!(overlays[0].album.as_deref(), Some("手动专辑"));
  assert_eq!(overlays[0].album_artist.as_deref(), Some("手动艺术家"));
  let context = read_context_metadata(
    &state,
    MetadataEntityKind::Album,
    &["track-1".to_string()],
  )
  .unwrap()
  .unwrap();
  assert_eq!(context.provider_id, MANUAL_METADATA_PROVIDER_ID);
  assert_eq!(context.source_path, "Zone 手动编辑");

  fs::remove_dir_all(root).unwrap();
}

#[test]
fn manual_metadata_rejects_fields_from_another_entity_kind() {
  let root = fixture_dir("manual-invalid");
  let audio_path = root.join("歌曲.mp3");
  write_audio(&audio_path);
  let state = MetadataState::initialize_at(&root.join("data")).unwrap();
  let fields = vec![MetadataManualFieldInput {
    key: "biography".to_string(),
    value: serde_json::json!("不应写入专辑"),
  }];
  let error = apply_manual_metadata(
    &state,
    MetadataEntityKind::Album,
    &[track(&audio_path, "track-1")],
    &fields,
  )
  .unwrap_err();
  assert!(error.contains("不支持"));

  fs::remove_dir_all(root).unwrap();
}

#[test]
fn sidecar_artwork_cannot_escape_its_directory() {
  let root = fixture_dir("artwork");
  let album_dir = root.join("专辑");
  fs::create_dir_all(&album_dir).unwrap();
  let audio_path = album_dir.join("歌曲.ogg");
  write_audio(&audio_path);
  fs::write(root.join("outside.jpg"), [0xff, 0xd8, 0xff, 0x00]).unwrap();
  fs::write(
    album_dir.join("album.zone.json"),
    r#"{"title":"专辑","cover":"../outside.jpg"}"#,
  )
  .unwrap();

  let error =
    find_sidecar_candidates(MetadataEntityKind::Album, &[track(&audio_path, "track-1")])
      .unwrap_err();
  assert!(error.contains("必须位于"));

  fs::remove_dir_all(root).unwrap();
}
