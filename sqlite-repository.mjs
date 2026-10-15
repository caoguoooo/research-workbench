import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';

export function createSQLiteRepository(dataRoot, normalize = value => value) {
  let db;
  let ready;
  function readRecords() {
    const records = db.prepare('SELECT payload FROM competitors ORDER BY rowid').all().map(row => JSON.parse(row.payload));
    const byId = new Map(records.map(item => [item.id, item]));
    for (const item of records) { item.floorplans = []; item.visits = []; item.files = []; }
    for (const table of ['floorplans', 'visits', 'files']) {
      for (const row of db.prepare(`SELECT project_id, payload FROM ${table} ORDER BY position`).all()) byId.get(row.project_id)[table].push(JSON.parse(row.payload));
    }
    const archive = { version: 1, competitors: records };
    const state = db.prepare("SELECT payload FROM archive_state WHERE id = 'researchTasks'").get();
    if (state) archive.researchTasks = JSON.parse(state.payload);
    return normalize(archive);
  }
  function writeRecords(archive) {
    if (archive.researchTasks) db.prepare("INSERT INTO archive_state(id, payload) VALUES ('researchTasks', ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(archive.researchTasks));
    db.exec('DELETE FROM files; DELETE FROM floorplans; DELETE FROM visits; DELETE FROM competitors;');
    const project = db.prepare('INSERT INTO competitors(id, name, city, deleted_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)');
    const floorplan = db.prepare('INSERT INTO floorplans(project_id, id, position, payload) VALUES (?, ?, ?, ?)');
    const visit = db.prepare('INSERT INTO visits(project_id, id, visited_at, position, payload) VALUES (?, ?, ?, ?, ?)');
    const file = db.prepare('INSERT INTO files(id, project_id, category, stored_name, visit_id, floorplan_id, position, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const item of archive.competitors) {
      const { floorplans, visits, files, ...fields } = item;
      project.run(item.id, item.name, item.city || '', item.deletedAt || null, item.updatedAt, JSON.stringify(fields));
      floorplans.forEach((slot, index) => floorplan.run(item.id, slot.id, index, JSON.stringify(slot)));
      visits.forEach((record, index) => visit.run(item.id, record.id, record.visitedAt, index, JSON.stringify(record)));
      files.forEach((record, index) => file.run(record.id, item.id, record.category, record.storedName, record.visitId || null, record.category === '户型图' ? record.slotId || null : null, index, JSON.stringify(record)));
    }
  }
  async function initialize() {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const filename = path.join(dataRoot, 'workbench.sqlite');
    db = new DatabaseSync(filename);
    await chmod(filename, 0o600);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_state(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS competitors(id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, deleted_at TEXT, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS competitors_city ON competitors(city, deleted_at);
      CREATE TABLE IF NOT EXISTS floorplans(project_id TEXT NOT NULL REFERENCES competitors(id), id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id, id));
      CREATE TABLE IF NOT EXISTS visits(project_id TEXT NOT NULL REFERENCES competitors(id), id TEXT NOT NULL, visited_at TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id, id));
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES competitors(id), category TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, visit_id TEXT, floorplan_id TEXT, position INTEGER NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY(project_id, visit_id) REFERENCES visits(project_id, id), FOREIGN KEY(project_id, floorplan_id) REFERENCES floorplans(project_id, id));
      CREATE INDEX IF NOT EXISTS files_project_category ON files(project_id, category);
    `);
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()) {
      let legacy = { version: 1, competitors: [] };
      try { legacy = normalize(JSON.parse(await readFile(path.join(dataRoot, 'competitors.json'), 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      db.exec('BEGIN IMMEDIATE');
      try {
        // Check again while holding the write lock, for concurrent first starts.
        if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()) {
          writeRecords(legacy);
          db.prepare('INSERT INTO schema_migrations VALUES(1, ?)').run(new Date().toISOString());
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  function ensureReady() { return ready ||= initialize(); }
  return {
    async initialize() { await ensureReady(); },
    async read() {
      await ensureReady();
      db.exec('BEGIN');
      try { const archive = readRecords(); db.exec('COMMIT'); return archive; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async mutate(change) {
      await ensureReady();
      // The read and write are in one transaction, preventing lost updates across processes.
      db.exec('BEGIN IMMEDIATE');
      try {
        const archive = readRecords();
        const result = change(archive.competitors, archive);
        writeRecords(archive);
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async close() { if (ready) { await ready; db.close(); } }
  };
}
