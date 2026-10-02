use std::path::{Path, PathBuf};

fn fallback_path(executable: &Path, runtime_available: bool, explicit_override: bool) -> Option<PathBuf> {
  if runtime_available || explicit_override {
    return None;
  }
  let directory = executable.parent()?.join("WebView2");
  directory.join("msedgewebview2.exe").is_file().then_some(directory)
}

pub(crate) fn configure() {
  // Keep Evergreen updates when available; the signed package provides the offline fallback.
  if let Ok(executable) = std::env::current_exe() {
    let explicit_override = std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER")
      .is_some_and(|value| !value.is_empty());
    if let Some(directory) = fallback_path(&executable, tauri::webview_version().is_ok(), explicit_override) {
      std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", directory);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn uses_only_the_adjacent_runtime_when_evergreen_is_missing() {
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("zone-runtime-{}-{nonce}", std::process::id()));
    let directory = root.join("WebView2");
    std::fs::create_dir_all(&directory).unwrap();
    let executable = root.join("zone-player.exe");
    assert_eq!(fallback_path(&executable, false, false), None);
    std::fs::write(directory.join("msedgewebview2.exe"), b"fixture").unwrap();
    assert_eq!(fallback_path(&executable, false, false), Some(directory.clone()));
    assert_eq!(fallback_path(&executable, true, false), None);
    assert_eq!(fallback_path(&executable, false, true), None);
    std::fs::remove_file(directory.join("msedgewebview2.exe")).unwrap();
    std::fs::remove_dir(directory).unwrap();
    std::fs::remove_dir(root).unwrap();
  }
}
