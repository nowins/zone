use super::*;
use reqwest::header::{self, HeaderMap, HeaderValue};
use rusqlite::{params, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::State;

const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const CUE_LIMIT: usize = 20_000;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCue {
  pub start_seconds: Option<f64>,
  pub end_seconds: Option<f64>,
  pub text: String,
  pub speaker: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDocument {
  pub episode_id: String,
  pub language: Option<String>,
  pub cues: Vec<TranscriptCue>,
  pub stale: bool,
}
#[derive(Clone)]
struct Resource {
  id: String,
  url: String,
  mime: String,
  language: Option<String>,
  etag: Option<String>,
  modified: Option<String>,
  fetched: Option<i64>,
}

fn timestamp(value: &str) -> Result<f64, String> {
  let parts = value
    .replace(',', ".")
    .split(':')
    .map(str::parse::<f64>)
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| "转写时间码无效")?;
  let (hours, minutes, seconds) = match parts.as_slice() {
    [m, s] => (0.0, *m, *s),
    [h, m, s] => (*h, *m, *s),
    _ => return Err("转写时间码无效".into()),
  };
  if !hours.is_finite()
    || !minutes.is_finite()
    || !seconds.is_finite()
    || hours.fract() != 0.0
    || minutes.fract() != 0.0
    || hours < 0.0
    || hours > 168.0
    || !(0.0..60.0).contains(&minutes)
    || !(0.0..60.0).contains(&seconds)
  {
    return Err("转写时间码超出范围".into());
  }
  Ok(hours * 3600.0 + minutes * 60.0 + seconds)
}

pub(crate) fn parse_transcript(bytes: &[u8], mime: &str) -> Result<Vec<TranscriptCue>, String> {
  if bytes.len() > RESPONSE_LIMIT {
    return Err("转写文件过大".into());
  }
  let text = std::str::from_utf8(bytes)
    .map_err(|_| "转写文件必须使用 UTF-8")?
    .trim_start_matches('\u{feff}')
    .replace("\r\n", "\n");
  let mut cues = Vec::new();
  match mime {
    "application/json" => {
      #[derive(Deserialize)]
      struct Segment {
        #[serde(rename = "startTime")]
        start: Option<f64>,
        #[serde(rename = "endTime")]
        end: Option<f64>,
        body: String,
        speaker: Option<String>,
      }
      #[derive(Deserialize)]
      struct Document {
        segments: Vec<Segment>,
      }
      let document: Document = serde_json::from_str(&text).map_err(|_| "JSON 转写格式无效")?;
      if document.segments.len() > CUE_LIMIT {
        return Err("转写段落过多".into());
      }
      cues = document
        .segments
        .into_iter()
        .map(|s| TranscriptCue {
          start_seconds: s.start,
          end_seconds: s.end,
          text: s.body.trim().into(),
          speaker: s.speaker,
        })
        .collect();
    }
    "text/vtt" | "application/x-subrip" | "application/srt" => {
      if mime == "text/vtt" && !text.starts_with("WEBVTT") {
        return Err("WebVTT 文件头无效".into());
      }
      let lines: Vec<_> = text.lines().collect();
      let mut index = 0;
      while index < lines.len() {
        let line = lines[index].trim();
        if line == "NOTE" || line.starts_with("NOTE ") || line == "STYLE" || line == "REGION" {
          while index < lines.len() && !lines[index].is_empty() {
            index += 1;
          }
          continue;
        }
        let Some((start, end)) = line.split_once("-->") else {
          index += 1;
          continue;
        };
        let start = timestamp(start.trim())?;
        let end = timestamp(end.split_whitespace().next().ok_or("转写时间码缺失")?)?;
        index += 1;
        let mut body = String::new();
        while index < lines.len()
          && !lines[index].trim().is_empty()
          && !lines[index].contains("-->")
        {
          body.push_str(lines[index]);
          body.push('\n');
          index += 1;
        }
        cues.push(TranscriptCue {
          start_seconds: Some(start),
          end_seconds: Some(end),
          text: plain_text(&body, body.len()),
          speaker: None,
        });
        if cues.len() > CUE_LIMIT {
          return Err("转写段落过多".into());
        }
      }
    }
    "text/plain" | "text/html" => {
      let text = if mime == "text/html" {
        plain_text(&text, text.len())
      } else {
        text
      };
      for paragraph in text.split("\n\n").filter(|value| !value.trim().is_empty()) {
        let characters: Vec<_> = paragraph.trim().chars().collect();
        for chunk in characters.chunks(4000) {
          cues.push(TranscriptCue {
            start_seconds: None,
            end_seconds: None,
            text: chunk.iter().collect(),
            speaker: None,
          });
        }
      }
    }
    _ => return Err("这份转写格式暂不支持".into()),
  }
  if cues.len() > CUE_LIMIT {
    return Err("转写段落过多".into());
  }
  for cue in &cues {
    if cue.text.chars().count() > 4000
      || cue
        .speaker
        .as_ref()
        .is_some_and(|s| s.chars().count() > 200)
      || cue
        .start_seconds
        .is_some_and(|s| !s.is_finite() || !(0.0..=604800.0).contains(&s))
      || cue
        .end_seconds
        .is_some_and(|s| !s.is_finite() || s > 604800.0 || s <= cue.start_seconds.unwrap_or(0.0))
    {
      return Err("转写段落或时间范围无效".into());
    }
  }
  cues.retain(|cue| !cue.text.is_empty());
  cues.sort_by(|a, b| {
    a.start_seconds
      .partial_cmp(&b.start_seconds)
      .unwrap_or(std::cmp::Ordering::Equal)
  });
  if cues.is_empty() {
    return Err("转写文件没有可读内容".into());
  }
  Ok(cues)
}

fn cached(
  path: &Path,
  resource: &Resource,
  episode: &str,
  stale: bool,
) -> Result<Option<TranscriptDocument>, String> {
  let db = open_database(path)?;
  let mut statement=db.prepare("SELECT start_ms,end_ms,text,speaker FROM podcast_transcript_cues WHERE resource_id=?1 ORDER BY ordinal LIMIT ?2").map_err(|e|e.to_string())?;
  let cues = statement
    .query_map(params![resource.id, CUE_LIMIT as i64], |r| {
      Ok(TranscriptCue {
        start_seconds: r.get::<_, Option<i64>>(0)?.map(|n| n as f64 / 1000.0),
        end_seconds: r.get::<_, Option<i64>>(1)?.map(|n| n as f64 / 1000.0),
        text: r.get(2)?,
        speaker: r.get(3)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok((!cues.is_empty()).then(|| TranscriptDocument {
    episode_id: episode.into(),
    language: resource.language.clone(),
    cues,
    stale,
  }))
}

async fn refresh(
  path: &Path,
  resource: &Resource,
  episode: &str,
  allow_private: bool,
) -> Result<TranscriptDocument, String> {
  let url = validate_url_shape_with_policy(&resource.url, allow_private)?;
  if !allow_private && url.scheme() != "https" {
    return Err("转写来源必须使用 HTTPS".into());
  }
  let mut headers = HeaderMap::new();
  for (key, value) in [
    (header::IF_NONE_MATCH, &resource.etag),
    (header::IF_MODIFIED_SINCE, &resource.modified),
  ] {
    if let Some(value) = value.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
      headers.insert(key, value);
    }
  }
  let response =
    send_public_get_with_headers(url, PODCAST_CHAPTER_TIMEOUT, None, allow_private, &headers)
      .await?;
  let etag = header_text(response.response.headers(), header::ETAG);
  let modified = header_text(response.response.headers(), header::LAST_MODIFIED);
  let not_modified = response.response.status() == reqwest::StatusCode::NOT_MODIFIED;
  let cues = if not_modified {
    None
  } else {
    if let Some(mime) = header_text(response.response.headers(), header::CONTENT_TYPE) {
      if !matches!(
        mime
          .split(';')
          .next()
          .unwrap_or("")
          .trim()
          .to_ascii_lowercase()
          .as_str(),
        "text/vtt"
          | "text/plain"
          | "text/html"
          | "application/json"
          | "application/x-subrip"
          | "application/srt"
          | "application/octet-stream"
      ) {
        return Err("转写来源返回了不支持的内容类型".into());
      }
    }
    Some(parse_transcript(
      &read_limited(response.response, RESPONSE_LIMIT, "播客转写").await?,
      &resource.mime,
    )?)
  };
  let mut db = open_database(path)?;
  let tx = db
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|e| e.to_string())?;
  if tx.execute("UPDATE podcast_episode_resources SET fetched_at=?3,etag=COALESCE(?4,etag),last_modified=COALESCE(?5,last_modified),error_message=NULL WHERE id=?1 AND url=?2",
    params![resource.id,resource.url,unix_time_millis(),etag,modified]).map_err(|e|e.to_string())?!=1 {return Err("转写来源已变化".into());}
  if let Some(cues) = cues {
    tx.execute(
      "DELETE FROM podcast_transcript_cues WHERE resource_id=?1",
      [&resource.id],
    )
    .map_err(|e| e.to_string())?;
    for (ordinal, cue) in cues.iter().enumerate() {
      tx.execute("INSERT INTO podcast_transcript_cues(resource_id,ordinal,start_ms,end_ms,text,speaker) VALUES(?1,?2,?3,?4,?5,?6)",params![resource.id,ordinal as i64,cue.start_seconds.map(|n|(n*1000.0).round() as i64),cue.end_seconds.map(|n|(n*1000.0).round() as i64),cue.text,cue.speaker]).map_err(|e|e.to_string())?;
    }
  } else if cached(path, resource, episode, false)?.is_none() {
    return Err("转写来源返回未修改，但本地没有缓存".into());
  }
  tx.commit().map_err(|e| e.to_string())?;
  cached(path, resource, episode, false)?.ok_or_else(|| "转写缓存为空".into())
}

pub(crate) async fn get_transcript(
  path: &Path,
  episode: &str,
  allow_private: bool,
) -> Result<TranscriptDocument, String> {
  validate_identifier(episode)?;
  let resources = {
    let db = open_database(path)?;
    let mut statement=db.prepare("SELECT id,url,mime_type,language,etag,last_modified,fetched_at FROM podcast_episode_resources WHERE episode_id=?1 AND kind='transcript' AND url IS NOT NULL AND mime_type IS NOT NULL
    ORDER BY CASE WHEN language LIKE 'zh%' THEN 0 ELSE 1 END,CASE mime_type WHEN 'text/vtt' THEN 0 WHEN 'application/x-subrip' THEN 1 WHEN 'application/json' THEN 2 ELSE 3 END,ordinal").map_err(|e|e.to_string())?;
    let result = statement
      .query_map([episode], |r| {
        Ok(Resource {
          id: r.get(0)?,
          url: r.get(1)?,
          mime: r.get::<_, String>(2)?.to_ascii_lowercase(),
          language: r.get(3)?,
          etag: r.get(4)?,
          modified: r.get(5)?,
          fetched: r.get(6)?,
        })
      })
      .map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>()
      .map_err(|e| e.to_string())?;
    result
  };
  let mut error = "这集没有可用转写".to_string();
  for resource in resources {
    let previous = cached(path, &resource, episode, false)?;
    if resource
      .fetched
      .is_some_and(|time| time <= unix_time_millis() && unix_time_millis() - time < 86_400_000)
    {
      if let Some(previous) = previous {
        return Ok(previous);
      }
    }
    match with_network_retries(PODCAST_CHAPTER_TIMEOUT, || {
      with_network_limit(
        NetworkClass::Metadata,
        refresh(path, &resource, episode, allow_private),
      )
    })
    .await
    {
      Ok(document) => return Ok(document),
      Err(reason) => {
        let _ = open_database(path)?.execute(
          "UPDATE podcast_episode_resources SET error_message=?2 WHERE id=?1",
          params![resource.id, truncate_chars(&reason, 500)],
        );
        if let Some(mut previous) = previous {
          previous.stale = true;
          return Ok(previous);
        }
        error = reason;
      }
    }
  }
  Err(error)
}

#[tauri::command]
pub async fn podcast_get_transcript(
  state: State<'_, PodcastState>,
  episode_id: String,
  request_id: Option<String>,
  variant: Option<String>,
) -> Result<TranscriptDocument, String> {
  state.ensure_ready()?;
  run_network_task(request_id.as_deref(), async {
    match variant.as_deref().unwrap_or("source") {
      "source" => get_transcript(&state.db_path, &episode_id, false).await.or_else(|error| super::cloud_transcript::cached_generated(&state.db_path,&episode_id,"generated")?.ok_or(error)),
      origin @ ("generated"|"translated") => super::cloud_transcript::cached_generated(&state.db_path,&episode_id,origin)?.ok_or_else(||"没有这类已生成转写".into()),
      _ => Err("转写类型无效".into())
    }
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  use tokio::io::{AsyncReadExt, AsyncWriteExt};
  #[tokio::test]
  async fn transcript_cache_is_conditional_and_survives_offline_without_advancing_freshness() {
    let dir = test_directory("transcript-cache");
    let state = PodcastState::initialize_at(&dir).unwrap();
    let parsed = parse_test_feed(
      r#"<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>转写节目</title><description>转写缓存</description><item><guid>transcript-one</guid><title>单集</title><enclosure url="https://example.com/a.mp3" type="audio/mpeg"/><podcast:transcript url="https://example.com/transcript.vtt" type="text/vtt" language="zh-CN"/></item></channel></rss>"#,
      "transcript-cache",
    );
    let episode = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
      "http://localhost:{}/transcript.vtt",
      listener.local_addr().unwrap().port()
    );
    open_database(&state.db_path)
      .unwrap()
      .execute(
        "UPDATE podcast_episode_resources SET url=?1 WHERE episode_id=?2",
        params![url, episode],
      )
      .unwrap();
    let server = tokio::spawn(async move {
      for index in 0..2 {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 8192];
        let length = stream.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..length]).to_ascii_lowercase();
        if index == 0 {
          let body = "WEBVTT\n\n00:00.000 --> 00:10.000\n缓存中文转写\n";
          stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/vtt\r\nETag: \"v1\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        } else {
          assert!(request.contains("if-none-match: \"v1\""));
          stream
            .write_all(
              b"HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        }
        stream.shutdown().await.unwrap();
      }
    });
    let first = get_transcript(&state.db_path, &episode, true)
      .await
      .unwrap();
    assert_eq!(first.cues[0].text, "缓存中文转写");
    assert!(!first.stale);
    assert_eq!(
      get_transcript(&state.db_path, &episode, true)
        .await
        .unwrap()
        .cues
        .len(),
      1
    );
    open_database(&state.db_path)
      .unwrap()
      .execute(
        "UPDATE podcast_episode_resources SET fetched_at=0 WHERE episode_id=?1",
        [&episode],
      )
      .unwrap();
    assert!(
      !get_transcript(&state.db_path, &episode, true)
        .await
        .unwrap()
        .stale
    );
    server.await.unwrap();
    open_database(&state.db_path)
      .unwrap()
      .execute(
        "UPDATE podcast_episode_resources SET fetched_at=0 WHERE episode_id=?1",
        [&episode],
      )
      .unwrap();
    assert!(
      get_transcript(&state.db_path, &episode, true)
        .await
        .unwrap()
        .stale
    );
    let fetched: i64 = open_database(&state.db_path)
      .unwrap()
      .query_row(
        "SELECT fetched_at FROM podcast_episode_resources WHERE episode_id=?1",
        [episode],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(fetched, 0);
  }
  #[tokio::test]
  async fn links_reject_private_dns_targets_and_non_web_schemes() {
    assert!(validate_public_link_target("https://localhost/")
      .await
      .is_err());
    assert!(validate_public_link_target("file:///secret").await.is_err());
  }
  #[test]
  fn transcript_formats_validate_timing_and_preserve_chinese_text() {
    let cues = parse_transcript(
      b"WEBVTT\n\n00:00.500 --> 00:02.000\n<v Alice>Hello\n\n00:02.000 --> 00:04.000\nWorld\n",
      "text/vtt",
    )
    .unwrap();
    assert_eq!(cues[0].start_seconds, Some(0.5));
    assert_eq!(cues[0].text, "Hello");
    assert_eq!(
      parse_transcript(
        "1\n00:00:00,000 --> 00:00:02,000\n中文转写\n".as_bytes(),
        "application/x-subrip"
      )
      .unwrap()[0]
        .text,
      "中文转写"
    );
    assert_eq!(
      parse_transcript(
        br#"{"segments":[{"startTime":2.5,"endTime":3,"speaker":"A","body":"hello"}]}"#,
        "application/json"
      )
      .unwrap()[0]
        .speaker
        .as_deref(),
      Some("A")
    );
    for value in [
      "WEBVTT\n\n00:61.000 --> 01:00.000\ninvalid",
      "WEBVTT\n\n00:02.000 --> 00:01.000\ninvalid",
    ] {
      assert!(parse_transcript(value.as_bytes(), "text/vtt").is_err());
    }
    assert!(parse_transcript(
      br#"{"segments":[{"startTime":-1,"body":"invalid"}]}"#,
      "application/json"
    )
    .is_err());
    assert!(parse_transcript(&vec![b'x'; RESPONSE_LIMIT + 1], "text/plain").is_err());
  }
}
