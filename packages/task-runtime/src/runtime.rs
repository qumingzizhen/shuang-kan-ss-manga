use std::{future::Future, pin::Pin, sync::Arc};

use anyhow::Context;
use comic_platform_source_adapter::AdapterError;
use comic_platform_task_queue::{TaskQueue, TaskQueueMessage};

use crate::dispatcher::{TaskDispatchReport, TaskDispatcher};

pub type ReporterFuture<'a, T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'a>>;

pub trait TaskReporter: Send + Sync {
    fn task_started<'a>(&'a self, message: &'a TaskQueueMessage) -> ReporterFuture<'a, ()>;

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
}

impl WorkerRuntime {
    pub fn new(
        queue: Arc<dyn TaskQueue>,
        dispatcher: TaskDispatcher,
        reporter: Arc<dyn TaskReporter>,
    ) -> Self {
        Self {
            queue,
            dispatcher,
            reporter,
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
