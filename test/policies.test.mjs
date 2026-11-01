import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createPolicyStore } from '../policy-store.mjs';
import { accountRecord, saveAccount } from '../auth-store.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
function input(store, extra = {}) { const city = store.directory()[0]; return { title: '测试文件（非真实规范）', placements: [{ cityId: city.id, typeId: city.types[0].id }], number: '测试〔2026〕1号', issuer: '测试发布单位', publishedAt: '2026-10-29', effectiveAt: '', status: '待核实', sourceUrl: 'https://example.com/policy', keywords: '住宅，规划', note: '仅用于测试', ...extra }; }

test('policy directory and shared placements persist with versions, soft deletion and safe directory edits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-policies-'));
  try {
    let store = await createPolicyStore(dir); const first = store.directory()[0], second = store.directory()[1];
    const metadata = input(store, { placements: [{ cityId: first.id, typeId: first.types[0].id }, { cityId: second.id, typeId: second.types[0].id }, { cityId: first.id, typeId: first.types[0].id }] });
    const old = await store.save(metadata); assert.equal(old.placements.length, 2);
    let current = await store.save({ ...metadata, title: '新版测试文件', replacesId: old.id });
    await assert.rejects(store.save({ ...metadata, replacesId: current.id }, old.id), /循环/);
    await assert.rejects(store.save({ ...metadata, effectiveAt: '2026-02-30' }), /日期/);
    await assert.rejects(store.save({ ...metadata, sourceUrl: 'javascript:alert(1)' }), /网址/);
    await assert.rejects(store.save({ ...metadata, status: '自动生效' }), /状态/);
    await assert.rejects(store.directoryChange({ action: 'renameCity', cityId: second.id, name: first.name }), /已存在/);
    await store.directoryChange({ action: 'renameCity', cityId: first.id, name: '国家通用' });
    await store.directoryChange({ action: 'renameType', cityId: first.id, typeId: first.types[0].id, name: '通用政策' });
    await store.remove(old.id); await store.remove(current.id);
    await assert.rejects(store.directoryChange({ action: 'deleteCity', cityId: first.id }), /回收站/);
    await assert.rejects(store.directoryChange({ action: 'deleteType', cityId: first.id, typeId: first.types[0].id }), /回收站/);
    store = await createPolicyStore(dir); assert.equal(store.list().length, 0); assert.equal(store.list({ deletedOnly: true }).length, 2);
    await store.restore(old.id); current = await store.restore(current.id); assert.equal(current.replacesId, old.id); assert.equal(current.status, '待核实');
    assert.equal(store.directory()[0].name, '国家通用'); assert.equal(store.directory()[0].types[0].name, '通用政策'); assert.equal(store.get(old.id).placements[0].cityId, first.id);
    await store.directoryChange({ action: 'addCity', name: '测试城市' }); const added = store.directory().at(-1);
    await store.directoryChange({ action: 'addType', cityId: added.id, name: '地方指引' }); const addedType = store.directory().at(-1).types.at(-1);
    await store.directoryChange({ action: 'deleteType', cityId: added.id, typeId: addedType.id });
    await store.directoryChange({ action: 'deleteCity', cityId: added.id });
    await store.save({ ...metadata, placements: [metadata.placements[0]] }, old.id); await store.save({ ...metadata, placements: [metadata.placements[0]], replacesId: old.id }, current.id);
    await store.directoryChange({ action: 'deleteType', cityId: second.id, typeId: second.types[0].id });
    assert.equal((await createPolicyStore(dir)).get(current.id).placements.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('policy originals are retained, validated, backed up, and cannot escape their directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-policy-files-'));
  try {
    const store = await createPolicyStore(dir), item = await store.save(input(store));
    await assert.rejects(store.upload(item.id, pdf, '../原文.pdf'), /名称/);
    await assert.rejects(store.upload(item.id, Buffer.from('<script/>'), '原文.pdf'), /PDF/);
    await assert.rejects(store.upload(item.id, pdf.subarray(0, 20), '原文.pdf'), /完整/);
    await assert.rejects(store.upload(item.id, pdf, '原文.html'), /支持/);
    const image = await sharp({ create: { width: 120, height: 100, channels: 3, background: '#eeeeee' } }).png().toBuffer();
    await assert.rejects(store.upload(item.id, image, '错误.jpg'), /不匹配/);
    await assert.rejects(store.upload(item.id, image.subarray(0, 40), '损坏.png'), /解码/);
    const uploaded = await store.upload(item.id, pdf, '原文.pdf'), file = uploaded.files[0]; assert.equal('storedName' in file, false);
    assert.deepEqual((await store.file(item.id, file.id)).bytes, pdf);
    const second = await store.upload(item.id, image, '图示.png'); await store.removeFile(item.id, second.files[1].id);
    assert.equal(store.get(item.id).files.length, 1); await assert.rejects(store.file(item.id, second.files[1].id), /不存在/);
    assert.equal((await readdir(path.join(dir, 'policy-files'))).length, 2);
    const backups = path.join(dir, 'test-backups'); const child = spawn(process.execPath, ['scripts/backup.mjs'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: dir, WORKBENCH_BACKUP_DIR: backups }, stdio: ['ignore', 'pipe', 'pipe'] }); assert.equal((await once(child, 'exit'))[0], 0);
    const backupDir = path.join(backups, (await readdir(backups))[0]), backup = await createPolicyStore(backupDir);
    assert.deepEqual((await backup.file(item.id, file.id)).bytes, pdf); assert.deepEqual(await readFile(path.join(backupDir, 'policy-library.json')), await readFile(path.join(dir, 'policy-library.json')));
    const index = JSON.parse(await readFile(path.join(dir, 'policy-library.json'))), stored = index.items[0].files[0].storedName;
    await rm(path.join(dir, 'policy-files', stored)); await symlink(path.join(dir, 'policy-library.json'), path.join(dir, 'policy-files', stored));
    await assert.rejects(store.file(item.id, file.id), /路径/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [index, storage] of ['json', 'sqlite'].entries()) test(`policy APIs enforce reader permissions, preserve metadata/files and directory across restart with ${storage} archives`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-policies-api-')), port = 39340 + index;
  const env = { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: '', WORKBENCH_STORAGE: storage, WORKBENCH_DATA_DIR: dir, WORKBENCH_ALLOW_EMPTY_PASSWORD: 'false', WORKBENCH_HOME_VISUAL: 'false', WORKBENCH_TRUST_PROXY: 'false' };
  let child;
  async function start() { child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let diagnostic = ''; child.stderr.on('data', chunk => { diagnostic += chunk; }); await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}: ${diagnostic}`))); }); }
  async function stop() { if (child && child.exitCode === null) { const end = once(child, 'exit'); child.kill(); await end; } }
  async function req(route, cookie, method = 'GET', body, extra = {}) { return fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'X-Workbench-Request': '1', Origin: 'https://demo.example', ...(cookie ? { Cookie: cookie } : {}), ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) }); }
  async function login(username, password) { const response = await req('/api/login', null, 'POST', { username, password, remember: true }); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0]; }
  try {
    await saveAccount(dir, accountRecord('admin', 'admin888')); await start(); assert.equal((await req('/api/policies')).status, 401); assert.equal((await req('/policies.js')).status, 401);
    const admin = await login('admin', 'admin888'); await req('/api/register', null, 'POST', { username: 'reader', password: 'reader88', confirmPassword: 'reader88' }); await req('/api/admin/users/reader', admin, 'PATCH', { status: 'active' }); const reader = await login('reader', 'reader88');
    const library = await (await req('/api/policies', admin)).json(), city = library.cities[1]; const metadata = { title: '<img onerror=alert(1)> 测试文件', placements: [{ cityId: city.id, typeId: city.types[0].id }], status: '待核实' };
    for (const [route, method, body] of [['/api/policies', 'POST', metadata], ['/api/policy-directory', 'POST', { action: 'addCity', name: '杭州' }]]) { assert.equal((await req(route, reader, method, body)).status, 403); assert.equal((await req(route, admin, method, body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403); }
    const created = await req('/api/policies', admin, 'POST', metadata); assert.equal(created.status, 201); const item = (await created.json()).item;
    const uploadUrl = `/api/policies/${item.id}/files?name=${encodeURIComponent('测试原文.pdf')}`;
    assert.equal((await req(uploadUrl, reader, 'POST', pdf)).status, 403); assert.equal((await req(uploadUrl, admin, 'POST', pdf, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const upload = await req(uploadUrl, admin, 'POST', pdf); assert.equal(upload.status, 201); const file = (await upload.json()).item.files[0];
    const original = await req(file.url, reader); assert.equal(original.status, 200); assert.equal(original.headers.get('content-type'), 'application/pdf'); assert.deepEqual(Buffer.from(await original.arrayBuffer()), pdf); assert.equal(original.headers.get('x-frame-options'), 'DENY');
    assert.match((await req(`${file.url}?download=1`, reader)).headers.get('content-disposition'), /^attachment;/);
    const partial = await req(file.url, reader, 'GET', undefined, { Range: 'bytes=-8' });
    assert.equal(partial.status, 206);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), pdf.subarray(-8));
    for (const range of ['bytes=999999-', 'bytes=1-0', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=0-999999999999999999']) {
      const invalid = await req(file.url, reader, 'GET', undefined, { Range: range });
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers.get('content-range'), `bytes */${pdf.length}`);
    }
    for (const [route, method, body] of [[`/api/policies/${item.id}`, 'PATCH', metadata], [`/api/policies/${item.id}`, 'DELETE'], [file.url, 'DELETE'], [`/api/policies/${item.id}/restore`, 'POST'], ['/api/policies?deleted=true', 'GET']]) assert.equal((await req(route, reader, method, body)).status, 403);
    assert.equal((await req('/api/policy-directory', admin, 'POST', { action: 'renameCity', cityId: city.id, name: '重庆主城' })).status, 200);
    assert.equal((await req(`/api/policies/${item.id}`, admin, 'DELETE')).status, 200); assert.equal((await req(file.url, reader)).status, 404); assert.equal((await req(`/api/policies/${item.id}/restore`, admin, 'POST')).status, 200);
    await stop(); await start(); const saved = await (await req('/api/policies', reader)).json(); assert.equal(saved.items.length, 1); assert.equal(saved.items[0].title, metadata.title); assert.equal(saved.cities.find(entry => entry.id === city.id).name, '重庆主城'); assert.deepEqual(Buffer.from(await (await req(file.url, reader)).arrayBuffer()), pdf);
    assert.equal((await req('/policies.js', reader)).status, 200);
    const filePath = (await readdir(path.join(dir, 'policy-files')))[0];
    await writeFile(path.join(dir, 'policy-files', filePath), Buffer.alloc(0));
    const empty = await req(file.url, reader);
    assert.equal(empty.status, 200);
    assert.equal((await empty.arrayBuffer()).byteLength, 0);
    assert.equal((await req(file.url, reader, 'GET', undefined, { Range: 'bytes=0-' })).status, 416);
    await unlink(path.join(dir, 'policy-files', filePath));
    assert.equal((await req(file.url, reader)).status, 404);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
