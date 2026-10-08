import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));

async function startServer(dataDir, optional, port) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, CYJ_DATA_DIR: dataDir, CYJ_ALLOW_EMPTY_PASSWORD: String(optional), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited: ${code}`)));
  });
  return {
    async request(route, body) {
      return fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    },
    async close() {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
}

test('empty-password preview keeps username validation and preserves the existing password', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cyj-auth-test-'));
  let server;
  try {
    server = await startServer(dir, false, 39031);
    const account = { username: 'demo-user', password: 'original-password' };
    assert.equal((await server.request('/api/setup', account)).status, 201);
    const before = await readFile(path.join(dir, 'auth.json'), 'utf8');
    await server.close();
    server = await startServer(dir, true, 39031);
    assert.equal((await (await server.request('/api/status')).json()).passwordOptional, true);
    const login = await server.request('/api/login', { username: account.username, password: '' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const app = await fetch('http://127.0.0.1:39031/app', { headers: { Cookie: cookie } });
    assert.equal(app.status, 200);
    assert.match(await app.text(), /competitor/);
    assert.equal((await server.request('/api/login', { username: 'wrong-user', password: '' })).status, 401);
    assert.equal((await server.request('/api/login', { username: account.username, password: 'wrong-password' })).status, 401);
    assert.equal((await server.request('/api/login', account)).status, 200);
    assert.equal(await readFile(path.join(dir, 'auth.json'), 'utf8'), before);
    await server.close();
    server = await startServer(dir, false, 39031);
    assert.equal((await (await server.request('/api/status')).json()).passwordOptional, false);
    assert.equal((await server.request('/api/login', { username: account.username, password: '' })).status, 401);
    assert.equal((await server.request('/api/login', account)).status, 200);
  } finally {
    if (server) await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('new empty-password accounts work only when preview mode is enabled', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cyj-auth-test-'));
  let server;
  try {
    const account = { username: 'new-user', password: '' };
    server = await startServer(dir, false, 39032);
    assert.equal((await server.request('/api/setup', account)).status, 400);
    await server.close();
    server = await startServer(dir, true, 39032);
    assert.equal((await server.request('/api/setup', account)).status, 201);
    assert.equal((await server.request('/api/login', account)).status, 200);
    await server.close();
    server = await startServer(dir, false, 39032);
    assert.equal((await server.request('/api/login', account)).status, 401);
  } finally {
    if (server) await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
