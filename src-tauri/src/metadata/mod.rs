use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

mod apple;
mod artwork;
mod commands;
mod manual;
mod matching;
mod netease;
mod sidecar;
mod store;
mod types;

pub(crate) use apple::*;
pub(crate) use artwork::*;
pub(crate) use commands::*;
pub(crate) use manual::*;
pub(crate) use matching::*;
pub(crate) use netease::*;
pub(crate) use sidecar::*;
pub(crate) use store::*;
pub(crate) use types::*;

pub(crate) const LOCAL_SIDECAR_PROVIDER_ID: &str = "local-sidecar";
pub(crate) const LOCAL_SIDECAR_PROVIDER_NAME: &str = "本地补充文件";
pub(crate) const MANUAL_METADATA_PROVIDER_ID: &str = "manual-edit";
pub(crate) const MANUAL_METADATA_PROVIDER_NAME: &str = "手动编辑";

#[derive(Clone, Debug)]
pub(crate) struct MetadataState {
  db_path: PathBuf,
  artwork_cache_dir: PathBuf,
  initialization_error: Option<String>,
}

impl MetadataState {
  pub(crate) fn initialize(app: &AppHandle) -> Result<Self, String> {
    let app_data_dir = app
      .path()
      .app_data_dir()
      .map_err(|error| format!("无法定位音乐信息数据目录：{error}"))?;
    Self::initialize_at(&app_data_dir)
  }

  pub(crate) fn initialize_at(app_data_dir: &Path) -> Result<Self, String> {
    fs::create_dir_all(app_data_dir)
      .map_err(|error| format!("无法创建音乐信息数据目录：{error}"))?;
    let artwork_cache_dir = app_data_dir.join("music-metadata-artwork");
    fs::create_dir_all(&artwork_cache_dir)
      .map_err(|error| format!("无法创建音乐信息图片缓存：{error}"))?;
    let db_path = app_data_dir.join("music-metadata.sqlite");
    let _ = open_database(&db_path)?;
    Ok(Self {
      db_path,
      artwork_cache_dir,
      initialization_error: None,
    })
  }

  pub(crate) fn unavailable(error: String) -> Self {
    Self {
      db_path: PathBuf::new(),
      artwork_cache_dir: PathBuf::new(),
      initialization_error: Some(error),
    }
  }

  pub(crate) fn ensure_ready(&self) -> Result<(), String> {
    if let Some(error) = self.initialization_error.as_deref() {
      Err(format!("音乐信息功能初始化失败：{error}"))
    } else {
      Ok(())
    }
  }

  pub(crate) fn artwork_cache_dir(&self) -> &Path {
    &self.artwork_cache_dir
  }
}

#[cfg(test)]
mod tests;
