# Stack

| Component | Main Language | Foundation / Ecosystem |
|---|---|---|
| Web console | TypeScript | Next.js, React, browser Web APIs |
| UI layer | TypeScript | Tailwind-style CSS, lucide-react |
| API service | Rust | Axum, Tokio, Tower |
| Worker runtime | Rust | Tokio, queue clients, filesystem |
| Shared domain | Rust | serde, chrono, uuid |
| Rust toolchain | Rust | stable-x86_64-pc-windows-gnu, rust-lld, project-local Cargo/Rustup cache |
| Local verification | PowerShell | `scripts/check.ps1`, `cargo check`, `next build` |
| Database | C | PostgreSQL |
| Cache / rate limit | C | Redis |
| Queue | Go | NATS JetStream |
| Object storage | Go | MinIO / S3-compatible storage |
| Search | Rust | Meilisearch |
| Future plugin sandbox | Rust / WASM | Wasmtime or subprocess isolation |
| Legacy adapter bridge | Python + C | CPython and existing crawler libraries |
