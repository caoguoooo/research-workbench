import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveAccount, accountRecord } from '../auth-store.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
test('code-server preview uses an isolated data directory, requires a password and overrides inherited production settings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-dev-server-'));
  const env = { ...process.env, NODE_ENV: 'production', WORKBENCH_DATA_DIR: path.join(dir, 'production-must-stay-absent'), WORKBENCH_STORAGE: 'sqlite', WORKBENCH_ALLOW_EMPTY_PASSWORD: 'true', WORKBENCH_DEV_DATA_DIR: path.join(dir, 'preview'), WORKBENCH_DEV_PORT: '39342', WORKBENCH_DEV_HOST: '127.0.0.1' };
  let child;
  try {
    child = spawn(process.execPath, ['scripts/dev-server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stopped = await once(child, 'exit'); assert.equal(stopped[0], 1);
    await assert.rejects(access(env.WORKBENCH_DATA_DIR));
    await saveAccount(env.WORKBENCH_DEV_DATA_DIR, accountRecord('previewadmin', 'preview88'));
    child = spawn(process.execPath, ['scripts/dev-server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`preview exited ${code}`))); });
    const status = await (await fetch('http://127.0.0.1:39342/api/status')).json(); assert.equal(status.passwordOptional, false); assert.equal(status.authenticated, false);
    const login = await fetch('http://127.0.0.1:39342/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ username: 'previewadmin', password: 'preview88' }) }); assert.equal(login.status, 200);
    await assert.rejects(access(env.WORKBENCH_DATA_DIR));
  } finally { if (child && child.exitCode === null) { const end = once(child, 'exit'); child.kill(); await end; } await rm(dir, { recursive: true, force: true }); }
});
