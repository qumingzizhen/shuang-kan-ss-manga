use std::sync::Arc;

use anyhow::Context;
use comic_platform_domain::{Task, TaskStatus};
use comic_platform_source_adapter::AdapterError;
use comic_platform_task_queue::{TaskQueue, TaskQueueMessage};
use comic_platform_task_runtime::{
    ReporterFuture, TaskDispatchReport, TaskDispatcher, TaskReporter, WorkerRuntime,
};

use crate::state::AppState;

pub fn start_local_worker_if_enabled(state: AppState) -> bool {
    if !local_worker_enabled() {
        tracing::info!("API local worker disabled");
        return false;
    }

    let queue: Arc<dyn TaskQueue> = Arc::new(state.queue.clone());
    let dispatcher = TaskDispatcher::new(state.sources.clone());
    let reporter = Arc::new(RepositoryTaskReporter::new(state));
    let runtime = WorkerRuntime::new(queue, dispatcher, reporter);

    tokio::spawn(async move {
        if let Err(error) = runtime.run_forever().await {
            tracing::error!(error = %error, "API local worker stopped");
        }
    });

    tracing::info!("API local worker started for in-memory task execution");
    true
}

fn local_worker_enabled() -> bool {
    std::env::var("API_LOCAL_WORKER")
        .map(|value| !matches!(value.as_str(), "0" | "false" | "False" | "FALSE"))
        .unwrap_or(true)
}

#[derive(Clone)]
struct RepositoryTaskReporter {
    state: AppState,
}

impl RepositoryTaskReporter {
    fn new(state: AppState) -> Self {
        Self { state }
    }

    async fn load_mutable_task(&self, message: &TaskQueueMessage) -> anyhow::Result<Option<Task>> {
        let task = self
            .state
            .tasks
            .get(&message.task_id)
            .await
            .context("failed to load task for local worker report")?
            .unwrap_or_else(|| message.task.clone());

        if matches!(
            task.status,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Canceled
        ) {
            return Ok(None);
        }

        Ok(Some(task))
    }
}

impl TaskReporter for RepositoryTaskReporter {
    fn task_started<'a>(&'a self, message: &'a TaskQueueMessage) -> ReporterFuture<'a, ()> {
        let reporter = self.clone();
        let message = message.clone();
        Box::pin(async move {
            let Some(mut task) = reporter.load_mutable_task(&message).await? else {
                return Ok(());
            };

            task.update_status(TaskStatus::Running);
            task.progress.message = format!("running attempt {}", message.attempt);
            let task = reporter
                .state
                .tasks
                .update(task)
                .await
                .context("failed to mark task as running")?;
            reporter.state.publisher.publish_task_started(&task).await;
            Ok(())
        })
    }

    fn task_completed<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        report: &'a TaskDispatchReport,
    ) -> ReporterFuture<'a, ()> {
        let reporter = self.clone();
        let message = message.clone();
        let summary = report.message.clone();
        let total = report.total;
        let done = report.done;
        let failed = report.failed;
        let output = report.output.clone();
        Box::pin(async move {
            let Some(mut task) = reporter.load_mutable_task(&message).await? else {
                return Ok(());
            };

            task.update_status(TaskStatus::Completed);
            task.progress.message = summary;
            task.progress.total = total.unwrap_or_else(|| task.progress.total.max(1));
            task.progress.failed = failed.unwrap_or(task.progress.failed);
            task.progress.done = done
                .or_else(|| Some(task.progress.total.saturating_sub(task.progress.failed)))
                .unwrap_or(1);
            if let Some(output) = output {
                task.set_output(output);
            }

            let task = reporter
                .state
                .tasks
                .update(task)
                .await
                .context("failed to mark task as completed")?;
            reporter.state.publisher.publish_task_completed(&task).await;
            Ok(())
        })
    }

    fn task_failed<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        error: &'a AdapterError,
    ) -> ReporterFuture<'a, ()> {
        let reporter = self.clone();
        let message = message.clone();
        let error_message = error.to_string();
        Box::pin(async move {
            let Some(mut task) = reporter.load_mutable_task(&message).await? else {
                return Ok(());
            };

            task.update_status(TaskStatus::Failed);
            task.progress.message = error_message;
            if task.progress.total == 0 {
                task.progress.total = 1;
            }
            if task.progress.failed == 0 {
                task.progress.failed = 1;
            }

            let task = reporter
                .state
                .tasks
                .update(task)
                .await
                .context("failed to mark task as failed")?;
            reporter.state.publisher.publish_task_failed(&task).await;
            Ok(())
        })
    }
}
