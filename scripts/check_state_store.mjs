import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDevApiStateStore } from "../services/dev-api/state-store.mjs";

const root = await mkdtemp(join(tmpdir(), "manga-state-store-"));
const databaseFile = join(root, "state.sqlite3");
const tasksFile = join(root, "tasks.json");
const sessionsFile = join(root, "reader-sessions.json");
const shelfFile = join(root, "library-shelf.json");
const now = "2026-07-28T00:00:00.000Z";

try {
  await writeFile(
    tasksFile,
    JSON.stringify([
      {
        id: "task-1",
        kind: "gallery",
        status: "running",
        title: "resume me",
        payload: { type: "gallery", source_id: "fixture", gallery_url: "https://example.test/g/1" },
        progress: { total: 2, done: 1, failed: 0, message: "running" },
        output: null,
        created_at: now,
        updated_at: now,
      },
    ]),
    "utf8",
  );
  await writeFile(
    sessionsFile,
    JSON.stringify([
      {
        id: "session-1",
        source_id: "fixture",
        gallery_url: "https://example.test/g/1",
        updated_at: now,
      },
    ]),
    "utf8",
  );
  await writeFile(
    shelfFile,
    JSON.stringify({ "library-1": { favorite: true, reading_status: "reading", updated_at: now } }),
    "utf8",
  );

  let store = await createDevApiStateStore({
    databaseFile,
    legacyFiles: { tasks: tasksFile, readerSessions: sessionsFile, libraryShelf: shelfFile },
  });
  assert.equal(store.loadTasks().length, 1, "legacy task should migrate");
  assert.equal(store.loadReaderSessions().length, 1, "legacy reader session should migrate");
  assert.equal(store.loadLibraryShelf().length, 1, "legacy shelf item should migrate");

  const updatedTask = { ...store.loadTasks()[0], status: "completed", updated_at: "2026-07-28T01:00:00.000Z" };
  store.saveTasks([updatedTask]);
  store.replaceReaderSessions([]);
  store.replaceLibraryShelf([["library-2", { favorite: false, reading_status: "completed", updated_at: now }]]);
  store.close();

  store = await createDevApiStateStore({
    databaseFile,
    legacyFiles: { tasks: tasksFile, readerSessions: sessionsFile, libraryShelf: shelfFile },
  });
  assert.equal(store.loadTasks()[0].status, "completed", "SQLite state must win over unchanged legacy JSON");
  assert.deepEqual(store.loadReaderSessions(), [], "reader session deletion should persist transactionally");
  assert.equal(store.loadLibraryShelf()[0][0], "library-2", "shelf replacement should persist");
  store.close();

  assert.equal(JSON.parse(await readFile(tasksFile, "utf8"))[0].status, "running", "migration must preserve legacy file");
  console.log(JSON.stringify({ ok: true, databaseFile, migrated: true, reopened: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
