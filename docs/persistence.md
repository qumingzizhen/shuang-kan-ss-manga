# Persistence

## Modes

The API supports two task repository modes:

| Mode | Configuration | Status |
|---|---|---|
| Memory | `TASK_REPOSITORY=memory` | Default, checked locally |
| PostgreSQL | `TASK_REPOSITORY=postgres` with `--features postgres` | Repository implemented, project-local server verified with `psql` |

## PostgreSQL

The API runs `services/api/migrations/0001_create_tasks.sql` automatically when:

```text
TASK_REPOSITORY=postgres
API_AUTO_MIGRATE=true
```

This workspace can run PostgreSQL without Docker by using the project-local
Windows binaries under `.tools\postgresql-17.10` and data under
`.data\postgres`:

```powershell
.\scripts\postgres.ps1 start
```

The script prints the environment values needed by the API:

```powershell
$env:TASK_REPOSITORY="postgres"
$env:API_AUTO_MIGRATE="true"
$env:DATABASE_URL="postgres://manga:manga@localhost:5432/manga?sslmode=disable"
.\.cache\cargo\bin\cargo.exe run -p comic-platform-api --features postgres
```

Other useful commands:

```powershell
.\scripts\postgres.ps1 status
.\scripts\postgres.ps1 psql
.\scripts\postgres.ps1 stop
```

On this Chinese-path Windows workspace, `scripts/postgres.ps1` automatically
uses a temporary ASCII `subst` drive for PostgreSQL paths while still storing
the files under this project on D drive.

Verified locally:

- `psql` connects to `manga` as user `manga`.
- `services/api/migrations/0001_create_tasks.sql` creates the `tasks` table.
- `.\scripts\check.ps1` passes in the default in-memory mode.

Current compiler boundary: `cargo check -p comic-platform-api --features postgres`
still hits the local Windows Rust linker setup (`dlltool` under the GNU toolchain).
A Docker/Linux build host, Visual Studio Build Tools, or a complete MinGW/MSVC
toolchain should be used for live API runtime verification.
