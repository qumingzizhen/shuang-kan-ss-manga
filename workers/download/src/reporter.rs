use anyhow::{Context, anyhow};
use comic_platform_domain::{Task, TaskStatus};
use comic_platform_source_adapter::AdapterError;
use comic_platform_task_queue::TaskQueueMessage;
use comic_platform_task_runtime::{ReporterFuture, TaskDispatchReport, TaskReporter};
use sqlx::{PgPool, postgres::PgPoolOptions};

#[derive(Clone)]
pub struct PostgresTaskReporter {
    pool: PgPool,
}

impl PostgresTaskReporter {
    pub async fn connect_from_env() -> anyhow::Result<Self> {
        let database_url = std::env::var("DATABASE_URL")
            .context("DATABASE_URL is required for the PostgreSQL task reporter")?;
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&database_url)
            .await
            .context("failed to connect task reporter to PostgreSQL")?;
        Ok(Self { pool })
    }

    async fn persist(&self, task: &Task) -> anyhow::Result<()> {
        let progress = serde_json::to_value(&task.progress)?;
        let output = task.output.as_ref().map(serde_json::to_value).transpose()?;
        let result = sqlx::query(
            r#"
            UPDATE tasks
            SET status = $1, progress = $2, output = $3, updated_at = $4
            WHERE id = $5
            "#,
        )
        .bind(task.status.as_str())
        .bind(progress)
        .bind(output)
        .bind(task.updated_at)
        .bind(&task.id)
        .execute(&self.pool)
        .await
        .context("failed to persist worker task state")?;
        if result.rows_affected() == 0 {
            return Err(anyhow!("task reporter could not find task {}", task.id));
        }
        Ok(())
    }
}

impl TaskReporter for PostgresTaskReporter {
    fn task_started<'a>(&'a self, message: &'a TaskQueueMessage) -> ReporterFuture<'a, ()> {
        Box::pin(async move {
            let mut task = message.task.clone();
            task.update_status(TaskStatus::Running);
            task.progress.message = format!("running attempt {}", message.attempt);
            self.persist(&task).await
        })
    }

    fn task_retrying<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        error: &'a AdapterError,
        next_attempt: u32,
    ) -> ReporterFuture<'a, ()> {
        Box::pin(async move {
            let mut task = message.task.clone();
            task.update_status(TaskStatus::Queued);
            task.progress.message = format!("retrying attempt {next_attempt} after {}", error.code);
            self.persist(&task).await
        })
    }

    fn task_completed<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        report: &'a TaskDispatchReport,
    ) -> ReporterFuture<'a, ()> {
        Box::pin(async move {
            let mut task = message.task.clone();
            task.update_status(TaskStatus::Completed);
            task.progress.message = report.message.clone();
            task.progress.total = report.total.unwrap_or_else(|| task.progress.total.max(1));
            task.progress.failed = report.failed.unwrap_or(task.progress.failed);
            task.progress.done = report
                .done
                .unwrap_or_else(|| task.progress.total.saturating_sub(task.progress.failed));
            if let Some(output) = report.output.clone() {
                task.set_output(output);
            }
            self.persist(&task).await
        })
    }

    fn task_failed<'a>(
        &'a self,
        message: &'a TaskQueueMessage,
        error: &'a AdapterError,
    ) -> ReporterFuture<'a, ()> {
        Box::pin(async move {
            let mut task = message.task.clone();
            task.update_status(TaskStatus::Failed);
            task.progress.message = format!("{}: {}", error.code, error.message);
            task.progress.total = task.progress.total.max(1);
            task.progress.failed = task.progress.failed.max(1);
            self.persist(&task).await
        })
    }
}
