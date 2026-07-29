use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{DateTime, NaiveDate, NaiveDateTime};
use comic_platform_domain::TaskSearchResult;
use unicode_normalization::UnicodeNormalization;
use url::Url;

const SOFT_DUPLICATE_THRESHOLD: f64 = 0.94;

pub(crate) fn merge_search_results(results: Vec<TaskSearchResult>) -> Vec<TaskSearchResult> {
    let mut merged = Vec::with_capacity(results.len());
    let mut exact_indexes = HashMap::new();
    let mut soft_index = SoftDuplicateIndex::default();

    for candidate in results {
        let exact_key = exact_result_key(&candidate);
        if let Some(&index) = exact_indexes.get(&exact_key) {
            merged[index] = merge_result_metadata(&merged[index], &candidate);
            soft_index.add(&merged[index], index);
            continue;
        }

        if let Some(index) = soft_index.find(&merged, &candidate) {
            merged[index] = merge_result_metadata(&merged[index], &candidate);
            soft_index.add(&merged[index], index);
            exact_indexes.insert(exact_key, index);
            exact_indexes.insert(exact_result_key(&merged[index]), index);
            continue;
        }

        let index = merged.len();
        exact_indexes.insert(exact_key, index);
        merged.push(candidate);
        soft_index.add(&merged[index], index);
    }

    sort_search_results_by_newest(merged)
}

#[derive(Default)]
struct SoftDuplicateIndex {
    exact_titles: HashMap<String, HashSet<usize>>,
    bigram_postings: HashMap<String, HashMap<usize, usize>>,
    title_lengths: HashMap<usize, usize>,
}

impl SoftDuplicateIndex {
    fn add(&mut self, result: &TaskSearchResult, result_index: usize) {
        let title = normalized_title(&result.title);
        let title_length = title.chars().count();
        if title_length < 8 {
            return;
        }
        self.exact_titles
            .entry(title.clone())
            .or_default()
            .insert(result_index);
        self.title_lengths.insert(result_index, title_length);
        if title_length < 12 {
            return;
        }
        for (pair, count) in bigram_counts(&title) {
            self.bigram_postings
                .entry(pair)
                .or_default()
                .insert(result_index, count);
        }
    }

    fn find(&self, results: &[TaskSearchResult], candidate: &TaskSearchResult) -> Option<usize> {
        let title = normalized_title(&candidate.title);
        let title_length = title.chars().count();
        if title_length < 8 {
            return None;
        }

        let mut candidates = self.exact_titles.get(&title).cloned().unwrap_or_default();
        if title_length >= 12 {
            let mut overlaps = HashMap::<usize, usize>::new();
            for (pair, candidate_count) in bigram_counts(&title) {
                if let Some(postings) = self.bigram_postings.get(&pair) {
                    for (&result_index, &existing_count) in postings {
                        *overlaps.entry(result_index).or_default() +=
                            candidate_count.min(existing_count);
                    }
                }
            }
            let candidate_pairs = title_length - 1;
            for (result_index, overlap) in overlaps {
                let existing_length = self
                    .title_lengths
                    .get(&result_index)
                    .copied()
                    .unwrap_or_default();
                if existing_length < 12 {
                    continue;
                }
                let required_overlap = (SOFT_DUPLICATE_THRESHOLD
                    * (candidate_pairs + existing_length - 1) as f64
                    / 2.0)
                    .ceil() as usize;
                if overlap >= required_overlap {
                    candidates.insert(result_index);
                }
            }
        }

        let mut candidates = candidates.into_iter().collect::<Vec<_>>();
        candidates.sort_unstable();
        candidates
            .into_iter()
            .find(|&index| is_soft_duplicate(&results[index], candidate))
    }
}

fn is_soft_duplicate(left: &TaskSearchResult, right: &TaskSearchResult) -> bool {
    if left.source_id == right.source_id
        || !compatible_page_counts(left.page_count, right.page_count)
    {
        return false;
    }
    let left_title = normalized_title(&left.title);
    let right_title = normalized_title(&right.title);
    let minimum_length = left_title.chars().count().min(right_title.chars().count());
    if minimum_length < 8 {
        return false;
    }
    if left_title == right_title {
        return true;
    }
    minimum_length >= 12 && dice_similarity(&left_title, &right_title) >= SOFT_DUPLICATE_THRESHOLD
}

fn merge_result_metadata(left: &TaskSearchResult, right: &TaskSearchResult) -> TaskSearchResult {
    let (primary, secondary) = if completeness_score(right) > completeness_score(left) {
        (right, left)
    } else {
        (left, right)
    };
    let mut result = primary.clone();
    result.tags = merge_tags(&primary.tags, &secondary.tags);
    result.thumbnail_url = primary
        .thumbnail_url
        .clone()
        .or_else(|| secondary.thumbnail_url.clone());
    result.uploader = primary
        .uploader
        .clone()
        .or_else(|| secondary.uploader.clone());
    result.uploaded_at = newest_date(
        primary.uploaded_at.as_deref(),
        secondary.uploaded_at.as_deref(),
    );
    result.category = primary
        .category
        .clone()
        .or_else(|| secondary.category.clone());
    result.page_count = primary.page_count.or(secondary.page_count);
    result.rating = primary.rating.or(secondary.rating);
    result
}

fn completeness_score(item: &TaskSearchResult) -> usize {
    usize::from(item.thumbnail_url.is_some()) * 3
        + usize::from(item.uploader.is_some())
        + usize::from(item.uploaded_at.is_some()) * 2
        + usize::from(item.category.is_some())
        + usize::from(item.page_count.is_some()) * 2
        + usize::from(item.rating.is_some())
        + item.tags.len().min(5)
}

fn merge_tags(primary: &[String], secondary: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    primary
        .iter()
        .chain(secondary)
        .filter_map(|tag| {
            let tag = tag.trim();
            (!tag.is_empty() && seen.insert(tag.to_string())).then(|| tag.to_string())
        })
        .collect()
}

fn newest_date(left: Option<&str>, right: Option<&str>) -> Option<String> {
    match (
        left.and_then(uploaded_at_timestamp_millis),
        right.and_then(uploaded_at_timestamp_millis),
    ) {
        (None, None) => left.or(right).map(str::to_string),
        (Some(_), None) => left.map(str::to_string),
        (None, Some(_)) => right.map(str::to_string),
        (Some(left_timestamp), Some(right_timestamp)) => {
            if left_timestamp >= right_timestamp {
                left.map(str::to_string)
            } else {
                right.map(str::to_string)
            }
        }
    }
}

fn exact_result_key(result: &TaskSearchResult) -> String {
    format!(
        "{}|{}",
        result.source_id,
        normalize_gallery_url(&result.gallery_url)
    )
}

fn normalize_gallery_url(value: &str) -> String {
    let text = value.trim();
    let Ok(mut url) = Url::parse(text) else {
        return text
            .split('#')
            .next()
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string();
    };
    url.set_fragment(None);
    let mut pairs = url
        .query_pairs()
        .filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            !(key.starts_with("utm_")
                || matches!(key.as_str(), "ref" | "referrer" | "source" | "spm"))
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    pairs.sort();
    url.query_pairs_mut().clear().extend_pairs(pairs);
    if url.query() == Some("") {
        url.set_query(None);
    }
    let trimmed_path = url.path().trim_end_matches('/').to_string();
    url.set_path(if trimmed_path.is_empty() {
        "/"
    } else {
        &trimmed_path
    });
    url.to_string()
}

fn compatible_page_counts(left: Option<u32>, right: Option<u32>) -> bool {
    left.is_none() || right.is_none() || left == right
}

fn normalized_title(value: &str) -> String {
    let normalized = value
        .nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>();
    let mut result = String::new();
    let mut bracket = String::new();
    let mut in_bracket = false;
    for character in normalized.chars() {
        match character {
            '[' if !in_bracket => {
                in_bracket = true;
                bracket.clear();
            }
            ']' if in_bracket => {
                if !is_translation_marker(&bracket) {
                    result.extend(
                        bracket
                            .chars()
                            .filter(|character| character.is_alphanumeric()),
                    );
                }
                in_bracket = false;
                bracket.clear();
            }
            _ if in_bracket => bracket.push(character),
            _ if character.is_alphanumeric() => result.push(character),
            _ => {}
        }
    }
    if in_bracket {
        result.extend(
            bracket
                .chars()
                .filter(|character| character.is_alphanumeric()),
        );
    }
    result
}

fn is_translation_marker(value: &str) -> bool {
    ["translated", "翻译", "翻譯", "漢化", "汉化"]
        .iter()
        .any(|marker| value.contains(marker))
}

fn dice_similarity(left: &str, right: &str) -> f64 {
    let left_pairs = bigram_counts(left);
    let right_pairs = bigram_counts(right);
    let overlap = left_pairs
        .iter()
        .map(|(pair, count)| count.min(right_pairs.get(pair).unwrap_or(&0)))
        .sum::<usize>();
    let total = left.chars().count().saturating_sub(1) + right.chars().count().saturating_sub(1);
    if total == 0 {
        0.0
    } else {
        2.0 * overlap as f64 / total as f64
    }
}

fn bigram_counts(value: &str) -> HashMap<String, usize> {
    let characters = value.chars().collect::<Vec<_>>();
    let mut counts = HashMap::new();
    for pair in characters.windows(2) {
        *counts.entry(pair.iter().collect()).or_default() += 1;
    }
    counts
}

fn sort_search_results_by_newest(results: Vec<TaskSearchResult>) -> Vec<TaskSearchResult> {
    let mut known = Vec::new();
    let mut unknown = Vec::new();
    for (index, result) in results.into_iter().enumerate() {
        match result
            .uploaded_at
            .as_deref()
            .and_then(uploaded_at_timestamp_millis)
        {
            Some(timestamp) => known.push((timestamp, index, result)),
            None => unknown.push(result),
        }
    }
    known.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));

    let mut sorted = Vec::with_capacity(known.len() + unknown.len());
    let mut known = known.into_iter().peekable();
    while let Some((timestamp, _, result)) = known.next() {
        let mut same_time = vec![result];
        while known.peek().is_some_and(|item| item.0 == timestamp) {
            if let Some((_, _, result)) = known.next() {
                same_time.push(result);
            }
        }
        sorted.extend(interleave_by_source(same_time));
    }
    sorted.extend(interleave_by_source(unknown));
    sorted
}

fn interleave_by_source(results: Vec<TaskSearchResult>) -> Vec<TaskSearchResult> {
    let result_count = results.len();
    let mut queues: Vec<(String, VecDeque<TaskSearchResult>)> = Vec::new();
    for result in results {
        if let Some((_, queue)) = queues
            .iter_mut()
            .find(|(source_id, _)| source_id == &result.source_id)
        {
            queue.push_back(result);
        } else {
            queues.push((result.source_id.clone(), VecDeque::from([result])));
        }
    }

    let mut interleaved = Vec::with_capacity(result_count);
    while interleaved.len() < result_count {
        for (_, queue) in &mut queues {
            if let Some(result) = queue.pop_front() {
                interleaved.push(result);
            }
        }
    }
    interleaved
}

pub(crate) fn uploaded_at_timestamp_millis(value: &str) -> Option<i64> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(number) = text.parse::<i64>() {
        return Some(if number < 10_000_000_000 {
            number.saturating_mul(1000)
        } else {
            number
        });
    }
    if let Ok(value) = DateTime::parse_from_rfc3339(text) {
        return Some(value.timestamp_millis());
    }
    for format in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(value) = NaiveDateTime::parse_from_str(text, format) {
            return Some(value.and_utc().timestamp_millis());
        }
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .ok()
        .and_then(|value| value.and_hms_opt(0, 0, 0))
        .map(|value| value.and_utc().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::{merge_search_results, normalize_gallery_url, uploaded_at_timestamp_millis};
    use comic_platform_domain::TaskSearchResult;

    fn result(source_id: &str, title: &str, uploaded_at: Option<&str>) -> TaskSearchResult {
        TaskSearchResult {
            source_id: source_id.to_string(),
            gallery_url: format!("https://{source_id}.test/{title}"),
            title: title.to_string(),
            tags: Vec::new(),
            thumbnail_url: None,
            uploader: None,
            uploaded_at: uploaded_at.map(str::to_string),
            category: None,
            page_count: None,
            rating: None,
        }
    }

    #[test]
    fn globally_sorts_and_interleaves_search_results() {
        let timestamp = Some("2026-07-28 03:45");
        let sorted = merge_search_results(vec![
            result("fangliding", "fang-1", timestamp),
            result("fangliding", "fang-2", timestamp),
            result("e-hentai", "eh-1", timestamp),
            result("18comic", "jm-1", timestamp),
            result("e-hentai", "older", Some("2026-07-27 03:45")),
        ]);
        assert_eq!(
            sorted
                .iter()
                .map(|item| item.title.as_str())
                .collect::<Vec<_>>(),
            vec!["fang-1", "eh-1", "jm-1", "fang-2", "older"]
        );
    }

    #[test]
    fn merges_normalized_urls_and_cross_source_titles() {
        let mut first = result("one", "[Circle] Shared work [翻译]", Some("2026-07-27"));
        first.gallery_url = "https://one.test/g/1/?utm_source=x".to_string();
        first.page_count = Some(20);
        first.tags = vec!["language:chinese".to_string()];
        let mut same_url = result("one", "same URL", None);
        same_url.gallery_url = "https://one.test/g/1".to_string();
        same_url.thumbnail_url = Some("https://one.test/1.jpg".to_string());
        same_url.page_count = Some(20);
        let mut richer = result(
            "two",
            "[Circle] Shared work [translated]",
            Some("2026-07-28"),
        );
        richer.page_count = Some(20);
        richer.uploader = Some("uploader".to_string());
        richer.category = Some("doujinshi".to_string());
        richer.tags = vec!["artist:fixture".to_string()];

        let merged = merge_search_results(vec![first, same_url, richer]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source_id, "two");
        assert_eq!(
            merged[0].thumbnail_url.as_deref(),
            Some("https://one.test/1.jpg")
        );
    }

    #[test]
    fn normalizes_tracking_urls_and_timestamp_formats() {
        assert_eq!(
            normalize_gallery_url("HTTPS://Example.Test/g/1/?utm_source=test&b=2&a=1#top"),
            "https://example.test/g/1?a=1&b=2"
        );
        assert_eq!(
            uploaded_at_timestamp_millis("2026-07-28 03:45"),
            uploaded_at_timestamp_millis("2026-07-28T03:45:00Z")
        );
        assert!(uploaded_at_timestamp_millis("").is_none());
        assert!(uploaded_at_timestamp_millis("not-a-date").is_none());
    }
}
