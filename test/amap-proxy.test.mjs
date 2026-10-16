import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMapSettingsStore } from '../map-service.mjs';
import { createAMapProxy, mapClientConfig } from '../amap-proxy.mjs';
import { amapPlaces, amapError } from '../amap-results.js';

test('JS API credentials preserve legacy settings, require a matching pair and never expose the security code', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-amap-'));
  try {
    const key = 'a'.repeat(32), jsKey = 'b'.repeat(32), securityJsCode = 'c'.repeat(32);
    await writeFile(path.join(dir, 'map-settings.json'), JSON.stringify({ key }));
    const store = createMapSettingsStore(dir);
    await assert.rejects(store.save({ jsKey }), /一起填写/);
    const result = await store.save({ jsKey, securityJsCode });
    assert.deepEqual(result, { configured: true, jsConfigured: true, jsKeyConfigured: true, securityConfigured: true });
    assert.equal(JSON.stringify(result).includes(securityJsCode), false);
    assert.equal((await stat(path.join(dir, 'map-settings.json'))).mode & 0o777, 0o600);
    assert.deepEqual(mapClientConfig(await store.getCredentials()), { configured: true, key: jsKey, serviceHost: '/_AMapService' });
    assert.equal(JSON.stringify(mapClientConfig(await store.getCredentials())).includes(securityJsCode), false);
    await store.save({ key: '', jsKey: '', securityJsCode: '' });
    assert.equal((await createMapSettingsStore(dir).getCredentials()).securityJsCode, securityJsCode);
    await assert.rejects(store.save({ jsKey: 'd'.repeat(32) }), /同时填写/);
    for (const value of [{ clearJS: 'true' }, { jsKey: 0 }, { securityJsCode: {} }, { securityJsCode: 'invalid' }]) await assert.rejects(store.save(value));
    await store.save({ clearJS: true });
    assert.deepEqual(mapClientConfig(await store.getCredentials()), { configured: false });
    assert.equal((await store.getCredentials()).key, key);
    await store.save({ jsKey, securityJsCode }); await store.save({ clear: true });
    assert.equal((await store.getPublic()).jsConfigured, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('same-origin proxy pins hosts and keys, forwards JSONP and preserves binary map tiles', async () => {
  const jsKey = 'b'.repeat(32), securityJsCode = 'c'.repeat(32), calls = [];
  const bytes = Buffer.from([255, 0, 194, 11, 44]);
  const proxy = createAMapProxy(async () => ({ jsKey, securityJsCode }), async (url, options) => {
    calls.push({ url, options });
    return url.pathname === '/v3/vectormap' ? new Response(bytes) : new Response('map_callback({"status":"1"})');
  });
  const result = await proxy(new URL(`https://work.example/_AMapService/v3/place/text?key=${jsKey}&jscode=attacker&callback=map_callback&keywords=重庆`));
  assert.equal(calls[0].url.origin, 'https://restapi.amap.com');
  assert.equal(calls[0].url.searchParams.get('jscode'), securityJsCode);
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers.Cookie, undefined);
  assert.match(result.type, /javascript/); assert.equal(result.body.toString(), 'map_callback({"status":"1"})');
  assert.equal(result.body.includes(Buffer.from(securityJsCode)), false);
  const tile = await proxy(new URL(`https://work.example/_AMapService/v3/vectormap?key=${jsKey}`));
  assert.deepEqual(tile.body, bytes);
  await proxy(new URL(`https://work.example/_AMapService/v4/map/styles2?key=${jsKey}`));
  assert.equal(calls.at(-1).url.origin, 'https://webapi.amap.com');
  for (const route of ['/v3/log/init', '/v3/ias/verify']) await proxy(new URL(`https://work.example/_AMapService${route}?key=${jsKey}`));
  for (const query of ['key=wrong', `key=${jsKey}&callback=alert(1)//`]) await assert.rejects(proxy(new URL('https://work.example/_AMapService/v3/place/text?' + query)));
  await assert.rejects(proxy(new URL(`https://work.example/_AMapService/v3/account/delete?key=${jsKey}`)), error => error.status === 404);
  assert.equal(calls.length, 5);
});

test('proxy rejects missing config, oversized or secret-reflecting upstream responses and redacts network errors', async () => {
  const credentials = { jsKey: 'b'.repeat(32), securityJsCode: 'c'.repeat(32) };
  const url = new URL(`https://example.test/_AMapService/v3/place/text?key=${credentials.jsKey}`);
  await assert.rejects(createAMapProxy(async () => ({}), () => assert.fail('No network'))(url), error => error.status === 409);
  for (const fetcher of [async () => { throw new Error(credentials.securityJsCode); }, async () => new Response(credentials.securityJsCode), async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), async () => new Response('', { status: 302 })]) {
    await assert.rejects(createAMapProxy(async () => credentials, fetcher)(url), error => error.status === 502 && !error.message.includes(credentials.securityJsCode));
  }
});

test('SDK POIs normalize GCJ-02 to archived WGS84 and provider errors never echo secrets', () => {
  const places = amapPlaces([{ id: 'B123', name: '测试楼盘', location: { getLng: () => 106.5, getLat: () => 29.7 }, cityname: '重庆', address: '测试地址' }, { name: '无坐标' }], 'project');
  assert.equal(places.length, 1); assert.ok(Math.abs(places[0].location.lng - 106.5) > .001);
  assert.equal(places[0].sourceUrl, 'https://www.amap.com/place/B123');
  assert.match(amapError('INVALID_USER_SCODE'), /安全密钥不匹配/);
  assert.match(amapError({ info: 'USERKEY_PLAT_NOMATCH' }), /类型不符/);
  assert.equal(amapError('secret-provider-message').includes('secret-provider-message'), false);
});
