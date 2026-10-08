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
