import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { accountRecord, saveAccount } from '../auth-store.mjs';
import { runtimeConfig, validOrigin } from '../runtime-config.mjs';
import { DatabaseSync } from 'node:sqlite';

process.env.WORKBENCH_HOME_VISUAL = 'false';

const root = fileURLToPath(new URL('../', import.meta.url));
test('Production configuration supports no preset domain and optional fixed HTTPS origin', () => {
  const automatic = runtimeConfig({ NODE_ENV: 'production' });
  assert.equal(automatic.publicOrigin, '');
  const headers = { host: '127.0.0.1:8899', origin: 'https://any-domain.example', 'x-workbench-request': '1' };
  assert.equal(validOrigin({ headers }, automatic), true);
  assert.equal(validOrigin({ headers: { ...headers, 'x-workbench-request': undefined } }, automatic), false);
  assert.equal(validOrigin({ headers: { ...headers, 'sec-fetch-site': 'cross-site' } }, automatic), false);
  assert.equal(validOrigin({ headers: { ...headers, 'sec-fetch-site': 'same-site' } }, automatic), false);
  assert.equal(validOrigin({ headers: { ...headers, origin: 'null' } }, automatic), false);
  assert.equal(validOrigin({ headers: { ...headers, origin: 'http://any-domain.example' } }, automatic), false);
  assert.throws(() => runtimeConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://demo.example', WORKBENCH_ALLOW_EMPTY_PASSWORD: 'true' }), /空密码/);
  assert.throws(() => runtimeConfig({ HOST: '0.0.0.0', WORKBENCH_ALLOW_EMPTY_PASSWORD: 'true' }), /本机/);
  assert.throws(() => runtimeConfig({ PUBLIC_ORIGIN: 'http://demo.example' }), /HTTPS/);
  const config = runtimeConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://demo.example/' });
  assert.equal(validOrigin({ headers: { host: '127.0.0.1:3000', origin: 'https://demo.example' } }, config), true);
  assert.equal(validOrigin({ headers: { host: 'attacker.example', origin: 'https://attacker.example' } }, config), false);
  assert.equal(validOrigin({ headers: { 'sec-fetch-site': 'cross-site' } }, config), false);
});

test('Production startup refuses an uninitialized administrator', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-no-admin-'));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://demo.example', WORKBENCH_ALLOW_EMPTY_PASSWORD: 'false', WORKBENCH_DATA_DIR: dir, PORT: '39036' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', data => { output += data; });
  try { const [code] = await once(child, 'exit'); assert.equal(code, 1); assert.match(output, /初始化非空密码/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('Production end-to-end: login, archive, upload/range, trash, restart and backup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-production-'));
  const backups = await mkdtemp(path.join(tmpdir(), 'workbench-backup-'));
  const account = { username: 'production-user', password: 'qa8-pass' };
  await saveAccount(dir, accountRecord(account.username, account.password));
  const origin = 'https://demo.example';
  const base = 'http://127.0.0.1:39037';
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'production', PUBLIC_ORIGIN: '', WORKBENCH_ALLOW_EMPTY_PASSWORD: 'false', WORKBENCH_STORAGE: 'sqlite', WORKBENCH_DATA_DIR: dir, PORT: '39037' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited ${code}`))); });
  }
  async function stop() { if (child?.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
  let cookie;
  async function request(route, method = 'GET', body) {
    return fetch(base + route, { method, headers: { Origin: origin, 'X-Workbench-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  try {
    await start();
    assert.equal((await request('/healthz')).status, 200);
    assert.equal((await request('/api/competitors')).status, 401);
    assert.equal((await request('/api/home-visual')).status, 401);
    assert.equal((await request('/api/setup', 'POST', account)).status, 403);
    assert.equal((await request('/api/login', 'POST', { ...account, password: '' })).status, 401);
    const login = await request('/api/login', 'POST', account);
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /; Secure/);
    assert.doesNotMatch(login.headers.get('set-cookie'), /Max-Age=/);
    cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/home-visual')).status, 200);
    assert.equal((await request('/api/home-visual/image')).status, 404);
    const response = await request('/api/competitors', 'POST', { name: '上线测试楼盘', city: '成都' });
    assert.equal(response.status, 201);
    const { item } = await response.json();
    const visitResponse = await request(`/api/competitors/${item.id}/visits`, 'POST', { visitedAt: '2026-10-08', notes: '测试记录' });
    const { visit } = await visitResponse.json();
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6n8AAAAASUVORK5CYII=', 'base64');
    const query = new URLSearchParams({ name: '测试图片.png', category: '户型图', slotId: item.floorplans[0].id, visitId: visit.id });
    const uploaded = await fetch(`${base}/api/competitors/${item.id}/files?${query}`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-Workbench-Request': '1', 'Content-Type': 'image/png' }, body: bytes });
    assert.equal(uploaded.status, 201);
    const { file } = await uploaded.json();
    const url = `${base}/api/competitors/${item.id}/files/${file.id}`;
    assert.deepEqual(Buffer.from(await (await fetch(url, { headers: { Cookie: cookie } })).arrayBuffer()), bytes);
    const range = await fetch(url, { headers: { Cookie: cookie, Range: 'bytes=0-7' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 8));
    assert.equal((await fetch(url, { headers: { Cookie: cookie, Range: 'bytes=999999-' } })).status, 416);
    const injected = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    const originalPayload = injected.prepare('SELECT payload FROM files WHERE id=?').get(file.id).payload;
    injected.prepare('UPDATE files SET payload=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(originalPayload), storedName: '../auth.json' }), file.id);
    assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 404);
    injected.prepare('UPDATE files SET payload=? WHERE id=?').run(originalPayload, file.id);
    injected.close();
    assert.equal((await request(`/api/competitors/${item.id}`, 'DELETE')).status, 200);
    assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await (await request('/api/competitors')).json()).items.length, 0);
    assert.equal((await (await request('/api/competitors?deleted=true')).json()).items.length, 1);
    assert.equal((await request(`/api/competitors/${item.id}/restore`, 'POST', {})).status, 200);
    const oversized = await fetch(`${base}/api/competitors/${item.id}/files?name=large.bin&category=其他`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-Workbench-Request': '1', 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(25 * 1024 * 1024 + 1) });
    assert.equal(oversized.status, 413);
    assert.equal((await fetch(base + '/api/competitors', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/api/competitors', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'X-Workbench-Request': '1', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const preflight = await fetch(base + '/api/login', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-workbench-request' } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    assert.equal(preflight.headers.get('access-control-allow-headers'), null);
    assert.equal((await request('/api/settings/ai', 'PATCH', { baseUrl: 'https://example.com/v1', token: 'test-backup-token' })).status, 200);
    assert.equal((await (await request('/api/settings/ai')).text()).includes('test-backup-token'), false);
    await stop();
    await start();
    assert.equal((await request('/api/competitors')).status, 401);
    const relogin = await request('/api/login', 'POST', account);
    cookie = relogin.headers.get('set-cookie').split(';')[0];
    const saved = (await (await request(`/api/competitors/${item.id}`)).json()).item;
    assert.equal(saved.files[0].visitId, visit.id);
    assert.equal(saved.files[0].slotId, item.floorplans[0].id);
    assert.deepEqual(Buffer.from(await (await fetch(url, { headers: { Cookie: cookie } })).arrayBuffer()), bytes);
    assert.equal((await request('/api/login', 'POST', { ...account, remember: 'true' })).status, 400);
    const rememberedLogin = await request('/api/login', 'POST', { ...account, remember: true });
    assert.equal(rememberedLogin.status, 200);
    assert.match(rememberedLogin.headers.get('set-cookie'), /Max-Age=604800/);
    cookie = rememberedLogin.headers.get('set-cookie').split(';')[0];
    await stop(); await start();
    assert.equal((await request('/api/competitors')).status, 200);
    assert.equal((await request('/api/logout', 'POST', {})).status, 200);
    assert.equal((await request('/api/competitors')).status, 401);
    await stop(); await start();
    assert.equal((await request('/api/competitors')).status, 401);
    await stop();
    const backup = spawn(process.execPath, ['scripts/backup.mjs'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: dir, WORKBENCH_BACKUP_DIR: backups }, stdio: ['ignore', 'pipe', 'pipe'] });
    const [code] = await once(backup, 'exit');
    assert.equal(code, 0);
    const folder = path.join(backups, (await readdir(backups))[0]);
    const db = new DatabaseSync(path.join(folder, 'workbench.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.close();
    assert.deepEqual(await readFile(path.join(folder, 'competitor-files', file.storedName)), bytes);
    assert.equal(JSON.parse(await readFile(path.join(folder, 'ai-settings.json'), 'utf8')).token, 'test-backup-token');
    await assert.rejects(readFile(path.join(folder, 'remembered-sessions.json')), error => error.code === 'ENOENT');
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); await rm(backups, { recursive: true, force: true }); }
});
