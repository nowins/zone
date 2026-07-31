use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MetadataEntityKind {
  Track,
  Album,
  Artist,
}

impl MetadataEntityKind {
  pub(crate) fn as_str(self) -> &'static str {
    match self {
      Self::Track => "track",
      Self::Album => "album",
      Self::Artist => "artist",
    }
  }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataTrackInput {
  pub(crate) id: String,
  pub(crate) path: String,
  pub(crate) title: String,
  pub(crate) artist: String,
  pub(crate) album: String,
  pub(crate) album_artist: Option<String>,
  pub(crate) track_number: Option<u32>,
  pub(crate) disc_number: Option<u32>,
  pub(crate) year: Option<u32>,
  pub(crate) genres: Option<Vec<String>>,
  pub(crate) duration_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataManualFieldInput {
  pub(crate) key: String,
  pub(crate) value: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataCandidateField {
  pub(crate) key: String,
  pub(crate) label: String,
  pub(crate) value: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataCandidate {
  pub(crate) id: String,
  pub(crate) kind: MetadataEntityKind,
  pub(crate) provider_id: String,
  pub(crate) provider_name: String,
  pub(crate) title: String,
  pub(crate) subtitle: String,
  pub(crate) source_path: String,
  pub(crate) confidence: u8,
  pub(crate) fields: Vec<MetadataCandidateField>,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedMetadataCandidate {
  pub(crate) candidate: MetadataCandidate,
  pub(crate) display_name: String,
  pub(crate) values: Vec<(String, Value)>,
  pub(crate) external_ids: Vec<(String, String)>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataProviderDescriptor {
  pub(crate) id: String,
  pub(crate) name: String,
  pub(crate) description: String,
  pub(crate) capabilities: Vec<String>,
  pub(crate) available: bool,
  pub(crate) enabled: bool,
  pub(crate) experimental: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataFieldSource {
  pub(crate) field: String,
  pub(crate) provider_id: String,
  pub(crate) provider_name: String,
  pub(crate) source_path: String,
  pub(crate) confidence: u8,
  pub(crate) updated_at: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataTrackOverlay {
  pub(crate) track_id: String,
  pub(crate) title: Option<String>,
  pub(crate) artist: Option<String>,
  pub(crate) album: Option<String>,
  pub(crate) album_artist: Option<String>,
  pub(crate) track_number: Option<u32>,
  pub(crate) disc_number: Option<u32>,
  pub(crate) year: Option<u32>,
  pub(crate) genres: Option<Vec<String>>,
  pub(crate) cover_path: Option<String>,
  pub(crate) artist_image_path: Option<String>,
  pub(crate) sources: Vec<MetadataFieldSource>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataContextRecord {
  pub(crate) entity_id: String,
  pub(crate) kind: MetadataEntityKind,
  pub(crate) provider_id: String,
  pub(crate) provider_name: String,
  pub(crate) source_path: String,
  pub(crate) confidence: u8,
  pub(crate) updated_at: i64,
  pub(crate) fields: Vec<MetadataCandidateField>,
}
