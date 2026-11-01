import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSQLiteRepository } from '../sqlite-repository.mjs';

function project(id) {
  return { id, name: '旧档案', city: '成都', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z',
    floorplans: [{ id: 'floorplan-01', label: 'A' }, { id: 'floorplan-02', label: 'B' }, { id: 'floorplan-03', label: 'C' }],
    visits: [{ id: 'v1', visitedAt: '2026-10-08', notes: '实地记录' }],
    files: [{ id: 'f1', category: '户型图', storedName: `${id}/floorplans/floorplan-01/f1.bin`, slotId: 'floorplan-01', visitId: 'v1', name: '原图.png' }]
  };
}
test('SQLite migrates legacy IDs and file relationships once, and survives reopening', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-sqlite-'));
  let store;
  try {
    const legacy = { version: 1, competitors: [project('p1')] };
    await writeFile(path.join(dir, 'competitors.json'), JSON.stringify(legacy));
    store = createSQLiteRepository(dir);
    assert.deepEqual(await store.read(), legacy);
    await store.mutate(items => { items[0].name = '正式资料'; items[0].deletedAt = '2026-10-08T01:00:00Z'; });
    await store.close();
    store = createSQLiteRepository(dir);
    const persisted = await store.read();
    assert.equal(persisted.competitors[0].name, '正式资料');
    assert.equal(persisted.competitors[0].deletedAt, '2026-10-08T01:00:00Z');
    assert.deepEqual(persisted.competitors[0].files, legacy.competitors[0].files);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'competitors.json'), 'utf8')), legacy);
    const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT stored_name FROM files WHERE id=?').get('f1').stored_name, legacy.competitors[0].files[0].storedName);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.close();
  } finally { if (store) await store.close(); await rm(dir, { recursive: true, force: true }); }
});
test('SQLite transactions roll back invalid relations and serialize multiple writers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-sqlite-writes-'));
  const a = createSQLiteRepository(dir);
  const b = createSQLiteRepository(dir);
  try {
    await a.mutate(items => items.push(project('p1')));
    await b.initialize();
    await assert.rejects(a.mutate(items => { items[0].name = '不应写入'; items[0].files[0].visitId = 'missing'; }), /FOREIGN KEY/);
    assert.equal((await b.read()).competitors[0].name, '旧档案');
    await Promise.all([
      a.mutate(items => { const item = project('p2'); item.files = []; item.visits = []; items.push(item); }),
      b.mutate(items => { const item = project('p3'); item.files = []; item.visits = []; items.push(item); })
    ]);
    assert.equal((await a.read()).competitors.length, 3);
  } finally { await a.close(); await b.close(); await rm(dir, { recursive: true, force: true }); }
});

test('SQLite changes only modified rows and preserves child ordering and relations', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-sqlite-incremental-'));
  const store = createSQLiteRepository(dir);
  let observer;
  try {
    await store.mutate(items => { items.push(project('p1')); const other = project('p2'); other.files[0].id = 'f2'; items.push(other); });
    observer = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    observer.exec('CREATE TABLE changes(table_name TEXT, operation TEXT, record_id TEXT)');
    for (const table of ['competitors', 'floorplans', 'visits', 'files']) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      observer.exec(`CREATE TRIGGER observe_${table}_${operation} AFTER ${operation} ON ${table} BEGIN INSERT INTO changes VALUES ('${table}', '${operation}', ${operation === 'DELETE' ? 'old' : 'new'}.id); END`);
    }
    await store.mutate(items => { items[0].name = 'Updated'; });
    assert.deepEqual(observer.prepare('SELECT * FROM changes').all().map(row => ({ ...row })), [{ table_name: 'competitors', operation: 'UPDATE', record_id: 'p1' }]);
    observer.exec('DELETE FROM changes');
    await store.mutate(() => {});
    assert.equal(observer.prepare('SELECT COUNT(*) AS count FROM changes').get().count, 0);
    await store.mutate((items, archive) => {
      items[0].files[0].slotId = 'floorplan-02';
      items[0].floorplans = items[0].floorplans.slice(1).reverse();
      archive.researchTasks = { retained: true };
    });
    const saved = await store.read();
    assert.deepEqual(saved.competitors[0].floorplans.map(slot => slot.id), ['floorplan-03', 'floorplan-02']);
    assert.equal(saved.competitors[0].files[0].slotId, 'floorplan-02');
    assert.deepEqual(saved.researchTasks, { retained: true });
    await store.mutate((items, archive) => { items.splice(0, 1); delete archive.researchTasks; });
    assert.deepEqual((await store.read()).competitors.map(item => item.id), ['p2']);
    assert.equal((await store.read()).researchTasks, undefined);
    await assert.rejects(store.mutate(items => items.push(structuredClone(items[0]))), /Duplicate/);
    assert.equal(observer.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { observer?.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('SQLite persists normalized legacy slots and file links before comparing incremental changes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-sqlite-normalization-'));
  let store = createSQLiteRepository(dir), observer;
  try {
    const legacy = project('legacy');
    legacy.floorplans = legacy.floorplans.slice(0, 1);
    delete legacy.files[0].slotId;
    await store.mutate(items => items.push(legacy));
    await store.close();
    store = createSQLiteRepository(dir, archive => ({ ...archive, competitors: archive.competitors.map(item => ({
      ...item,
      floorplans: [1, 2, 3].map(number => item.floorplans.find(slot => slot.id === `floorplan-0${number}`) || { id: `floorplan-0${number}`, label: `户型 ${number}` }),
      files: item.files.map(file => file.category === '户型图' && !file.slotId ? { ...file, slotId: 'floorplan-02' } : file)
    })) }));
    assert.equal((await store.read()).competitors[0].floorplans.length, 3);
    await store.mutate(items => { items[0].name = '已编辑的旧档案'; });
    observer = new DatabaseSync(path.join(dir, 'workbench.sqlite'), { readOnly: true });
    assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM floorplans').get().n, 3);
    assert.equal(observer.prepare('SELECT floorplan_id FROM files WHERE id = ?').get('f1').floorplan_id, 'floorplan-02');
    await store.mutate(items => items[0].files.push({ id: 'f-new', category: '户型图', storedName: 'legacy/new.bin', slotId: 'floorplan-03', name: '新户型.png' }));
    assert.equal((await store.read()).competitors[0].files.length, 2);
    assert.deepEqual(observer.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { observer?.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});
