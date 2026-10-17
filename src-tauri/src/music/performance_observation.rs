//! Opt-in observations over generated fixtures; never starts Tauri or reads a user library.
use super::*;
use crate::{db::{open_zone_database, unix_millis}, library::MusicFolder};
use rusqlite::params;
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, process::Command, time::Instant};

fn workspace() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".tmp/perf") }
fn durations(values: Vec<f64>) -> Value {
  let mut sorted = values.clone(); sorted.sort_by(f64::total_cmp);
  json!({"samplesMs": values, "medianMs": sorted[3], "p95Ms": sorted[6], "count": 7})
}
fn timed<T>(operation: impl FnOnce() -> T) -> (T, f64) {
  let started = Instant::now(); let value = operation(); (value, started.elapsed().as_secs_f64() * 1000.0)
}
fn read_sample(state: &MusicState, count: usize) -> Value {
  let (snapshot, read_ms) = timed(|| load_library_snapshot(state).unwrap());
  assert_eq!(snapshot.tracks.len(), count);
  let (bytes, json_ms) = timed(|| serde_json::to_vec(&snapshot).unwrap());
  json!({"snapshotMs": read_ms, "serializeMs": json_ms, "jsonBytes": bytes.len()})
}

#[test]
#[ignore = "Helper for the opt-in generated library observation; not a product startup test"]
fn fresh_process_read() {
  let Some(folder) = std::env::var_os("ZONE_PERF_FIXTURE") else { return; };
  let root = workspace().canonicalize().unwrap();
  let folder = PathBuf::from(folder).canonicalize().unwrap();
  assert!(folder.starts_with(&root));
  assert_eq!(fs::read_to_string(folder.join("generated-fixture.txt")).unwrap(), "Zone generated performance fixture v1");
  let count: usize = std::env::var("ZONE_PERF_COUNT").unwrap().parse().unwrap();
  let state = MusicState { db_path: folder.join("zone.sqlite"), initialization_error: None };
  println!("ZONE_PERF_SAMPLE {}", read_sample(&state, count));
}

fn seed_library(folder: &Path, count: usize) -> MusicState {
  let state = MusicState::initialize_at(folder).unwrap();
  fs::write(folder.join("generated-fixture.txt"), "Zone generated performance fixture v1").unwrap();
  let mut db = open_zone_database(state.db_path()).unwrap();
  let tx = db.transaction().unwrap();
  tx.execute("INSERT INTO music_folders(path,name,added_at) VALUES(?1,'生成基准',1)", [folder.to_string_lossy().as_ref()]).unwrap();
  {
    let mut track = tx.prepare("INSERT INTO music_tracks(id,path,folder_path,file_name,extension,title,artist,album,album_artist,track_number,disc_number,year,duration_seconds,genres_json,added_at,scanned_at) VALUES(?1,?2,?3,?4,'wav',?5,?6,?7,?6,?8,1,2024,180,'[\"生成流派\"]',1,1)").unwrap();
    let mut stats = tx.prepare("INSERT INTO music_track_stats(track_id,play_count,updated_at) VALUES(?1,8,1)").unwrap();
    for i in 0..count {
      track.execute(params![format!("track-{i}"), folder.join(format!("generated-reference-{i}.wav")).to_string_lossy(),folder.to_string_lossy(),format!("{}.wav",i%12+1),format!("歌曲 {i} Café"),format!("艺术家 {}",i/120),format!("专辑 {}",i/12),(i%12+1) as i64]).unwrap();
      if i%10 == 0 { stats.execute([format!("track-{i}")]).unwrap(); }
    }
    let mut list = tx.prepare("INSERT INTO music_playlists(id,name,kind,created_at,updated_at) VALUES(?1,?2,'manual',1,1)").unwrap();
    let mut item = tx.prepare("INSERT INTO music_playlist_items(playlist_id,track_id,position,added_at) VALUES(?1,?2,?3,1)").unwrap();
    for i in 0..100 {
      let id = format!("list-{i}"); list.execute(params![id,format!("列表 {i}")]).unwrap();
      for j in 0..500.min(count.div_ceil(100)) { item.execute(params![id,format!("track-{}",(i*97+j*13)%count),j as i64]).unwrap(); }
    }
  }
  tx.commit().unwrap();db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();state
}

fn wave() -> Vec<u8> {
  let frames = 22050u32; let size = frames * 2; let mut bytes = Vec::with_capacity(44+size as usize);
  bytes.extend(b"RIFF");bytes.extend((36+size).to_le_bytes());bytes.extend(b"WAVEfmt ");bytes.extend(16u32.to_le_bytes());
  bytes.extend(1u16.to_le_bytes());bytes.extend(1u16.to_le_bytes());bytes.extend(22050u32.to_le_bytes());bytes.extend(44100u32.to_le_bytes());
  bytes.extend(2u16.to_le_bytes());bytes.extend(16u16.to_le_bytes());bytes.extend(b"data");bytes.extend(size.to_le_bytes());
  for i in 0..frames { bytes.extend(((i%100) as i16*100-5000).to_le_bytes()); } bytes
}

#[test]
#[ignore = "Generated native backend benchmark; run explicitly in release mode and without competing builds"]
fn generated_library_observation() {
  assert!(!cfg!(debug_assertions), "Use --release for comparable observations");
  let phase = std::env::var("ZONE_PERF_PHASE").unwrap_or_else(|_|"before".into());
  assert!(phase.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'));
  let root = workspace().join(format!("generated-{}-{}",std::process::id(),unix_millis()));fs::create_dir_all(&root).unwrap();
  let mut reads = Vec::new();
  for count in [1000,10000,50000] {
    let folder = root.join(format!("library-{count}"));let state = seed_library(&folder,count);
    let mut fresh = Vec::new();let mut wall = Vec::new();
    for _ in 0..7 {
      let (output, elapsed) = timed(|| Command::new(std::env::current_exe().unwrap()).args(["music::performance_observation::fresh_process_read","--exact","--ignored","--nocapture","--test-threads=1"])
        .env("ZONE_PERF_FIXTURE",&folder).env("ZONE_PERF_COUNT",count.to_string()).output().unwrap());
      assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
      let stdout = String::from_utf8(output.stdout).unwrap();
      let line = stdout.lines().find_map(|line|line.find("ZONE_PERF_SAMPLE ").map(|index|&line[index+17..])).expect("child sample");
      fresh.push(serde_json::from_str::<Value>(line).unwrap());wall.push(elapsed);
    }
    let _ = read_sample(&state,count);let warm = (0..7).map(|_|read_sample(&state,count)).collect::<Vec<_>>();
    reads.push(json!({"tracks":count,"manualLists":100,"freshProcess":fresh,"freshProcessWall":durations(wall),"warm":warm,"databaseBytes":fs::metadata(state.db_path()).unwrap().len()}));
    println!("Measured native library {count}");
  }
  let mut scans = Vec::new();let bytes=wave();
  for count in [100,1000] {
    let folder=root.join(format!("scan-{count}"));fs::create_dir(&folder).unwrap();
    for i in 0..count {fs::write(folder.join(format!("Generated {i}.wav")),&bytes).unwrap();}
    let folders=vec![MusicFolder{path:folder.to_string_lossy().into_owned(),name:"生成 WAV".into()}];
    let state=MusicState::initialize_at(&root.join(format!("scan-db-{count}"))).unwrap();
    let (first,initial_ms)=timed(||scan_and_store_library_controlled(&state,folders.clone(),&||false,&|_|{}).unwrap());assert_eq!(first.tracks.len(),count);
    let mut rescan=Vec::new();let mut parse=Vec::new();
    for _ in 0..7 {
      let (value,ms)=timed(||crate::library::scan_library_controlled(vec![folders[0].path.clone()],&||false,&|_|{}).unwrap());assert_eq!(value.tracks.len(),count);parse.push(ms);
      let (value,ms)=timed(||scan_and_store_library_controlled(&state,folders.clone(),&||false,&|_|{}).unwrap());assert_eq!(value.tracks.len(),count);rescan.push(ms);
    }
    scans.push(json!({"files":count,"generatedBytes":count*bytes.len(),"initialScanAndStoreMs":initial_ms,"warmParse":durations(parse),"warmRescanAndStore":durations(rescan)}));
    println!("Measured generated WAV scan {count}");
  }
  let report=json!({"format":"ZoneNativeLibraryObservation","version":1,"phase":phase,"profile":"release","samples":7,"fixtureRoot":root,"reads":reads,"scans":scans,
    "limitations":["Native Rust/SQLite unit-test process only; no Tauri window, IPC or application startup measured","Fresh process includes first connection/schema checks; OS disk cache is not cold or flushed","Synthetic track references have no artwork or enrichment; generated scan WAV files are 1 second PCM","Fixture generation and compilation excluded; no audio playback, renderer, CPU/GPU or frame-time claims"]});
  fs::write(workspace().join(format!("native-{phase}.json")),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
