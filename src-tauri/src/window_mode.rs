use std::sync::Mutex;
use serde::Serialize;
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const COMPACT_MIN: (f64, f64) = (220.0, 360.0);
const COMPACT_SIZE: (f64, f64) = COMPACT_MIN;
const COMPACT_MAX: (f64, f64) = (360.0, 600.0);

#[derive(Clone, Copy)]
struct NormalWindow {
  size: LogicalSize<f64>,
  position: PhysicalPosition<i32>,
  maximized: bool,
  always_on_top: bool,
}

#[derive(Default)]
pub struct CompactWindowState(Mutex<Option<NormalWindow>>);

#[derive(Serialize)]
pub struct CompactMode {
  active: bool,
  pinned: bool,
}

fn mode_snapshot(window: &WebviewWindow, active: bool) -> Result<CompactMode, String> {
  Ok(CompactMode {
    active,
    pinned: active && window.is_always_on_top().map_err(|error| error.to_string())?,
  })
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
  if window.label() == "main" { Ok(()) } else { Err("仅主窗口支持小屏模式".into()) }
}

fn restore(window: &WebviewWindow, normal: NormalWindow) -> tauri::Result<()> {
  let config = window.app_handle().config();
  let bounds = config.app.windows.iter().find(|item| item.label == "main");
  window.set_max_size(bounds.and_then(|item| item.max_width.zip(item.max_height)).map(|(w, h)| LogicalSize::new(w, h)))?;
  window.set_min_size(bounds.and_then(|item| item.min_width.zip(item.min_height)).map(|(w, h)| LogicalSize::new(w, h)))?;
  window.set_maximizable(true)?;
  window.set_size(normal.size)?;
  // A disconnected monitor must not strand the normal window off screen.
  let monitors = window.available_monitors()?;
  let visible = monitors.iter().any(|monitor| {
    let area = monitor.work_area();
    normal.position.x >= area.position.x && normal.position.x < area.position.x + area.size.width as i32 - 80
      && normal.position.y >= area.position.y && normal.position.y < area.position.y + area.size.height as i32 - 28
  });
  if visible { window.set_position(normal.position)?; } else { window.center()?; }
  if normal.maximized { window.maximize()?; }
  window.set_always_on_top(normal.always_on_top)?;
  Ok(())
}

// Work in physical pixels for placement, retaining monitor-specific DPI for size.
fn compact_bounds(
  position: PhysicalPosition<i32>,
  previous_width: f64,
  area_position: PhysicalPosition<i32>,
  area_size: PhysicalSize<u32>,
  scale: f64,
) -> (LogicalSize<f64>, PhysicalPosition<i32>) {
  let width = COMPACT_SIZE.0.min(area_size.width as f64 / scale);
  let height = COMPACT_SIZE.1.min(area_size.height as f64 / scale);
  let max_x = area_position.x + (area_size.width as f64 - width * scale).max(0.0) as i32;
  let max_y = area_position.y + (area_size.height as f64 - height * scale).max(0.0) as i32;
  let x = position.x + ((previous_width - width) * scale) as i32;
  (LogicalSize::new(width, height), PhysicalPosition::new(
    x.clamp(area_position.x, max_x), position.y.clamp(area_position.y, max_y),
  ))
}

fn enter(window: &WebviewWindow, normal: NormalWindow) -> tauri::Result<()> {
  let monitor = window.current_monitor()?.or(window.primary_monitor()?);
  let scale = window.scale_factor()?;
  let (size, position) = if let Some(monitor) = &monitor {
    let area = monitor.work_area();
    compact_bounds(normal.position, normal.size.width, area.position, area.size, scale)
  } else {
    (LogicalSize::new(COMPACT_SIZE.0, COMPACT_SIZE.1), normal.position)
  };
  window.unmaximize()?;
  window.set_min_size(Some(LogicalSize::new(COMPACT_MIN.0.min(size.width), COMPACT_MIN.1.min(size.height))))?;
  window.set_max_size(Some(LogicalSize::new(COMPACT_MAX.0, COMPACT_MAX.1)))?;
  window.set_maximizable(false)?;
  window.set_size(size)?;
  window.set_position(position)?;
  Ok(())
}

#[tauri::command]
pub async fn get_compact_mode(window: WebviewWindow, state: tauri::State<'_, CompactWindowState>) -> Result<CompactMode, String> {
  main_window(&window)?;
  let current = state.0.lock().map_err(|_| "窗口状态不可用")?;
  mode_snapshot(&window, current.is_some())
}

/// Pinning is restricted to the main window while its compact snapshot exists.
#[tauri::command]
pub async fn set_compact_pinned(
  window: WebviewWindow,
  state: tauri::State<'_, CompactWindowState>,
  pinned: bool,
) -> Result<CompactMode, String> {
  main_window(&window)?;
  let current = state.0.lock().map_err(|_| "窗口状态不可用")?;
  if current.is_none() { return Err("仅小屏模式支持窗口置顶".into()); }
  window.set_always_on_top(pinned).map_err(|error| error.to_string())?;
  mode_snapshot(&window, true)
}

/// Only two predefined layouts are exposed; the webview cannot request arbitrary geometry.
#[tauri::command]
pub async fn set_compact_mode(
  window: WebviewWindow,
  state: tauri::State<'_, CompactWindowState>,
  compact: bool,
) -> Result<CompactMode, String> {
  main_window(&window)?;
  let mut current = state.0.lock().map_err(|_| "窗口状态不可用")?;
  if current.is_some() == compact { return mode_snapshot(&window, compact); }
  if window.is_fullscreen().map_err(|error| error.to_string())? {
    return Err("请先退出全屏".into());
  }
  if compact {
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized { window.unmaximize().map_err(|error| error.to_string())?; }
    let snapshot = (|| -> tauri::Result<NormalWindow> {
      Ok(NormalWindow {
        size: window.inner_size()?.to_logical(window.scale_factor()?),
        position: window.outer_position()?,
        maximized,
        always_on_top: window.is_always_on_top()?,
      })
    })();
    let normal = match snapshot {
      Ok(normal) => normal,
      Err(error) => {
        if maximized { let _ = window.maximize(); }
        return Err(error.to_string());
      }
    };
    if let Err(error) = enter(&window, normal) {
      // Retain a restoration snapshot if rollback fails, so a later exit can retry.
      if restore(&window, normal).is_err() { *current = Some(normal); }
      return Err(error.to_string());
    }
    *current = Some(normal);
  } else if let Some(normal) = *current {
    let pinned = window.is_always_on_top().map_err(|error| error.to_string())?;
    if let Err(error) = restore(&window, normal) {
      let _ = enter(&window, normal);
      let _ = window.set_always_on_top(pinned);
      return Err(error.to_string());
    }
    *current = None;
  }
  mode_snapshot(&window, compact)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn compact_state_exposes_mode_and_native_pin_status_together() {
    for (active, pinned) in [(false, false), (true, false), (true, true)] {
      assert_eq!(serde_json::to_value(CompactMode { active, pinned }).unwrap(),
        serde_json::json!({ "active": active, "pinned": pinned }));
    }
  }

  #[test]
  fn compact_keeps_the_right_edge_at_high_dpi() {
    let (size, position) = compact_bounds(PhysicalPosition::new(100, 70), 1180.0,
      PhysicalPosition::new(0, 0), PhysicalSize::new(3840, 2080), 2.0);
    assert_eq!(size, LogicalSize::new(220.0, 360.0));
    assert_eq!(position, PhysicalPosition::new(2020, 70));
  }

  #[test]
  fn compact_stays_inside_negative_origin_work_area() {
    let (size, position) = compact_bounds(PhysicalPosition::new(-1000, 800), 1180.0,
      PhysicalPosition::new(-1920, 0), PhysicalSize::new(1920, 1040), 1.5);
    assert_eq!(size, LogicalSize::new(220.0, 360.0));
    assert_eq!(position, PhysicalPosition::new(-330, 500));
  }

  #[test]
  fn compact_fits_a_short_screen_without_hiding_window_controls() {
    let (size, position) = compact_bounds(PhysicalPosition::new(60, 100), 920.0,
      PhysicalPosition::new(0, 40), PhysicalSize::new(1280, 440), 1.25);
    assert_eq!(size.height, 352.0);
    assert_eq!(position.y, 40);
    assert!(position.x >= 0 && position.x + (size.width * 1.25) as i32 <= 1280);
  }
}
