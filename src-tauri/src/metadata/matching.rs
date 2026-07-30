use std::collections::HashSet;

pub(crate) fn text_similarity(left: &str, right: &str) -> u8 {
  let left = normalize_match_text(left);
  let right = normalize_match_text(right);
  if left.is_empty() || right.is_empty() {
    return 0;
  }
  if left == right {
    return 100;
  }
  if left.contains(&right) || right.contains(&left) {
    let shorter = left.chars().count().min(right.chars().count());
    let longer = left.chars().count().max(right.chars().count());
    return ((shorter * 85) / longer.max(1)).max(60).min(85) as u8;
  }

  let left_chars: HashSet<char> = left.chars().collect();
  let right_chars: HashSet<char> = right.chars().collect();
  let shared = left_chars.intersection(&right_chars).count();
  ((shared * 200) / (left_chars.len() + right_chars.len()).max(1)).min(100) as u8
}

fn normalize_match_text(value: &str) -> String {
  value
    .chars()
    .flat_map(char::to_lowercase)
    .filter(|value| value.is_alphanumeric())
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn exact_and_composite_names_have_stable_scores() {
    assert_eq!(text_similarity("胡彦斌", "胡彦斌"), 100);
    assert!(text_similarity("胡彦斌 / 朴树", "胡彦斌") >= 60);
    assert!(text_similarity("胡彦斌", "完全不同") < 60);
  }
}
