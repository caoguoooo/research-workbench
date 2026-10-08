import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(tmpdir(), 'workbench-competitors-'));
process.env.WORKBENCH_DATA_DIR = dataDir;
const archive = await import('../competitor-store.mjs');
after(() => rm(dataDir, { recursive: true, force: true }));

test('楼盘、踩盘记录和附件元数据可以连续保存并重新读取', async () => {
  const item = await archive.createCompetitor({ name: '测试楼盘', city: '上海', district: '浦东' });
  assert.equal(item.floorplans.length, 3);
  const visit = await archive.addVisit(item.id, { visitedAt: '2026-09-29', observer: '测试人员', priceSummary: '测试价格' });
  await archive.updateCompetitor(item.id, { name: '测试楼盘', city: '上海', district: '浦东', positioning: '改善型住宅' });
  await archive.updateVisit(item.id, visit.id, { visitedAt: '2026-09-29', observer: '测试人员', priceSummary: '更新后的价格' });
  await archive.addFile(item.id, { id: 'file-1', name: '现场照片.png', category: '踩盘照片', type: 'image/png', size: 1234, storedName: 'file-1.bin', visitId: visit.id });

  const saved = await archive.getCompetitor(item.id);
  assert.equal(saved.positioning, '改善型住宅');
  assert.equal(saved.visits[0].priceSummary, '更新后的价格');
  assert.equal(saved.files[0].visitId, visit.id);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'competitors.json'), 'utf8')).competitors.length, 1);
});

test('每个楼盘有三个户型位置，图纸与位置一一对应', async () => {
  const item = (await archive.listCompetitors())[0];
  const slot = item.floorplans[0];
  await archive.updateFloorplan(item.id, slot.id, { label: 'A 户型', area: '约 105㎡', rooms: '三室两厅' });
  await archive.addFile(item.id, { id: 'floorplan-file', name: 'A户型.png', category: '户型图', slotId: slot.id, type: 'image/png', size: 800, storedName: `${item.id}/floorplans/${slot.id}/floorplan-file.bin` });
  await archive.addFile(item.id, { id: 'masterplan-file', name: '总规划.png', category: '总规划', slotId: 'masterplan', type: 'image/png', size: 900, storedName: `${item.id}/masterplan/masterplan-file.bin` });
  const extra = await archive.addFloorplan(item.id, { label: 'D 户型', area: '约 130㎡' });
  const saved = await archive.getCompetitor(item.id);
  assert.equal(saved.floorplans.length, 4);
  assert.equal(saved.floorplans[0].area, '约 105㎡');
  assert.equal(saved.files.find(file => file.id === 'floorplan-file').slotId, slot.id);
  assert.equal(saved.files.find(file => file.id === 'masterplan-file').slotId, 'masterplan');
  assert.equal(extra.label, 'D 户型');
  await assert.rejects(archive.addFile(item.id, { id: 'bad', name: '错误.png', category: '户型图', slotId: 'other', type: 'image/png', size: 1, storedName: 'bad.bin' }), /户型位置/);
});

test('旧档案缺少户型位置时仍显示三个默认户型', async () => {
  const archivePath = path.join(dataDir, 'competitors.json');
  const data = JSON.parse(await readFile(archivePath, 'utf8'));
  delete data.competitors[0].floorplans;
  data.competitors[0].files.push({ id: 'legacy-floorplan', name: '旧户型图.png', category: '户型图', slotId: null, type: 'image/png', size: 100, storedName: 'legacy.bin', uploadedAt: '2026-09-29T00:00:00.000Z' });
  await writeFile(archivePath, JSON.stringify(data));
  const restored = await archive.getCompetitor(data.competitors[0].id);
  assert.equal(restored.floorplans.length, 3);
  assert.equal(restored.files.find(file => file.id === 'legacy-floorplan').slotId, 'floorplan-02');
});

test('并发创建不会丢失档案，非法日期不会写入', async () => {
  await Promise.all([
    archive.createCompetitor({ name: '竞品 A' }),
    archive.createCompetitor({ name: '竞品 B' })
  ]);
  const items = await archive.listCompetitors();
  assert.equal(items.length, 3);
  assert.throws(() => archive.addVisit(items[0].id, { visitedAt: '2026-02-31' }), /日期格式/);
  assert.equal((await archive.getCompetitor(items[0].id)).visits.length, 0);
});

test('删除档案移入回收站，恢复后户型、踩盘及文件关联完整保留', async () => {
  const before = (await archive.listCompetitors()).find(item => item.name === '测试楼盘');
  await archive.deleteCompetitor(before.id);
  assert.ok(!(await archive.listCompetitors()).some(item => item.id === before.id));
  const deleted = (await archive.listCompetitors({ deletedOnly: true })).find(item => item.id === before.id);
  assert.ok(deleted.deletedAt);
  assert.deepEqual(deleted.files, before.files);
  assert.deepEqual(deleted.visits, before.visits);
  await assert.rejects(archive.getCompetitor(before.id), /找不到/);
  await assert.rejects(archive.addFloorplan(before.id, { label: '不应保存' }), /找不到/);
  await archive.restoreCompetitor(before.id);
  const restored = await archive.getCompetitor(before.id);
  assert.equal(restored.deletedAt, undefined);
  assert.deepEqual(restored.files, before.files);
  assert.deepEqual(restored.visits, before.visits);
  assert.deepEqual(restored.floorplans, before.floorplans);
  assert.equal((await archive.listCompetitors({ deletedOnly: true })).length, 0);
});
