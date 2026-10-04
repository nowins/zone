use super::*;
use rusqlite::params;
use serde::{Deserialize,Serialize};
use tauri::State;
const KEY:&str="private.podcast.cloud.v1";
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CloudSettings {pub base_url:String,pub transcription_model:String,pub translation_model:String,pub has_key:bool}
impl Default for CloudSettings {fn default()->Self{Self{base_url:"https://api.openai.com/v1".into(),transcription_model:"whisper-1".into(),translation_model:String::new(),has_key:false}}}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Stored {settings:CloudSettings,secret:String}
pub(crate) fn validate(settings:&CloudSettings)->Result<(),String>{
  let url=validate_public_url_shape(&settings.base_url)?;
  if url.scheme()!="https"||url.query().is_some()||settings.base_url.len()>1000{return Err("服务地址须为不带查询参数的公共 HTTPS 接口地址".into());}
  for model in [&settings.transcription_model,&settings.translation_model] {if model.len()>100||!model.bytes().all(|c|c.is_ascii_alphanumeric()||b"-._:/".contains(&c)){return Err("模型名称无效".into());}}
  if settings.transcription_model.is_empty(){return Err("请填写支持 verbose_json 时间段的转写模型".into());}Ok(())
}
#[cfg(target_os="windows")]
fn protect(bytes:&[u8],decrypt:bool)->Result<Vec<u8>,String>{
  use windows::{core::PCWSTR,Win32::{Foundation::{HLOCAL,LocalFree},Security::Cryptography::{CRYPT_INTEGER_BLOB,CryptProtectData,CryptUnprotectData,CRYPTPROTECT_UI_FORBIDDEN}}};
  let input=CRYPT_INTEGER_BLOB{cbData:bytes.len() as u32,pbData:bytes.as_ptr() as *mut u8};let mut output=CRYPT_INTEGER_BLOB::default();
  unsafe {let result=if decrypt {CryptUnprotectData(&input,None,None,None,None,CRYPTPROTECT_UI_FORBIDDEN,&mut output)}else{CryptProtectData(&input,PCWSTR::null(),None,None,None,CRYPTPROTECT_UI_FORBIDDEN,&mut output)};
    result.map_err(|_|"Windows 无法保护或读取服务密钥，请重新配置")?;
    let data=std::slice::from_raw_parts(output.pbData,output.cbData as usize).to_vec();let _=LocalFree(Some(HLOCAL(output.pbData as *mut _)));Ok(data)
  }
}
#[cfg(not(target_os="windows"))]
fn protect(_: &[u8],_:bool)->Result<Vec<u8>,String>{Err("此平台尚未接入安全密钥存储".into())}
fn stored(path:&Path)->Result<Option<Stored>,String>{let db=open_database(path)?;use rusqlite::OptionalExtension;let data:Option<String>=db.query_row("SELECT value_json FROM app_settings WHERE key=?1",[KEY],|r|r.get(0)).optional().map_err(|e|e.to_string())?;data.map(|data|serde_json::from_str(&data).map_err(|_|"转写服务设置损坏，原记录已保留".into())).transpose()}
pub(crate) fn settings(path:&Path)->Result<CloudSettings,String>{Ok(stored(path)?.map(|mut saved|{saved.settings.has_key=!saved.secret.is_empty();saved.settings}).unwrap_or_default())}
pub(crate) fn credentials(path:&Path)->Result<(CloudSettings,String),String>{let saved=stored(path)?.ok_or("请先在设置 → 播客 → 转写服务配置服务")?;validate(&saved.settings)?;if saved.secret.len()>16384||saved.secret.len()%2!=0||!saved.secret.bytes().all(|c|c.is_ascii_hexdigit()){return Err("服务密钥不可用，请重新配置".into());}
  let bytes=(0..saved.secret.len()).step_by(2).map(|i|u8::from_str_radix(&saved.secret[i..i+2],16).map_err(|_|"服务密钥无效")).collect::<Result<Vec<_>,_>>()?;
  let secret=String::from_utf8(protect(&bytes,true)?).map_err(|_|"服务密钥无效")?;if secret.is_empty(){return Err("请配置服务密钥".into());}Ok((saved.settings,secret))
}
pub(crate) fn save(path:&Path,mut settings:CloudSettings,key:Option<String>,clear:bool)->Result<CloudSettings,String>{
  settings.base_url=settings.base_url.trim().trim_end_matches('/').into();validate(&settings)?;
  let old=stored(path)?;let secret=if clear {String::new()}else if let Some(key)=key.filter(|key|!key.is_empty()) {if key.len()>4096||key.bytes().any(|c|c.is_ascii_control()){return Err("服务密钥无效".into());}protect(key.as_bytes(),false)?.iter().map(|byte|format!("{byte:02x}")).collect()}else {if old.as_ref().is_some_and(|old|!old.secret.is_empty()&&old.settings.base_url!=settings.base_url){return Err("更换服务地址时请重新填写密钥".into());}old.map(|old|old.secret).unwrap_or_default()};
  settings.has_key=!secret.is_empty();let saved=Stored{settings:settings.clone(),secret};let db=open_database(path)?;
  db.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",params![KEY,serde_json::to_string(&saved).map_err(|e|e.to_string())?,unix_time_millis()]).map_err(|e|e.to_string())?;Ok(settings)
}
#[tauri::command]
pub async fn podcast_get_cloud_settings(state:State<'_,PodcastState>)->Result<CloudSettings,String>{state.ensure_ready()?;settings(&state.db_path)}
#[tauri::command]
pub async fn podcast_set_cloud_settings(state:State<'_,PodcastState>,settings:CloudSettings,key:Option<String>,clear_key:bool)->Result<CloudSettings,String>{state.ensure_ready()?;save(&state.db_path,settings,key,clear_key)}

#[cfg(test)]
mod tests {
  use super::*;use crate::podcast::test_support::*;
  #[test]
  fn credentials_are_protected_and_excluded_from_exports_and_origin_changes_require_a_key() {
    let dir=test_directory("cloud-secret");let state=PodcastState::initialize_at(&dir).unwrap();
    let value=save(&state.db_path,CloudSettings::default(),Some("test-fixture-secret".into()),false).unwrap();assert!(value.has_key);assert_eq!(credentials(&state.db_path).unwrap().1,"test-fixture-secret");
    let raw:String=open_database(&state.db_path).unwrap().query_row("SELECT value_json FROM app_settings WHERE key=?1",[KEY],|r|r.get(0)).unwrap();assert!(!raw.contains("test-fixture-secret"));
    let mut next=value.clone();next.base_url="https://example.com/v1".into();assert!(save(&state.db_path,next,None,false).is_err());
    let path=dir.join("backup.zonepodcast");export_backup(&state,&path,Default::default(),false).unwrap();assert!(!fs::read_to_string(&path).unwrap().contains(KEY));
    for address in ["http://example.com/v1","https://127.0.0.1/v1","https://user:secret@example.com/v1","https://example.com/v1?secret=one"] {let mut settings=value.clone();settings.base_url=address.into();assert!(save(&state.db_path,settings,Some("x".into()),false).is_err());}
    assert!(!save(&state.db_path,value,None,true).unwrap().has_key);fs::remove_dir_all(dir).unwrap();
  }
}
