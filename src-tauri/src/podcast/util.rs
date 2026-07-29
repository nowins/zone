use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use super::*;

pub(crate) fn parse_iso8601_millis(value: &str) -> Option<i64> {
  let bytes = value.trim().as_bytes();
  if bytes.len() < 10 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
    return None;
  }
  let year = parse_ascii_number(bytes.get(0..4)?)?;
  let month = parse_ascii_number(bytes.get(5..7)?)?;
  let day = parse_ascii_number(bytes.get(8..10)?)?;
  if year == 0 || !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) {
    return None;
  }

  let mut hour = 0;
  let mut minute = 0;
  let mut second = 0;
  let mut millisecond = 0;
  let mut offset_minutes = 0i64;
  if bytes.len() > 10 {
    if !matches!(bytes.get(10), Some(b'T' | b't' | b' ')) || bytes.len() < 19 {
      return None;
    }
    hour = parse_ascii_number(bytes.get(11..13)?)?;
    minute = parse_ascii_number(bytes.get(14..16)?)?;
    second = parse_ascii_number(bytes.get(17..19)?)?;
    if bytes.get(13) != Some(&b':')
      || bytes.get(16) != Some(&b':')
      || hour > 23
      || minute > 59
      || second > 59
    {
      return None;
    }

    let mut cursor = 19;
    if bytes.get(cursor) == Some(&b'.') {
      cursor += 1;
      let fraction_start = cursor;
      while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        cursor += 1;
      }
      if cursor == fraction_start {
        return None;
      }
      let fraction = &bytes[fraction_start..cursor];
      millisecond = i64::from(fraction[0] - b'0') * 100;
      if fraction.len() > 1 {
        millisecond += i64::from(fraction[1] - b'0') * 10;
      }
      if fraction.len() > 2 {
        millisecond += i64::from(fraction[2] - b'0');
      }
    }

    match bytes.get(cursor) {
      Some(b'Z' | b'z') if cursor + 1 == bytes.len() => {}
      Some(sign @ (b'+' | b'-')) => {
        let remainder = bytes.get(cursor + 1..)?;
        let (offset_hour, offset_minute) = match remainder {
          [hour_1, hour_2, b':', minute_1, minute_2] => (
            parse_ascii_number(&[*hour_1, *hour_2])?,
            parse_ascii_number(&[*minute_1, *minute_2])?,
          ),
          [hour_1, hour_2, minute_1, minute_2] => (
            parse_ascii_number(&[*hour_1, *hour_2])?,
            parse_ascii_number(&[*minute_1, *minute_2])?,
          ),
          _ => return None,
        };
        if offset_hour > 23 || offset_minute > 59 {
          return None;
        }
        offset_minutes = i64::from(offset_hour * 60 + offset_minute);
        if *sign == b'-' {
          offset_minutes = -offset_minutes;
        }
      }
      _ => return None,
    }
  }

  let days = days_from_civil(i64::from(year), i64::from(month), i64::from(day));
  days
    .checked_mul(86_400_000)?
    .checked_add(i64::from(hour) * 3_600_000)?
    .checked_add(i64::from(minute) * 60_000)?
    .checked_add(i64::from(second) * 1_000)?
    .checked_add(millisecond)?
    .checked_sub(offset_minutes * 60_000)
}

fn parse_ascii_number(bytes: &[u8]) -> Option<u32> {
  if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
    return None;
  }
  bytes
    .iter()
    .try_fold(0u32, |value, digit| value.checked_mul(10)?.checked_add(u32::from(*digit - b'0')))
}

fn days_in_month(year: u32, month: u32) -> u32 {
  match month {
    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
    4 | 6 | 9 | 11 => 30,
    2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
    2 => 28,
    _ => 0,
  }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
  let adjusted_year = year - if month <= 2 { 1 } else { 0 };
  let era = if adjusted_year >= 0 {
    adjusted_year
  } else {
    adjusted_year - 399
  } / 400;
  let year_of_era = adjusted_year - era * 400;
  let adjusted_month = month + if month > 2 { -3 } else { 9 };
  let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
  let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  era * 146_097 + day_of_era - 719_468
}
pub(crate) fn validate_identifier(value: &str) -> Result<(), String> {
  if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return Err("播客标识无效".to_string());
  }
  Ok(())
}

pub(crate) fn hash_identifier(namespace: &str, values: &[&str]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(namespace.as_bytes());
  for value in values {
    hasher.update([0]);
    hasher.update(value.as_bytes());
  }
  hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn normalize_url(value: &str, allow_private_network: bool) -> Result<String, String> {
  let mut url = validate_url_shape_with_policy(value, allow_private_network)?;
  url.set_fragment(None);
  Ok(url.to_string())
}

pub(crate) fn clean_url_string(value: &str) -> Option<String> {
  validate_public_url_shape(value).ok().map(|url| url.to_string())
}

pub(crate) fn clean_hint(value: Option<&str>, limit: usize) -> Option<String> {
  value.and_then(|value| clean_text(value, limit))
}

pub(crate) fn clean_optional(value: Option<String>, limit: usize) -> Option<String> {
  value.and_then(|value| clean_text(&value, limit))
}

pub(crate) fn clean_text(value: &str, limit: usize) -> Option<String> {
  let value = truncate_chars(value.trim(), limit);
  (!value.is_empty()).then_some(value)
}

pub(crate) fn plain_text(value: &str, limit: usize) -> String {
  let mut output = String::new();
  let mut inside_tag = false;
  let mut pending_space = false;
  let mut output_characters = 0usize;
  for character in value.chars() {
    match character {
      '<' => inside_tag = true,
      '>' if inside_tag => {
        inside_tag = false;
        pending_space = true;
      }
      _ if inside_tag => {}
      _ if character.is_whitespace() => {
        pending_space = true;
      }
      _ => {
        if pending_space && !output.is_empty() && output_characters < limit {
          output.push(' ');
          output_characters += 1;
        }
        if output_characters >= limit {
          break;
        }
        output.push(character);
        output_characters += 1;
        pending_space = false;
      }
    }
    if output_characters >= limit {
      break;
    }
  }
  output
    .replace("&amp;", "&")
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .trim()
    .to_string()
}

pub(crate) fn truncate_chars(value: &str, limit: usize) -> String {
  value.chars().take(limit).collect()
}

pub(crate) fn unix_time_millis() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .ok()
    .and_then(|duration| i64::try_from(duration.as_millis()).ok())
    .unwrap_or(0)
}
