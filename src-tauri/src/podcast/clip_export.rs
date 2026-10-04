use super::*;
use std::{io::Write,sync::atomic::AtomicBool};
use tauri::State;
pub(crate) fn clip_bytes(state:&PodcastState,episode:&str,start:f64,end:f64)->Result<Vec<u8>,String>{
  validate_identifier(episode)?;if !start.is_finite()||!end.is_finite()||start<0.0||end<=start||end-start>300.0{return Err("片段须为 0–5 分钟的有效音频范围".into());}
  let _guard=EpisodeFileGuard::acquire(&state.active_downloads,episode)?;
  let detail=get_episode_detail(&state.db_path,&state.downloads_dir,episode)?;
  if detail.episode.duration_seconds.is_some_and(|duration|end>duration+0.1){return Err("片段结束位置超过本集时长".into());}
  let path=PathBuf::from(detail.episode.local_path.ok_or("请先下载本集音频")?);if !is_managed_download_path(&state.downloads_dir,episode,&path){return Err("音频文件路径无效".into());}
  let mut bytes=Vec::new();super::pcm_export::decode_chunks(&path,start,Some(end),300,&AtomicBool::new(false),|chunk|{if !bytes.is_empty(){return Err("片段超出长度上限".into());}bytes=chunk.bytes;Ok(())})?;Ok(bytes)
}
pub(crate) fn write_clip(path:&Path,bytes:&[u8])->Result<(),String>{
  if !path.is_absolute()||path.extension().and_then(|s|s.to_str()).is_none_or(|extension|!extension.eq_ignore_ascii_case("wav"))||bytes.len()>10*1024*1024||!bytes.starts_with(b"RIFF"){return Err("片段导出位置或格式无效".into());}
  let parent=path.parent().ok_or("导出目录无效")?;let metadata=fs::symlink_metadata(parent).map_err(|_|"无法读取导出目录")?;if metadata.file_type().is_symlink()||!metadata.is_dir(){return Err("导出目录不能是链接或非目录文件".into());}
  if path.exists(){return Err("目标文件已存在，请使用新的文件名".into());}
  let parent=parent.canonicalize().map_err(|_|"无法核实导出目录")?;let destination=parent.join(path.file_name().ok_or("导出文件名无效")?);
  let temporary=parent.join(format!(".zone-clip-{}.tmp",hash_identifier("clip",&[&unix_time_millis().to_string(),&destination.to_string_lossy()])));
  let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_|"无法创建片段临时文件")?;
  let result=(||{file.write_all(bytes).map_err(|_|"片段写入失败")?;file.sync_all().map_err(|_|"片段保存失败")?;drop(file);
    // A hard link publishes the completed bytes atomically and cannot overwrite an existing file.
    fs::hard_link(&temporary,&destination).map_err(|_|"无法保存片段；文件可能已存在，或目标目录不支持原子导出")?;Ok(())})();let _=fs::remove_file(&temporary);result
}
#[tauri::command]
pub async fn podcast_export_clip(state:State<'_,PodcastState>,episode_id:String,start_seconds:f64,end_seconds:f64)->Result<Option<String>,String>{
  state.ensure_ready()?;let state=state.inner().clone();let bytes=tauri::async_runtime::spawn_blocking(move||clip_bytes(&state,&episode_id,start_seconds,end_seconds)).await.map_err(|_|"音频处理失败")??;
  let Some(file)=rfd::AsyncFileDialog::new().set_title("导出播客片段").add_filter("WAV 音频",&["wav"]).set_file_name(format!("Zone-播客片段-{}.wav",start_seconds.floor() as i64)).save_file().await else{return Ok(None)};
  let path=file.path().to_path_buf();let label=path.to_string_lossy().into_owned();tauri::async_runtime::spawn_blocking(move||write_clip(&path,&bytes)).await.map_err(|_|"片段保存失败")??;Ok(Some(label))
}
#[cfg(test)]mod tests{use super::*;use crate::podcast::test_support::*;
  #[test]fn clips_decode_only_managed_audio_and_publish_without_overwriting_files(){let dir=test_directory("clip-export");let state=PodcastState::initialize_at(&dir).unwrap();let mut parsed=parsed_fixture_with_episode_count(1);parsed.episodes[0].duration_seconds=Some(3.0);let id=parsed.episodes[0].id.clone();store_subscription(&state.db_path,parsed).unwrap();let audio=state.downloads_dir.join(format!("{id}.wav"));let original=super::super::pcm_export::wav(&vec![1000;48000]);fs::write(&audio,&original).unwrap();open_database(&state.db_path).unwrap().execute("INSERT INTO podcast_downloads(episode_id,state,local_path,downloaded_bytes,updated_at) VALUES(?1,'downloaded',?2,?3,1)",rusqlite::params![id,audio.to_string_lossy(),original.len() as i64]).unwrap();let bytes=clip_bytes(&state,&id,0.5,1.5).unwrap();assert_eq!(bytes.len(),32044);let output=dir.join("excerpt.wav");write_clip(&output,&bytes).unwrap();assert!(write_clip(&output,&original).is_err());assert_eq!(fs::read(&output).unwrap(),bytes);assert_eq!(fs::read(&audio).unwrap(),original);assert!(clip_bytes(&state,&id,1.0,4.0).is_err());assert!(clip_bytes(&state,&id,0.0,301.0).is_err());fs::remove_dir_all(dir).unwrap();}
}
