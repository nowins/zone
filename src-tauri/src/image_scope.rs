//! Grant exact image files returned by native library commands, never directories.
use std::{collections::HashSet, fs, io::Read, path::Path};
use tauri::{AppHandle, Manager};

pub(crate) fn allow_images<'a>(app: &AppHandle, paths: impl IntoIterator<Item = &'a str>) {
  let scope = app.asset_protocol_scope();
  for path in paths.into_iter().collect::<HashSet<_>>() {
    if readable_image(Path::new(path)) {
      if let Err(error) = scope.allow_file(path) { eprintln!("[artwork] image scope failed: {error}"); }
    }
  }
}

pub(crate) fn allow_tracks(app: &AppHandle, tracks: &[crate::library::Track]) {
  allow_images(app, tracks.iter().filter_map(|track| track.cover_path.as_deref()));
}

fn readable_image(path: &Path) -> bool {
  let Some(extension) = path.extension().and_then(|value| value.to_str()) else { return false; };
  if !matches!(extension.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp") { return false; }
  let Ok(metadata) = fs::metadata(path) else { return false; };
  if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 { return false; }
  let mut header = [0; 12];
  let Ok(mut file) = fs::File::open(path) else { return false; };
  if file.read_exact(&mut header).is_err() { return false; }
  header.starts_with(&[0xff, 0xd8, 0xff]) || header.starts_with(b"\x89PNG\r\n\x1a\n")
    || header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a")
    || (header.starts_with(b"RIFF") && &header[8..12] == b"WEBP")
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn only_bounded_images_with_valid_headers_can_enter_asset_scope() {
    let root = std::env::temp_dir().join(format!("zone-image-scope-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let image = root.join("cover.png");
    fs::write(&image, b"\x89PNG\r\n\x1a\nimage").unwrap();
    assert!(readable_image(&image));
    let data = root.join("database.sqlite");
    fs::write(&data, b"SQLite format 3\0").unwrap();
    assert!(!readable_image(&data));
    fs::write(&image, b"SQLite format 3\0").unwrap();
    assert!(!readable_image(&image));
    let file = fs::File::create(&image).unwrap(); file.set_len(8 * 1024 * 1024 + 1).unwrap(); drop(file);
    assert!(!readable_image(&image));
    fs::remove_dir_all(root).unwrap();
  }
}
