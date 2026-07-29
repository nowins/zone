use super::bitmap::provide_iconic_thumbnail;
use super::{
    emit_command, TaskbarData, TASKBAR_FAVORITE_ID, TASKBAR_NEXT_ID, TASKBAR_PLAY_PAUSE_ID,
    TASKBAR_PREVIOUS_ID, TASKBAR_SUBCLASS_ID,
};
use std::ffi::c_void;
use std::mem::size_of_val;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use windows::core::{HSTRING, Result as WindowsResult};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmInvalidateIconicBitmaps, DwmSetWindowAttribute, DWMWA_FORCE_ICONIC_REPRESENTATION,
    DWMWA_HAS_ICONIC_BITMAP,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Shell::{
    DefSubclassProc, ITaskbarList3, RemoveWindowSubclass, TaskbarList, THBF_DISABLED, THBF_ENABLED,
    THBN_CLICKED, THB_FLAGS, THB_ICON, THB_TOOLTIP, THUMBBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    HICON, WM_COMMAND, WM_DWMSENDICONICTHUMBNAIL, WM_NCDESTROY,
};

pub(super) fn configure_custom_thumbnail(hwnd: HWND) {
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

pub(super) fn schedule_taskbar_refresh(hwnd: isize, data: Arc<TaskbarData>, preview_changed: bool) {
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

pub(super) unsafe fn refresh_taskbar(hwnd: HWND, data: &TaskbarData, force_add: bool) {
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

pub(super) unsafe extern "system" fn taskbar_subclass_proc(
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
