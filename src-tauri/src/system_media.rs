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
mod windows_impl {
    use super::SystemMediaState;
    use serde::Serialize;
    use std::f32::consts::TAU;
    use std::ffi::c_void;
    use std::mem::{size_of, size_of_val, ManuallyDrop};
    use std::ptr::{copy_nonoverlapping, null, null_mut};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};
    use windows::core::{
        factory, w, Error as WindowsError, Interface, Result as WindowsResult, GUID, HSTRING,
    };
    use windows::Foundation::{TimeSpan, TypedEventHandler};
    use windows::Media::{
        MediaPlaybackStatus, MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
        SystemMediaTransportControls, SystemMediaTransportControlsButton,
        SystemMediaTransportControlsButtonPressedEventArgs,
        SystemMediaTransportControlsTimelineProperties,
    };
    use windows::Storage::StorageFile;
    use windows::Storage::Streams::RandomAccessStreamReference;
    use windows::Win32::Foundation::{
        ERROR_SUCCESS, GENERIC_READ, HWND, LPARAM, LRESULT, PROPERTYKEY, WPARAM,
    };
    use windows::Win32::Graphics::Dwm::{
        DwmInvalidateIconicBitmaps, DwmSetIconicThumbnail, DwmSetWindowAttribute,
        DWMWA_FORCE_ICONIC_REPRESENTATION, DWMWA_HAS_ICONIC_BITMAP,
    };
    use windows::Win32::Graphics::Gdi::{
        CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
    };
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat32bppBGRA, IWICImagingFactory, IWICPalette,
        WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnLoad,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;
    use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DefSubclassProc, IShellLinkW, ITaskbarList3, RemoveWindowSubclass, SHChangeNotify,
        SHStrDupW, SetCurrentProcessExplicitAppUserModelID, SetWindowSubclass, ShellLink,
        TaskbarList, SHCNE_ASSOCCHANGED, SHCNF_IDLIST, THBF_DISABLED, THBF_ENABLED, THBN_CLICKED,
        THB_FLAGS, THB_ICON, THB_TOOLTIP, THUMBBUTTON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconIndirect, RegisterWindowMessageW, HICON, ICONINFO, SM_CXSMICON, WM_COMMAND,
        WM_DWMSENDICONICTHUMBNAIL, WM_NCDESTROY,
    };

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
            let system_media = initialize_system_media(&app, hwnd)?;
            Ok(Self {
                taskbar: TaskbarData::install(app, hwnd)?,
                system_media,
                hwnd: hwnd.0 as isize,
            })
        }

        fn update(&self, state: SystemMediaState) -> Result<(), String> {
            let preview_changed = self.taskbar.apply_state(&state);
            schedule_taskbar_refresh(self.hwnd, self.taskbar.clone(), preview_changed);
            update_system_media_state(&self.system_media, &state, preview_changed)
                .map_err(|error| error.to_string())
        }

        fn update_timeline(
            &self,
            duration_seconds: f64,
            position_seconds: f64,
        ) -> Result<(), String> {
            update_system_media_timeline(&self.system_media, duration_seconds, position_seconds)
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
                previous_icon: create_media_icon(MediaIcon::Previous, icon_size)?.0 as isize,
                play_icon: create_media_icon(MediaIcon::Play, icon_size)?.0 as isize,
                pause_icon: create_media_icon(MediaIcon::Pause, icon_size)?.0 as isize,
                next_icon: create_media_icon(MediaIcon::Next, icon_size)?.0 as isize,
                favorite_icon: create_media_icon(MediaIcon::Favorite, icon_size)?.0 as isize,
                favorite_filled_icon: create_media_icon(MediaIcon::FavoriteFilled, icon_size)?.0
                    as isize,
            });

            configure_custom_thumbnail(hwnd);

            let callback_data = Arc::into_raw(data.clone()) as usize;
            let installed = unsafe {
                SetWindowSubclass(
                    hwnd,
                    Some(taskbar_subclass_proc),
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
                refresh_taskbar(hwnd, &data, true);
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

            let artwork = next_cover_path.and_then(load_artwork);
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
        register_app_identity()
    }

    fn register_app_identity() -> Result<(), String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Unable to locate the Zone executable: {error}"))?;
        let mut identities = vec![APP_USER_MODEL_ID.to_string()];
        if let Some(file_name) = executable.file_name().and_then(|name| name.to_str()) {
            if !file_name.eq_ignore_ascii_case(APP_USER_MODEL_ID) {
                identities.push(file_name.to_string());
            }
        }

        for identity in identities {
            register_app_identity_key(&identity, Some(&executable))?;
        }
        register_start_menu_shortcut(&executable)?;
        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
        Ok(())
    }

    fn register_start_menu_shortcut(executable: &std::path::Path) -> Result<(), String> {
        let app_data = std::env::var_os("APPDATA")
            .ok_or("Unable to locate the Windows application data directory")?;
        let shortcut_directory = std::path::PathBuf::from(app_data)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");
        std::fs::create_dir_all(&shortcut_directory).map_err(|error| {
            format!("Unable to prepare the Windows Start menu directory: {error}")
        })?;
        let shortcut_path = shortcut_directory.join("Zone.lnk");
        let executable = HSTRING::from(executable.to_string_lossy().as_ref());
        let shortcut_path = HSTRING::from(shortcut_path.to_string_lossy().as_ref());

        let com_status = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        com_status
            .ok()
            .map_err(|error| format!("Unable to initialize Windows Shell integration: {error}"))?;

        let result: WindowsResult<()> = (|| {
            let shell_link: IShellLinkW =
                unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)? };
            unsafe {
                shell_link.SetPath(&executable)?;
                shell_link.SetDescription(w!("Zone music player"))?;
                shell_link.SetIconLocation(&executable, 0)?;
            }

            let property_store: IPropertyStore = shell_link.cast()?;
            let app_id = HSTRING::from(APP_USER_MODEL_ID);
            let app_id_buffer = unsafe { SHStrDupW(&app_id)? };
            let mut app_id_value = PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_LPWSTR,
                        wReserved1: 0,
                        wReserved2: 0,
                        wReserved3: 0,
                        Anonymous: PROPVARIANT_0_0_0 {
                            pwszVal: app_id_buffer,
                        },
                    }),
                },
            };
            let set_value_result =
                unsafe { property_store.SetValue(&PKEY_APP_USER_MODEL_ID, &app_id_value) };
            let clear_result = unsafe { PropVariantClear(&mut app_id_value) };
            set_value_result?;
            clear_result?;
            unsafe { property_store.Commit()? };

            let persist_file: IPersistFile = shell_link.cast()?;
            unsafe { persist_file.Save(&shortcut_path, true)? };
            Ok(())
        })();

        unsafe {
            CoUninitialize();
        }
        result.map_err(|error| format!("Unable to register the Zone Start menu shortcut: {error}"))
    }

    fn register_app_identity_key(
        identity: &str,
        executable: Option<&std::path::Path>,
    ) -> Result<(), String> {
        let registry_path = HSTRING::from(format!("Software\\Classes\\AppUserModelId\\{identity}"));
        let mut key = HKEY::default();
        let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, &registry_path, &mut key) };
        if status != ERROR_SUCCESS {
            return Err(format!(
                "Unable to register the Zone application identity: {status:?}"
            ));
        }

        let result: Result<(), String> = (|| {
            set_registry_string(key, w!("DisplayName"), "Zone")?;
            if let Some(executable) = executable {
                set_registry_string(key, w!("IconUri"), &executable.to_string_lossy())?;
            }
            Ok(())
        })();
        unsafe {
            let _ = RegCloseKey(key);
        }
        result?;
        Ok(())
    }

    fn set_registry_string(
        key: HKEY,
        name: windows::core::PCWSTR,
        value: &str,
    ) -> Result<(), String> {
        let wide = value
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let bytes = unsafe {
            std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * size_of::<u16>())
        };
        let status = unsafe { RegSetValueExW(key, name, None, REG_SZ, Some(bytes)) };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!(
                "Unable to write the Zone application identity: {status:?}"
            ))
        }
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

    fn initialize_system_media(
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
                SystemMediaTransportControlsButton::Previous => Some("previous"),
                SystemMediaTransportControlsButton::Next => Some("next"),
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

    fn update_system_media_state(
        controls: &SystemMediaTransportControls,
        state: &SystemMediaState,
        metadata_changed: bool,
    ) -> WindowsResult<()> {
        let has_track = state.track.is_some();
        controls.SetIsEnabled(has_track)?;
        controls.SetIsPlayEnabled(has_track)?;
        controls.SetIsPauseEnabled(has_track)?;
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

    fn update_system_media_timeline(
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

    fn configure_custom_thumbnail(hwnd: HWND) {
        let enabled = 1i32;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_FORCE_ICONIC_REPRESENTATION,
                &enabled as *const _ as *const c_void,
                size_of_val(&enabled) as u32,
            );
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_HAS_ICONIC_BITMAP,
                &enabled as *const _ as *const c_void,
                size_of_val(&enabled) as u32,
            );
        }
    }

    fn schedule_taskbar_refresh(hwnd: isize, data: Arc<TaskbarData>, preview_changed: bool) {
        let app = data.app.clone();
        let _ = app.run_on_main_thread(move || unsafe {
            let hwnd = HWND(hwnd as *mut c_void);
            refresh_taskbar(hwnd, &data, false);
            if preview_changed {
                let _ = DwmInvalidateIconicBitmaps(hwnd);
            }
        });
    }

    unsafe fn taskbar_list() -> WindowsResult<ITaskbarList3> {
        let taskbar: ITaskbarList3 =
            unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)? };
        unsafe { taskbar.HrInit()? };
        Ok(taskbar)
    }

    unsafe fn refresh_taskbar(hwnd: HWND, data: &TaskbarData, force_add: bool) {
        let Ok(taskbar) = (unsafe { taskbar_list() }) else {
            return;
        };
        let buttons = taskbar_buttons(data);
        let was_added = data.added.load(Ordering::Relaxed);

        let updated = if was_added && !force_add {
            unsafe { taskbar.ThumbBarUpdateButtons(hwnd, &buttons) }.is_ok()
        } else {
            unsafe { taskbar.ThumbBarAddButtons(hwnd, &buttons) }.is_ok()
                || unsafe { taskbar.ThumbBarUpdateButtons(hwnd, &buttons) }.is_ok()
        };
        data.added.store(updated, Ordering::Relaxed);

        if let Ok(preview) = data.preview.lock() {
            let tooltip = match (preview.title.is_empty(), preview.artist.is_empty()) {
                (false, false) => format!("{} — {}", preview.title, preview.artist),
                (false, true) => preview.title.clone(),
                _ => "Zone".to_string(),
            };
            let _ = unsafe { taskbar.SetThumbnailTooltip(hwnd, &HSTRING::from(tooltip)) };
        }
    }

    fn taskbar_buttons(data: &TaskbarData) -> [THUMBBUTTON; 4] {
        let has_track = data.has_track.load(Ordering::Relaxed);
        let is_playing = data.is_playing.load(Ordering::Relaxed);
        let is_favorite = data.is_favorite.load(Ordering::Relaxed);
        let previous_enabled = has_track && data.can_previous.load(Ordering::Relaxed);
        let next_enabled = has_track && data.can_next.load(Ordering::Relaxed);

        [
            taskbar_button(
                TASKBAR_PREVIOUS_ID,
                data.previous_icon,
                "上一首",
                previous_enabled,
            ),
            taskbar_button(
                TASKBAR_PLAY_PAUSE_ID,
                if is_playing {
                    data.pause_icon
                } else {
                    data.play_icon
                },
                if is_playing { "暂停" } else { "播放" },
                has_track,
            ),
            taskbar_button(TASKBAR_NEXT_ID, data.next_icon, "下一首", next_enabled),
            taskbar_button(
                TASKBAR_FAVORITE_ID,
                if is_favorite {
                    data.favorite_filled_icon
                } else {
                    data.favorite_icon
                },
                if is_favorite {
                    "取消喜欢"
                } else {
                    "喜欢"
                },
                has_track,
            ),
        ]
    }

    fn taskbar_button(id: u32, icon: isize, tooltip: &str, enabled: bool) -> THUMBBUTTON {
        THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: id,
            hIcon: HICON(icon as *mut c_void),
            szTip: tooltip_text(tooltip),
            dwFlags: if enabled { THBF_ENABLED } else { THBF_DISABLED },
            ..Default::default()
        }
    }

    fn tooltip_text(value: &str) -> [u16; 260] {
        let mut result = [0u16; 260];
        for (target, source) in result.iter_mut().take(259).zip(value.encode_utf16()) {
            *target = source;
        }
        result
    }

    fn load_artwork(path: &str) -> Option<Artwork> {
        let factory: IWICImagingFactory =
            unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
                .ok()?;
        let filename = HSTRING::from(path);
        let decoder = unsafe {
            factory.CreateDecoderFromFilename(
                &filename,
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnLoad,
            )
        }
        .ok()?;
        let frame = unsafe { decoder.GetFrame(0) }.ok()?;
        let converter = unsafe { factory.CreateFormatConverter() }.ok()?;
        unsafe {
            converter.Initialize(
                &frame,
                &GUID_WICPixelFormat32bppBGRA,
                WICBitmapDitherTypeNone,
                None::<&IWICPalette>,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
        }
        .ok()?;

        let mut width = 0;
        let mut height = 0;
        unsafe { converter.GetSize(&mut width, &mut height) }.ok()?;
        if width == 0 || height == 0 {
            return None;
        }
        let stride = width.checked_mul(4)?;
        let byte_count = stride.checked_mul(height)? as usize;
        let mut bgra = vec![0; byte_count];
        unsafe { converter.CopyPixels(null(), stride, &mut bgra) }.ok()?;
        Some(Artwork {
            width,
            height,
            bgra,
        })
    }

    unsafe fn provide_iconic_thumbnail(
        hwnd: HWND,
        data: &TaskbarData,
        max_width: u32,
        max_height: u32,
    ) {
        if max_width == 0 || max_height == 0 {
            return;
        }
        let Ok(preview) = data.preview.lock() else {
            return;
        };
        let Ok(bitmap) = preview_bitmap(&preview, max_width, max_height) else {
            return;
        };
        let _ = unsafe { DwmSetIconicThumbnail(hwnd, bitmap, 0) };
        unsafe {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
        }
    }

    fn preview_bitmap(
        preview: &PreviewState,
        max_width: u32,
        max_height: u32,
    ) -> WindowsResult<HBITMAP> {
        let side = max_width.min(max_height).max(1);
        let bgra = if let Some(artwork) = &preview.artwork {
            resize_square_bgra(artwork, side)
        } else {
            let mut pixels = Vec::with_capacity((side * side * 4) as usize);
            for _ in 0..side * side {
                pixels.extend_from_slice(&[18, 18, 18, 255]);
            }
            pixels
        };
        create_bgra_bitmap(side, side, &bgra)
    }

    fn resize_square_bgra(artwork: &Artwork, side: u32) -> Vec<u8> {
        let crop_side = artwork.width.min(artwork.height);
        let crop_x = (artwork.width - crop_side) / 2;
        let crop_y = (artwork.height - crop_side) / 2;
        let scale = crop_side as f32 / side as f32;
        let mut output = Vec::with_capacity((side * side * 4) as usize);

        for target_y in 0..side {
            let source_y = (crop_y as f32 + (target_y as f32 + 0.5) * scale - 0.5)
                .clamp(crop_y as f32, (crop_y + crop_side - 1) as f32);
            let y0 = source_y.floor() as u32;
            let y1 = (y0 + 1).min(crop_y + crop_side - 1);
            let fy = source_y - y0 as f32;

            for target_x in 0..side {
                let source_x = (crop_x as f32 + (target_x as f32 + 0.5) * scale - 0.5)
                    .clamp(crop_x as f32, (crop_x + crop_side - 1) as f32);
                let x0 = source_x.floor() as u32;
                let x1 = (x0 + 1).min(crop_x + crop_side - 1);
                let fx = source_x - x0 as f32;
                let mut pixel = [0u8; 4];

                for (channel, value) in pixel.iter_mut().enumerate() {
                    let top = sample_channel(artwork, x0, y0, channel) * (1.0 - fx)
                        + sample_channel(artwork, x1, y0, channel) * fx;
                    let bottom = sample_channel(artwork, x0, y1, channel) * (1.0 - fx)
                        + sample_channel(artwork, x1, y1, channel) * fx;
                    *value = (top * (1.0 - fy) + bottom * fy).round() as u8;
                }

                let alpha = pixel[3] as u16;
                for channel in &mut pixel[..3] {
                    *channel = ((*channel as u16 * alpha + 18 * (255 - alpha) + 127) / 255) as u8;
                }
                pixel[3] = 255;
                output.extend_from_slice(&pixel);
            }
        }
        output
    }

    fn sample_channel(artwork: &Artwork, x: u32, y: u32, channel: usize) -> f32 {
        artwork.bgra[((y * artwork.width + x) * 4) as usize + channel] as f32
    }

    fn create_media_icon(kind: MediaIcon, size: u32) -> Result<HICON, String> {
        let alpha = rasterize_icon(kind, size);
        create_icon_from_alpha(size, &alpha).map_err(|error| error.to_string())
    }

    fn rasterize_icon(kind: MediaIcon, size: u32) -> Vec<u8> {
        const SUPERSAMPLE: u32 = 4;
        let high_size = size * SUPERSAMPLE;
        let unit = high_size as f32 / 16.0;
        let mut mask = vec![false; (high_size * high_size) as usize];

        match kind {
            MediaIcon::Previous => {
                fill_rect(&mut mask, high_size, 2.5, 3.5, 4.2, 12.5, unit);
                fill_triangle(
                    &mut mask,
                    high_size,
                    [(4.5, 8.0), (12.2, 3.4), (12.2, 12.6)],
                    unit,
                );
            }
            MediaIcon::Play => fill_triangle(
                &mut mask,
                high_size,
                [(4.2, 3.0), (13.0, 8.0), (4.2, 13.0)],
                unit,
            ),
            MediaIcon::Pause => {
                fill_rect(&mut mask, high_size, 4.0, 3.0, 7.0, 13.0, unit);
                fill_rect(&mut mask, high_size, 9.0, 3.0, 12.0, 13.0, unit);
            }
            MediaIcon::Next => {
                fill_triangle(
                    &mut mask,
                    high_size,
                    [(3.8, 3.4), (11.5, 8.0), (3.8, 12.6)],
                    unit,
                );
                fill_rect(&mut mask, high_size, 11.8, 3.5, 13.5, 12.5, unit);
            }
            MediaIcon::Favorite | MediaIcon::FavoriteFilled => {
                let heart = heart_points(unit);
                if matches!(kind, MediaIcon::FavoriteFilled) {
                    fill_polygon(&mut mask, high_size, &heart);
                } else {
                    for points in heart.windows(2) {
                        draw_line(&mut mask, high_size, points[0], points[1], 1.45 * unit);
                    }
                }
            }
        }

        let mut alpha = vec![0u8; (size * size) as usize];
        for y in 0..size {
            for x in 0..size {
                let mut coverage = 0u32;
                for sample_y in 0..SUPERSAMPLE {
                    for sample_x in 0..SUPERSAMPLE {
                        let high_x = x * SUPERSAMPLE + sample_x;
                        let high_y = y * SUPERSAMPLE + sample_y;
                        if mask[(high_y * high_size + high_x) as usize] {
                            coverage += 1;
                        }
                    }
                }
                alpha[(y * size + x) as usize] =
                    (coverage * 255 / (SUPERSAMPLE * SUPERSAMPLE)) as u8;
            }
        }
        alpha
    }

    fn heart_points(unit: f32) -> Vec<(f32, f32)> {
        let mut points = Vec::with_capacity(66);
        for index in 0..=64 {
            let angle = TAU * index as f32 / 64.0;
            let x = 8.0 + 0.32 * 16.0 * angle.sin().powi(3);
            let y = 8.0
                - 0.29
                    * (13.0 * angle.cos()
                        - 5.0 * (2.0 * angle).cos()
                        - 2.0 * (3.0 * angle).cos()
                        - (4.0 * angle).cos());
            points.push((x * unit, y * unit));
        }
        points
    }

    fn fill_rect(
        mask: &mut [bool],
        size: u32,
        left: f32,
        top: f32,
        right: f32,
        bottom: f32,
        unit: f32,
    ) {
        let left = (left * unit).floor().max(0.0) as u32;
        let top = (top * unit).floor().max(0.0) as u32;
        let right = (right * unit).ceil().min(size as f32) as u32;
        let bottom = (bottom * unit).ceil().min(size as f32) as u32;
        for y in top..bottom {
            for x in left..right {
                mask[(y * size + x) as usize] = true;
            }
        }
    }

    fn fill_triangle(mask: &mut [bool], size: u32, points: [(f32, f32); 3], unit: f32) {
        let points = points.map(|(x, y)| (x * unit, y * unit));
        for y in 0..size {
            for x in 0..size {
                let point = (x as f32 + 0.5, y as f32 + 0.5);
                let a = edge(points[0], points[1], point);
                let b = edge(points[1], points[2], point);
                let c = edge(points[2], points[0], point);
                if (a >= 0.0 && b >= 0.0 && c >= 0.0) || (a <= 0.0 && b <= 0.0 && c <= 0.0) {
                    mask[(y * size + x) as usize] = true;
                }
            }
        }
    }

    fn fill_polygon(mask: &mut [bool], size: u32, points: &[(f32, f32)]) {
        for y in 0..size {
            for x in 0..size {
                let point = (x as f32 + 0.5, y as f32 + 0.5);
                let mut inside = false;
                for index in 0..points.len() - 1 {
                    let (x1, y1) = points[index];
                    let (x2, y2) = points[index + 1];
                    if (y1 > point.1) != (y2 > point.1)
                        && point.0 < (x2 - x1) * (point.1 - y1) / (y2 - y1) + x1
                    {
                        inside = !inside;
                    }
                }
                if inside {
                    mask[(y * size + x) as usize] = true;
                }
            }
        }
    }

    fn draw_line(mask: &mut [bool], size: u32, start: (f32, f32), end: (f32, f32), width: f32) {
        let radius_squared = (width * 0.5).powi(2);
        let segment = (end.0 - start.0, end.1 - start.1);
        let length_squared = segment.0 * segment.0 + segment.1 * segment.1;
        for y in 0..size {
            for x in 0..size {
                let point = (x as f32 + 0.5, y as f32 + 0.5);
                let projection = if length_squared > 0.0 {
                    (((point.0 - start.0) * segment.0 + (point.1 - start.1) * segment.1)
                        / length_squared)
                        .clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let nearest = (
                    start.0 + projection * segment.0,
                    start.1 + projection * segment.1,
                );
                let distance_squared =
                    (point.0 - nearest.0).powi(2) + (point.1 - nearest.1).powi(2);
                if distance_squared <= radius_squared {
                    mask[(y * size + x) as usize] = true;
                }
            }
        }
    }

    fn edge(start: (f32, f32), end: (f32, f32), point: (f32, f32)) -> f32 {
        (point.0 - start.0) * (end.1 - start.1) - (point.1 - start.1) * (end.0 - start.0)
    }

    fn create_icon_from_alpha(size: u32, alpha: &[u8]) -> WindowsResult<HICON> {
        let mut bgra = Vec::with_capacity((size * size * 4) as usize);
        for alpha in alpha {
            bgra.extend_from_slice(&[*alpha, *alpha, *alpha, *alpha]);
        }
        let color = create_bgra_bitmap(size, size, &bgra)?;
        let mask_stride = ((size + 15) / 16) * 2;
        let mask_bits = vec![0u8; (mask_stride * size) as usize];
        let mask = unsafe {
            CreateBitmap(
                size as i32,
                size as i32,
                1,
                1,
                Some(mask_bits.as_ptr() as *const c_void),
            )
        };
        if mask.is_invalid() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(color.0));
            }
            return Err(WindowsError::from_win32());
        }

        let icon_info = ICONINFO {
            fIcon: true.into(),
            hbmMask: mask,
            hbmColor: color,
            ..Default::default()
        };
        let icon = unsafe { CreateIconIndirect(&icon_info) };
        unsafe {
            let _ = DeleteObject(HGDIOBJ(color.0));
            let _ = DeleteObject(HGDIOBJ(mask.0));
        }
        icon
    }

    fn create_bgra_bitmap(width: u32, height: u32, pixels: &[u8]) -> WindowsResult<HBITMAP> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: width * height * 4,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut c_void = null_mut();
        let bitmap = unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)? };
        unsafe {
            copy_nonoverlapping(pixels.as_ptr(), bits as *mut u8, pixels.len());
        }
        Ok(bitmap)
    }

    unsafe extern "system" fn taskbar_subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        reference_data: usize,
    ) -> LRESULT {
        let data = unsafe { &*(reference_data as *const TaskbarData) };

        if message == data.taskbar_created_message {
            data.added.store(false, Ordering::Relaxed);
            unsafe { refresh_taskbar(hwnd, data, true) };
        } else if message == WM_DWMSENDICONICTHUMBNAIL {
            let raw_size = lparam.0 as usize;
            let max_width = ((raw_size >> 16) & 0xffff) as u32;
            let max_height = (raw_size & 0xffff) as u32;
            unsafe { provide_iconic_thumbnail(hwnd, data, max_width, max_height) };
            return LRESULT(0);
        } else if message == WM_COMMAND && ((wparam.0 >> 16) & 0xffff) as u32 == THBN_CLICKED {
            let button_id = (wparam.0 & 0xffff) as u32;
            let action = match button_id {
                TASKBAR_PREVIOUS_ID => Some("previous"),
                TASKBAR_PLAY_PAUSE_ID => {
                    data.is_playing.fetch_xor(true, Ordering::Relaxed);
                    unsafe { refresh_taskbar(hwnd, data, false) };
                    Some("toggle")
                }
                TASKBAR_NEXT_ID => Some("next"),
                TASKBAR_FAVORITE_ID => {
                    data.is_favorite.fetch_xor(true, Ordering::Relaxed);
                    unsafe { refresh_taskbar(hwnd, data, false) };
                    Some("favorite")
                }
                _ => None,
            };
            if let Some(action) = action {
                emit_command(&data.app, action);
                return LRESULT(0);
            }
        } else if message == WM_NCDESTROY {
            unsafe {
                let _ =
                    RemoveWindowSubclass(hwnd, Some(taskbar_subclass_proc), TASKBAR_SUBCLASS_ID);
                drop(Arc::from_raw(reference_data as *const TaskbarData));
            }
        }

        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }
}

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
