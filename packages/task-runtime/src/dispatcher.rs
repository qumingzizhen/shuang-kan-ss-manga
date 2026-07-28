use std::collections::{HashSet, VecDeque};

use chrono::{DateTime, NaiveDate, NaiveDateTime};
use comic_platform_domain::{
    CreateGalleryTaskRequest, SourceCapability, SourceSearchError, Task, TaskOutput, TaskPayload,
    TaskSearchResult,
};
use comic_platform_source_adapter::{AdapterResult, SourceAdapterRegistry};
use futures_util::{StreamExt, stream};

#[derive(Debug, Clone)]
pub struct TaskDispatchReport {
    pub task_id: String,
    pub source_id: String,
    pub operation: String,
    pub message: String,
    pub total: Option<u32>,
    pub done: Option<u32>,
    pub failed: Option<u32>,
    pub output: Option<TaskOutput>,
}

#[derive(Clone)]
pub struct TaskDispatcher {
    sources: SourceAdapterRegistry,
}

impl TaskDispatcher {
    pub fn new(sources: SourceAdapterRegistry) -> Self {
        Self { sources }
    }

    pub fn source_count(&self) -> usize {
        self.sources.list().len()
    }

    pub async fn dispatch(&self, task: Task) -> AdapterResult<TaskDispatchReport> {
        match task.payload {
            TaskPayload::Search(request) => {
                let excluded_tags = request.excluded_tags.clone();
                let source_ids = self
                    .sources
                    .resolve_source_ids(request.source_id.as_deref(), &request.source_ids);
                if source_ids.is_empty() {
                    return Err(comic_platform_source_adapter::AdapterError::invalid_input(
                        "search requires at least one source adapter",
                    ));
                }
                let source_concurrency =
                    configured_concurrency("TASK_SEARCH_SOURCE_CONCURRENCY", 2, 8);
                let enrich_concurrency =
                    configured_concurrency("TASK_SEARCH_ENRICH_CONCURRENCY", 4, 12);
                let source_runs = stream::iter(source_ids.iter().cloned().map(|source_id| {
                    let sources = self.sources.clone();
                    let mut source_request = request.clone();
                    let excluded_tags = excluded_tags.clone();
                    async move {
                        sources.require_capability(&source_id, SourceCapability::Search)?;
                        let adapter = sources.adapter(&source_id)?;
                        source_request.source_id = Some(source_id.clone());
                        source_request.source_ids.clear();
                        let source_results = adapter.search(source_request).await?;
                        let enriched_results =
                            stream::iter(source_results.into_iter().map(|mut item| {
                                let adapter = adapter.clone();
                                let source_id = source_id.clone();
                                let should_enrich =
                                    !excluded_tags.is_empty() && item.tags.is_empty();
                                async move {
                                    if should_enrich
                                        && let Ok(metadata) = adapter
                                            .read_gallery(CreateGalleryTaskRequest {
                                                source_id: Some(source_id),
                                                gallery_url: item.gallery_url.clone(),
                                            })
                                            .await
                                    {
                                        item.tags = metadata.tags;
                                    }
                                    item
                                }
                            }))
                            .buffered(enrich_concurrency)
                            .collect::<Vec<_>>()
                            .await;

                        let mut excluded_count = 0;
                        let results = enriched_results
                            .into_iter()
                            .filter_map(|item| {
                                if search_result_matches_excluded_tags(
                                    &item.title,
                                    &item.tags,
                                    &excluded_tags,
                                ) {
                                    excluded_count += 1;
                                    return None;
                                }
                                Some(TaskSearchResult {
                                    source_id: item.source_id,
                                    gallery_url: item.gallery_url,
                                    title: item.title,
                                    tags: item.tags,
                                    thumbnail_url: item.thumbnail_url,
                                    uploader: item.uploader,
                                    uploaded_at: item.uploaded_at,
                                    category: item.category,
                                    page_count: item.page_count,
                                    rating: item.rating,
                                })
                            })
                            .collect::<Vec<_>>();
                        Ok::<_, comic_platform_source_adapter::AdapterError>(SourceSearchRun {
                            results,
                            excluded_count,
                        })
                    }
                }))
                .buffered(source_concurrency)
                .collect::<Vec<_>>()
                .await;

                let mut results = Vec::new();
                let mut seen_results = HashSet::new();
                let mut source_errors = Vec::new();
                let mut excluded_count = 0;
                for (index, source_run) in source_runs.into_iter().enumerate() {
                    match source_run {
                        Ok(source_run) => {
                            excluded_count += source_run.excluded_count;
                            for result in source_run.results {
                                let key = format!("{}|{}", result.source_id, result.gallery_url);
                                if seen_results.insert(key) {
                                    results.push(result);
                                }
                            }
                        }
                        Err(error) => {
                            let source_id = source_ids[index].clone();
                            let source_name = self
                                .sources
                                .adapter(&source_id)
                                .map(|adapter| adapter.descriptor().name)
                                .unwrap_or_else(|_| source_id.clone());
                            source_errors.push(SourceSearchError {
                                source_id,
                                source_name,
                                message: error.to_string(),
                            });
                        }
                    }
                }

                if source_errors.len() == source_ids.len() {
                    let message = source_errors
                        .iter()
                        .map(|error| format!("{}: {}", error.source_name, error.message))
                        .collect::<Vec<_>>()
                        .join("; ");
                    return Err(
                        comic_platform_source_adapter::AdapterError::execution_failed(format!(
                            "all source searches failed: {message}"
                        )),
                    );
                }

                results = sort_search_results_by_newest(results);
                let total = results.len() as u32;
                let failure_suffix = if source_errors.is_empty() {
                    String::new()
                } else {
                    format!(", {} source(s) failed", source_errors.len())
                };
                let excluded_suffix = if excluded_count == 0 {
                    String::new()
                } else {
                    format!(", {excluded_count} excluded")
                };
                let source_id = source_ids
                    .first()
                    .cloned()
                    .unwrap_or_else(|| self.sources.default_source_id().to_string());
                Ok(TaskDispatchReport {
                    task_id: task.id,
                    source_id,
                    operation: "search".to_string(),
                    message: format!(
                        "search completed with {total} merged result(s){excluded_suffix}{failure_suffix}"
                    ),
                    total: Some(total),
                    done: Some(total),
                    failed: Some(source_errors.len() as u32),
                    output: Some(TaskOutput::SearchResults {
                        source_ids,
                        source_errors,
                        excluded_tags,
                        excluded_count,
                        next_search_page: Some(2),
                        has_more: !results.is_empty(),
                        loading_more: false,
                        load_more_error: None,
                        results,
                    }),
                })
            }
            TaskPayload::Gallery(request) => {
                let source_id = self.sources.resolve_source_id(request.source_id.as_deref());
                self.sources
                    .require_capability(&source_id, SourceCapability::Gallery)?;
                self.sources
                    .require_capability(&source_id, SourceCapability::Download)?;
                let adapter = self.sources.adapter(&source_id)?;
                adapter.download_gallery(request).await.map(|report| {
                    let total = report
                        .page_count
                        .unwrap_or_else(|| report.done + report.skipped + report.failed);
                    let message = format!(
                        "downloaded {} page(s), skipped {}, failed {} -> {}",
                        report.done, report.skipped, report.failed, report.output_folder
                    );
                    let output = TaskOutput::GalleryDownload {
                        source_id: report.source_id,
                        gallery_url: report.gallery_url,
                        title: report.title,
                        output_folder: report.output_folder,
                        page_count: report.page_count,
                        done: report.done,
                        skipped: report.skipped,
                        failed: report.failed,
                        stopped: report.stopped,
                    };
                    TaskDispatchReport {
                        task_id: task.id,
                        source_id,
                        operation: "gallery".to_string(),
                        message,
                        total: Some(total),
                        done: Some(report.done + report.skipped),
                        failed: Some(report.failed),
                        output: Some(output),
                    }
                })
            }
            TaskPayload::RetryFolder(request) => {
                let source_id = self.sources.resolve_source_id(request.source_id.as_deref());
                self.sources
                    .require_capability(&source_id, SourceCapability::RetryFolder)?;
                let adapter = self.sources.adapter(&source_id)?;
                adapter.retry_folder(request).await.map(|plan| {
                    let total = plan.page_indexes.len() as u32;
                    let output = TaskOutput::RetryPlan {
                        source_id: plan.source_id,
                        folder: plan.folder,
                        page_indexes: plan.page_indexes,
                    };
                    TaskDispatchReport {
                        task_id: task.id,
                        source_id,
                        operation: "retry_folder".to_string(),
                        message: format!("retry plan completed with {total} page(s)"),
                        total: Some(total),
                        done: Some(total),
                        failed: Some(0),
                        output: Some(output),
                    }
                })
            }
        }
    }
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

fn uploaded_at_timestamp_millis(value: &str) -> Option<i64> {
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

struct SourceSearchRun {
    results: Vec<TaskSearchResult>,
    excluded_count: u32,
}

fn configured_concurrency(name: &str, fallback: usize, maximum: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(fallback)
        .clamp(1, maximum)
}

fn normalize_tag(value: &str) -> String {
    value
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn normalized_tag_value(value: &str) -> String {
    let normalized = normalize_tag(value);
    normalized
        .split_once(':')
        .map_or_else(|| normalized.clone(), |(_, value)| value.trim().to_string())
}

fn search_result_matches_excluded_tags(
    title: &str,
    tags: &[String],
    excluded_tags: &[String],
) -> bool {
    let normalized_tags = tags
        .iter()
        .map(|tag| normalize_tag(tag))
        .collect::<Vec<_>>();
    let normalized_title = normalize_tag(title);
    excluded_tags.iter().any(|excluded_tag| {
        let excluded = normalize_tag(excluded_tag);
        let excluded_value = normalized_tag_value(&excluded);
        let tag_match = normalized_tags.iter().any(|tag| {
            tag == &excluded
                || (!excluded.contains(':') && normalized_tag_value(tag) == excluded_value)
        });
        tag_match
            || (normalized_tags.is_empty()
                && excluded_value.chars().count() >= 2
                && normalized_title.contains(&excluded_value))
    })
}

#[cfg(test)]
mod tests {
    use super::{sort_search_results_by_newest, uploaded_at_timestamp_millis};
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
        let sorted = sort_search_results_by_newest(vec![
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
    fn accepts_bridge_and_iso_timestamp_formats() {
        assert_eq!(
            uploaded_at_timestamp_millis("2026-07-28 03:45"),
            uploaded_at_timestamp_millis("2026-07-28T03:45:00Z")
        );
        assert!(uploaded_at_timestamp_millis("").is_none());
        assert!(uploaded_at_timestamp_millis("not-a-date").is_none());
    }
}
