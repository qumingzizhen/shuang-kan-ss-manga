import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

export async function createDevApiStateStore(options) {
  const databaseFile = requiredText(options?.databaseFile, "databaseFile");
  await mkdir(dirname(databaseFile), { recursive: true });
  const store = new DevApiStateStore(databaseFile);
  store.initialize();
  store.migrateLegacyJson(options?.legacyFiles || {});
  return store;
}

export class DevApiStateStore {
  constructor(databaseFile) {
    this.databaseFile = databaseFile;
    this.database = new DatabaseSync(databaseFile);
  }

  initialize() {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS schema_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
        ON tasks(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_kind_created
        ON tasks(kind, created_at DESC);

      CREATE TABLE IF NOT EXISTS reader_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        gallery_url TEXT NOT NULL,
        last_read_at TEXT,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reader_sessions_recent
        ON reader_sessions(last_read_at DESC, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reader_sessions_source_gallery
        ON reader_sessions(source_id, gallery_url);

      CREATE TABLE IF NOT EXISTS library_shelf (
        id TEXT PRIMARY KEY NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        reading_status TEXT NOT NULL DEFAULT 'unread',
        updated_at TEXT,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_library_shelf_favorite_updated
        ON library_shelf(favorite DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_library_shelf_status_updated
        ON library_shelf(reading_status, updated_at DESC);
    `);
    this.setMetadata("schema_version", String(SCHEMA_VERSION));
  }

  migrateLegacyJson(legacyFiles) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.migrateLegacyTasks(legacyFiles.tasks);
      this.migrateLegacyReaderSessions(legacyFiles.readerSessions);
      this.migrateLegacyLibraryShelf(legacyFiles.libraryShelf);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  migrateLegacyTasks(filePath) {
    if (this.count("tasks") > 0 || this.getMetadata("legacy_tasks_imported")) {
      return;
    }
    const records = readLegacyJson(filePath, []);
    if (!Array.isArray(records)) {
      this.setMetadata("legacy_tasks_imported", "invalid");
      return;
    }
    this.saveTasks(records);
    this.setMetadata("legacy_tasks_imported", new Date().toISOString());
  }

  migrateLegacyReaderSessions(filePath) {
    if (this.count("reader_sessions") > 0 || this.getMetadata("legacy_reader_sessions_imported")) {
      return;
    }
    const records = readLegacyJson(filePath, []);
    if (!Array.isArray(records)) {
      this.setMetadata("legacy_reader_sessions_imported", "invalid");
      return;
    }
    this.replaceReaderSessions(records);
    this.setMetadata("legacy_reader_sessions_imported", new Date().toISOString());
  }

  migrateLegacyLibraryShelf(filePath) {
    if (this.count("library_shelf") > 0 || this.getMetadata("legacy_library_shelf_imported")) {
      return;
    }
    const records = readLegacyJson(filePath, {});
    if (!records || typeof records !== "object" || Array.isArray(records)) {
      this.setMetadata("legacy_library_shelf_imported", "invalid");
      return;
    }
    this.replaceLibraryShelf(Object.entries(records));
    this.setMetadata("legacy_library_shelf_imported", new Date().toISOString());
  }

  loadTasks() {
    return this.loadJsonRows("SELECT record_json FROM tasks ORDER BY created_at DESC");
  }

  saveTasks(tasks) {
    const statement = this.database.prepare(`
      INSERT INTO tasks(id, kind, status, created_at, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `);
    this.transaction(() => {
      for (const task of tasks || []) {
        if (!task || typeof task.id !== "string" || !task.id.trim()) {
          continue;
        }
        const now = new Date().toISOString();
        statement.run(
          task.id,
          textOr(task.kind, "search"),
          textOr(task.status, "failed"),
          textOr(task.created_at, now),
          textOr(task.updated_at, now),
          JSON.stringify(task),
        );
      }
    });
  }

  loadReaderSessions() {
    return this.loadJsonRows(
      "SELECT record_json FROM reader_sessions ORDER BY COALESCE(last_read_at, updated_at) DESC",
    );
  }

  replaceReaderSessions(sessions) {
    const statement = this.database.prepare(`
      INSERT INTO reader_sessions(id, source_id, gallery_url, last_read_at, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        gallery_url = excluded.gallery_url,
        last_read_at = excluded.last_read_at,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `);
    this.transaction(() => {
      this.database.exec("DELETE FROM reader_sessions");
      for (const session of sessions || []) {
        if (!session || typeof session.id !== "string" || !session.id.trim()) {
          continue;
        }
        const now = new Date().toISOString();
        statement.run(
          session.id,
          textOr(session.source_id, "unknown"),
          textOr(session.gallery_url, session.id),
          nullableText(session.last_read_at),
          textOr(session.updated_at, now),
          JSON.stringify(session),
        );
      }
    });
  }

  loadLibraryShelf() {
    return this.loadJsonRows("SELECT id, record_json FROM library_shelf ORDER BY id").map((row) => [
      row.id,
      row.value,
    ]);
  }

  replaceLibraryShelf(entries) {
    const statement = this.database.prepare(`
      INSERT INTO library_shelf(id, favorite, reading_status, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        favorite = excluded.favorite,
        reading_status = excluded.reading_status,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `);
    this.transaction(() => {
      this.database.exec("DELETE FROM library_shelf");
      for (const entry of entries || []) {
        const [id, value] = Array.isArray(entry) ? entry : [];
        if (typeof id !== "string" || !id.trim() || !value || typeof value !== "object") {
          continue;
        }
        statement.run(
          id,
          value.favorite ? 1 : 0,
          textOr(value.reading_status, "unread"),
          nullableText(value.updated_at),
          JSON.stringify(value),
        );
      }
    });
  }

  loadJsonRows(sql) {
    return this.database.prepare(sql).all().flatMap((row) => {
      try {
        const value = JSON.parse(row.record_json);
        return "id" in row ? [{ id: row.id, value }] : [value];
      } catch {
        return [];
      }
    });
  }

  count(table) {
    const allowedTables = new Set(["tasks", "reader_sessions", "library_shelf"]);
    if (!allowedTables.has(table)) {
      throw new Error(`Unsupported state table: ${table}`);
    }
    return Number(this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  }

  getMetadata(key) {
    return this.database.prepare("SELECT value FROM schema_metadata WHERE key = ?").get(key)?.value || null;
  }

  setMetadata(key, value) {
    this.database
      .prepare(
        "INSERT INTO schema_metadata(key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  transaction(callback) {
    const alreadyInTransaction = this.database.isTransaction;
    if (!alreadyInTransaction) {
      this.database.exec("BEGIN IMMEDIATE");
    }
    try {
      callback();
      if (!alreadyInTransaction) {
        this.database.exec("COMMIT");
      }
    } catch (error) {
      if (!alreadyInTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

function readLegacyJson(filePath, fallback) {
  if (!filePath || !existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`${name} is required`);
  }
  return text;
}

function textOr(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function nullableText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}
