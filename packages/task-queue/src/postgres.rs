use std::{sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use comic_platform_domain::{Task, TaskId, TaskKind};
use serde_json::Value;
use sqlx::{PgPool, Row, postgres::PgPoolOptions};

use crate::{QueueError, QueueFuture, QueueResult, TaskQueue, TaskQueueMessage};

const CREATE_TASK_QUEUE_SQL: &str = include_str!("../migrations/0001_create_task_queue.sql");
const DEFAULT_POLL_INTERVAL_MS: u64 = 500;
const DEFAULT_LEASE_SECONDS: i32 = 120;
const MAX_RETRY_DELAY_SECONDS: u64 = 300;

#[derive(Clone)]
pub struct PostgresTaskQueue {
    pool: PgPool,
    consumer_id: Arc<str>,
    poll_interval: Duration,
    lease_seconds: i32,
}

impl PostgresTaskQueue {
    pub async fn connect_from_env() -> QueueResult<Self> {
        let database_url = std::env::var("DATABASE_URL").map_err(|_| {
            QueueError::publish_failed("DATABASE_URL is required when TASK_QUEUE_BACKEND=postgres")
        })?;
        Self::connect(&database_url).await
    }

    pub async fn connect(database_url: &str) -> QueueResult<Self> {
        if database_url.trim().is_empty() {
            return Err(QueueError::publish_failed("database URL cannot be empty"));
        }
        let pool = PgPoolOptions::new()
            .max_connections(env_u32("TASK_QUEUE_MAX_CONNECTIONS", 5))
            .connect(database_url)
            .await
            .map_err(|error| {
                QueueError::publish_failed(format!(
                    "failed to connect task queue database: {error}"
                ))
            })?;
        sqlx::raw_sql(CREATE_TASK_QUEUE_SQL)
            .execute(&pool)
            .await
            .map_err(|error| {
                QueueError::publish_failed(format!(
                    "failed to initialize task queue schema: {error}"
                ))
            })?;

        Ok(Self {
            pool,
            consumer_id: Arc::from(consumer_id()),
            poll_interval: Duration::from_millis(env_u64(
                "TASK_QUEUE_POLL_INTERVAL_MS",
                DEFAULT_POLL_INTERVAL_MS,
            )),
            lease_seconds: env_i32("TASK_QUEUE_LEASE_SECONDS", DEFAULT_LEASE_SECONDS).max(10),
        })
    }

    async fn claim_next(&self) -> QueueResult<Option<TaskQueueMessage>> {
        let mut transaction = self.pool.begin().await.map_err(receive_error)?;
        let row = sqlx::query(
            r#"
            SELECT message_id, task_id, kind, task, attempt, queued_at
            FROM task_queue_messages
            WHERE available_at <= NOW()
              AND (leased_until IS NULL OR leased_until < NOW())
            ORDER BY available_at ASC, message_id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
            "#,
        )
        .fetch_optional(&mut *transaction)
        .await
        .map_err(receive_error)?;

        let Some(row) = row else {
            transaction.commit().await.map_err(receive_error)?;
            return Ok(None);
        };

        let message_id: i64 = row.try_get("message_id").map_err(receive_error)?;
        sqlx::query(
            r#"
            UPDATE task_queue_messages
            SET leased_by = $1,
                leased_until = NOW() + make_interval(secs => $2)
            WHERE message_id = $3
            "#,
        )
        .bind(self.consumer_id.as_ref())
        .bind(self.lease_seconds)
        .bind(message_id)
        .execute(&mut *transaction)
        .await
        .map_err(receive_error)?;
        transaction.commit().await.map_err(receive_error)?;

        row_to_message(&row)
    }
}

impl TaskQueue for PostgresTaskQueue {
    fn enqueue<'a>(&'a self, task: Task) -> QueueFuture<'a, TaskQueueMessage> {
        Box::pin(async move {
            let message = TaskQueueMessage::new(task);
            let task_json = serde_json::to_value(&message.task).map_err(|error| {
                QueueError::publish_failed(format!("failed to serialize queued task: {error}"))
            })?;
            let result = sqlx::query(
                r#"
                INSERT INTO task_queue_messages (
                    task_id, kind, task, attempt, queued_at, available_at
                )
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (task_id) DO NOTHING
                "#,
            )
            .bind(&message.task_id)
            .bind(message.kind.as_str())
            .bind(task_json)
            .bind(i32::try_from(message.attempt).unwrap_or(i32::MAX))
            .bind(message.queued_at)
            .execute(&self.pool)
            .await
            .map_err(|error| QueueError::publish_failed(error.to_string()))?;

            if result.rows_affected() == 0 {
                return Err(QueueError::publish_failed(format!(
                    "task is already queued: {}",
                    message.task_id
                )));
            }
            Ok(message)
        })
    }

    fn receive<'a>(&'a self) -> QueueFuture<'a, Option<TaskQueueMessage>> {
        Box::pin(async move {
            loop {
                if let Some(message) = self.claim_next().await? {
                    return Ok(Some(message));
                }
                tokio::time::sleep(self.poll_interval).await;
            }
        })
    }

    fn ack<'a>(&'a self, message: &'a TaskQueueMessage) -> QueueFuture<'a, ()> {
        Box::pin(async move {
            let result = sqlx::query(
                "DELETE FROM task_queue_messages WHERE task_id = $1 AND leased_by = $2",
            )
            .bind(&message.task_id)
            .bind(self.consumer_id.as_ref())
            .execute(&self.pool)
            .await
            .map_err(|error| QueueError::publish_failed(format!("failed to ack task: {error}")))?;
            if result.rows_affected() == 0 {
                return Err(QueueError::publish_failed(format!(
                    "task lease was lost before ack: {}",
                    message.task_id
                )));
            }
            Ok(())
        })
    }

    fn retry<'a>(
        &'a self,
        message: TaskQueueMessage,
        reason: String,
        delay: Duration,
    ) -> QueueFuture<'a, ()> {
        Box::pin(async move {
            let next = message.next_attempt();
            let requested_delay = delay
                .as_secs()
                .saturating_add(u64::from(delay.subsec_nanos() > 0));
            let delay_seconds = retry_delay_seconds(next.attempt).max(requested_delay);
            let task_json = serde_json::to_value(&next.task).map_err(|error| {
                QueueError::publish_failed(format!("failed to serialize retried task: {error}"))
            })?;
            let result = sqlx::query(
                r#"
                UPDATE task_queue_messages
                SET task = $1,
                    attempt = $2,
                    queued_at = NOW(),
                    available_at = NOW() + make_interval(secs => $3),
                    leased_by = NULL,
                    leased_until = NULL,
                    last_error = $4
                WHERE task_id = $5 AND leased_by = $6
                "#,
            )
            .bind(task_json)
            .bind(i32::try_from(next.attempt).unwrap_or(i32::MAX))
            .bind(i32::try_from(delay_seconds).unwrap_or(i32::MAX))
            .bind(reason)
            .bind(&next.task_id)
            .bind(self.consumer_id.as_ref())
            .execute(&self.pool)
            .await
            .map_err(|error| {
                QueueError::publish_failed(format!("failed to retry task: {error}"))
            })?;
            if result.rows_affected() == 0 {
                return Err(QueueError::publish_failed(format!(
                    "task lease was lost before retry: {}",
                    next.task_id
                )));
            }
            Ok(())
        })
    }
}

fn row_to_message(row: &sqlx::postgres::PgRow) -> QueueResult<Option<TaskQueueMessage>> {
    let task_id: TaskId = row.try_get("task_id").map_err(receive_error)?;
    let kind_text: String = row.try_get("kind").map_err(receive_error)?;
    let kind = kind_text.parse::<TaskKind>().map_err(receive_error)?;
    let task_json: Value = row.try_get("task").map_err(receive_error)?;
    let task: Task = serde_json::from_value(task_json).map_err(receive_error)?;
    let attempt: i32 = row.try_get("attempt").map_err(receive_error)?;
    let queued_at: DateTime<Utc> = row.try_get("queued_at").map_err(receive_error)?;
    if task.id != task_id || task.kind != kind {
        return Err(QueueError::receive_failed(format!(
            "queued task envelope does not match payload: {task_id}"
        )));
    }
    Ok(Some(TaskQueueMessage {
        task_id,
        kind,
        task,
        attempt: u32::try_from(attempt).map_err(receive_error)?,
        queued_at,
    }))
}

fn retry_delay_seconds(attempt: u32) -> u64 {
    let exponent = attempt.saturating_sub(2).min(6);
    5_u64
        .saturating_mul(1_u64 << exponent)
        .min(MAX_RETRY_DELAY_SECONDS)
}

fn consumer_id() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "worker".to_string());
    let configured = std::env::var("TASK_QUEUE_CONSUMER_ID").unwrap_or_default();
    if configured.trim().is_empty() {
        format!("{host}-{}", std::process::id())
    } else {
        configured.trim().to_string()
    }
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn env_u32(name: &str, fallback: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn env_i32(name: &str, fallback: i32) -> i32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn receive_error(error: impl std::fmt::Display) -> QueueError {
    QueueError::receive_failed(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::retry_delay_seconds;

    #[test]
    fn retry_delay_is_bounded_exponential_backoff() {
        assert_eq!(retry_delay_seconds(2), 5);
        assert_eq!(retry_delay_seconds(3), 10);
        assert_eq!(retry_delay_seconds(8), 300);
        assert_eq!(retry_delay_seconds(100), 300);
    }
}
