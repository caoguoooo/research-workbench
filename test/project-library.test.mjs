import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { accountRecord, saveAccount } from '../auth-store.mjs';
import { createUserStore } from '../user-store.mjs';

const root = new URL('../', import.meta.url);
const endpoint = '/api/internal-projects';

test('private project albums upload both photo types, persist changes and back up originals', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-aerial-'));
  const backups = path.join(directory, 'backups');
  let server;
  async function stop() {
    if (server?.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });

  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const primary = accountRecord('project-admin', 'aerial-admin-qa');
  await saveAccount(directory, primary);
  const users = await createUserStore(directory, () => primary);
  await users.register('project-reader', 'aerial-reader-qa');
  await users.update('project-reader', { status: 'active' }, primary.username);

  const env = {
    ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
    PUBLIC_ORIGIN: '', WORKBENCH_DATA_DIR: directory, WORKBENCH_STORAGE: 'sqlite',
    WORKBENCH_HOME_VISUAL: 'false', WORKBENCH_ALLOW_EMPTY_PASSWORD: 'false',
    WORKBENCH_TRUST_PROXY: 'false', WORKBENCH_BACKUP_DIR: backups
  };
  async function start() {
    server = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
    await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(([code]) => { throw Error(`server exit ${code}`); })]);
  }
  function send(route, { method = 'GET', cookie, payload, bytes, headers = {} } = {}) {
    return fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        'X-Workbench-Request': '1', Origin: 'https://aerial.example',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
        ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}), ...headers
      },
      body: bytes || (payload ? JSON.stringify(payload) : undefined)
    });
  }
  async function login(username, password) {
    const response = await send('/api/login', { method: 'POST', payload: { username, password, remember: true } });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  function upload(album, cookie, bytes, { name, date, kind, uploadId = randomUUID() }, headers) {
    const query = new URLSearchParams({ name, date, kind, uploadId });
    return send(`${album}/aerial?${query}`, { method: 'POST', cookie, bytes, headers });
  }
  await start();
  const admin = await login(primary.username, 'aerial-admin-qa');
  const reader = await login('project-reader', 'aerial-reader-qa');
  assert.equal((await send(endpoint)).status, 401);
  assert.equal((await send(endpoint, { cookie: reader })).status, 403);
  assert.equal((await send('/vendor/pannellum.js', { cookie: reader })).status, 403);
  for (const file of ['pannellum.js', 'pannellum.css']) assert.equal((await send('/vendor/' + file, { cookie: admin })).status, 200);
  const created = await send(endpoint, { method: 'POST', cookie: admin, payload: { name: '航拍项目' } });
  assert.equal(created.status, 201);
  const album = endpoint + '/' + (await created.json()).item.id;

  const flat = await sharp({ create: { width: 480, height: 320, channels: 3, background: '#143943' } }).png().toBuffer();
  const pano = await sharp({ create: { width: 5000, height: 2500, channels: 3, background: '#47683d' } }).jpeg().toBuffer();
  const date = '2026-11-24';
  assert.equal((await upload(album, admin, flat, { name: '普通图', date, kind: 'panorama' })).status, 422);
  assert.equal((await upload(album, admin, pano, { name: '全景图', date: '2026-02-30', kind: 'panorama' })).status, 400);
  assert.equal((await upload(album, admin, pano, { name: '全景图', date, kind: 'panorama' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await upload(album, admin, Buffer.from('invalid'), { name: '无效图', date, kind: 'photo' })).status, 422);
  assert.deepEqual((await (await send(album, { cookie: admin })).json()).item.groups, []);

  const flatFields = { name: '主入口', date, kind: 'photo', uploadId: randomUUID() };
  assert.equal((await upload(album, admin, flat, flatFields)).status, 201);
  assert.equal((await upload(album, admin, flat, flatFields)).status, 201);
  assert.equal((await upload(album, admin, flat, { name: '上次航拍', date: '2026-11-20', kind: 'photo' })).status, 201);
  const complete = await upload(album, admin, pano, { name: '高空全景', date, kind: 'panorama' });
  assert.equal(complete.status, 201);
  const [latest, earlier] = (await complete.json()).item.groups;
  assert.equal(latest.date, date);
  assert.equal(earlier.date, '2026-11-20');
  assert.equal(latest.photos.length, 2);
  const [photo, panorama] = latest.photos;
  assert.equal((await send(panorama.previewUrl, { cookie: reader })).status, 403);
  assert.equal((await send(photo.originalUrl)).status, 401);
  const original = await send(panorama.originalUrl, { cookie: admin });
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), pano);
  const preview = await send(panorama.previewUrl, { cookie: admin });
  const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
  assert.deepEqual([metadata.width, metadata.height], [4096, 2048]);
  const bytesRange = await send(photo.originalUrl, { cookie: admin, headers: { Range: 'bytes=0-9' } });
  assert.equal(bytesRange.status, 206);
  assert.deepEqual(Buffer.from(await bytesRange.arrayBuffer()), flat.subarray(0, 10));

  async function change(route, payload) {
    const response = await send(route, { method: 'PATCH', cookie: admin, payload });
    assert.equal(response.status, 200);
    return (await response.json()).item;
  }
  await change(`${album}/groups/${date}`, { title: '首轮踩勘' });
  await change(`${album}/aerial/${panorama.id}`, { action: 'cover', name: '地块总览' });
  await change(`${album}/aerial/${panorama.id}`, { action: 'earlier' });
  await stop();
  await start();
  const reopened = (await (await send(album, { cookie: admin })).json()).item.groups[0];
  assert.equal(reopened.title, '首轮踩勘');
  assert.equal(reopened.coverId, panorama.id);
  assert.deepEqual(reopened.photos.map(item => item.name), ['地块总览', '主入口']);

  const backup = spawn(process.execPath, ['scripts/backup.mjs'], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(backup, 'exit'))[0], 0);
  const [backupFolder] = await readdir(backups);
  const location = path.join(backups, backupFolder);
  const projectId = album.split('/').pop();
  assert.ok((await readFile(path.join(location, 'project-library.json'), 'utf8')).includes(panorama.id));
  assert.deepEqual(await readFile(path.join(location, 'project-files', projectId, panorama.id, 'original')), pano);
  await change(`${album}/aerial/${panorama.id}`, { action: 'remove' });
  assert.equal((await send(panorama.originalUrl, { cookie: admin })).status, 404);
  assert.deepEqual(await readFile(path.join(directory, 'project-files', projectId, panorama.id, 'original')), pano);
});
