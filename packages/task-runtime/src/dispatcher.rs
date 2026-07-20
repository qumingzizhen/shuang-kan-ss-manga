use std::collections::HashSet;

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
