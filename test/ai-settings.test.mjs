import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createAISettingsStore } from '../ai-settings.mjs';

test('AI settings persist with private permissions and never return the token', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cyj-ai-settings-'));
  try {
    const store = createAISettingsStore(dir);
    assert.deepEqual(await store.getPublic(), { baseUrl: '', hasToken: false });
    const token = 'test-only-token';
    const result = await store.save({ baseUrl: 'https://example.com/custom/v1/', token });
    assert.deepEqual(result, { baseUrl: 'https://example.com/custom/v1', hasToken: true });
    assert.equal(JSON.stringify(result).includes(token), false);
    // Reopening or changing only the home message must not replace the stored token with a mask.
    await store.save({ baseUrl: result.baseUrl });
    await store.save({ baseUrl: '', token: '' });
    const fresh = createAISettingsStore(dir);
    assert.deepEqual(await fresh.getPublic(), result);
    const disk = JSON.parse(await readFile(path.join(dir, 'ai-settings.json'), 'utf8'));
    assert.equal(disk.token, token);
    assert.equal((await stat(path.join(dir, 'ai-settings.json'))).mode & 0o777, 0o600);
    await fresh.save({ token: 'replacement-test-token' });
    assert.equal(JSON.parse(await readFile(path.join(dir, 'ai-settings.json'), 'utf8')).token, 'replacement-test-token');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Invalid AI configuration cannot overwrite saved credentials', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cyj-ai-validation-'));
  try {
    const store = createAISettingsStore(dir);
    await store.save({ baseUrl: 'https://example.com/v1', token: 'test-only-token' });
    const before = await readFile(path.join(dir, 'ai-settings.json'), 'utf8');
    for (const baseUrl of ['not-a-url', 'file:///etc/passwd', 'http://example.com/v1', 'https://user:pass@example.com', 'https://example.com?key=secret']) {
      await assert.rejects(store.save({ baseUrl, token: 'changed-token' }));
    }
    await assert.rejects(store.save({ token: 'secret\r\nInjected: header' }));
    assert.equal(await readFile(path.join(dir, 'ai-settings.json'), 'utf8'), before);
    await assert.rejects(store.save({ baseUrl: 'http://127.0.0.1:11434/v1' }), /同时填写/);
    await store.save({ baseUrl: 'http://127.0.0.1:11434/v1', token: 'local-test-token' });
    assert.equal((await store.getPublic()).baseUrl, 'http://127.0.0.1:11434/v1');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('AI settings API requires login, validates origin, and does not expose the token', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cyj-ai-api-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root, env: { ...process.env, CYJ_DATA_DIR: dir, CYJ_ALLOW_EMPTY_PASSWORD: 'true', PORT: '39033' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const base = 'http://127.0.0.1:39033';
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Server exited: ${code}`)));
    });
    assert.equal((await fetch(`${base}/api/settings/ai`)).status, 401);
    const account = { username: 'ai-test-user', password: '' };
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(account) };
    assert.equal((await fetch(`${base}/api/setup`, options)).status, 201);
    const login = await fetch(`${base}/api/login`, options);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const token = 'api-test-only-token';
    const save = { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ baseUrl: 'https://example.com/v1', token }) };
    assert.equal((await fetch(`${base}/api/settings/ai`, { ...save, headers: { ...save.headers, Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/settings/ai`, { ...save, headers: { 'Content-Type': 'application/json' } })).status, 401);
    const response = await fetch(`${base}/api/settings/ai`, save);
    assert.equal(response.status, 200);
    const saved = await response.text();
    assert.equal(saved.includes(token), false);
    assert.equal(JSON.parse(saved).hasToken, true);
    const read = await fetch(`${base}/api/settings/ai`, { headers: { Cookie: cookie } });
    assert.equal((await read.text()).includes(token), false);
    assert.equal((await fetch(`${base}/data/ai-settings.json`, { headers: { Cookie: cookie } })).status, 404);
    const app = await (await fetch(`${base}/app`, { headers: { Cookie: cookie } })).text();
    assert.match(app, /id="ai-base-url"[^>]*type="password"/);
    assert.match(app, /id="ai-token"[^>]*type="password"/);
    assert.equal(app.includes(token), false);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(dir, { recursive: true, force: true });
  }
});
