use super::{emit_command, SystemMediaCommand, APP_USER_MODEL_ID};
use crate::system_media::SystemMediaState;
use tauri::{AppHandle, Emitter};
use windows::core::{factory, HSTRING, Result as WindowsResult};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
    SystemMediaTransportControls, SystemMediaTransportControlsButton,
    SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsTimelineProperties,
};
use windows::Storage::StorageFile;
use windows::Storage::Streams::RandomAccessStreamReference;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;

pub(super) fn initialize_system_media(
    app: &AppHandle,
    hwnd: HWND,
) -> Result<SystemMediaTransportControls, String> {
    let interop =
        factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()
            .map_err(|error| error.to_string())?;
    let controls: SystemMediaTransportControls =
        unsafe { interop.GetForWindow(hwnd) }.map_err(|error| error.to_string())?;

    let button_app = app.clone();
    let button_handler = TypedEventHandler::<
        SystemMediaTransportControls,
        SystemMediaTransportControlsButtonPressedEventArgs,
    >::new(move |_sender, args| {
        let action = match args.ok()?.Button()? {
            SystemMediaTransportControlsButton::Play => Some("play"),
            SystemMediaTransportControlsButton::Pause => Some("pause"),
            SystemMediaTransportControlsButton::Stop => Some("pause"),
            SystemMediaTransportControlsButton::Previous => Some("previous"),
            SystemMediaTransportControlsButton::Next => Some("next"),
            // Some shells surface a combined button; treat as toggle.
            SystemMediaTransportControlsButton::ChannelUp => Some("toggle"),
            SystemMediaTransportControlsButton::ChannelDown => Some("toggle"),
            _ => None,
        };
        if let Some(action) = action {
            emit_command(&button_app, action);
        }
        Ok(())
    });
    controls
        .ButtonPressed(&button_handler)
        .map_err(|error| error.to_string())?;

    let seek_app = app.clone();
    let seek_handler = TypedEventHandler::<
        SystemMediaTransportControls,
        PlaybackPositionChangeRequestedEventArgs,
    >::new(move |_sender, args| {
        let position_seconds =
            args.ok()?.RequestedPlaybackPosition()?.Duration as f64 / 10_000_000.0;
        let _ = seek_app.emit(
            "system-media-command",
            SystemMediaCommand {
                action: "seek",
                position_seconds: Some(position_seconds),
            },
        );
        Ok(())
    });
    controls
        .PlaybackPositionChangeRequested(&seek_handler)
        .map_err(|error| error.to_string())?;
    controls
        .SetIsEnabled(false)
        .map_err(|error| error.to_string())?;
    Ok(controls)
}

pub(super) fn update_system_media_state(
    controls: &SystemMediaTransportControls,
    state: &SystemMediaState,
    metadata_changed: bool,
) -> WindowsResult<()> {
    let has_track = state.track.is_some();
    controls.SetIsEnabled(has_track)?;
    controls.SetIsPlayEnabled(has_track)?;
    controls.SetIsPauseEnabled(has_track)?;
    controls.SetIsStopEnabled(has_track)?;
    controls.SetIsPreviousEnabled(has_track && state.can_previous)?;
    controls.SetIsNextEnabled(has_track && state.can_next)?;
    controls.SetPlaybackStatus(if !has_track {
        MediaPlaybackStatus::Closed
    } else if state.is_playing {
        MediaPlaybackStatus::Playing
    } else {
        MediaPlaybackStatus::Paused
    })?;

    if !metadata_changed {
        return Ok(());
    }

    let updater = controls.DisplayUpdater()?;
    updater.ClearAll()?;
    updater.SetAppMediaId(&HSTRING::from(APP_USER_MODEL_ID))?;
    if let Some(track) = &state.track {
        updater.SetType(MediaPlaybackType::Music)?;
        let music = updater.MusicProperties()?;
        music.SetTitle(&HSTRING::from(&track.title))?;
        music.SetArtist(&HSTRING::from(&track.artist))?;
        music.SetAlbumArtist(&HSTRING::from(&track.artist))?;
        music.SetAlbumTitle(&HSTRING::from(&track.album))?;

        if let Some(cover_path) = &track.cover_path {
            if let Ok(file_operation) =
                StorageFile::GetFileFromPathAsync(&HSTRING::from(cover_path))
            {
                if let Ok(file) = file_operation.get() {
                    if let Ok(thumbnail) = RandomAccessStreamReference::CreateFromFile(&file) {
                        updater.SetThumbnail(&thumbnail)?;
                    }
                }
            }
        }
    }
    updater.Update()
}

pub(super) fn update_system_media_timeline(
    controls: &SystemMediaTransportControls,
    duration_seconds: f64,
    position_seconds: f64,
) -> WindowsResult<()> {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Ok(());
    }
    let duration_seconds = duration_seconds.max(0.0);
    let position_seconds = if position_seconds.is_finite() {
        position_seconds.clamp(0.0, duration_seconds)
    } else {
        0.0
    };
    let to_time_span = |seconds: f64| TimeSpan {
        Duration: (seconds * 10_000_000.0).round() as i64,
    };
    let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
    timeline.SetStartTime(to_time_span(0.0))?;
    timeline.SetMinSeekTime(to_time_span(0.0))?;
    timeline.SetEndTime(to_time_span(duration_seconds))?;
    timeline.SetMaxSeekTime(to_time_span(duration_seconds))?;
    timeline.SetPosition(to_time_span(position_seconds))?;
    controls.SetPlaybackRate(1.0)?;
    controls.UpdateTimelineProperties(&timeline)
}
