#[tauri::command]
pub(crate) async fn export_diagnostics(content: String) -> Result<bool, String> {
  if content.len() > 256 * 1024 { return Err("诊断记录过大".into()); }
  serde_json::from_str::<serde_json::Value>(&content).map_err(|_| "诊断记录格式无效".to_string())?;
  tauri::async_runtime::spawn_blocking(move || {
    let Some(path) = rfd::FileDialog::new().set_title("导出诊断记录")
      .add_filter("JSON", &["json"]).set_file_name("Zone-诊断记录.json").save_file()
    else { return Ok(false); };
    std::fs::write(path, content).map_err(|_| "无法保存诊断记录".to_string())?;
    Ok(true)
  }).await.map_err(|_| "导出任务异常结束".to_string())?
}
