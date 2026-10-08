import { mkdtemp, writeFile, readFile, rm, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const prefix = `research-workbench-demo-${version}`;
const folders = (await readdir(path.join(root, 'releases'))).filter(name => name.startsWith(prefix + '-') && /^\d+$/.test(name.slice(prefix.length + 1))).sort();
const bundle = path.join(root, 'releases', folders.at(-1), prefix);
const manifest = JSON.parse(await readFile(path.join(bundle, 'release-manifest.json'), 'utf8'));
const temp = await mkdtemp(path.join(tmpdir(), 'cyj-docker-smoke-'));
const seed = path.join(temp, 'seed');
await cp(path.join(bundle, 'demo-data'), seed, { recursive: true });
const override = path.join(temp, 'compose.json');
const project = 'workbench-smoke-' + Date.now();
const origin = 'https://demo.example';
const port = '39100';
const passwordFile = path.join(temp, 'test-password');
await writeFile(passwordFile, 'disposable-test-password', { mode: 0o644 });
const env = { ...process.env, PUBLIC_ORIGIN: origin, CYJ_HTTP_PORT: port, COMPOSE_PROJECT_NAME: project, COMPOSE_FILE: path.join(root, 'compose.yaml') + ':' + override, WORKBENCH_SEED_DIR: seed };
await writeFile(override, JSON.stringify({ services: {
  app: { container_name: project + '-app', volumes: ['test-data:/data', 'test-backups:/backups', passwordFile + ':/run/test-password:ro'], environment: { CYJ_ADMIN_PASSWORD_FILE: '/run/test-password' } }
}, volumes: { 'test-data': {}, 'test-backups': {} } }));
async function compose(args) {
  return run('docker', ['compose', '-p', project, '-f', path.join(root, 'compose.yaml'), '-f', override, ...args], { env, timeout: 60_000, maxBuffer: 1024 * 1024 });
}
async function workbench(command, ...args) {
  return run('sh', [path.join(root, 'workbench.sh'), command, ...args], { env, timeout: 60_000, maxBuffer: 1024 * 1024 });
}
let cookie;
async function request(route, method = 'GET', body) {
  return fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function ready() {
  for (let i = 0; i < 60; i++) {
    try { if ((await request('/healthz')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Container not ready');
}
async function login() {
  const response = await request('/api/login', 'POST', { username: 'docker-test-user', password: 'disposable-test-password' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Secure/);
  cookie = response.headers.get('set-cookie').split(';')[0];
}
try {
  await workbench('init', 'docker-test-user');
  console.log('Docker: one-command setup, directory permissions, seed and administrator passed');
  await ready();
  await login();
  await assert.rejects(workbench('prepare'), error => error.stderr.includes('请先执行 sh workbench.sh stop'));
  const records = (await (await request('/api/competitors')).json()).items;
  assert.equal(records.length, manifest.projectCount);
  for (const item of records) for (const file of item.files) {
    const response = await request(`/api/competitors/${item.id}/files/${file.id}`);
    assert.equal(response.status, 200);
    const digest = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    assert.equal(digest, manifest.fileHashes.find(hash => hash.id === file.id).sha256);
  }
  assert.equal((await request('/api/ai/models')).status, 409);
  const app = await (await request('/app')).text();
  assert.ok(app.includes('ai-chat-dialog') && app.includes('competitor-view'));
  console.log(`Docker: formal login, page resources and ${manifest.fileCount} original attachments passed`);
  await compose(['restart', 'app']);
  await ready();
  assert.equal((await request('/api/competitors')).status, 401);
  await login();
  assert.equal((await (await request('/api/competitors')).json()).items.length, manifest.projectCount);
  console.log('Docker: SQLite persistence after restart passed');
  await workbench('backup');
  await ready();
  assert.notEqual((await compose(['ps', '--status', 'running', '-q', 'app'])).stdout.trim(), '');
  console.log('Docker: backup resumes a previously running app');
  await workbench('stop');
  await workbench('backup');
  assert.equal((await compose(['ps', '--status', 'running', '-q', 'app'])).stdout.trim(), '');
  console.log('Docker: backup preserves a previously stopped app');
  const check = await compose(['run', '--rm', '-T', 'app', 'node', '--input-type=module', '-e', "import {readdir} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';const folders=await readdir('/backups');const db=new DatabaseSync('/backups/'+folders[0]+'/workbench.sqlite',{readOnly:true});console.log(JSON.stringify({integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,projects:db.prepare('SELECT COUNT(*) n FROM competitors').get().n,files:db.prepare('SELECT COUNT(*) n FROM files').get().n}));db.close();"]);
  const result = JSON.parse(check.stdout.trim());
  assert.equal(result.integrity, 'ok');
  assert.equal(result.projects, manifest.projectCount);
  assert.equal(result.files, manifest.fileCount);
  console.log('Docker: backup integrity passed');
  await workbench('init', 'ignored-new-name');
  await ready();
  await login();
  assert.equal((await (await request('/api/competitors')).json()).items.length, manifest.projectCount);
  console.log('Docker: repeated setup preserves the existing administrator and projects');
  console.log(JSON.stringify({ ok: true, architecture: 'linux/amd64', projects: manifest.projectCount, attachments: manifest.fileCount }));
} finally {
  await compose(['down', '--volumes', '--remove-orphans']).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
