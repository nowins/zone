use super::*;
use std::sync::atomic::{AtomicBool,Ordering};
use symphonia::core::{audio::SampleBuffer,codecs::DecoderOptions,errors::Error,formats::FormatOptions,io::MediaSourceStream,meta::MetadataOptions,probe::Hint};

pub(crate) struct PcmChunk {pub bytes:Vec<u8>,pub start:f64,pub duration:f64}
pub(crate) fn wav(samples:&[i16])->Vec<u8> {
  let length=samples.len()*2;let mut output=Vec::with_capacity(length+44);
  output.extend(b"RIFF");output.extend(((length+36) as u32).to_le_bytes());output.extend(b"WAVEfmt ");output.extend(16u32.to_le_bytes());output.extend(1u16.to_le_bytes());output.extend(1u16.to_le_bytes());output.extend(16000u32.to_le_bytes());output.extend(32000u32.to_le_bytes());output.extend(2u16.to_le_bytes());output.extend(16u16.to_le_bytes());output.extend(b"data");output.extend((length as u32).to_le_bytes());
  for sample in samples {output.extend(sample.to_le_bytes());} output
}

// Stream bounded mono PCM chunks; no playback element or music analysis is involved.
pub(crate) fn decode_chunks(path:&Path,start:f64,end:Option<f64>,chunk_seconds:usize,cancelled:&AtomicBool,mut emit:impl FnMut(PcmChunk)->Result<(),String>)->Result<(),String> {
  if !start.is_finite() || !(0.0..=28800.0).contains(&start) || end.is_some_and(|end| !end.is_finite()||end<=start||end>28800.0) || !(1..=600).contains(&chunk_seconds) {return Err("音频处理范围无效".into());}
  let file=fs::File::open(path).map_err(|_|"无法读取已下载音频")?;
  let mut hint=Hint::new();if let Some(extension)=path.extension().and_then(|s|s.to_str()){hint.with_extension(extension);}
  let mut format=symphonia::default::get_probe().format(&hint,MediaSourceStream::new(Box::new(file),Default::default()),&FormatOptions::default(),&MetadataOptions::default()).map_err(|_|"不支持这份音频的处理格式")?.format;
  let track=format.default_track().ok_or("音频没有可解码轨道")?;let track_id=track.id;let parameters=track.codec_params.clone();
  let mut decoder=symphonia::default::get_codecs().make(&parameters,&DecoderOptions::default()).map_err(|_|"无法解码播客音频")?;
  let mut input_time=0.0;let mut next_output=0.0;let mut output_frame=0u64;let mut previous=0.0f32;let mut samples=Vec::<i16>::with_capacity(chunk_seconds*16000);let mut chunk_start=None;let mut emitted=false;
  loop {
    if cancelled.load(Ordering::Relaxed){return Err("已取消音频处理".into());}
    let packet=match format.next_packet(){Ok(packet)=>packet,Err(Error::IoError(error)) if error.kind()==std::io::ErrorKind::UnexpectedEof=>break,Err(_)=>return Err("音频文件损坏或读取失败".into())};
    if packet.track_id()!=track_id{continue;}
    let decoded=decoder.decode(&packet).map_err(|_|"音频解码失败，未保存处理结果")?;
    let spec=*decoded.spec();let rate=spec.rate;if !(8000..=384000).contains(&rate){return Err("音频采样率不支持".into());}let channels=spec.channels.count();if channels==0||channels>32{return Err("音频声道不支持".into());}
    let mut buffer=SampleBuffer::<f32>::new(decoded.capacity() as u64,spec);buffer.copy_interleaved_ref(decoded);
    for frame in buffer.samples().chunks_exact(channels) {
      let mono=frame.iter().sum::<f32>()/channels as f32;
      while next_output<=input_time {
        if next_output>=28800.0{return Err("音频处理上限为 8 小时".into());}
        if end.is_some_and(|end|next_output>=end){if !samples.is_empty(){let duration=samples.len() as f64/16000.0;emit(PcmChunk{bytes:wav(&samples),start:chunk_start.unwrap(),duration})?;}return Ok(());}
        if next_output>=start {
          chunk_start.get_or_insert(next_output);
          let fraction=((input_time-next_output)*rate as f64).clamp(0.0,1.0) as f32;
          let value=mono*(1.0-fraction)+previous*fraction;
          samples.push((if value.is_finite(){value.clamp(-1.0,1.0)}else{0.0}*32767.0).round() as i16);
          if samples.len()==chunk_seconds*16000 {emit(PcmChunk{bytes:wav(&samples),start:chunk_start.unwrap(),duration:chunk_seconds as f64})?;samples.clear();chunk_start=None;emitted=true;}
        }
        output_frame+=1;next_output=output_frame as f64/16000.0;
      }
      previous=mono;input_time+=1.0/rate as f64;
    }
  }
  if end.is_some_and(|end|input_time+0.1<end){return Err("音频实际时长不足，未保存片段".into());}
  if !samples.is_empty(){let duration=samples.len() as f64/16000.0;emit(PcmChunk{bytes:wav(&samples),start:chunk_start.unwrap(),duration})?;emitted=true;}
  if !emitted{return Err("音频处理范围为空".into());}Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;use crate::podcast::test_support::test_directory;
  #[test]
  fn pcm_processing_is_bounded_timed_cancellable_and_decodes_real_audio() {
    let dir=test_directory("pcm-export");let file=dir.join("audio.wav");let samples=(0..48000).map(|i|((i as f64*220.0*std::f64::consts::TAU/16000.0).sin()*1000.0) as i16).collect::<Vec<_>>();fs::write(&file,wav(&samples)).unwrap();
    let cancel=AtomicBool::new(false);let mut chunks=Vec::new();decode_chunks(&file,0.5,Some(2.5),1,&cancel,|chunk|{chunks.push(chunk);Ok(())}).unwrap();assert_eq!(chunks.len(),2);assert!((chunks[0].start-0.5).abs()<0.001);assert_eq!(&chunks[0].bytes[..4],b"RIFF");assert_eq!(chunks[0].bytes.len(),32044);assert!(chunks[0].bytes[44..].iter().any(|byte|*byte!=0));
    cancel.store(true,Ordering::Relaxed);assert!(decode_chunks(&file,0.0,None,1,&cancel,|_|Ok(())).is_err());cancel.store(false,Ordering::Relaxed);assert!(decode_chunks(&file,0.0,Some(30.0),1,&cancel,|_|Ok(())).is_err());fs::remove_dir_all(dir).unwrap();
  }
}
