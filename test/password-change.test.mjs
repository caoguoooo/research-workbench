import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountRecord, saveAccount, verifyPassword } from '../auth-store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(port) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-password-'));
  const account = { username: 'password-test', password: 'qa8-pass' };
  await saveAccount(dir, accountRecord(account.username, account.password));
  let child;
  async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), WORKBENCH_STORAGE: 'sqlite', WORKBENCH_DATA_DIR: dir, WORKBENCH_ALLOW_EMPTY_PASSWORD: 'false', WORKBENCH_HOME_VISUAL: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`server exit ${code}`))); });
  }
  const request = (route, body, cookie, extraHeaders = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET', headers: { Origin: 'https://demo.example', 'X-Workbench-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {})
  });
  async function login(password = account.password, remember = true) { const response = await request('/api/login', { username: account.username, password, remember }); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0]; }
  await start();
  return { dir, account, request, login, start, stop, async close() { await stop(); await rm(dir, { recursive: true, force: true }); } };
}

test('password change verifies current password, protects origin, revokes every session and preserves data across restart', async () => {
  const f = await fixture(39044);
  try {
    const change = { currentPassword: f.account.password, newPassword: 'changed8', confirmPassword: 'changed8' };
    assert.equal((await f.request('/api/account/password', change)).status, 401);
    const first = await f.login(); const second = await f.login(); const normal = await f.login(f.account.password, false);
    assert.equal((await f.request('/api/account/password', change, first, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const before = await readFile(path.join(f.dir, 'auth.json'), 'utf8');
    for (const input of [{ ...change, currentPassword: 'wrong888' }, { ...change, newPassword: 'short', confirmPassword: 'short' }, { ...change, confirmPassword: 'different' }, { ...change, newPassword: f.account.password, confirmPassword: f.account.password }]) assert.equal((await f.request('/api/account/password', input, first)).status, 400);
    assert.equal(await readFile(path.join(f.dir, 'auth.json'), 'utf8'), before);
    await f.request('/api/competitors', { name: '资料保留测试' }, first);
    const aiResponse = await fetch('http://127.0.0.1:39044/api/settings/ai', { method: 'PATCH', headers: { Cookie: first, Origin: 'https://demo.example', 'X-Workbench-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: 'https://example.com/v1', token: 'password-test-only-token' }) });
    assert.equal(aiResponse.status, 200);
    const settings = await readFile(path.join(f.dir, 'ai-settings.json'), 'utf8');
    const result = await f.request('/api/account/password', change, first);
    assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie'), /Max-Age=0/); assert.match(result.headers.get('set-cookie'), /Secure/);
    for (const cookie of [first, second, normal]) assert.equal((await f.request('/api/competitors', null, cookie)).status, 401);
    assert.equal((await f.request('/api/login', { ...f.account, remember: true })).status, 401);
    const updated = JSON.parse(await readFile(path.join(f.dir, 'auth.json'), 'utf8'));
    assert.equal(verifyPassword(updated, change.newPassword), true);
    assert.equal(JSON.stringify(updated).includes(change.newPassword), false);
    assert.equal(await readFile(path.join(f.dir, 'ai-settings.json'), 'utf8'), settings);
    await f.stop(); await f.start();
    assert.equal((await f.request('/api/competitors', null, second)).status, 401);
    const renewed = await f.login(change.newPassword);
    assert.equal((await (await f.request('/api/competitors', null, renewed)).json()).items[0].name, '资料保留测试');
  } finally { await f.close(); }
});

test('concurrent password changes and old-password logins cannot mint a session for the new credential', async () => {
  const f = await fixture(39045);
  try {
    const cookie = await f.login();
    const choices = ['changeA8', 'changeB8'];
    const results = await Promise.all(choices.map(newPassword => f.request('/api/account/password', { currentPassword: f.account.password, newPassword, confirmPassword: newPassword }, cookie)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
    const current = choices[results.findIndex(r => r.status === 200)];
    const newCookie = await f.login(current);
    const [change, oldLogin] = await Promise.all([
      f.request('/api/account/password', { currentPassword: current, newPassword: 'finalpw8', confirmPassword: 'finalpw8' }, newCookie),
      f.request('/api/login', { username: f.account.username, password: current, remember: true })
    ]);
    assert.equal(change.status, 200);
    if (oldLogin.status === 200) assert.equal((await f.request('/api/competitors', null, oldLogin.headers.get('set-cookie').split(';')[0])).status, 401);
    else assert.equal(oldLogin.status, 401);
    await f.login('finalpw8');
  } finally { await f.close(); }
});

test('wrong current-password attempts are limited for the account', async () => {
  const f = await fixture(39046);
  try {
    const cookie = await f.login();
    for (let i = 0; i < 10; i++) assert.equal((await f.request('/api/account/password', { currentPassword: 'wrong888', newPassword: 'changed8', confirmPassword: 'changed8' }, cookie)).status, 400);
    assert.equal((await f.request('/api/account/password', { currentPassword: f.account.password, newPassword: 'changed8', confirmPassword: 'changed8' }, cookie)).status, 429);
    assert.equal(verifyPassword(JSON.parse(await readFile(path.join(f.dir, 'auth.json'), 'utf8')), f.account.password), true);
  } finally { await f.close(); }
});
