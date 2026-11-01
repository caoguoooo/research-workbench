import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createAssetLibraryStore, normalizeBoardUrl } from '../asset-library-store.mjs';
import { accountRecord, saveAccount } from '../auth-store.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = { title: '住宅入口', category: '大门', project: '测试案例', tags: ['石材', '柱廊'], note: '研究比例', sourceUrl: 'https://example.com/case' };

test('custom asset categories migrate old indexes, rename/reassign active and trashed items atomically, and retain originals', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-asset-categories-'));
  try {
    let store = await createAssetLibraryStore(dir);
    const bytes = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#bdceab' } }).png().toBuffer();
    const image = await store.upload(metadata, bytes, '原图.png');
    const board = await store.addBoard({ ...metadata, boardUrl: 'https://www.pinterest.com/designer/gates/' });
    await store.remove(board.id);
    const filename = path.join(dir, 'asset-library.json'), legacy = JSON.parse(await readFile(filename, 'utf8'));
    delete legacy.categories; await writeFile(filename, JSON.stringify(legacy));
    store = await createAssetLibraryStore(dir); assert.deepEqual(store.categories(), ['规划彩总', '立面效果', '大门', '示范区景观']);
    await store.renameCategory('大门', '入口设计');
    assert.equal(store.get(image.id).category, '入口设计'); assert.equal(store.list({ deletedOnly: true })[0].category, '入口设计');
    await assert.rejects(store.removeCategory('入口设计'), /转移分类/);
    await store.addCategory('架空层');
    await assert.rejects(store.addCategory('架空层'), /已存在/);
    await assert.rejects(store.renameCategory('入口设计', '立面效果'), /已存在/);
    await assert.rejects(store.removeCategory('入口设计', '入口设计'), /另一个分类/);
    await store.removeCategory('入口设计', '架空层'); await store.restore(board.id);
    store = await createAssetLibraryStore(dir);
    assert.equal(store.get(image.id).category, '架空层'); assert.equal(store.get(board.id).category, '架空层');
    assert.deepEqual((await store.image(image.id)).bytes, bytes);
    assert.throws(() => store.addBoard({ ...metadata, category: '大门', boardUrl: 'https://www.pinterest.com/designer/other/' }), /分类不存在/);
    const queued = await Promise.allSettled([store.renameCategory('架空层', '灰空间'), store.addBoard({ ...metadata, category: '架空层', boardUrl: 'https://www.pinterest.com/designer/other/' })]);
    assert.equal(queued[0].status, 'fulfilled'); assert.equal(queued[1].status, 'rejected');
    assert.equal(store.get(image.id).category, '灰空间');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deleting all empty categories persists an empty library instead of recreating defaults', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-asset-no-categories-'));
  try {
    let store = await createAssetLibraryStore(dir);
    for (const category of store.categories()) await store.removeCategory(category);
    store = await createAssetLibraryStore(dir); assert.deepEqual(store.categories(), []);
    await store.addCategory('自由分类');
    await store.addBoard({ ...metadata, category: '自由分类', boardUrl: 'https://www.pinterest.com/designer/free/' });
    await assert.rejects(store.removeCategory('自由分类'), /转移分类/);
    assert.equal((await createAssetLibraryStore(dir)).categories()[0], '自由分类');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('assets retain original bytes, reject invalid images/URLs, serialize updates and restore deleted records after restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-assets-'));
  try {
    assert.equal(normalizeBoardUrl('https://cn.pinterest.com/designer/gates/?tracking=1'), 'https://www.pinterest.com/designer/gates/');
    for (const url of ['https://www.pinterest.com.evil.test/designer/gates/', 'javascript:alert(1)', 'https://www.pinterest.com/pin/123/', 'https://www.pinterest.com/a/%2f/', 'https://name:pass@www.pinterest.com/a/b/', 'https://pin.it/short', 'http://www.pinterest.com/a/b/']) assert.throws(() => normalizeBoardUrl(url));
    const store = await createAssetLibraryStore(dir);
    const bytes = await sharp({ create: { width: 1800, height: 1000, channels: 3, background: '#a5b5ac' } }).jpeg().toBuffer();
    const [image, board] = await Promise.all([store.upload(metadata, bytes, '入口.jpg'), store.addBoard({ ...metadata, title: '入口画板', boardUrl: 'https://www.pinterest.com/designer/gates/' })]);
    assert.equal(store.list().length, 2); assert.deepEqual((await store.image(image.id)).bytes, bytes);
    const thumb = await sharp((await store.image(image.id, true)).bytes).metadata(); assert.equal(thumb.width, 1000);
    assert.equal('storedName' in image, false); assert.equal('thumbnail' in image, false);
    await assert.rejects(store.upload(metadata, bytes.subarray(0, 100), 'bad.jpg'), /完整/);
    await assert.rejects(store.upload(metadata, Buffer.from('<svg/>'), 'bad.png'), /完整/);
    assert.throws(() => store.addBoard({ ...metadata, sourceUrl: 'javascript:alert(1)', boardUrl: board.boardUrl }));
    await assert.rejects(store.addBoard({ ...metadata, boardUrl: board.boardUrl }), /已关联/);
    await store.update(image.id, { ...metadata, title: '<img onerror=alert(1)>', category: '立面效果' });
    await store.remove(image.id); assert.equal(store.list().length, 1); assert.equal(store.list({ deletedOnly: true }).length, 1);
    await assert.rejects(store.image(image.id), /不存在/);
    const restarted = await createAssetLibraryStore(dir); await restarted.restore(image.id);
    assert.equal(restarted.get(image.id).title, '<img onerror=alert(1)>'); assert.deepEqual((await restarted.image(image.id)).bytes, bytes);
    assert.equal((await readdir(path.join(dir, 'asset-files/originals'))).length, 1);
    const backups = path.join(dir, 'test-backups');
    await mkdir(path.join(dir, 'assets', 'references'), { recursive: true });
    await writeFile(path.join(dir, 'assets', 'references', 'original.jpg'), bytes);
    const child = spawn(process.execPath, ['scripts/backup.mjs'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: dir, WORKBENCH_BACKUP_DIR: backups }, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal((await once(child, 'exit'))[0], 0);
    const backup = path.join(backups, (await readdir(backups))[0]);
    assert.deepEqual(await readFile(path.join(backup, 'assets', 'references', 'original.jpg')), bytes);
    assert.deepEqual(await readFile(path.join(backup, 'asset-library.json')), await readFile(path.join(dir, 'asset-library.json')));
    const original = (await readdir(path.join(dir, 'asset-files/originals')))[0];
    assert.deepEqual(await readFile(path.join(backup, 'asset-files/originals', original)), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [index, storage] of ['json', 'sqlite'].entries()) test(`asset API authentication, read-only permissions, upload and persistence with ${storage} archives`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-assets-api-')), port = 39330 + index;
  const env = { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: '', WORKBENCH_STORAGE: storage, WORKBENCH_DATA_DIR: dir, WORKBENCH_ALLOW_EMPTY_PASSWORD: 'false', WORKBENCH_HOME_VISUAL: 'false', WORKBENCH_TRUST_PROXY: 'false' };
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
  }
  async function stop() { if (child && child.exitCode === null) { const end = once(child, 'exit'); child.kill(); await end; } }
  async function req(route, cookie, method = 'GET', body, extra = {}) {
    return fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'X-Workbench-Request': '1', Origin: 'https://demo.example', ...(cookie ? { Cookie: cookie } : {}), ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) });
  }
  async function login(username, password) { const response = await req('/api/login', null, 'POST', { username, password, remember: true }); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0]; }
  try {
    await saveAccount(dir, accountRecord('admin', 'admin888')); await start();
    assert.equal((await req('/api/assets')).status, 401);
    const admin = await login('admin', 'admin888');
    await req('/api/register', null, 'POST', { username: 'reader', password: 'reader88', confirmPassword: 'reader88' });
    await req('/api/admin/users/reader', admin, 'PATCH', { status: 'active' });
    const reader = await login('reader', 'reader88');
    const boardInput = { ...metadata, boardUrl: 'https://www.pinterest.com/designer/gates/' };
    assert.equal((await req('/api/assets', reader, 'POST', boardInput)).status, 403);
    assert.equal((await req('/api/assets', admin, 'POST', boardInput, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const boardResponse = await req('/api/assets', admin, 'POST', boardInput); assert.equal(boardResponse.status, 201);
    const board = (await boardResponse.json()).item;
    const bytes = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#d5d3cb' } }).png().toBuffer();
    const query = new URLSearchParams({ title: '规划测试图', category: '规划彩总', name: '彩总.png', upload: '1' });
    const upload = await req(`/api/assets?${query}`, admin, 'POST', bytes, { 'Content-Type': 'image/png' }); assert.equal(upload.status, 201);
    const image = (await upload.json()).item;
    assert.equal((await req('/api/asset-categories', reader, 'POST', { name: '架空层' })).status, 403);
    assert.equal((await req('/api/asset-categories', admin, 'POST', { name: '架空层' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await req('/api/asset-categories', admin, 'POST', { name: '架空层' })).status, 201);
    assert.equal((await req('/api/asset-categories', admin, 'PATCH', { name: '架空层', newName: '灰空间' })).status, 200);
    assert((await (await req('/api/assets', reader)).json()).categories.includes('灰空间'));
    assert.equal((await req('/api/asset-categories', reader, 'DELETE', { name: '灰空间' })).status, 403);
    assert.equal((await req('/api/asset-categories', admin, 'DELETE', { name: '灰空间' })).status, 200);
    assert.deepEqual(Buffer.from(await (await req(image.imageUrl, reader)).arrayBuffer()), bytes);
    const partial = await req(image.imageUrl, reader, 'GET', undefined, { Range: 'bytes=0-7' });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 0-7/${bytes.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 8));
    assert.equal((await req('/api/assets?deleted=true', reader)).status, 403);
    assert.equal((await req(`/api/assets/${image.id}`, reader, 'DELETE')).status, 403);
    assert.equal((await req(`/api/assets/${image.id}`, admin, 'PATCH', { ...metadata, title: '更新后的素材' })).status, 200);
    assert.equal((await req(`/api/assets/${board.id}`, admin, 'DELETE')).status, 200);
    assert.equal((await req(`/api/assets/${board.id}/restore`, reader, 'POST')).status, 403);
    assert.equal((await req(`/api/assets/${board.id}/restore`, admin, 'POST')).status, 200);
    assert.equal((await req('/assets.js')).status, 401);
    assert.equal((await req(`/api/assets/${board.id}/pinterest`, reader)).status, 409);
    assert.equal((await req('/api/settings/pinterest', reader)).status, 403);
    assert.equal((await req('/api/settings/pinterest', admin, 'PATCH', { proxyUrl: 'socks5://127.0.0.1:7890' })).status, 400);
    assert.equal((await req('/api/settings/pinterest', admin, 'PATCH', { proxyUrl: 'http://192.168.31.70:7890' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await req('/api/settings/pinterest', admin, 'PATCH', { proxyUrl: 'http://192.168.31.70:7890' })).status, 200);
    assert.equal((await (await req('/api/settings/pinterest', admin)).json()).proxyUrl, 'http://192.168.31.70:7890');
    assert.equal((await req(`/api/assets/${image.id}/pinterest`, admin)).status, 400);
    const app = await req('/app', reader); assert.doesNotMatch(app.headers.get('content-security-policy'), /pinterest\.com/);
    await stop(); await start();
    assert.equal((await (await req('/api/settings/pinterest', admin)).json()).proxyUrl, 'http://192.168.31.70:7890');
    const saved = await (await req('/api/assets', admin)).json(); assert.equal(saved.items.length, 2); assert(saved.items.some(item => item.title === '更新后的素材'));
    assert(!saved.categories.includes('架空层')); assert(!saved.categories.includes('灰空间'));
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
