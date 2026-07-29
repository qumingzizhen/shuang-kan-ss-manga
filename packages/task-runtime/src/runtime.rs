use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use anyhow::Context;
use comic_platform_source_adapter::AdapterError;
use comic_platform_task_queue::{TaskQueue, TaskQueueMessage};

use crate::dispatcher::{TaskDispatchReport, TaskDispatcher};

pub type ReporterFuture<'a, T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'a>>;

pub trait TaskReporter: Send + Sync {
    fn task_started<'a>(&'a self, message: &'a TaskQueueMessage) -> ReporterFuture<'a, ()>;

    fn task_retrying<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        error: &'a AdapterError,
        next_attempt: u32,
    ) -> ReporterFuture<'a, ()>;

    fn task_completed<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        report: &'a TaskDispatchReport,
    ) -> ReporterFuture<'a, ()>;

    fn task_failed<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        error: &'a AdapterError,
    ) -> ReporterFuture<'a, ()>;
}

#[derive(Clone, Default)]
pub struct TracingTaskReporter;

impl TaskReporter for TracingTaskReporter {
    fn task_started<'a>(&'a self, message: &'a TaskQueueMessage) -> ReporterFuture<'a, ()> {
        Box::pin(async move {
            tracing::info!(
                task_id = %message.task_id,
                kind = ?message.kind,
                attempt = message.attempt,
                "task dispatch started"
            );
            Ok(())
        })
    }

    fn task_retrying<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        error: &'a AdapterError,
        next_attempt: u32,
    ) -> ReporterFuture<'a, ()> {
        Box::pin(async move {
            tracing::warn!(
                task_id = %message.task_id,
                kind = ?message.kind,
                attempt = message.attempt,
                next_attempt,
                error_code = %error.code,
                error = %error,
                "task dispatch will retry"
            );
            Ok(())
        })
    }

    fn task_completed<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        report: &'a TaskDispatchReport,
    ) -> ReporterFuture<'a, ()> {
        Box::pin(async move {
            tracing::info!(
                task_id = %message.task_id,
                source_id = %report.source_id,
                operation = %report.operation,
                "task dispatch completed"
            );
            Ok(())
        })
    }

    fn task_failed<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        error: &'a AdapterError,
    ) -> ReporterFuture<'a, ()> {
        Box::pin(async move {
            tracing::warn!(
                task_id = %message.task_id,
                kind = ?message.kind,
                attempt = message.attempt,
                error = %error,
                "task dispatch failed"
            );
            Ok(())
        })
    }
}

pub struct WorkerRuntime {
    queue: Arc<dyn TaskQueue>,
    dispatcher: TaskDispatcher,
    reporter: Arc<dyn TaskReporter>,
    max_attempts: u32,
}

impl WorkerRuntime {
    pub fn new(
        queue: Arc<dyn TaskQueue>,
        dispatcher: TaskDispatcher,
        reporter: Arc<dyn TaskReporter>,
    ) -> Self {
        let max_attempts = std::env::var("WORKER_MAX_ATTEMPTS")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(3)
            .max(1);
        Self {
            queue,
            dispatcher,
            reporter,
            max_attempts,
        }
    }

    pub async fn run_forever(&self) -> anyhow::Result<()> {
        loop {
            match self
                .queue
                .receive()
                .await
                .context("failed to receive task")?
            {
                Some(message) => self.handle_message(message).await?,
                None => {
                    tracing::warn!("task queue closed; worker runtime is stopping");
                    return Ok(());
                }
            }
        }
    }

    async fn handle_message(&self, message: TaskQueueMessage) -> anyhow::Result<()> {
        self.reporter.task_started(&message).await?;

        match self.dispatcher.dispatch(message.task.clone()).await {
            Ok(report) => self.complete_message(&message, &report).await,
            Err(error) if error.retryable && message.attempt < self.max_attempts => {
                self.retry_message(message, &error).await
            }
            Err(error) => self.fail_message(&message, &error).await,
        }
    }

    async fn complete_message(
        &self,
        message: &TaskQueueMessage,
        report: &TaskDispatchReport,
    ) -> anyhow::Result<()> {
        self.reporter.task_completed(message, report).await?;
        self.queue
            .ack(message)
            .await
            .context("failed to ack task")?;
        Ok(())
    }

    async fn retry_message(
        &self,
        message: TaskQueueMessage,
        error: &AdapterError,
    ) -> anyhow::Result<()> {
        let next_attempt = message.attempt.saturating_add(1);
        self.reporter
            .task_retrying(&message, error, next_attempt)
            .await?;
        self.queue
            .retry(
                message,
                format!("{}: {}", error.code, error.message),
                Duration::from_millis(error.retry_after_ms.unwrap_or(0)),
            )
            .await
            .context("failed to retry task")?;
        Ok(())
    }

    async fn fail_message(
        &self,
        message: &TaskQueueMessage,
        error: &AdapterError,
    ) -> anyhow::Result<()> {
        self.reporter.task_failed(message, error).await?;
        self.queue
            .ack(message)
            .await
            .context("failed to ack failed task")?;
        Ok(())
    }
}
