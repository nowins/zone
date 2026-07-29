use super::SystemMediaState;
use serde::Serialize;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use windows::core::{w, GUID, HSTRING};
use windows::Media::SystemMediaTransportControls;
use windows::Win32::Foundation::{HWND, PROPERTYKEY};
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::Shell::{SetCurrentProcessExplicitAppUserModelID, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{RegisterWindowMessageW, SM_CXSMICON};

mod bitmap;
mod identity;
mod smtc;
mod taskbar;

const TASKBAR_SUBCLASS_ID: usize = 0x5A4F4E45;
const TASKBAR_PREVIOUS_ID: u32 = 0x5A01;
const TASKBAR_PLAY_PAUSE_ID: u32 = 0x5A02;
const TASKBAR_NEXT_ID: u32 = 0x5A03;
const TASKBAR_FAVORITE_ID: u32 = 0x5A04;
const APP_USER_MODEL_ID: &str = "com.zone.player";
const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

static INTEGRATION: OnceLock<Mutex<Option<TaskbarIntegration>>> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemMediaCommand {
    action: &'static str,
    position_seconds: Option<f64>,
}

struct TaskbarIntegration {
    taskbar: Arc<TaskbarData>,
    system_media: SystemMediaTransportControls,
    hwnd: isize,
}

struct TaskbarData {
    app: AppHandle,
    taskbar_created_message: u32,
    added: AtomicBool,
    has_track: AtomicBool,
    is_playing: AtomicBool,
    can_previous: AtomicBool,
    can_next: AtomicBool,
    is_favorite: AtomicBool,
    preview: Mutex<PreviewState>,
    previous_icon: isize,
    play_icon: isize,
    pause_icon: isize,
    next_icon: isize,
    favorite_icon: isize,
    favorite_filled_icon: isize,
}

#[derive(Default)]
struct PreviewState {
    track_id: Option<String>,
    cover_path: Option<String>,
    title: String,
    artist: String,
    artwork: Option<Artwork>,
}

struct Artwork {
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

#[derive(Clone, Copy)]
enum MediaIcon {
    Previous,
    Play,
    Pause,
    Next,
    Favorite,
    FavoriteFilled,
}

impl TaskbarIntegration {
    fn new(app: AppHandle, hwnd: HWND) -> Result<Self, String> {
        let system_media = smtc::initialize_system_media(&app, hwnd)?;
        Ok(Self {
            taskbar: TaskbarData::install(app, hwnd)?,
            system_media,
            hwnd: hwnd.0 as isize,
        })
    }

    fn update(&self, state: SystemMediaState) -> Result<(), String> {
        let preview_changed = self.taskbar.apply_state(&state);
        taskbar::schedule_taskbar_refresh(self.hwnd, self.taskbar.clone(), preview_changed);
        smtc::update_system_media_state(&self.system_media, &state, preview_changed)
            .map_err(|error| error.to_string())
    }

    fn update_timeline(
        &self,
        duration_seconds: f64,
        position_seconds: f64,
    ) -> Result<(), String> {
        smtc::update_system_media_timeline(&self.system_media, duration_seconds, position_seconds)
            .map_err(|error| error.to_string())
    }
}

impl TaskbarData {
    fn install(app: AppHandle, hwnd: HWND) -> Result<Arc<Self>, String> {
        let taskbar_created_message =
            unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };
        if taskbar_created_message == 0 {
            return Err("RegisterWindowMessageW failed".into());
        }

        let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
        let icon_size =
            unsafe { GetSystemMetricsForDpi(SM_CXSMICON, dpi) }.clamp(16, 64) as u32;
        let data = Arc::new(Self {
            app,
            taskbar_created_message,
            added: AtomicBool::new(false),
            has_track: AtomicBool::new(false),
            is_playing: AtomicBool::new(false),
            can_previous: AtomicBool::new(false),
            can_next: AtomicBool::new(false),
            is_favorite: AtomicBool::new(false),
            preview: Mutex::new(PreviewState::default()),
            previous_icon: bitmap::create_media_icon(MediaIcon::Previous, icon_size)?.0 as isize,
            play_icon: bitmap::create_media_icon(MediaIcon::Play, icon_size)?.0 as isize,
            pause_icon: bitmap::create_media_icon(MediaIcon::Pause, icon_size)?.0 as isize,
            next_icon: bitmap::create_media_icon(MediaIcon::Next, icon_size)?.0 as isize,
            favorite_icon: bitmap::create_media_icon(MediaIcon::Favorite, icon_size)?.0 as isize,
            favorite_filled_icon: bitmap::create_media_icon(MediaIcon::FavoriteFilled, icon_size)?.0
                as isize,
        });

        taskbar::configure_custom_thumbnail(hwnd);

        let callback_data = Arc::into_raw(data.clone()) as usize;
        let installed = unsafe {
            SetWindowSubclass(
                hwnd,
                Some(taskbar::taskbar_subclass_proc),
                TASKBAR_SUBCLASS_ID,
                callback_data,
            )
        };
        if !installed.as_bool() {
            unsafe {
                drop(Arc::from_raw(callback_data as *const TaskbarData));
            }
            return Err("SetWindowSubclass failed".into());
        }

        unsafe {
            taskbar::refresh_taskbar(hwnd, &data, true);
        }
        Ok(data)
    }

    fn apply_state(&self, state: &SystemMediaState) -> bool {
        self.has_track
            .store(state.track.is_some(), Ordering::Relaxed);
        self.is_playing.store(state.is_playing, Ordering::Relaxed);
        self.can_previous
            .store(state.can_previous, Ordering::Relaxed);
        self.can_next.store(state.can_next, Ordering::Relaxed);
        self.is_favorite.store(state.is_favorite, Ordering::Relaxed);

        let next_track_id = state.track.as_ref().map(|track| track.id.as_str());
        let next_cover_path = state
            .track
            .as_ref()
            .and_then(|track| track.cover_path.as_deref());
        let needs_preview_update = self
            .preview
            .lock()
            .map(|preview| {
                preview.track_id.as_deref() != next_track_id
                    || preview.cover_path.as_deref() != next_cover_path
            })
            .unwrap_or(false);

        if !needs_preview_update {
            return false;
        }

        let artwork = next_cover_path.and_then(bitmap::load_artwork);
        if let Ok(mut preview) = self.preview.lock() {
            preview.track_id = next_track_id.map(str::to_owned);
            preview.cover_path = next_cover_path.map(str::to_owned);
            preview.title = state
                .track
                .as_ref()
                .map(|track| track.title.clone())
                .unwrap_or_default();
            preview.artist = state
                .track
                .as_ref()
                .map(|track| track.artist.clone())
                .unwrap_or_default();
            preview.artwork = artwork;
        }
        true
    }
}

pub fn set_process_app_id() -> Result<(), String> {
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_USER_MODEL_ID)) }
        .map_err(|error| error.to_string())?;
    identity::register_app_identity()
}

pub fn initialize(app: AppHandle, hwnd: isize) -> Result<(), String> {
    let integration = TaskbarIntegration::new(app, HWND(hwnd as *mut c_void))?;
    let slot = INTEGRATION.get_or_init(|| Mutex::new(None));
    *slot.lock().map_err(|_| "media integration lock poisoned")? = Some(integration);
    Ok(())
}

pub fn update(state: SystemMediaState) -> Result<(), String> {
    let Some(slot) = INTEGRATION.get() else {
        return Ok(());
    };
    let integration = slot.lock().map_err(|_| "media integration lock poisoned")?;
    if let Some(integration) = integration.as_ref() {
        integration.update(state)?;
    }
    Ok(())
}

pub fn update_timeline(duration_seconds: f64, position_seconds: f64) -> Result<(), String> {
    let Some(slot) = INTEGRATION.get() else {
        return Ok(());
    };
    let integration = slot.lock().map_err(|_| "media integration lock poisoned")?;
    if let Some(integration) = integration.as_ref() {
        integration.update_timeline(duration_seconds, position_seconds)?;
    }
    Ok(())
}

fn emit_command(app: &AppHandle, action: &'static str) {
    let _ = app.emit(
        "system-media-command",
        SystemMediaCommand {
            action,
            position_seconds: None,
        },
    );
}
