//! Shared backoff prevents unavailable catalog endpoints from flooding providers.
use std::{sync::Mutex, time::{Duration, Instant}};

const COOLDOWN: Duration = Duration::from_secs(300);
static NETEASE_RETRY_AT: Mutex<Option<Instant>> = Mutex::new(None);

pub(crate) fn check_netease() -> Result<(), String> {
  let retry_at = NETEASE_RETRY_AT.lock().map_err(|_| "网易云音乐来源状态暂不可用")?;
  if retry_at.is_some_and(|time| Instant::now() < time) {
    Err("网易云音乐暂不可用，请 5 分钟后重试；可先使用其他来源".into())
  } else { Ok(()) }
}

pub(crate) fn note_netease_code(code: u64) -> Result<(), String> {
  if is_restricted_code(code) {
    if let Ok(mut retry_at) = NETEASE_RETRY_AT.lock() { *retry_at = Some(Instant::now() + COOLDOWN); }
    Err("网易云音乐暂不可用，请 5 分钟后重试；可先使用其他来源".into())
  } else { Ok(()) }
}

fn is_restricted_code(code: u64) -> bool { matches!(code, 403 | 405 | 406 | 429) }

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn restricted_statuses_back_off_without_treating_empty_results_as_failure() {
    for code in [403, 405, 406, 429] { assert!(is_restricted_code(code)); }
    for code in [0, 200, 404, 500] { assert!(!is_restricted_code(code)); }
  }
}
