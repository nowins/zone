use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMediaTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMediaState {
    pub track: Option<SystemMediaTrack>,
    pub is_playing: bool,
    pub can_previous: bool,
    pub can_next: bool,
    pub is_favorite: bool,
}

#[cfg(target_os = "windows")]
mod windows_impl;

#[cfg(target_os = "windows")]
pub use windows_impl::{initialize, set_process_app_id, update, update_timeline};

#[cfg(not(target_os = "windows"))]
pub fn update(_state: SystemMediaState) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn update_timeline(_duration_seconds: f64, _position_seconds: f64) -> Result<(), String> {
    Ok(())
}
