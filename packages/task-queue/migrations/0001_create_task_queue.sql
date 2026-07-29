CREATE TABLE IF NOT EXISTS task_queue_messages (
    message_id BIGSERIAL PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    task JSONB NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    queued_at TIMESTAMPTZ NOT NULL,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    leased_by TEXT,
    leased_until TIMESTAMPTZ,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_queue_available
    ON task_queue_messages (available_at, message_id)
    WHERE leased_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_task_queue_claimable
    ON task_queue_messages (available_at, leased_until, message_id);
