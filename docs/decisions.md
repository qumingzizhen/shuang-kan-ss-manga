# Architecture Decisions

## ADR-001: Web-first platform

Decision: build a web platform first instead of a desktop app.

Reason: public usage, account management, admin workflows, task history, and deployment are all more natural on the web.

The backend must stay client-agnostic. Web, future mobile app, future desktop app, and future local agent should share the same core API, auth model, task system, event stream, and file library.

## ADR-002: Rust core services

Decision: use Rust with Axum and Tokio for the core API and workers.

Reason: the project is intentionally choosing a high-difficulty, high-ceiling stack for long-running concurrent services, task execution, and a future local agent.

## ADR-003: Queue-driven tasks

Decision: long-running downloads must run through queues and workers, not web request handlers.

Reason: download tasks need retries, pause/resume, observability, progress updates, and independent scaling.

## ADR-004: Source adapters

Decision: site-specific logic must live behind source adapters.

Reason: the product should support multiple sources without mixing parsing, downloading, and platform orchestration.
