use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use feed_rs::model::{Entry as ParsedEntry, Feed as ParsedFeed};
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::{Namespace, ResolveResult};
use quick_xml::reader::NsReader;
use quick_xml::Reader;
use reqwest::header::{self, HeaderMap, HeaderValue};
use reqwest::{StatusCode, Url};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use super::*;

#[derive(Clone, Debug)]
pub(crate) struct ParsedPodcast {
  pub(crate) feed: PodcastFeed,
  pub(crate) episodes: Vec<ParsedPodcastEpisode>,
  pub(crate) etag: Option<String>,
  pub(crate) last_modified: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ParsedPodcastEpisode {
  pub(crate) id: String,
  pub(crate) feed_id: String,
  pub(crate) identity_key: String,
  pub(crate) guid: Option<String>,
  pub(crate) title: String,
  pub(crate) description: Option<String>,
  pub(crate) published_at: Option<i64>,
  pub(crate) duration_seconds: Option<f64>,
  pub(crate) enclosure_url: String,
  pub(crate) enclosure_type: Option<String>,
  pub(crate) artwork_url: Option<String>,
  pub(crate) expected_bytes: Option<u64>,
  pub(crate) webpage_url: Option<String>,
  pub(crate) resources: Option<Vec<ParsedEpisodeResource>>,
}

#[derive(Clone, Debug)]
pub(crate) struct ParsedEpisodeResource {
  pub(crate) kind: &'static str,
  pub(crate) source_kind: &'static str,
  pub(crate) url: Option<String>,
  pub(crate) mime_type: Option<String>,
  pub(crate) language: Option<String>,
  pub(crate) relation: Option<String>,
  pub(crate) ordinal: usize,
  pub(crate) chapters: Vec<ParsedPodcastChapter>,
}

#[derive(Clone, Debug)]
pub(crate) struct ParsedPodcastChapter {
  pub(crate) start_ms: i64,
  pub(crate) end_ms: Option<i64>,
  pub(crate) title: String,
  pub(crate) href: Option<String>,
  pub(crate) image_url: Option<String>,
  pub(crate) visible: bool,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ParsedEpisodeExtensions {
  pub(crate) resources: Vec<ParsedEpisodeResource>,
  // Some(None) means an explicit but invalid duration: do not fall back to
  // feed-rs's permissive NPT parser (which treats MM:SS as seconds).
  pub(crate) duration_seconds: Option<Option<f64>>,
}
#[derive(Clone, Debug)]
pub(crate) struct PodcastRefreshTarget {
  pub(crate) id: String,
  pub(crate) feed_url: String,
  pub(crate) title: String,
  pub(crate) author: Option<String>,
  pub(crate) artwork_url: Option<String>,
  pub(crate) etag: Option<String>,
  pub(crate) last_modified: Option<String>,
}

#[derive(Debug)]
pub(crate) enum PodcastRefreshOutcome {
  Skipped,
  NotModified,
  Updated {
    inserted: usize,
    updated: usize,
  },
  Failed(PodcastRefreshFailure),
}
pub(crate) async fn fetch_and_parse_feed(
  feed_url: &str,
  title_hint: Option<&str>,
  author_hint: Option<&str>,
  artwork_hint: Option<&str>,
) -> Result<ParsedPodcast, String> {
  with_network_retries(Duration::from_secs(30), || with_network_limit(NetworkClass::Metadata, fetch_and_parse_feed_once(feed_url, title_hint, author_hint, artwork_hint))).await
}

async fn fetch_and_parse_feed_once(feed_url: &str, title_hint: Option<&str>, author_hint: Option<&str>, artwork_hint: Option<&str>) -> Result<ParsedPodcast, String> {
  let url = validate_public_url_shape(feed_url)?;
  let public_response = send_public_get(url, Duration::from_secs(30), None).await?;
  if !public_response.response.status().is_success() {
    return Err(format!(
      "播客订阅源返回错误 {}",
      public_response.response.status().as_u16()
    ));
  }
  let etag = header_text(public_response.response.headers(), header::ETAG);
  let last_modified = header_text(public_response.response.headers(), header::LAST_MODIFIED);
  let bytes = read_limited(public_response.response, PODCAST_FEED_RESPONSE_LIMIT, "播客订阅源").await?;
  parse_feed_bytes(
    &bytes,
    public_response.final_url.as_str(),
    title_hint,
    author_hint,
    artwork_hint,
    etag,
    last_modified,
  )
}

pub(crate) async fn refresh_feed_target(
  db_path: PathBuf,
  active_refreshes: Arc<Mutex<HashSet<String>>>,
  refresh_semaphore: Arc<tokio::sync::Semaphore>,
  target: PodcastRefreshTarget,
  allow_private_network: bool,
) -> PodcastRefreshOutcome {
  let _refresh_guard = match FeedRefreshGuard::acquire(&active_refreshes, &target.id) {
    Ok(Some(guard)) => guard,
    Ok(None) => return PodcastRefreshOutcome::Skipped,
    Err(message) => {
      return PodcastRefreshOutcome::Failed(PodcastRefreshFailure {
        feed_id: target.id,
        title: target.title,
        message,
      })
    }
  };
  let _refresh_permit = match refresh_semaphore.acquire_owned().await {
    Ok(permit) => permit,
    Err(_) => {
      return PodcastRefreshOutcome::Failed(PodcastRefreshFailure {
        feed_id: target.id,
        title: target.title,
        message: "播客刷新调度已停止".to_string(),
      })
    }
  };
  let checked_at = unix_time_millis();
  let result = with_network_retries(Duration::from_secs(30), || with_network_limit(NetworkClass::Metadata, async {
    let url = validate_url_shape_with_policy(&target.feed_url, allow_private_network)?;
    let mut request_headers = HeaderMap::new();
    if let Some(value) = target.etag.as_deref().and_then(|value| HeaderValue::from_str(value).ok()) {
      request_headers.insert(header::IF_NONE_MATCH, value);
    }
    if let Some(value) = target
      .last_modified
      .as_deref()
      .and_then(|value| HeaderValue::from_str(value).ok())
    {
      request_headers.insert(header::IF_MODIFIED_SINCE, value);
    }
    let public_response = send_public_get_with_headers(
      url,
      Duration::from_secs(30),
      None,
      allow_private_network,
      &request_headers,
    )
    .await?;
    let response_etag = header_text(public_response.response.headers(), header::ETAG);
    let response_last_modified =
      header_text(public_response.response.headers(), header::LAST_MODIFIED);
    if public_response.response.status() == StatusCode::NOT_MODIFIED {
      let db_path = db_path.clone();
      let feed_id = target.id.clone();
      tauri::async_runtime::spawn_blocking(move || {
        mark_refresh_not_modified(
          &db_path,
          &feed_id,
          checked_at,
          response_etag,
          response_last_modified,
        )
      })
      .await
      .map_err(|error| format!("播客数据任务异常结束：{error}"))??;
      return Ok(PodcastRefreshOutcome::NotModified);
    }
    if !public_response.response.status().is_success() {
      return Err(format!(
        "播客订阅源返回错误 {}",
        public_response.response.status().as_u16()
      ));
    }
    let bytes = read_limited(
      public_response.response,
      PODCAST_FEED_RESPONSE_LIMIT,
      "播客订阅源",
    )
    .await?;
    let mut parsed = parse_feed_bytes_with_network_policy(
      &bytes,
      public_response.final_url.as_str(),
      Some(&target.title),
      target.author.as_deref(),
      target.artwork_url.as_deref(),
      response_etag,
      response_last_modified,
      allow_private_network,
    )?;
    retain_refresh_identifiers(&mut parsed, &target.id);
    parsed.feed.last_checked_at = Some(checked_at);
    let db_path = db_path.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || store_preview(&db_path, parsed))
      .await
      .map_err(|error| format!("播客数据任务异常结束：{error}"))??;
    Ok(PodcastRefreshOutcome::Updated {
      inserted: stored.inserted_count,
      updated: stored.updated_count,
    })
  })).await;

  match result {
    Ok(outcome) => outcome,
    Err(message) => {
      let stored_message = truncate_chars(&message, 2_000);
      let error_db_path = db_path.clone();
      let error_feed_id = target.id.clone();
      let stored_message_for_db = stored_message.clone();
      let database_error = tauri::async_runtime::spawn_blocking(move || {
        mark_refresh_failed(
          &error_db_path,
          &error_feed_id,
          checked_at,
          &stored_message_for_db,
        )
      })
      .await
      .map_err(|error| format!("播客数据任务异常结束：{error}"))
      .and_then(|result| result);
      let message = match database_error {
        Ok(()) => stored_message,
        Err(database_error) => format!("{stored_message}；{database_error}"),
      };
      PodcastRefreshOutcome::Failed(PodcastRefreshFailure {
        feed_id: target.id,
        title: target.title,
        message,
      })
    }
  }
}

pub(crate) fn retain_refresh_identifiers(parsed: &mut ParsedPodcast, feed_id: &str) {
  parsed.feed.id = feed_id.to_string();
  remap_episode_identifiers(&mut parsed.episodes, feed_id);
}

pub(crate) fn remap_episode_identifiers(episodes: &mut [ParsedPodcastEpisode], feed_id: &str) {
  for episode in episodes {
    episode.feed_id = feed_id.to_string();
    episode.id = hash_identifier("episode", &[feed_id, &episode.identity_key]);
  }
}

pub(crate) fn parse_feed_bytes(
  bytes: &[u8],
  final_url: &str,
  title_hint: Option<&str>,
  author_hint: Option<&str>,
  artwork_hint: Option<&str>,
  etag: Option<String>,
  last_modified: Option<String>,
) -> Result<ParsedPodcast, String> {
  parse_feed_bytes_with_network_policy(
    bytes,
    final_url,
    title_hint,
    author_hint,
    artwork_hint,
    etag,
    last_modified,
    false,
  )
}

fn parse_feed_bytes_with_network_policy(
  bytes: &[u8],
  final_url: &str,
  title_hint: Option<&str>,
  author_hint: Option<&str>,
  artwork_hint: Option<&str>,
  etag: Option<String>,
  last_modified: Option<String>,
  allow_private_network: bool,
) -> Result<ParsedPodcast, String> {
  if bytes.len() > PODCAST_FEED_RESPONSE_LIMIT {
    return Err("播客订阅源超过大小限制".to_string());
  }
  let mut repaired_document = None;
  let parsed = match podcast_feed_parser(final_url).parse(bytes) {
    Ok(parsed) => parsed,
    Err(original_error) => {
      let Some(repaired) = repair_feed_bytes(bytes) else {
        return Err(format!("无法解析播客订阅源：{original_error}"));
      };
      let parsed = podcast_feed_parser(final_url)
        .parse(repaired.as_slice())
        .map_err(|_| format!("无法解析播客订阅源：{original_error}"))?;
      repaired_document = Some(repaired);
      parsed
    }
  };
  let normalized_document = repaired_document.as_deref().unwrap_or(bytes);
  let rss_enclosures = extract_rss_enclosures(normalized_document, final_url);
  let episode_extensions = extract_episode_extensions(normalized_document, final_url);
  normalize_feed(
    parsed,
    final_url,
    title_hint,
    author_hint,
    artwork_hint,
    etag,
    last_modified,
    &rss_enclosures,
    episode_extensions.as_deref(),
    allow_private_network,
  )
}

fn podcast_feed_parser(base_uri: &str) -> feed_rs::parser::Parser {
  feed_rs::parser::Builder::new()
    .base_uri(Some(base_uri))
    .id_generator(|links, title, uri| {
      let link = links.first().map(|value| value.href.as_str()).unwrap_or("");
      let title = title.as_ref().map(|value| value.content.as_str()).unwrap_or("");
      let uri = uri.unwrap_or("");
      format!(
        "{PODCAST_SYNTHETIC_ID_PREFIX}{}",
        hash_identifier("feed-generated-id", &[uri, link, title])
      )
    })
    .build()
}

fn repair_feed_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
  let encoding = detect_feed_encoding(bytes);
  let (decoded, _, _) = encoding.decode(bytes);
  let decoded = decoded.trim_start_matches(|character: char| {
    character == '\u{feff}' || character == '\0' || character.is_ascii_whitespace()
  });
  let mut text = decoded
    .chars()
    .filter(|character| is_allowed_xml_character(*character))
    .collect::<String>();
  rewrite_xml_encoding_as_utf8(&mut text);
  Some(repair_entities_outside_cdata(&text)?.into_bytes())
}

fn detect_feed_encoding(bytes: &[u8]) -> &'static Encoding {
  if let Some((encoding, _)) = Encoding::for_bom(bytes) {
    return encoding;
  }
  let head = &bytes[..bytes.len().min(512)];
  let little_endian_marker = find_bytes(head, b"<\0?\0x\0m\0l\0");
  let big_endian_marker = find_bytes(head, b"\0<\0?\0x\0m\0l");
  match (little_endian_marker, big_endian_marker) {
    (Some(little), Some(big)) => return if little < big { UTF_16LE } else { UTF_16BE },
    (Some(_), None) => return UTF_16LE,
    (None, Some(_)) => return UTF_16BE,
    (None, None) => {}
  }
  declared_xml_encoding(head).unwrap_or(UTF_8)
}

fn declared_xml_encoding(head: &[u8]) -> Option<&'static Encoding> {
  let lowered = head.iter().map(u8::to_ascii_lowercase).collect::<Vec<_>>();
  let declaration_start = find_bytes(&lowered, b"<?xml")?;
  let declaration_end = find_bytes(&lowered[declaration_start..], b"?>")? + declaration_start;
  let encoding_start = find_bytes(&lowered[declaration_start..declaration_end], b"encoding")?
    + declaration_start
    + b"encoding".len();
  let mut cursor = encoding_start;
  while lowered.get(cursor).is_some_and(u8::is_ascii_whitespace) {
    cursor += 1;
  }
  if lowered.get(cursor) != Some(&b'=') {
    return None;
  }
  cursor += 1;
  while lowered.get(cursor).is_some_and(u8::is_ascii_whitespace) {
    cursor += 1;
  }
  let quote = *lowered.get(cursor)?;
  if quote != b'"' && quote != b'\'' {
    return None;
  }
  cursor += 1;
  let end = lowered[cursor..declaration_end].iter().position(|byte| *byte == quote)? + cursor;
  Encoding::for_label(&lowered[cursor..end])
}

fn rewrite_xml_encoding_as_utf8(text: &mut String) {
  let Some(declaration_end) = text.find("?>") else {
    return;
  };
  let declaration = &text[..declaration_end];
  if !declaration.trim_start().starts_with("<?xml") {
    return;
  }
  let lowered = declaration.to_ascii_lowercase();
  let Some(name_start) = lowered.find("encoding") else {
    return;
  };
  let Some(equals_offset) = lowered[name_start + b"encoding".len()..].find('=') else {
    return;
  };
  let equals = name_start + b"encoding".len() + equals_offset;
  let Some(quote_offset) = lowered[equals + 1..].find(['"', '\'']) else {
    return;
  };
  let quote_start = equals + 1 + quote_offset;
  let quote = lowered.as_bytes()[quote_start];
  let Some(value_length) = lowered[quote_start + 1..].bytes().position(|byte| byte == quote) else {
    return;
  };
  let value_start = quote_start + 1;
  let value_end = value_start + value_length;
  text.replace_range(value_start..value_end, "UTF-8");
}

fn repair_entities_outside_cdata(text: &str) -> Option<String> {
  let mut output = String::with_capacity(text.len());
  let mut remainder = text;
  while let Some(cdata_start) = remainder.find("<![CDATA[") {
    append_repaired_xml_entities(&mut output, &remainder[..cdata_start])?;
    let cdata = &remainder[cdata_start..];
    let Some(cdata_end) = cdata.find("]]>") else {
      append_repair_fragment(&mut output, cdata)?;
      return Some(output);
    };
    let cdata_end = cdata_end + b"]]>".len();
    append_repair_fragment(&mut output, &cdata[..cdata_end])?;
    remainder = &cdata[cdata_end..];
  }
  append_repaired_xml_entities(&mut output, remainder)?;
  Some(output)
}

fn append_repaired_xml_entities(output: &mut String, text: &str) -> Option<()> {
  let bytes = text.as_bytes();
  let mut cursor = 0usize;
  while cursor < bytes.len() {
    if bytes[cursor] != b'&' {
      let character = text[cursor..].chars().next().expect("valid UTF-8 character");
      if output.len().saturating_add(character.len_utf8()) > PODCAST_FEED_RESPONSE_LIMIT {
        return None;
      }
      output.push(character);
      cursor += character.len_utf8();
      continue;
    }

    let entity_end = bytes[cursor + 1..bytes.len().min(cursor + 35)]
      .iter()
      .position(|byte| *byte == b';')
      .map(|offset| cursor + 1 + offset);
    let Some(entity_end) = entity_end else {
      append_repair_fragment(output, "&amp;")?;
      cursor += 1;
      continue;
    };
    let entity = &text[cursor + 1..entity_end];
    if is_valid_xml_entity(entity) {
      append_repair_fragment(output, &text[cursor..=entity_end])?;
      cursor = entity_end + 1;
      continue;
    }
    if is_named_entity(entity) {
      if let Some(replacement) = html_entity_numeric_reference(entity) {
        append_repair_fragment(output, replacement)?;
      } else {
        append_repair_fragment(output, "&amp;")?;
        append_repair_fragment(output, entity)?;
        append_repair_fragment(output, ";")?;
      }
      cursor = entity_end + 1;
      continue;
    }
    append_repair_fragment(output, "&amp;")?;
    cursor += 1;
  }
  Some(())
}

fn append_repair_fragment(output: &mut String, value: &str) -> Option<()> {
  if output.len().saturating_add(value.len()) > PODCAST_FEED_RESPONSE_LIMIT {
    return None;
  }
  output.push_str(value);
  Some(())
}

fn is_valid_xml_entity(entity: &str) -> bool {
  matches!(entity, "amp" | "lt" | "gt" | "quot" | "apos")
    || entity
      .strip_prefix('#')
      .is_some_and(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
    || entity
      .strip_prefix("#x")
      .or_else(|| entity.strip_prefix("#X"))
      .is_some_and(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn is_named_entity(entity: &str) -> bool {
  entity.len() <= 32
    && entity.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
    && entity.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn html_entity_numeric_reference(entity: &str) -> Option<&'static str> {
  match entity {
    "nbsp" => Some("&#160;"),
    "copy" => Some("&#169;"),
    "reg" => Some("&#174;"),
    "middot" => Some("&#183;"),
    "ndash" => Some("&#8211;"),
    "mdash" => Some("&#8212;"),
    "lsquo" => Some("&#8216;"),
    "rsquo" => Some("&#8217;"),
    "ldquo" => Some("&#8220;"),
    "rdquo" => Some("&#8221;"),
    "bull" => Some("&#8226;"),
    "hellip" => Some("&#8230;"),
    "trade" => Some("&#8482;"),
    _ => None,
  }
}

fn is_allowed_xml_character(character: char) -> bool {
  matches!(character, '\t' | '\n' | '\r')
    || (character >= '\u{20}' && character != '\u{fffe}' && character != '\u{ffff}')
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
  (!needle.is_empty() && needle.len() <= haystack.len())
    .then(|| haystack.windows(needle.len()).position(|window| window == needle))
    .flatten()
}

fn extract_rss_enclosures(bytes: &[u8], base_uri: &str) -> Vec<Option<Enclosure>> {
  let mut reader = Reader::from_reader(bytes);
  let mut enclosures = Vec::new();
  let mut current_entry = None;
  let mut base_stack = vec![Url::parse(base_uri).ok()];
  loop {
    match reader.read_event() {
      Ok(Event::Start(element)) => {
        let name = element.name();
        let base_url = element_base_url(&element, reader.decoder(), base_stack.last().and_then(Option::as_ref));
        base_stack.push(base_url);
        if is_feed_entry_element(name.as_ref()) {
          enclosures.push(None);
          current_entry = Some(enclosures.len() - 1);
        } else if is_rss_enclosure_element(name.as_ref()) {
          if let Some(index) = current_entry {
            if enclosures[index].is_none() {
              enclosures[index] =
                enclosure_from_xml(&element, reader.decoder(), base_stack.last().and_then(Option::as_ref));
            }
          }
        }
      }
      Ok(Event::Empty(element)) => {
        let name = element.name();
        let base_url = element_base_url(&element, reader.decoder(), base_stack.last().and_then(Option::as_ref));
        if is_feed_entry_element(name.as_ref()) {
          enclosures.push(None);
        } else if is_rss_enclosure_element(name.as_ref()) {
          if let Some(index) = current_entry {
            if enclosures[index].is_none() {
              enclosures[index] = enclosure_from_xml(&element, reader.decoder(), base_url.as_ref());
            }
          }
        }
      }
      Ok(Event::End(element)) => {
        let name = element.name();
        if is_feed_entry_element(name.as_ref()) {
          current_entry = None;
        }
        if base_stack.len() > 1 {
          base_stack.pop();
        }
      }
      Ok(Event::Eof) => break,
      Err(_) => return Vec::new(),
      _ => {}
    }
  }
  enclosures
}

fn extract_episode_extensions(
  bytes: &[u8],
  base_uri: &str,
) -> Option<Vec<ParsedEpisodeExtensions>> {
  let mut reader = NsReader::from_reader(bytes);
  let mut extensions = Vec::<ParsedEpisodeExtensions>::new();
  let mut current_entry = None;
  let mut psc_entry = None;
  let mut base_stack = vec![Url::parse(base_uri).ok()];
  loop {
    let decoder = reader.decoder();
    let (namespace, event) = reader.read_resolved_event().ok()?;
    let namespace_uri = match &namespace {
      ResolveResult::Bound(Namespace(value)) => Some((*value).to_vec()),
      _ => None,
    };
    drop(namespace);
    match event {
      Event::Start(element) => {
        let local_name = element.local_name();
        let base_url = element_base_url(
          &element,
          decoder,
          base_stack.last().and_then(Option::as_ref),
        );
        base_stack.push(base_url);
        if is_feed_entry_element(local_name.as_ref()) {
          extensions.push(ParsedEpisodeExtensions::default());
          current_entry = Some(extensions.len() - 1);
          psc_entry = None;
          continue;
        }
        let Some(entry_index) = current_entry else {
          continue;
        };
        if namespace_is(namespace_uri.as_deref(), b"http://www.itunes.com/dtds/podcast-1.0.dtd")
          && local_name.as_ref() == b"duration"
        {
          let text = reader.read_text(element.name()).ok()?;
          let text = text.decode().ok()?;
          extensions[entry_index].duration_seconds = Some(
            parse_podcast_duration_xml(&text),
          );
          base_stack.pop(); // read_text consumed the matching End event.
          continue;
        }
        collect_episode_extension_element(
          namespace_uri.as_deref(),
          &element,
          decoder,
          base_stack.last().and_then(Option::as_ref),
          entry_index,
          &mut psc_entry,
          &mut extensions,
        );
      }
      Event::Empty(element) => {
        let local_name = element.local_name();
        let base_url = element_base_url(
          &element,
          decoder,
          base_stack.last().and_then(Option::as_ref),
        );
        if is_feed_entry_element(local_name.as_ref()) {
          extensions.push(ParsedEpisodeExtensions::default());
          continue;
        }
        let Some(entry_index) = current_entry else {
          continue;
        };
        collect_episode_extension_element(
          namespace_uri.as_deref(),
          &element,
          decoder,
          base_url.as_ref(),
          entry_index,
          &mut psc_entry,
          &mut extensions,
        );
        if namespace_is(
          namespace_uri.as_deref(),
          PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI,
        ) && local_name.as_ref() == b"chapters"
        {
          psc_entry = None;
        }
      }
      Event::End(element) => {
        let local_name = element.local_name();
        if namespace_is(namespace_uri.as_deref(), PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI)
          && local_name.as_ref() == b"chapters"
        {
          psc_entry = None;
        }
        if is_feed_entry_element(local_name.as_ref()) {
          current_entry = None;
          psc_entry = None;
        }
        if base_stack.len() > 1 {
          base_stack.pop();
        }
      }
      Event::Eof => break,
      _ => {}
    }
  }
  for entry in &mut extensions {
    normalize_parsed_episode_resources(&mut entry.resources);
  }
  Some(extensions)
}

fn collect_episode_extension_element(
  namespace: Option<&[u8]>,
  element: &BytesStart<'_>,
  decoder: quick_xml::Decoder,
  base_url: Option<&Url>,
  entry_index: usize,
  psc_entry: &mut Option<usize>,
  extensions: &mut [ParsedEpisodeExtensions],
) {
  let local_name = element.local_name();
  if namespace_is_podcast(namespace) && local_name.as_ref() == b"chapters" {
    if extensions[entry_index]
      .resources
      .iter()
      .any(|resource| resource.source_kind == "podcast-json")
    {
      return;
    }
    let url = xml_attribute(element, decoder, b"url")
      .and_then(|value| resolve_resource_url(&value, base_url, true));
    let mime_type = xml_attribute(element, decoder, b"type")
      .and_then(|value| clean_text(&value, 200));
    if let (Some(url), Some(mime_type)) = (url, mime_type) {
      if is_json_chapter_mime_type(&mime_type) {
        extensions[entry_index].resources.push(ParsedEpisodeResource {
          kind: "chapters",
          source_kind: "podcast-json",
          url: Some(url),
          mime_type: Some(mime_type),
          language: None,
          relation: None,
          ordinal: 0,
          chapters: Vec::new(),
        });
      }
    }
    return;
  }
  if namespace_is_podcast(namespace) && local_name.as_ref() == b"transcript" {
    let transcript_count = extensions[entry_index]
      .resources
      .iter()
      .filter(|resource| resource.kind == "transcript")
      .count();
    if transcript_count >= PODCAST_TRANSCRIPT_SOURCE_MAX_COUNT {
      return;
    }
    let url = xml_attribute(element, decoder, b"url")
      .and_then(|value| resolve_resource_url(&value, base_url, true));
    let mime_type = xml_attribute(element, decoder, b"type")
      .and_then(|value| clean_text(&value, 200));
    if let (Some(url), Some(mime_type)) = (url, mime_type) {
      extensions[entry_index].resources.push(ParsedEpisodeResource {
        kind: "transcript",
        source_kind: "podcast-transcript",
        url: Some(url),
        mime_type: Some(mime_type),
        language: xml_attribute(element, decoder, b"language")
          .and_then(|value| clean_text(&value, 50)),
        relation: xml_attribute(element, decoder, b"rel")
          .and_then(|value| clean_text(&value, 100)),
        ordinal: transcript_count,
        chapters: Vec::new(),
      });
    }
    return;
  }
  if namespace_is(namespace, PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI)
    && local_name.as_ref() == b"chapters"
  {
    if extensions[entry_index]
      .resources
      .iter()
      .any(|resource| resource.source_kind == "psc")
    {
      return;
    }
    extensions[entry_index].resources.push(ParsedEpisodeResource {
      kind: "chapters",
      source_kind: "psc",
      url: None,
      mime_type: Some("application/xml".to_string()),
      language: None,
      relation: None,
      ordinal: 1,
      chapters: Vec::new(),
    });
    *psc_entry = Some(entry_index);
    return;
  }
  if namespace_is(namespace, PODLOVE_SIMPLE_CHAPTERS_NAMESPACE_URI)
    && local_name.as_ref() == b"chapter"
    && *psc_entry == Some(entry_index)
  {
    let Some(resource) = extensions[entry_index]
      .resources
      .iter_mut()
      .find(|resource| resource.source_kind == "psc")
    else {
      return;
    };
    if resource.chapters.len() >= PODCAST_CHAPTER_MAX_COUNT {
      return;
    }
    let start_ms = xml_attribute(element, decoder, b"start")
      .and_then(|value| parse_psc_time_ms(&value));
    let title = xml_attribute(element, decoder, b"title")
      .and_then(|value| clean_text(&value, PODCAST_TITLE_LIMIT));
    if let (Some(start_ms), Some(title)) = (start_ms, title) {
      resource.chapters.push(ParsedPodcastChapter {
        start_ms,
        end_ms: None,
        title,
        href: xml_attribute(element, decoder, b"href")
          .and_then(|value| resolve_resource_url(&value, base_url, false)),
        image_url: xml_attribute(element, decoder, b"image")
          .and_then(|value| resolve_resource_url(&value, base_url, false)),
        visible: true,
      });
    }
  }
}

fn namespace_is(namespace: Option<&[u8]>, expected: &[u8]) -> bool {
  namespace == Some(expected)
}

fn namespace_is_podcast(namespace: Option<&[u8]>) -> bool {
  namespace_is(namespace, PODCAST_NAMESPACE_URI)
    || namespace_is(namespace, PODCAST_NAMESPACE_COMPAT_URI)
}

fn xml_attribute(
  element: &BytesStart<'_>,
  decoder: quick_xml::Decoder,
  local_name: &[u8],
) -> Option<String> {
  element
    .attributes()
    .with_checks(false)
    .filter_map(Result::ok)
    .find(|attribute| attribute.key.local_name().as_ref() == local_name)
    .and_then(|attribute| {
      attribute
        .decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder)
        .ok()
        .map(|value| value.into_owned())
    })
}

pub(crate) fn resolve_resource_url(
  value: &str,
  base_url: Option<&Url>,
  require_https: bool,
) -> Option<String> {
  let url = Url::parse(value.trim())
    .ok()
    .or_else(|| base_url.and_then(|base_url| base_url.join(value.trim()).ok()))?;
  if require_https && url.scheme() != "https" {
    return None;
  }
  validate_url_with_policy(&url, false).ok()?;
  clean_url_string(url.as_str())
}

pub(crate) fn is_json_chapter_mime_type(value: &str) -> bool {
  matches!(
    value
      .split(';')
      .next()
      .unwrap_or_default()
      .trim()
      .to_ascii_lowercase()
      .as_str(),
    "application/json+chapters" | "application/json"
  )
}

fn parse_psc_time_ms(value: &str) -> Option<i64> {
  let parts = value.trim().split(':').collect::<Vec<_>>();
  if parts.is_empty() || parts.len() > 3 {
    return None;
  }
  let seconds = parts.last()?.parse::<f64>().ok()?;
  if !seconds.is_finite() || seconds < 0.0 || (parts.len() > 1 && seconds >= 60.0) {
    return None;
  }
  let mut total_seconds = seconds;
  if parts.len() >= 2 {
    let minutes = parts[parts.len() - 2].parse::<u64>().ok()?;
    if parts.len() == 3 && minutes >= 60 {
      return None;
    }
    total_seconds += minutes as f64 * 60.0;
  }
  if parts.len() == 3 {
    let hours = parts[0].parse::<u64>().ok()?;
    total_seconds += hours as f64 * 3_600.0;
  }
  let milliseconds = (total_seconds * 1_000.0).round();
  (milliseconds.is_finite() && milliseconds >= 0.0 && milliseconds <= i64::MAX as f64)
    .then_some(milliseconds as i64)
}

fn normalize_parsed_episode_resources(resources: &mut Vec<ParsedEpisodeResource>) {
  for resource in resources.iter_mut() {
    resource.chapters.sort_by_key(|chapter| chapter.start_ms);
    resource
      .chapters
      .dedup_by_key(|chapter| chapter.start_ms);
  }
  resources.retain(|resource| {
    resource.source_kind != "psc" || !resource.chapters.is_empty()
  });
  let mut seen = HashSet::new();
  resources.retain(|resource| {
    let key = format!(
      "{}\0{}\0{}\0{}\0{}",
      resource.kind,
      resource.source_kind,
      resource.url.as_deref().unwrap_or_default(),
      resource.mime_type.as_deref().unwrap_or_default(),
      resource.language.as_deref().unwrap_or_default(),
    );
    seen.insert(key)
  });
  for (ordinal, resource) in resources.iter_mut().enumerate() {
    resource.ordinal = ordinal;
  }
}

fn parse_podcast_duration_xml(value: &str) -> Option<f64> {
  let mut reader = Reader::from_str(value);
  let mut text = String::new();
  loop {
    match reader.read_event().ok()? {
      Event::Text(value) => text.push_str(&value.decode().ok()?),
      Event::CData(value) => text.push_str(&value.decode().ok()?),
      Event::GeneralRef(value) => text.push(value.resolve_char_ref().ok()??),
      Event::Comment(_) => {},
      Event::Eof => break,
      _ => return None,
    }
  }
  parse_podcast_duration(&text)
}

fn parse_podcast_duration(value: &str) -> Option<f64> {
  let parts = value.trim().split(':').collect::<Vec<_>>();
  if parts.is_empty() || parts.len() > 3 { return None; }
  let mut total = 0.0;
  for (index, part) in parts.iter().enumerate() {
    if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.') {
      return None;
    }
    let number = part.parse::<f64>().ok()?;
    let last = index + 1 == parts.len();
    if !number.is_finite() || (!last && part.contains('.')) || (index > 0 && number >= 60.0) {
      return None;
    }
    total = total * 60.0 + number;
  }
  (total.is_finite() && total > 0.0 && total <= i64::MAX as f64 / 1000.0).then_some(total)
}

fn is_feed_entry_element(name: &[u8]) -> bool {
  name == b"item" || name == b"entry"
}

fn is_rss_enclosure_element(name: &[u8]) -> bool {
  name == b"enclosure"
    || (name.ends_with(b":enclosure") && !name.eq_ignore_ascii_case(b"media:enclosure"))
}

fn element_base_url(
  element: &BytesStart<'_>,
  decoder: quick_xml::Decoder,
  inherited: Option<&Url>,
) -> Option<Url> {
  for attribute in element.attributes().with_checks(false) {
    let Ok(attribute) = attribute else {
      continue;
    };
    if attribute.key.as_ref() != b"xml:base" {
      continue;
    }
    let value = attribute
      .decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder)
      .ok()?;
    return Url::parse(&value)
      .ok()
      .or_else(|| inherited.and_then(|base_url| base_url.join(&value).ok()));
  }
  inherited.cloned()
}

fn enclosure_from_xml(
  element: &BytesStart<'_>,
  decoder: quick_xml::Decoder,
  base_url: Option<&Url>,
) -> Option<Enclosure> {
  let mut raw_url = None;
  let mut content_type = None;
  let mut length = None;
  for attribute in element.attributes().with_checks(false) {
    let Ok(attribute) = attribute else {
      continue;
    };
    let Ok(value) = attribute.decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder) else {
      continue;
    };
    match attribute.key.local_name().as_ref() {
      b"url" | b"resource" => raw_url = clean_text(&value, 4_096),
      b"type" => content_type = clean_text(&value, 200),
      b"length" => length = value.trim().parse::<u64>().ok(),
      _ => {}
    }
  }
  let raw_url = raw_url?;
  let resolved = Url::parse(&raw_url)
    .ok()
    .or_else(|| base_url.and_then(|base_url| base_url.join(&raw_url).ok()))?;
  let url = clean_url_string(resolved.as_str())?;
  if !is_possible_audio_enclosure(content_type.as_deref(), &url) {
    return None;
  }
  Some(Enclosure {
    url,
    content_type,
    length,
    duration_seconds: None,
  })
}
fn normalize_feed(
  parsed: ParsedFeed,
  final_url: &str,
  title_hint: Option<&str>,
  author_hint: Option<&str>,
  artwork_hint: Option<&str>,
  etag: Option<String>,
  last_modified: Option<String>,
  rss_enclosures: &[Option<Enclosure>],
  episode_extensions: Option<&[ParsedEpisodeExtensions]>,
  allow_private_network: bool,
) -> Result<ParsedPodcast, String> {
  let normalized_url = normalize_url(final_url, allow_private_network)?;
  let feed_id = hash_identifier("feed", &[&normalized_url]);
  let title = parsed
    .title
    .as_ref()
    .map(|value| plain_text(&value.content, PODCAST_TITLE_LIMIT))
    .filter(|value| !value.is_empty())
    .or_else(|| clean_hint(title_hint, PODCAST_TITLE_LIMIT))
    .unwrap_or_else(|| "未命名播客".to_string());
  let author = parsed
    .authors
    .first()
    .map(|person| plain_text(&person.name, PODCAST_TITLE_LIMIT))
    .filter(|value| !value.is_empty())
    .or_else(|| clean_hint(author_hint, PODCAST_TITLE_LIMIT))
    .or_else(|| {
      parsed.contributors.iter().find_map(|person| {
        let value = if matches!(person.name.as_str(), "managingEditor" | "webMaster") {
          person.email.as_deref().unwrap_or(&person.name)
        } else {
          &person.name
        };
        let value = plain_text(value, PODCAST_TITLE_LIMIT);
        (!value.is_empty()).then_some(value)
      })
    });
  let description = parsed
    .description
    .as_ref()
    .map(|value| plain_text(&value.content, PODCAST_DESCRIPTION_LIMIT))
    .filter(|value| !value.is_empty());
  let artwork_url = parsed
    .logo
    .as_ref()
    .map(|image| image.uri.clone())
    .or_else(|| parsed.icon.as_ref().map(|image| image.uri.clone()))
    .and_then(|value| clean_url_string(&value))
    .or_else(|| artwork_hint.and_then(clean_url_string));
  let fetched_at = unix_time_millis();
  let feed = PodcastFeed {
    id: feed_id.clone(),
    feed_url: normalized_url,
    title,
    author,
    description,
    artwork_url: artwork_url.clone(),
    last_fetched_at: fetched_at,
    subscribed: false,
    subscribed_at: None,
    last_checked_at: Some(fetched_at),
    last_refresh_error: None,
    latest_episode_at: None,
    unplayed_count: 0,
    latest_episode_title: None,
  };

  let mut episodes = Vec::new();
  for (index, entry) in parsed.entries.iter().enumerate() {
    if let Some(episode) = normalize_episode(
      entry,
      &feed_id,
      artwork_url.as_deref(),
      rss_enclosures.get(index).and_then(Option::as_ref),
      episode_extensions.and_then(|extensions| extensions.get(index)).and_then(|entry| entry.duration_seconds),
      episode_extensions
        .map(|extensions| {
          extensions
            .get(index)
            .map(|entry| entry.resources.clone())
            .unwrap_or_default()
        }),
    ) {
      episodes.push(episode);
    }
  }
  if episodes.is_empty() {
    return Err("订阅源中没有可播放的音频单集".to_string());
  }

  Ok(ParsedPodcast {
    feed,
    episodes,
    etag,
    last_modified,
  })
}

fn normalize_episode(
  entry: &ParsedEntry,
  feed_id: &str,
  feed_artwork: Option<&str>,
  rss_enclosure: Option<&Enclosure>,
  explicit_duration: Option<Option<f64>>,
  resources: Option<Vec<ParsedEpisodeResource>>,
) -> Option<ParsedPodcastEpisode> {
  let enclosure = rss_enclosure.cloned().or_else(|| find_enclosure(entry))?;
  let guid = clean_text(&entry.id, 4_096).filter(|value| !value.starts_with(PODCAST_SYNTHETIC_ID_PREFIX));
  let identity_key = if let Some(guid) = guid.as_deref() {
    format!("guid:{guid}")
  } else {
    format!("enclosure:{}", enclosure.url)
  };
  let id = hash_identifier("episode", &[feed_id, &identity_key]);
  let title = entry
    .title
    .as_ref()
    .map(|value| plain_text(&value.content, PODCAST_TITLE_LIMIT))
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "未命名单集".to_string());
  let description = entry
    .summary
    .as_ref()
    .map(|value| plain_text(&value.content, PODCAST_DESCRIPTION_LIMIT))
    .filter(|value| !value.is_empty())
    .or_else(|| {
      entry
        .content
        .as_ref()
        .and_then(|content| content.body.as_deref())
        .map(|value| plain_text(value, PODCAST_DESCRIPTION_LIMIT))
        .filter(|value| !value.is_empty())
    });
  let duration_seconds = explicit_duration.unwrap_or_else(|| entry
    .media
    .iter()
    .find_map(|media| media.duration.map(|duration| duration.as_secs_f64()))
    .or(enclosure.duration_seconds))
    .filter(|value| value.is_finite() && *value > 0.0);
  let artwork_url = entry
    .media
    .iter()
    .flat_map(|media| media.thumbnails.iter())
    .find_map(|thumbnail| clean_url_string(thumbnail.image.uri.as_str()))
    .or_else(|| feed_artwork.map(str::to_string));
  let webpage_url = entry.links.iter().find_map(|link| {
    if link.rel.as_deref() == Some("enclosure")
      || link
        .media_type
        .as_deref()
        .is_some_and(|content_type| content_type.to_ascii_lowercase().starts_with("audio/"))
    {
      return None;
    }
    clean_url_string(&link.href)
  });

  Some(ParsedPodcastEpisode {
    id,
    feed_id: feed_id.to_string(),
    identity_key,
    guid,
    title,
    description,
    published_at: entry
      .published
      .or(entry.updated)
      .map(|timestamp| timestamp.timestamp_millis()),
    duration_seconds,
    enclosure_url: enclosure.url,
    enclosure_type: enclosure.content_type,
    artwork_url,
    expected_bytes: enclosure.length,
    webpage_url,
    resources,
  })
}

#[derive(Clone)]
pub(crate) struct Enclosure {
  pub(crate) url: String,
  pub(crate) content_type: Option<String>,
  pub(crate) length: Option<u64>,
  pub(crate) duration_seconds: Option<f64>,
}

fn find_enclosure(entry: &ParsedEntry) -> Option<Enclosure> {
  if let Some(content) = entry.content.as_ref() {
    if let Some(source) = content.src.as_ref() {
      if let Some(url) = clean_url_string(&source.href) {
        let content_type = clean_text(content.content_type.as_str(), 200);
        if is_possible_audio_enclosure(content_type.as_deref(), &url) {
          return Some(Enclosure {
            url,
            content_type,
            length: content.length.or(source.length),
            duration_seconds: None,
          });
        }
      }
    }
  }

  for link in &entry.links {
    if link.rel.as_deref() != Some("enclosure") {
      continue;
    }
    let Some(url) = clean_url_string(&link.href) else {
      continue;
    };
    if is_possible_audio_enclosure(link.media_type.as_deref(), &url) {
      return Some(Enclosure {
        url,
        content_type: link.media_type.clone(),
        length: link.length,
        duration_seconds: None,
      });
    }
  }

  for media in &entry.media {
    for content in &media.content {
      let Some(url) = content.url.as_ref().map(Url::to_string) else {
        continue;
      };
      let content_type = content.content_type.as_ref().map(|value| value.as_str().to_string());
      if is_possible_audio_enclosure(content_type.as_deref(), &url) {
        return Some(Enclosure {
          url,
          content_type,
          length: content.size,
          duration_seconds: content
            .duration
            .or(media.duration)
            .map(|duration| duration.as_secs_f64()),
        });
      }
    }
  }
  None
}

fn is_possible_audio_enclosure(content_type: Option<&str>, url: &str) -> bool {
  if let Some(content_type) = content_type {
    let content_type = content_type.to_ascii_lowercase();
    if content_type.starts_with("video/")
      || content_type.starts_with("image/")
      || content_type.starts_with("text/")
      || content_type.contains("json")
      || content_type.contains("xml")
    {
      return false;
    }
    if content_type.starts_with("audio/")
      || content_type == "application/octet-stream"
      || content_type == "binary/octet-stream"
    {
      return true;
    }
  }
  let path = Url::parse(url)
    .ok()
    .map(|value| value.path().to_ascii_lowercase())
    .unwrap_or_default();
  [".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg"]
    .iter()
    .any(|extension| path.ends_with(extension))
    || content_type.is_none()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::podcast::test_support::*;
  use tokio::io::AsyncReadExt;
  use tokio::io::AsyncWriteExt;
  use tokio::net::TcpListener;
  use rusqlite::params;

  #[test]
  fn duration_formats_are_parsed_without_truncating_minutes() {
    for (value, expected) in [
      ("09:34", Some(574.0)), ("16:20", Some(980.0)),
      ("01:13:00", Some(4380.0)), ("574", Some(574.0)),
      (" 1:02.5 ", Some(62.5)), ("120:00", Some(7200.0)),
      ("0", None), ("1:60", None), ("1:60:00", None),
      ("-9", None), ("9 seconds", None), ("NaN", None), ("1::2", None),
    ] {
      assert_eq!(parse_podcast_duration(value), expected, "{value}");
    }
    for (value, expected) in [("09:34", Some(574.0)), ("16:20", Some(980.0)),
      ("<![CDATA[09:34]]>", Some(574.0)), ("0&#57;:34", Some(574.0)), ("1:60", None)] {
      let xml = format!(r#"<rss version="2.0" xmlns:pod="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>测试</title><link>https://example.test</link><description>测试</description><item><guid>one</guid><title>单集</title><enclosure url="https://example.test/a.mp3" type="audio/mpeg"/><pod:duration>{value}</pod:duration></item></channel></rss>"#);
      let parsed = parse_feed_bytes(xml.as_bytes(), "https://example.test/feed.xml", None, None, None, None, None).unwrap();
      assert_eq!(parsed.episodes[0].duration_seconds, expected, "RSS {value}");
    }
  }

  #[test]
  fn rss_feed_is_normalized_to_stable_feed_and_episode_records() {
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    assert_eq!(parsed.feed.title, "Zone 测试播客");
    assert_eq!(parsed.feed.author.as_deref(), Some("Zone 主播"));
    assert_eq!(parsed.feed.description.as_deref(), Some("一档 本地优先 的节目。"));
    assert_eq!(parsed.feed.id.len(), 64);
    assert_eq!(parsed.episodes.len(), 1);
    let episode = &parsed.episodes[0];
    assert_eq!(episode.title, "第一集");
    assert_eq!(episode.description.as_deref(), Some("第一集的 简介"));
    assert_eq!(episode.duration_seconds, Some(3_723.0));
    assert_eq!(episode.enclosure_type.as_deref(), Some("audio/mpeg"));
    assert_eq!(episode.expected_bytes, Some(23));
    assert_eq!(
      episode.webpage_url.as_deref(),
      Some("https://www.example.test/episodes/one")
    );
    assert_eq!(episode.id.len(), 64);
  }
  #[test]
  fn chinese_hosting_feed_shapes_preserve_metadata_and_audio_urls() {
    let cdata_feed = r#"<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"
        xmlns:content="http://purl.org/rss/1.0/modules/content/"
        xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
        <channel>
          <title><![CDATA[方向之间]]></title>
          <description><![CDATA[<p>一档中文谈话节目</p>]]></description>
          <pubDate>Mon, 01 Dec 2025 01:00:00 +0000</pubDate>
          <itunes:author><![CDATA[测试播客厂牌]]></itunes:author>
          <item>
            <guid><![CDATA[episode-380]]></guid>
            <title><![CDATA[380 城市与公共空间]]></title>
            <pubDate><![CDATA[Sat, 04 Jul 2026 01:00:00 +0000]]></pubDate>
            <content:encoded><![CDATA[<p>本期节目讨论城市生活。</p>]]></content:encoded>
            <enclosure
              url="https://tracking.example.test/audio.example.test/episodes/380.m4a?source=feed&amp;token=a%2Fb"
              length="230000"
              type="audio/mp4" />
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(cdata_feed, "cdata");
    assert_eq!(parsed.feed.title, "方向之间");
    assert_eq!(parsed.feed.author.as_deref(), Some("测试播客厂牌"));
    assert_eq!(parsed.episodes[0].title, "380 城市与公共空间");
    assert_eq!(parsed.episodes[0].published_at, Some(1_783_126_800_000));
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://tracking.example.test/audio.example.test/episodes/380.m4a?source=feed&token=a%2Fb"
    );

    let nested_url_feed = r#"<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>山海晨间</title>
          <description>通勤资讯</description>
          <item>
            <guid>episode-42</guid>
            <title>第 42 期</title>
            <pubDate>Sat, 4 Jul 2026 01:00:00 +0000</pubDate>
            <enclosure
              url="http://audio.example.test//group/42.m4a?source=rss&amp;jt=https%3A%2F%2Fjump.example.test%2F42"
              length="420000"
              type="audio/x-m4a" />
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(nested_url_feed, "nested-url");
    assert_eq!(parsed.episodes[0].published_at, Some(1_783_126_800_000));
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "http://audio.example.test//group/42.m4a?source=rss&jt=https%3A%2F%2Fjump.example.test%2F42"
    );
  }
  #[test]
  fn mixed_rss_and_media_enclosures_are_deduplicated() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
        <channel>
          <title>多媒体测试节目</title>
          <description>验证音频选择</description>
          <item>
            <guid>mixed-one</guid>
            <title>同时提供两种音频</title>
            <media:content url="https://img.example.test/cover.jpg" type="image/jpeg" />
            <media:content url="https://audio.example.test/fallback.m4a" type="audio/mp4" />
            <enclosure url="https://audio.example.test/preferred.mp3" length="100" type="audio/mpeg" />
          </item>
          <item>
            <guid>media-only</guid>
            <title>只有 Media RSS 音频</title>
            <media:content url="https://img.example.test/second-cover.jpg" type="image/jpeg" />
            <media:content url="https://audio.example.test/media-only.m4a" type="audio/mp4" fileSize="200" duration="61" />
          </item>
          <item xml:base="https://cdn.example.test/show/">
            <guid>xml-base</guid>
            <title>使用 XML 基准地址</title>
            <media:content url="https://audio.example.test/wrong-before-relative.m4a" type="audio/mp4" />
            <enclosure url="relative.mp3" type="audio/mpeg" />
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(xml, "mixed-enclosures");
    assert_eq!(parsed.episodes.len(), 3);
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://audio.example.test/preferred.mp3"
    );
    assert_eq!(parsed.episodes[0].enclosure_type.as_deref(), Some("audio/mpeg"));
    assert_eq!(parsed.episodes[0].expected_bytes, Some(100));
    assert_eq!(
      parsed.episodes[1].enclosure_url,
      "https://audio.example.test/media-only.m4a"
    );
    assert_eq!(parsed.episodes[1].expected_bytes, Some(200));
    assert_eq!(parsed.episodes[1].duration_seconds, Some(61.0));
    assert_eq!(
      parsed.episodes[2].enclosure_url,
      "https://cdn.example.test/show/relative.mp3"
    );
  }
  #[test]
  fn rss_one_rdf_enclosures_are_supported() {
    let rdf = r#"<?xml version="1.0" encoding="UTF-8"?>
      <rdf:RDF
        xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
        xmlns="http://purl.org/rss/1.0/"
        xmlns:enc="http://purl.oclc.org/net/rss_2.0/enc#">
        <channel rdf:about="https://feeds.example.test/rdf.xml">
          <title>RDF 节目</title>
          <link>https://shows.example.test/rdf</link>
          <description>RSS 1.0 测试</description>
          <items><rdf:Seq><rdf:li resource="https://shows.example.test/rdf/1" /></rdf:Seq></items>
        </channel>
        <item rdf:about="https://shows.example.test/rdf/1">
          <title>RDF 单集</title>
          <link>https://shows.example.test/rdf/1</link>
          <enc:enclosure
            rdf:resource="https://audio.example.test/rdf-1.mp3"
            enc:type="audio/mpeg"
            enc:length="300" />
        </item>
      </rdf:RDF>"#;
    let parsed = parse_test_feed(rdf, "rss-one");
    assert_eq!(parsed.feed.title, "RDF 节目");
    assert_eq!(parsed.episodes.len(), 1);
    assert_eq!(parsed.episodes[0].title, "RDF 单集");
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://audio.example.test/rdf-1.mp3"
    );
    assert_eq!(parsed.episodes[0].expected_bytes, Some(300));
  }
  #[test]
  fn dirty_feed_repair_preserves_cdata_and_visible_unknown_entities() {
    let dirty = r#"
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>研究&nbsp;电台</title>
          <description>脏 XML 恢复测试</description>
          <managingEditor>编辑部</managingEditor>
          <item>
            <title><![CDATA[AT&T 特别节目]]></title>
            <description>A &bogus123; B{control}</description>
            <enclosure
              url="https://audio.example.test/dirty.mp3?source=rss&episode=1"
              type="audio/mpeg" />
          </item>
        </channel>
      </rss>"#
      .replace("{control}", "\u{000b}");
    let mut bytes = vec![0xff, 0xfe];
    for unit in dirty.encode_utf16() {
      bytes.extend_from_slice(&unit.to_le_bytes());
    }
    assert!(feed_rs::parser::parse(bytes.as_slice()).is_err());
    let parsed = parse_feed_bytes(
      &bytes,
      "https://feeds.example.test/dirty.xml",
      None,
      None,
      None,
      None,
      None,
    )
    .expect("repair dirty fixture");
    assert_eq!(parsed.feed.title, "研究 电台");
    assert_eq!(parsed.feed.author.as_deref(), Some("编辑部"));
    assert_eq!(parsed.episodes[0].title, "AT&T 特别节目");
    assert_eq!(parsed.episodes[0].description.as_deref(), Some("A &bogus123; B"));
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://audio.example.test/dirty.mp3?source=rss&episode=1"
    );
    let hinted = parse_feed_bytes(
      &bytes,
      "https://feeds.example.test/dirty.xml",
      None,
      Some("目录中的节目作者"),
      None,
      None,
      None,
    )
    .expect("parse dirty fixture with author hint");
    assert_eq!(hinted.feed.author.as_deref(), Some("目录中的节目作者"));
  }
  #[test]
  fn utf16_feeds_and_relative_enclosures_have_stable_records() {
    let xml = r#"<?xml version="1.0" encoding="UTF-16"?>
      <rss version="2.0">
        <channel>
          <title>清晨电台</title>
          <description>编码兼容测试</description>
          <item>
            <title>第一期：你好</title>
            <enclosure url="../audio/utf16-one.mp3" type="audio/mpeg" />
          </item>
        </channel>
      </rss>"#;
    let mut little_endian = vec![0xff, 0xfe];
    let mut big_endian = Vec::new();
    for unit in xml.encode_utf16() {
      little_endian.extend_from_slice(&unit.to_le_bytes());
      big_endian.extend_from_slice(&unit.to_be_bytes());
    }

    let parse = |bytes: &[u8], name: &str| {
      parse_feed_bytes(
        bytes,
        "https://feeds.example.test/shows/feed.xml",
        None,
        None,
        None,
        None,
        None,
      )
      .unwrap_or_else(|error| panic!("parse {name} UTF-16 fixture: {error}"))
    };
    let little = parse(&little_endian, "little-endian");
    let big = parse(&big_endian, "big-endian");
    assert_eq!(little.feed.title, "清晨电台");
    assert_eq!(little.episodes[0].title, "第一期：你好");
    assert_eq!(
      little.episodes[0].enclosure_url,
      "https://feeds.example.test/audio/utf16-one.mp3"
    );
    assert!(little.episodes[0].guid.is_none());
    assert_eq!(little.episodes[0].id, big.episodes[0].id);
  }
  #[test]
  fn unrecoverable_feed_reports_the_original_parse_error() {
    let broken = br#"<?xml version="1.0"?><rss version="2.0"><channel><title>&bogus;</title>"#;
    let original = feed_rs::parser::Builder::new()
      .base_uri(Some("https://feeds.example.test/broken.xml"))
      .build()
      .parse(broken.as_slice())
      .expect_err("fixture should fail")
      .to_string();
    let error = parse_feed_bytes(
      broken,
      "https://feeds.example.test/broken.xml",
      None,
      None,
      None,
      None,
      None,
    )
    .expect_err("repair should still fail");
    assert!(error.contains(&original), "{error}");
  }
  #[test]
  fn feed_repair_keeps_input_and_output_within_the_response_limit() {
    let oversized = vec![b' '; PODCAST_FEED_RESPONSE_LIMIT + 1];
    let error = parse_feed_bytes(
      &oversized,
      "https://feeds.example.test/oversized.xml",
      None,
      None,
      None,
      None,
      None,
    )
    .expect_err("oversized feed should fail before parsing");
    assert_eq!(error, "播客订阅源超过大小限制");

    let expanding = "&".repeat(PODCAST_FEED_RESPONSE_LIMIT / b"&amp;".len() + 1);
    assert!(repair_feed_bytes(expanding.as_bytes()).is_none());
  }
  #[test]
  fn atom_enclosure_is_supported() {
    let atom = r#"<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <id>urn:zone:test</id>
        <title>Atom 节目</title>
        <updated>2026-07-25T08:00:00Z</updated>
        <entry>
          <id>urn:zone:episode</id>
          <title>Atom 单集</title>
          <updated>2026-07-25T08:00:00Z</updated>
          <link rel="enclosure" type="audio/mp4" href="https://media.example.test/episode.m4a" length="128" />
        </entry>
      </feed>"#;
    let parsed = parse_feed_bytes(
      atom.as_bytes(),
      "https://feeds.example.test/atom.xml",
      None,
      None,
      None,
      None,
      None,
    )
    .expect("parse atom");
    assert_eq!(parsed.feed.title, "Atom 节目");
    assert_eq!(parsed.episodes.len(), 1);
    assert_eq!(
      parsed.episodes[0].enclosure_url,
      "https://media.example.test/episode.m4a"
    );
  }
  #[test]
  fn podcast_resources_are_namespace_aware_and_align_with_audio_entries() {
    let rss = r#"<?xml version="1.0"?>
      <rss version="2.0"
        xmlns:p2="https://podcastindex.org/namespace/1.0"
        xmlns:psc="http://podlove.org/simple-chapters"
        xmlns:wrong="https://example.test/not-podcast">
        <channel>
          <title>章节节目</title>
          <description>chapter fixture</description>
          <link>https://example.test/show</link>
          <item>
            <guid>article-only</guid>
            <title>无音频文章</title>
            <wrong:chapters url="https://example.test/wrong.json"
              type="application/json+chapters" />
          </item>
          <item>
            <guid>chapter-episode</guid>
            <title>带章节单集</title>
            <enclosure url="https://media.example.test/chapter.mp3"
              type="audio/mpeg" length="128" />
            <p2:chapters url="https://cdn.example.test/chapters.json"
              type="application/json+chapters" />
            <p2:transcript url="https://cdn.example.test/transcript.vtt"
              type="text/vtt" language="zh-CN" rel="captions" />
            <psc:chapters version="1.1">
              <psc:chapter start="35:12.250" title="后半段" />
              <psc:chapter start="0" title="开场" />
              <psc:chapter start="7:48" title="主题"
                href="https://example.test/topic" />
            </psc:chapters>
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(rss, "chapter-resources");
    assert_eq!(parsed.episodes.len(), 1);
    let resources = parsed.episodes[0]
      .resources
      .as_ref()
      .expect("complete resource scan");
    assert_eq!(resources.len(), 3);
    let json = resources
      .iter()
      .find(|resource| resource.source_kind == "podcast-json")
      .expect("Podcasting 2.0 chapters");
    assert_eq!(
      json.url.as_deref(),
      Some("https://cdn.example.test/chapters.json")
    );
    let transcript = resources
      .iter()
      .find(|resource| resource.kind == "transcript")
      .expect("transcript resource");
    assert_eq!(transcript.language.as_deref(), Some("zh-CN"));
    assert_eq!(transcript.relation.as_deref(), Some("captions"));
    let psc = resources
      .iter()
      .find(|resource| resource.source_kind == "psc")
      .expect("PSC chapters");
    assert_eq!(
      psc
        .chapters
        .iter()
        .map(|chapter| chapter.start_ms)
        .collect::<Vec<_>>(),
      vec![0, 468_000, 2_112_250],
    );
    assert!(!resources.iter().any(|resource| {
      resource.url.as_deref() == Some("https://example.test/wrong.json")
    }));
  }
  #[test]
  fn podcast_namespace_compatibility_uri_and_psc_times_are_supported() {
    let rss = r#"<?xml version="1.0"?>
      <rss version="2.0"
        xmlns:any="https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md">
        <channel>
          <title>兼容命名空间</title>
          <description>compat fixture</description>
          <item>
            <guid>compat-episode</guid>
            <title>兼容单集</title>
            <enclosure url="https://media.example.test/compat.mp3" type="audio/mpeg" />
            <any:chapters url="https://cdn.example.test/compat.json"
              type="application/json" />
          </item>
        </channel>
      </rss>"#;
    let parsed = parse_test_feed(rss, "chapter-compat");
    assert!(parsed.episodes[0]
      .resources
      .as_ref()
      .is_some_and(|resources| {
        resources
          .iter()
          .any(|resource| resource.source_kind == "podcast-json")
      }));
    assert_eq!(parse_psc_time_ms("37"), Some(37_000));
    assert_eq!(parse_psc_time_ms("7:48"), Some(468_000));
    assert_eq!(parse_psc_time_ms("35:12.250"), Some(2_112_250));
    assert_eq!(parse_psc_time_ms("05:12:03.5"), Some(18_723_500));
    for invalid in ["", "-1", "1:60", "1:60:00", "1:2:3:4", "NaN"] {
      assert_eq!(parse_psc_time_ms(invalid), None, "{invalid}");
    }
  }
  #[test]
  fn feed_without_audio_is_rejected() {
    let rss = r#"<?xml version="1.0"?>
      <rss version="2.0"><channel><title>空节目</title>
      <description>empty</description><link>https://example.test</link>
      <item><guid>text-only</guid><title>文章</title></item>
      </channel></rss>"#;
    assert!(parse_feed_bytes(
      rss.as_bytes(),
      "https://feeds.example.test/empty.xml",
      None,
      None,
      None,
      None,
      None,
    )
    .is_err());
  }
  #[tokio::test]
  async fn conditional_refresh_handles_not_modified_without_advancing_fetch_time() {
    let directory = test_directory("refresh-not-modified");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind refresh server");
    let address = listener.local_addr().expect("refresh server address");
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.expect("accept refresh request");
      let mut request = vec![0u8; 8_192];
      let read = stream.read(&mut request).await.expect("read refresh request");
      let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
      assert!(request.contains("if-none-match: \"etag-one\""), "{request}");
      assert!(
        request.contains("if-modified-since: sat, 25 jul 2026 08:00:00 gmt"),
        "{request}"
      );
      stream
        .write_all(
          b"HTTP/1.1 304 Not Modified\r\nETag: \"etag-two\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await
        .expect("write not-modified response");
      stream.shutdown().await.expect("shutdown refresh response");
    });
    let feed_url = format!("http://{address}/feed.xml");
    open_database(&state.db_path)
      .expect("open refresh database")
      .execute(
        "
        UPDATE podcast_feeds SET
          feed_url = ?2,
          last_fetched_at = 123,
          last_checked_at = 0,
          last_refresh_error = '旧错误'
        WHERE id = ?1
        ",
        params![feed_id, feed_url],
      )
      .expect("point feed at refresh server");
    let target = list_refresh_targets(&state.db_path, Some(&feed_id), true, unix_time_millis())
      .expect("load refresh target")
      .pop()
      .expect("refresh target");
    let outcome = refresh_feed_target(
      state.db_path.clone(),
      state.active_refreshes.clone(),
      state.refresh_semaphore.clone(),
      target,
      true,
    )
    .await;
    server.await.expect("refresh server task");
    assert!(matches!(outcome, PodcastRefreshOutcome::NotModified));
    let (etag, last_fetched_at, last_checked_at, last_refresh_error) = open_database(&state.db_path)
      .expect("open refreshed database")
      .query_row(
        "
        SELECT etag, last_fetched_at, last_checked_at, last_refresh_error
        FROM podcast_feeds
        WHERE id = ?1
        ",
        [&feed_id],
        |row| {
          Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<String>>(3)?,
          ))
        },
      )
      .expect("read not-modified state");
    assert_eq!(etag.as_deref(), Some("\"etag-two\""));
    assert_eq!(last_fetched_at, 123);
    assert!(last_checked_at.is_some_and(|value| value > 0));
    assert!(last_refresh_error.is_none());

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[tokio::test]
  async fn successful_refresh_preserves_ids_and_reports_inserted_and_changed_episodes() {
    let directory = test_directory("refresh-updated");
    let state = PodcastState::initialize_at(&directory).expect("initialize podcast state");
    let parsed = parsed_fixture("https://media.example.test/episode-1.mp3");
    let feed_id = parsed.feed.id.clone();
    let original_episode_id = parsed.episodes[0].id.clone();
    store_subscription(&state.db_path, parsed).expect("store subscription");
    let original_first_seen =
      get_episode_detail(&state.db_path, &state.downloads_dir, &original_episode_id)
        .expect("initial episode")
        .episode
        .first_seen_at;

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind refresh server");
    let address = listener.local_addr().expect("refresh server address");
    let body = r#"<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Zone 测试播客</title>
          <description>刷新后的节目简介</description>
          <item>
            <guid isPermaLink="false">episode-one</guid>
            <title>第一集（修订）</title>
            <link>https://www.example.test/episodes/one-updated</link>
            <enclosure url="https://media.example.test/episode-1.mp3" type="audio/mpeg" />
          </item>
          <item>
            <guid isPermaLink="false">episode-two</guid>
            <title>第二集</title>
            <link>https://www.example.test/episodes/two</link>
            <enclosure url="https://media.example.test/episode-2.mp3" type="audio/mpeg" />
          </item>
        </channel>
      </rss>"#
      .as_bytes()
      .to_vec();
    let server_body = body.clone();
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.expect("accept refresh request");
      let mut request = vec![0u8; 8_192];
      let read = stream.read(&mut request).await.expect("read refresh request");
      let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
      assert!(request.contains("if-none-match: \"etag-one\""), "{request}");
      let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        server_body.len(),
      );
      stream.write_all(headers.as_bytes()).await.expect("write refresh headers");
      stream.write_all(&server_body).await.expect("write refresh body");
      stream.shutdown().await.expect("shutdown refresh response");
    });
    let feed_url = format!("http://{address}/feed.xml");
    open_database(&state.db_path)
      .expect("open refresh database")
      .execute(
        "
        UPDATE podcast_feeds SET
          feed_url = ?2,
          last_checked_at = 0,
          last_refresh_error = '旧错误'
        WHERE id = ?1
        ",
        params![feed_id, feed_url],
      )
      .expect("point feed at refresh server");
    let target = list_refresh_targets(&state.db_path, Some(&feed_id), true, unix_time_millis())
      .expect("load refresh target")
      .pop()
      .expect("refresh target");
    let outcome = refresh_feed_target(
      state.db_path.clone(),
      state.active_refreshes.clone(),
      state.refresh_semaphore.clone(),
      target,
      true,
    )
    .await;
    server.await.expect("refresh server task");
    assert!(matches!(
      &outcome,
      PodcastRefreshOutcome::Updated {
        inserted: 1,
        updated: 1,
      }
    ), "{outcome:?}");
    let episodes =
      list_episodes(&state.db_path, &state.downloads_dir, &feed_id).expect("list refreshed episodes");
    assert_eq!(episodes.len(), 2);
    let updated = episodes
      .iter()
      .find(|episode| episode.id == original_episode_id)
      .expect("stable existing episode");
    assert_eq!(updated.title, "第一集（修订）");
    assert_eq!(updated.first_seen_at, original_first_seen);
    assert_eq!(
      updated.webpage_url.as_deref(),
      Some("https://www.example.test/episodes/one-updated")
    );
    let inserted = episodes
      .iter()
      .find(|episode| episode.title == "第二集")
      .expect("inserted episode");
    assert_eq!(
      inserted.id,
      hash_identifier("episode", &[&feed_id, "guid:episode-two"])
    );
    assert!(inserted.first_seen_at >= original_first_seen);
    let feed = list_feeds(&state.db_path)
      .expect("list refreshed feeds")
      .pop()
      .expect("refreshed feed");
    assert_eq!(feed.id, feed_id);
    assert!(feed.last_refresh_error.is_none());
    let validators = open_database(&state.db_path)
      .expect("open refreshed database")
      .query_row(
        "SELECT etag, last_modified FROM podcast_feeds WHERE id = ?1",
        [&feed.id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
      )
      .expect("read refreshed validators");
    assert_eq!(validators, (None, None));

    fs::remove_dir_all(directory).expect("cleanup test directory");
  }
  #[tokio::test]
  #[ignore = "requires ZONE_PODCAST_LIVE=1 and public internet access"]
  async fn apple_cn_to_rss_to_enclosure_range_live_smoke() {
    if std::env::var("ZONE_PODCAST_LIVE").ok().as_deref() != Some("1") {
      eprintln!("set ZONE_PODCAST_LIVE=1 to run the podcast live smoke");
      return;
    }
    let query = std::env::var("ZONE_PODCAST_LIVE_QUERY").unwrap_or_else(|_| "声动早咖啡".to_string());
    let search = search_apple_cn(&query, 5).await.expect("Apple CN search");
    let candidate = search.into_iter().next().expect("Apple CN search candidate");
    let parsed = fetch_and_parse_feed(
      &candidate.feed_url,
      Some(&candidate.title),
      Some(&candidate.author),
      candidate.artwork_url.as_deref(),
    )
    .await
    .expect("fetch RSS");
    let episode = parsed.episodes.first().expect("podcast episode");
    let mut response = send_public_get(
      validate_public_url_shape(&episode.enclosure_url).expect("enclosure URL"),
      Duration::from_secs(30),
      Some("bytes=0-1023"),
    )
    .await
    .expect("enclosure range request");
    assert!(response.response.status().is_success());
    assert!(response_content_type_is_audio_candidate(
      header_text(response.response.headers(), header::CONTENT_TYPE).as_deref(),
      episode.enclosure_type.as_deref(),
      Some(episode.enclosure_url.as_str()),
    ));
    let first_chunk = response
      .response
      .chunk()
      .await
      .expect("read enclosure range")
      .expect("non-empty enclosure range");
    assert!(!first_chunk.is_empty());
  }
}
