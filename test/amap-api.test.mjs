import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { accountRecord, saveAccount } from '../auth-store.mjs';

test('AMap settings, client bootstrap and proxy require login; only the map frame gets SDK-specific CSP', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-amap-api-'));
  await saveAccount(dir, accountRecord('map-admin', 'map88888'));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '39139', PUBLIC_ORIGIN: '', WORKBENCH_ALLOW_EMPTY_PASSWORD: 'false', WORKBENCH_STORAGE: 'json', WORKBENCH_DATA_DIR: dir, WORKBENCH_HOME_VISUAL: 'false', WORKBENCH_TRUST_PROXY: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = 'http://127.0.0.1:39139'; let cookie;
  const request = (route, method = 'GET', body, extra = {}) => fetch(base + route, { method, headers: { Origin: 'https://work.example:8888', 'X-Workbench-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`server exit ${code}`))); });
    for (const route of ['/api/maps/client', '/_AMapService/v3/place/text?key=wrong', '/amap-frame', '/amap-frame.js']) assert.equal((await request(route)).status, 401);
    const login = await request('/api/login', 'POST', { username: 'map-admin', password: 'map88888' });
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
    const key = 'a'.repeat(32), jsKey = 'b'.repeat(32), securityJsCode = 'c'.repeat(32);
    const saved = await request('/api/settings/maps', 'PATCH', { key, jsKey, securityJsCode });
    assert.equal(saved.status, 200); assert.equal((await saved.text()).includes(securityJsCode), false);
    const config = await (await request('/api/maps/client')).json();
    assert.deepEqual(config, { configured: true, key: jsKey, serviceHost: '/_AMapService' });
    const app = await request('/app'); assert.doesNotMatch(app.headers.get('content-security-policy'), /unsafe-eval|amap\.com/);
    const frame = await request('/amap-frame');
    assert.equal(frame.status, 200); assert.equal(frame.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(frame.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.match(frame.headers.get('content-security-policy'), /https:\/\/webapi.amap.com/);
    assert.equal(frame.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal((await frame.text()).includes(securityJsCode), false);
    for (const route of ['/amap-frame.js', '/amap-bridge.js', '/amap-results.js', '/map-coordinates.js']) assert.equal((await request(route)).status, 200);
    assert.equal((await request('/_AMapService/v3/place/text?key=wrong')).status, 409);
    assert.equal((await request('/_AMapService/v3/account/delete?key=' + jsKey)).status, 404);
    assert.equal((await request('/_AMapService/v3/place/text?key=' + jsKey, 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await request('/_AMapService/v3/place/text?key=' + jsKey, 'GET', undefined, { Origin: 'null' })).status, 403);
    assert.equal((await request('/api/settings/maps', 'PATCH', { clearJS: true })).status, 200);
    assert.deepEqual(await (await request('/api/maps/client')).json(), { configured: false });
    assert.equal((await (await request('/api/settings/maps')).json()).configured, true);
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    await rm(dir, { recursive: true, force: true });
  }
});
