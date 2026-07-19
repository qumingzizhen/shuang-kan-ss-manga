use comic_platform_domain::{
    CreateGalleryTaskRequest, SourceCapability, Task, TaskOutput, TaskPayload, TaskSearchResult,
};
use comic_platform_source_adapter::{AdapterResult, SourceAdapterRegistry};

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
                let source_id = self.sources.resolve_source_id(request.source_id.as_deref());
                let excluded_tags = request.excluded_tags.clone();
                self.sources
                    .require_capability(&source_id, SourceCapability::Search)?;
                let adapter = self.sources.adapter(&source_id)?;
                let mut source_results = adapter.search(request).await?;
                if !excluded_tags.is_empty() {
                    for item in &mut source_results {
                        if item.tags.is_empty() {
                            if let Ok(metadata) = adapter
                                .read_gallery(CreateGalleryTaskRequest {
                                    source_id: Some(source_id.clone()),
                                    gallery_url: item.gallery_url.clone(),
                                })
                                .await
                            {
                                item.tags = metadata.tags;
                            }
                        }
                    }
                }
                let results = source_results
                    .into_iter()
                    .filter(|item| {
                        !search_result_matches_excluded_tags(
                            &item.title,
                            &item.tags,
                            &excluded_tags,
                        )
                    })
                    .map(|item| TaskSearchResult {
                        source_id: item.source_id,
                        gallery_url: item.gallery_url,
                        title: item.title,
                        tags: item.tags,
                    })
                    .collect::<Vec<_>>();
                let total = results.len() as u32;
                Ok(TaskDispatchReport {
                    task_id: task.id,
                    source_id,
                    operation: "search".to_string(),
                    message: format!("search completed with {total} result(s)"),
                    total: Some(total),
                    done: Some(total),
                    failed: Some(0),
                    output: Some(TaskOutput::SearchResults { results }),
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
