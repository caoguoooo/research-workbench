import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMapSettingsStore, createMapService, toGCJ02, toWGS84 } from '../map-service.mjs';

test('map settings keep keys on the server, survive reopening, and clear explicitly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-map-settings-'));
  try {
    const store = createMapSettingsStore(dir), key = 'a'.repeat(32);
    assert.deepEqual(await store.getPublic(), { configured: false });
    assert.deepEqual(await store.save({ key }), { configured: true });
    assert.equal((await stat(path.join(dir, 'map-settings.json'))).mode & 0o777, 0o600);
    await store.save({ key: '' });
    assert.equal((await createMapSettingsStore(dir).getCredentials()).key, key);
    await assert.rejects(store.save({ key: 'invalid' }), /32 位/);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'map-settings.json'))).key, key);
    await store.save({ clear: true }); assert.deepEqual(await store.getPublic(), { configured: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('GCJ-02 and WGS84 conversions round-trip without moving overseas coordinates', () => {
  const a = { lat: 29.7, lng: 106.5 }, b = toGCJ02(a), c = toWGS84(b);
  assert.ok(Math.abs(b.lng - a.lng) > .001);
  assert.ok(Math.abs(c.lng - a.lng) < .000001 && Math.abs(c.lat - a.lat) < .000001);
  assert.deepEqual(toGCJ02({ lat: 48.85, lng: 2.35 }), { lat: 48.85, lng: 2.35 });
});

test('AMap project search and four nearby categories use fixed hosts and normalize coordinates', async () => {
  const calls = [], key = 'b'.repeat(32);
  const service = createMapService(async () => ({ key }), async url => {
    calls.push(url); return Response.json({ status: '1', pois: [{ id: 'B0001', name: '测试项目', location: '106.5,29.7', pname: '重庆市', cityname: [], adname: '两江新区', address: '测试地址' }, { name: '无坐标' }] });
  });
  const result = await service.search({ name: '测试项目', city: '重庆' });
  assert.equal(calls[0].origin, 'https://restapi.amap.com'); assert.equal(calls[0].searchParams.get('key'), key);
  assert.equal(result.places.length, 1); assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(result.places[0].sourceUrl, 'https://www.amap.com/place/B0001');
  const nearby = await service.nearby({ amenities: { location: result.places[0].location } });
  assert.deepEqual(nearby.places.map(p => p.category), ['transport', 'education', 'shopping', 'medical']);
  assert.equal(calls.length, 5); assert.equal(calls[1].searchParams.get('radius'), '2000');
  assert.ok(Math.abs(Number(calls[1].searchParams.get('location').split(',')[0]) - 106.5) < .000001);
});

test('map lookup rejects missing settings, redacts provider errors and disallows concurrent requests', async () => {
  const item = { name: '测试项目', city: '重庆' };
  await assert.rejects(createMapService(async () => ({}), () => assert.fail('No network')).search(item), /设置中/);
  await assert.rejects(createMapService(async () => ({ key: 'private' }), async () => { throw new Error('private URL'); }).search(item), /暂时无法连接/);
  await assert.rejects(createMapService(async () => ({ key: 'private' }), async () => Response.json({ status: '0', infocode: '10001', info: 'private' })).search(item), /Key 无效/);
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const service = createMapService(async () => ({ key: 'private' }), () => pending);
  const first = service.search(item);
  await assert.rejects(service.search(item), error => error.status === 429);
  complete(Response.json({ status: '1', pois: [] })); await first;
  await assert.rejects(service.nearby({}), /先定位/);
});
