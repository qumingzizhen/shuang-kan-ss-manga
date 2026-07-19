#[cfg(feature = "postgres")]
use std::str::FromStr;
use std::{collections::HashMap, sync::Arc};

#[cfg(feature = "postgres")]
use anyhow::Context;
use anyhow::{Result, anyhow};
#[cfg(feature = "postgres")]
use chrono::{DateTime, Utc};
use comic_platform_domain::{Task, TaskId};
#[cfg(feature = "postgres")]
use comic_platform_domain::{TaskKind, TaskOutput, TaskPayload, TaskProgress, TaskStatus};
#[cfg(feature = "postgres")]
use serde_json::Value;
#[cfg(feature = "postgres")]
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use tokio::sync::RwLock;

#[cfg(feature = "postgres")]
const CREATE_TASKS_SQL: &str = include_str!("../migrations/0001_create_tasks.sql");
#[cfg(feature = "postgres")]
const ADD_TASK_OUTPUT_SQL: &str = include_str!("../migrations/0002_add_task_output.sql");

#[derive(Clone)]
pub enum TaskRepository {
    Memory(MemoryTaskRepository),
    #[cfg(feature = "postgres")]
    Postgres(PostgresTaskRepository),
}

impl Default for TaskRepository {
    fn default() -> Self {
        Self::Memory(MemoryTaskRepository::default())
    }
}

impl TaskRepository {
    pub async fn from_env() -> Result<Self> {
        let mode = std::env::var("TASK_REPOSITORY").unwrap_or_else(|_| "memory".to_string());
        match mode.to_ascii_lowercase().as_str() {
            "memory" => {
                tracing::info!("using in-memory task repository");
                Ok(Self::default())
            }
            "postgres" | "postgresql" => build_postgres_repository().await,
            other => Err(anyhow!("unknown TASK_REPOSITORY value: {other}")),
        }
    }

    pub async fn insert(&self, task: Task) -> Result<Task> {
        match self {
            Self::Memory(repository) => repository.insert(task).await,
            #[cfg(feature = "postgres")]
            Self::Postgres(repository) => repository.insert(task).await,
        }
    }

    pub async fn update(&self, task: Task) -> Result<Task> {
        match self {
            Self::Memory(repository) => repository.update(task).await,
            #[cfg(feature = "postgres")]
            Self::Postgres(repository) => repository.update(task).await,
        }
    }

    pub async fn get(&self, id: &TaskId) -> Result<Option<Task>> {
        match self {
            Self::Memory(repository) => repository.get(id).await,
            #[cfg(feature = "postgres")]
            Self::Postgres(repository) => repository.get(id).await,
        }
    }

    pub async fn list(&self) -> Result<Vec<Task>> {
        match self {
            Self::Memory(repository) => repository.list().await,
            #[cfg(feature = "postgres")]
            Self::Postgres(repository) => repository.list().await,
        }
    }
}

#[cfg(feature = "postgres")]
async fn build_postgres_repository() -> Result<TaskRepository> {
    tracing::info!("using PostgreSQL task repository");
    let repository = PostgresTaskRepository::connect_from_env().await?;
    Ok(TaskRepository::Postgres(repository))
}

#[cfg(not(feature = "postgres"))]
async fn build_postgres_repository() -> Result<TaskRepository> {
    Err(anyhow!(
        "TASK_REPOSITORY=postgres requires building comic-platform-api with --features postgres"
    ))
}

#[derive(Clone, Default)]
pub struct MemoryTaskRepository {
    tasks: Arc<RwLock<HashMap<TaskId, Task>>>,
}

impl MemoryTaskRepository {
    async fn insert(&self, task: Task) -> Result<Task> {
        self.tasks
            .write()
            .await
            .insert(task.id.clone(), task.clone());
        Ok(task)
    }

    async fn update(&self, task: Task) -> Result<Task> {
        let mut tasks = self.tasks.write().await;
        if !tasks.contains_key(&task.id) {
            return Err(anyhow!("task not found"));
        }
        tasks.insert(task.id.clone(), task.clone());
        Ok(task)
    }

    async fn get(&self, id: &TaskId) -> Result<Option<Task>> {
        Ok(self.tasks.read().await.get(id).cloned())
    }

    async fn list(&self) -> Result<Vec<Task>> {
        let tasks = self.tasks.read().await;
        let mut values: Vec<Task> = tasks.values().cloned().collect();
        values.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(values)
    }
}

#[cfg(feature = "postgres")]
#[derive(Clone)]
pub struct PostgresTaskRepository {
    pool: PgPool,
}

#[cfg(feature = "postgres")]
impl PostgresTaskRepository {
    async fn connect_from_env() -> Result<Self> {
        let database_url = std::env::var("DATABASE_URL")
            .context("DATABASE_URL is required for PostgreSQL mode")?;
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(&database_url)
            .await
            .context("failed to connect to PostgreSQL")?;

        let auto_migrate = std::env::var("API_AUTO_MIGRATE")
            .map(|value| value != "false" && value != "0")
            .unwrap_or(true);
        if auto_migrate {
            tracing::info!("running API database migrations");
            for (name, sql) in [
                ("0001_create_tasks", CREATE_TASKS_SQL),
                ("0002_add_task_output", ADD_TASK_OUTPUT_SQL),
            ] {
                sqlx::raw_sql(sql)
                    .execute(&pool)
                    .await
                    .with_context(|| format!("failed to run {name} migration"))?;
            }
        }

        Ok(Self { pool })
    }

    async fn insert(&self, task: Task) -> Result<Task> {
        let payload = serde_json::to_value(&task.payload)?;
        let progress = serde_json::to_value(&task.progress)?;
        let output = task.output.as_ref().map(serde_json::to_value).transpose()?;
        let row = sqlx::query(
            r#"
            INSERT INTO tasks (
                id, kind, status, title, payload, progress, output, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, kind, status, title, payload, progress, output, created_at, updated_at
            "#,
        )
        .bind(&task.id)
        .bind(task.kind.as_str())
        .bind(task.status.as_str())
        .bind(&task.title)
        .bind(payload)
        .bind(progress)
        .bind(output)
        .bind(task.created_at)
        .bind(task.updated_at)
        .fetch_one(&self.pool)
        .await
        .context("failed to insert task")?;

        row_to_task(&row)
    }

    async fn get(&self, id: &TaskId) -> Result<Option<Task>> {
        let row = sqlx::query(
            r#"
            SELECT id, kind, status, title, payload, progress, output, created_at, updated_at
            FROM tasks
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("failed to get task")?;

        row.map(|row| row_to_task(&row)).transpose()
    }

    async fn update(&self, task: Task) -> Result<Task> {
        let payload = serde_json::to_value(&task.payload)?;
        let progress = serde_json::to_value(&task.progress)?;
        let output = task.output.as_ref().map(serde_json::to_value).transpose()?;
        let row = sqlx::query(
            r#"
            UPDATE tasks
            SET status = $2,
                title = $3,
                payload = $4,
                progress = $5,
                output = $6,
                updated_at = $7
            WHERE id = $1
            RETURNING id, kind, status, title, payload, progress, output, created_at, updated_at
            "#,
        )
        .bind(&task.id)
        .bind(task.status.as_str())
        .bind(&task.title)
        .bind(payload)
        .bind(progress)
        .bind(output)
        .bind(task.updated_at)
        .fetch_optional(&self.pool)
        .await
        .context("failed to update task")?
        .ok_or_else(|| anyhow!("task not found"))?;

        row_to_task(&row)
    }

    async fn list(&self) -> Result<Vec<Task>> {
        let rows = sqlx::query(
            r#"
            SELECT id, kind, status, title, payload, progress, output, created_at, updated_at
            FROM tasks
            ORDER BY created_at DESC
            LIMIT 200
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to list tasks")?;

        rows.iter().map(row_to_task).collect()
    }
}

#[cfg(feature = "postgres")]
fn row_to_task(row: &sqlx::postgres::PgRow) -> Result<Task> {
    let kind_text: String = row.try_get("kind")?;
    let status_text: String = row.try_get("status")?;
    let payload: Value = row.try_get("payload")?;
    let progress: Value = row.try_get("progress")?;
    let output: Option<Value> = row.try_get("output")?;

    Ok(Task {
        id: row.try_get("id")?,
        kind: TaskKind::from_str(&kind_text).map_err(|message| anyhow!(message))?,
        status: TaskStatus::from_str(&status_text).map_err(|message| anyhow!(message))?,
        title: row.try_get("title")?,
        payload: serde_json::from_value::<TaskPayload>(payload)?,
        progress: serde_json::from_value::<TaskProgress>(progress)?,
        output: output
            .map(serde_json::from_value::<TaskOutput>)
            .transpose()?,
        created_at: row.try_get::<DateTime<Utc>, _>("created_at")?,
        updated_at: row.try_get::<DateTime<Utc>, _>("updated_at")?,
    })
}
