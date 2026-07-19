CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    payload JSONB NOT NULL,
    progress JSONB NOT NULL,
    output JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at
    ON tasks (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_kind_created_at
    ON tasks (kind, created_at DESC);
